/** The browser agent: an in-page model/tool loop that speaks ACP.
 *
 * Native agents keep using the official ACP SDK and maintained executables; this is
 * the only in-library loop. It runs a model provider and MCP tools, and emits
 * standard `session/update` payloads wrapped in ccht `WireEvent`s, so UI, replay
 * and persistence are identical to native agents.
 *
 * Failure policy: provider errors end the turn with a stable code and a fixed
 * message (never upstream text). Nothing is retried elsewhere unless the application
 * configured an explicit ordered `fallback` list of free providers, and then only
 * before the failing request produced any output.
 */
import { ProviderError, errorMessages, isAbort, toProviderError, type ErrorCode } from './errors.ts';
import { buildSystemPrompt } from './prompt.ts';
import { linkSignals, raceAbort } from '../signals.ts';
import { mergeTools } from '../tools/local.ts';
import { renderToolResult, truncateText } from '../tools/render.ts';
import type { CchtEvent, WireEvent } from '../../index.js';

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (value: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(value); };
    const stop = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
import type {
  ChatMessage, FinishReason, McpToolDefinition, ModelChunk, ModelProvider, TokenUsage, ToolCallRequest, ToolResult, ToolSource,
} from './types.ts';

export interface BrowserAgentOptions {
  provider: ModelProvider;
  /** MCP tools given to the agent (data access follows ACP: tools are MCP tools). */
  tools?: ToolSource | ToolSource[];
  /** Application instructions. The data-not-instructions notice is added automatically. */
  system?: string;
  /** Model requests per turn (default 5). The last one is offered no tools so it must answer. */
  maxSteps?: number;
  /** Explicit ordered fallback list. Free providers only; used only before any output. */
  fallback?: ModelProvider[];
  /** Cap on tool output sent to the model and stored in events (default 24000 characters). */
  maxToolOutputChars?: number;
  /** Per tool-call timeout in milliseconds (default 30000). */
  toolTimeoutMs?: number;
  /** Opt-in: retries of the same provider after a rate limit, only while nothing was shown yet (default 0). */
  rateLimitRetries?: number;
  /** Base pause in milliseconds; the n-th retry waits n times this (default 4000). */
  rateLimitPauseMs?: number;
  maxOutputTokens?: number;
}

export interface TurnInput {
  conversationId: string;
  text: string;
  /** Earlier user/assistant messages, for example from `historyFromTurns`. */
  history?: ChatMessage[];
  /** Model id from the provider's `models()`; defaults to the first one. */
  model?: string;
  requestId?: string;
  /** Live context line (for example the current view); added to the system prompt as data. */
  context?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface BrowserAgent {
  readonly provider: ModelProvider;
  /** Run one turn and yield its ordered wire events. Exactly one terminal event is yielded. */
  turn(input: TurnInput): AsyncGenerator<WireEvent, void, void>;
}

type Outcome =
  | { kind: 'done'; text: string; calls: ToolCallRequest[]; finish: FinishReason; usage?: TokenUsage; served: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: ProviderError };

const stopReasons: Record<FinishReason, string> = {
  stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'max_turn_requests',
};

function addUsage(total: TokenUsage, next: TokenUsage | undefined): void {
  if (!next) return;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (typeof next[key] === 'number') total[key] = (total[key] ?? 0) + next[key]!;
  }
}

/** Keep an MCP result within the output budget; oversized non-text blobs are dropped. */
function boundResult(result: ToolResult, limit: number): ToolResult {
  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') return { ...item, text: truncateText(item.text, limit) };
      return JSON.stringify(item).length > limit ? { type: item.type, omitted: true } : item;
    }),
  };
}

export function createBrowserAgent(options: BrowserAgentOptions): BrowserAgent {
  const { provider } = options;
  const fallback = options.fallback ?? [];
  for (const candidate of fallback) {
    if (candidate.billing !== 'free') throw new TypeError(`Fallback provider ${candidate.id} is not free; only free providers may be fallbacks.`);
  }
  const sources = options.tools === undefined ? [] : Array.isArray(options.tools) ? options.tools : [options.tools];
  const tools: ToolSource | undefined = sources.length ? mergeTools(...sources) : undefined;
  const maxSteps = Math.max(1, options.maxSteps ?? 5);

  async function* turn(input: TurnInput): AsyncGenerator<WireEvent, void, void> {
    const requestId = input.requestId ?? crypto.randomUUID();
    const linked = linkSignals([input.signal]);
    const signal = linked.signal;
    let sequence = 0;
    let terminal = false;
    const wire = (event: CchtEvent): WireEvent => ({ version: 1, conversation_id: input.conversationId, request_id: requestId, sequence: ++sequence, event });
    const update = (payload: Record<string, unknown> & { sessionUpdate: string }): WireEvent => wire({ kind: 'update', update: payload });
    const complete = (stop: string): WireEvent => { terminal = true; return wire({ kind: 'completed', stop_reason: stop }); };
    const fail = (code: ErrorCode): WireEvent => { terminal = true; return wire({ kind: 'error', code, message: errorMessages[code] }); };

    const toolLimit = Math.min(options.maxToolOutputChars ?? 24_000, ...[provider, ...fallback].map((p) => p.limits?.maxToolOutputChars ?? Infinity));
    const usage: TokenUsage = {};
    const served: string[] = [];
    const usedIds = new Set<string>();
    const openCalls = new Set<string>();

    try {
      yield update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: input.text } });
      if (signal.aborted) { yield complete('cancelled'); return; }

      let definitions: McpToolDefinition[] = [];
      if (tools) {
        try {
          definitions = await tools.listTools(signal);
        } catch (error) {
          if (signal.aborted || isAbort(error)) { yield complete('cancelled'); return; }
          yield fail('tools_unavailable');
          return;
        }
      }
      const specs = definitions.map((tool) => ({ name: tool.name, description: tool.description ?? tool.title ?? tool.name, inputSchema: tool.inputSchema }));
      const system = buildSystemPrompt({ instructions: options.system, context: input.context, tools: specs.length > 0 });
      const messages: ChatMessage[] = [
        ...(system ? [{ role: 'system', content: system } as ChatMessage] : []),
        ...(input.history ?? []),
        { role: 'user', content: input.text },
      ];

      const chain = [provider, ...fallback];
      const rateLimitRetries = options.rateLimitRetries ?? 0;
      const rateLimitPauseMs = options.rateLimitPauseMs ?? 4000;
      const primaryModel = input.model ?? (await provider.models().catch(() => []))[0]?.value;
      if (!primaryModel) { yield fail('configuration_error'); return; }
      const maxOutputTokens = input.maxOutputTokens ?? options.maxOutputTokens;

      // One model request, with the explicit fallback list. Yields output events as they stream.
      async function* modelStep(offered: typeof specs): AsyncGenerator<WireEvent, Outcome, void> {
        let last: ProviderError = new ProviderError('provider_unavailable');
        chain: for (const [index, candidate] of chain.entries()) {
          if (index > 0 && candidate.billing !== 'free') continue;
          const model = index === 0 ? primaryModel! : (await candidate.models().catch(() => [])).find((m) => !m.billed)?.value;
          if (!model) { last = new ProviderError('model_unavailable'); continue; }
          attempts: for (let attempt = 0; ; attempt++) {
            let produced = false;
            let text = '';
            const calls: ToolCallRequest[] = [];
            let finish: { reason: FinishReason; usage?: TokenUsage } | undefined;
            try {
              const stream: AsyncIterable<ModelChunk> = candidate.stream({ model, messages, tools: offered, maxOutputTokens, signal });
              for await (const chunk of stream) {
                if (signal.aborted) return { kind: 'cancelled' };
                if (chunk.type === 'text') {
                  produced = true; text += chunk.text;
                  yield update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } });
                } else if (chunk.type === 'reasoning') {
                  produced = true;
                  yield update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } });
                } else if (chunk.type === 'tool_call') {
                  calls.push(chunk.call);
                } else {
                  finish = { reason: chunk.reason, usage: chunk.usage };
                }
              }
              if (signal.aborted) return { kind: 'cancelled' };
              if (!finish) throw new ProviderError('incomplete_stream');
              const label = candidate.attribution ?? candidate.label;
              const name = (await candidate.models().catch(() => [])).find((m) => m.value === model)?.name ?? model;
              return { kind: 'done', text, calls, finish: finish.reason, usage: finish.usage, served: `${label} · ${name}` };
            } catch (error) {
              if (signal.aborted || (isAbort(error) && !(error instanceof ProviderError))) return { kind: 'cancelled' };
              last = toProviderError(error);
              // A free provider's short rate limit is waited out before anything is shown.
              if (!produced && last.code === 'rate_limited' && attempt < rateLimitRetries) {
                if (!(await pause(rateLimitPauseMs * (attempt + 1), signal))) return { kind: 'cancelled' };
                continue attempts;
              }
              // Fall through to the next configured free provider only if nothing was shown.
              if (produced || !last.retryable) break chain;
              break attempts;
            }
          }
        }
        return { kind: 'failed', error: last };
      }

      for (let step = 0; step < maxSteps; step++) {
        const offered = step < maxSteps - 1 ? specs : [];
        const outcome = yield* modelStep(offered);
        if (outcome.kind === 'cancelled') { yield complete('cancelled'); return; }
        if (outcome.kind === 'failed') { yield fail(outcome.error.code); return; }
        addUsage(usage, outcome.usage);
        if (!served.includes(outcome.served)) served.push(outcome.served);

        // Normalise ids: they must be unique across the turn and map 1:1 to ACP tool call ids.
        const calls = outcome.calls.map((call) => {
          let id = call.id || 'call';
          while (usedIds.has(id)) id = `${id}#${usedIds.size}`;
          usedIds.add(id);
          return { ...call, id };
        });
        if (!calls.length || offered.length === 0) {
          const meta = { ...(served.length ? { 'ccht/served': served } : {}), ...(Object.keys(usage).length ? { 'ccht/token_usage': usage } : {}) };
          if (Object.keys(meta).length) yield update({ sessionUpdate: 'session_info_update', _meta: meta });
          yield complete(calls.length ? 'max_turn_requests' : stopReasons[outcome.finish === 'tool_calls' ? 'stop' : outcome.finish]);
          return;
        }

        messages.push({ role: 'assistant', content: outcome.text, toolCalls: calls });
        for (const call of calls) {
          const definition = definitions.find((tool) => tool.name === call.name);
          const kind = definition?.annotations?.readOnlyHint ? 'read' : 'other';
          openCalls.add(call.id);
          yield update({ sessionUpdate: 'tool_call', toolCallId: call.id, title: definition?.title ?? call.name, kind, status: 'pending', rawInput: call.arguments });
          yield update({ sessionUpdate: 'tool_call_update', toolCallId: call.id, status: 'in_progress' });
          let result: ToolResult;
          if (!definition) result = { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
          else if (call.invalidArguments) result = { isError: true, content: [{ type: 'text', text: 'The tool arguments were not valid JSON.' }] };
          else {
            const run = linkSignals([signal], options.toolTimeoutMs ?? 30_000);
            try {
              result = await raceAbort(tools!.callTool(call.name, call.arguments, { signal: run.signal }), run.signal);
            } catch (error) {
              if (signal.aborted) { result = { isError: true, content: [{ type: 'text', text: 'Cancelled.' }] }; }
              else if (isAbort(error) || run.signal.aborted) result = { isError: true, content: [{ type: 'text', text: 'The tool timed out.' }] };
              else result = { isError: true, content: [{ type: 'text', text: 'The tool failed.' }] };
            } finally {
              run.dispose();
            }
          }
          const bounded = boundResult(result, toolLimit);
          const rendered = renderToolResult(bounded, toolLimit);
          openCalls.delete(call.id);
          yield update({
            sessionUpdate: 'tool_call_update', toolCallId: call.id, status: result.isError ? 'failed' : 'completed',
            rawOutput: bounded, content: rendered ? [{ type: 'content', content: { type: 'text', text: rendered } }] : [],
          });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: rendered, isError: result.isError });
          if (signal.aborted) { yield complete('cancelled'); return; }
        }
      }
      yield complete('max_turn_requests');
    } catch {
      // Unexpected failure inside the loop: stable code, no raw text.
      if (!terminal) {
        for (const id of openCalls) {
          yield update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', rawOutput: { error: signal.aborted ? 'cancelled' : 'failed' } });
        }
        yield signal.aborted ? complete('cancelled') : fail('provider_error');
      }
    } finally {
      linked.dispose();
    }
  }

  return { provider, turn };
}
