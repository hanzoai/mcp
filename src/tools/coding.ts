/**
 * coding — Hanzo Cloud autonomous coding runs as one MCP tool (HIP-0300).
 *
 * Mirrors rust/src/tools/coding_tool.rs 1-to-1:
 *   start      POST /v1/agent/coding                       -> {session, branch}
 *   progress   GET  /v1/agent/sessions/{id}/progress       -> {phase, pct, activity}
 *   changes    GET  /v1/agent/coding/{session}/changes     -> commits, files, pull request
 *   artifacts  GET  /v1/agent/coding/{session}/artifacts   -> what the run saved
 *   tree       GET  /v1/agent/coding/{session}/tree        -> directory listing
 *   blob       GET  /v1/agent/coding/{session}/blob        -> file contents
 *   steer      POST /v1/agent/coding/{session}/steer       -> redirect live run
 *   pull       POST /v1/agent/coding/{session}/pull        -> open pull request
 *   merge      POST /v1/agent/coding/{session}/merge       -> merge pull request
 *   extend     POST /v1/agent/sessions/{id}/extend         -> extend timeoutSeconds
 *   stop       POST /v1/agent/sessions/{id}/stop           -> end run
 */

import { Tool, ToolResult } from '../types/index.js';
import { resolveHanzoApiBase, resolveHanzoToken } from './hanzo-auth.js';
import { refusal } from './refusal.js';

const ACTIONS = [
  'start',
  'progress',
  'changes',
  'artifacts',
  'tree',
  'blob',
  'steer',
  'pull',
  'merge',
  'extend',
  'stop',
] as const;

const SESSION_RE = /^[A-Za-z0-9._:-]+$/;

function apiBase(): string {
  return resolveHanzoApiBase();
}

function token(): string {
  return resolveHanzoToken();
}

function sessionOf(args: any): string {
  const s = String(args?.session ?? args?.id ?? args?.sessionId ?? args?.session_id ?? '').trim();
  if (!s) throw new Error('session required: the id start returned');
  if (!SESSION_RE.test(s) || /^\.+$/.test(s)) {
    throw new Error(`session "${s}" is not a session id`);
  }
  return s;
}

function envelope(data: unknown, action: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'coding', action } }, null, 2) }],
  };
}

function fail(action: string, code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'coding', action } }, null, 2) }],
    isError: true,
  };
}

export const codingTool: Tool = {
  name: 'coding',
  description:
    'Autonomous coding runs on Hanzo Cloud (/v1/agent/coding): start {repo, prompt} returns {session, branch}; poll progress {session}; inspect changes, artifacts, tree, blob; steer, pull, merge, extend, or stop.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Coding run action: start | progress | changes | artifacts | tree | blob | steer | pull | merge | extend | stop',
      },
      session: {
        type: 'string',
        description: 'Session ID returned by start (aliases: id, sessionId)',
      },
      repo: {
        type: 'string',
        description: 'Repository slug (start)',
      },
      prompt: {
        type: 'string',
        description: 'Task instructions for the autonomous coding run (start; alias: task)',
      },
      base: {
        type: 'string',
        description: 'Base branch (start, pull)',
      },
      after: {
        type: 'string',
        description: 'Continue an earlier coding session on the same branch (start)',
      },
      branch: {
        type: 'string',
        description: 'Branch name agent/<name> (start)',
      },
      pull: {
        type: 'boolean',
        description: 'Open pull request automatically when start completes',
      },
      title: {
        type: 'string',
        description: 'Pull request title (pull)',
      },
      body: {
        type: 'string',
        description: 'Pull request description (pull)',
      },
      draft: {
        type: 'boolean',
        description: 'Open pull request as draft (pull)',
      },
      seconds: {
        type: 'number',
        description: 'Additional runtime seconds (extend)',
      },
      mode: {
        type: 'string',
        enum: ['build', 'plan'],
        description: 'build (default) edits and pushes; plan reads and returns a plan',
      },
      model: {
        type: 'string',
        description: 'Model override for coding run (start)',
      },
      effort: {
        type: 'string',
        description: 'Reasoning effort level (start)',
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Maximum run duration in seconds (start)',
      },
      issue: {
        type: ['string', 'number'],
        description: 'Issue reference (#464 or owner/name#464)',
      },
      project: {
        type: 'string',
        description: 'Project key',
      },
      text: {
        type: 'string',
        description: 'Steering instructions or stop reason (steer, stop; alias: message)',
      },
      path: {
        type: 'string',
        description: 'Directory or file path in the run repository (tree, blob)',
      },
    },
    required: ['action'],
  },
  handler: async (args: any = {}): Promise<ToolResult> => {
    const action = String(args.action || '').trim().toLowerCase();
    if (!ACTIONS.includes(action as any)) {
      return fail(action, 'INVALID_ARGS', `action must be one of: ${ACTIONS.join(', ')}`);
    }
    const key = token();
    if (!key) {
      return fail(action, 'NO_API_KEY', 'no API key: run `hanzo login` or set HANZO_API_KEY (pk-/sk-)');
    }

    try {
      let method = 'GET';
      let urlPath = '';
      let body: Record<string, unknown> | undefined;

      switch (action) {
        case 'start': {
          const prompt = String(args.prompt ?? args.task ?? '').trim();
          if (!prompt) return fail('start', 'INVALID_ARGS', 'prompt required');
          const after = String(args.after ?? '').trim();
          const repo = String(args.repo ?? '').trim();
          if (!repo && !after) return fail('start', 'INVALID_ARGS', 'repo (or after) required');
          method = 'POST';
          urlPath = '/v1/agent/coding';
          body = { prompt };
          if (repo) body.repo = repo;
          if (after) body.after = after;
          for (const k of ['base', 'branch', 'pull', 'mode', 'tool', 'model', 'effort', 'project', 'desktop']) {
            if (args[k] !== undefined && args[k] !== '') body[k] = args[k];
          }
          if (args.timeoutSeconds !== undefined || args.timeout_seconds !== undefined) {
            body.timeoutSeconds = args.timeoutSeconds ?? args.timeout_seconds;
          }
          if (args.issue !== undefined && args.issue !== null && args.issue !== '') {
            body.issue = String(args.issue);
          }
          break;
        }
        case 'progress': {
          const s = sessionOf(args);
          urlPath = `/v1/agent/sessions/${s}/progress`;
          break;
        }
        case 'changes': {
          const s = sessionOf(args);
          urlPath = `/v1/agent/coding/${s}/changes`;
          break;
        }
        case 'artifacts': {
          const s = sessionOf(args);
          urlPath = `/v1/agent/coding/${s}/artifacts`;
          break;
        }
        case 'tree': {
          const s = sessionOf(args);
          const q = args.path ? `?path=${encodeURIComponent(String(args.path))}` : '';
          urlPath = `/v1/agent/coding/${s}/tree${q}`;
          break;
        }
        case 'blob': {
          const s = sessionOf(args);
          if (!args.path) return fail('blob', 'INVALID_ARGS', 'path required');
          urlPath = `/v1/agent/coding/${s}/blob?path=${encodeURIComponent(String(args.path))}`;
          break;
        }
        case 'steer': {
          const s = sessionOf(args);
          const text = String(args.text ?? args.message ?? '').trim();
          if (!text) return fail('steer', 'INVALID_ARGS', 'text required');
          method = 'POST';
          urlPath = `/v1/agent/coding/${s}/steer`;
          body = { text };
          break;
        }
        case 'pull': {
          const s = sessionOf(args);
          method = 'POST';
          urlPath = `/v1/agent/coding/${s}/pull`;
          body = {};
          for (const k of ['title', 'body', 'base', 'draft']) {
            if (args[k] !== undefined) body[k] = args[k];
          }
          break;
        }
        case 'merge': {
          const s = sessionOf(args);
          method = 'POST';
          urlPath = `/v1/agent/coding/${s}/merge`;
          body = {};
          break;
        }
        case 'extend': {
          const s = sessionOf(args);
          if (typeof args.seconds !== 'number' || args.seconds <= 0) {
            return fail('extend', 'INVALID_ARGS', 'positive seconds required');
          }
          method = 'POST';
          urlPath = `/v1/agent/sessions/${s}/extend`;
          body = { seconds: args.seconds };
          break;
        }
        case 'stop': {
          const s = sessionOf(args);
          method = 'POST';
          urlPath = `/v1/agent/sessions/${s}/stop`;
          const text = String(args.text ?? args.message ?? '').trim();
          body = text ? { reason: text } : {};
          break;
        }
      }

      const resp = await fetch(`${apiBase()}${urlPath}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const raw = await resp.text();
      const refused = refusal(resp.status, raw);
      if (refused) return refused.result;
      if (!resp.ok) {
        return fail(action, 'UPSTREAM', `${resp.status}: ${raw.slice(0, 300)}`);
      }
      let parsed: any = raw ? JSON.parse(raw) : {};
      if (action === 'start' && parsed && typeof parsed === 'object' && parsed.sessionId && !parsed.session) {
        parsed = { session: parsed.sessionId, ...parsed };
      }
      return envelope(parsed, action);
    } catch (e: any) {
      return fail(action, 'INVALID_ARGS', e?.message || String(e));
    }
  },
};

export const codingTools: Tool[] = [codingTool];
