/** AbortSignal helpers that work in every browser the package targets. */

export interface LinkedSignal {
  signal: AbortSignal;
  /** Release listeners and the timer. Safe to call more than once. */
  dispose(): void;
}

/** A signal that aborts when any input aborts or `timeoutMs` elapses. */
export function linkSignals(inputs: Array<AbortSignal | undefined>, timeoutMs?: number): LinkedSignal {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const input of inputs) {
    if (!input) continue;
    if (input.aborted) {
      abort(input.reason);
      break;
    }
    const listener = (): void => abort(input.reason);
    input.addEventListener('abort', listener, { once: true });
    cleanups.push(() => input.removeEventListener('abort', listener));
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const timer = setTimeout(() => abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/** Reject when `signal` aborts, so awaiting code never hangs on a handler that ignores it. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
