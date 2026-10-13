import type { ModelInfo, ModelProvider, ProviderAvailability } from '../agent/types.ts';

/** Render-ready snapshot of one provider for `ProviderPicker.svelte`. */
export interface ProviderEntry {
  id: string;
  label: string;
  attribution?: string;
  availability: ProviderAvailability;
  models: ModelInfo[];
  /** Present for providers that use the visitor's own account. */
  account?: { connected: boolean };
  /** True when the provider may bill the visitor's account. */
  billed: boolean;
}

/** Query every provider's availability and model list. Never prepares or downloads anything. */
export async function inspectProviders(providers: ModelProvider[]): Promise<ProviderEntry[]> {
  return Promise.all(providers.map(async (provider) => {
    const availability = await provider.available().catch((): ProviderAvailability => ({
      ok: false, state: 'unavailable', reason: 'This provider could not be checked.',
    }));
    const models = availability.state === 'unsupported' ? [] : await provider.models().catch(() => []);
    return {
      id: provider.id,
      label: provider.label,
      ...(provider.attribution ? { attribution: provider.attribution } : {}),
      availability,
      models,
      ...(provider.account ? { account: { connected: provider.account.connected() } } : {}),
      billed: provider.billing === 'user_account',
    };
  }));
}
