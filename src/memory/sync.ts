/**
 * SyncBackend — local-first, write-through to cloud.
 *
 * Local is the working copy and the source of truth for reads (complete,
 * offline, fast). Every mutation lands locally first, then replicates to the
 * cloud best-effort: a cloud failure is logged, never fatal — the local write
 * already succeeded. This composes the two peer backends; it does not replace
 * either. Reads are served from local so behavior matches the default backend.
 */

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
  StoreInput,
  UpdateInput,
} from './types.js';

export class SyncBackend implements MemoryBackend {
  readonly kind = 'sync' as const;

  constructor(
    private readonly local: MemoryBackend,
    private readonly cloud: MemoryBackend,
  ) {}

  /** Replicate a mutation to cloud without failing the (already-done) local write. */
  private async mirror(op: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      console.error(`[memory:sync] cloud write-through failed for ${op}: ${e.message}`);
    }
  }

  async available(): Promise<Availability> {
    const c = await this.cloud.available();
    return { ok: true, detail: `sync: local primary; cloud ${c.ok ? 'replicating' : 'offline'} (${c.detail})` };
  }

  // --- writes: local first, then mirror to cloud --------------------------

  async store(input: StoreInput): Promise<{ entry: Entry; created: boolean }> {
    const res = await this.local.store(input);
    await this.mirror('store', () => this.cloud.store(input));
    return res;
  }

  async update(input: UpdateInput): Promise<Entry | null> {
    const res = await this.local.update(input);
    await this.mirror('update', () => this.cloud.update(input));
    return res;
  }

  async remove(q: RemoveQuery): Promise<number> {
    const n = await this.local.remove(q);
    await this.mirror('remove', () => this.cloud.remove(q));
    return n;
  }

  async clear(namespace?: string): Promise<number> {
    const n = await this.local.clear(namespace);
    await this.mirror('clear', () => this.cloud.clear(namespace));
    return n;
  }

  async bulk(ops: BulkOps): Promise<BulkResult> {
    const res = await this.local.bulk(ops);
    await this.mirror('bulk', () => this.cloud.bulk(ops));
    return res;
  }

  async importEntries(entries: Partial<Entry>[], namespace: string, tags?: string[]): Promise<number> {
    const n = await this.local.importEntries(entries, namespace, tags);
    await this.mirror('import', () => this.cloud.importEntries(entries, namespace, tags));
    return n;
  }

  async merge(key: string): Promise<{ merged: number }> {
    const res = await this.local.merge(key);
    await this.mirror('merge', () => this.cloud.merge(key));
    return res;
  }

  async setTag(key: string, namespace: string, tag: string, on: boolean): Promise<Entry | null> {
    const res = await this.local.setTag(key, namespace, tag, on);
    await this.mirror('setTag', () => this.cloud.setTag(key, namespace, tag, on));
    return res;
  }

  async addFact(input: AddFactInput): Promise<Fact> {
    const res = await this.local.addFact(input);
    await this.mirror('addFact', () => this.cloud.addFact(input));
    return res;
  }

  async removeFact(id: string, kb: string): Promise<boolean> {
    const res = await this.local.removeFact(id, kb);
    await this.mirror('removeFact', () => this.cloud.removeFact(id, kb));
    return res;
  }

  // --- reads: served from local (authoritative working copy) --------------

  recall(q: RecallQuery): Promise<Entry[]> {
    return this.local.recall(q);
  }
  search(q: SearchQuery): Promise<Entry[]> {
    return this.local.search(q);
  }
  list(q: ListQuery): Promise<ListResult> {
    return this.local.list(q);
  }
  stats(): Promise<Stats> {
    return this.local.stats();
  }
  namespaces(): Promise<Record<string, number>> {
    return this.local.namespaces();
  }
  history(key: string): Promise<Entry[]> {
    return this.local.history(key);
  }
  exportEntries(namespace?: string, tag?: string): Promise<Entry[]> {
    return this.local.exportEntries(namespace, tag);
  }
  recallFacts(q: FactQuery): Promise<Fact[]> {
    return this.local.recallFacts(q);
  }
  listFacts(q: ListFactsQuery): Promise<ListFactsResult> {
    return this.local.listFacts(q);
  }
}
