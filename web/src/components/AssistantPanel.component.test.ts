/** Browser behavior of the drop-in assistant surface (AssistantPanel.svelte):
 * open/close, provider switch, per-answer attribution, door openers, MCP
 * disclosure and the mobile sheet. Providers are fakes; no network is used. */
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AssistantPanel from './AssistantPanel.svelte';
import type { ModelProvider, ModelRequest } from '../agent/types.ts';
import { createAccounts } from '../accounts.ts';

function fakeProvider(id: string, label: string, over: Partial<ModelProvider> & { reply?: string; models?: Array<{ value: string; name: string }> } = {}) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider & { requests: ModelRequest[] } = {
    id, label, attribution: label, billing: 'free', requests,
    available: async () => ({ ok: true, state: 'ready' }),
    models: async () => over.models ?? [{ value: `${id}-m1`, name: `${label} Model One` }, { value: `${id}-m2`, name: `${label} Model Two` }],
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

function setWidth(small: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: small, media: query,
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn),
  }));
  return (matches: boolean) => listeners.forEach((fn) => fn({ matches }));
}

beforeEach(() => {
  setWidth(false);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

async function mounted(props: Record<string, unknown> = {}) {
  const providers = (props.providers as ModelProvider[] | undefined) ?? [fakeProvider('free', 'Free')];
  const view = render(AssistantPanel, { open: true, ...props, providers });
  await waitFor(() => expect((view.getByLabelText('Your question') as HTMLTextAreaElement).disabled).toBe(false));
  return view;
}

async function ask(view: Awaited<ReturnType<typeof mounted>>, question: string) {
  await fireEvent.input(view.getByLabelText('Your question'), { target: { value: question } });
  await fireEvent.click(view.getByRole('button', { name: 'Send' }));
}

describe('open and close', () => {
  test('the edge tab opens the panel; Escape and the close button close it', async () => {
    const onOpenChange = vi.fn();
    const view = render(AssistantPanel, { providers: [fakeProvider('free', 'Free')], onOpenChange, copy: { tabSummary: 'help' } });
    const panel = () => document.getElementById('ccht-assistant-panel')!;
    expect(panel().getAttribute('data-open')).toBe('false');
    await fireEvent.click(view.getByRole('button', { name: 'Open Assistant: help' }));
    await waitFor(() => expect(panel().getAttribute('data-open')).toBe('true'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(panel().getAttribute('data-open')).toBe('false'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await fireEvent.click(view.getByRole('button', { name: 'Open Assistant: help' }));
    await fireEvent.click(view.getByRole('button', { name: 'Close assistant' }));
    await waitFor(() => expect(panel().getAttribute('data-open')).toBe('false'));
  });

  test('showTab=false leaves opening to the app', () => {
    const view = render(AssistantPanel, { providers: [fakeProvider('free', 'Free')], showTab: false });
    expect(view.queryByRole('button', { name: /Open Assistant/ })).toBeNull();
  });
});

describe('conversation and attribution', () => {
  test('an answer shows "via <provider> · <model>"; the question and privacy line are visible', async () => {
    const free = fakeProvider('free', 'Free');
    const view = await mounted({ providers: [free], instructions: 'Be brief.', contextLine: () => 'on the pricing page', copy: { privacyNotice: 'Everything goes to the selected provider.' } });
    expect(view.getByText('Everything goes to the selected provider.')).toBeTruthy();
    await ask(view, 'What is this?');
    await waitFor(() => expect(view.getByText('answer from free')).toBeTruthy());
    await waitFor(() => expect(view.getByText('via Free · Free Model One')).toBeTruthy());
    expect(view.getByText('What is this?')).toBeTruthy();
    const system = free.requests[0]!.messages.find((message) => message.role === 'system');
    expect(system && 'content' in system ? system.content : '').toContain('Be brief.');
    expect(system && 'content' in system ? system.content : '').toContain('on the pricing page');
  });

  test('the privacy line can be hidden', async () => {
    const view = await mounted({ privacyNotice: '' });
    expect(view.queryByText(/sent to the selected provider/)).toBeNull();
  });

  test('switching provider and model changes who answers and who is credited', async () => {
    const first = fakeProvider('one', 'Alpha');
    const second = fakeProvider('two', 'Beta', { reply: 'beta says hi' });
    const view = await mounted({ providers: [first, second] });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(view.getByLabelText(/Beta/));
    await waitFor(() => expect((view.getByLabelText(/Beta/) as HTMLInputElement).checked).toBe(true));
    await fireEvent.change(view.getByLabelText('Model'), { target: { value: 'two-m2' } });
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByText('beta says hi')).toBeTruthy());
    expect(first.requests).toHaveLength(0);
    expect(second.requests[0]!.model).toBe('two-m2');
    await waitFor(() => expect(view.getByText('via Beta · Beta Model Two')).toBeTruthy());
  });

  test('earlier turns are sent as history and a new conversation clears them', async () => {
    const free = fakeProvider('free', 'Free');
    const view = await mounted({ providers: [free] });
    await ask(view, 'first');
    await waitFor(() => expect(view.getByText('via Free · Free Model One')).toBeTruthy());
    await ask(view, 'second');
    await waitFor(() => expect(free.requests).toHaveLength(2));
    expect(free.requests[1]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    await fireEvent.click(view.getByRole('button', { name: 'New conversation' }));
    expect(view.queryByText('first')).toBeNull();
  });

  test('a provider failure ends the turn with a stable error, not upstream text', async () => {
    const broken = fakeProvider('free', 'Free', { stream: () => { throw new Error('upstream secret detail'); } });
    const view = await mounted({ providers: [broken] });
    await ask(view, 'hello');
    await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
    expect(document.body.textContent).not.toContain('upstream secret detail');
  });

  test('createAgent supplies a ready agent and onEvent sees every wire event', async () => {
    const free = fakeProvider('free', 'Free');
    const onEvent = vi.fn();
    const turn = vi.fn(async function* (input: { conversationId: string; requestId?: string }) {
      yield { version: 1 as const, conversation_id: input.conversationId, request_id: input.requestId!, sequence: 1, event: { kind: 'update' as const, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'custom agent' } } } };
      yield { version: 1 as const, conversation_id: input.conversationId, request_id: input.requestId!, sequence: 2, event: { kind: 'completed' as const, stop_reason: 'end_turn' } };
    });
    const view = await mounted({ providers: [free], createAgent: () => ({ provider: free, turn }), onEvent });
    await ask(view, 'hi');
    await waitFor(() => expect(view.getByText('custom agent')).toBeTruthy());
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(free.requests).toHaveLength(0);
  });

  test('without a usable provider the settings open and sending is blocked', async () => {
    const down = fakeProvider('free', 'Free', { available: async () => ({ ok: false, state: 'unavailable', reason: 'Free chat is down.' }) });
    const view = render(AssistantPanel, { open: true, providers: [down] });
    await waitFor(() => expect(view.getAllByText('Free chat is down.').length).toBeGreaterThan(0));
    expect((view.getByLabelText('Your question') as HTMLTextAreaElement).disabled).toBe(true);
    expect(view.getByLabelText(/Free/)).toBeTruthy();
  });

  test('the selection is remembered only when the app gives storage', async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const providers = [fakeProvider('one', 'Alpha'), fakeProvider('two', 'Beta')];
    const view = await mounted({ providers, storage });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(view.getByLabelText(/Beta/));
    await waitFor(() => expect(JSON.parse(store.get('ccht.assistant.v1')!).provider).toBe('two'));
    cleanup();
    const again = await mounted({ providers, storage });
    await fireEvent.click(again.getByRole('button', { name: 'Settings' }));
    expect((again.getByLabelText(/Beta/) as HTMLInputElement).checked).toBe(true);
  });
});

function accountProvider(id: string, label: string) {
  let connected = false;
  const base = fakeProvider(id, label, {
    available: async () => (connected ? { ok: true, state: 'ready' } : { ok: false, state: 'needs_sign_in', reason: `Connect your ${label} account.` }),
  });
  return Object.assign(base, {
    account: { connected: () => connected, connect: async () => { connected = true; }, disconnect: () => { connected = false; } },
  });
}

describe('own accounts', () => {
  test('connecting from the picker makes the provider usable; disconnecting takes it away', async () => {
    const free = fakeProvider('free', 'Free');
    const own = accountProvider('own', 'Own');
    const view = await mounted({ providers: [free, own] });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(view.getByLabelText(/Own/));
    await fireEvent.click(await view.findByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(view.getByText('Connected')).toBeTruthy());
    await fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Connect account' })).toBeTruthy());
  });

  test('a connection made elsewhere (accounts store) refreshes the provider list', async () => {
    const free = fakeProvider('free', 'Free');
    const own = accountProvider('own', 'Own');
    const accounts = createAccounts([own]);
    const view = await mounted({ providers: [free, own], accounts });
    await fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    expect(view.getByText('Connect your Own account.')).toBeTruthy();
    await accounts.connect('own');
    await waitFor(() => expect(view.queryByText('Connect your Own account.')).toBeNull());
    expect((view.getByLabelText(/Own/) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('ask your own assistant', () => {
  test('door links carry the built prompt, update with the draft and the prompt can be copied', async () => {
    const view = await mounted({ doorPrompt: ({ draft }: { draft: string }) => `Context line. Question: ${draft || 'none yet'}`, assistants: ['chatgpt', 'perplexity'] });
    const chatgpt = view.getByRole('link', { name: 'ChatGPT' }) as HTMLAnchorElement;
    expect(chatgpt.href).toBe(`https://chatgpt.com/?q=${encodeURIComponent('Context line. Question: none yet')}`);
    expect(chatgpt.target).toBe('_blank');
    expect(chatgpt.rel).toContain('noopener');
    expect(view.queryByRole('link', { name: 'Claude' })).toBeNull();
    await fireEvent.input(view.getByLabelText('Your question'), { target: { value: 'compare A & B' } });
    await waitFor(() => expect((view.getByRole('link', { name: 'Perplexity' }) as HTMLAnchorElement).href).toContain(encodeURIComponent('compare A & B')));
    await fireEvent.click(view.getByRole('button', { name: 'Copy prompt' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Context line. Question: compare A & B');
    await waitFor(() => expect(view.getByText('Copied')).toBeTruthy());
  });

  test('the row is absent without a door prompt', async () => {
    const view = await mounted();
    expect(view.queryByText('Ask your own assistant:')).toBeNull();
  });

  test('the MCP disclosure shows the connector and copies the address; a bad address hides it', async () => {
    const view = await mounted({ mcpUrl: 'https://example.com/mcp', mcpName: 'demo' });
    expect(view.getByText('Use this in your own assistant (MCP)')).toBeTruthy();
    expect(view.getByText('https://example.com/mcp')).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Copy address' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.com/mcp');
    cleanup();
    const bad = await mounted({ mcpUrl: 'http://example.com/mcp' });
    expect(bad.queryByText('Use this in your own assistant (MCP)')).toBeNull();
  });

  test('copy strings are overridable', async () => {
    const view = await mounted({ doorPrompt: () => 'x', copy: { doorsLabel: 'Take it elsewhere:', copyPrompt: 'Copy question' } });
    expect(view.getByText('Take it elsewhere:')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Copy question' })).toBeTruthy();
  });
});

describe('mobile sheet', () => {
  test('wide screens keep the rail; small screens switch to the sheet', async () => {
    const view = await mounted();
    expect(view.container.querySelector('.ccht-assistant')!.classList.contains('ccht-assistant-sheet')).toBe(false);
    cleanup();
    setWidth(true);
    const small = await mounted();
    const wrapper = small.container.querySelector('.ccht-assistant')!;
    expect(wrapper.classList.contains('ccht-assistant-sheet')).toBe(true);
    expect(document.getElementById('ccht-assistant-panel')!.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  test('following a width change updates the sheet class, modal flag and scroll lock', async () => {
    const change = setWidth(false);
    const view = await mounted();
    const wrapper = view.container.querySelector('.ccht-assistant')!;
    change(true);
    await waitFor(() => expect(wrapper.classList.contains('ccht-assistant-sheet')).toBe(true));
    change(false);
    await waitFor(() => expect(wrapper.classList.contains('ccht-assistant-sheet')).toBe(false));
    expect(document.body.style.overflow).toBe('');
    expect(document.getElementById('ccht-assistant-panel')!.getAttribute('aria-modal')).toBe('false');
  });

  test('Tab stays inside the open sheet', async () => {
    setWidth(true);
    const view = await mounted();
    const panel = document.getElementById('ccht-assistant-panel')!;
    const controls = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href], select, input:not([disabled]), summary')];
    const last = controls[controls.length - 1]!;
    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    const first = controls[0]!;
    first.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    view.unmount();
  });

  test('wide screens do not trap Tab', async () => {
    await mounted();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
