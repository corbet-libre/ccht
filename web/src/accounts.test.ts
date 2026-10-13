import { describe, expect, test } from 'bun:test';
import type { ModelProvider } from './agent/types.ts';
import { accountProviders, createAccounts, type AccountProvider } from './accounts.ts';

function fake(id: string, init: { connected?: boolean; redirect?: 'connected' | 'none' | Error; connect?: () => Promise<void> } = {}): AccountProvider & { redirects: number } {
  let connected = init.connected ?? false;
  const provider = {
    id, label: `${id} account`, billing: 'free' as const, redirects: 0,
    available: async () => ({ ok: true, state: 'ready' as const }),
    models: async () => [],
    stream: () => (async function* () {})(),
    account: {
      connected: () => connected,
      connect: init.connect ?? (async () => { connected = true; }),
      disconnect: () => { connected = false; },
    },
    async completeRedirect() {
      provider.redirects++;
      const result = init.redirect ?? 'none';
      if (result instanceof Error) throw result;
      if (result === 'connected') connected = true;
      return result;
    },
  };
  return provider;
}

describe('accounts store', () => {
  test('lists only account-capable providers and counts connected ones', () => {
    const plain: ModelProvider = { id: 'free', label: 'Free', billing: 'free', available: async () => ({ ok: true, state: 'ready' }), models: async () => [], stream: () => (async function* () {})() };
    expect(accountProviders([plain, fake('a')]).map((item) => item.id)).toEqual(['a']);
    const accounts = createAccounts([plain, fake('a', { connected: true }), fake('b')]);
    expect(accounts.get().rows.map((row) => [row.id, row.connected])).toEqual([['a', true], ['b', false]]);
    expect(accounts.get().connectedCount).toBe(1);
  });

  test('connect and disconnect update subscribers and report changes', async () => {
    const changes: unknown[] = [];
    const accounts = createAccounts([fake('a')], { onChange: (change) => changes.push(change) });
    const counts: number[] = [];
    const stop = accounts.subscribe((state) => counts.push(state.connectedCount));
    await accounts.connect('a');
    accounts.disconnect('a');
    stop();
    accounts.refresh();
    expect(counts.at(0)).toBe(0);
    expect(counts).toContain(1);
    expect(counts.at(-1)).toBe(0);
    expect(changes).toEqual([{ id: 'a', connected: true }, { id: 'a', connected: false }]);
  });

  test('a failing connect yields a stable code, not upstream text', async () => {
    const accounts = createAccounts([fake('a', { connect: async () => { throw new Error('secret upstream detail'); } })]);
    await accounts.connect('a');
    expect(accounts.get().rows[0]).toMatchObject({ connected: false, busy: false, error: 'connect_failed' });
    expect(JSON.stringify(accounts.get())).not.toContain('secret');
  });

  test('redirects complete once per provider however often they are requested', async () => {
    const a = fake('a', { redirect: 'connected' });
    const b = fake('b', { redirect: new Error('boom') });
    const c = fake('c');
    const accounts = createAccounts([a, b, c]);
    await Promise.all([accounts.completeRedirects(), accounts.completeRedirects()]);
    await accounts.completeRedirects();
    expect([a.redirects, b.redirects, c.redirects]).toEqual([1, 1, 1]);
    expect(accounts.get().redirect).toEqual({ id: 'b', label: 'b account', result: 'failed' });
    expect(accounts.get().rows.find((row) => row.id === 'a')?.connected).toBe(true);
    accounts.dismissRedirect();
    expect(accounts.get().redirect).toBeNull();
  });
});
