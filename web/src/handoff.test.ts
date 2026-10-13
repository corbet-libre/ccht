import { describe, expect, test } from 'bun:test';
import { assistantLink, assistantLinks, assistantUrl, mcpConnector } from './handoff.ts';

describe('assistant door openers', () => {
  const prompt = 'Compare A & B? 100% ünïcode "quotes" #1\nnext line';

  test('each target gets the prompt percent-encoded in q and round-trips exactly', () => {
    for (const [id, base] of [['chatgpt', 'https://chatgpt.com/'], ['claude', 'https://claude.ai/new'], ['perplexity', 'https://www.perplexity.ai/search/new']] as const) {
      const url = assistantUrl(id, prompt);
      expect(url.startsWith(`${base}?q=`)).toBe(true);
      expect(url).not.toContain(' ');
      expect(url).not.toContain('+');
      expect(new URL(url).searchParams.get('q')).toBe(prompt);
    }
  });

  test('links carry label, prefill status and truncation', () => {
    const [chatgpt, claude, perplexity] = assistantLinks('hi');
    expect(chatgpt).toMatchObject({ id: 'chatgpt', label: 'ChatGPT', prefill: 'expected', truncated: false });
    expect(claude).toMatchObject({ id: 'claude', prefill: 'unconfirmed' });
    expect(perplexity!.id).toBe('perplexity');
    const long = assistantLink('claude', 'x'.repeat(5000), { maxPromptChars: 100 });
    expect(long.truncated).toBe(true);
    expect(new URL(long.url).searchParams.get('q')!.length).toBe(100);
    expect(assistantLinks('hi', ['claude']).map((l) => l.id)).toEqual(['claude']);
    expect(() => assistantLink('nobody' as never, 'x')).toThrow(RangeError);
  });
});

describe('mcp connector snippet', () => {
  test('formats the URL, CLI command and JSON config', () => {
    const connector = mcpConnector('https://example.com/mcp', 'catalogue');
    expect(connector.url).toBe('https://example.com/mcp');
    expect(connector.command).toBe('claude mcp add --transport http catalogue https://example.com/mcp');
    expect(JSON.parse(connector.json)).toEqual({ mcpServers: { catalogue: { type: 'http', url: 'https://example.com/mcp' } } });
    expect(connector.instructions).toContain('https://example.com/mcp');
  });

  test('refuses insecure endpoints, credentials and unsafe names', () => {
    expect(() => mcpConnector('http://example.com/mcp')).toThrow(TypeError);
    expect(() => mcpConnector('https://u:p@example.com/mcp')).toThrow(TypeError);
    expect(() => mcpConnector('https://example.com/mcp', 'bad name; rm -rf')).toThrow(TypeError);
    expect(mcpConnector('http://localhost:8787/mcp').url).toBe('http://localhost:8787/mcp');
  });
});
