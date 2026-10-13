import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../agent/errors.ts';
import { sseData } from '../sse.ts';
import { collect, sseResponse } from '../testing.ts';
import { openAiStream, toOpenAiMessages } from './openai.ts';
import { pollinations, anonymousToolModels } from './pollinations.ts';
import type { ModelRequest } from '../agent/types.ts';

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'openai', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal, ...over,
});
const delta = (d: object, extra: object = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] });
const run = (response: Response | (() => Response), over: Partial<ModelRequest> = {}) =>
  collect(openAiStream({ url: 'https://x.test/chat', fetch: (async () => (typeof response === 'function' ? response() : response)) as typeof fetch, request: request(over) }));

describe('sse reader', () => {
  test('handles split chunks, CRLF, comments and multi-line data', async () => {
    const encoder = new TextEncoder();
    const parts = [': keepalive\r\n', 'data: {"a"', ':1}\r', '\n\r\ndata: x\ndata: y\n\n', 'data: lost'];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(encoder.encode(p)); c.close(); } });
    expect(await collect(sseData(body))).toEqual(['{"a":1}', 'x\ny']);
  });
});

describe('openai-compatible stream', () => {
  test('text, reasoning, usage and finish', async () => {
    const chunks = await run(sseResponse([
      delta({ role: 'assistant', content: '' }),
      delta({ reasoning: 'think' }), delta({ reasoning_content: 'more' }),
      delta({ content: 'Hel' }), delta({ content: 'lo' }),
      delta({}, { finish_reason: 'stop' }),
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]));
    expect(chunks).toEqual([
      { type: 'reasoning', text: 'think' }, { type: 'reasoning', text: 'more' },
      { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    ]);
  });

  test('assembles streamed tool call fragments (recorded Pollinations shape)', async () => {
    const chunks = await run(sseResponse([
      delta({ tool_calls: [{ index: 0, id: 'chatcmpl-tool-1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      ...['{"', 'city', '":"', 'Zur', 'ich', '"}'].map((a) => delta({ tool_calls: [{ index: 0, function: { arguments: a } }] })),
      delta({}, { finish_reason: 'tool_calls' }),
    ]));
    expect(chunks).toEqual([
      { type: 'tool_call', call: { id: 'chatcmpl-tool-1', name: 'get_weather', arguments: { city: 'Zurich' } } },
      { type: 'finish', reason: 'tool_calls', usage: undefined },
    ]);
  });

  test('invalid argument JSON is flagged, empty arguments become {}', async () => {
    const chunks = await run(sseResponse([
      delta({ tool_calls: [{ index: 0, function: { name: 'a', arguments: '{bad' } }, { index: 1, function: { name: 'b', arguments: '' } }] }),
      delta({}, { finish_reason: 'tool_calls' }),
    ]));
    expect(chunks[0]).toMatchObject({ call: { id: 'call_0', name: 'a', invalidArguments: true } });
    expect(chunks[1]).toMatchObject({ call: { id: 'call_1', name: 'b', arguments: {} } });
  });

  test('sends tools, streaming flags and tool-result messages; never credentials', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => { seen = { url, init }; return sseResponse([delta({}, { finish_reason: 'stop' })]); }) as unknown as typeof fetch;
    await collect(openAiStream({ url: 'https://x.test/chat', fetch: fetcher, request: request({
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }], maxOutputTokens: 77,
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] }, { role: 'tool', toolCallId: 'c1', name: 't', content: 'bad', isError: true }],
    }) }));
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ model: 'openai', stream: true, max_tokens: 77, tools: [{ type: 'function', function: { name: 't', description: 'd' } }] });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'Error: bad' });
    expect(seen!.init.credentials).toBe('omit');
  });

  test.each([[401, 'auth_required'], [403, 'auth_required'], [402, 'payment_required'], [404, 'model_unavailable'], [429, 'rate_limited'], [503, 'provider_unavailable'], [400, 'provider_error']])(
    'HTTP %i maps to %s without reading the body', async (status, code) => {
      const error = await run(new Response('upstream secret text', { status })).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('secret');
    });

  test('network failure and in-stream error objects', async () => {
    const down = collect(openAiStream({ url: 'https://x.test', fetch: (async () => { throw new TypeError('Failed to fetch https://leak'); }) as typeof fetch, request: request() }));
    await expect(down).rejects.toMatchObject({ code: 'network_error', message: expect.not.stringContaining('leak') });
    const inStream = await run(sseResponse([delta({ content: 'a' }), { error: { code: 429, message: 'slow down' } }])).catch((e) => e);
    expect(inStream.code).toBe('rate_limited');
    const garbage = await run(sseResponse(['not json'])).catch((e) => e);
    expect(garbage.code).toBe('invalid_response');
  });

  test('a stream that stops without finish or [DONE] ends without a finish chunk', async () => {
    const chunks = await run(sseResponse([delta({ content: 'x' })], {}, false));
    expect(chunks).toEqual([{ type: 'text', text: 'x' }]);
  });

  test('toOpenAiMessages keeps plain turns untouched', () => {
    expect(toOpenAiMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }])).toEqual([
      { role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }]);
  });
});

describe('pollinations', () => {
  const catalogue = [
    { name: 'openai-fast', description: 'GPT-OSS 20B Reasoning LLM (OVH)', tier: 'anonymous', tools: true, aliases: ['openai'] },
    { name: 'paid-one', description: 'Paid', tier: 'seed', tools: true },
    { name: 'no-tools', description: 'No tools', tier: 'anonymous', tools: false },
    { name: 'community', description: 'C', tier: 'anonymous', tools: true, community: true },
  ];

  test('keeps anonymous-tier tool-capable models only', () => {
    expect(anonymousToolModels(catalogue).map((m) => m.value)).toEqual(['openai-fast', 'community']);
    expect(anonymousToolModels({})).toEqual([]);
  });

  test('availability and models come from the live catalogue; attribution is Pollinations', async () => {
    const fetcher = (async () => new Response(JSON.stringify(catalogue))) as unknown as typeof fetch;
    const provider = pollinations({ fetch: fetcher });
    expect(provider.attribution).toBe('Pollinations');
    expect(provider.billing).toBe('free');
    expect(await provider.available()).toEqual({ ok: true, state: 'ready' });
    expect((await provider.models())[0]).toEqual({ value: 'openai-fast', name: 'GPT-OSS 20B Reasoning LLM (OVH)' });
  });

  test('unreachable or empty catalogue is reported with a reason, not an exception', async () => {
    const down = pollinations({ fetch: (async () => { throw new TypeError('x'); }) as typeof fetch });
    expect(await down.available()).toMatchObject({ ok: false, state: 'unavailable', reason: expect.any(String) });
    expect(await down.models()).toEqual([]);
    const empty = pollinations({ fetch: (async () => new Response('[]')) as unknown as typeof fetch });
    expect(await empty.available()).toMatchObject({ ok: false });
    const error = pollinations({ fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch });
    expect((await error.available()).ok).toBe(false);
  });

  test('streams keylessly; referrer is optional and goes in the query', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const fetcher = (async (url: string, init: RequestInit) => { urls.push(url); headers.push(init.headers as Record<string, string>); return sseResponse([delta({ content: 'ok' }), delta({}, { finish_reason: 'stop' })]); }) as unknown as typeof fetch;
    await collect(pollinations({ fetch: fetcher }).stream(request()));
    await collect(pollinations({ fetch: fetcher, referrer: 'my app' }).stream(request()));
    expect(urls).toEqual(['https://text.pollinations.ai/openai', 'https://text.pollinations.ai/openai?referrer=my%20app']);
    expect(Object.keys(headers[0]!).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

