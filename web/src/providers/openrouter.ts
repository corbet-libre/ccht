/** OpenRouter with the visitor's own account (OAuth PKCE). Free (`:free`) tool-capable
 * models by default; billed models only after `allowPaid` is switched on explicitly and
 * are always labelled "billed to your account". Requests carry the key only to
 * `https://openrouter.ai/api/v1/`.
 */
import { ProviderError } from '../agent/errors.ts';
import { openAiStream } from './openai.ts';
import {
  beginConnect, clearKey, completeConnect, keyedFetch, loadKey, openrouterEndpoint,
  type StorageNames, type Store,
} from './openrouter-oauth.ts';
import type { ModelInfo, ModelProvider, ModelRequest, ProviderAvailability } from '../agent/types.ts';

export interface OpenRouterOptions {
  /** Persistent store for the key. Defaults to `localStorage` when present. */
  storage?: Store;
  /** Tab-scoped store for the PKCE verifier. Defaults to `sessionStorage` when present. */
  session?: Store;
  /** Page used for the callback URL and to strip `code`. Defaults to `location`. */
  page?: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;
  navigate?: (url: string) => void;
  replace?: (url: string) => void;
  fetch?: typeof fetch;
  /** Offer billed models too. Off by default; the UI must make this an explicit choice. */
  allowPaid?: boolean;
  /** Preferred free model ids, listed first. */
  pinned?: string[];
  /** Override storage key names, for example to keep an existing sign-in. */
  storageNames?: StorageNames;
  /** Optional attribution headers (`HTTP-Referer`, `X-Title`). */
  referer?: string;
  title?: string;
  /** Maximum models listed (default 200). */
  limit?: number;
}

export interface OpenRouterProvider extends ModelProvider {
  allowPaid: boolean;
  /** Call once on page load: completes a sign-in redirect and strips `code` from the address. */
  completeRedirect(): Promise<'connected' | 'none'>;
  readonly account: NonNullable<ModelProvider['account']>;
}

export const isFreeModelId = (id: string): boolean => id.endsWith(':free');

interface BrowserGlobals {
  history?: { replaceState(state: unknown, unused: string, url: string): void };
  location?: { assign(url: string): void };
}
const browser = (): BrowserGlobals => globalThis as unknown as BrowserGlobals;

function safeStore(kind: 'localStorage' | 'sessionStorage'): Store | undefined {
  try {
    return (globalThis as { [key: string]: unknown })[kind] as Store | undefined;
  } catch {
    return undefined;
  }
}

export function openrouter(options: OpenRouterOptions = {}): OpenRouterProvider {
  const local = options.storage ?? safeStore('localStorage');
  const session = options.session ?? safeStore('sessionStorage');
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const names = options.storageNames ?? {};
  const page = (): NonNullable<OpenRouterOptions['page']> =>
    options.page ?? (typeof location === 'undefined' ? { origin: 'https://localhost', pathname: '/', search: '', hash: '' } : location);
  const connected = (): boolean => loadKey(local, names) !== '';
  let listed: ModelInfo[] | undefined;
  const extra: Record<string, string> = {
    ...(options.referer ? { 'HTTP-Referer': options.referer } : {}),
    ...(options.title ? { 'X-Title': options.title } : {}),
  };

  const provider: OpenRouterProvider = {
    id: 'openrouter',
    label: 'OpenRouter (your account)',
    attribution: 'OpenRouter',
    get billing() {
      return provider.allowPaid ? 'user_account' : 'free';
    },
    allowPaid: options.allowPaid ?? false,
    limits: { maxToolOutputChars: 24_000 },
    account: {
      connected,
      async connect() {
        const url = await beginConnect(page(), session, names);
        (options.navigate ?? ((target: string) => browser().location?.assign(target)))(url);
      },
      disconnect() {
        clearKey(local, names);
      },
    },
    async completeRedirect() {
      return completeConnect({
        page: page(),
        replace: options.replace ?? ((url: string) => browser().history?.replaceState(null, '', url)),
        fetch: send,
        local,
        session,
        names,
      });
    },
    async available(): Promise<ProviderAvailability> {
      return connected()
        ? { ok: true, state: 'ready' }
        : { ok: false, state: 'needs_sign_in', reason: 'Connect your own OpenRouter account to use it.' };
    },
    async models(): Promise<ModelInfo[]> {
      if (!listed) {
        try {
          // The public list needs no key; only tool-capable models can drive tools.
          const response = await send(`${openrouterEndpoint}/models`, { credentials: 'omit' });
          const body = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown; supported_parameters?: unknown }> };
          listed = (body.data ?? []).flatMap((item) =>
            typeof item.id === 'string' && Array.isArray(item.supported_parameters) && item.supported_parameters.includes('tools')
              ? [{ value: item.id, name: typeof item.name === 'string' ? item.name : item.id, billed: !isFreeModelId(item.id) }]
              : []);
        } catch {
          return [];
        }
      }
      const pinned = options.pinned ?? [];
      const rank = (model: ModelInfo): number => {
        const index = pinned.indexOf(model.value);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return listed
        .filter((model) => !model.billed || provider.allowPaid)
        .sort((a, b) => Number(!!a.billed) - Number(!!b.billed) || rank(a) - rank(b) || a.name.localeCompare(b.name))
        .slice(0, options.limit ?? 200)
        .map((model) => ({ ...model, name: model.billed ? `${model.name} (billed to your account)` : `${model.name} (free)` }));
    },
    stream(request: ModelRequest) {
      if (!connected()) throw new ProviderError('auth_required');
      if (!isFreeModelId(request.model) && !provider.allowPaid) throw new ProviderError('configuration_error');
      const key = keyedFetch(send, () => loadKey(local, names));
      return openAiStream({ url: `${openrouterEndpoint}/chat/completions`, fetch: key, headers: extra, request });
    },
  };
  return provider;
}
