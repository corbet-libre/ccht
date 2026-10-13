/** Stable failure codes of the browser agent. Messages are fixed strings: raw
 * upstream text (provider bodies, exception messages) never reaches the UI,
 * logs or the stored transcript.
 */
export type ErrorCode =
  | 'provider_unavailable'
  | 'rate_limited'
  | 'auth_required'
  | 'payment_required'
  | 'model_unavailable'
  | 'consent_required'
  | 'network_error'
  | 'invalid_response'
  | 'incomplete_stream'
  | 'provider_error'
  | 'configuration_error'
  | 'tools_unavailable';

export const errorMessages: Record<ErrorCode, string> = {
  provider_unavailable: 'The model provider is unavailable. Try again later or pick another provider.',
  rate_limited: 'The model provider is rate limiting requests. Try again later.',
  auth_required: 'The model provider needs you to sign in again.',
  payment_required: 'The connected account has no credit for this model.',
  model_unavailable: 'The selected model is unavailable.',
  consent_required: 'This model has to be downloaded or loaded first, which needs your confirmation.',
  network_error: 'The model provider could not be reached. Check your connection. Nothing was retried elsewhere.',
  invalid_response: 'The model provider returned a response that could not be understood.',
  incomplete_stream: 'The provider stream ended before completion. Your prompt was not retried.',
  provider_error: 'The model provider failed. No other provider was used.',
  configuration_error: 'The assistant is not configured for this request.',
  tools_unavailable: 'The data tools could not be reached.',
};

/** Failures worth trying the next explicitly configured free provider for. */
const retryable: ReadonlySet<ErrorCode> = new Set([
  'provider_unavailable',
  'rate_limited',
  'model_unavailable',
  'network_error',
  'provider_error',
]);

/** A provider failure carrying only a stable code (and an HTTP status, when known). */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  constructor(code: ErrorCode, status?: number) {
    super(errorMessages[code]);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
  get retryable(): boolean {
    return retryable.has(this.code);
  }
}

/** Map an HTTP status to a stable code. The response body is never inspected. */
export function errorFromStatus(status: number): ProviderError {
  const code: ErrorCode =
    status === 401 || status === 403 ? 'auth_required'
    : status === 402 ? 'payment_required'
    : status === 404 ? 'model_unavailable'
    : status === 408 || status === 429 ? 'rate_limited'
    : status >= 500 ? 'provider_unavailable'
    : 'provider_error';
  return new ProviderError(code, status);
}

/** True for the abort errors fetch and streams raise on cancellation. */
export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Normalise anything thrown by a provider into a ProviderError. */
export function toProviderError(error: unknown): ProviderError {
  return error instanceof ProviderError ? error : new ProviderError('provider_error');
}

/** Raised by tool handlers to report a failure whose message is safe to show the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
