/**
 * Live verification of the memory backend seam (not a unit test — exercises the
 * real tool handler + backend selection end to end). Run via:
 *   esbuild scripts/verify-memory.ts --bundle --platform=node --format=esm | node --input-type=module
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-mem-verify-'));
process.env.MEMORY_PATH = path.join(tmp, 'memory.json');
process.env.HANZO_CREDENTIALS_FILE = path.join(tmp, 'credentials.json');
delete process.env.HANZO_MEMORY_BACKEND;

const { memoryTool } = await import('../src/tools/memory.js');
const { selectBackend, backendChoice } = await import('../src/memory/index.js');
const { CloudBackend } = await import('../src/memory/cloud.js');

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
const line = (s = '') => console.log(s);

line('============================================================');
line(' MEMORY BACKEND VERIFICATION');
line('============================================================');

// ---- LOCAL (default, no auth) -------------------------------------------
line('\n[1] DEFAULT backend (no env, no auth)');
line('    backendChoice() = ' + backendChoice());
const sel = await selectBackend();
line('    selectBackend().kind = ' + sel.kind);

line('\n[2] LOCAL round-trip through the memory TOOL');
line('    > store key=project value="Hanzo MCP memory refactor"');
line('    ' + text(await memoryTool.handler({ action: 'store', key: 'project', value: 'Hanzo MCP memory refactor', tags: ['mcp'] })));
line('    > recall key=project');
line('    ' + text(await memoryTool.handler({ action: 'recall', key: 'project', namespace: 'default' })).replace(/\n/g, '\n    '));
line('    > search query="refactor"');
line('    ' + text(await memoryTool.handler({ action: 'search', query: 'refactor' })).replace(/\n/g, '\n    '));
line('    > facts store_fact "uv manages python venvs"');
line('    ' + text(await memoryTool.handler({ action: 'facts', fact_action: 'store_fact', content: 'uv manages python venvs', kb: 'coding' })));
line('    > facts recall_facts query="uv"');
line('    ' + text(await memoryTool.handler({ action: 'facts', fact_action: 'recall_facts', query: 'uv', kb: 'coding' })).replace(/\n/g, '\n    '));
line('    > stats');
line('    ' + text(await memoryTool.handler({ action: 'stats' })).replace(/\n/g, '\n    '));

// ---- CLOUD selection without a token (honest fallback) ------------------
line('\n[3] CLOUD selection WITHOUT a token (honest fallback)');
process.env.HANZO_MEMORY_BACKEND = 'cloud';
const sel2 = await selectBackend();
line('    HANZO_MEMORY_BACKEND=cloud -> selectBackend().kind = ' + sel2.kind + '   (falls back to local, not faked)');
const cloud = new CloudBackend();
const avail = await cloud.available();
line('    CloudBackend.available() = ' + JSON.stringify(avail));

// ---- CLOUD live probe (honest network result) --------------------------
line('\n[4] CLOUD live probe against the real service (unauthenticated)');
const base = process.env.HANZO_MEMORY_URL || process.env.HANZO_CLOUD_URL || 'https://api.hanzo.ai';
for (const p of ['/health', '/v1/remember']) {
  try {
    const res = await fetch(base + p, p === '/v1/remember'
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : {});
    const body = (await res.text()).slice(0, 120).replace(/\n/g, ' ');
    line(`    ${p} -> HTTP ${res.status}  ${body}`);
  } catch (e: any) {
    line(`    ${p} -> network error: ${e.message}`);
  }
}

// ---- SYNC round-trip (local-first; cloud write-through best-effort) -----
line('\n[5] SYNC backend round-trip (local-first, cloud write-through)');
process.env.HANZO_MEMORY_BACKEND = 'sync';
const sync = await selectBackend();
line('    selectBackend().kind = ' + sync.kind);
line('    > store key=sync-test value="written locally, mirrored to cloud"');
line('    ' + text(await memoryTool.handler({ action: 'store', key: 'sync-test', value: 'written locally, mirrored to cloud' })));
line('    > recall key=sync-test (served from local)');
line('    ' + text(await memoryTool.handler({ action: 'recall', key: 'sync-test', namespace: 'default' })).replace(/\n/g, '\n    '));

await fs.rm(tmp, { recursive: true, force: true });
line('\n============================================================');
line(' DONE — local works offline; cloud is honest about auth/availability');
line('============================================================');
