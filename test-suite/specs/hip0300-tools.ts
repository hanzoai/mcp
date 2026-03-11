/**
 * HIP-0300 Unified Tool Conformance Tests
 *
 * These specs test the 13 canonical unified tools that ALL MCP implementations
 * (TypeScript, Python, Rust) must support. Each tool uses action-based routing:
 *   tool_name(action="action_name", ...params)
 *
 * Tools tested:
 *   fs, exec, code, git, fetch, workspace, ui, think, memory, hanzo, plan, tasks, mode
 */

import { ToolTestSpec } from '../src/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TMP = '/tmp/mcp-conformance';

/** Ensure temp dir exists */
function ensureTmp() {
  fs.mkdirSync(TMP, { recursive: true });
}

export const hip0300ToolSpecs: ToolTestSpec[] = [
  // ─── fs: Bytes + Paths axis ───────────────────────────────────────────
  {
    name: 'fs',
    category: 'hip0300-core',
    description: 'Unified filesystem tool (read, write, list, stat, mkdir, rm, search_text)',
    testCases: [
      {
        name: 'fs.write then fs.read roundtrip',
        input: { action: 'write', path: `${TMP}/hello.txt`, content: 'Hello HIP-0300!' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'wrote|written|ok|success' }],
        },
        setup: async () => ensureTmp(),
      },
      {
        name: 'fs.read written file',
        input: { action: 'read', path: `${TMP}/hello.txt` },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'Hello HIP-0300!' }],
        },
      },
      {
        name: 'fs.stat file metadata',
        input: { action: 'stat', path: `${TMP}/hello.txt` },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'size|bytes|modified' }],
        },
      },
      {
        name: 'fs.list directory',
        input: { action: 'list', path: TMP },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'hello\\.txt' }],
        },
      },
      {
        name: 'fs.search_text in file',
        input: { action: 'search_text', pattern: 'HIP-0300', path: TMP },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'HIP-0300' }],
        },
      },
      {
        name: 'fs.mkdir creates directory',
        input: { action: 'mkdir', path: `${TMP}/subdir` },
        expect: { success: true },
      },
      {
        name: 'fs.read non-existent returns error',
        input: { action: 'read', path: `${TMP}/does-not-exist.txt` },
        expect: {
          success: false,
          errorPattern: 'not found|ENOENT|no such file|NOT_FOUND',
        },
      },
      {
        name: 'fs.rm cleanup',
        input: { action: 'rm', path: `${TMP}/hello.txt` },
        expect: { success: true },
        cleanup: async () => {
          fs.rmSync(TMP, { recursive: true, force: true });
        },
      },
    ],
  },

  // ─── exec: Execution axis ──────────────────────────────────────────────
  {
    name: 'exec',
    category: 'hip0300-core',
    description: 'Unified execution tool (exec, ps, kill)',
    testCases: [
      {
        name: 'exec.exec echo command',
        input: { action: 'exec', command: 'echo "HIP-0300 conformance"' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'HIP-0300 conformance' }],
        },
      },
      {
        name: 'exec.exec with exit code',
        input: { action: 'exec', command: 'true' },
        expect: { success: true },
      },
      {
        name: 'exec.exec failing command',
        input: { action: 'exec', command: 'false' },
        expect: {
          success: false,
          errorPattern: 'exit|code|failed|error|1',
        },
      },
      {
        name: 'exec.ps list processes',
        input: { action: 'ps' },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 0 }],
        },
      },
    ],
  },

  // ─── code: Symbols + Structure axis ────────────────────────────────────
  {
    name: 'code',
    category: 'hip0300-core',
    description: 'Unified code semantics tool (parse, symbols, summarize)',
    testCases: [
      {
        name: 'code.symbols lists symbols in Python file',
        input: { action: 'symbols', path: `${TMP}/sample.py` },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'greet|hello' }],
        },
        setup: async () => {
          ensureTmp();
          fs.writeFileSync(
            `${TMP}/sample.py`,
            'def greet(name):\n    return f"hello {name}"\n\nclass Greeter:\n    pass\n',
          );
        },
        cleanup: async () => {
          fs.rmSync(TMP, { recursive: true, force: true });
        },
      },
      {
        name: 'code.summarize diff text',
        input: {
          action: 'summarize',
          text: '--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new\n',
        },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 5 }],
        },
      },
    ],
  },

  // ─── git: History + Diffs axis ─────────────────────────────────────────
  {
    name: 'git',
    category: 'hip0300-core',
    description: 'Unified version control tool (status, diff, log, branch)',
    testCases: [
      {
        name: 'git.status in a git repo',
        input: { action: 'status' },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 0 }],
        },
      },
      {
        name: 'git.branch lists branches',
        input: { action: 'branch' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'main|master|\\*' }],
        },
      },
      {
        name: 'git.log shows history',
        input: { action: 'log', limit: 5 },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 10 }],
        },
      },
    ],
  },

  // ─── fetch: Network axis ───────────────────────────────────────────────
  {
    name: 'fetch',
    category: 'hip0300-core',
    description: 'Unified network tool (fetch, search, head)',
    testCases: [
      {
        name: 'fetch.fetch retrieves URL',
        input: { action: 'fetch', url: 'https://httpbin.org/get' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'origin|headers|url' }],
        },
      },
      {
        name: 'fetch.head gets headers',
        input: { action: 'head', url: 'https://httpbin.org/get' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'content-type|200' }],
        },
      },
    ],
  },

  // ─── think: Reasoning axis ─────────────────────────────────────────────
  {
    name: 'think',
    category: 'hip0300-extended',
    description: 'Structured reasoning tool',
    testCases: [
      {
        name: 'think accepts structured thought',
        input: {
          thought: 'Analyzing the trade-offs between consistency and availability in distributed systems.',
        },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 1 }],
        },
      },
    ],
  },

  // ─── memory: Knowledge persistence ─────────────────────────────────────
  {
    name: 'memory',
    category: 'hip0300-extended',
    description: 'Persistent memory tool (store, recall, list, forget)',
    testCases: [
      {
        name: 'memory.store saves a memory',
        input: { action: 'store', key: 'test-conformance', content: 'HIP-0300 test value' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'stored|saved|ok' }],
        },
      },
      {
        name: 'memory.recall retrieves stored memory',
        input: { action: 'recall', key: 'test-conformance' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'HIP-0300 test value' }],
        },
      },
      {
        name: 'memory.list shows stored memories',
        input: { action: 'list' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'test-conformance' }],
        },
      },
      {
        name: 'memory.forget removes memory',
        input: { action: 'forget', key: 'test-conformance' },
        expect: { success: true },
      },
    ],
  },

  // ─── tasks: Task tracking ──────────────────────────────────────────────
  {
    name: 'tasks',
    category: 'hip0300-extended',
    description: 'Task tracking tool (add, list, update, remove)',
    testCases: [
      {
        name: 'tasks.add creates a task',
        input: { action: 'add', title: 'Conformance test task', priority: 'high' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'added|created|task' }],
        },
      },
      {
        name: 'tasks.list shows tasks',
        input: { action: 'list' },
        expect: {
          success: true,
          content: [{ type: 'text', textPattern: 'Conformance test task' }],
        },
      },
    ],
  },

  // ─── mode: Developer modes ─────────────────────────────────────────────
  {
    name: 'mode',
    category: 'hip0300-extended',
    description: 'Mode/personality switching tool',
    testCases: [
      {
        name: 'mode.list shows available modes',
        input: { action: 'list' },
        expect: {
          success: true,
          content: [{ type: 'text', minLength: 5 }],
        },
      },
    ],
  },
];
