/** "Ask your own assistant" door openers.
 *
 * Pure functions: they build URLs and snippets and perform no network access.
 * Prefill parameters are the ones the assistants themselves use, checked
 * 2026-10-13: ChatGPT `https://chatgpt.com/?q=` (community-documented, unofficial),
 * Perplexity `https://www.perplexity.ai/search/new?q=` (the site redirects the older
 * `/search?q=` form there), and Claude `https://claude.ai/new?q=` (reported broken
 * in October 2025 and not re-confirmed). No browser was available to test the
 * prefill end to end, so `prefill` is `'expected'` (documented or redirected by the
 * site) or `'unconfirmed'`; pair every door with a "copy prompt" button.
 */

export type AssistantId = 'chatgpt' | 'claude' | 'perplexity';

export interface AssistantTarget {
  id: AssistantId;
  label: string;
  /** Base URL; the prompt is appended as the `q` query parameter. */
  base: string;
  prefill: 'expected' | 'unconfirmed';
}

export const assistantTargets: readonly AssistantTarget[] = [
  { id: 'chatgpt', label: 'ChatGPT', base: 'https://chatgpt.com/', prefill: 'expected' },
  { id: 'claude', label: 'Claude', base: 'https://claude.ai/new', prefill: 'unconfirmed' },
  { id: 'perplexity', label: 'Perplexity', base: 'https://www.perplexity.ai/search/new', prefill: 'expected' },
];

export interface AssistantLink {
  id: AssistantId;
  label: string;
  url: string;
  prefill: AssistantTarget['prefill'];
  /** True when the prompt was shortened to fit `maxPromptChars`. */
  truncated: boolean;
}

export interface LinkOptions {
  /** Longest prompt placed in a URL (default 3000 characters; browsers and sites cap URLs). */
  maxPromptChars?: number;
}

/** Build the link for one assistant with `prompt` prefilled. */
export function assistantLink(id: AssistantId, prompt: string, options: LinkOptions = {}): AssistantLink {
  const target = assistantTargets.find((item) => item.id === id);
  if (!target) throw new RangeError(`Unknown assistant: ${id}`);
  const max = options.maxPromptChars ?? 3000;
  const truncated = prompt.length > max;
  const text = truncated ? `${prompt.slice(0, Math.max(0, max - 1))}…` : prompt;
  // encodeURIComponent keeps spaces as %20 for every consumer; URLSearchParams would use '+'.
  const url = `${target.base}${target.base.includes('?') ? '&' : '?'}q=${encodeURIComponent(text)}`;
  return { id, label: target.label, url, prefill: target.prefill, truncated };
}

export const assistantUrl = (id: AssistantId, prompt: string, options?: LinkOptions): string => assistantLink(id, prompt, options).url;

/** Links for several (default: all) assistants. */
export function assistantLinks(prompt: string, ids: AssistantId[] = assistantTargets.map((item) => item.id), options?: LinkOptions): AssistantLink[] {
  return ids.map((id) => assistantLink(id, prompt, options));
}

export interface McpConnector {
  name: string;
  /** The remote MCP endpoint to paste into an assistant's "add connector" dialog. */
  url: string;
  /** Claude Code command. */
  command: string;
  /** Generic `mcpServers` JSON accepted by many clients (Claude Code `.mcp.json`, Cursor, ...). */
  json: string;
  /** Short plain-English instruction. */
  instructions: string;
}

/** Format a remote MCP server for users who add it to their own assistant. */
export function mcpConnector(endpoint: string, name = 'data'): McpConnector {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new TypeError('Use an HTTPS MCP endpoint without credentials or a fragment.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new TypeError('The connector name may use letters, digits, - and _ only.');
  return {
    name,
    url: url.href,
    command: `claude mcp add --transport http ${name} ${url.href}`,
    json: JSON.stringify({ mcpServers: { [name]: { type: 'http', url: url.href } } }, null, 2),
    instructions: `In your assistant, add a custom connector or remote MCP server and paste ${url.href}`,
  };
}
