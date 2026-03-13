/**
 * ZAP (Zero-latency Agent Protocol) Server for @hanzo/mcp
 *
 * Self-contained ZAP binary protocol encode/decode.
 * No dependency on @hanzo/zap — MCP is MCP, ZAP is ZAP.
 *
 * Allows Hanzo browser extensions to discover this MCP server
 * and call tools directly over a binary WebSocket protocol.
 *
 * Wire format: [0x5A 0x41 0x50 0x01][type:1][length:4 BE][JSON payload]
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Tool } from './types/index.js';

// ── Inline ZAP Protocol ───────────────────────────────────────────────
// Minimal encode/decode for the ZAP binary wire format.
// Kept self-contained so @hanzo/mcp has zero ZAP package dependencies.

const ZAP_MAGIC = new Uint8Array([0x5a, 0x41, 0x50, 0x01]);
const HEADER_SIZE = 9; // 4 magic + 1 type + 4 length

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function zapEncode(type: number, payload: unknown): Uint8Array {
  const json = textEncoder.encode(JSON.stringify(payload));
  const frame = new Uint8Array(HEADER_SIZE + json.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  frame.set(ZAP_MAGIC, 0);
  view.setUint8(4, type);
  view.setUint32(5, json.length, false); // big-endian
  frame.set(json, HEADER_SIZE);
  return frame;
}

function zapDecode(data: Uint8Array): { type: number; payload: any } | null {
  if (data.length < HEADER_SIZE) return null;
  // Check magic
  if (data[0] !== 0x5a || data[1] !== 0x41 || data[2] !== 0x50 || data[3] !== 0x01) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(4);
  const length = view.getUint32(5, false);
  if (data.length < HEADER_SIZE + length) return null;
  const jsonBytes = data.subarray(HEADER_SIZE, HEADER_SIZE + length);
  const payload = length > 0 ? JSON.parse(textDecoder.decode(jsonBytes)) : null;
  return { type, payload };
}

// ── Protocol Constants ────────────────────────────────────────────────

const MSG_HANDSHAKE    = 0x01; // Init
const MSG_HANDSHAKE_OK = 0x02; // InitAck
const MSG_REQUEST      = 0x10; // Push
const MSG_RESPONSE     = 0x12; // Resolve
const MSG_PING         = 0xf0;
const MSG_PONG         = 0xf1;

const ZAP_PORTS = [9999, 9998, 9997, 9996, 9995];
const SERVER_ID = `mcp-${Date.now().toString(36)}`;

// ── Client tracking ─────────────────────────────────────────────────────

interface ZapClient {
  ws: WebSocket;
  clientId: string;
  browser: string;
  version: string;
  connectedAt: number;
}

// ── Server ──────────────────────────────────────────────────────────────

/** Generic MCP method handler: (method, params) => result */
export type McpMethodHandler = (method: string, params: any) => Promise<any>;

export interface ZapServerOptions {
  tools: Tool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>;
  /** Optional pass-through handler for ALL MCP methods (resources/*, prompts/*, etc.) */
  handleMethod?: McpMethodHandler;
  name?: string;
  preferredPort?: number;
}

export async function startZapServer(options: ZapServerOptions): Promise<{ port: number; stop: () => void } | null> {
  const { tools, callTool, handleMethod, name = 'hanzo-mcp' } = options;
  const clients = new Map<WebSocket, ZapClient>();

  const toolManifest = tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || {},
  }));

  /** Encode and send a ZAP frame over WebSocket */
  function sendFrame(ws: WebSocket, type: number, payload: unknown): void {
    ws.send(zapEncode(type, payload));
  }

  function handleMessage(ws: WebSocket, raw: RawData) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const msg = zapDecode(data);
    if (!msg) return;

    switch (msg.type) {
      case MSG_HANDSHAKE: {
        const p = (msg.payload || {}) as Record<string, string>;
        const clientId = p['clientId'] || 'unknown';
        const browser = p['browser'] || 'unknown';
        const version = p['version'] || '0';
        clients.set(ws, { ws, clientId, browser, version, connectedAt: Date.now() });
        console.error(`[ZAP] Client connected: ${clientId} (${browser} v${version})`);
        sendFrame(ws, MSG_HANDSHAKE_OK, {
          serverId: SERVER_ID,
          name,
          tools: toolManifest,
        });
        break;
      }

      case MSG_REQUEST: {
        const p = (msg.payload || {}) as Record<string, unknown>;
        handleRequest(ws, p['id'] as string, p['method'] as string, p['params']);
        break;
      }

      case MSG_PING:
        sendFrame(ws, MSG_PONG, {});
        break;

      default:
        break;
    }
  }

  async function handleRequest(ws: WebSocket, id: string, method: string, params: any) {
    try {
      let result: any;

      // Built-in handlers for core MCP methods
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

        // Client→server notifications (fire-and-forget)
        case 'notifications/elementSelected':
        case 'notifications/controlCancelled':
          result = { acknowledged: true };
          break;

        default:
          // Pass-through to MCP server for full protocol parity
          // (resources/list, resources/read, prompts/list, prompts/get, etc.)
          if (handleMethod) {
            result = await handleMethod(method, params);
          } else {
            throw new Error(`Unsupported method: ${method}`);
          }
          break;
      }

      sendFrame(ws, MSG_RESPONSE, { id, result });
    } catch (err: any) {
      sendFrame(ws, MSG_RESPONSE, {
        id,
        error: { code: -1, message: err?.message || String(err) },
      });
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
