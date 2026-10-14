/** Conversation history for `AssistantPanel.svelte`: a small storage adapter
 * interface, a ready `localStorage` implementation and the pure helpers around
 * the persisted format.
 *
 * A saved conversation is the REPLAYABLE EVENT STREAM of the shared
 * conversation model (the `WireEvent`s the browser agent emits, renumbered per
 * request so they replay without gaps), plus a title and two timestamps. It is
 * not a second transcript format: feeding `events` to `createConversation(id)`
 * (`applyEvent`) rebuilds exactly the snapshot the model produces for a live
 * conversation. Nothing here talks to the network.
 */
import type { ConversationSnapshot, TurnState, WireEvent } from '../index.js';
import { applyWireEvent, newTurn } from './assistant.ts';

type MaybePromise<T> = T | Promise<T>;

/** One saved conversation (`version` 1). */
export interface StoredConversation {
  version: 1;
  id: string;
  /** Short title derived from the first saved question; may be empty. */
  title: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  updatedAt: number;
  /** The persisted event stream, in order, sequences contiguous from 1 per request. */
  events: WireEvent[];
}

/** List entry for the conversation picker. */
export interface HistorySummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Number of turns (question and answer pairs). */
  turns: number;
}

/** Storage behind the panel's history. Any method may throw or reject; the panel then keeps the conversation in memory only. */
export interface ConversationHistory {
  /** Saved conversations, newest first. */
  list(): MaybePromise<HistorySummary[]>;
  load(id: string): MaybePromise<StoredConversation | undefined>;
  /** Insert or replace by `id`. */
  save(conversation: StoredConversation): MaybePromise<void>;
  remove?(id: string): MaybePromise<void>;
}

export type HistoryErrorCode = 'unavailable' | 'quota' | 'too_large';

/** Why a history write failed. Messages are fixed; never storage internals. */
export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  constructor(code: HistoryErrorCode) {
    super(code === 'unavailable' ? 'Storage is not available.' : code === 'quota' ? 'Storage is full.' : 'The conversation is too large to save.');
    this.name = 'HistoryError';
    this.code = code;
  }
}

const KINDS = new Set(['update', 'permission', 'completed', 'error']);

function isWireEvent(value: unknown): value is WireEvent {
  if (typeof value !== 'object' || value === null) return false;
  const wire = value as Partial<WireEvent>;
  return wire.version === 1
    && typeof wire.conversation_id === 'string'
    && typeof wire.request_id === 'string' && wire.request_id !== ''
    && typeof wire.sequence === 'number'
    && typeof wire.event === 'object' && wire.event !== null
    && KINDS.has((wire.event as { kind?: unknown }).kind as string);
}

/** Validate stored JSON; unusable events are dropped, an unusable record gives `undefined`. */
export function parseStoredConversation(value: unknown): StoredConversation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.id !== 'string' || record.id === '' || !Array.isArray(record.events)) return undefined;
  return {
    version: 1,
    id: record.id,
    title: typeof record.title === 'string' ? record.title : '',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    events: record.events.filter(isWireEvent),
  };
}

/** Give each request contiguous sequences from 1 and one conversation id, so a filtered stream replays without gaps. */
export function renumberEvents(events: WireEvent[], conversationId: string): WireEvent[] {
  const counters = new Map<string, number>();
  return events.map((wire) => {
    const sequence = (counters.get(wire.request_id) ?? 0) + 1;
    counters.set(wire.request_id, sequence);
    return { ...wire, conversation_id: conversationId, sequence };
  });
}

/** Fold a stream into turns with the same reducer the panel uses live. Turns that never ended stay `streaming`. */
export function replayTurns(events: WireEvent[]): TurnState[] {
  const turns = new Map<string, TurnState>();
  for (const wire of events) {
    const turn = turns.get(wire.request_id) ?? newTurn(wire.request_id, '');
    turns.set(wire.request_id, applyWireEvent(turn, wire));
  }
  return [...turns.values()];
}

/** Snapshot (the shape `Conversation.snapshot()` returns) built without Wasm; used when no model is supplied. */
export function snapshotFromEvents(events: WireEvent[], conversationId: string): ConversationSnapshot {
  return { conversation_id: conversationId, turns: replayTurns(events), configuration: { options: [], modes: null } };
}

/** Title from the first non-empty question, whitespace collapsed, at most 60 characters. */
export function titleFromTurns(turns: TurnState[]): string {
  const first = turns.map((turn) => turn.user_text.replace(/\s+/g, ' ').trim()).find((line) => line !== '');
  if (!first) return '';
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

export function summarize(conversation: StoredConversation): HistorySummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    turns: new Set(conversation.events.map((wire) => wire.request_id)).size,
  };
}

/** The JSON file `AssistantPanel` offers as "Export". */
export interface ConversationExport {
  format: 'ccht.conversation';
  version: 1;
  exported_at: string;
  title: string;
  /** What the shared conversation model reports for `events`. */
  snapshot: ConversationSnapshot;
  /** The replayable stream behind the snapshot (after `persistFilter`). */
  events: WireEvent[];
}

export function buildExport(conversation: StoredConversation, snapshot: ConversationSnapshot, now: Date = new Date()): ConversationExport {
  return { format: 'ccht.conversation', version: 1, exported_at: now.toISOString(), title: conversation.title, snapshot, events: conversation.events };
}

/** `<title-slug>-YYYY-MM-DD.json`. */
export function exportFileName(title: string, now: Date = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'conversation';
  return `${slug}-${now.toISOString().slice(0, 10)}.json`;
}

/** Offer `value` as a JSON file download. Throws where the browser cannot. */
// Structural DOM types: the package type-checks without the DOM library (JSR forbids global lib directives).
interface DownloadLink { href: string; download: string; click(): void; remove(): void }
interface DownloadDocument { createElement(tag: 'a'): DownloadLink; body: { append(node: DownloadLink): void } }

export function downloadJson(fileName: string, value: unknown): void {
  const document = (globalThis as { document?: DownloadDocument }).document;
  if (!document) throw new Error('Downloads need a browser document.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Session-only history (nothing survives a reload). Useful as a default and in tests. */
export function memoryHistory(): ConversationHistory {
  const saved = new Map<string, StoredConversation>();
  return {
    list: () => [...saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize),
    load: (id) => { const found = saved.get(id); return found && structuredClone(found); },
    save: (conversation) => { saved.set(conversation.id, structuredClone(conversation)); },
    remove: (id) => { saved.delete(id); },
  };
}

export interface LocalStorageHistoryOptions {
  /** Oldest conversations are dropped beyond this many (default 20). */
  maxConversations?: number;
  /** Budget for all saved JSON together, in characters (default 1,000,000). The oldest conversations go first, then the oldest turns of the one being saved. */
  maxBytes?: number;
  /** Storage area; defaults to `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

interface IndexEntry extends HistorySummary { bytes: number }

/** `localStorage` history: one index entry plus one record per conversation, both under `key`. Quota and disabled storage surface as `HistoryError`. */
export function localStorageHistory(key: string, options: LocalStorageHistoryOptions = {}): ConversationHistory & { remove(id: string): void; clear(): void } {
  const maxConversations = Math.max(1, options.maxConversations ?? 20);
  const maxBytes = Math.max(1, options.maxBytes ?? 1_000_000);
  const indexKey = `${key}:index`;
  const recordKey = (id: string): string => `${key}:c:${id}`;

  function area(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    try {
      const found = options.storage ?? globalThis.localStorage;
      if (found) return found;
    } catch { /* Disabled or blocked storage throws on access. */ }
    throw new HistoryError('unavailable');
  }
  function read(name: string): string | null {
    try { return area().getItem(name); } catch { throw new HistoryError('unavailable'); }
  }
  function drop(name: string): void {
    try { area().removeItem(name); } catch { /* A leftover record is harmless. */ }
  }
  function readIndex(): IndexEntry[] {
    const raw = read(indexKey);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is IndexEntry => typeof item?.id === 'string' && typeof item.updatedAt === 'number' && typeof item.bytes === 'number')
        .map((item) => ({ id: item.id, title: typeof item.title === 'string' ? item.title : '', updatedAt: item.updatedAt, turns: Number(item.turns) || 0, bytes: item.bytes }));
    } catch {
      return [];
    }
  }
  const newestFirst = (entries: IndexEntry[]): IndexEntry[] => [...entries].sort((a, b) => b.updatedAt - a.updatedAt);

  /** Drop the oldest request until the JSON fits; gives up when one turn alone is too large. */
  function fit(conversation: StoredConversation): { payload: string; conversation: StoredConversation } {
    let events = conversation.events;
    for (;;) {
      const next = { ...conversation, events };
      const payload = JSON.stringify(next);
      if (payload.length <= maxBytes) return { payload, conversation: next };
      const first = events[0]?.request_id;
      const rest = events.filter((wire) => wire.request_id !== first);
      if (first === undefined || rest.length === 0) throw new HistoryError('too_large');
      events = rest;
    }
  }

  return {
    list: () => newestFirst(readIndex()).map(({ id, title, updatedAt, turns }) => ({ id, title, updatedAt, turns })),
    load(id) {
      const raw = read(recordKey(id));
      if (raw === null) return undefined;
      try { return parseStoredConversation(JSON.parse(raw)); } catch { return undefined; }
    },
    save(conversation) {
      const { payload, conversation: fitted } = fit({ ...conversation, events: renumberEvents(conversation.events, conversation.id) });
      const summary = summarize(fitted);
      const entry: IndexEntry = { ...summary, bytes: payload.length };
      // Newest first; the conversation being saved is always the newest, so eviction only ever takes older ones.
      let others = newestFirst(readIndex().filter((item) => item.id !== entry.id));
      const evict = (): boolean => {
        const oldest = others.pop();
        if (!oldest) return false;
        drop(recordKey(oldest.id));
        return true;
      };
      while (others.length + 1 > maxConversations) evict();
      while (others.length > 0 && others.reduce((sum, item) => sum + item.bytes, entry.bytes) > maxBytes) evict();
      for (;;) {
        try {
          const store = area();
          store.setItem(recordKey(entry.id), payload);
          store.setItem(indexKey, JSON.stringify([entry, ...others]));
          return;
        } catch (error) {
          if (error instanceof HistoryError) throw error;
          // Quota (or a blocked write): free the oldest other conversation and try again.
          if (!evict()) throw new HistoryError('quota');
        }
      }
    },
    remove(id) {
      drop(recordKey(id));
      try { area().setItem(indexKey, JSON.stringify(readIndex().filter((item) => item.id !== id))); } catch { throw new HistoryError('unavailable'); }
    },
    clear() {
      for (const item of readIndex()) drop(recordKey(item.id));
      drop(indexKey);
    },
  };
}
