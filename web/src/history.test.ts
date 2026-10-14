import { describe, expect, test } from 'bun:test';
import type { WireEvent } from '../index.js';
import {
  buildExport, exportFileName, HistoryError, localStorageHistory, memoryHistory, parseStoredConversation,
  renumberEvents, replayTurns, snapshotFromEvents, summarize, titleFromTurns, type StoredConversation,
} from './history.ts';

const wire = (request: string, sequence: number, event: WireEvent['event'], conversation = 'c'): WireEvent =>
  ({ version: 1, conversation_id: conversation, request_id: request, sequence, event });
const chunk = (request: string, sequence: number, kind: string, text: string): WireEvent =>
  wire(request, sequence, { kind: 'update', update: { sessionUpdate: kind, content: { type: 'text', text } } });
const done = (request: string, sequence: number): WireEvent => wire(request, sequence, { kind: 'completed', stop_reason: 'end_turn' });

/** A finished question and answer. */
const turnEvents = (request: string, question: string, answer: string): WireEvent[] => [
  chunk(request, 1, 'user_message_chunk', question),
  chunk(request, 2, 'agent_message_chunk', answer),
  done(request, 3),
];

const conversation = (id: string, updatedAt: number, events: WireEvent[] = turnEvents('r1', 'hello', 'hi')): StoredConversation =>
  ({ version: 1, id, title: 'hello', createdAt: 1, updatedAt, events: renumberEvents(events, id) });

class FakeStorage {
  data = new Map<string, string>();
  failWrites: (name: string, value: string) => boolean = () => false;
  getItem = (name: string): string | null => this.data.get(name) ?? null;
  setItem = (name: string, value: string): void => {
    if (this.failWrites(name, value)) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(name, value);
  };
  removeItem = (name: string): void => { this.data.delete(name); };
}

describe('pure helpers', () => {
  test('replayTurns folds the stream per request in first-seen order', () => {
    const turns = replayTurns([...turnEvents('a', 'one', 'first'), ...turnEvents('b', 'two', 'second')]);
    expect(turns.map((turn) => [turn.request_id, turn.user_text, turn.text, turn.status])).toEqual([
      ['a', 'one', 'first', 'completed'],
      ['b', 'two', 'second', 'completed'],
    ]);
  });

  test('a stream that never ended replays as streaming', () => {
    expect(replayTurns([chunk('a', 1, 'user_message_chunk', 'q')])[0]!.status).toBe('streaming');
  });

  test('renumberEvents closes gaps per request and pins the conversation id', () => {
    const out = renumberEvents([chunk('a', 1, 'user_message_chunk', 'q'), chunk('a', 5, 'agent_message_chunk', 'x'), done('a', 9), chunk('b', 2, 'user_message_chunk', 'q2')], 'new');
    expect(out.map((event) => [event.request_id, event.sequence, event.conversation_id])).toEqual([['a', 1, 'new'], ['a', 2, 'new'], ['a', 3, 'new'], ['b', 1, 'new']]);
  });

  test('titleFromTurns uses the first non-empty question, collapsed and shortened', () => {
    expect(titleFromTurns(replayTurns(turnEvents('a', '  what\n is   this? ', 'x')))).toBe('what is this?');
    const long = titleFromTurns(replayTurns(turnEvents('a', 'x'.repeat(200), 'y')));
    expect(long.length).toBe(60);
    expect(long.endsWith('…')).toBe(true);
    expect(titleFromTurns([])).toBe('');
  });

  test('parseStoredConversation rejects other versions and drops unusable events', () => {
    expect(parseStoredConversation({ version: 2, id: 'x', events: [] })).toBeUndefined();
    expect(parseStoredConversation('nope')).toBeUndefined();
    expect(parseStoredConversation({ version: 1, id: '', events: [] })).toBeUndefined();
    const parsed = parseStoredConversation({ version: 1, id: 'x', events: [...turnEvents('a', 'q', 'a'), { nonsense: true }, { ...done('b', 1), event: { kind: 'unknown' } }] })!;
    expect(parsed.events).toHaveLength(3);
    expect(parsed.title).toBe('');
  });

  test('exportFileName is a slug plus the date', () => {
    const day = new Date('2026-10-14T10:00:00Z');
    expect(exportFileName('Why is the sky blue?!', day)).toBe('why-is-the-sky-blue-2026-10-14.json');
    expect(exportFileName('', day)).toBe('conversation-2026-10-14.json');
  });

  test('the export carries the snapshot and the replayable events', () => {
    const stored = conversation('c1', 5);
    const data = buildExport(stored, snapshotFromEvents(stored.events, 'c1'), new Date('2026-10-14T10:00:00Z'));
    expect(data.format).toBe('ccht.conversation');
    expect(data.exported_at).toBe('2026-10-14T10:00:00.000Z');
    expect(data.snapshot.conversation_id).toBe('c1');
    expect(data.snapshot.turns[0]!.text).toBe('hi');
    expect(data.events).toEqual(stored.events);
  });
});

describe('memoryHistory', () => {
  test('lists newest first and loads copies', async () => {
    const history = memoryHistory();
    await history.save(conversation('old', 1));
    await history.save(conversation('new', 2));
    expect((await history.list()).map((item) => item.id)).toEqual(['new', 'old']);
    const loaded = (await history.load('new'))!;
    loaded.events.length = 0;
    expect((await history.load('new'))!.events.length).toBeGreaterThan(0);
    await history.remove!('new');
    expect(await history.load('new')).toBeUndefined();
  });
});

describe('localStorageHistory', () => {
  test('saves, lists and loads the replayable stream under the key', () => {
    const storage = new FakeStorage();
    const history = localStorageHistory('app', { storage });
    history.save(conversation('c1', 10));
    history.save(conversation('c2', 20));
    expect([...storage.data.keys()].sort()).toEqual(['app:c:c1', 'app:c:c2', 'app:index']);
    expect(history.list()).toEqual([{ id: 'c2', title: 'hello', updatedAt: 20, turns: 1 }, { id: 'c1', title: 'hello', updatedAt: 10, turns: 1 }]);
    expect(history.load('c1')!.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(history.load('missing')).toBeUndefined();
  });

  test('saving again replaces the record and renumbers a filtered stream', () => {
    const storage = new FakeStorage();
    const history = localStorageHistory('app', { storage });
    history.save(conversation('c1', 10));
    const filtered = { ...conversation('c1', 11), events: [chunk('r1', 1, 'user_message_chunk', 'q'), done('r1', 3)] };
    history.save(filtered);
    expect(history.list()).toHaveLength(1);
    expect(history.load('c1')!.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  test('keeps at most maxConversations, dropping the oldest', () => {
    const storage = new FakeStorage();
    const history = localStorageHistory('app', { storage, maxConversations: 2 });
    history.save(conversation('a', 1));
    history.save(conversation('b', 2));
    history.save(conversation('c', 3));
    expect(history.list().map((item) => item.id)).toEqual(['c', 'b']);
    expect(storage.data.has('app:c:a')).toBe(false);
  });

  test('keeps within maxBytes: older conversations go first, then the oldest turns of the new one', () => {
    const storage = new FakeStorage();
    const big = (id: string, at: number, turns: number) => conversation(id, at, Array.from({ length: turns }, (_, index) => turnEvents(`r${index}`, `question ${index}`, 'a'.repeat(400))).flat());
    const size = JSON.stringify(big('x', 1, 1)).length;
    const history = localStorageHistory('app', { storage, maxBytes: size * 2 + 100 });
    history.save(big('a', 1, 1));
    history.save(big('b', 2, 1));
    history.save(big('c', 3, 1));
    expect(history.list().map((item) => item.id)).toEqual(['c', 'b']);
    history.save(big('d', 4, 5));
    const kept = history.load('d')!;
    const requests = new Set(kept.events.map((event) => event.request_id));
    expect(requests.size).toBeLessThan(5);
    expect(requests.has('r4')).toBe(true);
    expect(history.list()[0]!.id).toBe('d');
  });

  test('one turn larger than the budget is refused', () => {
    const history = localStorageHistory('app', { storage: new FakeStorage(), maxBytes: 100 });
    expect(() => history.save(conversation('a', 1))).toThrow(HistoryError);
  });

  test('a full storage evicts older conversations and retries, then reports quota', () => {
    const storage = new FakeStorage();
    const history = localStorageHistory('app', { storage });
    history.save(conversation('a', 1));
    history.save(conversation('b', 2));
    let calls = 0;
    storage.failWrites = (name) => name === 'app:c:c' && ++calls <= 2;
    history.save(conversation('c', 3));
    expect(history.list().map((item) => item.id)).toEqual(['c']);
    storage.failWrites = () => true;
    try {
      history.save(conversation('d', 4));
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(HistoryError);
      expect((error as HistoryError).code).toBe('quota');
    }
  });

  test('disabled storage reports unavailable; corrupt data reads as empty', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const history = localStorageHistory('app', { storage: blocked });
    expect(() => history.list()).toThrow(HistoryError);
    expect(() => history.save(conversation('a', 1))).toThrow(HistoryError);
    const storage = new FakeStorage();
    storage.data.set('app:index', '{not json');
    storage.data.set('app:c:x', '{"version":9}');
    const corrupt = localStorageHistory('app', { storage });
    expect(corrupt.list()).toEqual([]);
    expect(corrupt.load('x')).toBeUndefined();
  });

  test('remove and clear', () => {
    const storage = new FakeStorage();
    const history = localStorageHistory('app', { storage });
    history.save(conversation('a', 1));
    history.save(conversation('b', 2));
    history.remove('a');
    expect(history.list().map((item) => item.id)).toEqual(['b']);
    history.clear();
    expect(storage.data.size).toBe(0);
  });

  test('summaries count turns', () => {
    expect(summarize(conversation('a', 1, [...turnEvents('r1', 'q', 'a'), ...turnEvents('r2', 'q', 'a')])).turns).toBe(2);
  });
});
