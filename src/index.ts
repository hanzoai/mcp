/**
 * @hanzo/mcp - Model Context Protocol Server
 * 
 * A comprehensive MCP implementation with 20+ built-in tools for:
 * - File operations (read, write, edit, search)
 * - Shell execution (bash, background processes)
 * - Code intelligence (grep, AST-aware search)
 * - Project management (git, directory trees)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Export types
export * from './types/index.js';

// Export tools
export * from './tools/index.js';

// Export UI tools
export * from './ui/index.js';

// Export prompts
export { getSystemPrompt } from './prompts/system.js';

// Export security guards & risky-tool simulator (HIP-1347)
export * from './security/index.js';

// Export SWE-agent ACI compact interface (HIP-1347)
export * from './aci/index.js';

// Export symbol-graph dynamic repository map (HIP-1347)
export * from './repomap/index.js';

// Export RepoGraph architectural reasoning & change-impact tools (HIP-1347)
export * from './repograph/index.js';

// Export AST-aware semantic change planner & incremental test selector (HIP-1347)
// Namespaced + explicit non-colliding re-exports to avoid SymbolKind / normalizeRepoPath collisions with repomap.
export * as semanticEdit from './semantic-edit/index.js';
export {
  SemanticPlannerError,
  DerivedSemanticIndex,
  SemanticChangePlanner,
  createCanonicalBlobRecord,
  checkBlobAccess,
  inferLanguage,
  inferPackageName,
  inferIsTestFile,
  tokenizeCodeLexical,
  validateStructuralSyntax,
  renderAstReplacement,
  findStructuralMatchesInBlob,
  applyRulesToBlob,
  buildDerivedFileEntry,
  computeSemanticDiff,
  selectIncrementalTests,
  createSemanticEditTools,
  evaluateSemanticEditBenchmark,
  normalizeRepoPath as normalizeSemanticRepoPath,
  sha256Hex as semanticSha256Hex,
} from './semantic-edit/index.js';
export type {
  SupportedAstLanguage,
  SemanticErrorCode,
  TenantAccessContext,
  SourceBlobInput,
  CanonicalBlobRecord,
  AstLexToken,
  StructuralValidationResult,
  MetavarConstraintKind,
  AstRewriteRule,
  StructuralMatch,
  ConstrainedFileEdit,
  SymbolParameterSpec,
  SymbolKind as SemanticSymbolKind,
  ExtractedSymbol,
  ExtractedCallSite,
  ExtractedImport,
  DerivedFileEntry,
  SemanticChangeKind,
  SemanticSymbolDelta,
  IncompatibleCrossPackageChange,
  SemanticDiffReport,
  TestSelectionTier,
  IncrementalTestSelection,
  ExternalVerificationOutcome,
  VerificationRunner,
  SemanticChangePlanResult,
  PlannerThresholds,
  LexScanOutput,
  SemanticEditToolsOptions,
  BenchmarkStrategyName,
  TaskCaseEvaluation,
  StrategyAggregateSummary,
  NegativeControlSummary,
  SemanticEditBenchmarkReport,
} from './semantic-edit/index.js';

// Import Tool type and tool configuration for use in function signatures
import { Tool, listed } from './types/index.js';
import { ToolConfig } from './tools/index.js';

// Main server factory
export async function createMCPServer(config?: {
  name?: string;
  version?: string;
  projectPath?: string;
  customTools?: Tool[];
  toolConfig?: ToolConfig;
}) {
  const { 
    name = 'hanzo-mcp',
    version = '1.0.0',
    projectPath = process.cwd(),
    customTools = [],
    toolConfig = { enableCore: true, enableUI: false }
  } = config || {};
  
  // Import tools
  const { getConfiguredTools, legacyToolAliasMap } = await import('./tools/index.js');
  
  // Get configured tools based on toolConfig
  const configuredTools = getConfiguredTools({
    ...toolConfig,
    customTools: [...(toolConfig.customTools || []), ...customTools]
  });
  
  const combinedToolMap = new Map(configuredTools.map(t => [t.name, t]));
  const disabledSet = new Set(toolConfig.disabledTools || []);
  const allowLegacyCallAliases = !toolConfig.coreOnly && !toolConfig.betaSafe;
  
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );
  
  // ── MCP method handlers (shared between MCP + ZAP for full parity) ────

  const listToolsHandler = async () => ({
    tools: configuredTools.map(listed),
  });

  const callToolHandler = async (params: { name: string; arguments?: Record<string, unknown> }) => {
    const tool =
      combinedToolMap.get(params.name) ||
      (allowLegacyCallAliases && !disabledSet.has(params.name) ? legacyToolAliasMap.get(params.name) : undefined);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${params.name}` }],
        isError: true,
      };
    }
    try {
      return await tool.handler(params.arguments || {});
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error executing ${tool.name}: ${error.message}` }],
        isError: true,
      };
    }
  };

  const listResourcesHandler = async () => ({
    resources: [{
      uri: 'hanzo://system-prompt',
      name: 'System Prompt',
      mimeType: 'text/plain',
      description: 'Hanzo MCP system prompt and context',
    }],
  });

  const readResourceHandler = async (params: { uri: string }) => {
    if (params.uri === 'hanzo://system-prompt') {
      const { getSystemPrompt: getSysPrompt } = await import('./prompts/system.js');
      const systemPrompt = await getSysPrompt(projectPath);
      return {
        contents: [{ uri: params.uri, mimeType: 'text/plain', text: systemPrompt }],
      };
    }
    return {
      contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'Resource not found' }],
    };
  };

  // Register with MCP server
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, async (request) => callToolHandler(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, listResourcesHandler);
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResourceHandler(request.params));
  
  return {
    server,
    tools: configuredTools,
    
    async callTool(toolName: string, args: Record<string, unknown> = {}) {
      return callToolHandler({ name: toolName, arguments: args });
    },

    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error(`${name} MCP server started with ${configuredTools.length} tools`);
    },
    
    addTool(tool: Tool) {
      configuredTools.push(tool);
      combinedToolMap.set(tool.name, tool);
    },
    
    removeTool(name: string) {
      const index = configuredTools.findIndex(t => t.name === name);
      if (index >= 0) {
        configuredTools.splice(index, 1);
        combinedToolMap.delete(name);
      }
    }
  };
}