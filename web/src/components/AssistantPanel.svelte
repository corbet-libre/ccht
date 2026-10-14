<!-- Drop-in assistant chat surface composed from the shared pieces: `Dock`
  (edge rail / mobile sheet), `ChatDock` (conversation view), `ProviderPicker`
  (compact settings), a "via <provider> · <model>" line per answer, a one-line
  privacy notice, the "Ask your own assistant" row (assistant door openers plus
  copy prompt) and an optional MCP connector disclosure.

  The application supplies providers, tools, instructions, context getter, copy
  and the door prompt; nothing product-specific lives here. The panel runs the
  browser agent in the page. The conversation lives in memory unless the app
  passes `history` (a storage adapter such as `localStorageHistory`): then the
  replayable event stream is saved after every turn, the latest conversation is
  restored on mount and earlier ones can be picked. Without `storage` the
  provider choice is not remembered either.

  Settings open as an overlay so the transcript keeps its height; on short
  viewports the secondary footer collapses. Under 640px it is a full-screen
  sheet: safe-area insets, Tab trap, Escape to close and scroll lock; inputs are
  16px on touch devices (no iOS zoom). Motion follows the user's reduced-motion
  setting through `Dock`. -->
<script module lang="ts">
  import type { ProviderPickerLabels } from './ProviderPicker.svelte';
  import { defaultChatDockLabels, type ChatDockLabels } from './ChatDock.svelte';
  import type { BrowserAgentOptions } from '../agent/index.ts';

  /** Every user-facing string of the panel, including the ones of the chat view (`you`, `stop`, `copyMessage`, `showActivity`, …). */
  export interface AssistantCopy extends ChatDockLabels {
    kicker: string;
    title: string;
    /** Edge tab text while closed. */
    tabLabel: string;
    tabSummary: string;
    closeLabel: string;
    /** Visible text of the close button. */
    closeText: string;
    /** Accessible name of the edge tab, from the title and summary. */
    openLabel: (title: string, summary: string) => string;
    composerLabel: string;
    composerPlaceholder: string;
    sendLabel: string;
    welcomeTitle: string;
    welcomeBody: string;
    welcomeExample: string;
    newConversationLabel: string;
    settingsLabel: string;
    /** One line about where questions and data go. Empty hides it. */
    privacyNotice: string;
    /** Attribution under each answer, from "<provider> · <model>" labels. */
    servedBy: (served: string) => string;
    tokensLabel: (tokens: number) => string;
    doorsLabel: string;
    copyPrompt: string;
    mcpSummary: string;
    mcpCopy: string;
    checking: string;
    unavailable: string;
    connectFailed: string;
    prepareFailed: string;
    /** Header button that downloads the conversation. */
    exportLabel: string;
    exportFailed: string;
    /** One line shown when saving or restoring history failed; the conversation stays in memory. */
    historyUnavailable: string;
    /** Summary of the footer block that collapses on short viewports. */
    moreLabel: string;
    /** Error message of an answer that was still running when the page was left. */
    interrupted: string;
    /** Error message when the answer stream ended without a result. */
    incompleteAnswer: string;
    /** Error message when the assistant failed unexpectedly. */
    answerFailed: string;
  }

  /** `AssistantCopy` with every entry optional, including single statuses. */
  export type AssistantCopyOverrides = Partial<Omit<AssistantCopy, 'status'>> & { status?: Partial<AssistantCopy['status']> };

  export const defaultAssistantCopy: AssistantCopy = {
    ...defaultChatDockLabels,
    kicker: 'Assistant',
    title: 'Assistant',
    tabLabel: 'Assistant',
    tabSummary: '',
    closeLabel: 'Close assistant',
    closeText: 'Close',
    openLabel: (title, summary) => (summary ? `Open ${title}: ${summary}` : `Open ${title}`),
    composerLabel: 'Your question',
    composerPlaceholder: 'Ask a question…',
    sendLabel: 'Send',
    welcomeTitle: 'Assistant',
    welcomeBody: 'Ask a question to get started.',
    welcomeExample: '',
    newConversationLabel: 'New conversation',
    settingsLabel: 'Settings',
    privacyNotice: 'Your messages and any data the assistant reads are sent to the selected provider.',
    servedBy: (served) => `via ${served}`,
    tokensLabel: (tokens) => `${tokens.toLocaleString()} tokens`,
    doorsLabel: 'Ask your own assistant:',
    copyPrompt: 'Copy prompt',
    copied: 'Copied',
    mcpSummary: 'Use this in your own assistant (MCP)',
    mcpCopy: 'Copy address',
    checking: 'Checking providers…',
    unavailable: 'No assistant provider is available. Open settings to choose one.',
    connectFailed: 'Could not start the connection.',
    prepareFailed: 'The download could not be completed.',
    exportLabel: 'Export',
    exportFailed: 'The conversation could not be exported.',
    historyUnavailable: 'History could not be saved here. This conversation stays in this tab only.',
    moreLabel: 'More',
    interrupted: 'This answer was interrupted.',
    incompleteAnswer: 'The answer ended unexpectedly.',
    answerFailed: 'The assistant could not answer.',
  };

  /** Extra pieces a `createAgent` factory or the default one may use. */
  export type AgentSettings = Omit<BrowserAgentOptions, 'provider' | 'tools' | 'system'>;
</script>

<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { Conversation, ConversationSnapshot, TurnState, WireEvent } from '../../index.js';
  import { createBrowserAgent, historyFromTurns, type BrowserAgent } from '../agent/index.ts';
  import type { ModelProvider, ToolSource } from '../agent/types.ts';
  import type { AccountsStore } from '../accounts.ts';
  import { applyWireEvent, messagesFromTurns, newTurn, type AssistantMessage } from '../assistant.ts';
  import {
    buildExport, downloadJson, exportFileName, renumberEvents, replayTurns, snapshotFromEvents, titleFromTurns,
    type ConversationExport, type ConversationHistory, type HistorySummary, type StoredConversation,
  } from '../history.ts';
  import { assistantLinks, mcpConnector, type AssistantId } from '../handoff.ts';
  import { inspectProviders, type ProviderEntry } from '../providers/inspect.ts';
  import ChatDock from './ChatDock.svelte';
  import Dock from './Dock.svelte';
  import ProviderPicker from './ProviderPicker.svelte';
  import { shortQuery, sheetQuery, trapTab, watchMedia } from './sheet.ts';

  type Store = Pick<Storage, 'getItem' | 'setItem'>;

  let {
    providers,
    tools,
    instructions,
    contextLine,
    agentOptions = {},
    createAgent,
    open = $bindable(false),
    onOpenChange,
    side = 'right',
    showTab = true,
    panelId = 'ccht-assistant-panel',
    copy = {},
    pickerLabels = {},
    accountControls = true,
    privacyNotice,
    doorPrompt,
    assistants,
    mcpUrl,
    mcpName,
    accounts,
    storage,
    storageKey = 'ccht.assistant.v1',
    conversationId = 'assistant',
    history,
    persistFilter,
    conversationModel,
    onExport,
    onEvent,
    messageBody: messageBodySnippet,
    activityExtra,
    headerExtra: headerExtraSnippet,
    footer: footerSnippet
  }: {
    /** Providers offered in the picker, in order; the first usable one is the default. */
    providers: ModelProvider[];
    /** MCP tools given to the agent. */
    tools?: ToolSource | ToolSource[];
    /** Application instructions for the system prompt (the data-not-instructions notice is added). */
    instructions?: string;
    /** Live context line (for example the current view), read at send time and given to the agent as data. */
    contextLine?: () => string | undefined | Promise<string | undefined>;
    /** Further `createBrowserAgent` options (`maxSteps`, `fallback`, `rateLimitRetries` …). */
    agentOptions?: AgentSettings;
    /** Full control: return a ready `BrowserAgent` for the selected provider. Overrides `tools`, `instructions`, `agentOptions`. */
    createAgent?: (provider: ModelProvider) => BrowserAgent;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    side?: 'left' | 'right';
    /** Render the edge tab while closed. Turn off to open from your own button via `open`. */
    showTab?: boolean;
    panelId?: string;
    copy?: AssistantCopyOverrides;
    pickerLabels?: Partial<ProviderPickerLabels>;
    /** Show Connect, Connected and Disconnect in the settings (default). Turn off when the app has its own accounts UI. The "billed to my account" opt-in stays visible while an account is connected. */
    accountControls?: boolean;
    /** Overrides `copy.privacyNotice`. Empty string hides the line. */
    privacyNotice?: string;
    /** Builds the prompt for the "Ask your own assistant" row from the current draft. Omit to hide the row. */
    doorPrompt?: (input: { draft: string }) => string;
    /** Which assistants get a door (default: all). */
    assistants?: AssistantId[];
    /** HTTPS address of your remote MCP server. Omit to hide the disclosure. */
    mcpUrl?: string;
    /** Connector name in the snippets (letters, digits, `-`, `_`). */
    mcpName?: string;
    /** When given, the provider list is refreshed whenever an account connects or disconnects. */
    accounts?: AccountsStore;
    /** Remembers the chosen provider, model and billed-model opt-in. Omit to remember nothing. */
    storage?: Store;
    storageKey?: string;
    /** Conversation id on the wire. With `history`, each conversation gets `<conversationId>:<uuid>`. */
    conversationId?: string;
    /** Saves conversations (as the replayable event stream), restores the latest on mount and lists earlier ones. `localStorageHistory(key)` is ready-made. Storage failures degrade to memory with a one-line notice. */
    history?: ConversationHistory;
    /** Decides what is persisted and exported: return `false` to drop an event, `true` to keep it, or a replacement event to redact it. Must not mutate its argument. A throw drops the event. */
    persistFilter?: (event: WireEvent) => boolean | WireEvent;
    /** Builds the shared Rust/Wasm model, for example `(id) => createConversation(id, { wasm })`. When given, export and restore take their snapshot from it; otherwise an equivalent JavaScript fold is used. */
    conversationModel?: (conversationId: string) => Promise<Conversation>;
    /** Receives the export instead of the JSON file download. */
    onExport?: (data: ConversationExport, fileName: string) => void;
    /** Every wire event of every turn (unfiltered), for a full conversation model of your own. */
    onEvent?: (event: WireEvent) => void;
    /** Replace the default message text (for example to render Markdown). */
    messageBody?: Snippet<[AssistantMessage]>;
    activityExtra?: Snippet<[TurnState]>;
    /** Buttons in the heading (for example Export). */
    headerExtra?: Snippet;
    /** Extra content under the notice and doors. */
    footer?: Snippet;
  } = $props();

  const text: AssistantCopy = $derived({ ...defaultAssistantCopy, ...copy, status: { ...defaultAssistantCopy.status, ...copy.status } });
  const notice = $derived(privacyNotice ?? text.privacyNotice);

  let entries: ProviderEntry[] = $state([]);
  let selectedId = $state('');
  let model = $state('');
  let allowPaid = $state(false);
  let loading = $state(true);
  let settingsOpen = $state(false);
  let notes = $state('');
  let progress: Record<string, { loaded: number; text?: string }> = $state({});
  let busyId: string | null = $state(null);
  let turns: TurnState[] = $state([]);
  let draft = $state('');
  let busy = $state(false);
  let copied = $state('');
  let sheet = $state(false);
  let short = $state(false);
  let historyNotice = $state('');
  let exportNotice = $state('');
  let saved: HistorySummary[] = $state([]);
  let restoring = $state(false);
  let root: HTMLDivElement | undefined = $state(undefined);
  let aborter: AbortController | undefined;
  let generation = 0;
  let disposed = false;

  /** The conversation being shown: its id and the (filtered) events recorded for saving and export. */
  interface Session { id: string; createdAt: number; events: WireEvent[] }
  const freshId = (): string => (history ? `${conversationId}:${crypto.randomUUID()}` : conversationId);
  const fresh = (id = freshId()): Session => ({ id, createdAt: Date.now(), events: [] });
  let session: Session = fresh();
  let activeId = $state(untrack(() => session.id));

  const messages = $derived(messagesFromTurns(turns));
  const selected = $derived(entries.find((entry) => entry.id === selectedId));
  const ready = $derived(!!selected && selected.availability.ok && model !== '');
  const showSettings = $derived(settingsOpen || (!loading && !ready));
  const savedItems = $derived(saved.map((item) => ({ id: item.id, title: item.title, message_count: item.turns * 2 })));
  const prompt = $derived(doorPrompt ? doorPrompt({ draft }) : '');
  const doors = $derived(prompt ? assistantLinks(prompt, assistants) : []);
  const connector = $derived.by(() => {
    if (!mcpUrl) return undefined;
    try { return mcpConnector(mcpUrl, mcpName); } catch { return undefined; }
  });

  function remember(): void {
    try { storage?.setItem(storageKey, JSON.stringify({ provider: selectedId, model, allowPaid })); } catch { /* Selection stays in this tab. */ }
  }
  function recall(): { provider?: string; model?: string; allowPaid?: boolean } {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null') as { provider?: unknown; model?: unknown; allowPaid?: unknown } | null;
      return {
        ...(typeof saved?.provider === 'string' ? { provider: saved.provider } : {}),
        ...(typeof saved?.model === 'string' ? { model: saved.model } : {}),
        ...(typeof saved?.allowPaid === 'boolean' ? { allowPaid: saved.allowPaid } : {}),
      };
    } catch {
      return {};
    }
  }
  let restored = false;

  /** Re-read availability and models of every provider; never prepares or downloads anything. */
  export async function refresh(): Promise<void> {
    const mine = ++generation;
    const next = await inspectProviders(providers);
    if (disposed || mine !== generation) return;
    entries = next;
    const saved = restored ? {} : recall();
    restored = true;
    if (saved.allowPaid !== undefined) { allowPaid = saved.allowPaid; applyPaid(); }
    const wanted = saved.provider ?? selectedId;
    const usable = (entry: ProviderEntry): boolean => entry.availability.ok;
    const pick = next.find((entry) => entry.id === wanted && (usable(entry) || entry.availability.state === 'needs_sign_in' || entry.availability.state === 'needs_consent'))
      ?? next.find(usable) ?? next[0];
    selectedId = pick?.id ?? '';
    const models = pick?.models ?? [];
    const keep = saved.model ?? model;
    model = models.some((item) => item.value === keep) ? keep : (models[0]?.value ?? '');
    loading = false;
    remember();
  }
  function applyPaid(): void {
    for (const provider of providers) if ('allowPaid' in provider) (provider as ModelProvider & { allowPaid: boolean }).allowPaid = allowPaid;
  }
  const provider = (id: string): ModelProvider | undefined => providers.find((item) => item.id === id);

  function selectProvider(id: string): void {
    selectedId = id;
    model = entries.find((entry) => entry.id === id)?.models[0]?.value ?? '';
    remember();
  }
  async function prepare(id: string): Promise<void> {
    const target = provider(id);
    if (!target?.prepare) return;
    busyId = id;
    notes = '';
    try {
      await target.prepare({ ...(model ? { model } : {}), onProgress: ({ loaded, text: label }) => { progress = { ...progress, [id]: { loaded, ...(label ? { text: label } : {}) } }; } });
    } catch {
      notes = text.prepareFailed;
    } finally {
      busyId = null;
      progress = {};
    }
    await refresh();
  }
  async function connect(id: string): Promise<void> {
    notes = '';
    try { await provider(id)?.account?.connect(); } catch { notes = text.connectFailed; }
    accounts?.refresh();
    await refresh();
  }
  async function disconnect(id: string): Promise<void> {
    try { provider(id)?.account?.disconnect(); } catch { /* Shown by the refreshed status. */ }
    accounts?.refresh();
    await refresh();
  }
  async function setAllowPaid(value: boolean): Promise<void> {
    allowPaid = value;
    applyPaid();
    await refresh();
  }

  const wireOf = (target: Session, requestId: string, sequence: number, code: string, message: string): WireEvent =>
    ({ version: 1, conversation_id: target.id, request_id: requestId, sequence, event: { kind: 'error', code, message } });

  /** Keep an event for saving and export, after the app's filter. */
  function record(target: Session, wire: WireEvent): void {
    let kept: boolean | WireEvent = true;
    if (persistFilter) {
      try { kept = persistFilter(wire); } catch { kept = false; }
    }
    if (kept === true) target.events.push(wire);
    else if (kept && typeof kept === 'object') target.events.push(kept);
  }

  async function persist(target: Session): Promise<void> {
    if (!history || target.events.length === 0) return;
    const events = renumberEvents(target.events, target.id);
    const stored: StoredConversation = { version: 1, id: target.id, title: titleFromTurns(replayTurns(events)), createdAt: target.createdAt, updatedAt: Date.now(), events };
    try {
      await history.save(stored);
      const list = await history.list();
      if (!disposed) { saved = list; historyNotice = ''; }
    } catch {
      if (!disposed) historyNotice = text.historyUnavailable;
    }
  }

  async function send(prompt: string): Promise<void> {
    const target = provider(selectedId);
    if (!target || !ready || busy || restoring) throw new Error('The assistant is not ready.');
    const mine = session;
    const requestId = crypto.randomUUID();
    const turnHistory = historyFromTurns(turns);
    let turn = newTurn(requestId, prompt);
    const index = turns.length;
    turns = [...turns, turn];
    const controller = new AbortController();
    aborter = controller;
    busy = true;
    // A turn that outlives its conversation (the user started or picked another one) no longer touches the view.
    const store = (next: TurnState): void => {
      turn = next;
      if (session === mine) turns = turns.map((item, position) => (position === index ? next : item));
    };
    const fail = (code: string, message: string): void => {
      // Only a turn that is still running can fail; a completed one stays as it is.
      if (turn.status !== 'streaming' && turn.status !== 'awaiting_permission') return;
      const wire = wireOf(mine, requestId, turn.last_sequence + 1, code, message);
      store(applyWireEvent(turn, wire));
      record(mine, wire);
    };
    try {
      const line = await contextLine?.();
      const agent = createAgent
        ? createAgent(target)
        : createBrowserAgent({ ...agentOptions, provider: target, ...(tools ? { tools } : {}), ...(instructions ? { system: instructions } : {}) });
      for await (const wire of agent.turn({ conversationId: mine.id, requestId, text: prompt, history: turnHistory, model, ...(line ? { context: line } : {}), signal: controller.signal })) {
        store(applyWireEvent(turn, wire));
        try { onEvent?.(wire); } catch { /* The observer must not break the turn. */ }
        record(mine, wire);
      }
      fail('incomplete_stream', text.incompleteAnswer);
    } catch {
      fail('provider_error', text.answerFailed);
    } finally {
      if (aborter === controller) { aborter = undefined; busy = false; }
      await persist(mine);
    }
  }
  function stop(): void { aborter?.abort(); }

  function begin(next: Session, shown: TurnState[]): void {
    stop();
    session = next;
    activeId = next.id;
    turns = shown;
    draft = '';
    exportNotice = '';
  }
  /** Start an empty conversation. The one on screen stays saved. */
  function reset(): void { begin(fresh(), []); }

  async function snapshotOf(events: WireEvent[], id: string): Promise<ConversationSnapshot> {
    if (conversationModel) {
      let model: Conversation | undefined;
      try {
        model = await conversationModel(id);
        for (const wire of events) model.applyEvent(wire);
        return model.snapshot();
      } catch {
        /* Fall back to the equivalent JavaScript fold below. */
      } finally {
        model?.free();
      }
    }
    return snapshotFromEvents(events, id);
  }

  /** Show a saved conversation. Turns that never ended (the page was left mid-answer) are closed with an error. */
  async function openSaved(id: string): Promise<void> {
    if (!history) return;
    const target = fresh(id);
    try {
      const stored = await history.load(id);
      if (disposed) return;
      if (!stored) { saved = saved.filter((item) => item.id !== id); return; }
      const shown = replayTurns(stored.events);
      target.createdAt = stored.createdAt;
      target.events = [...stored.events];
      const last = new Map<string, number>();
      for (const wire of stored.events) last.set(wire.request_id, wire.sequence);
      const settled = shown.map((turn) => {
        if (turn.status !== 'streaming' && turn.status !== 'awaiting_permission') return turn;
        const wire = wireOf(target, turn.request_id, (last.get(turn.request_id) ?? 0) + 1, 'interrupted', text.interrupted);
        record(target, wire);
        return applyWireEvent(turn, wire);
      });
      begin(target, settled);
    } catch {
      historyNotice = text.historyUnavailable;
    }
  }
  function selectHistory(id: string): void {
    if (id === '') reset();
    else if (id !== session.id) void openSaved(id);
  }

  async function restore(): Promise<void> {
    if (!history) return;
    restoring = true;
    try {
      const list = await history.list();
      if (disposed) return;
      saved = list;
      if (list[0] && session.events.length === 0 && turns.length === 0) await openSaved(list[0].id);
    } catch {
      if (!disposed) historyNotice = text.historyUnavailable;
    } finally {
      restoring = false;
    }
  }

  async function exportConversation(): Promise<void> {
    exportNotice = '';
    const events = renumberEvents(session.events, session.id);
    const title = titleFromTurns(replayTurns(events));
    try {
      const stored: StoredConversation = { version: 1, id: session.id, title, createdAt: session.createdAt, updatedAt: Date.now(), events };
      const data = buildExport(stored, await snapshotOf(events, session.id));
      const fileName = exportFileName(title);
      if (onExport) onExport(data, fileName);
      else downloadJson(fileName, data);
    } catch {
      exportNotice = text.exportFailed;
    }
  }

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = label;
      setTimeout(() => { if (copied === label) copied = ''; }, 1500);
    } catch {
      copied = '';
    }
  }

  function setOpen(value: boolean): void {
    open = value;
    onOpenChange?.(value);
  }

  onMount(() => {
    const unwatch = watchMedia(sheetQuery, (matches) => { sheet = matches; });
    const unwatchHeight = watchMedia(shortQuery, (matches) => { short = matches; });
    const unsubscribe = accounts?.subscribe(() => {});
    void refresh();
    void restore();
    return () => { disposed = true; unwatch(); unwatchHeight(); unsubscribe?.(); aborter?.abort(); };
  });

  // Providers may have changed (an account connected, a download finished) since the panel was last shown.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) void refresh();
    wasOpen = open;
  });
  // Refresh when the accounts store reports a connection change.
  $effect(() => {
    if (!accounts) return;
    let last = accounts.get().rows.map((row) => `${row.id}:${row.connected}`).join();
    return accounts.subscribe((state) => {
      const now = state.rows.map((row) => `${row.id}:${row.connected}`).join();
      if (now !== last) { last = now; void refresh(); }
    });
  });
  // While a sheet is open it is modal: mark it, and keep the page behind it from scrolling.
  $effect(() => {
    const panel = root?.querySelector<HTMLElement>('.ccht-dock-panel');
    panel?.setAttribute('aria-modal', open && sheet ? 'true' : 'false');
    if (!(open && sheet)) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  });

  function onKeydown(event: KeyboardEvent): void {
    if (open && sheet) trapTab(event, root?.querySelector<HTMLElement>('.ccht-dock-panel'));
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="ccht-assistant"
  class:ccht-assistant-sheet={sheet}
  class:ccht-assistant-short={short}
  data-sheet={sheet}
  data-short={short}
  bind:this={root}
>
  <Dock
    {side}
    title={text.title}
    {open}
    onOpen={() => setOpen(true)}
    onClose={() => setOpen(false)}
    tabLabel={text.tabLabel}
    tabSummary={text.tabSummary}
    closeLabel={text.closeLabel}
    closeText={text.closeText}
    openLabel={text.openLabel}
    {panelId}
    {showTab}
  >
    <ChatDock
      kicker={text.kicker}
      title={text.title}
      composerId="{panelId}-input"
      composerLabel={text.composerLabel}
      composerPlaceholder={text.composerPlaceholder}
      sendLabel={text.sendLabel}
      welcomeTitle={text.welcomeTitle}
      welcomeBody={text.welcomeBody}
      welcomeExample={text.welcomeExample}
      newConversationLabel={text.newConversationLabel}
      {messages}
      bind:draft
      submitting={busy}
      canSend={ready}
      controlsLoading={loading}
      composerDisabled={loading || !ready || restoring}
      labels={text}
      history={savedItems}
      activeHistoryId={saved.some((item) => item.id === activeId) ? activeId : null}
      showHistoryPicker={!!history && saved.length > 0}
      onSend={send}
      onStop={stop}
      onSelectHistory={selectHistory}
      {activityExtra}
    >
      {#snippet headerExtra()}
        <button
          type="button"
          class="ccht-assistant-settings"
          aria-expanded={showSettings}
          aria-controls="{panelId}-settings"
          onclick={() => { settingsOpen = !settingsOpen; }}
        >{text.settingsLabel}</button>
        {#if turns.length > 0}
          <button type="button" class="ccht-assistant-settings ccht-assistant-export" onclick={() => void exportConversation()}>{text.exportLabel}</button>
        {/if}
        {#if headerExtraSnippet}{@render headerExtraSnippet()}{/if}
      {/snippet}
      {#snippet statusNote()}
        {#if loading}
          <p class="ccht-assistant-line" role="status">{text.checking}</p>
        {:else if !ready}
          <p class="ccht-assistant-line" role="status">{selected?.availability.reason ?? text.unavailable}</p>
        {/if}
        {#if notes}<p class="ccht-assistant-line ccht-assistant-error" role="alert">{notes}</p>{/if}
        {#if exportNotice}<p class="ccht-assistant-line ccht-assistant-error" role="alert">{exportNotice}</p>{/if}
        {#if historyNotice}<p class="ccht-assistant-line" role="status">{historyNotice}</p>{/if}
        {#if showSettings}
          <div id="{panelId}-settings" class="ccht-assistant-picker" inert={busy}>
            <ProviderPicker
              {entries}
              {selectedId}
              modelValue={model}
              {progress}
              {busyId}
              {allowPaid}
              labels={pickerLabels}
              {accountControls}
              onSelectProvider={selectProvider}
              onSelectModel={(_, value) => { model = value; remember(); }}
              onPrepare={(id) => void prepare(id)}
              onConnect={(id) => void connect(id)}
              onDisconnect={(id) => void disconnect(id)}
              onAllowPaid={(value) => void setAllowPaid(value)}
            />
          </div>
        {/if}
      {/snippet}
      {#snippet messageBody(message)}
        {#if messageBodySnippet}
          {@render messageBodySnippet(message as AssistantMessage)}
        {:else}
          <p class="ccht-assistant-text">{message.content}</p>
        {/if}
        {#if message.role === 'assistant'}
          {@const entry = messages.find((item) => item.id === message.id)}
          {#if entry?.served || entry?.tokens !== undefined}
            <small class="ccht-assistant-served">{[entry?.served && text.servedBy(entry.served.join(', ')), entry?.tokens !== undefined && text.tokensLabel(entry.tokens)].filter(Boolean).join(' · ')}</small>
          {/if}
        {/if}
      {/snippet}
    </ChatDock>
    {#snippet extras()}
      {#if doors.length}
        <p class="ccht-assistant-doors">
          <span>{text.doorsLabel}</span>
          {#each doors as door (door.id)}
            <a href={door.url} target="_blank" rel="noopener noreferrer" data-prefill={door.prefill}>{door.label}</a>
          {/each}
          <button type="button" class="ccht-assistant-small" onclick={() => void copyText(prompt, 'prompt')}>
            {copied === 'prompt' ? text.copied : text.copyPrompt}
          </button>
        </p>
      {/if}
      {#if connector}
        <details class="ccht-assistant-mcp">
          <summary>{text.mcpSummary}</summary>
          <p class="ccht-assistant-line">{connector.instructions}</p>
          <pre class="ccht-assistant-code">{connector.url}</pre>
          <button type="button" class="ccht-assistant-small" onclick={() => void copyText(connector.url, 'mcp')}>
            {copied === 'mcp' ? text.copied : text.mcpCopy}
          </button>
        </details>
      {/if}
      {#if footerSnippet}{@render footerSnippet()}{/if}
    {/snippet}
    {#if notice || doors.length || connector || footerSnippet}
      <div class="ccht-assistant-footer">
        {#if notice}<p class="ccht-assistant-line ccht-assistant-privacy">{notice}</p>{/if}
        {#if short && (doors.length || connector || footerSnippet)}
          <details class="ccht-assistant-mcp ccht-assistant-more">
            <summary>{text.moreLabel}</summary>
            {@render extras()}
          </details>
        {:else}
          {@render extras()}
        {/if}
      </div>
    {/if}
  </Dock>
</div>

<style>
  .ccht-assistant :global(.ccht-dock-body) {
    position: relative; display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; overflow: auto;
  }
  /* The transcript keeps at least half of the panel; settings float over it and the footer is capped. */
  .ccht-assistant :global(.ccht-chat-messages) { flex: 1 1 50%; min-height: 6rem; min-height: max(6rem, 50%); }
  .ccht-assistant :global(select) { font-size: var(--ccht-select-font-size, 0.85rem); }
  /* 16px stops iOS from zooming into a focused field; only touch devices need it. */
  @media (pointer: coarse) {
    .ccht-assistant :global(textarea),
    .ccht-assistant :global(select),
    .ccht-assistant :global(input:not([type='checkbox']):not([type='radio'])) { font-size: 16px; }
  }
  .ccht-assistant-short :global(.ccht-chat-composer textarea) { min-height: 3rem; }
  .ccht-assistant-short :global(.ccht-chat-heading) { padding-bottom: 0.5rem; }
  .ccht-assistant-sheet :global(.ccht-dock-panel[data-side]) {
    left: 0; right: 0; top: 0; bottom: 0; width: auto; height: 100dvh; max-height: 100dvh;
    border: 0; border-radius: 0;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .ccht-assistant-sheet :global(.ccht-chat-message-user) { margin-left: 0.75rem; }
  .ccht-assistant-sheet :global(.ccht-chat-actions button),
  .ccht-assistant-sheet :global(.ccht-chat-primary) { min-height: 2.75rem; }
  .ccht-assistant-line {
    margin: var(--ccht-assistant-gap, 0.4rem) 0; color: var(--ccht-muted, #8fa0b7); font-size: 0.75rem; line-height: 1.5;
  }
  .ccht-assistant-error { color: var(--ccht-error, #b91c1c); }
  .ccht-assistant-picker {
    position: absolute; left: 0.4rem; right: 0.4rem; z-index: 5; max-height: min(24rem, 50%); overflow: auto;
    margin-top: 0.4rem; padding: 0.6rem; box-sizing: border-box;
    border: 1px solid var(--ccht-border, #30405c); border-radius: 0.6rem;
    background: var(--ccht-panel-bg, #0d1625); box-shadow: 0 0.6rem 1.6rem #0008;
  }
  .ccht-assistant-picker[inert] { opacity: 0.6; }
  .ccht-assistant-text { white-space: pre-wrap; }
  .ccht-assistant-served { display: block; margin-top: 0.4rem; color: var(--ccht-muted, #8fa0b7); font-size: 0.7rem; overflow-wrap: anywhere; }
  .ccht-assistant-footer { flex: 0 1 auto; max-height: 20dvh; overflow: auto; min-width: 0; }
  .ccht-assistant-short .ccht-assistant-footer { max-height: 12dvh; }
  .ccht-assistant-footer .ccht-assistant-line { margin: 0 0 var(--ccht-assistant-gap, 0.4rem); }
  .ccht-assistant-doors {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--ccht-assistant-gap, 0.4rem) 0.6rem;
    margin: 0 0 var(--ccht-assistant-gap, 0.4rem); color: var(--ccht-muted, #8fa0b7); font-size: 0.75rem;
  }
  .ccht-assistant-doors a { color: var(--ccht-accent, #7bb8ff); padding: 0.45rem 0; }
  .ccht-assistant-mcp { color: var(--ccht-muted, #8fa0b7); font-size: 0.75rem; }
  .ccht-assistant-mcp summary { cursor: pointer; padding: 0.35rem 0; }
  .ccht-assistant-code {
    overflow: auto; margin: 0.3rem 0; padding: 0.45rem; border-radius: 0.4rem; font-size: 0.7rem;
    color: var(--ccht-fg, #d8e2f0); background: var(--ccht-input-bg, #111c2d);
  }
  .ccht-assistant-settings, .ccht-assistant-small {
    min-height: 2.4rem; padding: 0.35rem 0.6rem; border: 1px solid var(--ccht-border, #30405c); border-radius: 0.45rem;
    color: var(--ccht-fg, #c2cede); background: var(--ccht-tab-bg, #111c2d);
    font: inherit; font-size: 0.75rem; font-weight: 750; cursor: pointer;
  }
  .ccht-assistant-settings:hover, .ccht-assistant-small:hover, .ccht-assistant-settings[aria-expanded='true'] {
    border-color: var(--ccht-accent, #53708f); background: var(--ccht-tab-bg-hover, #17243a);
  }
</style>
