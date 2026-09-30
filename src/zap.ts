/**
 * This process's seat on the user's ZAP router, as a consumer.
 *
 * The router is zapd, embedded by every Python and Rust hanzo-mcp (and by the
 * extension's native host); an fcntl lock on `<runtime>/zapd.lock` elects one
 * per login, and it serves `<runtime>/zapd.sock`, where `<runtime>` is
 * `$XDG_RUNTIME_DIR/zap` (else `~/.zap/run`). zapd has no JS or wasm build, so
 * this runtime never stands for router: it joins whichever process holds the
 * lock, as `mcp/hanzo-<pid>`, and reconnects on the next call when that
 * process exits and another takes over.
 *
 * Wire (HIP-0069), little-endian: u32 len · u8 type · u16 flags · u16 from_len ·
 * u16 to_len · u32 payload_len · from · to · payload. A browser command is one
 * ROUTE whose payload is `encodeCmd`, answered by one RESPONSE.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export const HELLO = 1, WELCOME = 2, PROVIDERS_LIST = 3, PROVIDERS = 4, ERROR = 7, ROUTE = 16, RESPONSE = 17;
export const ROLE_PROVIDER = 1, ROLE_CONSUMER = 2;

/** The id prefix of every browser node. */
export const BROWSER = 'browser/';

export const NO_ROUTER = 'no ZAP router on this machine: start any Python or Rust hanzo-mcp, ' +
  "or open Chrome with the Hanzo extension, whose native host stands for the router";

export interface Frame { t: number; from: string; to: string; payload: Buffer }
export interface Node { id: string; role: string; brand: string; caps: string[]; attrs: Record<string, string> }

export function runtimeDir(): string {
  const r = process.env.XDG_RUNTIME_DIR;
  return r ? path.join(r, 'zap') : path.join(os.homedir(), '.zap', 'run');
}

export function socketPath(): string {
  return path.join(runtimeDir(), 'zapd.sock');
}

const str = (s: string) => { const b = Buffer.from(s); const n = Buffer.alloc(2); n.writeUInt16LE(b.length); return Buffer.concat([n, b]); };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

export function encodeFrame(t: number, from: string, to: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const f = Buffer.from(from), d = Buffer.from(to);
  const head = Buffer.alloc(15);
  head.writeUInt32LE(11 + f.length + d.length + payload.length, 0);
  head.writeUInt8(t, 4);
  head.writeUInt16LE(0, 5);
  head.writeUInt16LE(f.length, 7);
  head.writeUInt16LE(d.length, 9);
  head.writeUInt32LE(payload.length, 11);
  return Buffer.concat([head, f, d, payload]);
}

/** Take every whole frame off the front of `buf`; return them and the rest. */
export function decodeFrames(buf: Buffer): [Frame[], Buffer] {
  const out: Frame[] = [];
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const end = 4 + buf.readUInt32LE(0);
    const fl = buf.readUInt16LE(7), tl = buf.readUInt16LE(9), pl = buf.readUInt32LE(11);
    if (15 + fl + tl + pl !== end) throw new Error('zap: frame length disagrees with its fields');
    out.push({
      t: buf.readUInt8(4),
      from: buf.toString('utf8', 15, 15 + fl),
      to: buf.toString('utf8', 15 + fl, 15 + fl + tl),
      payload: buf.subarray(15 + fl + tl, end),
    });
    buf = buf.subarray(end);
  }
  return [out, buf];
}

/** The browser command body, peer of the extension's `decodeCmd`: method(str),
 *  u16 count, then key(str) + value(u32 len + bytes) per param. */
export function encodeCmd(method: string, params: Record<string, string>): Buffer {
  const parts = [str(method), u16(Object.keys(params).length)];
  for (const [k, v] of Object.entries(params)) {
    const b = Buffer.from(v);
    parts.push(str(k), u32(b.length), b);
  }
  return Buffer.concat(parts);
}

/** A HELLO body: role + brand + caps + attrs (none). */
export function encodeHello(role: number, brand: string, caps: string[]): Buffer {
  return Buffer.concat([Buffer.from([role]), str(brand), u16(caps.length), ...caps.map(str), u16(0)]);
}

export function decodeProviders(p: Buffer): Node[] {
  let o = 0;
  const n16 = () => { const v = p.readUInt16LE(o); o += 2; return v; };
  const s = () => { const n = n16(); const v = p.toString('utf8', o, o + n); o += n; return v; };
  const out: Node[] = [];
  for (let i = n16(); i > 0; i--) {
    const id = s();
    const role = p.readUInt8(o); o += 1;
    const brand = s();
    const caps: string[] = [];
    for (let c = n16(); c > 0; c--) caps.push(s());
    const attrs: Record<string, string> = {};
    for (let a = n16(); a > 0; a--) { const k = s(); attrs[k] = s(); }
    out.push({ id, role: role === ROLE_PROVIDER ? 'provider' : role === ROLE_CONSUMER ? 'consumer' : 'router', brand, caps, attrs });
  }
  return out;
}

/** The runtime dir must be this user's alone before we trust its socket. */
function privateDir(dir: string) {
  const m = fs.lstatSync(dir);
  if (!m.isDirectory() || (process.getuid && m.uid !== process.getuid()) || (m.mode & 0o077) !== 0) {
    throw new Error(`zap: ${dir} must be a 0700 directory owned by this user`);
  }
}

type Wait = { from: string; resolve: (f: Frame) => void; reject: (e: Error) => void };

/** This process's node. One call at a time, matched by the answerer's id. */
export class Seat {
  private sock: net.Socket | null = null;
  private up: Promise<void> | null = null;
  private waiting: Wait | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  id = `mcp/hanzo-${process.pid}`;

  private connect(): Promise<void> {
    if (this.up) return this.up;
    const up = new Promise<void>((resolve, reject) => {
      try { privateDir(runtimeDir()); } catch (e) { reject(e); return; }
      const sock = net.connect(socketPath());
      let buf: Buffer = Buffer.alloc(0);
      let welcomed = false;
      // A socket that never says WELCOME is not a router: give up on it.
      const deaf = setTimeout(() => sock.destroy(new Error('zap: the router did not answer HELLO')), 5_000);
      deaf.unref();
      const gone = (e: Error) => {
        clearTimeout(deaf);
        if (this.sock === sock) { this.sock = null; if (welcomed) this.up = null; }
        if (!welcomed) reject(e);
        this.waiting?.reject(e);
        this.waiting = null;
      };
      sock.on('error', (e: NodeJS.ErrnoException) => gone(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(NO_ROUTER) : e));
      sock.on('close', () => gone(new Error('zap: router changed')));
      sock.on('connect', () => sock.write(encodeFrame(HELLO, this.id, '', encodeHello(ROLE_CONSUMER, 'hanzo', []))));
      sock.on('data', (chunk: Buffer) => {
        let frames: Frame[];
        try { [frames, buf] = decodeFrames(Buffer.concat([buf, chunk])); } catch (e) { sock.destroy(e as Error); return; }
        for (const f of frames) {
          if (f.t === WELCOME) { this.id = f.to; welcomed = true; clearTimeout(deaf); resolve(); continue; }
          if (f.t === ERROR) {
            const why = f.payload.toString();
            const dest = why.startsWith('no_route:') ? why.slice(9) : null;
            if (!welcomed) { sock.destroy(); gone(new Error(`zap: ${why}`)); return; }
            if (dest !== null && this.waiting?.from === dest) this.settle(null, new Error(`zap: ${why}`));
            continue;
          }
          const from = f.t === PROVIDERS ? 'zapd' : f.t === RESPONSE ? f.from : null;
          if (from !== null && this.waiting?.from === from) this.settle(f);
        }
      });
      sock.unref();
      this.sock = sock;
    });
    // A failed join is forgotten, so the next call tries again.
    up.catch(() => { if (this.up === up) this.up = null; });
    return (this.up = up);
  }

  private settle(f: Frame | null, e?: Error) {
    const w = this.waiting;
    this.waiting = null;
    if (w) e ? w.reject(e) : w.resolve(f as Frame);
  }

  /** Send one frame and wait for `answerer`'s reply; the deadline covers the join. */
  private ask(t: number, to: string, payload: Buffer, answerer: string, ms: number): Promise<Frame> {
    const run = () => new Promise<Frame>((resolve, reject) => {
      let done = false;
      const finish = (e: Error | null, f?: Frame) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.waiting === w) this.waiting = null;
        e ? reject(e) : resolve(f as Frame);
      };
      const w: Wait = { from: answerer, resolve: (f) => finish(null, f), reject: (e) => finish(e) };
      const timer = setTimeout(() => finish(new Error(`zap: ${answerer} did not answer`)), ms);
      this.connect().then(() => {
        if (done) return;
        if (!this.sock) return finish(new Error('zap: router changed'));
        this.waiting = w;
        this.sock.write(encodeFrame(t, '', to, payload));
      }, (e) => finish(e));
    });
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => {});
    return next;
  }

  /** Every node on this user's router. */
  async nodes(ms = 2000): Promise<Node[]> {
    return decodeProviders((await this.ask(PROVIDERS_LIST, '', Buffer.alloc(0), 'zapd', ms)).payload);
  }

  /** Route `payload` to node `to` and return its RESPONSE payload. */
  async call(to: string, payload: Buffer, ms = 30_000): Promise<Buffer> {
    return (await this.ask(ROUTE, to, payload, to, ms)).payload;
  }

  close() {
    this.sock?.destroy();
  }
}

let seat: Seat | null = null;

/** This process's seat, taken on first use. */
export function getSeat(): Seat {
  return (seat ??= new Seat());
}

/** Every browser on the router. */
export async function browsers(): Promise<Node[]> {
  return (await getSeat().nodes()).filter((n) => n.id.startsWith(BROWSER));
}

/** The browser to address: `clientId` exactly, else the first whose engine or
 *  name is `browser`, else the first one. */
export async function resolve(browser?: string | null, clientId?: string | null): Promise<string | null> {
  const found = await browsers();
  if (clientId) return found.find((b) => b.id === clientId)?.id ?? null;
  if (browser) {
    const want = browser.toLowerCase();
    return found.find((b) => b.attrs.engine === want || b.id.split('/').pop()!.split('-')[0] === want)?.id ?? null;
  }
  return found[0]?.id ?? null;
}

/** Send `method` to `provider` and return its answer as text. */
export async function route(provider: string, method: string, params: Record<string, string>, ms = 30_000): Promise<string> {
  return (await getSeat().call(provider, encodeCmd(method, params), ms)).toString('utf8');
}
