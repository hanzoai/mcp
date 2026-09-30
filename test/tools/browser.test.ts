/**
 * browser and cdp over a real ZAP router elected by ANOTHER process.
 *
 * The router is zapd from PyPI, embedded by a Python child exactly as Python
 * hanzo-mcp embeds it, on a private XDG_RUNTIME_DIR / XDG_STATE_HOME / HOME:
 * nothing here touches the router (or the browser) of the user running it. A
 * fake extension joins that router over its unix socket as
 * `browser/chrome-test` and answers every ROUTE with the method and params it
 * decoded; the tools under test are this runtime's consumer seat.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { browserTool, cdpTool } from '../../src/tools/browser.js';
import * as zap from '../../src/zap.js';

let dir: string;
let router: ChildProcess;
let provider: net.Socket;

/** The extension's decodeCmd, for the fake. */
function decodeCmd(p: Buffer): { method: string; params: Record<string, string> } {
  let o = 0;
  const s = (n: number) => { const v = p.toString('utf8', o, o + n); o += n; return v; };
  const method = s(p.readUInt16LE((o += 2) - 2));
  const params: Record<string, string> = {};
  for (let n = p.readUInt16LE((o += 2) - 2); n > 0; n--) {
    const k = s(p.readUInt16LE((o += 2) - 2));
    params[k] = s(p.readUInt32LE((o += 4) - 4));
  }
  return { method, params };
}

async function until<T>(f: () => Promise<T | null> | T | null, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(f).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const body = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(body(r));

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-ts-'));
  const run = path.join(dir, 'run'), state = path.join(dir, 'state', 'zap'), home = path.join(dir, 'home');
  fs.mkdirSync(run, { mode: 0o700 });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home);
  // The door binds the port the pairing names: pin it to one nothing else
  // wants, never a well-known port a real extension sweeps.
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  fs.writeFileSync(path.join(state, 'pair'), `ws://127.0.0.1:${port}/#${'07'.repeat(32)}\n`, { mode: 0o600 });

  process.env.XDG_RUNTIME_DIR = run;
  process.env.BROWSER_BACKEND = 'auto';
  router = spawn('uv', ['run', '--no-project', '--quiet', '--with', 'zapd==1.1.5', 'python', '-c',
    'import sys, zapd; zapd.embed(); sys.stdin.read()'], {
    env: { ...process.env, XDG_RUNTIME_DIR: run, XDG_STATE_HOME: path.join(dir, 'state'), HOME: home },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const sock = path.join(run, 'zap', 'zapd.sock');
  await until(() => fs.existsSync(sock), 'the router socket');

  provider = await until(() => new Promise<net.Socket | null>((resolve) => {
    const s = net.connect(sock, () => resolve(s));
    s.on('error', () => resolve(null));
  }), 'a connection to the router');
  let buf: Buffer = Buffer.alloc(0);
  provider.on('data', (chunk: Buffer) => {
    let frames: zap.Frame[];
    [frames, buf] = zap.decodeFrames(Buffer.concat([buf, chunk]));
    for (const f of frames) {
      if (f.t !== zap.ROUTE) continue;
      const { method, params } = decodeCmd(f.payload);
      const reply = method === 'hanzo.snapshot'
        ? JSON.stringify({ title: 'Example', url: 'https://example.com/', refs: 1, tree: '- button "Go" [ref=e1]' })
        : params.selector === '@e9' ? 'ERR:@e9 is stale: snapshot again' : JSON.stringify({ method, params });
      provider.write(zap.encodeFrame(zap.RESPONSE, '', f.from, Buffer.from(reply)));
    }
  });
  provider.write(zap.encodeFrame(zap.HELLO, 'browser/chrome-test', '', zap.encodeHello(zap.ROLE_PROVIDER, 'hanzo', ['browser.tabs'])));
  await until(() => zap.resolve(), 'the fake browser on the router');
}, 120_000);

afterAll(() => {
  zap.getSeat().close();
  provider?.destroy();
  router?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('browser over ZAP', () => {
  test('browsers lists the node the router registered', async () => {
    const v = json(await browserTool.handler({ action: 'browsers' }));
    expect(v.count).toBe(1);
    expect(v.browsers[0].id).toMatch(/^browser\/[a-z0-9-]+\/chrome-test$/);
    expect(v.browsers[0].role).toBe('provider');
    expect(await zap.resolve('chrome')).toBe(v.browsers[0].id);
    expect(await zap.resolve('firefox')).toBeNull();
  });

  test('an action routes as its extension method, with the wire params', async () => {
    let v = json(await browserTool.handler({ action: 'click', selector: '@e1', tab_id: 'tab-7' }));
    expect(v).toMatchObject({ success: true, method: 'hanzo.act', params: { op: 'click', selector: '@e1', tabId: '7' } });

    v = json(await browserTool.handler({ action: 'select', selector: '#plan', args: { value: 'Weekly' } }));
    expect(v.params).toEqual({ op: 'select', selector: '#plan', value: 'Weekly' });

    v = json(await browserTool.handler({ action: 'evaluate', code: 'document.title' }));
    expect(JSON.parse(v.result)).toEqual({ method: 'Runtime.evaluate', params: { expression: 'document.title' } });
  });

  test('snapshot answers text; a refusal is an error and never falls back', async () => {
    expect(body(await browserTool.handler({ action: 'snapshot', interactive: true })))
      .toBe('Example — https://example.com/ (1 refs)\n- button "Go" [ref=e1]');
    const r: any = await browserTool.handler({ action: 'click', selector: '@e9' });
    expect(r.isError).toBe(true);
    expect(json(r).error).toBe('@e9 is stale: snapshot again');
    const f = json(await browserTool.handler({ action: 'click', selector: '@e1', target_browser: 'firefox' }));
    expect(f.error).toMatch(/^no browser on the ZAP router/);
  });

  test('cdp sends the method verbatim', async () => {
    const v = json(await cdpTool.handler({ action: 'send', method: 'Page.navigate', params: { url: 'https://example.com', n: 2 }, tab_id: 7 }));
    expect(v.transport).toBe('native-zap');
    expect(JSON.parse(v.result)).toEqual({ method: 'Page.navigate', params: { url: 'https://example.com', n: '2', tabId: '7' } });
    expect(JSON.parse(json(await cdpTool.handler({ action: 'tabs' })).result).method).toBe('Target.getTargets');
  });

  test('with no router the seat says so at once, and never stands for one', async () => {
    const empty = fs.mkdtempSync(path.join(dir, 'none-'));
    fs.mkdirSync(path.join(empty, 'zap'), { mode: 0o700 });
    const was = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = empty;
    try {
      await expect(new zap.Seat().nodes()).rejects.toThrow(zap.NO_ROUTER);
      expect(fs.readdirSync(path.join(empty, 'zap'))).toEqual([]);
    } finally {
      process.env.XDG_RUNTIME_DIR = was;
    }
  });

  test('help, unknown actions and unknown args are answered locally', async () => {
    expect(body(await browserTool.handler({ action: 'help', topic: 'tabs' }))).toMatch(/^tabs\n {2}new_tab/);
    expect(json(await browserTool.handler({ action: 'nope' })).error).toMatch(/^Unknown action "nope"\. Core: navigate, snapshot/);
    expect(json(await browserTool.handler({ action: 'click', args: { bogus: 1 } })).error).toMatch(/^Unknown args/);
  });
});
