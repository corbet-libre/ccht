import { describe, expect, test } from 'bun:test';
import { createBrowserAgent } from './agent.ts';
import { ProviderError, ToolError, errorMessages } from './errors.ts';
import { historyFromTurns, toolDataNotice } from './prompt.ts';
import { localTools } from '../tools/local.ts';
import { collect, finish, scripted, updates } from '../testing.ts';

const weather = localTools([{
  name: 'get_weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  annotations: { readOnlyHint: true },
  handler: (args) => ({ city: (args as { city: string }).city, temperature: 21 }),
}]);

const call = (id: string, name: string, args: unknown = {}) => ({ type: 'tool_call' as const, call: { id, name, arguments: args } });
const turn = (agent: ReturnType<typeof createBrowserAgent>, text = 'hi', extra = {}) =>
  collect(agent.turn({ conversationId: 'c1', text, requestId: 'r1', ...extra }));

describe('event stream', () => {
  test('a text turn yields contiguous ACP events and one terminal event', async () => {
    const provider = scripted([[{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, finish()]]);
    const events = await turn(createBrowserAgent({ provider }));
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.version === 1 && e.conversation_id === 'c1' && e.request_id === 'r1')).toBe(true);
    const kinds = updates(events).map((u) => u.sessionUpdate);
    expect(kinds).toEqual(['user_message_chunk', 'agent_message_chunk', 'agent_message_chunk', 'session_info_update']);
    expect(updates(events)[3]!._meta).toEqual({ 'ccht/served': ['Fixture · Model One'], 'ccht/token_usage': { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
    expect(events.filter((e) => e.event.kind !== 'update')).toHaveLength(1);
  });

  test('reasoning becomes agent_thought_chunk and finish reasons map to ACP stop reasons', async () => {
    const reasoning = scripted([[{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'a' }, finish('length')]]);
    const events = await turn(createBrowserAgent({ provider: reasoning }));
    expect(updates(events).map((u) => u.sessionUpdate)).toContain('agent_thought_chunk');
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'max_tokens' });
    const refused = await turn(createBrowserAgent({ provider: scripted([[finish('content_filter')]]) }));
    expect(refused.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'refusal' });
  });

  test('history and the data-not-instructions notice reach the provider', async () => {
    const provider = scripted([[{ type: 'text', text: 'ok' }, finish()]]);
    await turn(createBrowserAgent({ provider, tools: weather, system: 'Be brief.' }), 'again', {
      history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }], context: 'view=home',
    });
    const messages = provider.requests[0]!.messages;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('Be brief.');
    expect(messages[0]!.content).toContain(toolDataNotice);
    expect(messages[0]!.content).toContain('view=home');
    expect(messages.slice(1).map((m) => m.content)).toEqual(['first', 'reply', 'again']);
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(['get_weather']);
  });

  test('historyFromTurns keeps completed turns only', () => {
    expect(historyFromTurns([
      { status: 'completed', user_text: 'q1', text: 'a1' },
      { status: 'failed', user_text: 'q2', text: '' },
      { status: 'cancelled', user_text: 'q3', text: 'partial' },
    ])).toEqual([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  });
});

describe('tool loop', () => {
  test('tool calls run pending, in progress, completed with raw input and output', async () => {
    const provider = scripted([
      [{ type: 'text', text: 'Checking. ' }, call('t1', 'get_weather', { city: 'Zurich' }), finish('tool_calls')],
      [{ type: 'text', text: '21 degrees.' }, finish()],
    ]);
    const events = await turn(createBrowserAgent({ provider, tools: weather }));
    const tool = updates(events).filter((u) => u.toolCallId === 't1');
    expect(tool.map((u) => [u.sessionUpdate, u.status])).toEqual([
      ['tool_call', 'pending'], ['tool_call_update', 'in_progress'], ['tool_call_update', 'completed'],
    ]);
    expect(tool[0]).toMatchObject({ title: 'get_weather', kind: 'read', rawInput: { city: 'Zurich' } });
    expect(tool[2]!.rawOutput).toMatchObject({ structuredContent: { city: 'Zurich', temperature: 21 } });
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
    const second = provider.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 't1', name: 'get_weather' }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 't1', name: 'get_weather' });
    expect(second.at(-1)!.content).toContain('"temperature":21');
  });

  test('tool failures become failed updates the model can read; the turn continues', async () => {
    const tools = localTools([
      { name: 'boom', description: 'x', inputSchema: { type: 'object' }, handler: () => { throw new Error('secret internals'); } },
      { name: 'picky', description: 'x', inputSchema: { type: 'object' }, handler: () => { throw new ToolError('city is required'); } },
    ]);
    const provider = scripted([
      [call('a', 'boom'), call('b', 'picky'), call('c', 'missing'), { type: 'tool_call', call: { id: 'd', name: 'boom', arguments: {}, invalidArguments: true } }, finish('tool_calls')],
      [{ type: 'text', text: 'Sorry.' }, finish()],
    ]);
    const events = await turn(createBrowserAgent({ provider, tools }));
    const done = updates(events).filter((u) => u.sessionUpdate === 'tool_call_update' && u.status !== 'in_progress');
    expect(done.map((u) => u.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    const texts = provider.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(texts).toEqual(['The tool failed.', 'city is required', 'Unknown tool.', 'The tool arguments were not valid JSON.']);
    expect(JSON.stringify(events)).not.toContain('secret internals');
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
  });

  test('the last allowed step is offered no tools so the model must answer', async () => {
    const provider = scripted([[call('x', 'get_weather', { city: 'A' }), finish('tool_calls')], [call('y', 'get_weather', { city: 'B' }), finish('tool_calls')], [{ type: 'text', text: 'done' }, finish()]]);
    const events = await turn(createBrowserAgent({ provider, tools: weather, maxSteps: 3 }));
    expect(provider.requests.map((r) => r.tools.length)).toEqual([1, 1, 0]);
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
  });

  test('a model that keeps calling tools without any offered ends with max_turn_requests', async () => {
    const provider = scripted([[call('x', 'get_weather', { city: 'A' }), finish('tool_calls')]]);
    const events = await turn(createBrowserAgent({ provider, tools: weather, maxSteps: 2 }));
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'max_turn_requests' });
  });

  test('duplicate provider call ids stay unique across the turn', async () => {
    const provider = scripted([[call('call_0', 'get_weather', { city: 'A' }), finish('tool_calls')], [call('call_0', 'get_weather', { city: 'B' }), finish('tool_calls')], [finish()]]);
    const events = await turn(createBrowserAgent({ provider, tools: weather }));
    const ids = new Set(updates(events).filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.toolCallId));
    expect(ids.size).toBe(2);
  });

  test('oversized tool output is truncated in the model message and the event', async () => {
    const big = localTools([{ name: 'big', description: 'x', inputSchema: { type: 'object' }, handler: () => 'x'.repeat(5000) }]);
    const provider = scripted([[call('t', 'big'), finish('tool_calls')], [finish()]]);
    const events = await turn(createBrowserAgent({ provider, tools: big, maxToolOutputChars: 100 }));
    expect(provider.requests[1]!.messages.at(-1)!.content.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(events).length).toBeLessThan(2000);
  });

  test('an unreachable tool source ends the turn with tools_unavailable', async () => {
    const provider = scripted([[finish()]]);
    const broken = { listTools: async () => { throw new Error('x'); }, callTool: async () => ({ content: [] }) };
    const events = await turn(createBrowserAgent({ provider, tools: broken }));
    expect(events.at(-1)!.event).toEqual({ kind: 'error', code: 'tools_unavailable', message: errorMessages.tools_unavailable });
    expect(provider.requests).toHaveLength(0);
  });
});

describe('cancel', () => {
  test('already aborted: completed cancelled after the user message', async () => {
    const provider = scripted([[finish()]]);
    const controller = new AbortController();
    controller.abort();
    const events = await turn(createBrowserAgent({ provider }), 'hi', { signal: controller.signal });
    expect(events.map((e) => e.event.kind)).toEqual(['update', 'completed']);
    expect(events[1]!.event).toEqual({ kind: 'completed', stop_reason: 'cancelled' });
    expect(provider.requests).toHaveLength(0);
  });

  test('abort while the model streams', async () => {
    const provider = scripted([[{ type: 'text', text: 'partial' }, 'hang']]);
    const controller = new AbortController();
    const agent = createBrowserAgent({ provider });
    const events: Awaited<ReturnType<typeof turn>> = [];
    for await (const wire of agent.turn({ conversationId: 'c1', text: 'go', requestId: 'r', signal: controller.signal })) {
      events.push(wire);
      if (updates([wire])[0]?.sessionUpdate === 'agent_message_chunk') controller.abort();
    }
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'cancelled' });
    expect(events.filter((e) => e.event.kind !== 'update')).toHaveLength(1);
  });

  test('abort during a tool call fails the call and completes cancelled, even if the handler ignores the signal', async () => {
    const controller = new AbortController();
    const slow = localTools([{ name: 'slow', description: 'x', inputSchema: { type: 'object' }, handler: () => new Promise(() => {}) }]);
    const provider = scripted([[call('t', 'slow'), finish('tool_calls')], [finish()]]);
    const agent = createBrowserAgent({ provider, tools: slow });
    const events: Awaited<ReturnType<typeof turn>> = [];
    for await (const wire of agent.turn({ conversationId: 'c1', text: 'go', requestId: 'r', signal: controller.signal })) {
      events.push(wire);
      if (updates([wire])[0]?.status === 'in_progress') controller.abort();
    }
    const last = updates(events).filter((u) => u.toolCallId === 't').at(-1)!;
    expect(last.status).toBe('failed');
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'cancelled' });
    expect(provider.requests).toHaveLength(1);
  });

  test('a tool that exceeds its timeout fails without ending the turn', async () => {
    const slow = localTools([{ name: 'slow', description: 'x', inputSchema: { type: 'object' }, handler: () => new Promise(() => {}) }]);
    const provider = scripted([[call('t', 'slow'), finish('tool_calls')], [{ type: 'text', text: 'ok' }, finish()]]);
    const events = await turn(createBrowserAgent({ provider, tools: slow, toolTimeoutMs: 20 }));
    expect(provider.requests[1]!.messages.at(-1)!.content).toBe('The tool timed out.');
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
  });
});

describe('provider errors', () => {
  test('stable code with a fixed message; upstream text never leaks', async () => {
    const leaky = scripted([[new Error('upstream said: sk-secret-token and <html>')]]);
    const events = await turn(createBrowserAgent({ provider: leaky }));
    expect(events.at(-1)!.event).toEqual({ kind: 'error', code: 'provider_error', message: errorMessages.provider_error });
    expect(JSON.stringify(events)).not.toContain('sk-secret');
    const limited = scripted([[new ProviderError('rate_limited', 429)]]);
    const failed = await turn(createBrowserAgent({ provider: limited }));
    expect(failed.at(-1)!.event).toEqual({ kind: 'error', code: 'rate_limited', message: errorMessages.rate_limited });
  });

  test('a stream that ends without finishing is incomplete_stream and is not retried', async () => {
    const provider = scripted([[{ type: 'text', text: 'half' }]]);
    const events = await turn(createBrowserAgent({ provider }));
    expect(events.at(-1)!.event).toMatchObject({ kind: 'error', code: 'incomplete_stream' });
    expect(provider.requests).toHaveLength(1);
  });

  test('a provider that throws synchronously is handled', async () => {
    const provider = scripted([[finish()]], { stream: () => { throw new ProviderError('auth_required', 401); } });
    const events = await turn(createBrowserAgent({ provider }));
    expect(events.at(-1)!.event).toMatchObject({ kind: 'error', code: 'auth_required' });
  });

  test('no model available is a configuration error', async () => {
    const provider = scripted([[finish()]], { models: async () => [] });
    expect((await turn(createBrowserAgent({ provider }))).at(-1)!.event).toMatchObject({ kind: 'error', code: 'configuration_error' });
  });
});

describe('fallback', () => {
  const failing = () => scripted([[new ProviderError('rate_limited', 429)]]);

  test('never switches providers unless a fallback list is configured', async () => {
    const other = scripted([[{ type: 'text', text: 'x' }, finish()]]);
    const events = await turn(createBrowserAgent({ provider: failing() }));
    expect(events.at(-1)!.event).toMatchObject({ kind: 'error', code: 'rate_limited' });
    expect(other.requests).toHaveLength(0);
  });

  test('uses the explicit ordered free fallback, attributing the answering provider', async () => {
    const second = scripted([[new ProviderError('provider_unavailable', 503)]], { id: 'two' });
    const third = scripted([[{ type: 'text', text: 'saved' }, finish()]], { id: 'three', attribution: 'Third' });
    const events = await turn(createBrowserAgent({ provider: failing(), fallback: [second, third] }));
    expect(events.at(-1)!.event).toEqual({ kind: 'completed', stop_reason: 'end_turn' });
    expect(updates(events).at(-1)!._meta).toMatchObject({ 'ccht/served': ['Third · Model One'] });
    expect(second.requests).toHaveLength(1);
  });

  test('does not fall back after output was produced, nor for non-retryable errors', async () => {
    const spare = scripted([[{ type: 'text', text: 'x' }, finish()]]);
    const partial = scripted([[{ type: 'text', text: 'half' }, new ProviderError('network_error')]]);
    expect((await turn(createBrowserAgent({ provider: partial, fallback: [spare] }))).at(-1)!.event).toMatchObject({ kind: 'error', code: 'network_error' });
    const unauthorised = scripted([[new ProviderError('auth_required', 401)]]);
    expect((await turn(createBrowserAgent({ provider: unauthorised, fallback: [spare] }))).at(-1)!.event).toMatchObject({ kind: 'error', code: 'auth_required' });
    expect(spare.requests).toHaveLength(0);
  });

  test('fallback providers must be free', () => {
    const paid = scripted([[finish()]], { billing: 'user_account', id: 'paid' });
    expect(() => createBrowserAgent({ provider: failing(), fallback: [paid] })).toThrow(TypeError);
  });

  test('a fallback that turns billable at run time is skipped', async () => {
    const flip = scripted([[{ type: 'text', text: 'x' }, finish()]]);
    let billing: 'free' | 'user_account' = 'free';
    Object.defineProperty(flip, 'billing', { get: () => billing });
    const agent = createBrowserAgent({ provider: failing(), fallback: [flip] });
    billing = 'user_account';
    expect((await turn(agent)).at(-1)!.event).toMatchObject({ kind: 'error', code: 'rate_limited' });
    expect(flip.requests).toHaveLength(0);
  });
});

describe('shared event model', () => {
  // The same file is applied by the Rust reducer (src/conversation.rs tests), so the
  // browser agent's events are proven valid for the shared Wasm model.
  test('a tool turn matches the golden wire fixture', async () => {
    const provider = scripted([
      [{ type: 'reasoning', text: 'Need the weather.' }, { type: 'text', text: 'Checking. ' }, call('t1', 'get_weather', { city: 'Zurich' }), finish('tool_calls')],
      [{ type: 'text', text: 'It is 21 degrees.' }, finish()],
    ]);
    const events = await collect(createBrowserAgent({ provider, tools: weather }).turn({ conversationId: 'golden', requestId: 'req-1', text: 'Weather in Zurich?' }));
    const path = new URL('../../../src/fixtures/browser_agent_tool_turn.json', import.meta.url);
    const text = `${JSON.stringify(events, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES) await Bun.write(path, text);
    expect(JSON.parse(await Bun.file(path).text())).toEqual(JSON.parse(text));
  });
});

describe('shared event model (error)', () => {
  test('a rate-limited turn matches the golden wire fixture', async () => {
    const provider = scripted([[new ProviderError('rate_limited', 429)]]);
    const events = await collect(createBrowserAgent({ provider }).turn({ conversationId: 'golden', requestId: 'req-2', text: 'Hello' }));
    const path = new URL('../../../src/fixtures/browser_agent_rate_limited.json', import.meta.url);
    const text = `${JSON.stringify(events, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES) await Bun.write(path, text);
    expect(JSON.parse(await Bun.file(path).text())).toEqual(JSON.parse(text));
  });
});
