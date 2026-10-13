<!-- Panel listing every account-capable provider (anything exposing `account`,
  for example `openrouter()`) with its status, a Connect / Disconnect button and a
  one-line explanation of what connecting does. The list comes from the shared
  accounts store (`createAccounts`), so it is extensible: apps pass providers.
  Desktop: a popover under the header. Under 640px: a full-screen sheet with
  safe-area insets, focus trap and Escape to close. It never stores anything. -->
<script module lang="ts">
  export interface AccountsPanelCopy {
    title: string;
    close: string;
    connected: string;
    notConnected: string;
    connect: string;
    disconnect: string;
    working: string;
    empty: string;
    connectFailed: string;
    disconnectFailed: string;
    redirectFailed: string;
    /** Shown after a sign-in redirect finished. */
    redirectConnected: (label: string) => string;
    /** One line on what connecting does, per provider. */
    describe: (provider: { id: string; label: string; attribution?: string }) => string;
  }

  export const defaultAccountsCopy: AccountsPanelCopy = {
    title: 'Accounts',
    close: 'Close',
    connected: 'Connected',
    notConnected: 'Not connected',
    connect: 'Connect',
    disconnect: 'Disconnect',
    working: 'Working…',
    empty: 'No accounts can be connected here.',
    connectFailed: 'Could not start the connection.',
    disconnectFailed: 'Could not disconnect.',
    redirectFailed: 'The sign-in could not be completed. Connect again.',
    redirectConnected: (label) => `${label} is connected.`,
    describe: (provider) => `Uses your own ${provider.attribution ?? provider.label} account; the key stays in this browser.`,
  };
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AccountsState, AccountsStore } from '../accounts.ts';
  import { dialog, sheetQuery, watchMedia } from './sheet.ts';

  let {
    accounts,
    open = $bindable(false),
    panelId = 'ccht-accounts-panel',
    copy = {},
    descriptions = {},
    note = '',
    onClose
  }: {
    accounts: AccountsStore;
    open?: boolean;
    panelId?: string;
    copy?: Partial<AccountsPanelCopy>;
    /** Per-provider one-line explanation, by provider id; falls back to `copy.describe`. */
    descriptions?: Record<string, string>;
    /** Optional extra line under the list (for example a billing reminder). */
    note?: string;
    onClose?: () => void;
  } = $props();

  const text: AccountsPanelCopy = $derived({ ...defaultAccountsCopy, ...copy });
  let state: AccountsState = $state(untrack(() => accounts.get()));
  let sheet = $state(false);
  $effect(() => accounts.subscribe((next) => { state = next; }));
  onMount(() => {
    void accounts.completeRedirects();
    return watchMedia(sheetQuery, (matches) => { sheet = matches; });
  });

  function close(): void {
    open = false;
    accounts.dismissRedirect();
    onClose?.();
  }
  const errorText = (code: string): string =>
    code === 'connect_failed' ? text.connectFailed : code === 'disconnect_failed' ? text.disconnectFailed : text.redirectFailed;
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="ccht-accounts-backdrop" data-sheet={sheet} onclick={close}></div>
  <div
    id={panelId}
    class="ccht-accounts-panel"
    class:ccht-accounts-sheet={sheet}
    role="dialog"
    aria-modal={sheet ? 'true' : undefined}
    aria-labelledby="{panelId}-title"
    tabindex="-1"
    use:dialog={{ trap: sheet, onEscape: close }}
  >
    <div class="ccht-accounts-head">
      <h2 id="{panelId}-title">{text.title}</h2>
      <button type="button" class="ccht-accounts-close" onclick={close}>{text.close}</button>
    </div>
    <div class="ccht-accounts-body">
      {#if state.redirect}
        <p class="ccht-accounts-note" role="status">
          {state.redirect.result === 'connected' ? text.redirectConnected(state.redirect.label) : text.redirectFailed}
        </p>
      {/if}
      {#if state.rows.length === 0}
        <p class="ccht-accounts-note">{text.empty}</p>
      {:else}
        <ul class="ccht-accounts-list">
          {#each state.rows as row (row.id)}
            <li class="ccht-account-row" data-connected={row.connected} data-account={row.id}>
              <div class="ccht-account-main">
                <strong>{row.label}</strong>
                <span class="ccht-account-status">{row.connected ? text.connected : text.notConnected}</span>
              </div>
              <p class="ccht-account-about">{descriptions[row.id] ?? text.describe(row)}</p>
              {#if row.error && row.error !== 'redirect_failed'}
                <p class="ccht-account-error" role="alert">{errorText(row.error)}</p>
              {/if}
              <button
                type="button"
                class="ccht-account-action"
                disabled={row.busy}
                onclick={() => { if (row.connected) accounts.disconnect(row.id); else void accounts.connect(row.id); }}
              >
                {row.busy ? text.working : row.connected ? text.disconnect : text.connect}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if note}<p class="ccht-accounts-note">{note}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .ccht-accounts-backdrop { position: fixed; inset: 0; z-index: var(--ccht-accounts-z, 90); background: transparent; }
  .ccht-accounts-backdrop[data-sheet='true'] { background: var(--ccht-backdrop, #0009); }
  .ccht-accounts-panel {
    position: fixed; z-index: calc(var(--ccht-accounts-z, 90) + 1);
    top: var(--ccht-popover-top, 3.5rem); right: var(--ccht-popover-right, 1rem);
    width: min(24rem, calc(100vw - 2rem)); max-height: calc(100dvh - var(--ccht-popover-top, 3.5rem) - 1rem);
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid var(--ccht-border, #30405c); border-radius: 0.65rem;
    color: var(--ccht-fg, #d8e2f0); background: var(--ccht-panel-bg, #0d1625);
    box-shadow: 0 0.75rem 2rem var(--ccht-shadow, #0006);
  }
  .ccht-accounts-panel:focus { outline: none; }
  .ccht-accounts-sheet {
    inset: 0; width: auto; max-height: none; height: 100dvh; border: 0; border-radius: 0; box-shadow: none;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .ccht-accounts-head {
    display: flex; align-items: center; justify-content: space-between; gap: 0.8rem;
    padding: 0.9rem 1rem; border-bottom: 1px solid var(--ccht-border, #223049);
  }
  .ccht-accounts-head h2 { margin: 0; font-size: 1.02rem; }
  .ccht-accounts-close, .ccht-account-action {
    min-height: 2.5rem; padding: 0.45rem 0.85rem; border: 1px solid var(--ccht-border, #30405c); border-radius: 0.5rem;
    color: var(--ccht-fg, #c2cede); background: var(--ccht-tab-bg, #111c2d);
    font: inherit; font-size: 0.8rem; font-weight: 800; cursor: pointer;
  }
  .ccht-accounts-close:hover, .ccht-account-action:hover:not(:disabled) {
    border-color: var(--ccht-accent, #53708f); background: var(--ccht-tab-bg-hover, #17243a);
  }
  .ccht-account-action:disabled { cursor: progress; opacity: 0.6; }
  .ccht-accounts-body { padding: 0.9rem 1rem 1rem; overflow: auto; overscroll-behavior: contain; display: grid; gap: 0.7rem; align-content: start; }
  .ccht-accounts-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
  .ccht-account-row {
    display: grid; gap: 0.4rem; justify-items: start; padding: 0.75rem;
    border: 1px solid var(--ccht-border, #223049); border-radius: 0.55rem; background: var(--ccht-message-bg, #111c2d);
  }
  .ccht-account-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
  .ccht-account-status { font-size: 0.75rem; color: var(--ccht-muted, #8fa0b7); }
  .ccht-account-row[data-connected='true'] .ccht-account-status { color: var(--ccht-ok, #4ca07a); }
  .ccht-account-about, .ccht-accounts-note { margin: 0; font-size: 0.8rem; line-height: 1.5; color: var(--ccht-muted, #8fa0b7); }
  .ccht-account-error { margin: 0; font-size: 0.8rem; color: var(--ccht-error, #b91c1c); }
  @media (prefers-reduced-motion: no-preference) {
    .ccht-accounts-panel { animation: ccht-accounts-in 0.12s ease-out; }
    @keyframes ccht-accounts-in { from { opacity: 0; transform: translateY(-0.25rem); } }
  }
</style>
