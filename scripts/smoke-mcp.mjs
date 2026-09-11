#!/usr/bin/env node
// MCP integration test against dist/cli.js over real stdio.
//
// Drives the same JSON-RPC surface Claude Desktop / Claude Code use,
// in sequence on one connection:
//   1. initialize          — handshake + serverInfo
//   2. tools/list          — full tool catalog
//   3. tools/call fs read  — actually read a file we wrote on disk
//   4. tools/call fs list  — list the cwd, expect our temp file in the result
//   5. resources/list      — system-prompt resource present
//   6. resources/read      — body of hanzo://system-prompt non-empty
//   7. list-tools          — every tool from 2, and no group without a tool
//   8. --core-only         — serve and list-tools narrow to the core group
//   9. install --claude-code — runs `claude mcp add` (a stand-in claude on PATH)
// Any failure -> exit 1 with the diagnostic. No silent passes.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "dist", "cli.js");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-smoke-"));
const probe = path.join(tmp, "probe.txt");
const probeBody = `hello-mcp-${process.pid}-${Date.now()}`;
await fs.writeFile(probe, probeBody, "utf8");

const child = spawn(process.execPath, [cli, "serve"], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: tmp,
  env: {
    ...process.env,
    HANZO_MCP_NO_ZAP: "1",         // don't bind WS in CI
    HANZO_MCP_DEBUG: "1",          // surface platform/path on failure
  },
});

const pending = new Map();          // id -> {resolve, reject}
let nextId = 2;
let buf = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const slot = pending.get(msg.id);
    if (!slot) continue;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`rpc ${msg.id} error: ${JSON.stringify(msg.error)}`));
    else slot.resolve(msg.result);
  }
});

const die = (why, err) => {
  console.error(`FAIL: ${why}`);
  if (err) console.error(err.stack || String(err));
  try { child.kill("SIGTERM"); } catch {}
  fs.rm(tmp, { recursive: true, force: true }).finally(() => process.exit(1));
};
child.on("error", (e) => die("spawn", e));
child.on("exit", (code, sig) => {
  if (pending.size) die(`child exited mid-test code=${code} sig=${sig}`);
});

const call = (method, params) => new Promise((resolve, reject) => {
  const id = method === "initialize" ? 1 : nextId++;
  pending.set(id, { resolve, reject });
  const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(req + "\n");
  setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }
  }, 20_000);
});

const ok = (msg) => console.log(`ok  ${msg}`);

try {
  // 1
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0" },
  });
  if (init?.serverInfo?.name !== "hanzo-mcp") {
    die(`bad serverInfo: ${JSON.stringify(init?.serverInfo)}`);
  }
  ok(`initialize → hanzo-mcp ${init.serverInfo.version} (protocol ${init.protocolVersion})`);

  // 2
  const list = await call("tools/list", {});
  if (!Array.isArray(list?.tools) || list.tools.length < 5) {
    die(`tools/list returned ${list?.tools?.length ?? 0} tools`);
  }
  const names = new Set(list.tools.map((t) => t.name));
  for (const required of ["fs"]) {
    if (!names.has(required)) die(`missing required tool: ${required}`);
  }
  ok(`tools/list → ${list.tools.length} tools (${[...names].slice(0, 6).join(", ")}…)`);

  // 3 — read the probe file we just created
  const read = await call("tools/call", {
    name: "fs",
    arguments: { action: "read", path: probe },
  });
  const readText = JSON.stringify(read);
  if (!readText.includes(probeBody)) {
    die(`fs.read did not return probe body. got: ${readText.slice(0, 400)}`);
  }
  ok(`tools/call fs.read → returned probe body verbatim`);

  // 4 — list cwd, expect probe.txt
  const ls = await call("tools/call", {
    name: "fs",
    arguments: { action: "list", path: tmp },
  });
  const lsText = JSON.stringify(ls);
  if (!lsText.includes("probe.txt")) {
    die(`fs.list did not include probe.txt. got: ${lsText.slice(0, 400)}`);
  }
  ok(`tools/call fs.list → saw probe.txt`);

  // 5
  const res = await call("resources/list", {});
  const uri = res?.resources?.[0]?.uri;
  if (uri !== "hanzo://system-prompt") {
    die(`resources/list missing hanzo://system-prompt. got: ${JSON.stringify(res)}`);
  }
  ok(`resources/list → hanzo://system-prompt`);

  // 6
  const rr = await call("resources/read", { uri: "hanzo://system-prompt" });
  const body = rr?.contents?.[0]?.text ?? "";
  if (body.length < 32) {
    die(`system-prompt body too small (${body.length} bytes)`);
  }
  ok(`resources/read → system prompt (${body.length} bytes)`);

  // 7 — list-tools prints what tools/list offered, under groups that each have a tool
  const run = (args, { env = {}, input } = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: tmp, input, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HANZO_MCP_NO_ZAP: "1", ...env },
    });
  const listed = (out) => out.split("\n").filter((l) => l.startsWith("  - ")).map((l) => l.slice(4).split(":")[0]);
  const lt = run(["list-tools"]);
  const lines = lt.stdout.split("\n");
  const empty = lines.filter((l, i) => /^\S.*:$/.test(l) && !l.includes("(") && !lines[i + 1]?.startsWith("  - "));
  const shown = listed(lt.stdout);
  const unlisted = [...names].filter((n) => !shown.includes(n));
  if (lt.status !== 0 || empty.length || unlisted.length || shown.length !== names.size) {
    die(`list-tools: exit ${lt.status}, empty groups ${JSON.stringify(empty)}, unlisted ${JSON.stringify(unlisted)}, ${shown.length} listed of ${names.size}`);
  }
  ok(`list-tools → ${shown.length} tools, no empty group`);

  // 8 — --core-only narrows serve and list-tools to the core group
  const CORE = "fs exec code git fetch workspace ui";
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map((m) => JSON.stringify(m) + "\n").join("");
  const answer = run(["serve", "--core-only"], { input }).stdout.split("\n").find((l) => l.includes('"id":2'));
  const served = answer ? JSON.parse(answer).result.tools.map((t) => t.name).join(" ") : "";
  const coreListed = listed(run(["list-tools", "--core-only"]).stdout).join(" ");
  if (served !== CORE || coreListed !== CORE) die(`--core-only: serve offered "${served}", list-tools printed "${coreListed}"`);
  ok(`--core-only → ${CORE}`);

  // 9 — install --claude-code has claude register the server, through a stand-in on PATH
  const bin = path.join(tmp, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "claude"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/argv"\n', { mode: 0o755 });
  const inst = run(["install", "--claude-code"], { env: { HOME: tmp, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const argv = (await fs.readFile(path.join(tmp, "argv"), "utf8").catch(() => "")).trim().split("\n").join(" ");
  if (inst.status !== 0 || argv !== "mcp add --scope user hanzo -- npx -y @hanzo/mcp serve") {
    die(`install --claude-code: exit ${inst.status}, claude ran with "${argv}"`);
  }
  ok(`install --claude-code → claude ${argv}`);

  console.log(`PASS  hanzo-mcp ${init.serverInfo.version} integration smoke (9/9)`);
  child.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  die("integration", e);
}
