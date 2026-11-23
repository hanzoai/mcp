import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { skillsTool, validSlug } from '../../src/tools/skills.js';

describe('skills tool', () => {
  let tmpDir: string;
  let origFetch: typeof globalThis.fetch;
  let savedSkillsDir: string | undefined;
  let savedApiUrl: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzo-skills-test-'));
    origFetch = globalThis.fetch;
    savedSkillsDir = process.env.HANZO_SKILLS_DIR;
    savedApiUrl = process.env.HANZOSKILLS_API_URL;
    process.env.HANZO_SKILLS_DIR = tmpDir;
    process.env.HANZOSKILLS_API_URL = 'https://mock.hanzoskills.test';
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    if (savedSkillsDir === undefined) delete process.env.HANZO_SKILLS_DIR;
    else process.env.HANZO_SKILLS_DIR = savedSkillsDir;
    if (savedApiUrl === undefined) delete process.env.HANZOSKILLS_API_URL;
    else process.env.HANZOSKILLS_API_URL = savedApiUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('validates slugs strictly against ^[a-z0-9][a-z0-9_-]{0,63}$', () => {
    for (const ok of ['kai', 'hanzo', 'hanzo-mcp', 'hip-0300', 'skill_1', 'a'.repeat(64)]) {
      expect(validSlug(ok)).toBe(true);
    }
    for (const bad of ['', '-kai', '_kai', 'Kai', '../evil', 'a/b', 'a\\b', 'a.b', 'a b', 'a'.repeat(65)]) {
      expect(validSlug(bad)).toBe(false);
    }
  });

  test('search, get, install, and list roundtrip cleanly while blocking traversal slugs', async () => {
    (globalThis as any).fetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u === 'https://mock.hanzoskills.test/search.json') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            v: 1,
            t: 2,
            s: [
              { i: 'kai', c: 'hanzo', d: 'Kai calibrated decisions', g: ['hanzo', 'decisions'] },
              { i: 'hanzo-mcp', c: 'hanzo', d: 'Hanzo MCP canonical tools', g: ['mcp'] },
            ],
          }),
        };
      }
      if (u === 'https://mock.hanzoskills.test/skills/kai/SKILL.md') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/markdown' }),
          text: async () => '---\nname: kai\ndescription: "Kai calibrated decisions"\n---\n# Kai\nDecide cleanly.\n',
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });

    const bad = await skillsTool.handler({ action: 'install', slug: '../etc/passwd' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0].text!).error.code).toBe('INVALID_SLUG');

    const searched = JSON.parse((await skillsTool.handler({ action: 'search', query: 'decisions' })).content[0].text!);
    expect(searched.ok).toBe(true);
    expect(searched.data.skills[0].slug).toBe('kai');

    const got = JSON.parse((await skillsTool.handler({ action: 'get', slug: 'kai' })).content[0].text!);
    expect(got.ok).toBe(true);
    expect(got.data.content).toContain('# Kai');

    const installed = JSON.parse((await skillsTool.handler({ action: 'install', slug: 'kai' })).content[0].text!);
    expect(installed.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, 'kai', 'SKILL.md'), 'utf8')).toContain('# Kai');

    const listed = JSON.parse((await skillsTool.handler({ action: 'list' })).content[0].text!);
    expect(listed.data.installed_count).toBe(1);
    expect(listed.data.installed[0].slug).toBe('kai');
  });
});
