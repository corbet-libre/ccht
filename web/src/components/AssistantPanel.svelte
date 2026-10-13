<!-- Drop-in assistant chat surface composed from the shared pieces: `Dock`
  (edge rail / mobile sheet), `ChatDock` (conversation view), `ProviderPicker`
  (compact settings), a "via <provider> · <model>" line per answer, a one-line
  privacy notice, the "Ask your own assistant" row (assistant door openers plus
  copy prompt) and an optional MCP connector disclosure.

  The application supplies providers, tools, instructions, context getter, copy
  and the door prompt; nothing product-specific lives here. The panel runs the
  browser agent in the page, keeps the conversation only in memory (use `onEvent`
  to persist) and stores nothing unless the app passes `storage`.

  Under 640px it is a full-screen sheet: safe-area insets, Tab trap, Escape to
  close, scroll lock and 16px inputs (no iOS zoom). Motion follows the user's
  reduced-motion setting through `Dock`. -->
<script module lang="ts">
  import type { ProviderPickerLabels } from './ProviderPicker.svelte';
  import type { BrowserAgentOptions } from '../agent/index.ts';

  export interface AssistantCopy {
    kicker: string;
    title: string;
    /** Edge tab text while closed. */
    tabLabel: string;
    tabSummary: string;
    closeLabel: string;
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
    copied: string;
    mcpSummary: string;
    mcpCopy: string;
    checking: string;
    unavailable: string;
    connectFailed: string;
    prepareFailed: string;
  }

  export const defaultAssistantCopy: AssistantCopy = {
    kicker: 'Assistant',
    title: 'Assistant',
    tabLabel: 'Assistant',
    tabSummary: '',
    closeLabel: 'Close assistant',
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
  };

  /** Extra pieces a `createAgent` factory or the default one may use. */
  export type AgentSettings = Omit<BrowserAgentOptions, 'provider' | 'tools' | 'system'>;
</script>

<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { TurnState, WireEvent } from '../../index.js';
  import { createBrowserAgent, historyFromTurns, type BrowserAgent } from '../agent/index.ts';
  import type { ModelProvider, ToolSource } from '../agent/types.ts';
  import type { AccountsStore } from '../accounts.ts';
  import { applyWireEvent, failTurn, messagesFromTurns, newTurn, type AssistantMessage } from '../assistant.ts';
  import { assistantLinks, mcpConnector, type AssistantId } from '../handoff.ts';
  import { inspectProviders, type ProviderEntry } from '../providers/inspect.ts';
  import ChatDock from './ChatDock.svelte';
  import Dock from './Dock.svelte';
  import ProviderPicker from './ProviderPicker.svelte';
  import { sheetQuery, trapTab, watchMedia } from './sheet.ts';

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
    privacyNotice,
    doorPrompt,
    assistants,
    mcpUrl,
    mcpName,
    accounts,
    storage,
    storageKey = 'ccht.assistant.v1',
    conversationId = 'assistant',
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
    copy?: Partial<AssistantCopy>;
    pickerLabels?: Partial<ProviderPickerLabels>;
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
    conversationId?: string;
    /** Every wire event of every turn, for persistence or a full conversation model. */
    onEvent?: (event: WireEvent) => void;
    /** Replace the default message text (for example to render Markdown). */
    messageBody?: Snippet<[AssistantMessage]>;
    activityExtra?: Snippet<[TurnState]>;
    /** Buttons in the heading (for example Export). */
    headerExtra?: Snippet;
    /** Extra content under the notice and doors. */
    footer?: Snippet;
  } = $props();

  const text: AssistantCopy = $derived({ ...defaultAssistantCopy, ...copy });
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
  let root: HTMLDivElement | undefined = $state(undefined);
  let aborter: AbortController | undefined;
  let generation = 0;
  let disposed = false;

  const messages = $derived(messagesFromTurns(turns));
  const selected = $derived(entries.find((entry) => entry.id === selectedId));
  const ready = $derived(!!selected && selected.availability.ok && model !== '');
  const showSettings = $derived(settingsOpen || (!loading && !ready));
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

  async function send(prompt: string): Promise<void> {
    const target = provider(selectedId);
    if (!target || !ready || busy) throw new Error('The assistant is not ready.');
    const requestId = crypto.randomUUID();
    const history = historyFromTurns(turns);
    let turn = newTurn(requestId, prompt);
    const index = turns.length;
    turns = [...turns, turn];
    const controller = new AbortController();
    aborter = controller;
    busy = true;
    const store = (next: TurnState): void => { turn = next; turns = turns.map((item, position) => (position === index ? next : item)); };
    try {
      const line = await contextLine?.();
      const agent = createAgent
        ? createAgent(target)
        : createBrowserAgent({ ...agentOptions, provider: target, ...(tools ? { tools } : {}), ...(instructions ? { system: instructions } : {}) });
      for await (const wire of agent.turn({ conversationId, requestId, text: prompt, history, model, ...(line ? { context: line } : {}), signal: controller.signal })) {
        store(applyWireEvent(turn, wire));
        try { onEvent?.(wire); } catch { /* The observer must not break the turn. */ }
      }
      store(failTurn(turn, 'incomplete_stream', 'The answer ended unexpectedly.'));
    } catch {
      store(failTurn(turn, 'provider_error', 'The assistant could not answer.'));
    } finally {
      if (aborter === controller) aborter = undefined;
      busy = false;
    }
  }
  function stop(): void { aborter?.abort(); }
  function reset(): void {
    stop();
    turns = [];
    draft = '';
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
    const unsubscribe = accounts?.subscribe(() => {});
    void refresh();
    return () => { disposed = true; unwatch(); unsubscribe?.(); aborter?.abort(); };
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

<div class="ccht-assistant" class:ccht-assistant-sheet={sheet} data-sheet={sheet} bind:this={root}>
  <Dock
    {side}
    title={text.title}
    {open}
    onOpen={() => setOpen(true)}
    onClose={() => setOpen(false)}
    tabLabel={text.tabLabel}
    tabSummary={text.tabSummary}
    closeLabel={text.closeLabel}
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
      composerDisabled={loading || !ready}
      onSend={send}
      onStop={stop}
      onSelectHistory={() => reset()}
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
        {#if headerExtraSnippet}{@render headerExtraSnippet()}{/if}
      {/snippet}
      {#snippet statusNote()}
        {#if loading}
          <p class="ccht-assistant-line" role="status">{text.checking}</p>
        {:else if !ready}
          <p class="ccht-assistant-line" role="status">{selected?.availability.reason ?? text.unavailable}</p>
        {/if}
        {#if notes}<p class="ccht-assistant-line ccht-assistant-error" role="alert">{notes}</p>{/if}
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
    <div class="ccht-assistant-footer">
      {#if notice}<p class="ccht-assistant-line ccht-assistant-privacy">{notice}</p>{/if}
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
    </div>
  </Dock>
</div>

<style>
  .ccht-assistant :global(.ccht-dock-body) {
    display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; overflow: auto;
  }
  .ccht-assistant :global(.ccht-chat-messages) { flex: 1 1 8rem; min-height: 6rem; }
  .ccht-assistant :global(textarea),
  .ccht-assistant :global(select),
  .ccht-assistant :global(input:not([type='checkbox']):not([type='radio'])) { font-size: 16px; }
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
  .ccht-assistant-picker { flex: 0 0 auto; max-height: 40dvh; overflow: auto; margin-top: 0.6rem; }
  .ccht-assistant-picker[inert] { opacity: 0.6; }
  .ccht-assistant-text { white-space: pre-wrap; }
  .ccht-assistant-served { display: block; margin-top: 0.4rem; color: var(--ccht-muted, #8fa0b7); font-size: 0.7rem; overflow-wrap: anywhere; }
  .ccht-assistant-footer { flex: 0 0 auto; max-height: 32dvh; overflow: auto; min-width: 0; }
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
