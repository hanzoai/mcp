/**
 * End-to-end JSON-RPC stdio test harness for HIP-0300 unified tools (Issue #73).
 *
 * Spawns `dist/cli.js serve` in an isolated temporary workspace with a local git
 * repository, an ephemeral local HTTP server for offline `fetch` verification,
 * and isolated store paths (`MEMORY_PATH`, `PLAN_PATH`, `TODO_PATH`, `HOME`).
 *
 * Exercises:
 *   1. `initialize` + `notifications/initialized` + `tools/list` schema checks
 *   2. Happy-path and invalid-argument error paths for all 13 unified tools:
 *      fs, exec, code, git, fetch, workspace, computer, think, memory,
 *      hanzo, plan, tasks, ui
 *   3. Stdio framing edge cases (chunked JSON-RPC frames and zero stdout noise)
 */

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

jest.setTimeout(30000);

const REQUIRED_13_UNIFIED_TOOLS = [
  'fs',
  'exec',
  'code',
  'git',
  'fetch',
  'workspace',
  'computer',
  'think',
  'memory',
  'hanzo',
  'plan',
  'tasks',
  'ui',
] as const;

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly exitPromise: Promise<void>;
  private buffer = '';
  private nextId = 1;
  public readonly nonJsonStdoutLines: string[] = [];
  public readonly rawStdoutLines: string[] = [];
  public readonly stderrChunks: string[] = [];

  constructor(cliPath: string, cwd: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [cliPath, 'serve'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk);
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        this.rawStdoutLines.push(line);

        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          this.nonJsonStdoutLines.push(line);
          continue;
        }

        if (msg.id !== undefined && msg.id !== null) {
          const waiter = this.pending.get(Number(msg.id));
          if (waiter) {
            this.pending.delete(Number(msg.id));
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
          }
        }
      }
    });
  }

  public sendNotification(method: string, params?: Record<string, unknown>): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    this.child.stdin.write(`${payload}\n`);
  }

  public request(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (id=${id}). stderr=${this.stderrChunks.join('').slice(-500)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  public requestChunked(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const midpoint = Math.floor(payload.length / 2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for chunked ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload.slice(0, midpoint));
      setTimeout(() => {
        this.child.stdin.write(`${payload.slice(midpoint)}\n`);
      }, 20);
    });
  }

  public callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    return this.request('tools/call', { name, arguments: args });
  }

  public async close(): Promise<void> {
    for (const [id, waiter] of this.pending.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Client closed while request ${id} pending`));
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {
      // Ignore already closed stream
    }
    if (this.child.exitCode === null && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
      }, 2000);
      await this.exitPromise;
      clearTimeout(killTimer);
    }
  }
}

function extractText(result: any): string {
  expect(Array.isArray(result?.content)).toBe(true);
  expect(result.content.length).toBeGreaterThan(0);
  return String(result.content[0].text ?? '');
}

describe('Stdio JSON-RPC E2E Harness (Issue #73)', () => {
  let tmpRoot: string;
  let httpServer: http.Server;
  let localBaseUrl: string;
  let client: StdioMcpClient;
  let listedTools: any[] = [];

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-mcp-stdio-e2e-'));
    await fs.writeFile(
      path.join(tmpRoot, 'sample.ts'),
      'export function greetUser(name: string): string {\n  return `Hello, ${name}`;\n}\n\nexport class SampleService {}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'isolated-e2e-fixture', private: true }, null, 2),
      'utf8',
    );

    execFileSync('git', ['init'], { cwd: tmpRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'harness@hanzo.test'], { cwd: tmpRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Harness'], { cwd: tmpRoot, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: tmpRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial fixture'], { cwd: tmpRoot, stdio: 'ignore' });

    httpServer = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', source: 'stdio-harness' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const addr = httpServer.address() as AddressInfo;
    localBaseUrl = `http://127.0.0.1:${addr.port}`;

    const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
    const stateDir = path.join(tmpRoot, '.hanzo-state');
    await fs.mkdir(stateDir, { recursive: true });

    client = new StdioMcpClient(cliPath, tmpRoot, {
      ...process.env,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      MEMORY_PATH: path.join(stateDir, 'memory.json'),
      PLAN_PATH: path.join(stateDir, 'plans.json'),
      TODO_PATH: path.join(stateDir, 'todos.json'),
      HANZO_API_KEY: '',
      HANZO_USER_KEY: '',
      API_KEY: '',
      HANZO_TOKEN: '',
    });

    const initResp = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-jsonrpc-harness', version: '1.0.0' },
    });
    expect(initResp.error).toBeUndefined();
    expect(initResp.result?.serverInfo?.name).toBe('hanzo-mcp');

    client.sendNotification('notifications/initialized');

    const listResp = await client.request('tools/list', {});
    expect(listResp.error).toBeUndefined();
    listedTools = listResp.result?.tools ?? [];
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('tools/list validates schema integrity and all 13 unified tools', () => {
    const names = listedTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);

    for (const requiredName of REQUIRED_13_UNIFIED_TOOLS) {
      expect(names).toContain(requiredName);
    }

    for (const tool of listedTools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.trim().length).toBeGreaterThan(0);

      const schema = tool.inputSchema;
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(typeof schema.properties).toBe('object');
      expect(Array.isArray(schema.properties)).toBe(false);

      if (schema.required !== undefined) {
        expect(Array.isArray(schema.required)).toBe(true);
        for (const reqField of schema.required) {
          expect(typeof reqField).toBe('string');
          expect(Object.prototype.hasOwnProperty.call(schema.properties, reqField)).toBe(true);
        }
      }

      for (const [, propSchema] of Object.entries<any>(schema.properties)) {
        expect(propSchema).toBeDefined();
        expect(typeof propSchema).toBe('object');
        if (propSchema.type === 'array') {
          expect(propSchema.items).toBeDefined();
        }
        if (propSchema.enum !== undefined) {
          expect(Array.isArray(propSchema.enum)).toBe(true);
          expect(propSchema.enum.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('chunked stdio JSON-RPC framing reassembles cleanly', async () => {
    const resp = await client.requestChunked('tools/call', {
      name: 'workspace',
      arguments: { action: 'help' },
    });
    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    const parsed = JSON.parse(extractText(resp.result));
    expect(parsed.ok).toBe(true);
    expect(parsed.meta?.tool).toBe('workspace');
  });

  test('fs: happy-path roundtrip and invalid-argument error path', async () => {
    const targetFile = path.join(tmpRoot, 'harness-note.txt');

    const writeResp = await client.callTool('fs', { action: 'write', uri: targetFile, content: 'line1\nline2\n' });
    expect(writeResp.result?.isError).toBeFalsy();
    const writeJson = JSON.parse(extractText(writeResp.result));
    expect(writeJson.ok).toBe(true);
    expect(writeJson.data.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const readResp = await client.callTool('fs', { action: 'read', uri: targetFile });
    expect(readResp.result?.isError).toBeFalsy();
    const readJson = JSON.parse(extractText(readResp.result));
    expect(readJson.data.text).toContain('line1');

    const rmResp = await client.callTool('fs', { action: 'rm', uri: targetFile, confirm: true });
    expect(rmResp.result?.isError).toBeFalsy();

    const missingUriResp = await client.callTool('fs', { action: 'read' });
    expect(missingUriResp.result?.isError).toBe(true);
    const badActionResp = await client.callTool('fs', { action: 'invalid_fs_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('INVALID_PARAMS');
  });

  test('exec: happy-path command execution and invalid-argument error path', async () => {
    const okResp = await client.callTool('exec', {
      action: 'exec',
      command: `"${process.execPath}" -e "console.log('stdio-exec-ok')"`,
    });
    expect(okResp.result?.isError).toBeFalsy();
    const okJson = JSON.parse(extractText(okResp.result));
    expect(okJson.ok).toBe(true);
    expect(okJson.data.stdout).toContain('stdio-exec-ok');

    const psResp = await client.callTool('exec', { action: 'ps' });
    expect(psResp.result?.isError).toBeFalsy();

    const missingCmdResp = await client.callTool('exec', { action: 'exec' });
    expect(missingCmdResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(missingCmdResp.result)).error?.code).toBe('INVALID_PARAMS');

    const badActionResp = await client.callTool('exec', { action: 'invalid_exec_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('UNKNOWN_ACTION');
  });

  test('code: happy-path AST symbol outline and invalid-argument error path', async () => {
    const sampleFile = path.join(tmpRoot, 'sample.ts');
    const outlineResp = await client.callTool('code', { action: 'outline', uri: sampleFile });
    expect(outlineResp.result?.isError).toBeFalsy();
    const outlineJson = JSON.parse(extractText(outlineResp.result));
    expect(outlineJson.ok).toBe(true);
    const symbolNames = outlineJson.data.symbols.map((s: any) => s.name);
    expect(symbolNames).toContain('greetUser');
    expect(symbolNames).toContain('SampleService');

    const missingUriResp = await client.callTool('code', { action: 'outline' });
    expect(missingUriResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(missingUriResp.result)).error?.code).toBe('INVALID_PARAMS');

    const badActionResp = await client.callTool('code', { action: 'invalid_code_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('UNKNOWN_ACTION');
  });

  test('git: happy-path status/log and invalid-argument error path', async () => {
    const statusResp = await client.callTool('git', { action: 'status', path: tmpRoot });
    expect(statusResp.result?.isError).toBeFalsy();
    expect(extractText(statusResp.result).length).toBeGreaterThan(0);

    const logResp = await client.callTool('git', { action: 'log', path: tmpRoot, limit: 5 });
    expect(logResp.result?.isError).toBeFalsy();
    expect(extractText(logResp.result)).toContain('Initial fixture');

    const missingMsgResp = await client.callTool('git', { action: 'commit', path: tmpRoot });
    expect(missingMsgResp.result?.isError).toBe(true);

    const badActionResp = await client.callTool('git', { action: 'invalid_git_action', path: tmpRoot });
    expect(badActionResp.result?.isError).toBe(true);
  });

  test('fetch: happy-path local HTTP request and invalid-argument error path', async () => {
    const okResp = await client.callTool('fetch', { action: 'request', url: `${localBaseUrl}/ok` });
    expect(okResp.result?.isError).toBeFalsy();
    const okJson = JSON.parse(extractText(okResp.result));
    expect(okJson.ok).toBe(true);
    expect(okJson.data.status).toBe(200);
    expect(okJson.data.body).toEqual({ status: 'ok', source: 'stdio-harness' });

    const missingUrlRequest = await client.callTool('fetch', { action: 'request' });
    expect(missingUrlRequest.result?.isError).toBe(true);
    expect(JSON.parse(extractText(missingUrlRequest.result)).error?.code).toBe('INVALID_PARAMS');

    const missingUrlOpen = await client.callTool('fetch', { action: 'open' });
    expect(missingUrlOpen.result?.isError).toBe(true);
    expect(JSON.parse(extractText(missingUrlOpen.result)).error?.code).toBe('INVALID_PARAMS');

    const badActionResp = await client.callTool('fetch', { action: 'invalid_fetch_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('UNKNOWN_ACTION');
  });

  test('workspace: happy-path detect/system and invalid-argument error path', async () => {
    const detectResp = await client.callTool('workspace', { action: 'detect', path: tmpRoot });
    expect(detectResp.result?.isError).toBeFalsy();
    const detectJson = JSON.parse(extractText(detectResp.result));
    expect(detectJson.ok).toBe(true);
    expect(detectJson.data.vcs).toBe('git');
    expect(detectJson.data.languages).toContain('javascript');

    const badActionResp = await client.callTool('workspace', { action: 'invalid_workspace_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('UNKNOWN_ACTION');
  });

  test('computer: happy-path info and invalid-argument error path', async () => {
    const infoResp = await client.callTool('computer', { action: 'info' });
    expect(infoResp.result?.isError).toBeFalsy();
    const infoJson = JSON.parse(extractText(infoResp.result));
    expect(infoJson.ok).toBe(true);
    expect(infoJson.data.platform).toBe(process.platform);

    const badActionResp = await client.callTool('computer', { action: 'invalid_computer_action' });
    expect(badActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badActionResp.result)).error?.code).toBe('UNSUPPORTED');
  });

  test('think: happy-path scratchpad/critic and invalid-argument error path', async () => {
    const thinkResp = await client.callTool('think', {
      action: 'think',
      thought: 'Validating structured reasoning over stdio JSON-RPC',
    });
    expect(thinkResp.result?.isError).toBeFalsy();
    expect(extractText(thinkResp.result)).toContain('Thinking:');

    const missingTextResp = await client.callTool('think', { action: 'summarize' });
    expect(missingTextResp.result?.isError).toBe(true);

    const badActionResp = await client.callTool('think', { action: 'invalid_think_action' });
    expect(badActionResp.result?.isError).toBe(true);
  });

  test('memory: happy-path isolated store/recall and invalid-argument error path', async () => {
    const storeResp = await client.callTool('memory', {
      action: 'store',
      key: 'e2e-key',
      value: 'isolated-memory-value',
    });
    expect(storeResp.result?.isError).toBeFalsy();
    expect(extractText(storeResp.result)).toContain('e2e-key');

    const recallResp = await client.callTool('memory', { action: 'recall', key: 'e2e-key' });
    expect(recallResp.result?.isError).toBeFalsy();
    expect(extractText(recallResp.result)).toContain('isolated-memory-value');

    const missingValResp = await client.callTool('memory', { action: 'store', key: 'only-key' });
    expect(missingValResp.result?.isError).toBe(true);

    const badActionResp = await client.callTool('memory', { action: 'invalid_memory_action' });
    expect(badActionResp.result?.isError).toBe(true);
  });

  test('hanzo: happy-path resource discovery/auth status and invalid-argument error path', async () => {
    const listResp = await client.callTool('hanzo', {});
    expect(listResp.result?.isError).toBeFalsy();
    const listJson = JSON.parse(extractText(listResp.result));
    expect(listJson.ok).toBe(true);
    expect(listJson.data.resources).toContain('auth');

    const authStatusResp = await client.callTool('hanzo', { resource: 'auth', action: 'status' });
    expect(authStatusResp.result?.isError).toBeFalsy();
    const authJson = JSON.parse(extractText(authStatusResp.result));
    expect(authJson.ok).toBe(true);
    expect(authJson.data.authenticated).toBe(false);

    const badAuthActionResp = await client.callTool('hanzo', { resource: 'auth', action: 'invalid_auth_action' });
    expect(badAuthActionResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(badAuthActionResp.result)).error?.code).toBe('INVALID_ARGS');

    const unknownResResp = await client.callTool('hanzo', { resource: 'nonexistent_subsystem_xyz' });
    expect(unknownResResp.result?.isError).toBe(true);
    expect(JSON.parse(extractText(unknownResResp.result)).error?.code).toBe('NOT_FOUND');
  });

  test('plan: happy-path create/list and invalid-argument error path', async () => {
    const createResp = await client.callTool('plan', {
      action: 'create',
      name: 'Stdio Harness Plan',
      goal: 'Verify isolated plan persistence',
      steps: [{ description: 'Step 1: validate schema' }],
    });
    expect(createResp.result?.isError).toBeFalsy();
    expect(extractText(createResp.result)).toContain('Stdio Harness Plan');

    const listResp = await client.callTool('plan', { action: 'list' });
    expect(listResp.result?.isError).toBeFalsy();
    expect(extractText(listResp.result)).toContain('Stdio Harness Plan');

    const missingStepsResp = await client.callTool('plan', { action: 'create', name: 'Incomplete' });
    expect(missingStepsResp.result?.isError).toBe(true);

    const badActionResp = await client.callTool('plan', { action: 'invalid_plan_action' });
    expect(badActionResp.result?.isError).toBe(true);
  });

  test('tasks: happy-path add/list and invalid-argument error path', async () => {
    const addResp = await client.callTool('tasks', {
      action: 'add',
      content: 'Verify stdio task persistence',
    });
    expect(addResp.result?.isError).toBeFalsy();
    expect(extractText(addResp.result)).toContain('Verify stdio task persistence');

    const listResp = await client.callTool('tasks', { action: 'list' });
    expect(listResp.result?.isError).toBeFalsy();
    expect(extractText(listResp.result)).toContain('Verify stdio task persistence');

    const missingContentResp = await client.callTool('tasks', { action: 'add' });
    expect(missingContentResp.result?.isError).toBe(true);

    const badActionResp = await client.callTool('tasks', { action: 'invalid_tasks_action' });
    expect(badActionResp.result?.isError).toBe(true);
  });

  test('ui: happy-path offline framework/composition and invalid-argument error path', async () => {
    const setFwResp = await client.callTool('ui', { method: 'set_framework', framework: 'hanzo' });
    expect(setFwResp.result?.isError).toBeFalsy();
    expect(extractText(setFwResp.result)).toContain('Hanzo UI');

    const compResp = await client.callTool('ui', {
      method: 'create_composition',
      name: 'HarnessCard',
      components: ['button', 'card'],
      description: 'Offline composition test',
      framework: 'hanzo',
    });
    expect(compResp.result?.isError).toBeFalsy();
    expect(extractText(compResp.result)).toContain('export function HarnessCard');

    const missingMethodResp = await client.callTool('ui', {});
    expect(missingMethodResp.result?.isError).toBe(true);

    const badMethodResp = await client.callTool('ui', { method: 'invalid_ui_method' });
    expect(badMethodResp.result?.isError).toBe(true);
  });

  test('stdout emits strictly valid JSON-RPC frames with zero non-JSON noise', () => {
    expect(client.nonJsonStdoutLines).toEqual([]);
    expect(client.rawStdoutLines.length).toBeGreaterThan(20);
  });
});
