/** Test fixtures shared by the suites. Not part of the published entries. */
import type { WireEvent } from '../index.js';
import type { ModelChunk, ModelInfo, ModelProvider, ModelRequest, ProviderAvailability } from './agent/types.ts';

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export const updates = (events: WireEvent[]): Array<Record<string, unknown>> =>
  events.flatMap((wire) => (wire.event.kind === 'update' ? [wire.event.update as Record<string, unknown>] : []));

export type Script = Array<ModelChunk | Error | 'hang'>;

/** A provider that replays one script per request and records every request. */
export function scripted(scripts: Script[], extra: Partial<ModelProvider> = {}): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let call = 0;
  return {
    id: 'fixture', label: 'Fixture', attribution: 'Fixture', billing: 'free',
    async available(): Promise<ProviderAvailability> { return { ok: true, state: 'ready' }; },
    async models(): Promise<ModelInfo[]> { return [{ value: 'm1', name: 'Model One' }]; },
    requests,
    async *stream(request: ModelRequest) {
      requests.push({ ...request, messages: [...request.messages] });
      const script = scripts[Math.min(call++, scripts.length - 1)] ?? [];
      for (const item of script) {
        if (item === 'hang') {
          await new Promise<void>((_, reject) => {
            const abort = (): void => reject(new DOMException('Aborted', 'AbortError'));
            if (request.signal.aborted) abort();
            else request.signal.addEventListener('abort', abort, { once: true });
          });
        } else if (item instanceof Error) throw item;
        else yield item;
      }
    },
    ...extra,
  };
}

export const finish = (reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop'): ModelChunk => ({ type: 'finish', reason, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });

/** An SSE `Response` from data payloads. */
export function sseResponse(payloads: Array<string | object>, init: ResponseInit = {}, endWithDone = true): Response {
  const lines = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`);
  if (endWithDone) lines.push('data: [DONE]\n\n');
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

/** In-memory Storage. */
export function memoryStore(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
