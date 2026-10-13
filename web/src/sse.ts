/** Minimal Server-Sent Events reader over a fetch body (WHATWG HTML section 9.2). */

/** Yield the `data` payload of each complete event. Comments and other fields are ignored.
 * An event left unterminated when the stream ends is discarded, per the specification. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // A trailing CR may be the first half of a CRLF split across chunks.
      const hold = buffer.endsWith('\r') ? 1 : 0;
      const ready = buffer.slice(0, buffer.length - hold);
      const lines = ready.split(/\r\n|\n|\r/);
      buffer = lines.pop()! + buffer.slice(buffer.length - hold);
      for (const line of lines) {
        if (line === '') {
          if (data.length) {
            const event = data.join('\n');
            data = [];
            yield event;
          }
        } else if (line.startsWith('data:')) {
          const rest = line.slice(5);
          data.push(rest.startsWith(' ') ? rest.slice(1) : rest);
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
