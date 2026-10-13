/** Framework-free helpers behind `AssistantPanel.svelte`.
 *
 * A tiny reducer that folds the browser agent's wire events into a `TurnState`
 * (the same shape the shared Wasm model produces), so the panel can render the
 * default `ChatDock` activity view without loading Wasm. Applications that keep
 * a full `ConversationModel` simply feed the same events to it through the
 * panel's `onEvent` callback.
 *
 * No DOM access, no network, no storage.
 */
import type { TurnState, WireEvent } from '../index.js';

/** One renderable message; structurally a `ChatDockMessage` plus attribution. */
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  requestId?: string;
  activity?: TurnState;
  /** "<provider> · <model>" labels of the backends that produced this answer. */
  served?: string[];
  /** Total tokens reported for the answer, when the provider reported them. */
  tokens?: number;
}

/** A fresh turn that already holds the user's prompt and is streaming. */
export function newTurn(requestId: string, userText: string): TurnState {
  return {
    request_id: requestId,
    last_sequence: 0,
    text: '',
    user_text: userText,
    user_content: [],
    thought_text: '',
    thought_content: [],
    content: [],
    tools: {},
    permissions: [],
    updates: {},
    status: 'streaming',
    stop_reason: null,
    error: null,
  };
}

const textOf = (update: Record<string, unknown>): string => {
  const content = update.content as { type?: unknown; text?: unknown } | undefined;
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
};

const terminal = (turn: TurnState): boolean => !['streaming', 'awaiting_permission'].includes(turn.status);

/** Pure fold of one wire event into a turn. Events after a terminal event are ignored. */
export function applyWireEvent(turn: TurnState, wire: WireEvent): TurnState {
  if (terminal(turn) || wire.request_id !== turn.request_id) return turn;
  const next: TurnState = { ...turn, last_sequence: wire.sequence };
  const event = wire.event;
  if (event.kind === 'completed') {
    next.stop_reason = event.stop_reason;
    next.status = event.stop_reason === 'cancelled' ? 'cancelled' : event.stop_reason === 'refusal' ? 'refused' : 'completed';
    return next;
  }
  if (event.kind === 'error') {
    next.status = 'failed';
    next.error = { code: event.code, message: event.message };
    return next;
  }
  if (event.kind === 'permission') {
    next.permissions = [...turn.permissions, { request_id: event.request_id, request: event.request }];
    next.status = 'awaiting_permission';
    return next;
  }
  const update = event.update as Record<string, unknown> & { sessionUpdate: string };
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const text = textOf(update);
      // `newTurn` already holds the prompt; the agent's first chunk repeats it.
      if (!(turn.last_sequence === 0 && text === turn.user_text)) next.user_text = turn.user_text + text;
      break;
    }
    case 'agent_message_chunk':
      next.text = turn.text + textOf(update);
      break;
    case 'agent_thought_chunk':
      next.thought_text = turn.thought_text + textOf(update);
      break;
    case 'tool_call': {
      const id = String(update.toolCallId ?? '');
      next.tools = { ...turn.tools, [id]: { ...turn.tools[id], ...update, toolCallId: id } as TurnState['tools'][string] };
      break;
    }
    case 'tool_call_update': {
      const id = String(update.toolCallId ?? '');
      const known = turn.tools[id];
      if (known) next.tools = { ...turn.tools, [id]: { ...known, ...update, toolCallId: id } as TurnState['tools'][string] };
      break;
    }
    default:
      next.updates = { ...turn.updates, [update.sessionUpdate]: update };
  }
  return next;
}

/** End a turn that stopped producing events without a terminal one. */
export function failTurn(turn: TurnState, code: string, message: string): TurnState {
  return terminal(turn) ? turn : { ...turn, status: 'failed', error: { code, message } };
}

const meta = (turn: TurnState): Record<string, unknown> | undefined =>
  (turn.updates.session_info_update as { _meta?: Record<string, unknown> } | undefined)?._meta;

/** "<provider> · <model>" labels reported with the answer (`ccht/served`). */
export function servedOf(turn: TurnState): string[] {
  const served = meta(turn)?.['ccht/served'];
  return Array.isArray(served) ? served.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/** Total tokens reported with the answer, if any. */
export function tokensOf(turn: TurnState): number | undefined {
  const total = (meta(turn)?.['ccht/token_usage'] as { totalTokens?: unknown } | undefined)?.totalTokens;
  return typeof total === 'number' ? total : undefined;
}

/** User and assistant messages for a list of turns. */
export function messagesFromTurns(turns: TurnState[]): AssistantMessage[] {
  return turns.flatMap((turn): AssistantMessage[] => {
    const served = servedOf(turn);
    const tokens = tokensOf(turn);
    return [
      { id: `${turn.request_id}:user`, role: 'user', content: turn.user_text },
      {
        id: `${turn.request_id}:assistant`,
        role: 'assistant',
        content: turn.text,
        requestId: turn.request_id,
        activity: turn,
        ...(served.length ? { served } : {}),
        ...(tokens === undefined ? {} : { tokens }),
      },
    ];
  });
}
