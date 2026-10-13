/** Browser behavior of AccountsButton.svelte and AccountsPanel.svelte with
 * fake account providers: status, connect/disconnect, the connected count,
 * one-time redirect completion, and the mobile sheet. No network or storage. */
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAccounts } from '../accounts.ts';
import type { ModelProvider } from '../agent/types.ts';
import AccountsButton from './AccountsButton.svelte';
import AccountsPanel from './AccountsPanel.svelte';
import AccountsHarness from './AccountsHarness.test.svelte';

function account(id: string, init: { connected?: boolean; redirect?: 'connected' | 'none' | 'throw'; connect?: () => Promise<void> } = {}) {
  let connected = init.connected ?? false;
  const calls = { redirect: 0, connect: 0, disconnect: 0 };
  const provider: ModelProvider & { completeRedirect(): Promise<'connected' | 'none'>; calls: typeof calls } = {
    id, label: `${id[0]!.toUpperCase()}${id.slice(1)} (your account)`, attribution: id[0]!.toUpperCase() + id.slice(1), billing: 'free', calls,
    available: async () => ({ ok: true, state: 'ready' }),
    models: async () => [],
    stream: () => (async function* () {})(),
    account: {
      connected: () => connected,
      connect: async () => { calls.connect++; if (init.connect) return init.connect(); connected = true; },
      disconnect: () => { calls.disconnect++; connected = false; },
    },
    async completeRedirect() {
      calls.redirect++;
      if (init.redirect === 'throw') throw new Error('upstream detail');
      if (init.redirect === 'connected') connected = true;
      return init.redirect === 'connected' ? 'connected' : 'none';
    },
  };
  return provider;
}

function setWidth(small: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: small, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

beforeEach(() => setWidth(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AccountsButton', () => {
  test('shows the connected count and toggles the bound open state', async () => {
    const accounts = createAccounts([account('alpha', { connected: true }), account('beta')]);
    const view = render(AccountsHarness, { accounts });
    const button = view.getByRole('button', { name: 'Accounts, 1 connected' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('1');
    await fireEvent.click(button);
    await waitFor(() => expect(view.getByRole('dialog', { name: 'Accounts' })).toBeTruthy());
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('no badge and a plain name while nothing is connected', () => {
    const view = render(AccountsButton, { accounts: createAccounts([account('alpha')]) });
    const button = view.getByRole('button', { name: 'Accounts' });
    expect(button.querySelector('.ccht-accounts-count')).toBeNull();
  });

  test('the count follows connect and disconnect made in the panel', async () => {
    const accounts = createAccounts([account('alpha')]);
    const view = render(AccountsHarness, { accounts, initiallyOpen: true });
    await fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Accounts, 1 connected' })).toBeTruthy());
    await fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Accounts' })).toBeTruthy());
  });
});

describe('AccountsPanel', () => {
  test('lists each account-capable provider with status and what connecting does', () => {
    const plain: ModelProvider = { id: 'free', label: 'Free', billing: 'free', available: async () => ({ ok: true, state: 'ready' }), models: async () => [], stream: () => (async function* () {})() };
    const accounts = createAccounts([plain, account('alpha', { connected: true }), account('beta')]);
    const view = render(AccountsPanel, { accounts, open: true, descriptions: { beta: 'Custom line for beta.' } });
    expect(view.queryByText('Free')).toBeNull();
    expect(view.getByText('Uses your own Alpha account; the key stays in this browser.')).toBeTruthy();
    expect(view.getByText('Custom line for beta.')).toBeTruthy();
    const rows = view.container.querySelectorAll('.ccht-account-row');
    expect([...rows].map((row) => row.getAttribute('data-connected'))).toEqual(['true', 'false']);
    expect(view.getByText('Connected')).toBeTruthy();
    expect(view.getByText('Not connected')).toBeTruthy();
  });

  test('is extensible: a provider added to the list gets its own row', () => {
    const view = render(AccountsPanel, { accounts: createAccounts([account('alpha'), account('beta'), account('gamma')]), open: true });
    expect(view.getAllByRole('button', { name: 'Connect' })).toHaveLength(3);
  });

  test('connect calls the provider and flips to Disconnect; disconnect flips back', async () => {
    const alpha = account('alpha');
    const view = render(AccountsPanel, { accounts: createAccounts([alpha]), open: true });
    await fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Disconnect' })).toBeTruthy());
    expect(alpha.calls.connect).toBe(1);
    await fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Connect' })).toBeTruthy());
    expect(alpha.calls.disconnect).toBe(1);
  });

  test('a failing connect shows a fixed message, never upstream text', async () => {
    const view = render(AccountsPanel, { accounts: createAccounts([account('alpha', { connect: async () => { throw new Error('secret upstream detail'); } })]), open: true });
    await fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Could not start the connection.'));
    expect(document.body.textContent).not.toContain('secret upstream detail');
  });

  test('a connect in progress disables its button', async () => {
    let finish: () => void = () => {};
    const view = render(AccountsPanel, { accounts: createAccounts([account('alpha', { connect: () => new Promise<void>((resolve) => { finish = resolve; }) })]), open: true });
    await fireEvent.click(view.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect((view.getByRole('button', { name: 'Working…' }) as HTMLButtonElement).disabled).toBe(true));
    finish();
    await waitFor(() => expect(view.getByRole('button', { name: 'Connect' })).toBeTruthy());
  });

  test('completes each provider redirect once, even with button and panel mounted together', async () => {
    const alpha = account('alpha', { redirect: 'connected' });
    const accounts = createAccounts([alpha]);
    const view = render(AccountsHarness, { accounts });
    await waitFor(() => expect(view.getByRole('status').textContent).toBe('Alpha (your account) is connected.'));
    expect(alpha.calls.redirect).toBe(1);
    expect(view.getByRole('button', { name: 'Accounts, 1 connected' })).toBeTruthy();
    cleanup();
    render(AccountsHarness, { accounts });
    await Promise.resolve();
    expect(alpha.calls.redirect).toBe(1);
  });

  test('a failed redirect says so with fixed copy and opens the panel', async () => {
    const view = render(AccountsHarness, { accounts: createAccounts([account('alpha', { redirect: 'throw' })]) });
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('The sign-in could not be completed'));
    expect(document.body.textContent).not.toContain('upstream detail');
  });

  test('closing: Escape, the close button and the backdrop; focus returns to the opener', async () => {
    const view = render(AccountsHarness, { accounts: createAccounts([account('alpha')]) });
    const button = view.getByRole('button', { name: 'Accounts' });
    button.focus();
    for (const close of [
      () => fireEvent.keyDown(document, { key: 'Escape' }),
      () => fireEvent.click(view.getByRole('button', { name: 'Close' })),
      () => fireEvent.click(document.querySelector('.ccht-accounts-backdrop')!),
    ]) {
      await fireEvent.click(button);
      await waitFor(() => expect(view.getByRole('dialog')).toBeTruthy());
      await close();
      await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(button);
    }
  });

  test('small screens render a modal sheet and trap Tab', async () => {
    setWidth(true);
    const view = render(AccountsPanel, { accounts: createAccounts([account('alpha')]), open: true });
    const dialog = await waitFor(() => {
      const found = view.getByRole('dialog');
      expect(found.classList.contains('ccht-accounts-sheet')).toBe(true);
      return found;
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
    controls[controls.length - 1]!.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  test('desktop popovers are not modal and do not trap Tab', () => {
    const view = render(AccountsPanel, { accounts: createAccounts([account('alpha')]), open: true });
    expect(view.getByRole('dialog').getAttribute('aria-modal')).toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('copy is overridable and an empty list says so', () => {
    const view = render(AccountsPanel, { accounts: createAccounts([]), open: true, copy: { title: 'Connections', empty: 'Nothing to connect.' } });
    expect(view.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
    expect(view.getByText('Nothing to connect.')).toBeTruthy();
  });
});
