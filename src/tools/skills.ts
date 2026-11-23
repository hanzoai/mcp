/**
 * skills — First-class Hanzo Skills MCP tool (HIP-0300).
 *
 * Actions: search, detect, get, install, list.
 * Queries https://hanzoskills.com/search.json (1,470+ skills, Tier-1 index) and
 * https://hanzoskills.com/skills/<slug>/SKILL.md (Tier-2 full markdown), overrideable via
 * HANZOSKILLS_API_URL, plus /v1/tool/skills on api.hanzo.ai. Installs SKILL.md into
 * ~/.agents/skills/<slug>/SKILL.md with strict slug sanitization (^[a-z0-9][a-z0-9_-]{0,63}$).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Tool, ToolResult } from '../types/index.js';
import { resolveHanzoApiBase, resolveHanzoToken } from './hanzo-auth.js';

export const DEFAULT_SKILLS_BASE_URL = 'https://hanzoskills.com';
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

interface SkillEntry {
  slug: string;
  category?: string;
  description: string;
  tags?: string[];
  url?: string;
  source?: string;
}

function skillsBaseUrl(): string {
  return (process.env.HANZOSKILLS_API_URL?.trim() || DEFAULT_SKILLS_BASE_URL).replace(/\/+$/, '');
}

function cloudBase(): string {
  return resolveHanzoApiBase();
}

function cloudToken(): string {
  return resolveHanzoToken();
}

function skillsRoot(): string {
  const custom = process.env.HANZO_SKILLS_DIR?.trim();
  if (custom) return custom;
  return path.join(os.homedir(), '.agents', 'skills');
}

function frontmatterDescription(md: string): string {
  const normalized = md.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return '';
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return '';
  const block = normalized.slice(4, end);
  for (const line of block.split('\n')) {
    if (line.startsWith('description:')) {
      const v = line.slice('description:'.length).trim();
      if (v.startsWith('"')) {
        try {
          return JSON.parse(v);
        } catch {}
      }
      return v.replace(/^'+|'+$/g, '');
    }
  }
  return '';
}

function parseEntries(val: any, source: string, origin: string): SkillEntry[] {
  const arr = Array.isArray(val)
    ? val
    : Array.isArray(val?.s)
      ? val.s
      : Array.isArray(val?.skills)
        ? val.skills
        : Array.isArray(val?.tools)
          ? val.tools
          : Array.isArray(val?.items)
            ? val.items
            : [];
  const base = origin.replace(/\/+$/, '').replace(/\/api\/skills$/, '');
  const out: SkillEntry[] = [];
  for (const item of arr) {
    const slug = String(item?.i ?? item?.slug ?? item?.name ?? item?.id ?? '').trim();
    if (!validSlug(slug)) continue;
    const category = typeof (item?.c ?? item?.category) === 'string' && (item.c || item.category) ? String(item.c ?? item.category) : undefined;
    const description = typeof (item?.d ?? item?.description) === 'string' ? String(item.d ?? item.description) : '';
    const rawTags = item?.g ?? item?.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.map(String)
      : typeof rawTags === 'string' && rawTags.trim()
        ? rawTags.split(/[,\s]+/).filter(Boolean)
        : undefined;
    const rawUrl = typeof item?.url === 'string' ? item.url : undefined;
    const url = rawUrl
      ? rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? rawUrl
        : `${base}/${rawUrl.replace(/^\/+/, '')}`
      : `${base}/skills/${slug}/SKILL.md`;
    out.push({
      slug,
      ...(category ? { category } : {}),
      description,
      ...(tags?.length ? { tags } : {}),
      url,
      source,
    });
  }
  return out;
}

async function fetchCatalog(includeOrg = true): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>();
  const base = skillsBaseUrl();
  const candidates =
    base.endsWith('/api/skills') || base.endsWith('.json')
      ? [base]
      : [`${base}/search.json`, `${base}/.well-known/agent-skills/index.json`];

  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        for (const s of parseEntries(await r.json(), 'hanzoskills', base)) {
          merged.set(s.slug, s);
        }
        if (merged.size > 0) break;
      } else {
        lastErr = new Error(`${url}: HTTP ${r.status}`);
      }
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (merged.size === 0 && lastErr) throw lastErr;

  const tok = cloudToken();
  if (includeOrg && tok) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${tok}` };
      if (process.env.HANZO_ORG?.trim()) headers['X-Org-Id'] = process.env.HANZO_ORG.trim();
      const r = await fetch(`${cloudBase()}/v1/tool/skills`, { headers, signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        for (const s of parseEntries(await r.json(), 'hanzo_cloud', cloudBase())) {
          if (!merged.has(s.slug)) merged.set(s.slug, s);
        }
      }
    } catch {}
  }

  return [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function fetchSkillMarkdown(slug: string): Promise<{ content: string; url: string }> {
  if (!validSlug(slug)) {
    throw new Error(`invalid skill slug "${slug}": must match ^[a-z0-9][a-z0-9_-]{0,63}$`);
  }
  const base = skillsBaseUrl();
  const urls = base.endsWith('/api/skills')
    ? [`${base}/${slug}`]
    : [`${base}/skills/${slug}/SKILL.md`, `${base}/${slug}.md`];

  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const txt = await r.text();
      if (ct.includes('json') || txt.trimStart().startsWith('{')) {
        const v = JSON.parse(txt);
        const md = v?.content ?? v?.markdown ?? v?.skill_md;
        if (typeof md === 'string' && md.trim()) return { content: md, url };
      } else if (txt.trim()) {
        return { content: txt, url };
      }
    } catch {}
  }

  const tok = cloudToken();
  if (tok) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${tok}` };
      if (process.env.HANZO_ORG?.trim()) headers['X-Org-Id'] = process.env.HANZO_ORG.trim();
      const r = await fetch(`${cloudBase()}/v1/tool/skills/authored`, { headers, signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        const authored: any = await r.json();
        const hit = Array.isArray(authored?.skills) ? authored.skills.find((x: any) => x?.name === slug) : null;
        if (typeof hit?.content === 'string' && hit.content.trim()) {
          return { content: hit.content, url: `${cloudBase()}/v1/tool/skills/authored` };
        }
      }
    } catch {}
  }

  throw new Error(`skill "${slug}" not found on ${base}`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectSignals(ws: string): Promise<string[]> {
  const signals = new Set<string>(['hanzo']);
  if (await fileExists(path.join(ws, 'Cargo.toml'))) {
    signals.add('rust');
    signals.add('hanzo-mcp');
  }
  if (await fileExists(path.join(ws, 'go.mod'))) {
    signals.add('go-sdk');
    signals.add('hanzo-base');
    signals.add('hanzo-cloud');
  }
  if ((await fileExists(path.join(ws, 'package.json'))) || (await fileExists(path.join(ws, 'tsconfig.json')))) {
    signals.add('hanzo-node');
    signals.add('frontend');
    signals.add('mcp-builder');
  }
  if (await fileExists(path.join(ws, 'pyproject.toml'))) {
    signals.add('hanzo-sdk');
    signals.add('kai');
  }
  if ((await fileExists(path.join(ws, 'compose.yml'))) || (await fileExists(path.join(ws, 'Dockerfile')))) {
    signals.add('hanzo-deploy');
    signals.add('hanzo-platform');
  }
  if ((await fileExists(path.join(ws, 'kustomization.yaml'))) || (await fileExists(path.join(ws, 'charts')))) {
    signals.add('hanzo-k8s');
    signals.add('hanzo-deploy');
  }
  return [...signals].sort();
}

function envelope(data: unknown, action: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'skills', action } }, null, 2) }],
  };
}

function fail(action: string, code: string, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'skills', action } }, null, 2) }],
    isError: true,
  };
}

export const skillsTool: Tool = {
  name: 'skills',
  description:
    'Discover, inspect, detect, list, and install agent skills from hanzoskills.com (/search.json & /skills/<slug>/SKILL.md) and Hanzo Cloud (/v1/tool/skills) into ~/.agents/skills/<slug>/SKILL.md.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'detect', 'get', 'install', 'list'],
        description: 'Skill operation: search | detect | get | install | list',
      },
      query: {
        type: 'string',
        description: 'Search words for action=search (e.g. "kai decisions" or "kubernetes deploy")',
      },
      category: {
        type: 'string',
        description: 'Optional category filter for action=search (e.g. "hanzo")',
      },
      slug: {
        type: 'string',
        description: 'Skill slug (^[a-z0-9][a-z0-9_-]{0,63}$) for get or install (alias: name)',
      },
      name: {
        type: 'string',
        description: 'Alias for slug',
      },
      path: {
        type: 'string',
        description: 'Workspace directory for action=detect (default: current directory)',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Maximum results to return (default 10)',
      },
      remote: {
        type: 'boolean',
        description: 'For action=list: also include remote catalog and org /v1/tool/skills entries',
      },
    },
    required: ['action'],
  },
  handler: async (args: any = {}): Promise<ToolResult> => {
    const action = String(args.action || '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10));
    const slug = String(args.slug ?? args.name ?? '').trim();

    try {
      switch (action) {
        case 'search': {
          const query = String(args.query ?? args.q ?? '').trim();
          if (!query) return fail('search', 'INVALID_ARGS', 'query required');
          const catFilter = String(args.category ?? '').trim().toLowerCase();
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          const catalog = await fetchCatalog(true);
          const joined = words.join('-');
          const hits: Array<{ score: number; entry: SkillEntry }> = [];
          for (const entry of catalog) {
            if (catFilter && (entry.category || '').toLowerCase() !== catFilter) continue;
            const nameLc = entry.slug.toLowerCase();
            const descLc = entry.description.toLowerCase();
            const tagsLc = (entry.tags || []).map((t) => t.toLowerCase());
            let score = nameLc === joined ? 25 : 0;
            let matched = false;
            for (const w of words) {
              if (nameLc.includes(w)) {
                score += 5;
                matched = true;
              } else if (tagsLc.some((t) => t.includes(w))) {
                score += 3;
                matched = true;
              } else if (descLc.includes(w)) {
                score += 1;
                matched = true;
              }
            }
            if (matched) hits.push({ score, entry });
          }
          hits.sort(
            (a, b) =>
              b.score - a.score ||
              a.entry.slug.length - b.entry.slug.length ||
              a.entry.slug.localeCompare(b.entry.slug),
          );
          return envelope(
            {
              query,
              total: hits.length,
              skills: hits.slice(0, limit).map((h) => h.entry),
            },
            'search',
          );
        }

        case 'detect': {
          const ws = path.resolve(args.path || process.cwd());
          const signals = await detectSignals(ws);
          const catalog = await fetchCatalog(true).catch(() => [] as SkillEntry[]);
          const recommended: SkillEntry[] = [];
          for (const sig of signals) {
            const hit = catalog.find((s) => s.slug === sig);
            if (hit) recommended.push(hit);
          }
          if (recommended.length === 0) {
            for (const s of catalog.filter((c) => signals.some((k) => c.slug.includes(k))).slice(0, limit)) {
              recommended.push(s);
            }
          }
          return envelope({ path: ws, signals, recommended }, 'detect');
        }

        case 'get': {
          if (!slug) return fail('get', 'INVALID_ARGS', 'slug required');
          if (!validSlug(slug)) {
            return fail('get', 'INVALID_SLUG', `invalid skill slug "${slug}": must match ^[a-z0-9][a-z0-9_-]{0,63}$`);
          }
          const { content, url } = await fetchSkillMarkdown(slug);
          return envelope(
            {
              slug,
              description: frontmatterDescription(content),
              url,
              content,
            },
            'get',
          );
        }

        case 'install': {
          if (!slug) return fail('install', 'INVALID_ARGS', 'slug required');
          if (!validSlug(slug)) {
            return fail(
              'install',
              'INVALID_SLUG',
              `invalid skill slug "${slug}": must match ^[a-z0-9][a-z0-9_-]{0,63}$`,
            );
          }
          const { content, url } = await fetchSkillMarkdown(slug);
          const root = skillsRoot();
          const dir = path.join(root, slug);
          await fs.mkdir(dir, { recursive: true });
          const dest = path.join(dir, 'SKILL.md');
          const tmp = path.join(dir, `.SKILL.md.tmp.${process.pid}`);
          await fs.writeFile(tmp, content, 'utf8');
          await fs.rename(tmp, dest);
          return envelope(
            {
              installed: true,
              slug,
              path: dest,
              bytes: Buffer.byteLength(content, 'utf8'),
              source_url: url,
            },
            'install',
          );
        }

        case 'list': {
          const root = skillsRoot();
          const installed: Array<Record<string, unknown>> = [];
          const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
          for (const d of dirents) {
            if (!d.isDirectory() || !validSlug(d.name)) continue;
            const p = path.join(root, d.name, 'SKILL.md');
            try {
              const content = await fs.readFile(p, 'utf8');
              installed.push({
                slug: d.name,
                description: frontmatterDescription(content),
                path: p,
                bytes: Buffer.byteLength(content, 'utf8'),
              });
            } catch {}
          }
          installed.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
          const remote = args.remote ? (await fetchCatalog(true).catch(() => [])).slice(0, limit) : null;
          return envelope(
            {
              skills_dir: root,
              installed_count: installed.length,
              installed,
              remote,
            },
            'list',
          );
        }

        default:
          return fail(action, 'INVALID_ARGS', 'action must be one of: search, detect, get, install, list');
      }
    } catch (e: any) {
      return fail(action, 'UPSTREAM', e?.message || String(e));
    }
  },
};

export const skillsTools: Tool[] = [skillsTool];
