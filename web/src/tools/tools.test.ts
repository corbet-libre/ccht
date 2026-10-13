import { describe, expect, test } from 'bun:test';
import { ToolError } from '../agent/errors.ts';
import { localTools, mergeTools } from './local.ts';
import { McpError, mirroredParams, remoteMcp } from './mcp.ts';
import { renderToolResult, truncateText } from './render.ts';
import type { McpToolDefinition } from '../agent/types.ts';

const ctx = () => ({ signal: new AbortController().signal });

describe('localTools', () => {
  const tools = localTools([
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, handler: (a) => a },
    { name: 'text', description: 'Text', inputSchema: { type: 'object' }, handler: () => 'plain' },
    { name: 'full', description: 'Full', inputSchema: { type: 'object' }, handler: () => ({ content: [{ type: 'text', text: 'x' }], isError: false }) },
    { name: 'bad', description: 'Bad', inputSchema: { type: 'object' }, handler: () => { throw new ToolError('nope'); } },
    { name: 'crash', description: 'Crash', inputSchema: { type: 'object' }, handler: () => { throw new Error('internal /etc/secret'); } },
  ]);

  test('lists MCP-shaped definitions and normalises handler results', async () => {
    expect((await tools.listTools()).map((t) => t.name)).toEqual(['echo', 'text', 'full', 'bad', 'crash']);
    expect(await tools.callTool('echo', { a: 1 }, ctx())).toEqual({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } });
    expect(await tools.callTool('text', {}, ctx())).toEqual({ content: [{ type: 'text', text: 'plain' }] });
    expect((await tools.callTool('full', {}, ctx())).content).toEqual([{ type: 'text', text: 'x' }]);
  });

  test('errors become isError results; only ToolError text is exposed', async () => {
    expect(await tools.callTool('bad', {}, ctx())).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] });
    expect(await tools.callTool('crash', {}, ctx())).toEqual({ isError: true, content: [{ type: 'text', text: 'The tool failed.' }] });
    expect((await tools.callTool('ghost', {}, ctx())).isError).toBe(true);
  });

  test('validates names and rejects duplicates', () => {
    expect(() => localTools([{ name: 'has space', description: '', inputSchema: {}, handler: () => 1 }])).toThrow(TypeError);
    const one = { name: 'a', description: '', inputSchema: {}, handler: () => 1 };
    expect(() => localTools([one, one])).toThrow(TypeError);
  });

  test('mergeTools routes by name and rejects duplicates across sources', async () => {
    const a = localTools([{ name: 'a', description: '', inputSchema: {}, handler: () => 'A' }]);
    const b = localTools([{ name: 'b', description: '', inputSchema: {}, handler: () => 'B' }]);
    const merged = mergeTools(a, b);
    expect((await merged.listTools()).map((t) => t.name)).toEqual(['a', 'b']);
    expect((await merged.callTool('b', {}, ctx())).content).toEqual([{ type: 'text', text: 'B' }]);
    await expect(mergeTools(a, a).listTools()).rejects.toThrow(TypeError);
  });

  test('render helpers flatten and truncate', () => {
    expect(renderToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'xx' }, { type: 'resource', resource: { text: 'doc' } }] })).toBe('a\n[image content omitted]\ndoc');
    expect(renderToolResult({ content: [], structuredContent: { k: 1 } })).toBe('{"k":1}');
    expect(truncateText('x'.repeat(100), 50).length).toBe(50);
    expect(truncateText('short', 50)).toBe('short');
  });
});

interface Seen { method: string; headers: Headers; body?: any }

/** A fixture MCP server speaking either era over a fake fetch. */
function server(era: 'modern' | 'legacy', options: { sse?: boolean; pages?: McpToolDefinition[][]; sessionExpiry?: boolean; legacyBadRequest?: boolean } = {}) {
  const seen: Seen[] = [];
  let session = 'sess-1';
  let sessions = 0;
  const pages = options.pages ?? [[{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]];
  const reply = (id: unknown, result: unknown, sse: boolean | undefined, headers: Record<string, string> = {}) => {
    const message = JSON.stringify({ jsonrpc: '2.0', id, result });
    return sse
      ? new Response(`: hello\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${message}\n\n`, { headers: { 'content-type': 'text/event-stream', ...headers } })
      : new Response(message, { headers: { 'content-type': 'application/json', ...headers } });
  };
  const fetcher = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    seen.push({ method: init.method ?? 'GET', headers, body });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (era === 'legacy') {
      if (body?.params?._meta) return options.legacyBadRequest === false ? new Response('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"},"id":null}', { status: 400 }) : new Response('legacy server: bad request', { status: 400 });
      if (body.method === 'initialize') { sessions++; session = `sess-${sessions}`; return reply(body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } }, false, { 'mcp-session-id': session }); }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (options.sessionExpiry && sessions === 1 && body.method === 'tools/list') return new Response('session gone', { status: 404 });
      if (headers.get('mcp-session-id') !== session) return new Response('no session', { status: 400 });
    } else if (headers.get('mcp-protocol-version') !== '2026-07-28' || headers.get('mcp-method') !== body?.method) {
      return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"HeaderMismatch"}}', { status: 400 });
    }
    if (body.method === 'tools/list') {
      const index = body.params?.cursor ? Number(body.params.cursor) : 0;
      return reply(body.id, { resultType: 'complete', tools: pages[index], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) }, options.sse);
    }
    if (body.method === 'tools/call') {
      if (body.params.name === 'ask') return reply(body.id, { resultType: 'input_required', inputRequests: { x: { method: 'elicitation/create', params: {} } } }, false);
      if (body.params.name === 'boom') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool: secret detail' } }));
      return reply(body.id, { resultType: 'complete', content: [{ type: 'text', text: `found ${JSON.stringify(body.params.arguments)}` }], isError: false }, options.sse);
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

describe('remote MCP: modern (2026-07-28)', () => {
  test('lists and calls tools statelessly with per-request metadata and mirrored headers', async () => {
    const { fetcher, seen } = server('modern');
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher, headers: { authorization: 'Bearer app-token' } });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(['search']);
    const result = await mcp.callTool('search', { q: 'cats' }, ctx());
    expect(result.content).toEqual([{ type: 'text', text: 'found {"q":"cats"}' }]);
    expect(mcp.era()).toBe('modern');
    expect(seen).toHaveLength(2);
    const [list, call] = seen;
    expect(list!.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(list!.headers.get('mcp-method')).toBe('tools/list');
    expect(list!.headers.get('accept')).toBe('application/json, text/event-stream');
    expect(list!.headers.get('authorization')).toBe('Bearer app-token');
    expect(list!.body.params._meta).toMatchObject({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} });
    expect(list!.body.params._meta['io.modelcontextprotocol/clientInfo']).toMatchObject({ name: 'ccht' });
    expect(call!.headers.get('mcp-name')).toBe('search');
    expect(call!.body.params).toMatchObject({ name: 'search', arguments: { q: 'cats' } });
    expect(call!.body.id).not.toBe(list!.body.id);
  });

  test('reads SSE responses (ignoring notifications) and follows pagination', async () => {
    const t = (name: string): McpToolDefinition => ({ name, inputSchema: { type: 'object' } });
    const { fetcher } = server('modern', { sse: true, pages: [[t('a')], [t('b')], [t('c')]] });
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    expect((await mcp.listTools()).map((x) => x.name)).toEqual(['a', 'b', 'c']);
    expect((await mcp.callTool('a', {}, ctx())).content[0]).toMatchObject({ text: 'found {}' });
  });

  test('non-ASCII tool names use the base64 sentinel; x-mcp-header parameters are mirrored', async () => {
    const tools: McpToolDefinition[] = [
      { name: 'sql', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, n: { type: 'integer', 'x-mcp-header': 'Count' }, nested: { type: 'object', properties: { ok: { type: 'boolean', 'x-mcp-header': 'Flag' } } } } } },
      { name: 'Größe', inputSchema: { type: 'object' } },
      { name: 'invalid', inputSchema: { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': '' } } } },
      { name: 'unreachable', inputSchema: { type: 'object', properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'X' } } } } },
    ];
    const { fetcher, seen } = server('modern', { pages: [tools] });
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(['sql', 'Größe']);
    await mcp.callTool('sql', { region: 'us-west1', n: 3, nested: { ok: true } }, ctx());
    await mcp.callTool('sql', { region: ' padded ' }, ctx());
    await mcp.callTool('Größe', {}, ctx());
    const [, first, second, third] = seen;
    expect(first!.headers.get('mcp-param-region')).toBe('us-west1');
    expect(first!.headers.get('mcp-param-count')).toBe('3');
    expect(first!.headers.get('mcp-param-flag')).toBe('true');
    expect(second!.headers.get('mcp-param-region')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(second!.headers.get('mcp-param-count')).toBeNull();
    expect(third!.headers.get('mcp-name')).toBe(`=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode('Größe')))}?=`);
  });

  test('mirroredParams enforces the schema constraints', () => {
    const ok = { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' } } };
    expect(mirroredParams(ok)).toEqual([{ header: 'Mcp-Param-A', path: ['a'] }]);
    expect(mirroredParams({ type: 'object', properties: { a: { type: 'number', 'x-mcp-header': 'A' } } })).toBeNull();
    expect(mirroredParams({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } })).toBeNull();
    expect(mirroredParams({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'bad name' } } })).toBeNull();
    expect(mirroredParams({ type: 'object' })).toEqual([]);
  });

  test('tool failures and protocol errors become isError results with fixed text', async () => {
    const { fetcher } = server('modern');
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    await mcp.listTools();
    const input = await mcp.callTool('ask', {}, ctx());
    expect(input).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('interactive input') }] });
    const protocol = await mcp.callTool('boom', {}, ctx());
    expect(protocol.isError).toBe(true);
    expect(JSON.stringify(protocol)).not.toContain('secret detail');
  });

  test('a modern JSON-RPC error body does not trigger the legacy fallback', async () => {
    const seen: string[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported', data: { supported: ['2027-01-01'], requested: '2026-07-28' } } }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(remoteMcp('https://mcp.example/mcp', { fetch: fetcher }).listTools()).rejects.toBeInstanceOf(McpError);
    expect(seen).toEqual(['tools/list']);
  });

  test('transport failures throw McpError with fixed text; aborts propagate', async () => {
    const down = remoteMcp('https://mcp.example/mcp', { fetch: (async () => { throw new TypeError('Failed to fetch https://internal'); }) as typeof fetch });
    await expect(down.listTools()).rejects.toMatchObject({ message: 'The MCP server could not be reached.' });
    const controller = new AbortController();
    controller.abort();
    const hanging = remoteMcp('https://mcp.example/mcp', { fetch: ((_u: string, init: RequestInit) => new Promise((_, reject) => {
      const abort = (): void => reject(new DOMException('x', 'AbortError'));
      if (init.signal!.aborted) abort(); else init.signal!.addEventListener('abort', abort);
    })) as unknown as typeof fetch });
    await expect(hanging.callTool('x', {}, { signal: controller.signal })).rejects.toBeDefined();
    const live = new AbortController();
    const pending = hanging.callTool('x', {}, { signal: live.signal });
    live.abort();
    await expect(pending).rejects.toBeDefined();
  });

  test('endpoint validation', () => {
    expect(() => remoteMcp('http://example.com/mcp')).toThrow(TypeError);
    expect(() => remoteMcp('https://user:pw@example.com/mcp')).toThrow(TypeError);
    expect(() => remoteMcp('http://localhost:8787/mcp')).not.toThrow();
  });
});

describe('remote MCP: legacy sessions (2025-03-26 .. 2025-11-25)', () => {
  test('falls back to initialize after a non-modern 400, then uses the session headers', async () => {
    const { fetcher, seen } = server('legacy');
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    expect((await mcp.listTools()).map((t) => t.name)).toEqual(['search']);
    expect(mcp.era()).toBe('legacy');
    expect(seen.map((s) => s.body?.method)).toEqual(['tools/list', 'initialize', 'notifications/initialized', 'tools/list']);
    const [, init, ack, list] = seen;
    expect(init!.body.params).toMatchObject({ protocolVersion: '2025-11-25', capabilities: {} });
    expect(ack!.headers.get('mcp-session-id')).toBe('sess-1');
    expect(ack!.headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(list!.headers.get('mcp-session-id')).toBe('sess-1');
    const result = await mcp.callTool('search', { q: 'dogs' }, ctx());
    expect(result.content[0]).toMatchObject({ text: 'found {"q":"dogs"}' });
    expect(seen.at(-1)!.body.params._meta).toBeUndefined();
    expect(seen.at(-1)!.headers.get('mcp-method')).toBeNull();
  });

  test('a legacy server answering with a JSON-RPC -32000 error also triggers the fallback', async () => {
    const { fetcher } = server('legacy', { legacyBadRequest: false });
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    expect((await mcp.listTools()).length).toBe(1);
    expect(mcp.era()).toBe('legacy');
  });

  test('an expired session (404) is re-initialised once', async () => {
    const { fetcher, seen } = server('legacy', { sessionExpiry: true });
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    expect((await mcp.listTools()).length).toBe(1);
    expect(seen.filter((s) => s.body?.method === 'initialize')).toHaveLength(2);
    expect(seen.at(-1)!.headers.get('mcp-session-id')).toBe('sess-2');
  });

  test('SSE responses work and close() ends the session with DELETE', async () => {
    const { fetcher, seen } = server('legacy', { sse: true });
    const mcp = remoteMcp('https://mcp.example/mcp', { fetch: fetcher });
    await mcp.listTools();
    await mcp.close!();
    expect(seen.at(-1)!.method).toBe('DELETE');
    expect(seen.at(-1)!.headers.get('mcp-session-id')).toBe('sess-1');
  });
});
