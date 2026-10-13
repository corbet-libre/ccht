<!-- Generic model-provider picker (content only; the app wraps it in a Dock or form).
  Shows every provider with its availability reason, an explicit consent step for
  downloads (built-in or WebLLM models), connect/disconnect for own-account
  providers, and a model select. It never fetches, loads, or stores anything:
  entries come from `inspectProviders()` and every action is an app callback.
  Product copy stays with the app; all strings below are overridable defaults. -->
<script module lang="ts">
  import type { ProviderEntry } from '../providers/inspect.ts';

  export interface ProviderPickerLabels {
    legend: string;
    model: string;
    download: string;
    connect: string;
    disconnect: string;
    allowPaid: string;
    connected: string;
    /** Disclosure shown before a download is started. */
    downloadNote: (download: NonNullable<ProviderEntry['availability']['download']>) => string;
  }

  export function formatMB(mb: number): string {
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  export const defaultProviderLabels: ProviderPickerLabels = {
    legend: 'Assistant',
    model: 'Model',
    download: 'Download and use',
    connect: 'Connect account',
    disconnect: 'Disconnect',
    allowPaid: 'Allow models billed to my account',
    connected: 'Connected',
    downloadNote: (download) =>
      [
        download.approxMB ? `Downloads about ${formatMB(download.approxMB)} to this device` : 'Downloads a model to this device',
        download.memoryMB ? `and needs about ${formatMB(download.memoryMB)} of memory` : '',
        download.cached ? '(already downloaded once)' : '',
      ].filter(Boolean).join(' ') + '.',
  };
</script>

<script lang="ts">
  let {
    entries,
    selectedId,
    modelValue = '',
    progress = {},
    busyId = null,
    allowPaid = false,
    labels = {},
    onSelectProvider,
    onSelectModel,
    onPrepare,
    onConnect,
    onDisconnect,
    onAllowPaid
  }: {
    entries: ProviderEntry[];
    selectedId: string;
    modelValue?: string;
    progress?: Record<string, { loaded: number; text?: string }>;
    busyId?: string | null;
    allowPaid?: boolean;
    labels?: Partial<ProviderPickerLabels>;
    onSelectProvider: (id: string) => void;
    onSelectModel: (id: string, model: string) => void;
    onPrepare?: (id: string) => void;
    onConnect?: (id: string) => void;
    onDisconnect?: (id: string) => void;
    onAllowPaid?: (value: boolean) => void;
  } = $props();

  const text: ProviderPickerLabels = $derived({ ...defaultProviderLabels, ...labels });
  const usable = (entry: ProviderEntry) =>
    entry.availability.state !== 'unsupported' && entry.availability.state !== 'unavailable';
</script>

<fieldset class="ccht-providers">
  <legend>{text.legend}</legend>
  {#each entries as entry (entry.id)}
    {@const selected = entry.id === selectedId}
    {@const state = entry.availability.state}
    <div class="ccht-provider" data-state={state} data-selected={selected}>
      <label class="ccht-provider-choice">
        <input
          type="radio"
          name="ccht-provider"
          value={entry.id}
          checked={selected}
          disabled={!usable(entry) || busyId === entry.id}
          onchange={() => onSelectProvider(entry.id)}
        />
        <span class="ccht-provider-label">{entry.label}</span>
        {#if entry.attribution}<small class="ccht-provider-attribution">{entry.attribution}</small>{/if}
      </label>
      {#if entry.availability.reason && state !== 'ready'}
        <p class="ccht-provider-reason" role="status">{entry.availability.reason}</p>
      {/if}
      {#if selected}
        {#if state === 'needs_consent'}
          {#if entry.availability.download}
            <p class="ccht-provider-download">{text.downloadNote(entry.availability.download)}</p>
          {/if}
          {#if progress[entry.id]}
            <progress
              class="ccht-provider-progress"
              max="1"
              value={progress[entry.id].loaded}
              aria-label={progress[entry.id].text ?? 'Download progress'}
            ></progress>
          {/if}
          {#if onPrepare}
            <button type="button" class="ccht-provider-action" disabled={busyId === entry.id} onclick={() => onPrepare(entry.id)}>
              {text.download}
            </button>
          {/if}
        {:else if state === 'needs_sign_in'}
          {#if onConnect}
            <button type="button" class="ccht-provider-action" disabled={busyId === entry.id} onclick={() => onConnect(entry.id)}>
              {text.connect}
            </button>
          {/if}
        {/if}
        {#if entry.account?.connected}
          <p class="ccht-provider-connected">
            {text.connected}
            {#if onDisconnect}
              <button type="button" class="ccht-provider-action" onclick={() => onDisconnect(entry.id)}>{text.disconnect}</button>
            {/if}
          </p>
          {#if onAllowPaid}
            <label class="ccht-provider-paid">
              <input type="checkbox" checked={allowPaid} onchange={(event) => onAllowPaid(event.currentTarget.checked)} />
              {text.allowPaid}
            </label>
          {/if}
        {/if}
        {#if state === 'ready' && entry.models.length}
          <label class="ccht-provider-model-label" for={`ccht-provider-${entry.id}-model`}>{text.model}</label>
          <select
            id={`ccht-provider-${entry.id}-model`}
            class="ccht-provider-model"
            value={modelValue}
            onchange={(event) => onSelectModel(entry.id, event.currentTarget.value)}
          >
            {#each entry.models as model (model.value)}
              <option value={model.value}>{model.name}</option>
            {/each}
          </select>
        {/if}
      {/if}
    </div>
  {/each}
</fieldset>

<style>
  .ccht-providers {
    display: grid;
    gap: 0.6rem;
    margin: 0;
    border: 1px solid var(--ccht-border, #30405c);
    border-radius: 0.5rem;
    padding: 0.75rem;
  }
  .ccht-providers legend { font-weight: 700; padding: 0 0.4rem; }
  .ccht-provider { display: grid; gap: 0.35rem; }
  .ccht-provider[data-state='unsupported'],
  .ccht-provider[data-state='unavailable'] { opacity: 0.7; }
  .ccht-provider-choice { display: flex; align-items: baseline; gap: 0.5rem; cursor: pointer; }
  .ccht-provider-attribution { color: var(--ccht-muted, #8fa0b7); font-size: 0.7rem; }
  .ccht-provider-reason, .ccht-provider-download, .ccht-provider-connected {
    margin: 0 0 0 1.5rem;
    font-size: 0.75rem;
    color: var(--ccht-muted, #8fa0b7);
  }
  .ccht-provider-progress { margin-left: 1.5rem; width: calc(100% - 1.5rem); }
  .ccht-provider-action {
    margin-left: 1.5rem;
    justify-self: start;
    min-height: 2.2rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--ccht-border, #30405c);
    border-radius: 0.4rem;
    background: var(--ccht-tab-bg, #111c2d);
    color: var(--ccht-fg, #bdc8d7);
    font-size: 0.75rem;
    font-weight: 750;
    cursor: pointer;
  }
  .ccht-provider-connected .ccht-provider-action { margin-left: 0.5rem; }
  .ccht-provider-paid { margin-left: 1.5rem; font-size: 0.75rem; color: var(--ccht-fg, #bdc8d7); }
  .ccht-provider-model-label { margin-left: 1.5rem; font-size: 0.75rem; color: var(--ccht-muted, #8fa0b7); }
  .ccht-provider-model {
    margin-left: 1.5rem;
    min-width: 0;
    padding: 0.5rem;
    border: 1px solid var(--ccht-select-border, #405779);
    border-radius: 0.4rem;
    background: var(--ccht-select-bg, #070f1b);
    color: var(--ccht-fg-bright, #e2eaf5);
  }
</style>
