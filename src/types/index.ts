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

export interface ToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  }>;
  isError?: boolean;
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