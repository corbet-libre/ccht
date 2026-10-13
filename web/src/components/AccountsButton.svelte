<!-- Header button for the accounts panel. Shows how many accounts are connected.
  It also finishes sign-in redirects on page load (each provider's
  `completeRedirect` runs once, through the shared accounts store) and opens the
  panel with the result. It never stores anything; the app owns `open`. -->
<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import type { AccountsState, AccountsStore } from '../accounts.ts';

  let {
    accounts,
    open = $bindable(false),
    panelId = 'ccht-accounts-panel',
    label = 'Accounts',
    countLabel = (count: number) => `${count} connected`,
    openOnRedirect = true,
    icon
  }: {
    accounts: AccountsStore;
    open?: boolean;
    /** `id` of the matching `AccountsPanel`. */
    panelId?: string;
    label?: string;
    /** Text for the connected count (also read by screen readers). */
    countLabel?: (count: number) => string;
    /** Open the panel when a sign-in redirect finished (default on). */
    openOnRedirect?: boolean;
    /** Optional icon placed before the label. */
    icon?: Snippet;
  } = $props();

  let state: AccountsState = $state(untrack(() => accounts.get()));
  $effect(() => accounts.subscribe((next) => { state = next; }));
  $effect(() => {
    if (openOnRedirect && state.redirect) open = true;
  });
  onMount(() => { void accounts.completeRedirects(); });

  const description = $derived(state.connectedCount > 0 ? `${label}, ${countLabel(state.connectedCount)}` : label);
</script>

<button
  type="button"
  class="ccht-accounts-button"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={panelId}
  aria-label={description}
  onclick={() => { open = !open; }}
>
  {#if icon}{@render icon()}{/if}
  <span class="ccht-accounts-button-label">{label}</span>
  {#if state.connectedCount > 0}<span class="ccht-accounts-count" aria-hidden="true">{state.connectedCount}</span>{/if}
</button>

<style>
  .ccht-accounts-button {
    display: inline-flex; align-items: center; gap: 0.45rem; min-height: 2.5rem; padding: 0.4rem 0.7rem;
    border: 1px solid var(--ccht-border, #30405c); border-radius: 0.5rem;
    color: var(--ccht-fg, #c2cede); background: var(--ccht-tab-bg, #111c2d);
    font: inherit; font-size: 0.8rem; font-weight: 750; cursor: pointer;
  }
  .ccht-accounts-button:hover, .ccht-accounts-button[aria-expanded='true'] {
    border-color: var(--ccht-accent, #53708f); background: var(--ccht-tab-bg-hover, #17243a);
  }
  .ccht-accounts-button:focus-visible { outline: 2px solid var(--ccht-accent, #53708f); outline-offset: 2px; }
  .ccht-accounts-count {
    min-width: 1.25rem; padding: 0 0.35rem; border-radius: 999px; text-align: center;
    font-size: 0.7rem; line-height: 1.25rem;
    color: var(--ccht-badge-fg, #0d1625); background: var(--ccht-badge-bg, var(--ccht-ok, #4ca07a));
  }
</style>
