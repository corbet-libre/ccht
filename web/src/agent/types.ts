/** Shared vocabulary of the browser agent, its model providers and tool sources.
 *
 * Everything here is plain data and interfaces: no DOM access, no network, no
 * storage. Providers and tool sources implement these contracts; the agent in
 * `./agent.ts` composes them into ordinary ccht/ACP events.
 */

/** A JSON Schema object (MCP `inputSchema` shape). */
export type JsonSchema = Record<string, unknown>;

/** One tool call requested by a model. `arguments` is the parsed JSON object. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: unknown;
  /** True when the model produced arguments that are not valid JSON. */
  invalidArguments?: boolean;
}

/** Provider-neutral conversation message. Tool results are data, never instructions. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

/** A tool as offered to a model. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

/** Incremental output of one model request. */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'finish'; reason: FinishReason; usage?: TokenUsage };

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  signal: AbortSignal;
}

/** A selectable model, as shown in StepConfig. */
export interface ModelInfo {
  value: string;
  name: string;
  /** True when using this model is billed to the user's own account. */
  billed?: boolean;
  /** Rough one-off download in MB (local models only). */
  approxDownloadMB?: number;
  /** Approximate GPU/device memory in MB (local models only). */
  memoryMB?: number;
}

/** What a UI should offer for a provider right now. */
export type ProviderState =
  | 'ready'
  | 'needs_sign_in'
  | 'needs_consent'
  | 'unsupported'
  | 'unavailable';

export interface ProviderAvailability {
  ok: boolean;
  state: ProviderState;
  /** Short human-readable reason when `ok` is false (generic, never upstream text). */
  reason?: string;
  /** Download disclosure shown before an explicit consent action. */
  download?: { approxMB?: number; memoryMB?: number; cached?: boolean; note?: string };
}

export interface PrepareProgress {
  /** 0..1 */
  loaded: number;
  text?: string;
}

export interface PrepareOptions {
  model?: string;
  onProgress?: (progress: PrepareProgress) => void;
  signal?: AbortSignal;
}

/** Account connection of a provider that uses the visitor's own account. */
export interface ProviderAccount {
  connected(): boolean;
  /** Begin the sign-in (may navigate away from the page). */
  connect(): Promise<void>;
  disconnect(): void;
}

/** A model backend. `stream` must honour `request.signal`. */
export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /** Visible attribution text, shown by UIs and recorded with each turn. */
  readonly attribution?: string;
  /** `free`: no cost to the user. `user_account`: may bill the user's own account. */
  readonly billing: 'free' | 'user_account';
  /** Per-request limits the agent should respect for this backend. */
  readonly limits?: { maxToolOutputChars?: number };
  readonly account?: ProviderAccount;
  available(): Promise<ProviderAvailability>;
  models(): Promise<ModelInfo[]>;
  /** Explicit, user-initiated preparation (model download/load). Never called implicitly. */
  prepare?(options?: PrepareOptions): Promise<void>;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

/** Content of a tool result (MCP content item subset; unknown types pass through). */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: string; [key: string]: unknown };

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** MCP tool definition (subset used by the agent). */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface ToolCallContext {
  signal: AbortSignal;
}

/** Where tools come from. MCP is the shared model: local handlers and remote servers alike. */
export interface ToolSource {
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown, context: ToolCallContext): Promise<ToolResult>;
  close?(): Promise<void> | void;
}
