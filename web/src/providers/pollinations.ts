/** Pollinations: keyless, anonymous-tier chat over an OpenAI-compatible endpoint.
 *
 * `https://text.pollinations.ai/openai` answers anonymously with CORS `*` and
 * supports tool calls. `https://text.pollinations.ai/models` lists models; only
 * anonymous-tier, tool-capable ones are offered. Nothing is required from the
 * application. `referrer` optionally identifies the app to Pollinations (their
 * app-registration tier). UIs should show the attribution "Pollinations".
 */
import { ProviderError } from '../agent/errors.ts';
import { openAiStream } from './openai.ts';
import type { ModelInfo, ModelProvider, ModelRequest, ProviderAvailability } from '../agent/types.ts';

export const pollinationsEndpoint = 'https://text.pollinations.ai/openai';
export const pollinationsModelsUrl = 'https://text.pollinations.ai/models';

export interface PollinationsOptions {
  fetch?: typeof fetch;
  /** Optional app identifier sent as `referrer` (their registration tier). */
  referrer?: string;
  /** Override only for tests or a compatible mirror. */
  endpoint?: string;
  modelsUrl?: string;
  /** How long a fetched model list stays valid (default 60 s). */
  cacheMs?: number;
}

interface CatalogueEntry {
  name?: unknown;
  description?: unknown;
  tier?: unknown;
  tools?: unknown;
  community?: unknown;
  aliases?: unknown;
}

/** Keep anonymous-tier models that support tool calls. */
export function anonymousToolModels(catalogue: unknown): ModelInfo[] {
  if (!Array.isArray(catalogue)) return [];
  return (catalogue as CatalogueEntry[]).flatMap((entry) =>
    entry && entry.tier === 'anonymous' && entry.tools === true && typeof entry.name === 'string'
      ? [{ value: entry.name, name: typeof entry.description === 'string' ? entry.description : entry.name }]
      : []);
}

export function pollinations(options: PollinationsOptions = {}): ModelProvider {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = options.endpoint ?? pollinationsEndpoint;
  const url = options.referrer ? `${endpoint}?referrer=${encodeURIComponent(options.referrer)}` : endpoint;
  let cached: { at: number; models: ModelInfo[] } | undefined;

  async function load(): Promise<ModelInfo[]> {
    if (cached && Date.now() - cached.at < (options.cacheMs ?? 60_000)) return cached.models;
    const response = await send(options.modelsUrl ?? pollinationsModelsUrl, { credentials: 'omit', headers: { accept: 'application/json' } });
    if (!response.ok) throw new ProviderError('provider_unavailable', response.status);
    const models = anonymousToolModels(await response.json());
    cached = { at: Date.now(), models };
    return models;
  }

  return {
    id: 'pollinations',
    label: 'Pollinations (free)',
    attribution: 'Pollinations',
    billing: 'free',
    limits: { maxToolOutputChars: 24_000 },
    async available(): Promise<ProviderAvailability> {
      try {
        return (await load()).length
          ? { ok: true, state: 'ready' }
          : { ok: false, state: 'unavailable', reason: 'Pollinations offers no free tool-capable model right now.' };
      } catch {
        return { ok: false, state: 'unavailable', reason: 'Pollinations could not be reached.' };
      }
    },
    async models(): Promise<ModelInfo[]> {
      try {
        return await load();
      } catch {
        return [];
      }
    },
    stream(request: ModelRequest) {
      return openAiStream({ url, fetch: send, request });
    },
  };
}
