/** OpenRouter own-account sign-in: OAuth PKCE (S256), https://openrouter.ai/docs/guides/overview/auth/oauth
 *
 * The exchanged API key is stored only in the visitor's own `localStorage` and
 * is attached only to requests for `https://openrouter.ai/api/v1/`; any other
 * target is refused before a header is built. The PKCE verifier lives in
 * `sessionStorage` (tab-scoped) for at most 30 minutes. Nothing here logs.
 */
export const openrouterEndpoint = 'https://openrouter.ai/api/v1';
export const defaultKeyStorageKey = 'ccht.openrouter.key.v1';
export const defaultPendingStorageKey = 'ccht.openrouter.pkce.v1';
const authURL = 'https://openrouter.ai/auth';
const maxPendingMs = 30 * 60 * 1000;

/** The subset of Storage the flow needs. */
export type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

export interface StorageNames {
  key?: string;
  pending?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomToken(bytes = 48): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export const codeVerifier = (): string => randomToken(48);

export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function authorizeURL(callback: string, challenge: string, state?: string): string {
  const url = new URL(authURL);
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (state) url.searchParams.set('state', state);
  return url.href;
}

/** The page itself, without query or hash; OpenRouter appends `?code=`. */
export const callbackURL = (page: Pick<Location, 'origin' | 'pathname'>): string => page.origin + page.pathname;

function read(store: Store | undefined, name: string): string {
  try {
    return store?.getItem(name) ?? '';
  } catch {
    return '';
  }
}

function write(store: Store | undefined, name: string, value: string | null): boolean {
  if (!store) return false;
  try {
    if (value === null) {
      if (store.removeItem) store.removeItem(name);
      else store.setItem(name, '');
    } else store.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

export const loadKey = (store?: Store, names: StorageNames = {}): string => read(store, names.key ?? defaultKeyStorageKey);
export const saveKey = (store: Store | undefined, key: string, names: StorageNames = {}): boolean => write(store, names.key ?? defaultKeyStorageKey, key);
export const clearKey = (store?: Store, names: StorageNames = {}): boolean => write(store, names.key ?? defaultKeyStorageKey, null);

/** True when `target` is an OpenRouter API URL the key may be sent to. */
export function isKeyTarget(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' && url.host === 'openrouter.ai' && !url.username && !url.password && url.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
}

/** A fetch that attaches the key to OpenRouter API requests only; any other target throws first. */
export function keyedFetch(send: typeof fetch, key: () => string): typeof fetch {
  return (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!isKeyTarget(target)) throw new Error('The OpenRouter key is only sent to OpenRouter.');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('authorization', `Bearer ${key()}`);
    return send(input, { ...init, headers, credentials: 'omit', redirect: 'manual' });
  };
}

/** Remember verifier and state for this tab and return the OpenRouter URL to visit. */
export async function beginConnect(page: Pick<Location, 'origin' | 'pathname'>, session: Store | undefined, names: StorageNames = {}): Promise<string> {
  const verifier = codeVerifier();
  const state = randomToken(16);
  if (!write(session, names.pending ?? defaultPendingStorageKey, JSON.stringify({ verifier, state, at: Date.now() }))) {
    throw new Error('Browser storage is required to connect OpenRouter.');
  }
  return authorizeURL(callbackURL(page), await codeChallenge(verifier), state);
}

/** True when the page was opened by an OpenRouter redirect that this tab started. */
export function pendingCallback(search: string, session: Store | undefined, names: StorageNames = {}): boolean {
  return new URLSearchParams(search).has('code') && read(session, names.pending ?? defaultPendingStorageKey) !== '';
}

export async function exchangeCode(send: typeof fetch, code: string, verifier: string): Promise<string> {
  const response = await send(`${openrouterEndpoint}/auth/keys`, {
    method: 'POST', credentials: 'omit', redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!response.ok) throw new Error('OpenRouter did not accept the sign-in. Connect again.');
  const value: unknown = await response.json().catch(() => null);
  const key = value && typeof value === 'object' ? (value as { key?: unknown }).key : null;
  if (typeof key !== 'string' || !key) throw new Error('OpenRouter returned no key. Connect again.');
  return key;
}

export interface CompleteOptions {
  page: Pick<Location, 'search' | 'pathname' | 'hash'>;
  /** Replace the address (for example `history.replaceState`) to strip `code` and `state`. */
  replace: (url: string) => void;
  fetch: typeof fetch;
  local: Store | undefined;
  session: Store | undefined;
  names?: StorageNames;
}

/** Finish the redirect: verify `state`, exchange `code`, store the key locally, strip the query. */
export async function completeConnect(options: CompleteOptions): Promise<'connected' | 'none'> {
  const names = options.names ?? {};
  const params = new URLSearchParams(options.page.search);
  const code = params.get('code');
  const pending = read(options.session, names.pending ?? defaultPendingStorageKey);
  if (!code || !pending) return 'none';
  const returnedState = params.get('state');
  params.delete('code');
  params.delete('state');
  const rest = params.toString();
  options.replace(options.page.pathname + (rest ? `?${rest}` : '') + options.page.hash);
  write(options.session, names.pending ?? defaultPendingStorageKey, null);
  let verifier = '';
  try {
    const stored = JSON.parse(pending) as { verifier?: unknown; state?: unknown; at?: unknown };
    if (typeof stored.verifier !== 'string' || typeof stored.at !== 'number' || Date.now() - stored.at > maxPendingMs) throw new Error();
    if (typeof stored.state === 'string' && stored.state !== returnedState) throw new Error();
    verifier = stored.verifier;
  } catch {
    throw new Error('The OpenRouter sign-in expired or did not match. Connect again.');
  }
  const key = await exchangeCode(options.fetch, code, verifier);
  if (!saveKey(options.local, key, names)) throw new Error('The key could not be stored; browser storage is unavailable.');
  return 'connected';
}
