#!/usr/bin/env node
// Cross-platform MCP-protocol smoke test.
//
// Spawns the local hanzo-mcp serve via node + dist/cli.js, sends a single
// JSON-RPC `initialize` request on stdin, waits for the response on stdout,
// and exits 0 iff serverInfo.name === "hanzo-mcp".
//
// Catches the class of bug where the CLI starts but never speaks MCP on
// stdio (e.g. wrong port handling, hung tool init, missing stdio transport).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "dist", "cli.js");

const child = spawn(process.execPath, [cli, "serve"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HANZO_MCP_NO_ZAP: "1" },
});

let timer;
let buf = "";
let resolved = false;

const done = (ok, why) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timer);
  try {
    child.kill("SIGTERM");
  } catch {}
  if (ok) {
    console.log(`smoke ok: ${why}`);
    process.exit(0);
  } else {
    console.error(`smoke FAIL: ${why}`);
    process.exit(1);
  }
};

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1 && msg.result?.serverInfo?.name === "hanzo-mcp") {
      done(true, `serverInfo.name=hanzo-mcp version=${msg.result.serverInfo.version}`);
      return;
    }
    if (msg.error) {
      done(false, `initialize error: ${JSON.stringify(msg.error)}`);
      return;
    }
  }
});

child.on("error", (err) => done(false, `spawn error: ${err.message}`));
child.on("exit", (code, sig) => {
  if (!resolved) done(false, `child exited before reply (code=${code} sig=${sig})`);
});

const req = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0" },
  },
});
child.stdin.write(req + "\n");

timer = setTimeout(() => done(false, "no response within 20s"), 20_000);
