/**
 * workspace — Workspace context, project discovery, config, mode & host system info (HIP-0300).
 *
 * Absorbs config, system, mode, repo, version.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../types/index.js';
import { modeTool } from '../mode-preset.js';

const execAsync = promisify(exec);

const CANONICAL_NAMES = [
  'fs', 'exec', 'code', 'git', 'fetch', 'workspace', 'browser', 'computer', 'ui',
  'kai', 'think', 'plan', 'memory', 'tasks', 'tracker', 'coding', 'research', 'skills', 'hanzo',
];

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'workspace', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'workspace' } }, null, 2) }], isError: true };
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export const workspaceTool: Tool = {
  name: 'workspace',
  description: 'Workspace discovery, roots, config, mode & host system info: detect, projects, config, system, mode, version, capabilities, help, schema',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['detect', 'projects', 'config', 'system', 'mode', 'version', 'capabilities', 'help', 'schema'],
        description: 'Workspace action',
      },
      path: { type: 'string', description: 'Project root', default: '.' },
      sub_action: { type: 'string', description: 'Sub-action when routing to config, system, or mode' },
      key: { type: 'string', description: 'Configuration key (action=config)' },
      value: { description: 'Configuration value (action=config)' },
      name: { type: 'string', description: 'Mode name (action=mode)' },
    },
    required: ['action'],
  },
  handler: async (args) => {
    try {
      const root = args.path || process.cwd();

      switch (args.action) {
        case 'detect': {
          const languages: string[] = [];
          const build: string[] = [];
          const test: string[] = [];
          let vcs: string | null = null;

          if (await fileExists(path.join(root, '.git'))) vcs = 'git';
          if (await fileExists(path.join(root, 'package.json'))) { languages.push('typescript', 'javascript'); build.push('npm'); }
          if (await fileExists(path.join(root, 'tsconfig.json'))) languages.push('typescript');
          if (await fileExists(path.join(root, 'pyproject.toml'))) { languages.push('python'); build.push('uv'); }
          if (await fileExists(path.join(root, 'Cargo.toml'))) { languages.push('rust'); build.push('cargo'); }
          if (await fileExists(path.join(root, 'go.mod'))) { languages.push('go'); build.push('go'); }
          if (await fileExists(path.join(root, 'Makefile'))) build.push('make');
          if (await fileExists(path.join(root, 'compose.yml'))) build.push('compose');
          if (await fileExists(path.join(root, 'Dockerfile'))) build.push('docker');

          if (await fileExists(path.join(root, 'jest.config.ts')) || await fileExists(path.join(root, 'jest.config.js'))) test.push('jest');
          if (await fileExists(path.join(root, 'vitest.config.ts'))) test.push('vitest');
          if (await fileExists(path.join(root, 'pytest.ini')) || await fileExists(path.join(root, 'conftest.py'))) test.push('pytest');

          return envelope({
            root,
            languages: [...new Set(languages)],
            build: [...new Set(build)],
            test,
            vcs,
          }, 'detect');
        }

        case 'projects': {
          const projects: Array<{ path: string; git: boolean }> = [];
          const check = async (dir: string) => {
            const isGit = await fileExists(path.join(dir, '.git'));
            const hasManifest =
              isGit ||
              (await fileExists(path.join(dir, 'package.json'))) ||
              (await fileExists(path.join(dir, 'Cargo.toml'))) ||
              (await fileExists(path.join(dir, 'go.mod'))) ||
              (await fileExists(path.join(dir, 'pyproject.toml')));
            if (hasManifest) projects.push({ path: dir, git: isGit });
          };
          await check(root);
          const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'target') {
              await check(path.join(root, e.name));
            }
          }
          return envelope({ root, count: projects.length, projects }, 'projects');
        }

        case 'config': {
          const cfgPath = path.join(os.homedir(), '.hanzo', 'mcp.json');
          let cfg: Record<string, unknown> = {};
          try { cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')); } catch {}
          const sub = args.config_action || args.sub_action || (args.value !== undefined ? 'set' : args.key ? 'get' : 'show');
          if (sub === 'set' && args.key) {
            cfg[args.key] = args.value;
            await fs.mkdir(path.dirname(cfgPath), { recursive: true });
            await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
            return envelope({ path: cfgPath, key: args.key, value: args.value }, 'config');
          }
          if (sub === 'get' && args.key) {
            return envelope({ path: cfgPath, key: args.key, value: cfg[args.key] ?? null }, 'config');
          }
          return envelope({ path: cfgPath, config: cfg }, 'config');
        }

        case 'system':
        case 'version': {
          return envelope({
            platform: process.platform,
            arch: process.arch,
            release: os.release(),
            cpus: os.cpus().length,
            totalmem: os.totalmem(),
            freemem: os.freemem(),
            node: process.version,
            cwd: process.cwd(),
            canonical_tools: CANONICAL_NAMES.length,
          }, args.action);
        }

        case 'mode': {
          return modeTool.handler({ ...args, action: args.mode_action || args.sub_action || 'list' });
        }

        case 'capabilities': {
          let hasRg = false, hasGit = false, hasNode = false, hasPython = false, hasCargo = false;
          try { await execAsync('which rg'); hasRg = true; } catch {}
          try { await execAsync('which git'); hasGit = true; } catch {}
          try { await execAsync('which node'); hasNode = true; } catch {}
          try { await execAsync('which python3'); hasPython = true; } catch {}
          try { await execAsync('which cargo'); hasCargo = true; } catch {}

          return envelope({
            search: hasRg ? 'ripgrep' : 'grep',
            vcs: hasGit ? 'git' : null,
            runtimes: { node: hasNode, python: hasPython, rust: hasCargo },
            tools: CANONICAL_NAMES,
          }, 'capabilities');
        }

        case 'help': {
          return envelope({
            tools: {
              fs: 'Local filesystem & search: read, write, edit, apply_patch, list, tree, search_text, stat, mkdir, rm, mv, cp',
              exec: 'Process execution & package runners: exec, ps, logs, kill, wait, npx, uvx',
              code: 'Code intelligence: symbols, outline, definition, references, diagnostics, rename, refactor, lsp, jq, search/rag_search, context, ask, index',
              git: 'Git operations: status, diff, log, commit, branch, checkout, blame, stash, worktree',
              fetch: 'Network, web search, markdown reader & vision: get, request, search, read, vision',
              workspace: 'Project discovery, config, mode & host system info: detect, projects, config, system, mode',
              browser: 'Web browser & CDP automation over ZAP: navigate, snapshot, click, type, screenshot, evaluate, cdp',
              computer: 'Native OS desktop GUI & GIMP control: screenshot, click, move, type, key, window, gimp',
              ui: '@hanzo/ui & @hanzo/gui component registry: search, get, blocks, install, tokens',
              kai: 'Calibrated decisions, verified actions, compaction & guards: decide, choice, score, noul, run, plan, list, triggers, compact, tool_select, next_action, command_guard, injection_screen, extract, log_triage, recover, agent_step',
              think: 'Structured reasoning, consensus, Enso LLM & sub-agents: think, critic, consensus, llm, agent',
              plan: 'Execution plan creation & step tracking: create, update, show, list',
              memory: 'Persistent memory & recall: store, recall, search, list, delete',
              tasks: 'Local private session todo list (~/.hanzo/todos.json): list, add, update, complete, clear',
              tracker: 'Cloud /v1/tracker boards & issues: boards, issues, create, update',
              coding: 'Cloud /v1/agent/coding autonomous runs: start, progress, changes, artifacts, tree, blob, steer, pull, merge, stop',
              research: 'Hanzo Science /v1/research & cited synthesis: studies, runs, start, status, ledger, artifacts, search',
              skills: 'Hanzo Skills search, detection & SKILL.md installer: search, detect, get, install, list',
              hanzo: 'Unified Hanzo Cloud platform router: auth, iam, kms/vault, connectors, platform, compute, billing, s3, social, 120+ services',
            },
          }, 'help');
        }

        case 'schema': {
          return envelope({
            message: 'Use workspace(action="help") for canonical 19-tool summaries.',
          }, 'schema');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  },
};
