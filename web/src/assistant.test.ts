import { describe, expect, test } from 'bun:test';
import type { WireEvent } from '../index.js';
import { applyWireEvent, failTurn, messagesFromTurns, newTurn, servedOf, tokensOf } from './assistant.ts';

const wire = (sequence: number, event: WireEvent['event'], request = 'r1'): WireEvent =>
  ({ version: 1, conversation_id: 'c', request_id: request, sequence, event });
const update = (sequence: number, payload: Record<string, unknown> & { sessionUpdate: string }): WireEvent =>
  wire(sequence, { kind: 'update', update: payload });
const chunk = (sequence: number, kind: string, text: string): WireEvent =>
  update(sequence, { sessionUpdate: kind, content: { type: 'text', text } });

describe('applyWireEvent', () => {
  test('folds a streamed answer with attribution into a completed turn', () => {
    let turn = newTurn('r1', 'hello');
    for (const event of [
      chunk(1, 'user_message_chunk', 'hello'),
      chunk(2, 'agent_thought_chunk', 'thinking'),
      chunk(3, 'agent_message_chunk', 'Hi '),
      chunk(4, 'agent_message_chunk', 'there'),
      update(5, { sessionUpdate: 'session_info_update', _meta: { 'ccht/served': ['Pollinations · Model A'], 'ccht/token_usage': { totalTokens: 12 } } }),
      wire(6, { kind: 'completed', stop_reason: 'end_turn' }),
    ]) turn = applyWireEvent(turn, event);
    expect(turn.user_text).toBe('hello');
    expect(turn.thought_text).toBe('thinking');
    expect(turn.text).toBe('Hi there');
    expect(turn.status).toBe('completed');
    expect(servedOf(turn)).toEqual(['Pollinations · Model A']);
    expect(tokensOf(turn)).toBe(12);
  });

  test('tool calls start pending and merge their updates', () => {
    let turn = newTurn('r1', 'q');
    turn = applyWireEvent(turn, update(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Search', status: 'pending', rawInput: { a: 1 } }));
    turn = applyWireEvent(turn, update(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { ok: true } }));
    turn = applyWireEvent(turn, update(3, { sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'completed' }));
    expect(Object.keys(turn.tools)).toEqual(['t1']);
    expect(turn.tools.t1).toMatchObject({ title: 'Search', status: 'completed', rawInput: { a: 1 }, rawOutput: { ok: true } });
  });

  test('errors, cancellation and refusal map to terminal states; later events are ignored', () => {
    const failed = applyWireEvent(newTurn('r1', 'q'), wire(1, { kind: 'error', code: 'rate_limited', message: 'Try later.' }));
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'rate_limited', message: 'Try later.' });
    expect(applyWireEvent(failed, chunk(2, 'agent_message_chunk', 'late')).text).toBe('');
    expect(applyWireEvent(newTurn('r1', 'q'), wire(1, { kind: 'completed', stop_reason: 'cancelled' })).status).toBe('cancelled');
    expect(applyWireEvent(newTurn('r1', 'q'), wire(1, { kind: 'completed', stop_reason: 'refusal' })).status).toBe('refused');
  });

  test('events of another request are ignored', () => {
    const turn = newTurn('r1', 'q');
    expect(applyWireEvent(turn, wire(1, { kind: 'completed', stop_reason: 'end_turn' }, 'other'))).toBe(turn);
  });

  test('failTurn closes only open turns', () => {
    expect(failTurn(newTurn('r1', 'q'), 'provider_error', 'Failed.').status).toBe('failed');
    const done = applyWireEvent(newTurn('r1', 'q'), wire(1, { kind: 'completed', stop_reason: 'end_turn' }));
    expect(failTurn(done, 'provider_error', 'Failed.')).toBe(done);
  });
});

describe('messagesFromTurns', () => {
  test('emits a user and an assistant message per turn with attribution', () => {
    let turn = newTurn('r1', 'q');
    turn = applyWireEvent(turn, chunk(1, 'agent_message_chunk', 'a'));
    turn = applyWireEvent(turn, update(2, { sessionUpdate: 'session_info_update', _meta: { 'ccht/served': ['X · Y'] } }));
    const [user, assistant] = messagesFromTurns([turn]);
    expect(user).toMatchObject({ role: 'user', content: 'q' });
    expect(assistant).toMatchObject({ role: 'assistant', content: 'a', requestId: 'r1', served: ['X · Y'] });
    expect(assistant!.tokens).toBeUndefined();
  });
});
