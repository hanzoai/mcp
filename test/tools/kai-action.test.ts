/**
 * Tests for the `kai` tool (Kai Actions).
 *
 * The TypeScript runtime carries the schema and delegates the work to the Rust runtime's `actions` module, so what is tested
 * here is that the schema is the same text in all three places it lives, that the command line a call becomes is the one the
 * native CLI reads, and that a missing native runtime is said plainly. The executor's behaviour is tested in rust/src/actions.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kaiActionTool, kaiActionSchema, argv } from '../../src/tools/kai-action.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('kai (Kai Actions)', () => {
  test('the schema is the same text in the canonical file and in the Rust runtime', () => {
    const canonical = JSON.parse(readFileSync(join(root, 'schema', 'kai.json'), 'utf8'));
    const rust = JSON.parse(readFileSync(join(root, 'rust', 'schema', 'kai.json'), 'utf8'));
    expect(kaiActionSchema).toEqual(canonical);
    expect(rust).toEqual(canonical);
    expect(kaiActionTool.name).toBe('kai');
    expect(kaiActionTool.inputSchema).toEqual(canonical.inputSchema);
  });

  test('a call becomes the command line the native CLI reads', () => {
    const base = ['kai', 'run', '--cwd', '/w/ws', '--request', 'Run the tests'];
    expect(argv({ action: 'run', cwd: '/w/ws', request: 'Run the tests', ask: false })).toEqual(base);
    expect(argv({ cwd: '/w/ws', request: 'Run the tests', ask: false, approve: true, prove: true, cache: '/c', min_margin: 0.2 })).toEqual([...base, '--cache', '/c', '--approve', 'grant', '--prove', '--min-margin', '0.2']);
    expect(argv({ action: 'list' })).toEqual(['kai', 'list']);
    expect(argv({ action: 'triggers', request: 'x' })).toEqual(['kai', 'triggers', '--request', 'x']);
    const was = process.env.HANZO_API_BASE;
    process.env.HANZO_API_BASE = 'http://127.0.0.1:18977';
    try {
      const asking = argv({ cwd: '/w/ws', request: 'x', kai_url: 'https://evil.example/v1' });
      expect(asking).toContain('--kai');
      expect(asking[asking.indexOf('--kai') + 1]).toBe('http://127.0.0.1:18977/v1');
      expect(asking).not.toContain('https://evil.example/v1');
    } finally {
      if (was === undefined) delete process.env.HANZO_API_BASE;
      else process.env.HANZO_API_BASE = was;
    }
  });

  test('the tool says so when there is no native runtime, and when a call is malformed', async () => {
    const saved = process.env.HANZO_MCP_NATIVE;
    delete process.env.HANZO_MCP_NATIVE;
    try {
      const none = await kaiActionTool.handler({ request: 'Run the tests' });
      expect(none.isError).toBe(true);
      expect(none.content[0].text).toContain('native runtime');
      const bad = await kaiActionTool.handler({ action: 'fly' });
      expect(bad.content[0].text).toContain('action must be one of');
      const missing = await kaiActionTool.handler({ action: 'run' });
      expect(missing.content[0].text).toContain('request required');
    } finally {
      if (saved !== undefined) process.env.HANZO_MCP_NATIVE = saved;
    }
  });
});
