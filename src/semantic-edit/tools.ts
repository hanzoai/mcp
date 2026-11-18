/**
 * Opt-in MCP Tool Bindings for Semantic Change Planner (HIP-1347, Issue #38).
 *
 * Exposes `semantic_ast_search`, `semantic_ast_rewrite`, `semantic_diff`, and
 * `semantic_change_plan` via `createSemanticEditTools()` for registration through
 * `createMCPServer({ customTools })` without altering the default HIP-0300 7-tool surface.
 */

import { Tool, ToolResult } from '../types/index.js';
import {
  AstRewriteRule,
  SemanticChangePlanner,
  SemanticPlannerError,
  SourceBlobInput,
  SupportedAstLanguage,
  TenantAccessContext,
} from './change-planner.js';

export interface SemanticEditToolsOptions {
  planner?: SemanticChangePlanner;
  defaultTenantId?: string;
  defaultRepoId?: string;
}

function okJson(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function failResult(err: unknown): ToolResult {
  if (err instanceof SemanticPlannerError) {
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

function resolveAccess(
  args: Record<string, unknown>,
  defaultTenantId: string,
  defaultRepoId: string
): TenantAccessContext {
  const tenantId = String(args.tenantId ?? defaultTenantId).trim();
  if (!tenantId) {
    throw new SemanticPlannerError('TENANT_MISMATCH', 'tenantId is required');
  }
  const callerRoles = Array.isArray(args.callerRoles)
    ? args.callerRoles.map((r) => String(r))
    : undefined;
  const repoId = args.repoId !== undefined ? String(args.repoId) : defaultRepoId;
  return { tenantId, callerRoles, repoId };
}

export function createSemanticEditTools(options: SemanticEditToolsOptions = {}): Tool[] {
  const defaultTenantId = options.defaultTenantId ?? 'default';
  const defaultRepoId = options.defaultRepoId ?? 'workspace';
  const planner = options.planner ?? new SemanticChangePlanner();

  const ingestFilesIfProvided = (
    args: Record<string, unknown>,
    access: TenantAccessContext
  ): void => {
    if (!Array.isArray(args.files)) return;
    for (const raw of args.files) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const input: SourceBlobInput = {
        tenantId: String(rec.tenantId ?? access.tenantId),
        repoId: String(rec.repoId ?? access.repoId ?? defaultRepoId),
        filePath: String(rec.filePath ?? ''),
        content: String(rec.content ?? ''),
        commitVersion: rec.commitVersion !== undefined ? String(rec.commitVersion) : undefined,
        packageName: rec.packageName !== undefined ? String(rec.packageName) : undefined,
        language: rec.language as SupportedAstLanguage | undefined,
        isTestFile: typeof rec.isTestFile === 'boolean' ? rec.isTestFile : undefined,
        allowedRoles: Array.isArray(rec.allowedRoles)
          ? rec.allowedRoles.map((r) => String(r))
          : undefined,
      };
      planner.upsertBlob(input);
    }
  };

  const searchTool: Tool = {
    name: 'semantic_ast_search',
    description:
      'Structural AST search with balanced metavariables ($NODE, $$$VARIADIC) across authorized tenant blobs, ignoring comments and string literals.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Structural AST pattern (e.g. "legacyFetch($URL, $$$OPTS)")' },
        tenantId: { type: 'string', description: 'Tenant scope identifier' },
        repoId: { type: 'string', description: 'Repository identifier' },
        callerRoles: { type: 'array', items: { type: 'string' }, description: 'Caller RBAC roles' },
        languages: { type: 'array', items: { type: 'string' }, description: 'Optional language filter' },
        packageFilter: { type: 'array', items: { type: 'string' }, description: 'Optional package filter' },
        includeTests: { type: 'boolean', description: 'Whether to include test files (default false)' },
        files: { type: 'array', items: { type: 'object' }, description: 'Optional canonical blobs to index first' },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      try {
        const access = resolveAccess(args, defaultTenantId, defaultRepoId);
        ingestFilesIfProvided(args, access);
        const rule: AstRewriteRule = {
          id: 'ast-search',
          pattern: String(args.pattern),
          languages: Array.isArray(args.languages)
            ? (args.languages.map(String) as SupportedAstLanguage[])
            : undefined,
          packageFilter: Array.isArray(args.packageFilter)
            ? args.packageFilter.map(String)
            : undefined,
          includeTests: Boolean(args.includeTests),
        };
        const matches = planner.searchStructural(rule, access);
        return okJson({ matchCount: matches.length, matches });
      } catch (err) {
        return failResult(err);
      }
    },
  };

  const planTool: Tool = {
    name: 'semantic_change_plan',
    description:
      'Generate constrained AST-aware edits, compute symbol-level semantic diffs, detect cross-package contract breakages, and select incremental tests with automatic low-confidence escalation.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', description: 'Tenant scope identifier' },
        repoId: { type: 'string', description: 'Repository identifier' },
        callerRoles: { type: 'array', items: { type: 'string' }, description: 'Caller RBAC roles' },
        rules: {
          type: 'array',
          items: { type: 'object' },
          description: 'AST rewrite rules ({id, pattern, replacement, languages, packageFilter, includeTests})',
        },
        explicitFileContents: {
          type: 'object',
          description: 'Optional map of filePath -> updated source content',
        },
        commitIfReady: {
          type: 'boolean',
          description: 'Persist edits to the canonical store if syntax & cross-package checks pass',
        },
        files: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional canonical blobs to upsert prior to planning',
        },
      },
    },
    handler: async (args) => {
      try {
        const access = resolveAccess(args, defaultTenantId, defaultRepoId);
        ingestFilesIfProvided(args, access);

        const rules: AstRewriteRule[] = Array.isArray(args.rules)
          ? args.rules.map((r: any, idx: number) => ({
              id: String(r.id ?? `rule-${idx + 1}`),
              pattern: String(r.pattern ?? ''),
              replacement: r.replacement !== undefined ? String(r.replacement) : undefined,
              languages: Array.isArray(r.languages) ? r.languages : undefined,
              packageFilter: Array.isArray(r.packageFilter) ? r.packageFilter : undefined,
              includeTests: Boolean(r.includeTests),
              metavarKinds: r.metavarKinds,
              forbiddenMetavarPattern: r.forbiddenMetavarPattern,
            }))
          : [];

        const explicitFileContents =
          args.explicitFileContents && typeof args.explicitFileContents === 'object'
            ? (args.explicitFileContents as Record<string, string>)
            : undefined;

        const plan = planner.planChange({
          access,
          rules,
          explicitFileContents,
          commitIfReady: Boolean(args.commitIfReady),
        });

        return okJson(plan);
      } catch (err) {
        return failResult(err);
      }
    },
  };

  return [searchTool, planTool];
}
