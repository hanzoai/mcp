import { describe, test, expect, afterAll } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_PATH = path.resolve(process.cwd(), 'dist', 'cli.js');

interface ClientProfile {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

const CLIENT_PROFILES: ClientProfile[] = [
  {
    clientName: 'claude-code',
    clientVersion: '2.1.0',
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true } },
  },
  {
    clientName: 'codex-cli',
    clientVersion: '0.1.0',
    protocolVersion: '2025-03-26',
    capabilities: {},
  },
  {
    clientName: 'cursor-vscode',
    clientVersion: '1.0.0',
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
  },
  {
    clientName: 'windsurf',
    clientVersion: '1.12.0',
    protocolVersion: '2024-11-05',
    capabilities: {},
  },
  {
    clientName: 'gemini-cli',
    clientVersion: '0.1.0',
    protocolVersion: '2025-03-26',
    capabilities: {},
  },
  {
    clientName: 'Visual Studio Code',
    clientVersion: '1.100.0',
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
  },
];

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

class StdioMcpHarness {
  private child: ReturnType<typeof spawn>;
  private buffer = '';
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private stderrChunks: string[] = [];
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(cwd: string, extraArgs: string[] = ['--core-only']) {
    this.child = spawn(process.execPath, [CLI_PATH, 'serve', ...extraArgs], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        for (const [id, slot] of this.pending.entries()) {
          slot.reject(new Error(`Process exited unexpectedly (${code}/${signal}) waiting for id=${id}`));
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch (err: any) {
          throw new Error(`Non-JSON line leaked to stdout: ${line} (${err.message})`);
        }
        if (msg.id !== undefined) {
          const slot = this.pending.get(msg.id);
          if (slot) {
            this.pending.delete(msg.id);
            if (msg.error) {
              slot.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
            } else {
              slot.resolve(msg.result);
            }
          }
        }
      }
    });

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
  }

  request(id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Timed out waiting for ${method} (id=${id}). stderr=${this.stderrChunks.join('')}`));
        }
      }, 10000);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.child.stdin?.write(JSON.stringify(payload) + '\n');
  }

  async closeWithEof(timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.stdin?.end();
    const timer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, timeoutMs);
    const outcome = await this.exitPromise;
    clearTimeout(timer);
    return outcome;
  }
}

async function parseMcpHttpBody(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();
  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error(`Expected SSE data payload, got headers=${contentType} body=${body}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

describe('Multi-client MCP interoperability matrix', () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
  });

  test.each(CLIENT_PROFILES)(
    'stdio handshake, discovery, call, and clean EOF exit for $clientName ($protocolVersion)',
    async (profile) => {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-mcp-interop-'));
      tempDirs.push(workDir);
      const probeFile = path.join(workDir, 'interop-probe.txt');
      const expectedText = `interop-${profile.clientName}`;
      await fs.writeFile(probeFile, expectedText, 'utf8');

      const harness = new StdioMcpHarness(workDir, ['--core-only']);
      const initResult = await harness.request(1, 'initialize', {
        protocolVersion: profile.protocolVersion,
        capabilities: profile.capabilities,
        clientInfo: { name: profile.clientName, version: profile.clientVersion },
      });

      expect(initResult?.serverInfo?.name).toBe('hanzo-mcp');
      expect(typeof initResult?.protocolVersion).toBe('string');
      expect(initResult?.capabilities?.tools).toBeDefined();
      expect(initResult?.capabilities?.resources).toBeDefined();

      harness.notify('notifications/initialized');

      const listResult = await harness.request(2, 'tools/list');
      const toolNames = (listResult?.tools || []).map((t: any) => t.name);
      expect(toolNames).toEqual(expect.arrayContaining(['fs', 'exec', 'code', 'git', 'fetch', 'workspace', 'ui']));

      const callResult = await harness.request(3, 'tools/call', {
        name: 'fs',
        arguments: { action: 'read', uri: probeFile },
      });
      expect(callResult?.isError).not.toBe(true);
      expect(JSON.stringify(callResult)).toContain(expectedText);

      const resourcesResult = await harness.request(4, 'resources/list');
      expect((resourcesResult?.resources || []).map((r: any) => r.uri)).toContain('hanzo://system-prompt');

      const exitOutcome = await harness.closeWithEof(5000);
      expect(exitOutcome.code).toBe(0);
      expect(exitOutcome.signal).toBeNull();
    },
    20000,
  );

  test(
    'streamable HTTP and -t sse alias handle health, CORS, 405 GET, strict Accept clients, and clean shutdown',
    async () => {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-mcp-http-'));
      tempDirs.push(workDir);

      const child = spawn(process.execPath, [CLI_PATH, 'serve', '-t', 'sse', '--port', '0', '--core-only'], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stderrLog = '';
      const boundPort = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`HTTP server did not bind in time. stderr=${stderrLog}`));
        }, 10000);

        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderrLog += chunk;
          const match = stderrLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(Number.parseInt(match[1], 10));
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`HTTP server exited early with code=${code}. stderr=${stderrLog}`));
        });
      });

      try {
        const baseUrl = `http://127.0.0.1:${boundPort}`;

        const healthRes = await fetch(`${baseUrl}/health`, {
          headers: { Connection: 'close' },
        });
        expect(healthRes.status).toBe(200);
        const healthBody = await healthRes.json() as any;
        expect(healthBody.ok).toBe(true);
        expect(healthBody.name).toBe('hanzo-mcp');

        const optionsRes = await fetch(`${baseUrl}/v1/mcp`, {
          method: 'OPTIONS',
          headers: { Connection: 'close' },
        });
        expect(optionsRes.status).toBe(204);
        expect(optionsRes.headers.get('access-control-allow-origin')).toBe('*');

        const getRes = await fetch(`${baseUrl}/v1/mcp`, {
          method: 'GET',
          headers: { Connection: 'close' },
        });
        expect(getRes.status).toBe(405);

        const sseInitRes = await fetch(`${baseUrl}/v1/mcp`, {
          method: 'POST',
          headers: {
            Connection: 'close',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'http-sse-client', version: '1.0.0' },
            },
          }),
        });
        expect(sseInitRes.status).toBe(200);
        const sseInitJson = await parseMcpHttpBody(sseInitRes);
        expect(sseInitJson.result?.serverInfo?.name).toBe('hanzo-mcp');

        const jsonOnlyListRes = await fetch(`${baseUrl}/v1/mcp`, {
          method: 'POST',
          headers: {
            Connection: 'close',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Mcp-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          }),
        });
        expect(jsonOnlyListRes.status).toBe(200);
        expect(jsonOnlyListRes.headers.get('content-type')).toContain('application/json');
        const jsonOnlyList = await parseMcpHttpBody(jsonOnlyListRes);
        const listedNames = (jsonOnlyList.result?.tools || []).map((t: any) => t.name);
        expect(listedNames).toEqual(expect.arrayContaining(['fs', 'exec', 'code']));
      } finally {
        const exited = new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
        child.kill('SIGTERM');
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            killTimer = setTimeout(resolve, 3000);
            killTimer.unref();
          }),
        ]);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    },
    20000,
  );

  test(
    'install writes verified non-destructive configs across Cursor, Windsurf, Gemini CLI, VS Code, Codex, and Claude Code',
    async () => {
      const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-mcp-home-'));
      tempDirs.push(fakeHome);

      // Seed existing client config to ensure install merges rather than overwrites
      await fs.mkdir(path.join(fakeHome, '.gemini'), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, '.gemini', 'settings.json'),
        JSON.stringify({ theme: 'Default', mcpServers: { existing: { command: 'echo', args: ['hi'] } } }, null, 2),
        'utf8',
      );
      await fs.mkdir(path.join(fakeHome, '.codex'), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, '.codex', 'config.toml'),
        'model = "gpt-5-codex"\n\n[mcp_servers.hanzo]\ncommand = "old"\nargs = ["stale"]\n',
        'utf8',
      );

      // Stand-in claude shim on PATH to capture argv without invoking external CLI
      const shimDir = path.join(fakeHome, 'bin');
      const argvOut = path.join(fakeHome, 'claude-argv.txt');
      await fs.mkdir(shimDir, { recursive: true });
      const recordScript = path.join(shimDir, 'record-claude.mjs');
      await fs.writeFile(
        recordScript,
        "import fs from 'node:fs'; fs.writeFileSync(process.env.HANZO_TEST_ARGV_OUT, process.argv.slice(2).join(' '));\n",
        'utf8',
      );
      await fs.writeFile(
        path.join(shimDir, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${recordScript}" "$@"\n`,
        { mode: 0o755 },
      );
      if (process.platform === 'win32') {
        await fs.writeFile(
          path.join(shimDir, 'claude.cmd'),
          `@echo off\r\n"${process.execPath}" "${recordScript}" %*\r\n`,
          'utf8',
        );
      }

      const env = {
        ...process.env,
        HANZO_MCP_HOME: fakeHome,
        HANZO_TEST_ARGV_OUT: argvOut,
        PATH: [
          shimDir,
          path.dirname(process.execPath),
          ...(process.platform === 'win32'
            ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
            : ['/usr/bin', '/bin']),
        ].join(path.delimiter),
      };

      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'install', '--cursor', '--windsurf', '--gemini', '--vscode', '--codex', '--claude-code'],
        { cwd: fakeHome, env, encoding: 'utf8', timeout: 15000 },
      );
      expect(res.status).toBe(0);

      const cursorCfg = JSON.parse(await fs.readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'));
      expect(cursorCfg.mcpServers['hanzo-mcp'].command).toBe('npx');

      const windsurfCfg = JSON.parse(
        await fs.readFile(path.join(fakeHome, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'),
      );
      expect(windsurfCfg.mcpServers['hanzo-mcp'].command).toBe('npx');

      const geminiCfg = JSON.parse(await fs.readFile(path.join(fakeHome, '.gemini', 'settings.json'), 'utf8'));
      expect(geminiCfg.theme).toBe('Default');
      expect(geminiCfg.mcpServers.existing).toBeDefined();
      expect(geminiCfg.mcpServers['hanzo-mcp'].command).toBe('npx');

      const vscodePath =
        process.platform === 'win32'
          ? path.join(fakeHome, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
          : process.platform === 'darwin'
            ? path.join(fakeHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
            : path.join(fakeHome, '.config', 'Code', 'User', 'mcp.json');
      const vscodeCfg = JSON.parse(await fs.readFile(vscodePath, 'utf8'));
      expect(vscodeCfg.servers['hanzo-mcp'].type).toBe('stdio');

      const codexToml = await fs.readFile(path.join(fakeHome, '.codex', 'config.toml'), 'utf8');
      expect(codexToml).toContain('model = "gpt-5-codex"');
      expect(codexToml).toContain('[mcp_servers.hanzo]');
      expect(codexToml).not.toContain('command = "old"');

      const claudeArgv = (await fs.readFile(argvOut, 'utf8')).trim();
      expect(claudeArgv).toBe('mcp add --scope user hanzo -- npx -y @hanzo/mcp serve');
    },
    20000,
  );
});
