/**
 * npx, uvx and jq, as python-sdk offers them.
 *
 * A package run is `exec`'s argv runner (no shell) with a two-minute
 * auto-background, so a long-running one shows up in `exec ps` and its output
 * in `exec logs`. jq takes its filter as one argv word: `!`, `|` and quotes
 * need no escaping.
 */

import { execFile } from 'child_process';
import { Tool, ToolResult } from '../types/index.js';
import { run } from './unified/exec.js';

/** Milliseconds before a package run keeps going in the background. */
export const BACKGROUND = 120_000;

/** The argv a package tool runs, peer of python-sdk's BaseBinaryTool. */
export function argv(tool: 'npx' | 'uvx', a: Record<string, any>): string[] {
  if (!a.package) throw new Error('package required');
  const flags = tool === 'npx' ? (a.yes === false ? [] : ['-y']) : a.python ? ['--python', a.python] : [];
  return [tool, ...flags, a.package, ...String(a.args ?? '').split(/\s+/).filter(Boolean)];
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

function packageTool(name: 'npx' | 'uvx', description: string, extra: Record<string, unknown>): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'The package (and its command)' },
        args: { type: 'string', default: '', description: 'Arguments, split on whitespace' },
        cwd: { type: 'string', description: 'Working directory' },
        ...extra,
      },
      required: ['package'],
    },
    handler: async (a: Record<string, any>) => {
      try {
        return await run(name, argv(name, a), a.cwd, BACKGROUND);
      } catch (e: any) {
        return text(`Error: ${e.message}`, true);
      }
    },
  };
}

export const npxTool = packageTool('npx', `Run npx packages with automatic backgrounding for long-running processes.

Commands that run for more than 2 minutes will automatically continue in the background.

Usage:
npx create-react-app my-app
npx http-server -p 8080  # Auto-backgrounds after 2 minutes
npx prettier --write "**/*.js"
npx json-server db.json  # Auto-backgrounds if needed`, { yes: { type: 'boolean', default: true, description: 'Pass -y' } });

export const uvxTool = packageTool('uvx', `Run Python packages with uvx with automatic backgrounding for long-running processes.

Commands that run for more than 2 minutes will automatically continue in the background.

Usage:
uvx ruff check .
uvx mkdocs serve  # Auto-backgrounds after 2 minutes
uvx black --check src/
uvx jupyter lab --port 8888  # Auto-backgrounds if needed`, { python: { type: 'string', description: 'Python version for uvx --python' } });

export const jqTool: Tool = {
  name: 'jq',
  description: `JSON processor - jq without shell escaping issues.

Examples:
  jq --filter ".result.data" --input '{"result": {"data": [1,2,3]}}'
  jq --filter ".[] | select(.active)" --file data.json
  jq --filter "keys" --input '{"a": 1, "b": 2}'
  jq --filter '.checks | to_entries[] | select(.value.error != null)' --file health.json

Parameters:
  filter: jq filter expression (required)
  input: JSON input as string
  file: Path to JSON file (alternative to input)
  raw: Output raw strings without quotes (default: false)
  compact: Compact output (default: false)
  slurp: Read entire input as single array (default: false)
  sort_keys: Sort object keys (default: false)

The filter is passed directly to jq without shell interpretation,
so you don't need to escape special characters like ! or |`,
  inputSchema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'jq filter expression' },
      input: { type: 'string', description: 'JSON input string' },
      file: { type: 'string', description: 'Path to JSON file' },
      raw: { type: 'boolean', default: false, description: 'Output raw strings' },
      compact: { type: 'boolean', default: false, description: 'Compact output' },
      slurp: { type: 'boolean', default: false, description: 'Read as single array' },
      sort_keys: { type: 'boolean', default: false, description: 'Sort object keys' },
    },
    required: ['filter'],
  },
  handler: async (a: Record<string, any>) => {
    if (!a.filter) return text("Error: 'filter' is required", true);
    if (!a.input && !a.file) return text("Error: Either 'input' or 'file' is required", true);
    if (a.input) {
      try { JSON.parse(a.input); } catch (e: any) { return text(`Error: Invalid JSON input: ${e.message}`, true); }
    }
    const flags = ([['-r', 'raw'], ['-c', 'compact'], ['-s', 'slurp'], ['-S', 'sort_keys']] as const).filter(([, k]) => a[k]).map(([f]) => f);
    const args = [...flags, a.filter, ...(a.file && !a.input ? [a.file] : [])];
    return new Promise<ToolResult>((resolve) => {
      const child = execFile('jq', args, { timeout: 30_000, maxBuffer: 64 << 20 }, (err: any, stdout, stderr) => {
        if (err?.code === 'ENOENT') return resolve(text('Error: jq not found. Install jq: brew install jq', true));
        if (err?.killed) return resolve(text('jq timed out after 30s', true));
        if (err) {
          return resolve(text(/syntax error/i.test(stderr)
            ? `jq syntax error in filter:\n  ${a.filter}\n\nError: ${stderr}`
            : `jq failed (exit ${err.code}):\n${stderr}`, true));
        }
        resolve(text(stdout.trimEnd()));
      });
      child.stdin?.end(a.input ?? '');
    });
  },
};

export const packageTools: Tool[] = [npxTool, uvxTool, jqTool];
