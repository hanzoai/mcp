/**
 * Zero-Playwright Native WebSocket CDP + WebMCP + Snapshot Engine for `hanzo-mcp`.
 *
 * Mirrors `@hanzo/browser`'s headless CDP driver: spawns local Chrome / Chromium /
 * Lightpanda / Obscura with Chrome WebMCP flags enabled by default (unless
 * `HANZO_BROWSER_NO_WEBMCP=1` or `AGENT_BROWSER_NO_WEBMCP=1` is set), speaks raw
 * CDP over built-in Node RFC 6455 WebSockets, and injects the exact `PAGE_BUNDLE`
 * (`snapshot.ts` + `read.ts` + `keys.ts`) so `@e1` refs, `>>>` shadow-DOM selectors,
 * and WebMCP catalog diffing work identically without Playwright.
 */

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import { PAGE_BUNDLE } from './page-bundle.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type HeadlessEngineName = 'chrome' | 'lightpanda' | 'obscura';

export interface WebMCPToolSummary {
  name: string;
  description: string;
  origin: string;
  frameId: number | string;
}

export interface WebMCPToolSchema extends WebMCPToolSummary {
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  declarative?: boolean;
}

export function isWebMCPDisabled(explicitOptOut?: boolean): boolean {
  if (explicitOptOut) return true;
  const off = (v: string | undefined) => v === '1' || /^true$/i.test(v || '');
  return off(process.env.HANZO_BROWSER_NO_WEBMCP) || off(process.env.AGENT_BROWSER_NO_WEBMCP);
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class WebMCPCatalogTracker {
  private lastHash: string | undefined;

  reset(): void {
    this.lastHash = undefined;
  }

  update(frames: Array<{ frameId: number; origin: string; tools: any[] }>): { tools: WebMCPToolSummary[] } | undefined {
    const sortedFrames = [...frames].sort((a, b) => a.frameId - b.frameId);
    const flatFull: any[] = [];
    const summaries: WebMCPToolSummary[] = [];

    for (const f of sortedFrames) {
      const tools = [...(f.tools || [])]
        .filter((t) => t && typeof t.name === 'string' && t.name.trim() !== '')
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const t of tools) {
        const desc = String(t.description ?? '').replace(/\s+/g, ' ').trim();
        flatFull.push({
          frameId: f.frameId,
          origin: f.origin,
          name: t.name.trim(),
          description: desc,
          inputSchema: t.inputSchema ?? null,
          annotations: t.annotations ?? null,
        });
        summaries.push({
          name: t.name.trim(),
          description: desc.length > 160 ? `${desc.slice(0, 159)}…` : desc,
          origin: f.origin,
          frameId: f.frameId,
        });
      }
    }

    const nextHash = flatFull.length === 0 ? 'empty' : fnv1a(JSON.stringify(flatFull));
    const prevHash = this.lastHash;
    this.lastHash = nextHash;

    if (flatFull.length === 0) return undefined;
    if (prevHash === nextHash) return undefined;
    return { tools: summaries };
  }
}

const WEBMCP_RUNTIME_SCRIPT = `
(async (op, payload) => {
  const g = globalThis;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (!g.__hanzoWebMCP || !g.__hanzoWebMCP.__installed) {
    const registered = new Map();
    const contextTools = new Map();
    const norm = (t) => {
      if (!t || typeof t.name !== 'string' || !t.name.trim()) return null;
      return {
        name: t.name.trim(),
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : undefined,
        execute: typeof t.execute === 'function' ? t.execute : (typeof t.handler === 'function' ? t.handler : undefined),
      };
    };
    const nativeMC = nav && nav.modelContext;
    const origReg = nativeMC && typeof nativeMC.registerTool === 'function' ? nativeMC.registerTool.bind(nativeMC) : null;
    const origUnreg = nativeMC && typeof nativeMC.unregisterTool === 'function' ? nativeMC.unregisterTool.bind(nativeMC) : null;
    const origProvide = nativeMC && typeof nativeMC.provideContext === 'function' ? nativeMC.provideContext.bind(nativeMC) : null;
    const origClear = nativeMC && typeof nativeMC.clearContext === 'function' ? nativeMC.clearContext.bind(nativeMC) : null;

    const api = {
      __installed: true,
      registerTool(tool, opts) {
        const n = norm(tool);
        if (n) registered.set(n.name, n);
        if (origReg) { try { return origReg(tool, opts); } catch {} }
        return { unregister: () => api.unregisterTool(n ? n.name : '') };
      },
      unregisterTool(name) {
        registered.delete(String(name));
        contextTools.delete(String(name));
        if (origUnreg) { try { return origUnreg(name); } catch {} }
      },
      provideContext(ctx) {
        contextTools.clear();
        if (ctx && Array.isArray(ctx.tools)) {
          for (const t of ctx.tools) {
            const n = norm(t);
            if (n) contextTools.set(n.name, n);
          }
        }
        if (origProvide) { try { return origProvide(ctx); } catch {} }
      },
      clearContext() {
        registered.clear();
        contextTools.clear();
        if (origClear) { try { return origClear(); } catch {} }
      },
      _getImperative() {
        const merged = new Map();
        for (const [k, v] of contextTools) merged.set(k, v);
        for (const [k, v] of registered) merged.set(k, v);
        if (Array.isArray(g.__hanzoWebMCP?.tools)) {
          for (const item of g.__hanzoWebMCP.tools) {
            const n = norm(item);
            if (n && !merged.has(n.name)) merged.set(n.name, n);
          }
        }
        return merged;
      },
    };
    if (nav) {
      if (nativeMC && typeof nativeMC === 'object') {
        try {
          nativeMC.registerTool = api.registerTool;
          nativeMC.unregisterTool = api.unregisterTool;
          nativeMC.provideContext = api.provideContext;
          nativeMC.clearContext = api.clearContext;
        } catch {}
      } else {
        try {
          Object.defineProperty(nav, 'modelContext', {
            value: {
              registerTool: api.registerTool,
              unregisterTool: api.unregisterTool,
              provideContext: api.provideContext,
              clearContext: api.clearContext,
            },
            configurable: true,
            writable: true,
          });
        } catch {}
      }
    }
    g.__hanzoWebMCP = api;
  }

  const scanForms = () => {
    const out = new Map();
    if (typeof document === 'undefined' || !document.querySelectorAll) return out;
    for (const form of Array.from(document.querySelectorAll('form[toolname], form[data-toolname]'))) {
      const name = (form.getAttribute('toolname') || form.getAttribute('data-toolname') || '').trim();
      if (!name) continue;
      const description = (form.getAttribute('tooldescription') || form.getAttribute('data-tooldescription') || form.getAttribute('aria-label') || '').trim();
      const properties = {};
      const required = [];
      for (const ctrl of Array.from(form.querySelectorAll('input, select, textarea'))) {
        const fn = (ctrl.getAttribute('name') || '').trim();
        if (!fn || ctrl.getAttribute('toolparamignore') === 'true') continue;
        const tag = ctrl.tagName.toLowerCase();
        const type = tag === 'input' ? (ctrl.type || 'text').toLowerCase() : tag;
        if (['submit', 'button', 'reset', 'image'].includes(type)) continue;
        properties[fn] = type === 'checkbox' ? { type: 'boolean' } : (type === 'number' || type === 'range' ? { type: 'number' } : { type: 'string' });
        if (ctrl.required && !required.includes(fn)) required.push(fn);
      }
      out.set(name, {
        form,
        schema: {
          name,
          description,
          inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
          declarative: true,
        },
      });
    }
    return out;
  };

  const origin = typeof location !== 'undefined' ? (location.origin || location.href || 'null') : 'null';
  if (op === 'install') return { installed: true, origin };

  const imperative = g.__hanzoWebMCP._getImperative();
  const declarative = scanForms();

  if (op === 'list') {
    const tools = [];
    for (const [, t] of imperative) {
      tools.push({ name: t.name, description: t.description || '', inputSchema: t.inputSchema, annotations: t.annotations, declarative: false });
    }
    for (const [name, d] of declarative) {
      if (!imperative.has(name)) tools.push(d.schema);
    }
    return { origin, tools };
  }

  if (op === 'call') {
    const toolName = String(payload?.tool || '').trim();
    const args = payload?.args && typeof payload.args === 'object' ? payload.args : {};
    const imp = imperative.get(toolName);
    if (imp && typeof imp.execute === 'function') {
      const res = await imp.execute(args, { agentInvoked: true });
      return { found: true, origin, result: res === undefined ? null : res };
    }
    const decl = declarative.get(toolName);
    if (decl && decl.form) {
      for (const [k, v] of Object.entries(args)) {
        const el = decl.form.querySelector('[name="' + CSS.escape(k) + '"]');
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = Boolean(v);
        else el.value = String(v ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      let responded = false, respVal;
      const ev = new Event('submit', { bubbles: true, cancelable: true });
      ev.agentInvoked = true;
      ev.respondWith = (p) => { responded = true; respVal = p; };
      decl.form.dispatchEvent(ev);
      return { found: true, origin, result: responded ? await respVal : { submitted: true } };
    }
    return { found: false, origin };
  }
  return { origin, tools: [] };
})
`;

class NativeWebSocket extends EventEmitter {
  private socket: Duplex | null = null;
  private rxBuf: Buffer = Buffer.alloc(0);
  private fragOpcode = 0;
  private fragChunks: Buffer[] = [];
  public readyState: 'CONNECTING' | 'OPEN' | 'CLOSED' = 'CONNECTING';

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<NativeWebSocket> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(wsUrl);
      const isSecure = parsed.protocol === 'wss:';
      const mod = isSecure ? https : http;
      const key = crypto.randomBytes(16).toString('base64');
      const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

      const ws = new NativeWebSocket();
      const timer = setTimeout(() => req.destroy(new Error(`CDP WebSocket timeout: ${wsUrl}`)), timeoutMs);

      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (isSecure ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });

      req.once('error', (err) => {
        clearTimeout(timer);
        ws.readyState = 'CLOSED';
        reject(err);
      });

      req.once('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        if (res.headers['sec-websocket-accept'] !== expectedAccept) {
          socket.destroy();
          ws.readyState = 'CLOSED';
          reject(new Error('Invalid Sec-WebSocket-Accept header'));
          return;
        }
        ws.attach(socket, head);
        resolve(ws);
      });

      req.end();
    });
  }

  private attach(socket: Duplex, head: Buffer): void {
    this.socket = socket;
    this.readyState = 'OPEN';
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.once('close', () => {
      this.readyState = 'CLOSED';
      this.emit('close');
    });
    socket.on('error', () => {});
    if (head && head.length > 0) this.onData(head);
  }

  send(text: string): void {
    if (!this.socket || this.readyState !== 'OPEN') throw new Error('CDP WebSocket closed');
    this.writeFrame(0x01, Buffer.from(text, 'utf8'));
  }

  close(): void {
    if (!this.socket || this.readyState === 'CLOSED') return;
    try { this.writeFrame(0x08, Buffer.alloc(0)); } catch {}
    this.readyState = 'CLOSED';
    this.socket.destroy();
    this.socket = null;
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let headerLen = 6;
    if (len >= 126 && len < 65536) headerLen += 2;
    else if (len >= 65536) headerLen += 8;
    const frame = Buffer.allocUnsafe(headerLen + len);
    frame[0] = 0x80 | (opcode & 0x0f);
    let offset = 2;
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }
    mask.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) frame[offset + i] = payload[i] ^ mask[i & 3];
    this.socket.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.rxBuf = this.rxBuf.length === 0 ? chunk : Buffer.concat([this.rxBuf, chunk]);
    while (this.rxBuf.length >= 2) {
      const b0 = this.rxBuf[0];
      const b1 = this.rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (this.rxBuf.length < 4) return;
        payloadLen = this.rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.rxBuf.length < 10) return;
        payloadLen = Number(this.rxBuf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.rxBuf.length < offset + maskLen + payloadLen) return;
      let payload = this.rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = this.rxBuf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }
      this.rxBuf = this.rxBuf.subarray(offset + maskLen + payloadLen);
      if (opcode === 0x08) { this.close(); return; }
      if (opcode === 0x09) { try { this.writeFrame(0x0a, payload); } catch {} continue; }
      if (opcode === 0x0a) continue;
      if (opcode === 0x00) {
        this.fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragChunks);
          const kind = this.fragOpcode;
          this.fragChunks = [];
          this.fragOpcode = 0;
          if (kind === 0x01) this.emit('message', full.toString('utf8'));
        }
      } else if (!fin) {
        this.fragOpcode = opcode;
        this.fragChunks = [payload];
      } else if (opcode === 0x01) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

class CDPConnection {
  private ws: NativeWebSocket;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(ws: NativeWebSocket) {
    this.ws = ws;
    ws.on('message', (raw: string) => {
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
      }
    });
    ws.on('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === 'OPEN';
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.ws.close();
  }
}

function httpGetJson<T = any>(url: string, timeoutMs = 2000): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function whichBin(names: string[]): string | null {
  for (const n of names) {
    try {
      const p = execFileSync('which', [n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export function findLocalBrowserBinary(engine: HeadlessEngineName = 'chrome'): string {
  if (engine === 'lightpanda') {
    const cands = [
      process.env.HANZO_LIGHTPANDA_BIN,
      path.join(os.homedir(), '.local', 'bin', 'lightpanda'),
      '/usr/local/bin/lightpanda',
      '/usr/bin/lightpanda',
    ].filter(Boolean) as string[];
    for (const c of cands) if (fs.existsSync(c)) return c;
    const found = whichBin(['lightpanda']);
    if (found) return found;
    throw new Error('Lightpanda binary not found. Set HANZO_LIGHTPANDA_BIN.');
  }

  if (engine === 'obscura') {
    const cands = [
      process.env.HANZO_OBSCURA_BIN,
      path.join(os.homedir(), '.local', 'bin', 'obscura'),
      '/usr/local/bin/obscura',
    ].filter(Boolean) as string[];
    for (const c of cands) if (fs.existsSync(c)) return c;
    const found = whichBin(['obscura']);
    if (found) return found;
  }

  const chromeCands = [
    process.env.HANZO_BROWSER_BIN,
    process.env.CHROME_BIN,
    '/usr/local/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/usr/local/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean) as string[];

  for (const c of chromeCands) if (fs.existsSync(c)) return c;
  const found = whichBin(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']);
  if (found) return found;

  throw new Error(
    'No browser: the Hanzo extension is not connected on ZAP and no local Chrome/Chromium/Lightpanda binary was found. ' +
    'Connect the Hanzo browser extension, or install chromium / set HANZO_BROWSER_BIN.',
  );
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

interface HeadlessState {
  engine: HeadlessEngineName;
  headless: boolean;
  noWebmcp: boolean;
  cdp: CDPConnection;
  proc: ChildProcess | null;
  userDataDir: string | null;
  baseUrl: string | null;
  activeTargetId: string;
  activeSessionId: string;
  lastRefSeq: number;
  webmcpTracker: WebMCPCatalogTracker;
}

let state: HeadlessState | null = null;

export async function closeHeadlessCDP(): Promise<void> {
  const cur = state;
  state = null;
  if (!cur) return;
  try { cur.cdp.close(); } catch {}
  if (cur.proc && cur.proc.exitCode === null && !cur.proc.killed) {
    try { cur.proc.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 150));
    try { if (cur.proc.pid) process.kill(cur.proc.pid, 'SIGKILL'); } catch {}
  }
  if (cur.userDataDir) {
    try { fs.rmSync(cur.userDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function attachPageSession(cdp: CDPConnection, targetId: string, noWebmcp: boolean): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await cdp.send('Page.enable', {}, sessionId).catch(() => {});
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_BUNDLE }, sessionId).catch(() => {});
  if (!noWebmcp) {
    const boot = `${WEBMCP_RUNTIME_SCRIPT}("install", {});`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: boot }, sessionId).catch(() => {});
    await cdp.send('Runtime.evaluate', { expression: boot, awaitPromise: true }, sessionId).catch(() => {});
  }
  return sessionId;
}

async function ensureHeadless(opts: {
  cdpEndpoint?: string;
  headless?: boolean;
  engine?: HeadlessEngineName;
  noWebmcp?: boolean;
} = {}): Promise<HeadlessState> {
  if (state && state.cdp.isOpen && !opts.cdpEndpoint) {
    return state;
  }
  if (state) {
    await closeHeadlessCDP();
  }

  const engine = opts.engine ?? ((process.env.HANZO_BROWSER_ENGINE as HeadlessEngineName) || 'chrome');
  const headless = opts.headless ?? true;
  const noWebmcp = isWebMCPDisabled(opts.noWebmcp);

  let wsUrl = '';
  let baseUrl: string | null = null;
  let proc: ChildProcess | null = null;
  let userDataDir: string | null = null;

  if (opts.cdpEndpoint) {
    if (/^wss?:\/\//i.test(opts.cdpEndpoint)) {
      wsUrl = opts.cdpEndpoint;
    } else {
      baseUrl = opts.cdpEndpoint.replace(/\/+$/, '');
      const ver = await httpGetJson<{ webSocketDebuggerUrl?: string }>(`${baseUrl}/json/version`, 5000);
      if (!ver?.webSocketDebuggerUrl) {
        throw new Error(`Could not resolve CDP webSocketDebuggerUrl from ${baseUrl}`);
      }
      wsUrl = ver.webSocketDebuggerUrl;
    }
  } else {
    const bin = findLocalBrowserBinary(engine);
    const port = await allocatePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const args: string[] = [];

    if (engine === 'lightpanda') {
      args.push('serve', '--host', '127.0.0.1', '--port', String(port));
    } else {
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzo-mcp-cdp-'));
      args.push(
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--password-store=basic',
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--window-size=1440,900',
      );
      if (!noWebmcp) {
        args.push(
          '--enable-features=WebMCP,ModelContextProtocol',
          '--enable-experimental-web-platform-features',
        );
      }
      if (engine === 'obscura') {
        args.push('--disable-blink-features=AutomationControlled');
      }
      if (headless) {
        args.push('--headless=new', '--disable-gpu');
      }
      if ((typeof process.getuid === 'function' && process.getuid() === 0) || process.env.CI || process.env.HANZO_BROWSER_NO_SANDBOX === '1') {
        args.push('--no-sandbox');
      }
      args.push('about:blank');
    }

    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrBuf = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => { stderrBuf += chunk; });

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s\r\n]+)/);
      if (m?.[1]) {
        wsUrl = m[1];
        break;
      }
      const ver = await httpGetJson<{ webSocketDebuggerUrl?: string }>(`${baseUrl}/json/version`, 800);
      if (ver?.webSocketDebuggerUrl) {
        wsUrl = ver.webSocketDebuggerUrl;
        break;
      }
      if (proc.exitCode !== null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!wsUrl) {
      try { proc.kill('SIGKILL'); } catch {}
      if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
      throw new Error(`Failed to launch headless ${engine} CDP session. ${stderrBuf.trim()}`);
    }
  }

  const ws = await NativeWebSocket.connect(wsUrl);
  const cdp = new CDPConnection(ws);

  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
  let pageTarget = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!pageTarget) {
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    pageTarget = { targetId: created.targetId, type: 'page', url: 'about:blank' };
  }

  const sessionId = await attachPageSession(cdp, pageTarget.targetId, noWebmcp);

  state = {
    engine,
    headless,
    noWebmcp,
    cdp,
    proc,
    userDataDir,
    baseUrl,
    activeTargetId: pageTarget.targetId,
    activeSessionId: sessionId,
    lastRefSeq: 0,
    webmcpTracker: new WebMCPCatalogTracker(),
  };

  return state;
}

async function evalInSession<T = any>(s: HeadlessState, expression: string, timeoutMs = 30_000): Promise<T> {
  const res = await s.cdp.send<any>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    s.activeSessionId,
    timeoutMs,
  );
  if (res?.exceptionDetails) {
    const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluation error';
    throw new Error(msg);
  }
  return res?.result?.value as T;
}

async function runPageOp(s: HeadlessState, req: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
  const installed = await evalInSession<boolean>(s, 'typeof globalThis.__hanzoPage === "function"', timeoutMs);
  if (!installed) {
    await evalInSession(s, PAGE_BUNDLE, timeoutMs);
  }
  const out = await evalInSession<any>(s, `globalThis.__hanzoPage(${JSON.stringify(req)})`, timeoutMs);
  if (!out) throw new Error('Headless snapshot engine failed to respond');
  const { ok, error, _sync, ...rest } = out;
  if (!ok) throw new Error(String(error || 'Page action failed'));
  if (typeof _sync === 'string' && _sync) {
    await evalInSession(s, `(() => {
      const el = document.querySelector(${JSON.stringify(`[data-hanzo-sync="${_sync}"]`)});
      if (!el) return;
      el.removeAttribute('data-hanzo-sync');
      const val = el.value;
      if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
        el._valueTracker.setValue('__hanzo_prev_' + val.length + '__');
      }
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, val);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`).catch(() => {});
  }
  return rest;
}

async function observeHeadlessWebMCP(s: HeadlessState): Promise<{ tools: WebMCPToolSummary[] } | undefined> {
  if (s.noWebmcp) return undefined;
  try {
    const out = await evalInSession<{ origin: string; tools: any[] }>(
      s,
      `${WEBMCP_RUNTIME_SCRIPT}("list", {})`,
      5000,
    );
    if (!out || !Array.isArray(out.tools)) return undefined;
    return s.webmcpTracker.update([{ frameId: 0, origin: String(out.origin || 'null'), tools: out.tools }]);
  } catch {
    return undefined;
  }
}

export interface HeadlessDispatchCallbacks {
  text: (v: unknown, isError?: boolean) => any;
  capture: (raw: Buffer, meta: Record<string, unknown>, file?: string) => any;
}

export async function viaHeadlessCDP(
  action: string,
  a: Record<string, any>,
  cb: HeadlessDispatchCallbacks,
): Promise<any> {
  if (action === 'close') {
    await closeHeadlessCDP();
    return cb.text({ success: true, closed: true, source: 'headless-cdp' });
  }
  if (action === 'status') {
    return cb.text({
      success: true,
      source: 'headless-cdp',
      engine: state?.engine ?? 'chrome',
      running: Boolean(state?.cdp.isOpen),
      webmcp: !isWebMCPDisabled(Boolean(a.no_webmcp)),
    });
  }
  if (action === 'connect') {
    if (!a.cdp_endpoint) return cb.text({ error: 'args.cdp_endpoint required' }, true);
    const s = await ensureHeadless({ cdpEndpoint: String(a.cdp_endpoint), noWebmcp: Boolean(a.no_webmcp) });
    return cb.text({ success: true, source: 'headless-cdp', connected: true, targetId: s.activeTargetId });
  }
  if (action === 'set_headless') {
    await closeHeadlessCDP();
    const s = await ensureHeadless({ headless: a.headless !== false, noWebmcp: Boolean(a.no_webmcp) });
    return cb.text({ success: true, source: 'headless-cdp', headless: s.headless });
  }

  if (action.startsWith('lastpass_')) {
    return cb.text(
      {
        error: `${action} requires a connected Hanzo Browser Extension over ZAP (signed-in browser vault).`,
        action,
      },
      true,
    );
  }

  const s = await ensureHeadless({
    engine: a.engine as HeadlessEngineName | undefined,
    noWebmcp: Boolean(a.no_webmcp),
  });
  const sel: string | undefined = a.selector;
  const timeout = a.timeout ?? 30_000;

  switch (action) {
    case 'navigate': {
      if (!a.url) return cb.text({ error: 'url required' }, true);
      await s.cdp.send('Page.navigate', { url: String(a.url) }, s.activeSessionId, timeout);
      const deadline = Date.now() + Math.min(timeout, 15_000);
      while (Date.now() < deadline) {
        const rs = await evalInSession<string>(s, 'document.readyState', 2000).catch(() => 'loading');
        if (rs === 'complete' || rs === 'interactive') break;
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!s.noWebmcp) {
        await evalInSession(s, `${WEBMCP_RUNTIME_SCRIPT}("install", {})`, 3000).catch(() => {});
      }
      const url = await evalInSession<string>(s, 'location.href');
      const title = await evalInSession<string>(s, 'document.title');
      const webmcp = await observeHeadlessWebMCP(s);
      return cb.text({ success: true, source: 'headless-cdp', url, title, ...(webmcp ? { webmcp } : {}) });
    }

    case 'snapshot': {
      const { last, ...out } = await runPageOp(
        s,
        {
          op: 'snapshot',
          interactive: Boolean(a.interactive),
          compact: Boolean(a.compact),
          depth: a.depth,
          selector: sel,
          urls: Boolean(a.urls),
          base: s.lastRefSeq || undefined,
        },
        timeout,
      );
      if (typeof last === 'number' && last > s.lastRefSeq) s.lastRefSeq = last;
      const webmcp = await observeHeadlessWebMCP(s);
      const suffix = webmcp ? `\n\n[webmcp: ${JSON.stringify(webmcp)}]` : '';
      return cb.text(`${out.title} — ${out.url} (${out.refs} refs)\n${out.tree}${suffix}`);
    }

    case 'read': {
      const out = await runPageOp(
        s,
        { op: 'read', outline: Boolean(a.outline), filter: a.filter },
        timeout,
      );
      return cb.text(`${out.title} — ${out.url}\n\n${out.markdown}`);
    }

    case 'click':
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'check':
    case 'uncheck': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: action, selector: sel }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'scroll_into_view': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: 'scrollIntoView', selector: sel }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'fill': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const { value: _omit, ...out } = await runPageOp(s, { op: 'fill', selector: sel, text: a.text ?? '' }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'type': {
      const { value: _omit, ...out } = await runPageOp(
        s,
        { op: 'type', ...(sel ? { selector: sel } : {}), text: a.text ?? '' },
        timeout,
      );
      return cb.text({ success: true, ...out });
    }

    case 'press': {
      const out = await runPageOp(
        s,
        { op: 'press', ...(sel ? { selector: sel } : {}), key: a.key ?? 'Enter' },
        timeout,
      );
      return cb.text({ success: true, ...out });
    }

    case 'select': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: 'select', selector: sel, value: String(a.value ?? '') }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'scroll': {
      const out = await runPageOp(
        s,
        { op: 'scroll', ...(sel ? { selector: sel } : {}), dx: a.delta_x ?? 0, dy: a.delta_y ?? 300 },
        timeout,
      );
      return cb.text({ success: true, ...out });
    }

    case 'get_text': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: 'text', selector: sel }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'get_attribute': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: 'attribute', selector: sel, attribute: a.attribute }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'count': {
      if (!sel) return cb.text({ error: 'selector required' }, true);
      const out = await runPageOp(s, { op: 'count', selector: sel }, timeout);
      return cb.text({ success: true, ...out });
    }

    case 'get_html': {
      const html = sel
        ? await evalInSession<string>(s, `document.querySelector(${JSON.stringify(sel)})?.innerHTML ?? ""`, timeout)
        : await evalInSession<string>(s, 'document.documentElement.outerHTML', timeout);
      return cb.text({ success: true, html });
    }

    case 'evaluate': {
      const result = await evalInSession(s, String(a.code ?? ''), timeout);
      return cb.text({ success: true, result });
    }

    case 'wait': {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const probe = await runPageOp(s, { op: 'probe', selector: sel, text: a.text, state: a.state }, timeout);
        if (probe.met) return cb.text({ success: true, met: true, waited: Date.now() - start });
        await new Promise((r) => setTimeout(r, 100));
      }
      return cb.text({ error: `Timed out after ${timeout}ms waiting for ${sel || a.text}` }, true);
    }

    case 'url':
      return cb.text({ success: true, url: await evalInSession<string>(s, 'location.href') });

    case 'title':
      return cb.text({ success: true, title: await evalInSession<string>(s, 'document.title') });

    case 'go_back':
      await evalInSession(s, 'history.back()');
      return cb.text({ success: true, action });

    case 'go_forward':
      await evalInSession(s, 'history.forward()');
      return cb.text({ success: true, action });

    case 'reload':
      await s.cdp.send('Page.reload', {}, s.activeSessionId, timeout);
      return cb.text({ success: true, action });

    case 'set_content': {
      const { frameTree } = await s.cdp.send<any>('Page.getFrameTree', {}, s.activeSessionId);
      await s.cdp.send(
        'Page.setDocumentContent',
        { frameId: frameTree.frame.id, html: String(a.html ?? '') },
        s.activeSessionId,
      );
      return cb.text({ success: true, action });
    }

    case 'screenshot': {
      const params: Record<string, unknown> = { format: a.full_res ? 'png' : 'jpeg' };
      if (!a.full_res) params.quality = a.quality ?? 70;
      if (a.full_page) params.captureBeyondViewport = true;
      const res = await s.cdp.send<{ data: string }>('Page.captureScreenshot', params, s.activeSessionId, timeout);
      return cb.capture(Buffer.from(res.data, 'base64'), { source: 'headless-cdp', engine: s.engine }, a.path);
    }

    case 'pdf': {
      const res = await s.cdp.send<{ data: string }>('Page.printToPDF', {}, s.activeSessionId, timeout);
      const raw = Buffer.from(res.data, 'base64');
      if (a.path) {
        fs.mkdirSync(path.dirname(String(a.path)), { recursive: true });
        fs.writeFileSync(String(a.path), raw);
      }
      return cb.text({ success: true, bytes: raw.length, ...(a.path ? { path: a.path } : {}) });
    }

    case 'viewport': {
      if (a.width && a.height) {
        await s.cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width: Number(a.width), height: Number(a.height), deviceScaleFactor: 1, mobile: false },
          s.activeSessionId,
        );
      }
      const vp = await evalInSession<{ width: number; height: number }>(
        s,
        '({ width: window.innerWidth, height: window.innerHeight })',
      );
      return cb.text({ success: true, ...vp });
    }

    case 'tabs': {
      const { targetInfos } = await s.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>(
        'Target.getTargets',
      );
      const pages = targetInfos.filter((t) => t.type === 'page');
      return cb.text({
        success: true,
        tabs: pages.map((p, i) => ({ index: i, id: p.targetId, url: p.url, title: p.title })),
      });
    }

    case 'new_tab': {
      const created = await s.cdp.send<{ targetId: string }>('Target.createTarget', { url: a.url || 'about:blank' });
      s.activeTargetId = created.targetId;
      s.activeSessionId = await attachPageSession(s.cdp, created.targetId, s.noWebmcp);
      return cb.text({ success: true, tab_id: created.targetId });
    }

    case 'close_tab':
    case 'select_tab': {
      const { targetInfos } = await s.cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
      const pages = targetInfos.filter((t) => t.type === 'page');
      const wanted = a.tab_id
        ? pages.find((p) => p.targetId === String(a.tab_id))
        : pages[a.tab_index ?? 0];
      if (!wanted) return cb.text({ error: `no tab ${a.tab_id ?? a.tab_index}` }, true);
      if (action === 'close_tab') {
        await s.cdp.send('Target.closeTarget', { targetId: wanted.targetId });
        const next = pages.find((p) => p.targetId !== wanted.targetId);
        if (next) {
          s.activeTargetId = next.targetId;
          s.activeSessionId = await attachPageSession(s.cdp, next.targetId, s.noWebmcp);
        }
      } else {
        await s.cdp.send('Target.activateTarget', { targetId: wanted.targetId });
        s.activeTargetId = wanted.targetId;
        s.activeSessionId = await attachPageSession(s.cdp, wanted.targetId, s.noWebmcp);
      }
      return cb.text({ success: true, action, tab_id: wanted.targetId });
    }

    case 'cookies': {
      const res = await s.cdp.send<{ cookies: Array<Record<string, any>> }>('Network.getCookies', {}, s.activeSessionId);
      // Redact raw cookie values so plaintext session secrets are never returned
      const sanitized = (res.cookies || []).map(({ value: _redacted, ...meta }) => meta);
      return cb.text({ success: true, cookies: sanitized });
    }

    case 'clear_cookies': {
      await s.cdp.send('Network.clearBrowserCookies', {}, s.activeSessionId);
      return cb.text({ success: true, cleared: true });
    }

    case 'webmcp_list': {
      if (s.noWebmcp) return cb.text({ success: true, tools: [] });
      const out = await evalInSession<{ origin: string; tools: any[] }>(s, `${WEBMCP_RUNTIME_SCRIPT}("list", {})`, timeout);
      const all: WebMCPToolSchema[] = (out?.tools || []).map((t: any) => ({
        name: String(t.name),
        description: String(t.description ?? ''),
        origin: String(out?.origin || 'null'),
        frameId: 0,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        ...(t.annotations ? { annotations: t.annotations } : {}),
        ...(t.declarative ? { declarative: true } : {}),
      }));
      if (a.tool) {
        const match = all.find((t) => t.name === String(a.tool));
        if (!match) return cb.text({ error: `WebMCP tool ${JSON.stringify(a.tool)} not found` }, true);
        return cb.text({ success: true, tool: match });
      }
      return cb.text({
        success: true,
        tools: all.map((t) => ({
          name: t.name,
          description: t.description.length > 160 ? `${t.description.slice(0, 159)}…` : t.description,
          origin: t.origin,
          frameId: t.frameId,
        })),
      });
    }

    case 'webmcp_call': {
      if (s.noWebmcp) return cb.text({ error: 'WebMCP is disabled' }, true);
      const toolName = String(a.tool ?? '').trim();
      if (!toolName) return cb.text({ error: 'args.tool required for webmcp_call' }, true);
      const callArgs = a._webmcpArgs ?? a.tool_args ?? a.params ?? {};
      const out = await evalInSession<any>(
        s,
        `${WEBMCP_RUNTIME_SCRIPT}("call", ${JSON.stringify({ tool: toolName, args: callArgs })})`,
        timeout,
      );
      if (!out?.found) return cb.text({ error: `WebMCP tool ${JSON.stringify(toolName)} not found` }, true);
      return cb.text({ success: true, tool: toolName, frameId: 0, origin: out.origin, result: out.result });
    }

    default:
      return cb.text(
        { error: `${action} is not supported on headless CDP without the ZAP browser extension.`, action },
        true,
      );
  }
}
