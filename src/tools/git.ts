/**
 * VCS tool — single tool, action-routed git operations
 * Full git power: status, diff, log, branch, commit, blame, stash,
 * show, tag, remote, merge, rebase, cherry-pick, reset, clean, worktree, bisect, reflog
 */

import { Tool } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function git(args: string, cwd?: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd: cwd || '.', maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

export const gitTool: Tool = {
  name: 'git',
  description: 'Git version control: status, diff, log, branch, commit, blame, stash, show, tag, remote, merge, rebase, cherry_pick, reset, clean, worktree, bisect, reflog, init, clone, fetch, pull, push, config, shortlog',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'status', 'diff', 'log', 'branch', 'commit', 'blame', 'stash', 'show',
          'tag', 'remote', 'merge', 'rebase', 'cherry_pick', 'reset', 'clean',
          'worktree', 'bisect', 'reflog',
          'init', 'clone', 'fetch', 'pull', 'push',
          'config', 'shortlog', 'rev_parse', 'describe'
        ],
        description: 'Git action'
      },
      path: { type: 'string', description: 'Repository path', default: '.' },
      file: { type: 'string', description: 'File path (diff, blame, log)' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files to stage/add' },
      staged: { type: 'boolean', description: 'Staged changes (diff)', default: false },
      stat: { type: 'boolean', description: 'Show diffstat only', default: false },
      limit: { type: 'number', description: 'Number of entries (log, reflog)', default: 20 },
      author: { type: 'string', description: 'Filter by author' },
      since: { type: 'string', description: 'Since date (e.g., 1.week, 2024-01-01)' },
      until: { type: 'string', description: 'Until date' },
      oneline: { type: 'boolean', default: true },
      graph: { type: 'boolean', description: 'Show graph (log)', default: false },
      name: { type: 'string', description: 'Branch/tag/remote/worktree name' },
      message: { type: 'string', description: 'Commit/tag/stash message' },
      ref: { type: 'string', description: 'Commit ref', default: 'HEAD' },
      target: { type: 'string', description: 'Target branch/ref (merge, rebase, reset)' },
      all: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      lines: { type: 'string', description: 'Line range (blame, e.g., 10,20)' },
      sub_action: { type: 'string', description: 'Sub-action: list, create, delete, checkout, add, remove, show, start, good, bad, run, push, pop, apply, drop' },
      index: { type: 'number', description: 'Stash index', default: 0 },
      url: { type: 'string', description: 'Remote URL (clone, remote add)' },
      key: { type: 'string', description: 'Config key' },
      value: { type: 'string', description: 'Config value' },
      mode: { type: 'string', enum: ['soft', 'mixed', 'hard'], description: 'Reset mode', default: 'mixed' },
      cherry: { type: 'string', description: 'Commit SHA for cherry-pick' },
      pattern: { type: 'string', description: 'Clean pattern / grep pattern' },
      format: { type: 'string', description: 'Log format (short, medium, full, fuller, oneline, format:...)' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const cwd = args.path || '.';
      let out: string;

      switch (args.action) {
        case 'status':
          out = args.all
            ? await git('status', cwd)
            : await git('status -sb', cwd) || 'Clean';
          break;

        case 'diff': {
          let cmd = 'diff';
          if (args.staged) cmd += ' --staged';
          if (args.stat) cmd += ' --stat';
          if (args.target) cmd += ` ${args.target}`;
          if (args.file) cmd += ` -- ${args.file}`;
          out = await git(cmd, cwd) || 'No changes';
          break;
        }

        case 'log': {
          let cmd = `log -${args.limit || 20}`;
          if (args.oneline !== false && !args.format) cmd += ' --oneline';
          if (args.graph) cmd += ' --graph --decorate';
          if (args.author) cmd += ` --author="${args.author}"`;
          if (args.since) cmd += ` --since="${args.since}"`;
          if (args.until) cmd += ` --until="${args.until}"`;
          if (args.format) cmd += ` --format=${args.format}`;
          if (args.pattern) cmd += ` --grep="${args.pattern}"`;
          if (args.all) cmd += ' --all';
          if (args.file) cmd += ` -- ${args.file}`;
          out = await git(cmd, cwd) || 'No commits';
          break;
        }

        case 'branch': {
          const sa = args.sub_action || 'list';
          if (sa === 'create') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = await git(`checkout -b ${args.name}${args.target ? ` ${args.target}` : ''}`, cwd);
          } else if (sa === 'checkout') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = await git(`checkout ${args.name}`, cwd);
          } else if (sa === 'delete') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = await git(`branch ${args.force ? '-D' : '-d'} ${args.name}`, cwd);
          } else {
            out = await git(`branch${args.all ? ' -a' : ''} -v`, cwd);
          }
          break;
        }

        case 'commit': {
          if (!args.message) return { content: [{ type: 'text', text: 'message required' }], isError: true };
          if (args.files?.length) await git(`add ${args.files.join(' ')}`, cwd);
          else if (args.all) await git('add -A', cwd);
          out = await git(`commit -m "${args.message.replace(/"/g, '\\"')}"`, cwd);
          break;
        }

        case 'blame': {
          if (!args.file) return { content: [{ type: 'text', text: 'file required' }], isError: true };
          let cmd = `blame ${args.file}`;
          if (args.lines) cmd += ` -L ${args.lines}`;
          out = await git(cmd, cwd);
          break;
        }

        case 'stash': {
          const sa = args.sub_action || 'push';
          if (sa === 'push') out = await git(args.message ? `stash push -m "${args.message}"` : 'stash push', cwd);
          else if (sa === 'list') out = await git('stash list', cwd) || 'No stashes';
          else if (sa === 'show') out = await git(`stash show -p stash@{${args.index || 0}}`, cwd);
          else out = await git(`stash ${sa} stash@{${args.index || 0}}`, cwd);
          break;
        }

        case 'show': {
          const fmt = args.stat ? '--stat' : '-p';
          out = await git(`show ${args.ref || 'HEAD'} ${fmt}`, cwd);
          if (out.length > 5000) out = out.substring(0, 5000) + '\n... (truncated)';
          break;
        }

        case 'tag': {
          const sa = args.sub_action || 'list';
          if (sa === 'create') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = args.message
              ? await git(`tag -a ${args.name} -m "${args.message}" ${args.ref || ''}`, cwd)
              : await git(`tag ${args.name} ${args.ref || ''}`, cwd);
          } else if (sa === 'delete') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = await git(`tag -d ${args.name}`, cwd);
          } else if (sa === 'show') {
            out = await git(`tag -l -n${args.limit || 20}`, cwd);
          } else {
            out = await git(`tag -l --sort=-version:refname`, cwd) || 'No tags';
          }
          break;
        }

        case 'remote': {
          const sa = args.sub_action || 'list';
          if (sa === 'add') {
            if (!args.name || !args.url) return { content: [{ type: 'text', text: 'name and url required' }], isError: true };
            out = await git(`remote add ${args.name} ${args.url}`, cwd);
          } else if (sa === 'remove') {
            if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
            out = await git(`remote remove ${args.name}`, cwd);
          } else if (sa === 'show') {
            out = await git(`remote show ${args.name || 'origin'}`, cwd);
          } else {
            out = await git('remote -v', cwd) || 'No remotes';
          }
          break;
        }

        case 'merge': {
          if (!args.target) return { content: [{ type: 'text', text: 'target branch required' }], isError: true };
          out = await git(`merge ${args.target}${args.message ? ` -m "${args.message}"` : ''}`, cwd);
          break;
        }

        case 'rebase': {
          if (!args.target) return { content: [{ type: 'text', text: 'target branch required' }], isError: true };
          out = await git(`rebase ${args.target}`, cwd);
          break;
        }

        case 'cherry_pick': {
          const sha = args.cherry || args.ref;
          if (!sha) return { content: [{ type: 'text', text: 'cherry (commit SHA) required' }], isError: true };
          out = await git(`cherry-pick ${sha}`, cwd);
          break;
        }

        case 'reset': {
          const mode = args.mode || 'mixed';
          out = await git(`reset --${mode} ${args.ref || 'HEAD~1'}`, cwd);
          break;
        }

        case 'clean': {
          if (args.force) {
            out = await git(`clean -fd${args.pattern ? ` -e "${args.pattern}"` : ''}`, cwd);
          } else {
            out = await git(`clean -nd`, cwd) || 'Nothing to clean';
          }
          break;
        }

        case 'worktree': {
          const sa = args.sub_action || 'list';
          if (sa === 'add') {
            if (!args.name) return { content: [{ type: 'text', text: 'name (path) required' }], isError: true };
            out = await git(`worktree add ${args.name}${args.target ? ` ${args.target}` : ''}`, cwd);
          } else if (sa === 'remove') {
            if (!args.name) return { content: [{ type: 'text', text: 'name (path) required' }], isError: true };
            out = await git(`worktree remove ${args.name}${args.force ? ' --force' : ''}`, cwd);
          } else {
            out = await git('worktree list', cwd);
          }
          break;
        }

        case 'bisect': {
          const sa = args.sub_action || 'start';
          if (sa === 'start') out = await git('bisect start', cwd);
          else if (sa === 'good') out = await git(`bisect good ${args.ref || ''}`, cwd);
          else if (sa === 'bad') out = await git(`bisect bad ${args.ref || ''}`, cwd);
          else if (sa === 'run') {
            if (!args.value) return { content: [{ type: 'text', text: 'value (script) required' }], isError: true };
            out = await git(`bisect run ${args.value}`, cwd);
          } else {
            out = await git('bisect reset', cwd);
          }
          break;
        }

        case 'reflog':
          out = await git(`reflog -${args.limit || 20}`, cwd);
          break;

        case 'init':
          out = await git(`init${args.name ? ` ${args.name}` : ''}`, cwd);
          break;

        case 'clone': {
          if (!args.url) return { content: [{ type: 'text', text: 'url required' }], isError: true };
          out = await git(`clone ${args.url}${args.name ? ` ${args.name}` : ''}`, cwd);
          break;
        }

        case 'fetch':
          out = await git(`fetch ${args.name || '--all'}${args.all ? ' --prune' : ''}`, cwd);
          break;

        case 'pull':
          out = await git(`pull ${args.name || 'origin'} ${args.target || ''}`, cwd);
          break;

        case 'push':
          out = await git(`push ${args.name || 'origin'} ${args.target || ''}${args.force ? ' --force' : ''}`, cwd);
          break;

        case 'config': {
          if (args.key && args.value) out = await git(`config ${args.key} "${args.value}"`, cwd);
          else if (args.key) out = await git(`config --get ${args.key}`, cwd);
          else out = await git('config --list --local', cwd);
          break;
        }

        case 'shortlog':
          out = await git(`shortlog -sn${args.since ? ` --since="${args.since}"` : ''}${args.all ? ' --all' : ''}`, cwd);
          break;

        case 'rev_parse':
          out = await git(`rev-parse ${args.ref || 'HEAD'}`, cwd);
          break;

        case 'describe':
          out = await git(`describe --tags --always ${args.ref || ''}`, cwd).catch(() => 'No tags');
          break;

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }

      return { content: [{ type: 'text', text: out || 'Done' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const gitTools = [gitTool];
