/**
 * Core types for Hanzo MCP
 */

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<ToolResult>;
}

/**
 * The tools that read, decide or hand work to Hanzo's models and indexes, and change nothing on
 * this machine, listed with `readOnlyHint`. A client that asks before any tool that may write calls
 * these without asking: Codex, Hanzo Dev and Open Interpreter refuse every unannotated call in a
 * run that never asks. `llm`'s one write is the rating its `feedback` gives an answer it returned.
 */
export const READ_ONLY = new Set([
  'kai_decide', 'kai_choice', 'kai_score', 'kai_noul', 'kai_agent_step', 'kai_tool_select',
  'kai_next_action', 'kai_command_guard', 'kai_injection_screen', 'kai_extract', 'kai_log_triage',
  'kai_recover', 'kai_compact', 'llm', 'think', 'code_search', 'code_context', 'code_ask',
]);

/** A tool as MCP lists it: its name, description and schema, and whether it only reads. */
export function listed(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(READ_ONLY.has(tool.name) ? { annotations: { readOnlyHint: true, openWorldHint: true } } : {}),
  };
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  version: string;
  tools?: Tool[];
  systemPrompt?: string;
  projectPath?: string;
  permissions?: {
    allowedPaths?: string[];
    deniedPaths?: string[];
    allowCommands?: boolean;
    allowNetwork?: boolean;
  };
}

export interface SearchResult {
  file: string;
  line?: number;
  column?: number;
  match: string;
  context?: string;
}

export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  lastModified: Date;
  permissions?: string;
}