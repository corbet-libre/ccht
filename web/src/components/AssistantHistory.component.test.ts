/** Browser behavior of the panel's history, export, account switch, copy overrides
 * and layout hooks (AssistantPanel.svelte). Providers are fakes; no network is used. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AssistantPanel from './AssistantPanel.svelte';
import type { WireEvent } from '../../index.js';
import type { ModelProvider, ModelRequest } from '../agent/types.ts';
import { memoryHistory, renumberEvents, localStorageHistory, type ConversationExport, type ConversationHistory, type StoredConversation } from '../history.ts';

function fakeProvider(id: string, label: string, over: Partial<ModelProvider> & { reply?: string } = {}) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider & { requests: ModelRequest[] } = {
    id, label, attribution: label, billing: 'free', requests,
    available: async () => ({ ok: true, state: 'ready' }),
    models: async () => [{ value: `${id}-m1`, name: `${label} Model One` }],
    stream(request: ModelRequest) {
      requests.push(request);
      return (async function* () {
        yield { type: 'text' as const, text: over.reply ?? `answer from ${id}` };
        yield { type: 'finish' as const, reason: 'stop' as const };
      })();
    },
    ...over,
  };
  return provider;
}

function media(match: { sheet?: boolean; short?: boolean } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width') ? !!match.sheet : query.includes('max-height') ? !!match.short : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  media();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

type View = ReturnType<typeof render>;

const readBlob = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});
/** The answer with its attribution line is on screen and the turn has ended. */
const answered = (view: View) => waitFor(() => {
  expect(view.getByText('via Free · Free Model One')).toBeTruthy();
  expect(view.container.querySelector('.ccht-chat-stop')).toBeNull();
});

async function mounted(props: Record<string, unknown> = {}): Promise<View> {
  const providers = (props.providers as ModelProvider[] | undefined) ?? [fakeProvider('free', 'Free')];
  const view = render(AssistantPanel, { open: true, ...props, providers });
  await waitFor(() => expect((view.getByLabelText(String((props.copy as { composerLabel?: string } | undefined)?.composerLabel ?? 'Your question')) as HTMLTextAreaElement).disabled).toBe(false));
  return view;
}

async function ask(view: View, question: string, label = 'Your question', send = 'Send') {
  await fireEvent.input(view.getByLabelText(label), { target: { value: question } });
  await fireEvent.click(view.getByRole('button', { name: send }));
}

const wire = (conversation: string, request: string, sequence: number, event: WireEvent['event']): WireEvent =>
  ({ version: 1, conversation_id: conversation, request_id: request, sequence, event });
const chunk = (conversation: string, request: string, sequence: number, kind: string, text: string): WireEvent =>
  wire(conversation, request, sequence, { kind: 'update', update: { sessionUpdate: kind, content: { type: 'text', text } } });

function stored(id: string, question: string, answer: string, updatedAt: number, finish = true): StoredConversation {
  const events = [
    chunk(id, 'r1', 1, 'user_message_chunk', question),
    chunk(id, 'r1', 2, 'agent_message_chunk', answer),
    ...(finish ? [wire(id, 'r1', 3, { kind: 'completed', stop_reason: 'end_turn' })] : []),
  ];
  return { version: 1, id, title: question, createdAt: updatedAt, updatedAt, events: renumberEvents(events, id) };
}

async function seeded(...items: StoredConversation[]): Promise<ConversationHistory> {
  const history = memoryHistory();
  for (const item of items) await history.save(item);
  return history;
}

describe('history: restore, save, new, pick', () => {
  test('the latest saved conversation is restored on mount and can continue', async () => {
    const free = fakeProvider('free', 'Free');
    const history = await seeded(stored('old', 'older question', 'older answer', 1), stored('latest', 'latest question', 'latest answer', 2));
    const view = await mounted({ providers: [free], history });
    expect(view.getByText('latest question')).toBeTruthy();
    expect(view.getByText('latest answer')).toBeTruthy();
    expect(view.queryByText('older question')).toBeNull();
    await ask(view, 'follow up');
    await waitFor(() => expect(free.requests).toHaveLength(1));
    // The restored turn is given to the model as earlier context.
    expect(free.requests[0]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    await waitFor(async () => expect((await history.load('latest'))!.events.some((event) => event.request_id !== 'r1')).toBe(true));
    const saved = (await history.load('latest'))!;
    expect(saved.events.every((event) => event.conversation_id === 'latest')).toBe(true);
  });

  test('with nothing saved the first answer is saved as a replayable stream with a title', async () => {
    const history = memoryHistory();
    const view = await mounted({ history });
    expect(view.queryByLabelText('Conversation')).toBeNull();
    await ask(view, 'What is this?');
    await waitFor(() => expect(view.getByText('answer from free')).toBeTruthy());
    await waitFor(async () => expect(await history.list()).toHaveLength(1));
    const [summary] = await history.list();
    expect(summary).toMatchObject({ title: 'What is this?', turns: 1 });
    const saved = (await history.load(summary!.id))!;
    expect(saved.id).toMatch(/^assistant:/);
    expect(saved.events.map((event) => event.sequence)).toEqual(saved.events.map((_, index) => index + 1));
    expect(saved.events.at(-1)!.event).toMatchObject({ kind: 'completed' });
  });

  test('New starts an empty conversation, the earlier one stays pickable and can be reopened', async () => {
    const history = await seeded(stored('one', 'first question', 'first answer', 1));
    const view = await mounted({ history });
    await fireEvent.click(view.getByRole('button', { name: 'New conversation' }));
    expect(view.queryByText('first question')).toBeNull();
    const picker = view.getByLabelText('Conversation') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(['New conversation', 'first question · 2 messages']);
    await ask(view, 'second question');
    await waitFor(async () => expect(await history.list()).toHaveLength(2));
    await waitFor(() => expect([...(view.getByLabelText('Conversation') as HTMLSelectElement).options]).toHaveLength(3));
    await fireEvent.change(view.getByLabelText('Conversation'), { target: { value: 'one' } });
    await waitFor(() => expect(view.getByText('first answer')).toBeTruthy());
    expect(view.queryByText('second question')).toBeNull();
    expect((view.getByLabelText('Conversation') as HTMLSelectElement).value).toBe('one');
    await fireEvent.change(view.getByLabelText('Conversation'), { target: { value: '' } });
    expect(view.queryByText('first answer')).toBeNull();
  });

  test('a turn that was still running when the page was left is closed as interrupted', async () => {
    const history = await seeded(stored('cut', 'question', 'half an ans', 1, false));
    const view = await mounted({ history, copy: { interrupted: 'Cut short.' } });
    expect(view.getByText('half an ans')).toBeTruthy();
    expect(view.getByRole('alert').textContent).toBe('interrupted: Cut short.');
  });

  test('works with localStorageHistory', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => void data.set(name, value), removeItem: (name: string) => void data.delete(name) };
    const view = await mounted({ history: localStorageHistory('test-history', { storage }) });
    await ask(view, 'persist me');
    await waitFor(() => expect(data.get('test-history:index')).toContain('persist me'));
    cleanup();
    const again = await mounted({ history: localStorageHistory('test-history', { storage }) });
    expect(again.getByText('persist me')).toBeTruthy();
  });
});

describe('history: failures degrade to memory', () => {
  test('a failing save shows one notice and the conversation keeps working', async () => {
    const history: ConversationHistory = { ...memoryHistory(), save: () => { throw new Error('quota'); } };
    const view = await mounted({ history });
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByText('answer from free')).toBeTruthy());
    await waitFor(() => expect(view.getAllByText(/History could not be saved here/)).toHaveLength(1));
    await ask(view, 'again');
    await waitFor(() => expect(view.getAllByText('answer from free')).toHaveLength(2));
    expect(view.getAllByText(/History could not be saved here/)).toHaveLength(1);
  });

  test('a failing list on mount shows the notice and the panel still works', async () => {
    const history: ConversationHistory = { ...memoryHistory(), list: () => { throw new Error('blocked'); } };
    const view = await mounted({ history, copy: { historyUnavailable: 'No history here.' } });
    expect(view.getByText('No history here.')).toBeTruthy();
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByText('answer from free')).toBeTruthy());
  });

  test('a record that disappeared is skipped quietly', async () => {
    const base = await seeded(stored('gone', 'q', 'a', 1));
    const history: ConversationHistory = { ...base, load: () => undefined };
    const view = await mounted({ history });
    expect(view.queryByText('q')).toBeNull();
    expect(view.queryByText(/History could not/)).toBeNull();
  });
});

describe('persistFilter', () => {
  const secretProvider = () => fakeProvider('free', 'Free', { reply: 'The price is SECRET-42.' });

  test('dropped events never reach storage; the filtered stream stays replayable; onEvent sees everything', async () => {
    const history = memoryHistory();
    const onEvent = vi.fn();
    const view = await mounted({
      providers: [secretProvider()], history, onEvent,
      persistFilter: (event: WireEvent) => !JSON.stringify(event).includes('SECRET'),
    });
    await ask(view, 'price?');
    await waitFor(() => expect(view.getByText('The price is SECRET-42.')).toBeTruthy());
    await waitFor(async () => expect(await history.list()).toHaveLength(1));
    const saved = (await history.load((await history.list())[0]!.id))!;
    expect(JSON.stringify(saved)).not.toContain('SECRET');
    expect(saved.events.length).toBeGreaterThan(0);
    expect(saved.events.map((event) => event.sequence)).toEqual(saved.events.map((_, index) => index + 1));
    expect(onEvent.mock.calls.map(([event]) => JSON.stringify(event)).join()).toContain('SECRET');
  });

  test('a replacement event redacts; a throwing filter drops the event', async () => {
    const history = memoryHistory();
    const redact = (event: WireEvent): WireEvent | boolean => {
      const text = JSON.stringify(event);
      return text.includes('SECRET') ? (JSON.parse(text.replace('SECRET-42', '[removed]')) as WireEvent) : true;
    };
    const view = await mounted({ providers: [secretProvider()], history, persistFilter: redact });
    await ask(view, 'price?');
    await waitFor(async () => expect(await history.list()).toHaveLength(1));
    const saved = JSON.stringify(await history.load((await history.list())[0]!.id));
    expect(saved).toContain('The price is [removed].');
    cleanup();

    const second = memoryHistory();
    const throwing = await mounted({ providers: [secretProvider()], history: second, persistFilter: () => { throw new Error('boom'); } });
    await ask(throwing, 'price?');
    await waitFor(() => expect(throwing.getByText('The price is SECRET-42.')).toBeTruthy());
    expect(await second.list()).toHaveLength(0);
  });

  test('export contains only what the filter kept', async () => {
    const onExport = vi.fn();
    const view = await mounted({ providers: [secretProvider()], persistFilter: (event: WireEvent) => !JSON.stringify(event).includes('SECRET'), onExport });
    await ask(view, 'price?');
    await waitFor(() => expect(view.getByText('The price is SECRET-42.')).toBeTruthy());
    await fireEvent.click(await view.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(JSON.stringify(onExport.mock.calls[0]![0])).not.toContain('SECRET');
  });
});

describe('export', () => {
  test('is offered once there is a turn and hands the snapshot and events to onExport', async () => {
    const onExport = vi.fn();
    const view = await mounted({ onExport });
    expect(view.queryByRole('button', { name: 'Export' })).toBeNull();
    await ask(view, 'Explain it');
    await answered(view);
    await fireEvent.click(view.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    const [data, fileName] = onExport.mock.calls[0]! as [ConversationExport, string];
    expect(data).toMatchObject({ format: 'ccht.conversation', version: 1, title: 'Explain it' });
    expect(data.snapshot.conversation_id).toBe('assistant');
    expect(data.snapshot.turns).toHaveLength(1);
    expect(data.snapshot.turns[0]).toMatchObject({ user_text: 'Explain it', text: 'answer from free', status: 'completed' });
    expect(data.events.at(-1)!.event).toMatchObject({ kind: 'completed' });
    expect(fileName).toMatch(/^explain-it-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test('downloads a JSON file by default', async () => {
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:test'; }, revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = await mounted();
    await ask(view, 'hello');
    await answered(view);
    await fireEvent.click(view.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created[0]!.type).toBe('application/json');
    expect(JSON.parse(await readBlob(created[0]!)).snapshot.turns[0].user_text).toBe('hello');
    click.mockRestore();
  });

  test('a browser that cannot download gets a notice', async () => {
    const view = await mounted({ copy: { exportFailed: 'Export failed.' } });
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByText('answer from free')).toBeTruthy());
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
    await fireEvent.click(view.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(view.getByText('Export failed.')).toBeTruthy());
  });

  test('the snapshot comes from the shared model when one is supplied', async () => {
    const applied: unknown[] = [];
    const free = vi.fn();
    const model = {
      applyEvent: (event: unknown) => { applied.push(event); return {} as never; },
      snapshot: () => ({ conversation_id: 'from-model', turns: [], configuration: { options: [], modes: null } }),
      free,
    };
    const onExport = vi.fn();
    const conversationModel = vi.fn(async () => model);
    const view = await mounted({ conversationModel, onExport });
    await ask(view, 'hello');
    await answered(view);
    await fireEvent.click(view.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(conversationModel).toHaveBeenCalledWith('assistant');
    expect(applied.length).toBeGreaterThan(2);
    expect(onExport.mock.calls[0]![0].snapshot.conversation_id).toBe('from-model');
    expect(free).toHaveBeenCalled();
  });

  test('a failing shared model falls back to the built-in fold', async () => {
    const onExport = vi.fn();
    const view = await mounted({ conversationModel: async () => { throw new Error('wasm missing'); }, onExport });
    await ask(view, 'hello');
    await answered(view);
    await fireEvent.click(view.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(onExport.mock.calls[0]![0].snapshot.turns[0].text).toBe('answer from free');
  });
});

function accountProvider(id: string, label: string, connected = false) {
  const base = fakeProvider(id, label, {
    available: async () => (connected ? { ok: true, state: 'ready' } : { ok: false, state: 'needs_sign_in', reason: `Connect your ${label} account.` }),
  });
  return Object.assign(base, { account: { connected: () => connected, connect: async () => { connected = true; }, disconnect: () => { connected = false; } } });
}

describe('accountControls', () => {
  test('are shown by default', async () => {
    const view = await mounted({ providers: [fakeProvider('free', 'Free'), accountProvider('own', 'Own')] });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(view.getByLabelText(/Own/));
    expect(await view.findByRole('button', { name: 'Connect account' })).toBeTruthy();
  });

  test('accountControls=false hides Connect while the provider and its reason stay visible', async () => {
    const view = await mounted({ providers: [fakeProvider('free', 'Free'), accountProvider('own', 'Own')], accountControls: false });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(view.getByLabelText(/Own/));
    await waitFor(() => expect((view.getByLabelText(/Own/) as HTMLInputElement).checked).toBe(true));
    expect(view.queryByRole('button', { name: 'Connect account' })).toBeNull();
    expect(view.getAllByText('Connect your Own account.').length).toBeGreaterThan(0);
  });

  test('accountControls=false hides Connected and Disconnect but keeps the billed-models opt-in', async () => {
    const own = accountProvider('own', 'Own', true);
    const view = await mounted({ providers: [own], accountControls: false });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    expect(view.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(view.queryByText('Connected')).toBeNull();
    expect(view.getByLabelText('Allow models billed to my account')).toBeTruthy();
  });
});

describe('copy overrides', () => {
  const german = {
    composerLabel: 'Ihre Frage', sendLabel: 'Senden', you: 'Sie', stop: 'Anhalten', copyMessage: 'Kopieren', copied: 'Kopiert',
    settingsLabel: 'Einstellungen', newConversationLabel: 'Neues Gespräch', exportLabel: 'Exportieren', closeText: 'Schließen',
    closeLabel: 'Assistent schließen', conversationPicker: 'Gespräch', untitled: 'Ohne Titel', reasoning: 'Überlegung', plan: 'Plan',
    messagesLabel: (title: string) => `Nachrichten von ${title}`, status: { completed: 'Fertig' },
    openLabel: (title: string, summary: string) => `${title} öffnen${summary ? `: ${summary}` : ''}`,
    contextUsage: (used: number) => `Kontext: ${used}`,
  };

  test('no English is left in the chat chrome', async () => {
    const view = await mounted({ copy: german, history: memoryHistory() });
    await ask(view, 'Hallo', 'Ihre Frage', 'Senden');
    await answered(view);
    expect(view.getByText('Sie')).toBeTruthy();
    expect(view.getAllByRole('button', { name: 'Kopieren' })).toHaveLength(2);
    expect(view.getByRole('button', { name: 'Einstellungen' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Exportieren' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Neues Gespräch' })).toBeTruthy();
    expect(view.getByText('Schließen')).toBeTruthy();
    expect(view.getByText('Fertig')).toBeTruthy();
    expect(view.getByLabelText('Nachrichten von Assistant')).toBeTruthy();
    for (const english of ['You', 'Copy', 'Settings', 'Export', 'New conversation', 'Done', 'Close']) {
      expect(view.queryByText(english)).toBeNull();
    }
    await fireEvent.click(view.getAllByRole('button', { name: 'Kopieren' })[0]!);
    await waitFor(() => expect(view.getByText('Kopiert')).toBeTruthy());
  });

  test('Stop and the picker use the copy object', async () => {
    const hang = fakeProvider('free', 'Free', {
      stream(request: ModelRequest) {
        return (async function* () {
          yield { type: 'text' as const, text: 'working' };
          await new Promise<void>((resolve) => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve()); });
          yield { type: 'text' as const, text: 'late' };
        })();
      },
    });
    const history = await seeded(stored('x', '', 'a', 1));
    const view = await mounted({ providers: [hang], history, copy: { stop: 'Anhalten', conversationPicker: 'Gespräch', untitled: 'Ohne Titel', historyItem: (title: string, n: number) => `${title} · ${n} Nachrichten` } });
    expect((view.getByLabelText('Gespräch') as HTMLSelectElement).options[1]!.textContent).toBe('Ohne Titel · 2 Nachrichten');
    await ask(view, 'go');
    await fireEvent.click(await view.findByRole('button', { name: 'Anhalten' }));
    await waitFor(() => expect(view.queryByRole('button', { name: 'Anhalten' })).toBeNull());
    expect(view.queryByText('Stop')).toBeNull();
  });

  test('turn failures use the copy messages, not fixed English', async () => {
    const broken = fakeProvider('free', 'Free', { stream: () => { throw new Error('upstream'); } });
    const view = await mounted({ providers: [broken], copy: { errorLine: (error: { code: string }) => `Fehler ${error.code}` } });
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(/^Fehler /));
  });

  test('the edge tab and close button follow the copy', async () => {
    const view = render(AssistantPanel, { providers: [fakeProvider('free', 'Free')], copy: german });
    expect(view.getByRole('button', { name: 'Assistant öffnen' })).toBeTruthy();
  });
});

describe('layout', () => {
  test('tall viewports keep the footer open; short ones fold the extras into a collapsed block', async () => {
    const options = { doorPrompt: () => 'prompt', mcpUrl: 'https://example.com/mcp', copy: { privacyNotice: 'Goes to the provider.', moreLabel: 'More info' } };
    const tall = await mounted(options);
    expect(tall.container.querySelector('.ccht-assistant')!.classList.contains('ccht-assistant-short')).toBe(false);
    expect(tall.container.querySelector('.ccht-assistant-more')).toBeNull();
    expect(tall.getByText('Copy prompt')).toBeTruthy();
    cleanup();

    media({ short: true });
    const short = await mounted(options);
    const wrapper = short.container.querySelector('.ccht-assistant')!;
    expect(wrapper.classList.contains('ccht-assistant-short')).toBe(true);
    expect(wrapper.classList.contains('ccht-assistant-sheet')).toBe(false);
    const more = short.container.querySelector('details.ccht-assistant-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')!.textContent).toBe('More info');
    expect(more.textContent).toContain('Copy prompt');
    // The privacy line is never folded away.
    expect(more.textContent).not.toContain('Goes to the provider.');
    expect(short.getByText('Goes to the provider.')).toBeTruthy();
  });

  test('a short viewport without extras renders no empty block', async () => {
    media({ short: true });
    const view = await mounted();
    expect(view.container.querySelector('.ccht-assistant-more')).toBeNull();
  });

  test('settings are an overlay inside the panel, not part of the transcript flow', async () => {
    const view = await mounted();
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    const picker = view.container.querySelector('.ccht-assistant-picker')!;
    expect(picker.closest('.ccht-chat-status-note')).not.toBeNull();
    expect(picker.compareDocumentPosition(view.container.querySelector('.ccht-chat-messages')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    expect(view.container.querySelector('.ccht-assistant-picker')).toBeNull();
  });

  test('stylesheet: 16px inputs only on touch devices, transcript keeps half the panel', () => {
    const sources = ['AssistantPanel', 'ChatDock', 'ProviderPicker'].map((name) => readFileSync(join(process.cwd(), 'src/components', `${name}.svelte`), 'utf8'));
    for (const source of sources) {
      const css = source.slice(source.indexOf('<style>'));
      // Every 16px rule sits inside a coarse-pointer media query.
      const outside = css.replace(/@media \(pointer: coarse\) \{[\s\S]*?\n  \}/g, '');
      expect(outside).not.toMatch(/font-size:\s*16px/);
      expect(css).toContain('(pointer: coarse)');
    }
    expect(sources[0]).toContain('min-height: max(6rem, 50%)');
  });
});
