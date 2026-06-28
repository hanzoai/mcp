/**
 * LocalBackend — on-disk memory store at MEMORY_PATH || ~/.hanzo/memory.json.
 *
 * This is the DEFAULT backend. Behavior is identical to the pre-refactor
 * inline tool: the same load/save/expiry semantics and the same per-action
 * filtering/sorting logic, relocated here unchanged. Offline, zero-dependency,
 * cross-runtime compatible with the Rust store.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  AddFactInput,
  Availability,
  BulkOps,
  BulkResult,
  Entry,
  Fact,
  FactQuery,
  ListFactsQuery,
  ListFactsResult,
  ListQuery,
  ListResult,
  MemoryBackend,
  RecallQuery,
  RemoveQuery,
  SearchQuery,
  Stats,
  Store,
  StoreInput,
  UpdateInput,
} from './types.js';

function defaultPath(): string {
  return process.env.MEMORY_PATH || path.join(os.homedir(), '.hanzo', 'memory.json');
}

function isExpired(e: Entry): boolean {
  if (!e.ttl) return false;
  return new Date(e.ttl) < new Date();
}

export class LocalBackend implements MemoryBackend {
  readonly kind = 'local' as const;
  private readonly file: string;

  constructor(file?: string) {
    this.file = file || defaultPath();
  }

  // --- persistence --------------------------------------------------------

  private async load(): Promise<Store> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      return {
        entries: raw.entries || [],
        lastId: raw.lastId || 0,
        facts: raw.facts || [],
        lastFactId: raw.lastFactId || 0,
      };
    } catch {
      return { entries: [], lastId: 0, facts: [], lastFactId: 0 };
    }
  }

  /** Load and prune expired entries (lazy expiry, matches legacy behavior). */
  private async loadClean(): Promise<Store> {
    const s = await this.load();
    s.entries = s.entries.filter((e) => !isExpired(e));
    return s;
  }

  private async save(s: Store): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(s, null, 2));
  }

  async available(): Promise<Availability> {
    return { ok: true, detail: `local store at ${this.file}` };
  }

  // --- entries: single ops ------------------------------------------------

  async store(input: StoreInput): Promise<{ entry: Entry; created: boolean }> {
    const s = await this.loadClean();
    const now = new Date().toISOString();
    const idx = s.entries.findIndex((e) => e.key === input.key && e.namespace === input.namespace);
    if (idx >= 0) {
      const e = s.entries[idx];
      e.value = input.append ? e.value + '\n' + input.value : input.value;
      e.updated = now;
      if (input.tags) e.tags = input.tags;
      if (input.metadata) e.metadata = { ...e.metadata, ...input.metadata };
      if (input.ttl) e.ttl = input.ttl;
      await this.save(s);
      return { entry: e, created: false };
    }
    s.lastId++;
    const entry: Entry = {
      id: String(s.lastId),
      key: input.key,
      value: input.value,
      tags: input.tags || [],
      namespace: input.namespace,
      created: now,
      updated: now,
      metadata: input.metadata,
      ttl: input.ttl,
    };
    s.entries.push(entry);
    await this.save(s);
    return { entry, created: true };
  }

  async update(input: UpdateInput): Promise<Entry | null> {
    const s = await this.loadClean();
    const entry = s.entries.find((e) => e.key === input.key && e.namespace === input.namespace);
    if (!entry) return null;
    if (input.value) entry.value = input.value;
    if (input.tags) entry.tags = input.tags;
    if (input.metadata) entry.metadata = { ...entry.metadata, ...input.metadata };
    if (input.ttl) entry.ttl = input.ttl;
    entry.updated = new Date().toISOString();
    await this.save(s);
    return entry;
  }

  async recall(q: RecallQuery): Promise<Entry[]> {
    const s = await this.loadClean();
    let r = s.entries.filter((e) => e.namespace === q.namespace || !q.scoped);
    if (q.key) r = r.filter((e) => e.key === q.key);
    if (q.tag) r = r.filter((e) => e.tags.includes(q.tag!));
    return r.slice(0, q.limit || 10);
  }

  async search(q: SearchQuery): Promise<Entry[]> {
    const s = await this.loadClean();
    const terms = q.query.toLowerCase().split(/\s+/);
    let results = s.entries.filter((e) => {
      const text = `${e.key} ${e.value} ${e.tags.join(' ')} ${e.namespace}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
    if (q.namespace) results = results.filter((e) => e.namespace === q.namespace);
    if (q.tag) results = results.filter((e) => e.tags.includes(q.tag!));
    return results.slice(0, q.limit || 20);
  }

  async list(q: ListQuery): Promise<ListResult> {
    const s = await this.loadClean();
    let entries = s.entries;
    if (q.namespace) entries = entries.filter((e) => e.namespace === q.namespace);
    if (q.tag) entries = entries.filter((e) => e.tags.includes(q.tag!));
    const sortKey = q.sort || 'updated';
    entries.sort((a, b) => {
      if (sortKey === 'key') return a.key.localeCompare(b.key);
      if (sortKey === 'namespace') return a.namespace.localeCompare(b.namespace);
      return (b[sortKey as 'created' | 'updated'] || '').localeCompare(a[sortKey as 'created' | 'updated'] || '');
    });
    const namespaces = [...new Set(s.entries.map((e) => e.namespace))];
    return { entries: entries.slice(0, q.limit || 50), total: s.entries.length, namespaces };
  }

  async remove(q: RemoveQuery): Promise<number> {
    const s = await this.loadClean();
    let count = 0;
    if (q.key) {
      const i = s.entries.findIndex((e) => e.key === q.key && e.namespace === q.namespace);
      if (i < 0) return 0;
      s.entries.splice(i, 1);
      count = 1;
    } else if (q.tag) {
      const before = s.entries.length;
      s.entries = s.entries.filter((e) => !e.tags.includes(q.tag!));
      count = before - s.entries.length;
    }
    await this.save(s);
    return count;
  }

  async clear(namespace?: string): Promise<number> {
    const s = await this.loadClean();
    const before = s.entries.length;
    if (namespace) {
      s.entries = s.entries.filter((e) => e.namespace !== namespace);
    } else {
      s.entries = [];
    }
    await this.save(s);
    return before - s.entries.length;
  }

  async bulk(ops: BulkOps): Promise<BulkResult> {
    const s = await this.loadClean();
    const now = new Date().toISOString();
    const result: BulkResult = { created: 0, updated: 0, deleted: 0 };

    if (ops.create?.length) {
      for (const c of ops.create) {
        s.lastId++;
        s.entries.push({
          id: String(s.lastId),
          key: c.key,
          value: c.value,
          tags: c.tags || [],
          namespace: c.namespace || ops.namespace,
          created: now,
          updated: now,
        });
      }
      result.created = ops.create.length;
    }

    if (ops.update?.length) {
      for (const u of ops.update) {
        const uns = u.namespace || ops.namespace;
        const entry = s.entries.find((e) => e.key === u.key && e.namespace === uns);
        if (entry) {
          if (u.value) entry.value = u.value;
          if (u.tags) entry.tags = u.tags;
          entry.updated = now;
          result.updated++;
        }
      }
    }

    if (ops.delete?.length) {
      const keys = new Set(ops.delete);
      const before = s.entries.length;
      s.entries = s.entries.filter((e) => !keys.has(e.key));
      result.deleted = before - s.entries.length;
    }

    await this.save(s);
    return result;
  }

  // --- entries: whole-store ops -------------------------------------------

  async stats(): Promise<Stats> {
    const s = await this.loadClean();
    const namespaces = [...new Set(s.entries.map((e) => e.namespace))];
    const tags = [...new Set(s.entries.flatMap((e) => e.tags))];
    const sizeBytes = s.entries.reduce((acc, e) => acc + e.value.length, 0);
    const byNamespace: Record<string, number> = {};
    for (const e of s.entries) byNamespace[e.namespace] = (byNamespace[e.namespace] || 0) + 1;
    return { entries: s.entries.length, facts: s.facts.length, sizeBytes, namespaces, tags, byNamespace };
  }

  async namespaces(): Promise<Record<string, number>> {
    const s = await this.loadClean();
    const counts: Record<string, number> = {};
    for (const e of s.entries) counts[e.namespace] = (counts[e.namespace] || 0) + 1;
    return counts;
  }

  async history(key: string): Promise<Entry[]> {
    const s = await this.loadClean();
    return s.entries.filter((e) => e.key === key);
  }

  async exportEntries(namespace?: string, tag?: string): Promise<Entry[]> {
    const s = await this.loadClean();
    let entries = s.entries;
    if (namespace) entries = entries.filter((e) => e.namespace === namespace);
    if (tag) entries = entries.filter((e) => e.tags.includes(tag));
    return entries;
  }

  async importEntries(entries: Partial<Entry>[], namespace: string, tags?: string[]): Promise<number> {
    const s = await this.loadClean();
    const now = new Date().toISOString();
    for (const raw of entries) {
      s.lastId++;
      s.entries.push({
        id: String(s.lastId),
        key: raw.key || `import-${s.lastId}`,
        value: raw.value ?? '',
        tags: raw.tags || tags || [],
        namespace: raw.namespace || namespace,
        created: raw.created || now,
        updated: raw.updated || now,
        metadata: raw.metadata,
        ttl: raw.ttl,
      });
    }
    await this.save(s);
    return entries.length;
  }

  async merge(key: string): Promise<{ merged: number }> {
    const s = await this.loadClean();
    const matching = s.entries.filter((e) => e.key === key);
    if (matching.length < 2) return { merged: matching.length };
    const merged = matching.map((e) => e.value).join('\n---\n');
    const allTags = [...new Set(matching.flatMap((e) => e.tags))];
    const keep = matching[0];
    keep.value = merged;
    keep.tags = allTags;
    keep.updated = new Date().toISOString();
    s.entries = s.entries.filter((e) => e.key !== key || e.id === keep.id);
    await this.save(s);
    return { merged: matching.length };
  }

  async setTag(key: string, namespace: string, tag: string, on: boolean): Promise<Entry | null> {
    const s = await this.loadClean();
    const entry = s.entries.find((e) => e.key === key && e.namespace === namespace);
    if (!entry) return null;
    if (on) {
      if (!entry.tags.includes(tag)) entry.tags.push(tag);
    } else {
      entry.tags = entry.tags.filter((t) => t !== tag);
    }
    entry.updated = new Date().toISOString();
    await this.save(s);
    return entry;
  }

  // --- facts --------------------------------------------------------------

  async addFact(input: AddFactInput): Promise<Fact> {
    const s = await this.loadClean();
    s.lastFactId++;
    const fact: Fact = {
      id: String(s.lastFactId),
      content: input.content,
      kb: input.kb,
      tags: input.tags || [],
      created: new Date().toISOString(),
    };
    s.facts.push(fact);
    await this.save(s);
    return fact;
  }

  async recallFacts(q: FactQuery): Promise<Fact[]> {
    const s = await this.loadClean();
    let facts = s.facts.filter((f) => f.kb === q.kb);
    if (q.query) {
      const terms = q.query.toLowerCase().split(/\s+/);
      facts = facts.filter((f) => {
        const text = `${f.content} ${f.tags.join(' ')} ${f.kb}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
    }
    if (q.tag) facts = facts.filter((f) => f.tags.includes(q.tag!));
    return facts.slice(0, q.limit || 20);
  }

  async listFacts(q: ListFactsQuery): Promise<ListFactsResult> {
    const s = await this.loadClean();
    let facts = s.facts;
    if (q.kb) facts = facts.filter((f) => f.kb === q.kb);
    if (q.tag) facts = facts.filter((f) => f.tags.includes(q.tag!));
    const kbs = [...new Set(s.facts.map((f) => f.kb))];
    return { facts: facts.slice(0, q.limit || 50), total: s.facts.length, kbs };
  }

  async removeFact(id: string, kb: string): Promise<boolean> {
    const s = await this.loadClean();
    const idx = s.facts.findIndex((f) => f.id === id && f.kb === kb);
    if (idx < 0) return false;
    s.facts.splice(idx, 1);
    await this.save(s);
    return true;
  }
}
