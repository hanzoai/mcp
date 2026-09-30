/**
 * fs against python-sdk's contract (the Rust runtime's tests assert the same):
 * `uri` (or `path`), the unified envelope, `sha256:<hex>` hashes, `write` that
 * only creates, and `apply_patch` guarded by the hash a read returned.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fsTool, parsePatch } from '../../../src/tools/unified/fs.js';

let d: string;
const at = (n: string) => path.join(d, n);
const call = async (args: any) => {
  const r: any = await fsTool.handler(args);
  return { ...JSON.parse(r.content[0].text), isError: !!r.isError, content: r.content };
};

beforeEach(() => { d = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-')); });
afterEach(() => { fs.rmSync(d, { recursive: true, force: true }); });

describe('fs', () => {
  test('write creates; read numbers lines and returns the hash', async () => {
    const w = await call({ action: 'write', uri: at('sub/a.txt'), content: 'one\ntwo\nthree\n' });
    expect(w.ok).toBe(true);
    expect(w.data.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const r = await call({ action: 'read', path: at('sub/a.txt'), offset: 1, limit: 1 });
    expect(r.data.text).toBe('     2│two');
    expect(r.data.total_lines).toBe(3);
    expect(r.data.hash).toBe(w.data.hash);
    expect(r.data.uri).toMatch(/^file:\/\//);

    const again = await call({ action: 'write', uri: at('sub/a.txt'), content: 'x' });
    expect([again.ok, again.error.code]).toEqual([false, 'CONFLICT']);
  });

  test('apply_patch needs the current hash and a unique match', async () => {
    fs.writeFileSync(at('b.txt'), 'alpha beta beta\n');
    const hash = (await call({ action: 'stat', uri: at('b.txt') })).data.hash;
    expect((await call({ action: 'apply_patch', uri: at('b.txt'), old_text: 'alpha', new_text: 'A', base_hash: 'sha256:0' })).error.code).toBe('CONFLICT');
    expect((await call({ action: 'apply_patch', uri: at('b.txt'), old_text: 'beta', new_text: 'B', base_hash: hash })).error.code).toBe('INVALID_PARAMS');
    const ok = await call({ action: 'apply_patch', uri: at('b.txt'), old_text: 'alpha', new_text: '$& A', base_hash: hash });
    expect(ok.data.previous_hash).toBe(hash);
    expect(fs.readFileSync(at('b.txt'), 'utf8')).toBe('$& A beta beta\n');
  });

  test('list walks to depth, filters and pages', async () => {
    for (const f of ['a.rs', 'b.txt', 'src/c.rs', 'src/deep/d.rs']) {
      fs.mkdirSync(path.dirname(at(f)), { recursive: true });
      fs.writeFileSync(at(f), 'x');
    }
    const names = (r: any) => r.data.entries.map((e: any) => e.name);
    expect(names(await call({ action: 'list', uri: d }))).toEqual(['a.rs', 'b.txt', 'src']);
    expect(names(await call({ action: 'list', uri: d, depth: 3, pattern: '*.rs' }))).toEqual(['a.rs']);
    const page = await call({ action: 'list', uri: d, limit: 2 });
    expect(page.data.paging).toEqual({ cursor: '2', more: true, total: 3 });
    expect(names(await call({ action: 'list', uri: d, limit: 2, cursor: '2' }))).toEqual(['src']);
  });

  test('search_text finds lines under a glob, and a pattern is never a shell word', async () => {
    fs.writeFileSync(at('a.rs'), 'fn main() {}\nlet needle = 1;\n');
    fs.writeFileSync(at('b.txt'), 'needle\n');
    const s = await call({ action: 'search_text', pattern: 'needle', uri: d, glob: '*.rs' });
    expect(s.data.matches).toEqual([{ uri: 'file://' + at('a.rs'), line: 2, text: 'let needle = 1;' }]);
    const boom = at('boom');
    await call({ action: 'search_text', pattern: `"; touch ${boom}; echo "`, uri: d });
    expect(fs.existsSync(boom)).toBe(false);
  });

  test('patch applies the Rust grammar', async () => {
    fs.writeFileSync(at('u.txt'), 'keep\nold\n');
    fs.writeFileSync(at('gone.txt'), 'x');
    const cwd = process.cwd();
    process.chdir(d);
    try {
      const p = await call({ action: 'patch', input: '*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: u.txt\n@@\n keep\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch' });
      expect(p.data.success).toBe(true);
    } finally {
      process.chdir(cwd);
    }
    expect(fs.readFileSync(at('new.txt'), 'utf8')).toBe('hello\n');
    expect(fs.readFileSync(at('u.txt'), 'utf8')).toBe('keep\nnew\n');
    expect(fs.existsSync(at('gone.txt'))).toBe(false);
    expect(parsePatch('*** Delete File: x')).toEqual([{ op: 'delete', path: 'x', hunks: [], content: '' }]);
  });

  test('mv, mkdir and a guarded rm', async () => {
    expect((await call({ action: 'mkdir', uri: at('x/y') })).data.created).toBe(true);
    expect((await call({ action: 'mkdir', uri: at('x/y') })).data.created).toBe(false);
    fs.writeFileSync(at('f'), '1');
    expect((await call({ action: 'mv', uri: at('f'), destination: at('x/y/g') })).data.moved).toBe(true);
    expect((await call({ action: 'rm', uri: at('x') })).error.code).toBe('INVALID_PARAMS');
    expect((await call({ action: 'rm', uri: at('x'), confirm: true })).data.removed).toBe(true);
    expect(fs.existsSync(at('x'))).toBe(false);
  });

  test('paths are absolute, actions are named, an image is pixels', async () => {
    expect((await call({ action: 'read', uri: 'relative.txt' })).error.message).toBe('Path must be absolute');
    expect((await call({ action: 'edit', uri: '/tmp/x' })).error.message).toMatch(/^Unknown action 'edit'\. Available: read, write, stat, list/);
    expect((await call({})).data.actions).toHaveLength(10);
    fs.writeFileSync(at('i.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    const r = await call({ action: 'read', uri: at('i.png') });
    expect(r.data.mime).toBe('image/png');
    expect(r.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  });
});
