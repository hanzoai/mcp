/**
 * Opt-In MCP Tool Bindings for RepoGraph Architectural Reasoning (HIP-1347, Issue #37).
 *
 * Exposes all six explicit architectural reasoning tools via `createRepoGraphTools()`:
 *   - `find_callers`
 *   - `find_implementations`
 *   - `trace_dependency`
 *   - `explain_change_impact`
 *   - `find_related_tests`
 *   - `find_regression_origin`
 * without mutating the default 7-tool HIP-0300 surface.
 */

import { Tool, ToolResult } from '../types/index.js';
import {
  GraphAccessPolicy,
  RepoGraphEngine,
  RepoGraphError,
  StackFrameRef,
} from './repograph.js';

export interface RepoGraphToolsOptions {
  engine?: RepoGraphEngine;
  defaultTenantId?: string;
  defaultRepoId?: string;
}

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errResult(err: unknown): ToolResult {
  if (err instanceof RepoGraphError) {
    return {
      content: [{ type: 'text', text: `[${err.code}] ${err.message}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Error: ${msg}` }],
    isError: true,
  };
}

function parseAccess(
  args: Record<string, unknown>,
  defaultTenantId: string,
  defaultRepoId: string
): GraphAccessPolicy {
  const tenantId = String(args.tenantId ?? defaultTenantId).trim();
  if (!tenantId) {
    throw new RepoGraphError('TENANT_ISOLATION_VIOLATION', 'tenantId is required');
  }
  return {
    tenantId,
    repoId: args.repoId !== undefined ? String(args.repoId) : defaultRepoId,
    callerRoles: Array.isArray(args.callerRoles) ? args.callerRoles.map(String) : undefined,
  };
}

export function createRepoGraphTools(options: RepoGraphToolsOptions = {}): Tool[] {
  const defaultTenantId = options.defaultTenantId ?? 'default';
  const defaultRepoId = options.defaultRepoId ?? 'workspace';
  const engine = options.engine ?? new RepoGraphEngine();

  const findCallersTool: Tool = {
    name: 'find_callers',
    description:
      'Find direct and transitive callers of a symbol or method with receiver-type disambiguation and runtime trace invocation counts.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol or OwnerType.method name' },
        ownerType: { type: 'string', description: 'Optional enclosing class/struct/interface/trait' },
        filePath: { type: 'string', description: 'Optional defining file path' },
        maxDepth: { type: 'number', description: 'Max transitive hop depth (default 3)' },
        includeTests: { type: 'boolean', description: 'Include test callers (default true)' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
      required: ['symbol'],
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        return ok(
          engine.findCallers(
            {
              symbol: String(args.symbol ?? ''),
              ownerType: args.ownerType !== undefined ? String(args.ownerType) : undefined,
              filePath: args.filePath !== undefined ? String(args.filePath) : undefined,
              maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
              includeTests: typeof args.includeTests === 'boolean' ? args.includeTests : undefined,
            },
            access
          )
        );
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const findImplementationsTool: Tool = {
    name: 'find_implementations',
    description:
      'Find concrete implementations of an interface, Go structural interface, Rust trait, Python base class, or polymorphic method.',
    inputSchema: {
      type: 'object',
      properties: {
        interfaceOrSymbol: { type: 'string', description: 'Interface/trait/base name or Interface.method' },
        methodName: { type: 'string', description: 'Optional specific method name' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
      required: ['interfaceOrSymbol'],
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        const implementations = engine.findImplementations(
          {
            interfaceOrSymbol: String(args.interfaceOrSymbol ?? ''),
            methodName: args.methodName !== undefined ? String(args.methodName) : undefined,
          },
          access
        );
        return ok({ count: implementations.length, implementations });
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const traceDependencyTool: Tool = {
    name: 'trace_dependency',
    description:
      'Trace directed dependency chains between symbols or files across static calls, interface dispatch, and runtime traces.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol or file path' },
        to: { type: 'string', description: 'Target symbol or file path' },
        maxDepth: { type: 'number', description: 'Max hops (default 5)' },
        maxPaths: { type: 'number', description: 'Max paths returned (default 3)' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
      required: ['from', 'to'],
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        return ok(
          engine.traceDependency(
            {
              from: String(args.from ?? ''),
              to: String(args.to ?? ''),
              maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
              maxPaths: typeof args.maxPaths === 'number' ? args.maxPaths : undefined,
            },
            access
          )
        );
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const explainChangeImpactTool: Tool = {
    name: 'explain_change_impact',
    description:
      'Predict what a change to symbols or files could break before running it by fusing static call/implementation edges, runtime traces, recent failures, and Git co-change history.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: 'Modified symbols' },
        files: { type: 'array', items: { type: 'string' }, description: 'Modified file paths' },
        maxDepth: { type: 'number', description: 'Max impact propagation hops (default 3)' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        return ok(
          engine.explainChangeImpact(
            {
              symbols: Array.isArray(args.symbols) ? args.symbols.map(String) : undefined,
              files: Array.isArray(args.files) ? args.files.map(String) : undefined,
              maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
            },
            access
          )
        );
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const findRelatedTestsTool: Tool = {
    name: 'find_related_tests',
    description:
      'Rank related unit and integration test suites using static reachability, runtime trace spans, failure stacks, and Git co-change coupling.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
        maxTests: { type: 'number', description: 'Max tests to return (default 10)' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        const tests = engine.findRelatedTests(
          {
            symbols: Array.isArray(args.symbols) ? args.symbols.map(String) : undefined,
            files: Array.isArray(args.files) ? args.files.map(String) : undefined,
            maxTests: typeof args.maxTests === 'number' ? args.maxTests : undefined,
          },
          access
        );
        return ok({ count: tests.length, tests });
      } catch (err) {
        return errResult(err);
      }
    },
  };

  const findRegressionOriginTool: Tool = {
    name: 'find_regression_origin',
    description:
      'Localize the root-cause commit, file, and symbol of a regression by combining failure stack slicing, runtime trace errors, and Git commit hunk blame.',
    inputSchema: {
      type: 'object',
      properties: {
        failureId: { type: 'string', description: 'Indexed failure event ID' },
        failingTestFile: { type: 'string', description: 'Failing test path' },
        stackFrames: {
          type: 'array',
          items: { type: 'object' },
          description: 'Inline stack frames [{filePath, symbolName, line}]',
        },
        maxCandidates: { type: 'number', description: 'Max ranked suspects (default 5)' },
        tenantId: { type: 'string' },
        repoId: { type: 'string' },
        callerRoles: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (args) => {
      try {
        const access = parseAccess(args, defaultTenantId, defaultRepoId);
        const stackFrames: StackFrameRef[] | undefined = Array.isArray(args.stackFrames)
          ? args.stackFrames.map((sf: any) => ({
              filePath: String(sf.filePath ?? ''),
              symbolName: String(sf.symbolName ?? ''),
              line: Number(sf.line ?? 1),
            }))
          : undefined;

        const candidates = engine.findRegressionOrigin(
          {
            failureId: args.failureId !== undefined ? String(args.failureId) : undefined,
            failingTestFile:
              args.failingTestFile !== undefined ? String(args.failingTestFile) : undefined,
            stackFrames,
            maxCandidates: typeof args.maxCandidates === 'number' ? args.maxCandidates : undefined,
          },
          access
        );
        return ok({ count: candidates.length, candidates });
      } catch (err) {
        return errResult(err);
      }
    },
  };

  return [
    findCallersTool,
    findImplementationsTool,
    traceDependencyTool,
    explainChangeImpactTool,
    findRelatedTestsTool,
    findRegressionOriginTool,
  ];
}
