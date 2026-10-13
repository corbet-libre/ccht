import { ToolError } from '../agent/errors.ts';
import type { McpToolDefinition, ToolCallContext, ToolResult, ToolSource } from '../agent/types.ts';

const namePattern = /^[A-Za-z0-9_.-]{1,128}$/;

/** An in-page tool in the MCP tool shape. */
export interface LocalTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolDefinition['annotations'];
  /** Return a string, any JSON value, or a full MCP result (`{ content: [...] }`).
   * Throw `ToolError` for a failure whose message the model may see; any other
   * exception becomes a generic failure. */
  handler: (args: unknown, context: ToolCallContext) => unknown | Promise<unknown>;
}

function isResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

function toResult(value: unknown): ToolResult {
  if (isResult(value)) return value;
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  const json = JSON.stringify(value ?? null);
  return { content: [{ type: 'text', text: json }], structuredContent: value ?? null };
}

/** Build a tool source from in-page handlers. Tool outputs are data, never instructions. */
export function localTools(tools: LocalTool[]): ToolSource {
  const byName = new Map<string, LocalTool>();
  for (const tool of tools) {
    if (!namePattern.test(tool.name)) throw new TypeError(`Invalid tool name: ${tool.name}`);
    if (byName.has(tool.name)) throw new TypeError(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return {
    async listTools() {
      return [...byName.values()].map(({ name, title, description, inputSchema, annotations }) => ({
        name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}),
      }));
    },
    async callTool(name, args, context) {
      const tool = byName.get(name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
      try {
        return toResult(await tool.handler(args, context));
      } catch (error) {
        if (context.signal.aborted) throw error;
        const message = error instanceof ToolError ? error.message : 'The tool failed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  };
}

/** Combine several sources into one; duplicate tool names are a programming error. */
export function mergeTools(...sources: ToolSource[]): ToolSource {
  if (sources.length === 1) return sources[0]!;
  let routes = new Map<string, ToolSource>();
  const list = async (signal?: AbortSignal): Promise<McpToolDefinition[]> => {
    const next = new Map<string, ToolSource>();
    const all: McpToolDefinition[] = [];
    for (const source of sources) {
      for (const tool of await source.listTools(signal)) {
        if (next.has(tool.name)) throw new TypeError(`Duplicate tool name across sources: ${tool.name}`);
        next.set(tool.name, source);
        all.push(tool);
      }
    }
    routes = next;
    return all;
  };
  return {
    listTools: list,
    async callTool(name, args, context) {
      if (!routes.size) await list(context.signal);
      const source = routes.get(name);
      if (!source) return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
      return source.callTool(name, args, context);
    },
    async close() {
      await Promise.all(sources.map((source) => source.close?.()));
    },
  };
}
