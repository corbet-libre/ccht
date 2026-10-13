/** Local in-browser models through WebLLM (`@mlc-ai/web-llm`, WebGPU).
 *
 * `@mlc-ai/web-llm` is an optional peer dependency and is never imported by this
 * module: the application passes a loader (`load: () => import('@mlc-ai/web-llm')`,
 * or `loadWebLlm` from `@corbet-labs/ccht/providers/webllm-loader`). The loader runs
 * only inside `prepare()`, which the UI must call from an explicit user action after
 * showing the download disclosure. Tools use the constrained-JSON protocol: WebLLM's
 * own function calling is limited to a few 7-8B Hermes builds and does not stream.
 */
import { ProviderError, isAbort } from '../agent/errors.ts';
import { ToolProtocolParser, toProtocolMessages, toolProtocolSchema } from './json-tools.ts';
import type { ModelChunk, ModelInfo, ModelProvider, ModelRequest, PrepareOptions, ProviderAvailability } from '../agent/types.ts';

/** The slice of the WebLLM API this provider uses. */
export interface WebLlmEngine {
  chat: { completions: { create(request: Record<string, unknown>): Promise<AsyncIterable<{
    choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  }>> } };
  interruptGenerate(): void | Promise<void>;
  reload?(modelId: string): Promise<void>;
  unload(): Promise<void>;
}
export interface WebLlmModule {
  CreateMLCEngine(
    modelId: string,
    config?: { initProgressCallback?: (report: { progress: number; text?: string }) => void },
  ): Promise<WebLlmEngine>;
}

/** Curated WebLLM models (sizes from the 0.2.86 prebuilt list; downloads are approximate). */
export const webllmModels: ModelInfo[] = [
  { value: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', name: 'Hermes 3 Llama 3.2 3B', approxDownloadMB: 1800, memoryMB: 2264 },
  { value: 'Qwen3-1.7B-q4f16_1-MLC', name: 'Qwen3 1.7B (smaller, weaker)', approxDownloadMB: 1100, memoryMB: 2037 },
  { value: 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC', name: 'Hermes 2 Pro Mistral 7B (large)', approxDownloadMB: 4100, memoryMB: 4033 },
];

export interface WebLlmOptions {
  /** Import WebLLM. Required: this package never imports it itself. */
  load: () => Promise<WebLlmModule>;
  models?: ModelInfo[];
  /** Whether WebGPU exists. Defaults to `'gpu' in navigator`. Injected in tests. */
  hasWebGpu?: () => boolean;
  /** Remembers which models were fetched before (a hint only). Defaults to `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

const consentPrefix = 'ccht.webllm.loaded.';

export function webllm(options: WebLlmOptions): ModelProvider {
  const catalogue = options.models ?? webllmModels;
  const hasGpu = options.hasWebGpu ?? ((): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator);
  const store = (() => {
    try {
      return options.storage ?? globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();
  let engine: WebLlmEngine | undefined;
  let loadedModel: string | undefined;
  let preparing: Promise<void> | undefined;

  const known = (id: string): boolean => {
    try {
      return store?.getItem(consentPrefix + id) === '1';
    } catch {
      return false;
    }
  };
  const remember = (id: string): void => {
    try {
      store?.setItem(consentPrefix + id, '1');
    } catch {
      // The hint is optional.
    }
  };

  const provider: ModelProvider = {
    id: 'webllm',
    label: 'Local model on this device (WebLLM)',
    attribution: 'WebLLM',
    billing: 'free',
    limits: { maxToolOutputChars: 6_000 },
    async available(): Promise<ProviderAvailability> {
      if (!hasGpu()) return { ok: false, state: 'unsupported', reason: 'This browser has no WebGPU, which local models need.' };
      if (engine) return { ok: true, state: 'ready' };
      const first = catalogue[0];
      return {
        ok: false,
        state: 'needs_consent',
        reason: 'A local model must be downloaded to this device first.',
        download: { approxMB: first?.approxDownloadMB, memoryMB: first?.memoryMB, cached: first ? known(first.value) : false, note: 'Approximate; the exact size depends on the model chosen.' },
      };
    },
    async models(): Promise<ModelInfo[]> {
      return catalogue;
    },
    async prepare(prepare: PrepareOptions = {}): Promise<void> {
      const model = prepare.model ?? catalogue[0]?.value;
      if (!model || !catalogue.some((item) => item.value === model)) throw new ProviderError('model_unavailable');
      if (!hasGpu()) throw new ProviderError('provider_unavailable');
      if (engine && loadedModel === model) return;
      preparing ??= (async () => {
        try {
          const module = await options.load();
          if (engine) await engine.unload().catch(() => {});
          engine = undefined;
          loadedModel = undefined;
          const created = await module.CreateMLCEngine(model, {
            initProgressCallback: (report) => prepare.onProgress?.({ loaded: report.progress, text: report.text }),
          });
          if (prepare.signal?.aborted) {
            await created.unload().catch(() => {});
            throw new DOMException('Aborted', 'AbortError');
          }
          engine = created;
          loadedModel = model;
          remember(model);
        } catch (error) {
          if (isAbort(error)) throw error;
          throw new ProviderError('provider_unavailable');
        }
      })().finally(() => { preparing = undefined; });
      await preparing;
    },
    async *stream(request: ModelRequest): AsyncGenerator<ModelChunk, void, void> {
      if (!engine || loadedModel !== request.model) throw new ProviderError('consent_required');
      const active = engine;
      const tools = request.tools.length > 0;
      const interrupt = (): void => void Promise.resolve(active.interruptGenerate()).catch(() => {});
      request.signal.addEventListener('abort', interrupt, { once: true });
      try {
        const stream = await active.chat.completions.create({
          messages: toProtocolMessages(request.messages, request.tools),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(tools ? { response_format: { type: 'json_object', schema: JSON.stringify(toolProtocolSchema(request.tools)) } } : {}),
        });
        const parser = tools ? new ToolProtocolParser(request.tools) : undefined;
        let reason: string | null | undefined;
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (text) {
            if (parser) yield* parser.push(text);
            else yield { type: 'text', text };
          }
          if (choice?.finish_reason) reason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
        if (request.signal.aborted) return;
        const tokens = usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined;
        if (reason === 'length') {
          // A truncated constrained document is not parseable; report the limit instead.
          yield { type: 'finish', reason: 'length', usage: tokens };
          return;
        }
        const ending = parser ? parser.end() : [{ type: 'finish', reason: 'stop' } as ModelChunk];
        for (const item of ending) yield item.type === 'finish' ? { ...item, usage: tokens } : item;
      } catch (error) {
        if (isAbort(error) || request.signal.aborted) throw error;
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('provider_error');
      } finally {
        request.signal.removeEventListener('abort', interrupt);
      }
    },
  };
  return provider;
}
