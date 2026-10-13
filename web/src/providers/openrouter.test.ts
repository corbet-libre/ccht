import { describe, expect, test } from 'bun:test';
import { collect, memoryStore, sseResponse } from '../testing.ts';
import {
  authorizeURL, beginConnect, callbackURL, clearKey, codeChallenge, codeVerifier, completeConnect, defaultKeyStorageKey,
  defaultPendingStorageKey, isKeyTarget, keyedFetch, loadKey, pendingCallback, saveKey,
} from './openrouter-oauth.ts';
import { openrouter } from './openrouter.ts';
import type { ModelRequest } from '../agent/types.ts';

const page = { origin: 'https://app.example', pathname: '/chat/', search: '', hash: '' };

describe('PKCE helpers', () => {
  test('S256 challenge matches the RFC 7636 appendix B vector', async () => {
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('verifiers are url-safe, long and unique', () => {
    const a = codeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(codeVerifier()).not.toBe(a);
  });

  test('authorize URL carries callback, challenge, method and state; callback has no query or hash', () => {
    const url = new URL(authorizeURL(callbackURL(page), 'CHAL', 'STATE'));
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: 'https://app.example/chat/', code_challenge: 'CHAL', code_challenge_method: 'S256', state: 'STATE',
    });
  });
});

describe('key host restriction', () => {
  test.each([
    ['https://openrouter.ai/api/v1/chat/completions', true],
    ['https://openrouter.ai/api/v1/auth/keys', true],
    ['https://openrouter.ai/api/v1', false],
    ['http://openrouter.ai/api/v1/models', false],
    ['https://openrouter.ai.evil.example/api/v1/models', false],
    ['https://evil.example/https://openrouter.ai/api/v1/models', false],
    ['https://user:pw@openrouter.ai/api/v1/models', false],
    ['https://openrouter.ai/api/v1/../../evil', false],
    ['https://openrouter.ai:8443/api/v1/models', false],
    ['not a url', false],
  ])('%s -> %s', (target, allowed) => {
    expect(isKeyTarget(target)).toBe(allowed);
  });

  test('keyedFetch adds the bearer only for OpenRouter targets and refuses everything else before sending', async () => {
    const sent: Array<{ url: string; auth: string | null; credentials?: string }> = [];
    const send = (async (input: string, init: RequestInit) => { sent.push({ url: input, auth: new Headers(init.headers).get('authorization'), credentials: init.credentials }); return new Response('{}'); }) as unknown as typeof fetch;
    const fetcher = keyedFetch(send, () => 'sk-test');
    await fetcher('https://openrouter.ai/api/v1/models', { headers: { 'x-a': 'b' } });
    expect(sent[0]).toEqual({ url: 'https://openrouter.ai/api/v1/models', auth: 'Bearer sk-test', credentials: 'omit' });
    expect(() => fetcher('https://example.com/api/v1/models')).toThrow();
    expect(() => fetcher('https://openrouter.ai.evil.example/api/v1/x')).toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe('sign-in flow', () => {
  test('begin stores the verifier in the session store only and returns the authorize URL', async () => {
    const local = memoryStore();
    const session = memoryStore();
    const url = new URL(await beginConnect(page, session));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const pending = JSON.parse(session.data.get(defaultPendingStorageKey)!);
    expect(await codeChallenge(pending.verifier)).toBe(url.searchParams.get('code_challenge')!);
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(local.data.size).toBe(0);
    expect(pendingCallback('?code=abc', session)).toBe(true);
    expect(pendingCallback('?code=abc', memoryStore())).toBe(false);
    expect(pendingCallback('?x=1', session)).toBe(false);
  });

  test('begin fails when session storage is unavailable', async () => {
    await expect(beginConnect(page, undefined)).rejects.toThrow();
  });

  async function start() {
    const local = memoryStore();
    const session = memoryStore();
    const url = new URL(await beginConnect(page, session));
    return { local, session, state: url.searchParams.get('state')!, verifier: JSON.parse(session.data.get(defaultPendingStorageKey)!).verifier as string };
  }

  test('complete exchanges the code, stores the key locally only, strips code and state', async () => {
    const { local, session, state, verifier } = await start();
    const replaced: string[] = [];
    const bodies: unknown[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { bodies.push([url, JSON.parse(init.body as string)]); return new Response(JSON.stringify({ key: 'sk-or-v1-abc' })); }) as unknown as typeof fetch;
    const result = await completeConnect({ page: { search: `?code=C0DE&state=${state}&keep=1`, pathname: '/chat/', hash: '#h' }, replace: (u) => replaced.push(u), fetch: fetcher, local, session });
    expect(result).toBe('connected');
    expect(replaced).toEqual(['/chat/?keep=1#h']);
    expect(bodies).toEqual([['https://openrouter.ai/api/v1/auth/keys', { code: 'C0DE', code_verifier: verifier, code_challenge_method: 'S256' }]]);
    expect(loadKey(local)).toBe('sk-or-v1-abc');
    expect(session.data.has(defaultPendingStorageKey)).toBe(false);
    expect(session.data.size).toBe(0);
    expect(local.data.get(defaultKeyStorageKey)).toBe('sk-or-v1-abc');
  });

  test('a state mismatch, a missing state, an expired verifier and a rejected code all fail without storing a key', async () => {
    const never = (async () => { throw new Error('must not exchange'); }) as unknown as typeof fetch;
    for (const search of ['?code=C&state=forged', '?code=C']) {
      const { local, session } = await start();
      await expect(completeConnect({ page: { search, pathname: '/', hash: '' }, replace: () => {}, fetch: never, local, session })).rejects.toThrow();
      expect(loadKey(local)).toBe('');
    }
    const expired = memoryStore({ [defaultPendingStorageKey]: JSON.stringify({ verifier: 'v', state: 's', at: Date.now() - 31 * 60 * 1000 }) });
    await expect(completeConnect({ page: { search: '?code=C&state=s', pathname: '/', hash: '' }, replace: () => {}, fetch: never, local: memoryStore(), session: expired })).rejects.toThrow('expired');
    const { local, session, state } = await start();
    const rejected = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(completeConnect({ page: { search: `?code=C&state=${state}`, pathname: '/', hash: '' }, replace: () => {}, fetch: rejected, local, session })).rejects.toThrow();
    expect(loadKey(local)).toBe('');
  });

  test('without a pending sign-in or code nothing happens', async () => {
    const fetcher = (async () => { throw new Error('no'); }) as unknown as typeof fetch;
    expect(await completeConnect({ page: { search: '?code=x', pathname: '/', hash: '' }, replace: () => {}, fetch: fetcher, local: memoryStore(), session: memoryStore() })).toBe('none');
    expect(await completeConnect({ page: { search: '', pathname: '/', hash: '' }, replace: () => {}, fetch: fetcher, local: memoryStore(), session: memoryStore() })).toBe('none');
  });

  test('key storage helpers tolerate broken storage', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadKey(broken)).toBe('');
    expect(saveKey(broken, 'k')).toBe(false);
    expect(clearKey(broken)).toBe(false);
  });
});

describe('openrouter provider', () => {
  const catalogue = { data: [
    { id: 'vendor/model-a:free', name: 'Model A', supported_parameters: ['tools', 'temperature'] },
    { id: 'vendor/model-b', name: 'Model B', supported_parameters: ['tools'] },
    { id: 'vendor/no-tools:free', name: 'No tools', supported_parameters: ['temperature'] },
    { id: 'vendor/model-c:free', name: 'Model C', supported_parameters: ['tools'] },
  ] };
  const base = (extra = {}) => {
    const local = memoryStore();
    const requests: Array<{ url: string; auth: string | null }> = [];
    const send = (async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.endsWith('/models') ? new Response(JSON.stringify(catalogue)) : sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]);
    }) as unknown as typeof fetch;
    return { local, requests, provider: openrouter({ storage: local, session: memoryStore(), fetch: send, page, ...extra }) };
  };
  const req = (model: string): ModelRequest => ({ model, messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal });

  test('needs sign-in until a key exists; connect navigates to the authorize URL', async () => {
    const navigated: string[] = [];
    const { provider, local } = base({ navigate: (u: string) => navigated.push(u) });
    expect(await provider.available()).toMatchObject({ ok: false, state: 'needs_sign_in' });
    await provider.account.connect();
    expect(navigated[0]).toStartWith('https://openrouter.ai/auth?');
    saveKey(local, 'sk-x');
    expect(await provider.available()).toEqual({ ok: true, state: 'ready' });
    expect(provider.account.connected()).toBe(true);
    provider.account.disconnect();
    expect(provider.account.connected()).toBe(false);
  });

  test('lists free tool-capable models by default, billed ones only after explicit opt-in and labelled', async () => {
    const { provider } = base({ pinned: ['vendor/model-c:free'] });
    expect(provider.billing).toBe('free');
    expect((await provider.models()).map((m) => [m.value, m.name])).toEqual([
      ['vendor/model-c:free', 'Model C (free)'], ['vendor/model-a:free', 'Model A (free)'],
    ]);
    provider.allowPaid = true;
    expect(provider.billing).toBe('user_account');
    const all = await provider.models();
    expect(all.map((m) => m.value)).toEqual(['vendor/model-c:free', 'vendor/model-a:free', 'vendor/model-b']);
    expect(all.at(-1)).toMatchObject({ billed: true, name: 'Model B (billed to your account)' });
  });

  test('streams with the key sent only to the OpenRouter API; paid models need the opt-in', async () => {
    const { provider, local, requests } = base();
    expect(() => provider.stream(req('vendor/model-a:free'))).toThrow(expect.objectContaining({ code: 'auth_required' }));
    saveKey(local, 'sk-live');
    const chunks = await collect(provider.stream(req('vendor/model-a:free')));
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
    expect(requests).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', auth: 'Bearer sk-live' }]);
    expect(() => provider.stream(req('vendor/model-b'))).toThrow(expect.objectContaining({ code: 'configuration_error' }));
    provider.allowPaid = true;
    await collect(provider.stream(req('vendor/model-b')));
    expect(requests).toHaveLength(2);
  });

  test('completeRedirect finishes a sign-in using the provider stores', async () => {
    const session = memoryStore();
    const local = memoryStore();
    const replaced: string[] = [];
    const send = (async () => new Response(JSON.stringify({ key: 'sk-new' }))) as unknown as typeof fetch;
    const navigated: string[] = [];
    const first = openrouter({ storage: local, session, page, fetch: send, navigate: (u) => navigated.push(u), replace: (u) => replaced.push(u) });
    await first.account.connect();
    const state = new URL(navigated[0]!).searchParams.get('state');
    const back = openrouter({ storage: local, session, page: { ...page, search: `?code=ok&state=${state}` }, fetch: send, replace: (u) => replaced.push(u) });
    expect(await back.completeRedirect()).toBe('connected');
    expect(back.account.connected()).toBe(true);
    expect(replaced).toEqual(['/chat/']);
  });

  test('a custom storage key keeps an existing sign-in', async () => {
    const local = memoryStore({ 'cccc.chat.openrouter.v1': 'sk-old' });
    const provider = openrouter({ storage: local, session: memoryStore(), storageNames: { key: 'cccc.chat.openrouter.v1' }, page });
    expect(provider.account.connected()).toBe(true);
  });
});
