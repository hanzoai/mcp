/**
 * ZAP (Zero-latency Agent Protocol) Server for @hanzo/mcp
 *
 * Allows Hanzo browser extensions to discover this MCP server
 * and call tools directly over a binary WebSocket protocol.
 *
 * Protocol: 9-byte header + JSON payload
 *   [0x5A 0x41 0x50 0x01] magic  "ZAP\x01"
 *   [type]                 1 byte message type
 *   [length]               4 bytes big-endian payload length
 *   [payload]              UTF-8 JSON
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Tool } from './types/index.js';

// ── Protocol Constants ──────────────────────────────────────────────────
const ZAP_MAGIC = Buffer.from([0x5a, 0x41, 0x50, 0x01]);
const MSG_HANDSHAKE    = 0x01;
const MSG_HANDSHAKE_OK = 0x02;
const MSG_REQUEST      = 0x10;
const MSG_RESPONSE     = 0x11;
const MSG_PING         = 0xfe;
const MSG_PONG         = 0xff;

const ZAP_PORTS = [9999, 9998, 9997, 9996, 9995];
const SERVER_ID = `mcp-${Date.now().toString(36)}`;

// ── Encode / Decode ─────────────────────────────────────────────────────

function encode(type: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(9 + json.length);
  ZAP_MAGIC.copy(buf, 0);
  buf[4] = type;
  buf.writeUInt32BE(json.length, 5);
  json.copy(buf, 9);
  return buf;
}

function decode(data: Buffer): { type: number; payload: any } | null {
  if (data.length < 5) return null;

  // Format 1: MCP ZAP — [magic:4 BE][type:1][length:4 BE][JSON]
  if (data[0] === 0x5a && data[1] === 0x41 && data[2] === 0x50 && data[3] === 0x01) {
    if (data.length < 9) return null;
    const type = data[4];
    const length = data.readUInt32BE(5);
    if (data.length < 9 + length) return null;
    try {
      const payload = JSON.parse(data.subarray(9, 9 + length).toString('utf8'));
      return { type, payload };
    } catch {
      return null;
    }
  }

  // Format 2: hanzo/dev ZAP — [length:4 LE][type:1][payload]
  const leLength = data.readUInt32LE(0);
  if (leLength > 0 && leLength <= 16 * 1024 * 1024 && data.length >= 5 + leLength) {
    const type = data[4];
    if (type <= 0x45 || type >= 0xFE) {
      // Valid hanzo/dev message type range
      const payloadBuf = data.subarray(5, 5 + leLength);
      try {
        const payload = JSON.parse(payloadBuf.toString('utf8'));
        return { type, payload };
      } catch {
        // Binary payload from hanzo/dev — wrap as raw
        return { type, payload: { raw: payloadBuf } };
      }
    }
  }

  // Format 3: Plain JSON fallback
  try {
    const payload = JSON.parse(data.toString('utf8'));
    return { type: MSG_REQUEST, payload };
  } catch {
    return null;
  }
}

// ── Client tracking ─────────────────────────────────────────────────────

interface ZapClient {
  ws: WebSocket;
  clientId: string;
  browser: string;
  version: string;
  connectedAt: number;
}

// ── Server ──────────────────────────────────────────────────────────────

export interface ZapServerOptions {
  tools: Tool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  name?: string;
  preferredPort?: number;
}

export async function startZapServer(options: ZapServerOptions): Promise<{ port: number; stop: () => void } | null> {
  const { tools, callTool, name = 'hanzo-mcp' } = options;
  const clients = new Map<WebSocket, ZapClient>();

  const toolManifest = tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
  }));

  function handleMessage(ws: WebSocket, raw: RawData) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    const msg = decode(buf);
    if (!msg) return;

    switch (msg.type) {
      case MSG_HANDSHAKE: {
        const { clientId = 'unknown', browser = 'unknown', version = '0' } = msg.payload || {};
        clients.set(ws, { ws, clientId, browser, version, connectedAt: Date.now() });
        console.error(`[ZAP] Client connected: ${clientId} (${browser} v${version})`);
        ws.send(encode(MSG_HANDSHAKE_OK, {
          serverId: SERVER_ID,
          name,
          tools: toolManifest,
        }));
        break;
      }

      case MSG_REQUEST: {
        const { id, method, params } = msg.payload || {};
        handleRequest(ws, id, method, params);
        break;
      }

      case MSG_PING:
        ws.send(encode(MSG_PONG, {}));
        break;

      default:
        break;
    }
  }

  async function handleRequest(ws: WebSocket, id: string, method: string, params: any) {
    try {
      let result: any;

      switch (method) {
        case 'tools/list':
          result = { tools: toolManifest };
          break;

        case 'tools/call': {
          const { name: toolName, arguments: args = {} } = params || {};
          if (!toolName) {
            throw new Error('Missing tool name');
          }
          result = await callTool(toolName, args);
          break;
        }

        case 'notifications/elementSelected':
          // Acknowledge element selection events from extensions
          result = { acknowledged: true };
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      ws.send(encode(MSG_RESPONSE, { id, result }));
    } catch (err: any) {
      ws.send(encode(MSG_RESPONSE, {
        id,
        error: { code: -1, message: err?.message || String(err) },
      }));
    }
  }

  // Try each port until one works
  const ports = options.preferredPort
    ? [options.preferredPort, ...ZAP_PORTS.filter(p => p !== options.preferredPort)]
    : ZAP_PORTS;

  for (const port of ports) {
    try {
      const wss = await new Promise<WebSocketServer>((resolve, reject) => {
        const server = new WebSocketServer({ port, host: '127.0.0.1' });
        server.once('listening', () => resolve(server));
        server.once('error', (err) => reject(err));
      });

      wss.on('connection', (ws) => {
        ws.on('message', (data) => handleMessage(ws, data));
        ws.on('close', () => {
          const client = clients.get(ws);
          if (client) {
            console.error(`[ZAP] Client disconnected: ${client.clientId}`);
            clients.delete(ws);
          }
        });
        ws.on('error', () => {
          clients.delete(ws);
        });
      });

      console.error(`[ZAP] Server listening on ws://127.0.0.1:${port} (${toolManifest.length} tools)`);

      return {
        port,
        stop: () => {
          for (const client of clients.values()) {
            client.ws.close();
          }
          clients.clear();
          wss.close();
        },
      };
    } catch {
      // Port busy, try next
      continue;
    }
  }

  console.error('[ZAP] Could not bind to any port (9999-9995). ZAP discovery disabled.');
  return null;
}
