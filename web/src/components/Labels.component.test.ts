/** Every user-facing string of the shared components comes from overridable
 * labels with English defaults: ChatDock, Dock, ProviderPicker,
 * AccountConnection and StepConfig. (AssistantPanel's copy object is covered
 * in AssistantHistory.component.test.ts; the accounts components already take
 * their own copy.) */
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AccountConnection from './AccountConnection.svelte';
import ChatDock from './ChatDock.svelte';
import Dock from './Dock.svelte';
import ProviderPicker from './ProviderPicker.svelte';
import StepConfig from './StepConfig.svelte';
import type { StepData } from './StepConfig.svelte';
import type { ProviderEntry } from '../providers/inspect.ts';
import { createRawSnippet } from 'svelte';

afterEach(() => cleanup());
vi.stubGlobal('navigator', Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } }));

const chatProps = {
  kicker: 'k', title: 'Chat', composerId: 'c', composerLabel: 'Ask', composerPlaceholder: '…', sendLabel: 'Go',
  welcomeTitle: 'Bot', welcomeBody: 'b', welcomeExample: 'e', draft: '', onSend: () => {},
};

function activity(over: Record<string, unknown> = {}) {
  return {
    request_id: 'r', last_sequence: 3, text: 'answer', user_text: 'q', user_content: [], thought_text: 'pondering', thought_content: [],
    content: [], tools: { t1: { toolCallId: 't1', title: 'Lookup' } },
    permissions: [{ request_id: 'p1', request: {} }, { request_id: 'p2', request: {} }],
    updates: { usage_update: { used: 1200, size: 8000 }, plan: { entries: [{ content: 'step', status: 'done' }] } },
    status: 'failed', stop_reason: null, error: { code: 'rate_limited', message: 'Slow down.' }, ...over,
  };
}

describe('ChatDock labels', () => {
  const messages = [
    { id: 'u', role: 'user' as const, content: 'q' },
    { id: 'a', role: 'assistant' as const, content: 'answer', activity: activity() as never },
    { id: 'b', role: 'assistant' as const, content: 'old answer', requestId: 'old' },
  ];

  test('English defaults are unchanged', () => {
    const view = render(ChatDock, { ...chatProps, messages, submitting: true, onStop: () => {}, onShowActivity: () => {} });
    for (const text of ['You', 'Stop', 'Show activity', 'Reasoning', 'Plan', 'Failed', 'rate_limited: Slow down.', 'Context: 1,200 / 8,000 tokens']) {
      expect(view.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(view.getAllByText('Copy')).toHaveLength(3);
    expect(view.getByText('Lookup · pending')).toBeTruthy();
    expect(view.getByText('2 permission requests pending: p1, p2')).toBeTruthy();
    expect(view.getByLabelText('Chat messages')).toBeTruthy();
  });

  test('every string can be replaced', async () => {
    const labels = {
      you: 'Sie', stop: 'Anhalten', copyMessage: 'Kopieren', copied: 'Kopiert', showActivity: 'Aktivität zeigen', reasoning: 'Überlegung', plan: 'Vorhaben',
      conversationPicker: 'Gespräch', untitled: 'Ohne Titel', historyItem: (title: string, n: number) => `${title} · ${n} Nachrichten`, toolPending: 'wartet',
      messagesLabel: (title: string) => `Nachrichten: ${title}`,
      contextUsage: (used: number, size: number | undefined) => `Kontext ${used}/${size}`,
      permissionsPending: (ids: string[]) => `${ids.length} Freigaben offen`,
      errorLine: (error: { code: string }) => `Fehler ${error.code}`,
      status: { failed: 'Fehlgeschlagen' },
    };
    const view = render(ChatDock, {
      ...chatProps, messages, labels, submitting: true, onStop: () => {}, onShowActivity: () => {}, onSelectHistory: () => {},
      showHistoryPicker: true, history: [{ id: 'h', title: null, message_count: 2 }],
    });
    for (const text of ['Sie', 'Anhalten', 'Aktivität zeigen', 'Überlegung', 'Vorhaben', 'Fehlgeschlagen', 'Fehler rate_limited', 'Kontext 1200/8000', 'Lookup · wartet', '2 Freigaben offen']) {
      expect(view.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(view.getByLabelText('Nachrichten: Chat')).toBeTruthy();
    expect(view.getByLabelText('Gespräch')).toBeTruthy();
    expect(view.getByText('Ohne Titel · 2 Nachrichten')).toBeTruthy();
    await fireEvent.click(view.getAllByText('Kopieren')[0]!);
    await vi.waitFor(() => expect(view.getByText('Kopiert')).toBeTruthy());
    for (const english of ['You', 'Stop', 'Copy', 'Show activity', 'Reasoning', 'Plan', 'Failed', 'Conversation']) {
      expect(view.queryByText(english)).toBeNull();
    }
  });

  test('a single status can be replaced without losing the others, and statusLabel still wins', () => {
    const one = render(ChatDock, { ...chatProps, messages: [{ id: 'a', role: 'assistant', content: 'x', activity: activity({ error: null, status: 'completed' }) as never }], labels: { status: { completed: 'Erledigt' } } });
    expect(one.getByText('Erledigt')).toBeTruthy();
    cleanup();
    const other = render(ChatDock, { ...chatProps, messages: [{ id: 'a', role: 'assistant', content: 'x', activity: activity({ error: null, status: 'cancelled' }) as never }], labels: { status: { completed: 'Erledigt' } } });
    expect(other.getByText('Stopped')).toBeTruthy();
    cleanup();
    const custom = render(ChatDock, { ...chatProps, messages: [{ id: 'a', role: 'assistant', content: 'x', activity: activity({ error: null, status: 'completed' }) as never }], statusLabel: () => 'Custom' });
    expect(custom.getByText('Custom')).toBeTruthy();
  });
});

describe('Dock labels', () => {
  const dock = (props: Record<string, unknown> = {}) => render(Dock, {
    side: 'right', title: 'Help', open: false, onClose: () => {}, onOpen: () => {}, tabLabel: 'Help', panelId: 'd',
    children: createRawSnippet(() => ({ render: () => '<p>body</p>' })), ...props,
  });

  test('defaults', () => {
    const view = dock({ tabSummary: 'ask' });
    expect(view.getByRole('button', { name: 'Open Help: ask' })).toBeTruthy();
    expect(view.container.querySelector('.ccht-dock-close')!.textContent).toBe('Close');
  });

  test('the close text and the tab name are replaceable', () => {
    const view = dock({ tabSummary: 'fragen', closeText: 'Schließen', openLabel: (title: string, summary: string) => `${title} öffnen (${summary})` });
    expect(view.getByRole('button', { name: 'Help öffnen (fragen)' })).toBeTruthy();
    expect(view.container.querySelector('.ccht-dock-close')!.textContent).toBe('Schließen');
  });
});

describe('ProviderPicker labels', () => {
  const local: ProviderEntry = {
    id: 'local', label: 'Local', attribution: 'x', billing: 'free', models: [],
    availability: { ok: false, state: 'needs_consent', reason: 'Download first.', download: { approxMB: 10 } },
  } as ProviderEntry;

  test('the download progress name is a label', () => {
    const view = render(ProviderPicker, { entries: [local], selectedId: 'local', progress: { local: { loaded: 0.5 } }, labels: { downloadProgress: 'Fortschritt' }, onSelectProvider: () => {}, onSelectModel: () => {} });
    expect(view.getByLabelText('Fortschritt')).toBeTruthy();
    cleanup();
    const plain = render(ProviderPicker, { entries: [local], selectedId: 'local', progress: { local: { loaded: 0.5 } }, onSelectProvider: () => {}, onSelectModel: () => {} });
    expect(plain.getByLabelText('Download progress')).toBeTruthy();
  });

  test('accountControls=false drops Connect, Connected and Disconnect', () => {
    const signedOut = { ...local, availability: { ok: false, state: 'needs_sign_in', reason: 'Sign in.' } } as ProviderEntry;
    const connected = { ...local, availability: { ok: true, state: 'ready' }, models: [{ value: 'm', name: 'M' }], account: { connected: true } } as ProviderEntry;
    const props = { selectedId: 'local', onSelectProvider: () => {}, onSelectModel: () => {}, onConnect: () => {}, onDisconnect: () => {}, onAllowPaid: () => {} };
    const on = render(ProviderPicker, { ...props, entries: [signedOut] });
    expect(on.getByRole('button', { name: 'Connect account' })).toBeTruthy();
    cleanup();
    const off = render(ProviderPicker, { ...props, entries: [signedOut], accountControls: false });
    expect(off.queryByRole('button', { name: 'Connect account' })).toBeNull();
    cleanup();
    const connectedOn = render(ProviderPicker, { ...props, entries: [connected] });
    expect(connectedOn.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    cleanup();
    const connectedOff = render(ProviderPicker, { ...props, entries: [connected], accountControls: false });
    expect(connectedOff.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(connectedOff.queryByText('Connected')).toBeNull();
    expect(connectedOff.getByLabelText('Allow models billed to my account')).toBeTruthy();
  });
});

describe('AccountConnection labels', () => {
  const base = { busy: false, onStart: () => {}, onCancel: () => {}, onKeySubmit: () => {} };
  const device = { id: 'gpt', label: 'ChatGPT', kind: 'chatgpt' };
  const german = {
    ariaLabel: (a: string) => `${a}-Verbindung`, connected: 'Verbunden', disconnect: 'Trennen', checking: (a: string) => `Prüfe ${a}…`, cancel: 'Abbrechen',
    enterCode: (a: string) => `Code bei ${a} eingeben:`, copyAndContinue: 'Code kopieren und weiter', continueTo: (a: string) => `Weiter zu ${a}`,
    copyFailed: 'Kopieren fehlgeschlagen.', starting: 'Starte…', signInHint: (a: string) => `Mit ${a} anmelden.`, signIn: (a: string) => `Bei ${a} anmelden`,
    keyLabel: (a: string) => `${a}-Schlüssel`, connectKey: (a: string) => `${a} verbinden`, notConnected: 'Nicht verbunden',
  };

  test('defaults read as before', () => {
    const view = render(AccountConnection, { ...base, account: device, state: 'unauthenticated' });
    expect(view.getByText('Sign in to ChatGPT')).toBeTruthy();
    expect(view.getByText('Sign in with your ChatGPT account.')).toBeTruthy();
    expect(view.getByLabelText('ChatGPT connection')).toBeTruthy();
  });

  test('signed-out, key, checking and busy states use the labels', () => {
    const out = render(AccountConnection, { ...base, account: device, state: 'unauthenticated', labels: german });
    expect(out.getByText('Bei ChatGPT anmelden')).toBeTruthy();
    expect(out.getByText('Mit ChatGPT anmelden.')).toBeTruthy();
    expect(out.getByLabelText('ChatGPT-Verbindung')).toBeTruthy();
    cleanup();
    const busy = render(AccountConnection, { ...base, account: device, state: 'unauthenticated', labels: german, busy: true });
    expect(busy.getByText('Starte…')).toBeTruthy();
    expect(busy.getByText('Abbrechen')).toBeTruthy();
    cleanup();
    const key = render(AccountConnection, { ...base, account: { id: 'k', label: 'Go', kind: 'opencode_go' }, state: 'unauthenticated', labels: german });
    expect(key.getByText('Go-Schlüssel')).toBeTruthy();
    expect(key.getByText('Go verbinden')).toBeTruthy();
    cleanup();
    const checking = render(AccountConnection, { ...base, account: device, state: 'unknown', labels: german });
    expect(checking.getByText('Prüfe ChatGPT…')).toBeTruthy();
    cleanup();
    const other = render(AccountConnection, { ...base, account: { id: 'x', label: 'Other', kind: 'other' }, state: 'unauthenticated', labels: german });
    expect(other.getByText('Nicht verbunden')).toBeTruthy();
  });

  test('connected and device-code states use the labels', async () => {
    const connected = render(AccountConnection, { ...base, account: device, state: { authenticated: { account: 'me@example.com' } }, labels: german });
    expect(connected.container.textContent).toMatch(/Verbunden\s*·\s*me@example\.com/);
    expect(connected.getByText('Trennen')).toBeTruthy();
    cleanup();
    const challenge = { user_code: 'ABCD-1234', verification_url: 'https://example.com/device' };
    const code = render(AccountConnection, { ...base, account: device, state: 'unauthenticated', challenge, labels: german });
    expect(code.getByText('Code bei ChatGPT eingeben:')).toBeTruthy();
    expect(code.getByText('Weiter zu ChatGPT')).toBeTruthy();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    await fireEvent.click(code.getByText('Code kopieren und weiter'));
    await vi.waitFor(() => expect(code.getByText('Kopieren fehlgeschlagen.')).toBeTruthy());
  });
});

describe('StepConfig labels', () => {
  const step = (over: Partial<StepData> = {}): StepData => ({
    id: 'creator', label: 'Creator', backendValue: '', backendOptions: [], backendPlaceholder: 'Default', accountConnected: true, accountBusy: false,
    modelValue: '', modelOptions: [], refreshable: true, extraOptions: [], extraValues: {}, ...over,
  });
  const base = { onSelectBackend: () => {}, onSelectModel: () => {}, onSelectOption: () => {}, onRefresh: () => {} };

  test('defaults', () => {
    const view = render(StepConfig, { ...base, steps: [step()] });
    expect(view.getByLabelText('Creator assistant')).toBeTruthy();
    expect(view.getByLabelText('Creator model')).toBeTruthy();
    expect(view.getByText('No model')).toBeTruthy();
    expect(view.getByText('Refresh models')).toBeTruthy();
  });

  test('replacements', () => {
    const labels = { assistant: (s: string) => `${s}: Assistent`, model: (s: string) => `${s}: Modell`, noModel: 'Kein Modell', loadingControls: 'Lade…', refreshModels: 'Modelle laden' };
    const view = render(StepConfig, { ...base, steps: [step()], labels });
    expect(view.getByLabelText('Creator: Assistent')).toBeTruthy();
    expect(view.getByLabelText('Creator: Modell')).toBeTruthy();
    expect(view.getByText('Kein Modell')).toBeTruthy();
    expect(view.getByText('Modelle laden')).toBeTruthy();
    cleanup();
    const busy = render(StepConfig, { ...base, steps: [step()], labels, refreshing: true });
    expect(busy.getByText('Lade…')).toBeTruthy();
  });
});
