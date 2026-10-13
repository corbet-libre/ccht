/** The browser's built-in model through the Prompt API (`LanguageModel` global).
 *
 * Spec: https://github.com/webmachinelearning/prompt-api . `availability()` reports
 * `unavailable | downloadable | downloading | available`; `create()` with a
 * `monitor` starts the download and needs user activation. This provider calls
 * `create()` only from `prepare()` (an explicit user action) and only when the
 * model is already `available` while chatting, so it never starts a download on
 * its own. Tools use the constrained-JSON protocol (`responseConstraint`), which
 * the specification defines for every implementation; the API's own open-loop
 * `tool-call` content is not used (see the README).
 */
import { ProviderError, isAbort } from '../agent/errors.ts';
import { ToolProtocolParser, toProtocolMessages, toolProtocolSchema } from './json-tools.ts';
import type { ModelChunk, ModelInfo, ModelProvider, ModelRequest, PrepareOptions, ProviderAvailability } from '../agent/types.ts';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** The slice of the Prompt API this provider uses. */
export interface PromptSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal; responseConstraint?: unknown }): ReadableStream<string>;
  destroy(): void;
}
export interface PromptApi {
  availability(options?: unknown): Promise<Availability>;
  create(options?: {
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    expectedInputs?: Array<{ type: string; languages?: string[] }>;
    expectedOutputs?: Array<{ type: string; languages?: string[] }>;
    monitor?: (monitor: EventTarget) => void;
    signal?: AbortSignal;
  }): Promise<PromptSession>;
}

export interface BuiltinOptions {
  /** Resolve the API; defaults to `globalThis.LanguageModel`. Injected in tests. */
  api?: () => PromptApi | undefined;
  /** Input/output languages declared to the API (default `['en']`). */
  languages?: string[];
}

export const builtinModelId = 'browser';

export function builtin(options: BuiltinOptions = {}): ModelProvider {
  const api = options.api ?? ((): PromptApi | undefined => (globalThis as { LanguageModel?: PromptApi }).LanguageModel);
  const languages = options.languages ?? ['en'];
  const io = {
    expectedInputs: [{ type: 'text', languages }],
    expectedOutputs: [{ type: 'text', languages }],
  };

  async function status(): Promise<Availability | 'missing'> {
    const lm = api();
    if (!lm) return 'missing';
    try {
      return await lm.availability(io);
    } catch {
      return 'unavailable';
    }
  }

  return {
    id: 'builtin',
    label: 'Built-in browser model',
    attribution: 'Built-in browser model',
    billing: 'free',
    limits: { maxToolOutputChars: 8_000 },
    async available(): Promise<ProviderAvailability> {
      switch (await status()) {
        case 'missing':
          return { ok: false, state: 'unsupported', reason: 'This browser has no built-in model (Prompt API).' };
        case 'unavailable':
          return { ok: false, state: 'unsupported', reason: 'This device or language is not supported by the built-in model.' };
        case 'downloadable':
          return { ok: false, state: 'needs_consent', reason: 'The built-in model must be downloaded first; the browser decides the size.', download: { note: 'Size set by the browser.' } };
        case 'downloading':
          return { ok: false, state: 'needs_consent', reason: 'The built-in model is still downloading.', download: { note: 'Download in progress.' } };
        default:
          return { ok: true, state: 'ready' };
      }
    },
    async models(): Promise<ModelInfo[]> {
      return [{ value: builtinModelId, name: 'Built-in browser model' }];
    },
    async prepare(prepare: PrepareOptions = {}): Promise<void> {
      const lm = api();
      if (!lm) throw new ProviderError('provider_unavailable');
      try {
        const session = await lm.create({
          ...io,
          signal: prepare.signal,
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
              const loaded = (event as { loaded?: number }).loaded;
              if (typeof loaded === 'number') prepare.onProgress?.({ loaded: Math.min(1, Math.max(0, loaded)) });
            });
          },
        });
        session.destroy();
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new ProviderError('consent_required');
      }
    },
    async *stream(request: ModelRequest): AsyncGenerator<ModelChunk, void, void> {
      const lm = api();
      if (!lm) throw new ProviderError('provider_unavailable');
      const state = await status();
      if (state === 'downloadable' || state === 'downloading') throw new ProviderError('consent_required');
      if (state !== 'available') throw new ProviderError('provider_unavailable');
      const messages = toProtocolMessages(request.messages, request.tools);
      const last = messages.pop();
      if (!last || last.role === 'system') throw new ProviderError('configuration_error');
      let session: PromptSession | undefined;
      try {
        session = await lm.create({ ...io, initialPrompts: messages, signal: request.signal });
        const tools = request.tools.length > 0;
        const stream = session.promptStreaming(last.content, {
          signal: request.signal,
          ...(tools ? { responseConstraint: toolProtocolSchema(request.tools) } : {}),
        });
        const parser = tools ? new ToolProtocolParser(request.tools) : undefined;
        const reader = stream.getReader();
        const onAbort = (): void => void reader.cancel().catch(() => {});
        request.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // Chunks are deltas (current specification); text is never re-sent.
            if (parser) yield* parser.push(value);
            else if (value) yield { type: 'text', text: value };
          }
        } finally {
          request.signal.removeEventListener('abort', onAbort);
          reader.releaseLock();
        }
        if (request.signal.aborted) return;
        if (parser) yield* parser.end();
        else yield { type: 'finish', reason: 'stop' };
      } catch (error) {
        if (isAbort(error) || request.signal.aborted) throw error;
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('provider_error');
      } finally {
        session?.destroy();
      }
    },
  };
}
