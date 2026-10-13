import type { ToolResult } from '../agent/types.ts';

/** Marker appended when a tool output exceeds the configured limit. */
export const truncationMarker = '\n[output truncated]';

/** Cut `text` to at most `limit` characters, appending a marker when shortened. */
export function truncateText(text: string, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - truncationMarker.length)) + truncationMarker;
}

/** Flatten an MCP tool result into text for the model. Non-text content is named, not inlined. */
export function renderToolResult(result: ToolResult, limit = Number.POSITIVE_INFINITY): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && typeof (item.resource as { text?: unknown } | undefined)?.text === 'string') {
      parts.push((item.resource as { text: string }).text);
    } else parts.push(`[${item.type} content omitted]`);
  }
  let text = parts.join('\n');
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  return truncateText(text, limit);
}
