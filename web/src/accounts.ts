/** Account connections for `AccountsButton.svelte` and `AccountsPanel.svelte`.
 *
 * `createAccounts(providers)` keeps the connect/disconnect state of every
 * provider that exposes `account` (for example `openrouter()`), as a Svelte
 * store (`subscribe`) so the header button and the panel stay in sync. It owns
 * no credentials: it only calls the provider's `account` and `completeRedirect`.
 * Failures surface as stable codes, never upstream text.
 */
import type { ModelProvider, ProviderAccount } from './agent/types.ts';

/** A provider that uses the visitor's own account. */
export type AccountProvider = ModelProvider & {
  readonly account: ProviderAccount;
  /** Call once on page load: finishes a sign-in redirect. */
  completeRedirect?: () => Promise<'connected' | 'none'>;
};

/** Keep only the providers that can connect an account. */
export function accountProviders(providers: readonly ModelProvider[]): AccountProvider[] {
  return providers.filter((provider): provider is AccountProvider => !!provider.account);
}

export type AccountErrorCode = 'connect_failed' | 'disconnect_failed' | 'redirect_failed';

export interface AccountRow {
  id: string;
  label: string;
  attribution?: string;
  connected: boolean;
  /** True while a connect or disconnect is in progress. */
  busy: boolean;
  error: AccountErrorCode | '';
}

export interface AccountsState {
  rows: AccountRow[];
  connectedCount: number;
  /** Result of finishing a sign-in redirect on page load, until dismissed. */
  redirect: { id: string; label: string; result: 'connected' | 'failed' } | null;
}

export interface AccountsStore {
  subscribe(run: (state: AccountsState) => void): () => void;
  get(): AccountsState;
  /** Re-read every provider (call after an outside change). */
  refresh(): void;
  /** Finish sign-in redirects. Each provider's `completeRedirect` runs once, however often this is called. */
  completeRedirects(): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(id: string): void;
  dismissRedirect(): void;
}

export interface AccountsOptions {
  /** Called after a provider's connection state changed through this store. */
  onChange?: (change: { id: string; connected: boolean }) => void;
}

export function createAccounts(providers: readonly ModelProvider[], options: AccountsOptions = {}): AccountsStore {
  const list = accountProviders(providers);
  const listeners = new Set<(state: AccountsState) => void>();
  const busy = new Set<string>();
  const errors = new Map<string, AccountErrorCode>();
  let redirect: AccountsState['redirect'] = null;
  let redirects: Promise<void> | undefined;

  const read = (): AccountsState => {
    const rows = list.map((provider): AccountRow => {
      let connected = false;
      try { connected = provider.account.connected(); } catch { /* Treat an unreadable store as not connected. */ }
      return {
        id: provider.id,
        label: provider.label,
        ...(provider.attribution ? { attribution: provider.attribution } : {}),
        connected,
        busy: busy.has(provider.id),
        error: errors.get(provider.id) ?? '',
      };
    });
    return { rows, connectedCount: rows.filter((row) => row.connected).length, redirect };
  };
  let state = read();
  const publish = (): void => {
    state = read();
    for (const run of listeners) run(state);
  };
  const find = (id: string): AccountProvider | undefined => list.find((provider) => provider.id === id);
  const changed = (id: string, connected: boolean): void => {
    try { options.onChange?.({ id, connected }); } catch { /* The observer must not break the store. */ }
  };

  return {
    subscribe(run) {
      listeners.add(run);
      run(state);
      return () => { listeners.delete(run); };
    },
    get: () => state,
    refresh: publish,
    completeRedirects() {
      redirects ??= (async () => {
        for (const provider of list) {
          if (!provider.completeRedirect) continue;
          try {
            if ((await provider.completeRedirect()) === 'connected') {
              redirect = { id: provider.id, label: provider.label, result: 'connected' };
              changed(provider.id, true);
            }
          } catch {
            redirect = { id: provider.id, label: provider.label, result: 'failed' };
            errors.set(provider.id, 'redirect_failed');
          }
        }
        publish();
      })();
      return redirects;
    },
    async connect(id) {
      const provider = find(id);
      if (!provider || busy.has(id)) return;
      busy.add(id);
      errors.delete(id);
      publish();
      try {
        await provider.account.connect();
      } catch {
        errors.set(id, 'connect_failed');
      } finally {
        busy.delete(id);
        publish();
        if (state.rows.find((row) => row.id === id)?.connected) changed(id, true);
      }
    },
    disconnect(id) {
      const provider = find(id);
      if (!provider) return;
      errors.delete(id);
      try {
        provider.account.disconnect();
      } catch {
        errors.set(id, 'disconnect_failed');
      }
      publish();
      changed(id, state.rows.find((row) => row.id === id)?.connected ?? false);
    },
    dismissRedirect() {
      if (!redirect) return;
      redirect = null;
      publish();
    },
  };
}
