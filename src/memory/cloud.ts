/**
 * CloudBackend — the Hanzo cloud memory service (hanzo-memory) over HTTP,
 * IAM-bearer authenticated, per-user by token owner.
 *
 * Base: HANZO_MEMORY_URL || ${HANZO_CLOUD_URL:-https://api.hanzo.ai}
 * Routes are the service's source-of-truth paths (FastAPI hanzo-memory):
 *   POST /v1/remember          retrieve relevant + store (semantic)
 *   POST /v1/memories/add      explicit store
 *   POST /v1/memories/update   update by memory id
 *   POST /v1/memories/delete   delete by memory id
 *   POST /v1/kb/facts/add|get|delete, GET /v1/kb/list
 *
 * This service is a SEMANTIC store (embeddings + vector recall), not a KV
 * mirror of the local file store. Local KV identity (key/namespace/tags/ttl)
 * rides in `metadata`. Whole-store introspection that the semantic model has
 * no endpoint for (list-all, stats, namespaces, history, export, merge, tag,
 * clear) is refused honestly via BackendUnsupported — use local or sync.
 */

import { authConfig, AuthConfig, resolveCredential } from '../auth/oauth.js';
import {
  AddFactInput,
  Availability,
  BackendUnsupported,
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
  StoreInput,
  UpdateInput,
} from './types.js';

function cloudBase(): string {
  const base =
    process.env.HANZO_MEMORY_URL ||
    process.env.HANZO_CLOUD_URL ||
    'https://api.hanzo.ai';
  return base.replace(/\/$/, '');
}

const ROUTES = {
  health: '/health',
  remember: '/v1/remember',
  add: '/v1/memories/add',
  update: '/v1/memories/update',
  del: '/v1/memories/delete',
  kbList: '/v1/kb/list',
  factsAdd: '/v1/kb/facts/add',
  factsGet: '/v1/kb/facts/get',
  factsDel: '/v1/kb/facts/delete',
};

interface Auth {
  token: string;
  userid: string;
}

export class CloudBackend implements MemoryBackend {
  readonly kind = 'cloud' as const;
  private readonly cfg: AuthConfig;
  private readonly base: string;

  constructor(cfg?: AuthConfig, base?: string) {
    this.cfg = cfg || authConfig();
    this.base = base || cloudBase();
  }

  /** Resolve a valid bearer + user id, or null when unauthenticated. */
  private async auth(): Promise<Auth | null> {
    const cred = await resolveCredential(this.cfg);
    if (!cred) return null;
    const userid = process.env.HANZO_MEMORY_USER || cred.sub || cred.email || 'me';
    return { token: cred.accessToken, userid };
  }

  private async post(path: string, body: Record<string, any>, token: string): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`cloud ${path} ${res.status}: ${text.substring(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async available(): Promise<Availability> {
    const a = await this.auth();
    if (!a) {
      return { ok: false, detail: 'not authenticated — run `hanzo-mcp auth login` (falling back to local)' };
    }
    try {
      const res = await fetch(`${this.base}${ROUTES.health}`, {
        headers: { Authorization: `Bearer ${a.token}` },
      });
      if (!res.ok) return { ok: false, detail: `cloud /health ${res.status} at ${this.base}` };
      return { ok: true, detail: `cloud ${this.base} as ${a.userid}` };
    } catch (e: any) {
      return { ok: false, detail: `cloud unreachable at ${this.base}: ${e.message}` };
    }
  }

  private async requireAuth(): Promise<Auth> {
    const a = await this.auth();
    if (!a) throw new Error('not authenticated — run `hanzo-mcp auth login`');
    return a;
  }

  // Pack local KV identity into the cloud memory metadata envelope.
  private pack(input: StoreInput | { key: string; value: string; namespace: string; tags?: string[]; metadata?: Record<string, any>; ttl?: string }): Record<string, any> {
    return {
      key: input.key,
      namespace: input.namespace,
      tags: input.tags || [],
      ...(input.ttl ? { ttl: input.ttl } : {}),
      ...(input.metadata || {}),
    };
  }

  // --- entries: single ops ------------------------------------------------

  async store(input: StoreInput): Promise<{ entry: Entry; created: boolean }> {
    const a = await this.requireAuth();
    const res = await this.post(
      ROUTES.add,
      { userid: a.userid, memoriestoadd: [input.value], metadata: this.pack(input) },
      a.token,
    );
    const id = (res?.memory_ids && res.memory_ids[0]) || String(res?.added_count || '');
    const now = new Date().toISOString();
    const entry: Entry = {
      id: String(id),
      key: input.key,
      value: input.value,
      tags: input.tags || [],
      namespace: input.namespace,
      created: now,
      updated: now,
      metadata: input.metadata,
      ttl: input.ttl,
    };
    return { entry, created: true };
  }

  async update(input: UpdateInput): Promise<Entry | null> {
    const a = await this.requireAuth();
    // The cloud service updates by memory id; the local `key` is used as the id.
    const res = await this.post(
      ROUTES.update,
      {
        userid: a.userid,
        memoryid: input.key,
        ...(input.value !== undefined ? { content: input.value } : {}),
        metadata: this.pack({ key: input.key, value: input.value || '', namespace: input.namespace, tags: input.tags, metadata: input.metadata, ttl: input.ttl }),
      },
      a.token,
    );
    if (!res) return null;
    const now = new Date().toISOString();
    return {
      id: input.key,
      key: input.key,
      value: input.value ?? '',
      tags: input.tags || [],
      namespace: input.namespace,
      created: now,
      updated: now,
      metadata: input.metadata,
      ttl: input.ttl,
    };
  }

  /** Semantic retrieval via /v1/remember (also stores the query as a memory). */
  private async retrieve(query: string, namespace: string, limit: number, token: string, userid: string): Promise<Entry[]> {
    const res = await this.post(
      ROUTES.remember,
      { userid, messagecontent: query, includememoryid: true, filterresults: false },
      token,
    );
    const rel: any[] = res?.relevant_memories || [];
    const now = new Date().toISOString();
    return rel.slice(0, limit).map((m: any, i: number) => {
      const content = typeof m === 'string' ? m : m.content;
      const id = typeof m === 'string' ? `cloud-${i}` : m.memoryId || m.memory_id || `cloud-${i}`;
      return {
        id: String(id),
        key: '',
        value: String(content),
        tags: [],
        namespace,
        created: now,
        updated: now,
      } as Entry;
    });
  }

  async recall(q: RecallQuery): Promise<Entry[]> {
    const a = await this.requireAuth();
    const query = q.key || q.tag || '';
    if (!query) {
      throw new BackendUnsupported('recall-without-query', this.kind);
    }
    return this.retrieve(query, q.namespace, q.limit || 10, a.token, a.userid);
  }

  async search(q: SearchQuery): Promise<Entry[]> {
    const a = await this.requireAuth();
    return this.retrieve(q.query, q.namespace || 'default', q.limit || 20, a.token, a.userid);
  }

  async list(_q: ListQuery): Promise<ListResult> {
    // Semantic store has no exhaustive list-all endpoint.
    throw new BackendUnsupported('list', this.kind);
  }

  async remove(q: RemoveQuery): Promise<number> {
    const a = await this.requireAuth();
    if (!q.key) throw new BackendUnsupported('remove-by-tag', this.kind);
    await this.post(ROUTES.del, { userid: a.userid, memoryid: q.key }, a.token);
    return 1;
  }

  async clear(_namespace?: string): Promise<number> {
    // Only /v1/user/delete exists (nukes ALL user memories) — too broad to map.
    throw new BackendUnsupported('clear', this.kind);
  }

  async bulk(ops: BulkOps): Promise<BulkResult> {
    const a = await this.requireAuth();
    const result: BulkResult = { created: 0, updated: 0, deleted: 0 };
    if (ops.create?.length) {
      for (const c of ops.create) {
        await this.post(
          ROUTES.add,
          { userid: a.userid, memoriestoadd: [c.value], metadata: this.pack({ key: c.key, value: c.value, namespace: c.namespace || ops.namespace, tags: c.tags }) },
          a.token,
        );
        result.created++;
      }
    }
    if (ops.update?.length) {
      for (const u of ops.update) {
        await this.post(
          ROUTES.update,
          { userid: a.userid, memoryid: u.key, ...(u.value !== undefined ? { content: u.value } : {}) },
          a.token,
        );
        result.updated++;
      }
    }
    if (ops.delete?.length) {
      for (const key of ops.delete) {
        await this.post(ROUTES.del, { userid: a.userid, memoryid: key }, a.token);
        result.deleted++;
      }
    }
    return result;
  }

  // --- entries: whole-store ops (not modeled by the semantic service) -----

  async stats(): Promise<Stats> {
    throw new BackendUnsupported('stats', this.kind);
  }
  async namespaces(): Promise<Record<string, number>> {
    throw new BackendUnsupported('namespaces', this.kind);
  }
  async history(_key: string): Promise<Entry[]> {
    throw new BackendUnsupported('history', this.kind);
  }
  async exportEntries(_namespace?: string, _tag?: string): Promise<Entry[]> {
    throw new BackendUnsupported('export', this.kind);
  }

  async importEntries(entries: Partial<Entry>[], namespace: string, tags?: string[]): Promise<number> {
    const a = await this.requireAuth();
    let n = 0;
    for (const e of entries) {
      await this.post(
        ROUTES.add,
        { userid: a.userid, memoriestoadd: [e.value ?? ''], metadata: this.pack({ key: e.key || `import-${n}`, value: e.value ?? '', namespace: e.namespace || namespace, tags: e.tags || tags }) },
        a.token,
      );
      n++;
    }
    return n;
  }

  async merge(_key: string): Promise<{ merged: number }> {
    throw new BackendUnsupported('merge', this.kind);
  }
  async setTag(_key: string, _namespace: string, _tag: string, _on: boolean): Promise<Entry | null> {
    throw new BackendUnsupported('tag/untag', this.kind);
  }

  // --- facts --------------------------------------------------------------

  async addFact(input: AddFactInput): Promise<Fact> {
    const a = await this.requireAuth();
    const res = await this.post(
      ROUTES.factsAdd,
      { userid: a.userid, kb_id: input.kb, facts: [{ content: input.content, metadata: { tags: input.tags || [] } }] },
      a.token,
    );
    const added = (res?.facts && res.facts[0]) || {};
    return {
      id: String(added.fact_id || ''),
      content: input.content,
      kb: input.kb,
      tags: input.tags || [],
      created: new Date().toISOString(),
    };
  }

  async recallFacts(q: FactQuery): Promise<Fact[]> {
    const a = await this.requireAuth();
    if (!q.query) throw new BackendUnsupported('list-facts-without-query', this.kind);
    const res = await this.post(
      ROUTES.factsGet,
      { userid: a.userid, kb_id: q.kb, query: q.query, limit: q.limit || 20 },
      a.token,
    );
    const facts: any[] = res?.facts || [];
    const now = new Date().toISOString();
    return facts.map((f) => ({
      id: String(f.fact_id || ''),
      content: String(f.content || ''),
      kb: q.kb,
      tags: (f.metadata && f.metadata.tags) || [],
      created: now,
    }));
  }

  async listFacts(_q: ListFactsQuery): Promise<ListFactsResult> {
    const a = await this.requireAuth();
    // The service lists knowledge bases; exhaustive fact listing needs a query.
    const res = await this.post(ROUTES.kbList, { userid: a.userid }, a.token).catch(async () => {
      // /v1/kb/list is GET in the service; fall back to GET if POST is rejected.
      const r = await fetch(`${this.base}${ROUTES.kbList}`, { headers: { Authorization: `Bearer ${a.token}` } });
      return r.ok ? r.json() : { knowledge_bases: [] };
    });
    const kbs: string[] = (res?.knowledge_bases || []).map((k: any) => k.kb_id || k.name || String(k));
    return { facts: [], total: 0, kbs };
  }

  async removeFact(id: string, kb: string): Promise<boolean> {
    const a = await this.requireAuth();
    await this.post(ROUTES.factsDel, { userid: a.userid, kb_id: kb, fact_id: id }, a.token);
    return true;
  }
}
