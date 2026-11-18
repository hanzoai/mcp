/**
 * Optional MCP Tool Bindings & Multi-Tenant Session Registry for SWE-agent ACI (HIP-1347).
 *
 * Exposes stateful `aci_viewer`, `aci_edit`, and `aci_compact_output` MCP tools
 * via `createAciTools()` for opt-in registration (`createMCPServer({ customTools })`)
 * without mutating the canonical HIP-0300 7-tool default surface.
 */

import { Tool, ToolResult } from '../types/index.js';
import {
  AciAccessError,
  AciSecurityOptions,
  AciWorkspaceBackend,
  GuardedFileEditor,
  WindowedFileViewer,
  compactCommandOutput,
} from './compact-response.js';

export interface AciSessionOptions {
  workspaceRoot?: string;
  windowSize?: number;
  contextLines?: number;
  backend?: AciWorkspaceBackend;
  security?: AciSecurityOptions;
  maxSessions?: number;
}

export interface AciSessionHandle {
  key: string;
  tenantId: string;
  sessionId: string;
  viewer: WindowedFileViewer;
  editor: GuardedFileEditor;
}

/**
 * Multi-tenant LRU session registry ensuring open file cursors, line windows,
 * and workspace policies never leak across tenant or agent session boundaries.
 */
export class AciSessionRegistry {
  private readonly sessions = new Map<string, AciSessionHandle>();
  private readonly baseOptions: AciSessionOptions;
  private readonly maxSessions: number;

  constructor(options: AciSessionOptions = {}) {
    this.baseOptions = options;
    this.maxSessions = Math.max(4, Math.floor(options.maxSessions ?? 256));
  }

  public getSession(
    sessionId = 'default',
    callerSecurity?: Partial<AciSecurityOptions>
  ): AciSessionHandle {
    const cleanSession = String(sessionId || 'default').trim() || 'default';
    const tenantId = callerSecurity?.tenantId ?? this.baseOptions.security?.tenantId ?? 'default';
    if (cleanSession.includes(':') || tenantId.includes(':')) {
      throw new AciAccessError(
        'INVALID_ARGUMENT',
        'sessionId and tenantId must not contain ":" delimiter'
      );
    }
    const key = `${tenantId}:${cleanSession}`;
    const existing = this.sessions.get(key);
    if (existing) {
      // Refresh LRU insertion order
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }

    const mergedSecurity: AciSecurityOptions = {
      ...this.baseOptions.security,
      ...callerSecurity,
      tenantId: callerSecurity?.tenantId ?? this.baseOptions.security?.tenantId,
      ...(this.baseOptions.workspaceRoot ? { workspaceRoot: this.baseOptions.workspaceRoot } : {}),
    };

    const viewer = new WindowedFileViewer({
      windowSize: this.baseOptions.windowSize ?? 100,
      backend: this.baseOptions.backend,
      security: mergedSecurity,
    });
    const editor = new GuardedFileEditor({
      contextLines: this.baseOptions.contextLines ?? 4,
      backend: viewer.getBackend(),
      security: mergedSecurity,
      viewer,
    });

    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) {
        this.sessions.delete(oldestKey);
      }
    }

    const handle: AciSessionHandle = {
      key,
      tenantId,
      sessionId: cleanSession,
      viewer,
      editor,
    };
    this.sessions.set(key, handle);
    return handle;
  }

  public clear(): void {
    this.sessions.clear();
  }

  public size(): number {
    return this.sessions.size;
  }
}

function okText(text: string, meta?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(meta ? { _meta: meta } : {}),
  };
}

function errText(code: string, message: string, detail?: string): ToolResult {
  const body = detail ? `[${code}] ${message}\n${detail}` : `[${code}] ${message}`;
  return {
    content: [{ type: 'text', text: body }],
    isError: true,
  };
}

/**
 * Create opt-in MCP tools (`aci_viewer`, `aci_edit`, `aci_compact_output`) backed
 * by a tenant-isolated `AciSessionRegistry`.
 */
export function createAciTools(options: AciSessionOptions = {}): Tool[] {
  const registry = new AciSessionRegistry(options);

  const viewerTool: Tool = {
    name: 'aci_viewer',
    description:
      'Stateful SWE-agent line-numbered file viewer (100-line viewport): open, scroll_down, scroll_up, goto_line, search_file, state',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'scroll_down', 'scroll_up', 'goto_line', 'search_file', 'state'],
          description: 'Viewport navigation or search command',
        },
        path: { type: 'string', description: 'File path for open or search_file' },
        line: { type: 'number', description: '1-based start or target line number' },
        window_size: { type: 'number', description: 'Viewport height in lines (default 100)' },
        step: { type: 'number', description: 'Scroll step in lines' },
        query: { type: 'string', description: 'Search pattern for search_file' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search_file flag' },
        auto_jump: { type: 'boolean', description: 'Jump viewport to first search_file match' },
        session_id: { type: 'string', description: 'Isolated agent session identifier' },
        tenant_id: { type: 'string', description: 'Optional multi-tenant scope identifier' },
      },
      required: ['action'],
    },
    handler: async (args: Record<string, any>): Promise<ToolResult> => {
      try {
        const session = registry.getSession(args.session_id, {
          ...(args.tenant_id ? { tenantId: String(args.tenant_id) } : {}),
        });
        switch (args.action) {
          case 'open': {
            if (typeof args.path !== 'string' || !args.path) {
              return errText('INVALID_ARGUMENT', 'path is required for open');
            }
            const res = session.viewer.open(
              args.path,
              typeof args.line === 'number' ? args.line : 1,
              typeof args.window_size === 'number' ? args.window_size : undefined
            );
            return okText(res.rendered, { hash: res.hash, metrics: res.metrics });
          }
          case 'scroll_down': {
            const res = session.viewer.scroll_down(
              typeof args.step === 'number' ? args.step : undefined
            );
            return okText(res.rendered, { hash: res.hash, metrics: res.metrics });
          }
          case 'scroll_up': {
            const res = session.viewer.scroll_up(
              typeof args.step === 'number' ? args.step : undefined
            );
            return okText(res.rendered, { hash: res.hash, metrics: res.metrics });
          }
          case 'goto_line': {
            if (typeof args.line !== 'number') {
              return errText('INVALID_ARGUMENT', 'line is required for goto_line');
            }
            const res = session.viewer.goto_line(args.line);
            return okText(res.rendered, { hash: res.hash, metrics: res.metrics });
          }
          case 'search_file': {
            if (typeof args.query !== 'string' || !args.query) {
              return errText('INVALID_ARGUMENT', 'query is required for search_file');
            }
            const res = session.viewer.search_file(args.query, {
              filePath: typeof args.path === 'string' ? args.path : undefined,
              caseInsensitive: Boolean(args.case_insensitive),
              autoJump: Boolean(args.auto_jump),
            });
            return okText(res.rendered, {
              matchLines: res.matchLines,
              totalMatches: res.totalMatches,
              metrics: res.metrics,
            });
          }
          case 'state': {
            return okText(JSON.stringify(session.viewer.getState(), null, 2));
          }
          default:
            return errText('INVALID_ARGUMENT', `Unsupported aci_viewer action: ${String(args.action)}`);
        }
      } catch (err: any) {
        const code = err instanceof AciAccessError ? err.code : 'ACI_VIEWER_ERROR';
        return errText(code, err?.message ?? String(err));
      }
    },
  };

  const editTool: Tool = {
    name: 'aci_edit',
    description:
      'Guarded atomic search-replace file editor with uniqueness check, base_hash precondition, and pre-flight syntax lint gate',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file path' },
        search_block: { type: 'string', description: 'Exact unique block to replace' },
        replace_block: { type: 'string', description: 'Replacement block' },
        base_hash: { type: 'string', description: 'Optional sha256:<hex> precondition' },
        expected_start_line: {
          type: 'number',
          description: 'Optional 1-based line anchor to disambiguate duplicate blocks',
        },
        context_lines: {
          type: 'number',
          description: 'Localized +/- context lines returned in snippet (default 4)',
        },
        session_id: { type: 'string', description: 'Isolated agent session identifier' },
        tenant_id: { type: 'string', description: 'Optional multi-tenant scope identifier' },
      },
      required: ['path', 'search_block', 'replace_block'],
    },
    handler: async (args: Record<string, any>): Promise<ToolResult> => {
      try {
        const session = registry.getSession(args.session_id, {
          ...(args.tenant_id ? { tenantId: String(args.tenant_id) } : {}),
        });
        const res = await session.editor.editAsync({
          filePath: String(args.path ?? ''),
          searchBlock: String(args.search_block ?? ''),
          replaceBlock: String(args.replace_block ?? ''),
          baseHash: typeof args.base_hash === 'string' ? args.base_hash : undefined,
          expectedStartLine:
            typeof args.expected_start_line === 'number' ? args.expected_start_line : undefined,
          contextLines: typeof args.context_lines === 'number' ? args.context_lines : undefined,
        });
        if (!res.applied) {
          return {
            content: [{ type: 'text', text: res.snippet }],
            isError: true,
            _meta: { errorCode: res.errorCode, syntaxDiagnostics: res.syntaxDiagnostics },
          };
        }
        return okText(res.snippet, {
          previousHash: res.previousHash,
          newHash: res.newHash,
          editedRange: res.editedRange,
          metrics: res.metrics,
        });
      } catch (err: any) {
        const code = err instanceof AciAccessError ? err.code : 'ACI_EDIT_ERROR';
        return errText(code, err?.message ?? String(err));
      }
    },
  };

  const compactOutputTool: Tool = {
    name: 'aci_compact_output',
    description:
      'Compress noisy command/build/test output with ANSI stripping, duplicate stack-frame collapsing, head/tail preservation, and structured footer',
    inputSchema: {
      type: 'object',
      properties: {
        raw_output: { type: 'string', description: 'Raw stdout/stderr command output' },
        exit_code: { type: 'number', description: 'Process exit code (default 0)' },
        elapsed_ms: { type: 'number', description: 'Elapsed runtime in milliseconds (default 0)' },
        head_lines: { type: 'number', description: 'Leading lines to preserve (default 15)' },
        tail_lines: { type: 'number', description: 'Trailing lines to preserve (default 20)' },
        max_lines: { type: 'number', description: 'Maximum output body lines (default 60)' },
        max_bytes: { type: 'number', description: 'Maximum output body bytes (default 4096)' },
      },
      required: ['raw_output'],
    },
    handler: async (args: Record<string, any>): Promise<ToolResult> => {
      const res = compactCommandOutput(String(args.raw_output ?? ''), {
        exitCode: typeof args.exit_code === 'number' ? args.exit_code : 0,
        elapsedMs: typeof args.elapsed_ms === 'number' ? args.elapsed_ms : 0,
        headLines: typeof args.head_lines === 'number' ? args.head_lines : undefined,
        tailLines: typeof args.tail_lines === 'number' ? args.tail_lines : undefined,
        maxLines: typeof args.max_lines === 'number' ? args.max_lines : undefined,
        maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
      });
      return okText(res.output, {
        category: res.category,
        truncatedBytes: res.truncatedBytes,
        collapsedStackFrames: res.collapsedStackFrames,
        extractedLocations: res.extractedLocations,
        metrics: res.metrics,
      });
    },
  };

  return [viewerTool, editTool, compactOutputTool];
}
