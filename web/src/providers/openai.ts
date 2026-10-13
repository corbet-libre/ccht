/** Streaming client for OpenAI-compatible `/chat/completions` endpoints.
 *
 * Shared by the Pollinations and OpenRouter providers. It turns the SSE stream
 * into provider-neutral `ModelChunk`s and maps every failure to a stable
 * `ProviderError`; response bodies and exception messages are never surfaced.
 */
import { ProviderError, errorFromStatus, isAbort } from '../agent/errors.ts';
import { sseData } from '../sse.ts';
import type { ChatMessage, FinishReason, ModelChunk, ModelRequest, TokenUsage, ToolCallRequest } from '../agent/types.ts';

export interface OpenAiStreamOptions {
  /** Full URL of the chat completions endpoint. */
  url: string;
  headers?: Record<string, string>;
  fetch: typeof fetch;
  request: ModelRequest;
  /** Extra JSON body fields. */
  body?: Record<string, unknown>;
}

/** Convert neutral messages into OpenAI chat messages. */
export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.isError ? `Error: ${message.content}` : message.content };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

const finishReasons: Record<string, FinishReason> = {
  stop: 'stop', tool_calls: 'tool_calls', function_call: 'tool_calls', length: 'length', content_filter: 'content_filter',
};

function codeFromBodyError(error: { code?: unknown }): ProviderError {
  const status = typeof error.code === 'number' ? error.code : Number(error.code);
  return Number.isInteger(status) && status >= 400 ? errorFromStatus(status) : new ProviderError('provider_error');
}

interface PartialCall {
  id?: string;
  name: string;
  args: string;
}

/** Stream one chat completion. */
export async function* openAiStream(options: OpenAiStreamOptions): AsyncGenerator<ModelChunk, void, void> {
  const { request } = options;
  const body = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.tools.length
      ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }
      : {}),
    ...options.body,
  };
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: request.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...options.headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isAbort(error) || request.signal.aborted) throw error;
    throw new ProviderError('network_error');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw errorFromStatus(response.status);
  }
  if (!response.body) throw new ProviderError('invalid_response');

  const calls = new Map<number, PartialCall>();
  let finish: FinishReason | undefined;
  let usage: TokenUsage | undefined;
  let done = false;
  try {
    for await (const data of sseData(response.body, request.signal)) {
      if (data.trim() === '[DONE]') {
        done = true;
        break;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new ProviderError('invalid_response');
      }
      if (chunk.error && typeof chunk.error === 'object') throw codeFromBodyError(chunk.error as { code?: unknown });
      const rawUsage = chunk.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null | undefined;
      if (rawUsage && typeof rawUsage === 'object') {
        const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
        usage = { inputTokens: number(rawUsage.prompt_tokens), outputTokens: number(rawUsage.completion_tokens), totalTokens: number(rawUsage.total_tokens) };
      }
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
      const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      for (const part of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const index = typeof part.index === 'number' ? part.index : calls.size;
        const call = calls.get(index) ?? { name: '', args: '' };
        const fn = (part.function ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof part.id === 'string' && part.id) call.id = part.id;
        if (typeof fn.name === 'string') call.name += fn.name;
        if (typeof fn.arguments === 'string') call.args += fn.arguments;
        calls.set(index, call);
      }
      if (typeof choice.finish_reason === 'string') finish = finishReasons[choice.finish_reason] ?? 'stop';
    }
  } catch (error) {
    if (isAbort(error) || request.signal.aborted) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('network_error');
  }
  if (finish === undefined && !done) return; // truncated stream: the agent reports incomplete_stream
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!call.name) continue;
    yield { type: 'tool_call', call: parseCall(call, index) };
  }
  yield { type: 'finish', reason: finish ?? (calls.size ? 'tool_calls' : 'stop'), usage };
}

function parseCall(call: PartialCall, index: number): ToolCallRequest {
  const id = call.id ?? `call_${index}`;
  if (!call.args.trim()) return { id, name: call.name, arguments: {} };
  try {
    return { id, name: call.name, arguments: JSON.parse(call.args) };
  } catch {
    return { id, name: call.name, arguments: {}, invalidArguments: true };
  }
}
