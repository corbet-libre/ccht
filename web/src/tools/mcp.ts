/** Remote MCP tools over Streamable HTTP (JSON-RPC 2.0), dual-era.
 *
 * Modern servers (spec 2026-07-28) are stateless: every POST carries its protocol
 * version, client info and capabilities in `params._meta`, mirrored into the
 * `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, plus any
 * `Mcp-Param-*` headers a tool schema asks for via `x-mcp-header`. Legacy servers
 * (2025-03-26 .. 2025-11-25) use an `initialize` handshake and the `Mcp-Session-Id`
 * header. The era is detected on the first request, as the specification describes:
 * a modern request is tried first, and only a 400/404/405 whose body is not a
 * recognised modern JSON-RPC error falls back to `initialize`.
 *
 * Only `tools/list` and `tools/call` are implemented. Servers that need client
 * input mid-call (elicitation, sampling) get a clear tool failure. The server
 * must allow cross-origin requests and, for legacy sessions, expose the
 * `Mcp-Session-Id` response header. Authorization headers are supplied by the
 * application; this module stores nothing.
 *
 * Reference: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 */
import { sseData } from '../sse.ts';
import { linkSignals } from '../signals.ts';
import type { McpToolDefinition, ToolCallContext, ToolResult, ToolSource } from '../agent/types.ts';

export const modernProtocolVersion = '2026-07-28';
export const legacyProtocolVersions: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];

export interface RemoteMcpOptions {
  fetch?: typeof fetch;
  /** Extra request headers, for example `Authorization` supplied by the application. */
  headers?: Record<string, string>;
  clientInfo?: { name: string; version: string };
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Safety bound on `tools/list` pagination (default 10 pages). */
  maxPages?: number;
}

export interface RemoteMcp extends ToolSource {
  /** `modern`, `legacy`, or `undefined` before the first request. */
  era(): 'modern' | 'legacy' | undefined;
}

/** A failed MCP exchange. The message is fixed text; server text is never copied into it. */
export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

class FallbackToLegacy extends Error {}

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const safeAscii = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const sentinel = /^=\?base64\?.*\?=$/;
const modernErrorCodes: ReadonlySet<number> = new Set([-32020, -32022]);

function encodeHeaderValue(value: string): string {
  if (safeAscii.test(value) && !sentinel.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

interface MirroredParam {
  header: string;
  path: string[];
}

function countAnnotations(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countAnnotations(item), 0);
  if (typeof value !== 'object' || value === null) return 0;
  let sum = 0;
  for (const [key, child] of Object.entries(value)) sum += (key === 'x-mcp-header' ? 1 : 0) + countAnnotations(child);
  return sum;
}

/** Collect `x-mcp-header` parameters; null when the schema violates the specification. */
export function mirroredParams(schema: unknown): MirroredParam[] | null {
  const found: MirroredParam[] = [];
  const seen = new Set<string>();
  let valid = true;
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== 'object' || node === null) return;
    const properties = (node as { properties?: unknown }).properties;
    if (typeof properties !== 'object' || properties === null) return;
    for (const [name, child] of Object.entries(properties)) {
      if (typeof child !== 'object' || child === null) continue;
      const annotation = (child as Record<string, unknown>)['x-mcp-header'];
      if (annotation !== undefined) {
        const type = (child as { type?: unknown }).type;
        if (typeof annotation !== 'string' || !tokenPattern.test(annotation) || seen.has(annotation.toLowerCase()) ||
            !(type === 'string' || type === 'integer' || type === 'boolean')) {
          valid = false;
        } else {
          seen.add(annotation.toLowerCase());
          found.push({ header: `Mcp-Param-${annotation}`, path: [...path, name] });
        }
      }
      walk(child, [...path, name]);
    }
  };
  walk(schema, []);
  // Any annotation that is not statically reachable through `properties` is invalid.
  if (!valid || countAnnotations(schema) !== found.length) return null;
  return found;
}

function valueAt(args: unknown, path: string[]): unknown {
  let current: unknown = args;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function checkUrl(input: string): URL {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new TypeError('Use an HTTPS MCP endpoint (http only for localhost) without credentials or a fragment.');
  }
  return url;
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

const failed = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Connect to a remote MCP server (Streamable HTTP) and expose its tools. */
export function remoteMcp(url: string, options: RemoteMcpOptions = {}): RemoteMcp {
  const endpoint = checkUrl(url).href;
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const clientInfo = options.clientInfo ?? { name: 'ccht', version: '0.3.1' };
  const timeoutMs = options.timeoutMs ?? 30_000;
  let era: 'modern' | 'legacy' | undefined;
  let nextId = 1;
  let sessionId: string | undefined;
  let negotiated = legacyProtocolVersions[0]!;
  let initializing: Promise<void> | undefined;
  const definitions = new Map<string, MirroredParam[]>();

  async function post(body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    try {
      return await send(endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...options.headers, ...headers },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new McpError('The MCP server could not be reached.');
    }
  }

  async function errorBody(response: Response): Promise<RpcMessage['error'] | undefined> {
    try {
      const parsed: unknown = JSON.parse(await response.text());
      const error = (parsed as RpcMessage | null)?.error;
      return typeof error === 'object' && error !== null ? error : undefined;
    } catch {
      return undefined;
    }
  }

  async function readMessage(response: Response, id: number, signal: AbortSignal): Promise<RpcMessage> {
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    let found: RpcMessage | undefined;
    if (type.includes('text/event-stream') && response.body) {
      for await (const data of sseData(response.body, signal)) {
        let message: RpcMessage;
        try {
          message = JSON.parse(data) as RpcMessage;
        } catch {
          continue;
        }
        if (message.id === id && ('result' in message || 'error' in message)) {
          found = message;
          break;
        }
      }
    } else {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new McpError('The MCP server returned an unreadable response.');
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      found = (list as RpcMessage[]).find((message) => message && message.id === id);
    }
    if (!found) throw new McpError('The MCP server ended the response without a result.');
    if (found.error) throw new McpError('The MCP server reported an error.', found.error.code);
    return found;
  }

  async function modernRpc(method: string, params: Record<string, unknown>, signal: AbortSignal, extra: Record<string, string>): Promise<unknown> {
    const id = nextId++;
    const meta = {
      ...(params._meta as object | undefined),
      'io.modelcontextprotocol/protocolVersion': modernProtocolVersion,
      'io.modelcontextprotocol/clientInfo': clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const name = typeof params.name === 'string' ? params.name : undefined;
    const headers: Record<string, string> = {
      'mcp-protocol-version': modernProtocolVersion,
      'mcp-method': method,
      ...(method === 'tools/call' && name !== undefined ? { 'mcp-name': encodeHeaderValue(name) } : {}),
      ...extra,
    };
    const response = await post({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }, headers, signal);
    if (!response.ok) {
      const error = await errorBody(response);
      const modern = error?.code !== undefined &&
        (modernErrorCodes.has(error.code) || (response.status === 404 && error.code === -32601));
      if ([400, 404, 405].includes(response.status) && !modern) throw new FallbackToLegacy();
      if (error?.code === -32022) {
        const supported = (error.data as { supported?: unknown } | undefined)?.supported;
        const common = Array.isArray(supported) ? legacyProtocolVersions.find((version) => supported.includes(version)) : undefined;
        if (common) {
          negotiated = common;
          throw new FallbackToLegacy();
        }
        throw new McpError('The MCP server does not support a compatible protocol version.', error.code);
      }
      throw new McpError(response.status === 401 || response.status === 403
        ? 'The MCP server refused access.' : 'The MCP server returned an error.', error?.code);
    }
    const message = await readMessage(response, id, signal);
    era = 'modern';
    return message.result;
  }

  async function initialize(signal: AbortSignal): Promise<void> {
    sessionId = undefined;
    const id = nextId++;
    const response = await post({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: negotiated, capabilities: {}, clientInfo },
    }, {}, signal);
    if (!response.ok) throw new McpError('The MCP server did not accept the connection.');
    const message = await readMessage(response, id, signal);
    const version = (message.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    if (typeof version !== 'string' || !legacyProtocolVersions.includes(version)) {
      throw new McpError('The MCP server uses an unsupported protocol version.');
    }
    negotiated = version;
    sessionId = response.headers.get('mcp-session-id') ?? undefined;
    const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, legacyHeaders(), signal);
    if (!ack.ok) throw new McpError('The MCP server did not accept the connection.');
    await ack.body?.cancel().catch(() => {});
    era = 'legacy';
  }

  function legacyHeaders(): Record<string, string> {
    return { 'mcp-protocol-version': negotiated, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };
  }

  async function legacyRpc(method: string, params: Record<string, unknown>, signal: AbortSignal, retried = false): Promise<unknown> {
    if (era !== 'legacy') {
      initializing ??= initialize(signal).finally(() => { initializing = undefined; });
      await initializing;
    }
    const id = nextId++;
    const response = await post({ jsonrpc: '2.0', id, method, params }, legacyHeaders(), signal);
    if (response.status === 404 && sessionId && !retried) {
      // The session expired: start a new one once.
      era = undefined;
      return legacyRpc(method, params, signal, true);
    }
    if (!response.ok) throw new McpError('The MCP server returned an error.');
    return (await readMessage(response, id, signal)).result;
  }

  async function rpc(method: string, params: Record<string, unknown>, signal: AbortSignal, extra: Record<string, string> = {}): Promise<unknown> {
    if (era !== 'legacy') {
      try {
        return await modernRpc(method, params, signal, extra);
      } catch (error) {
        if (!(error instanceof FallbackToLegacy)) throw error;
        era = undefined;
      }
    }
    return legacyRpc(method, params, signal);
  }

  async function guarded<T>(outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const linked = linkSignals([outer], timeoutMs);
    try {
      return await run(linked.signal);
    } finally {
      linked.dispose();
    }
  }

  return {
    era: () => era,
    listTools(signal) {
      return guarded(signal, async (linked) => {
        const tools: McpToolDefinition[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < (options.maxPages ?? 10); page++) {
          const result = (await rpc('tools/list', cursor ? { cursor } : {}, linked)) as { tools?: unknown; nextCursor?: unknown } | undefined;
          if (!Array.isArray(result?.tools)) throw new McpError('The MCP server returned an invalid tool list.');
          for (const tool of result.tools as McpToolDefinition[]) {
            if (typeof tool?.name !== 'string' || typeof tool.inputSchema !== 'object' || tool.inputSchema === null) continue;
            const mirrored = mirroredParams(tool.inputSchema);
            // A tool with an invalid x-mcp-header annotation is excluded (Streamable HTTP, request metadata).
            if (era === 'modern' && mirrored === null) continue;
            definitions.set(tool.name, mirrored ?? []);
            tools.push(tool);
          }
          if (typeof result.nextCursor !== 'string' || !result.nextCursor) break;
          cursor = result.nextCursor;
        }
        return tools;
      });
    },
    async callTool(name: string, args: unknown, context: ToolCallContext) {
      try {
        return await guarded(context.signal, async (linked) => {
          const extra: Record<string, string> = {};
          for (const param of definitions.get(name) ?? []) {
            const value = valueAt(args, param.path);
            if (value === undefined || value === null) continue;
            if (typeof value === 'number' && !Number.isSafeInteger(value)) continue;
            extra[param.header] = encodeHeaderValue(String(value));
          }
          const params = { name, arguments: (args && typeof args === 'object' ? args : {}) as object };
          const result = await rpc('tools/call', params, linked, extra);
          if ((result as { resultType?: unknown } | undefined)?.resultType === 'input_required') {
            return failed('This tool needs interactive input, which this client does not support.');
          }
          return isToolResult(result) ? result : failed('The MCP server returned an invalid tool result.');
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        return failed(error instanceof McpError ? error.message : 'The MCP server could not be used.');
      }
    },
    async close() {
      if (era !== 'legacy' || !sessionId) return;
      const linked = linkSignals([], 5_000);
      try {
        const response = await send(endpoint, { method: 'DELETE', credentials: 'omit', redirect: 'error', signal: linked.signal, headers: { ...options.headers, ...legacyHeaders() } });
        await response.body?.cancel().catch(() => {});
      } catch {
        // Best effort: servers may answer 405 or be gone already.
      } finally {
        linked.dispose();
        sessionId = undefined;
        era = undefined;
      }
    },
  };
}
