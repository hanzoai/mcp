/**
 * workspace — Workspace context tool (HIP-0300)
 *
 * One tool for the Project Context axis.
 * Actions: detect, capabilities, help, schema
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

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
  description: 'Workspace context: detect, capabilities, help, schema',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['detect', 'capabilities', 'help', 'schema'], description: 'Workspace action' },
      path: { type: 'string', description: 'Project root', default: '.' },
    },
    required: ['action']
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

          // VCS
          if (await fileExists(path.join(root, '.git'))) vcs = 'git';

          // Languages & build systems
          if (await fileExists(path.join(root, 'package.json'))) { languages.push('typescript', 'javascript'); build.push('npm'); }
          if (await fileExists(path.join(root, 'tsconfig.json'))) languages.push('typescript');
          if (await fileExists(path.join(root, 'pyproject.toml'))) { languages.push('python'); build.push('uv'); }
          if (await fileExists(path.join(root, 'Cargo.toml'))) { languages.push('rust'); build.push('cargo'); }
          if (await fileExists(path.join(root, 'go.mod'))) { languages.push('go'); build.push('go'); }
          if (await fileExists(path.join(root, 'Makefile'))) build.push('make');
          if (await fileExists(path.join(root, 'compose.yml'))) build.push('docker-compose');
          if (await fileExists(path.join(root, 'Dockerfile'))) build.push('docker');

          // Test frameworks
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
            runtimes: {
              node: hasNode,
              python: hasPython,
              rust: hasCargo,
            },
            tools: ['fs', 'exec', 'code', 'git', 'fetch', 'computer', 'workspace', 'browser', 'think', 'llm', 'memory', 'hanzo', 'plan', 'tasks', 'mode'],
          }, 'capabilities');
        }

        case 'help': {
          return envelope({
            tools: {
              fs: 'Filesystem: read, write, stat, list, mkdir, rm, mv, apply_patch, search_text',
              exec: 'Processes: exec, ps, kill, logs',
              code: 'Semantics: search_symbol, outline, references, metrics, exports, types, hierarchy, rename, grep_replace',
              git: 'Version control: status, diff, log, commit, branch, tag, remote, merge, rebase, and more',
              fetch: 'Network: request, download, open',
              workspace: 'Workspace: detect, capabilities, help, schema',
              computer: 'Native OS control: click, type, screenshot, window management',
              browser: 'Web automation: navigate, click, fill, screenshot (Playwright)',
              think: 'Structured reasoning: think, critic, review, summarize, classify, explain',
              llm: 'LLM operations: query, consensus, models, enable, disable, test',
              memory: 'Memory: store, recall, list, delete, search, stats, clear, export, import, merge, tag, untag',
              hanzo: 'Hanzo Cloud: iam, kms, paas, commerce, storage, auth, api',
              plan: 'Planning: create, show, update, list, next, archive, add_step, remove_step, estimate, progress',
            }
          }, 'help');
        }

        case 'schema': {
          return envelope({
            message: 'Use ws(action="help") for tool summaries, or call any tool with no action to see its schema.',
          }, 'schema');
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
