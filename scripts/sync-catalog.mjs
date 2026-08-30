#!/usr/bin/env node
/**
 * Refreshes src/tools/catalog.json from the fleet's own typed operations.
 *
 * The catalog is generated in cloud (`plugin/gen-mcp-catalog`), because that is
 * where the operations are declared — this script fetches the answer rather than
 * deriving a second one. Point HANZO_CLOUD at a checkout to read it from disk;
 * with no checkout it asks the running fleet, which serves the same projection.
 *
 * It REFUSES to write a catalog smaller than the one it is replacing unless
 * --shrink is passed. A fleet that answered partially — a subsystem still
 * starting, a half-applied rollout — looks exactly like a fleet that lost
 * capabilities, and the quiet direction of that mistake is a client that stops
 * offering operations the API still serves.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'tools', 'catalog.json');
const shrink = process.argv.includes('--shrink');

const count = (c) => Object.values(c).reduce((n, e) => n + e.ops.length, 0);

async function fromFleet() {
  const base = process.env.HANZO_API_URL || 'https://api.hanzo.ai';
  const res = await fetch(`${base}/v1/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) throw new Error(`${base}: ${res.status}`);
  const body = await res.json();
  const tools = body?.result?.tools;
  if (!Array.isArray(tools)) throw new Error(`${base} served no tools`);
  const out = {};
  for (const t of tools) {
    // `describe` is the client's own tool, not a subsystem.
    if (t.name === 'describe') continue;
    const ops = t?.inputSchema?.properties?.op?.enum;
    if (Array.isArray(ops) && ops.length) out[t.name] = { ops: [...ops].sort() };
  }
  return out;
}

function fromCheckout(dir) {
  const p = join(dir, 'fleet', 'mcp.json');
  if (!existsSync(p)) throw new Error(`${p} not found — run: go run ./plugin/gen-mcp-catalog . in cloud`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const cloud = process.env.HANZO_CLOUD;
const next = cloud ? fromCheckout(cloud) : await fromFleet();
const source = cloud ? `${cloud}/fleet/mcp.json` : 'the running fleet';

const before = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const [was, now] = [count(before), count(next)];

if (now < was && !shrink) {
  console.error(
    `refusing to shrink the catalog: ${was} operations -> ${now}, read from ${source}.\n` +
      `A partial answer and a real removal look the same here. Re-run when the fleet is whole, ` +
      `or pass --shrink if operations were genuinely withdrawn.`,
  );
  process.exit(1);
}

writeFileSync(target, JSON.stringify(next, null, 1) + '\n');
console.log(
  `catalog.json: ${Object.keys(next).length} subsystems, ${now} operations, from ${source}` +
    (now === was ? ' (unchanged)' : ` (was ${was})`),
);
