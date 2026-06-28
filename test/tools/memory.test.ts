import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TEST_TEMP_DIR } from '../setup.js';
import { LocalBackend } from '../../src/memory/local.js';
import { CloudBackend } from '../../src/memory/cloud.js';
import { SyncBackend } from '../../src/memory/sync.js';
import { selectBackend, backendChoice } from '../../src/memory/index.js';
import { memoryTool } from '../../src/tools/memory.js';

// Isolate storage + credentials to this suite's temp dir; no network, no real creds.
const STORE = path.join(TEST_TEMP_DIR, 'memory.json');
const CREDS = path.join(TEST_TEMP_DIR, 'credentials.json');

const ENV_KEYS = ['MEMORY_PATH', 'HANZO_CREDENTIALS_FILE', 'HANZO_MEMORY_BACKEND', 'HANZO_MEMORY_URL', 'HANZO_CLOUD_URL', 'HANZO_MCP_KEYCHAIN'];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.MEMORY_PATH = STORE;
  process.env.HANZO_CREDENTIALS_FILE = CREDS;
  await fs.rm(STORE, { force: true });
  await fs.rm(CREDS, { force: true });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function textOf(res: any): string {
  return res.content.map((c: any) => c.text).join('\n');
}

describe('LocalBackend (default, on-disk)', () => {
  test('store + recall round-trips', async () => {
    const b = new LocalBackend(STORE);
    const { created } = await b.store({ key: 'pref', value: 'User prefers dark mode', namespace: 'default', tags: ['ui'] });
    expect(created).toBe(true);

    const recalled = await b.recall({ namespace: 'default', scoped: true, key: 'pref' });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].value).toBe('User prefers dark mode');
    expect(recalled[0].tags).toEqual(['ui']);
  });

  test('store upsert reports not-created on second write', async () => {
    const b = new LocalBackend(STORE);
    await b.store({ key: 'k', value: 'v1', namespace: 'default' });
    const { created } = await b.store({ key: 'k', value: 'v2', namespace: 'default' });
    expect(created).toBe(false);
    const r = await b.recall({ namespace: 'default', scoped: true, key: 'k' });
    expect(r[0].value).toBe('v2');
  });

  test('full-text search, facts, update, delete, tags, merge, stats', async () => {
    const b = new LocalBackend(STORE);
    await b.store({ key: 'lang', value: 'User prefers Python', namespace: 'default' });
    await b.store({ key: 'editor', value: 'User likes vim', namespace: 'default' });

    const hits = await b.search({ query: 'python' });
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('lang');

    const fact = await b.addFact({ content: 'Use uv for Python', kb: 'coding' });
    expect(fact.id).toBeTruthy();
    const facts = await b.recallFacts({ kb: 'coding', query: 'uv' });
    expect(facts).toHaveLength(1);

    const updated = await b.update({ key: 'lang', namespace: 'default', value: 'User prefers Rust' });
    expect(updated?.value).toBe('User prefers Rust');

    const tagged = await b.setTag('lang', 'default', 'important', true);
    expect(tagged?.tags).toContain('important');

    const stats = await b.stats();
    expect(stats.entries).toBe(2);
    expect(stats.facts).toBe(1);

    const removed = await b.remove({ namespace: 'default', key: 'editor' });
    expect(removed).toBe(1);
  });
});

describe('memory tool (delegates to selected backend)', () => {
  test('default backend is local and store+recall round-trips with identical output', async () => {
    const stored = await memoryTool.handler({ action: 'store', key: 'k', value: 'hello world' });
    expect(textOf(stored)).toBe('Stored: k (11 chars)');

    const recalled = await memoryTool.handler({ action: 'recall', key: 'k', namespace: 'default' });
    expect(textOf(recalled)).toContain('hello world');
    expect(textOf(recalled)).toContain('[default] k');
  });

  test('upsert path reports Updated', async () => {
    await memoryTool.handler({ action: 'store', key: 'k', value: 'aaa' });
    const res = await memoryTool.handler({ action: 'store', key: 'k', value: 'bbbb' });
    expect(textOf(res)).toBe('Updated: k (4 chars)');
  });

  test('facts round-trip through the tool', async () => {
    const s = await memoryTool.handler({ action: 'facts', fact_action: 'store_fact', content: 'uv manages venvs', kb: 'coding' });
    expect(textOf(s)).toContain("Stored fact #1 in kb 'coding'");
    const r = await memoryTool.handler({ action: 'facts', fact_action: 'recall_facts', query: 'uv', kb: 'coding' });
    expect(textOf(r)).toContain('uv manages venvs');
  });

  test('help works without touching storage', async () => {
    const res = await memoryTool.handler({ action: 'help' });
    expect(textOf(res)).toContain('memory tool — actions');
    expect(textOf(res)).toContain('HANZO_MEMORY_BACKEND');
  });
});

describe('backend selection', () => {
  test('default selection is local', async () => {
    expect(backendChoice()).toBe('local');
    const b = await selectBackend();
    expect(b.kind).toBe('local');
  });

  test('sync selection composes local + cloud', async () => {
    process.env.HANZO_MEMORY_BACKEND = 'sync';
    expect(backendChoice()).toBe('sync');
    const b = await selectBackend();
    expect(b.kind).toBe('sync');
  });

  test('cloud selection without a token falls back to local (honest)', async () => {
    process.env.HANZO_MEMORY_BACKEND = 'cloud';
    const b = await selectBackend();
    expect(b.kind).toBe('local'); // no credential → fall back, not fake
  });
});

describe('CloudBackend honesty', () => {
  test('available() reports not-authenticated without a token (no network)', async () => {
    const c = new CloudBackend();
    const a = await c.available();
    expect(a.ok).toBe(false);
    expect(a.detail).toMatch(/not authenticated/i);
  });

  test('store throws a clear error when unauthenticated', async () => {
    const c = new CloudBackend();
    await expect(c.store({ key: 'k', value: 'v', namespace: 'default' })).rejects.toThrow(/not authenticated/i);
  });

  test('SyncBackend serves reads from local even when cloud is unauthenticated', async () => {
    const sync = new SyncBackend(new LocalBackend(STORE), new CloudBackend());
    const { created } = await sync.store({ key: 'k', value: 'local-first', namespace: 'default' });
    expect(created).toBe(true);
    const r = await sync.recall({ namespace: 'default', scoped: true, key: 'k' });
    expect(r[0].value).toBe('local-first');
  });
});
