/** Browser behavior of the generic provider picker (ProviderPicker.svelte). */
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ProviderPicker, { formatMB } from './ProviderPicker.svelte';
import type { ProviderEntry } from '../providers/inspect.ts';

afterEach(() => cleanup());

const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: 'free', label: 'Free chat', attribution: 'Pollinations', billed: false,
  availability: { ok: true, state: 'ready' }, models: [{ value: 'm1', name: 'Model One' }, { value: 'm2', name: 'Model Two' }], ...over,
});

function open(entries: ProviderEntry[], props: Record<string, unknown> = {}) {
  return render(ProviderPicker, {
    entries, selectedId: entries[0]!.id, modelValue: 'm1', onSelectProvider: () => {}, onSelectModel: () => {}, ...props,
  });
}

describe('availability', () => {
  test('lists providers with attribution; unsupported ones are disabled and explain why', () => {
    const { getByLabelText, getByText } = open([
      entry(),
      entry({ id: 'local', label: 'Local model', attribution: 'WebLLM', models: [], availability: { ok: false, state: 'unsupported', reason: 'This browser has no WebGPU.' } }),
    ]);
    expect(getByText('Pollinations')).toBeTruthy();
    expect((getByLabelText(/Local model/) as HTMLInputElement).disabled).toBe(true);
    expect(getByText('This browser has no WebGPU.').getAttribute('role')).toBe('status');
    expect((getByLabelText(/Free chat/) as HTMLInputElement).checked).toBe(true);
  });

  test('selecting a provider and a model forwards ids', async () => {
    const onSelectProvider = vi.fn();
    const onSelectModel = vi.fn();
    const { getByLabelText } = open([entry(), entry({ id: 'second', label: 'Second' })], { onSelectProvider, onSelectModel });
    await fireEvent.click(getByLabelText(/Second/));
    expect(onSelectProvider).toHaveBeenCalledWith('second');
    await fireEvent.change(getByLabelText('Model'), { target: { value: 'm2' } });
    expect(onSelectModel).toHaveBeenCalledWith('free', 'm2');
  });
});

describe('consent and accounts', () => {
  const local = entry({
    id: 'local', label: 'Local model', models: [],
    availability: { ok: false, state: 'needs_consent', reason: 'A local model must be downloaded first.', download: { approxMB: 1800, memoryMB: 2264 } },
  });

  test('a download is disclosed and only starts from the explicit button', async () => {
    const onPrepare = vi.fn();
    const { getByRole, getByText } = open([local], { onPrepare });
    expect(getByText(/Downloads about 1.8 GB to this device and needs about 2.3 GB of memory/)).toBeTruthy();
    expect(onPrepare).not.toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Download and use' }));
    expect(onPrepare).toHaveBeenCalledWith('local');
  });

  test('progress is shown while preparing', () => {
    const { getByRole } = open([local], { onPrepare: () => {}, progress: { local: { loaded: 0.4, text: 'Fetching params' } }, busyId: 'local' });
    const bar = getByRole('progressbar') as HTMLProgressElement;
    expect(bar.value).toBeCloseTo(0.4);
    expect(bar.getAttribute('aria-label')).toBe('Fetching params');
    expect((getByRole('button', { name: 'Download and use' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('own-account providers connect, disconnect and opt in to billed models explicitly', async () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onAllowPaid = vi.fn();
    const signedOut = entry({ id: 'or', label: 'OpenRouter', models: [], billed: false, account: { connected: false }, availability: { ok: false, state: 'needs_sign_in', reason: 'Connect your own account.' } });
    const first = open([signedOut], { onConnect });
    await fireEvent.click(first.getByRole('button', { name: 'Connect account' }));
    expect(onConnect).toHaveBeenCalledWith('or');
    cleanup();
    const signedIn = entry({ id: 'or', label: 'OpenRouter', account: { connected: true } });
    const second = open([signedIn], { onDisconnect, onAllowPaid, allowPaid: false });
    const toggle = second.getByLabelText('Allow models billed to my account') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await fireEvent.click(toggle);
    expect(onAllowPaid).toHaveBeenCalledWith(true);
    await fireEvent.click(second.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith('or');
  });

  test('labels are overridable', () => {
    const { getByRole } = open([local], { onPrepare: () => {}, labels: { download: 'Get it' } });
    expect(getByRole('button', { name: 'Get it' })).toBeTruthy();
  });

  test('formatMB', () => {
    expect(formatMB(512)).toBe('512 MB');
    expect(formatMB(2264)).toBe('2.3 GB');
  });
});
