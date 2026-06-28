/**
 * Memory storage — one interface, swappable backends (HIP-0300).
 *
 * The memory TOOL is presentation + routing. Storage is decomplected behind
 * `MemoryBackend`: a value-level contract with orthogonal, composable
 * implementations — `LocalBackend` (on-disk ~/.hanzo, default, complete),
 * `CloudBackend` (api.hanzo.ai/v1 hanzo-memory service), `SyncBackend`
 * (local-first write-through). One operation → one method; no redundant paths.
 *
 * The on-disk record shapes are shared verbatim with the local store and the
 * Rust runtime (`~/.hanzo/memory.json`), so they stay structurally frozen.
 */

export interface Entry {
  id: string;
  key: string;
  value: string;
  tags: string[];
  namespace: string;
  created: string;
  updated: string;
  metadata?: Record<string, any>;
  ttl?: string;
}

export interface Fact {
  id: string;
  content: string;
  kb: string;
  tags: string[];
  created: string;
}

/** On-disk document shape (LocalBackend / Rust compatible). */
export interface Store {
  entries: Entry[];
  lastId: number;
  facts: Fact[];
  lastFactId: number;
}

// --- Inputs (mutations) ---------------------------------------------------

export interface StoreInput {
  key: string;
  value: string;
  namespace: string;
  tags?: string[];
  metadata?: Record<string, any>;
  ttl?: string;
  append?: boolean;
}

export interface UpdateInput {
  key: string;
  namespace: string;
  value?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  ttl?: string;
}

export interface RemoveQuery {
  namespace: string;
  key?: string;
  tag?: string;
}

export interface BulkOps {
  namespace: string;
  create?: Array<{ key: string; value: string; tags?: string[]; namespace?: string }>;
  update?: Array<{ key: string; value?: string; tags?: string[]; namespace?: string }>;
  delete?: string[];
}

export interface BulkResult {
  created: number;
  updated: number;
  deleted: number;
}

// --- Queries (reads) ------------------------------------------------------

export interface RecallQuery {
  namespace: string;
  /** When false, recall spans all namespaces (matches the legacy `!args.namespace` path). */
  scoped: boolean;
  key?: string;
  tag?: string;
  limit?: number;
}

export interface SearchQuery {
  query: string;
  namespace?: string;
  tag?: string;
  limit?: number;
}

export interface ListQuery {
  namespace?: string;
  tag?: string;
  sort?: 'key' | 'created' | 'updated' | 'namespace';
  limit?: number;
}

export interface ListResult {
  entries: Entry[];
  total: number;
  namespaces: string[];
}

export interface Stats {
  entries: number;
  facts: number;
  sizeBytes: number;
  namespaces: string[];
  tags: string[];
  byNamespace: Record<string, number>;
}

// --- Facts ----------------------------------------------------------------

export interface AddFactInput {
  content: string;
  kb: string;
  tags?: string[];
}

export interface FactQuery {
  kb: string;
  query?: string;
  tag?: string;
  limit?: number;
}

export interface ListFactsQuery {
  kb?: string;
  tag?: string;
  limit?: number;
}

export interface ListFactsResult {
  facts: Fact[];
  total: number;
  kbs: string[];
}

export interface Availability {
  ok: boolean;
  detail: string;
}

/**
 * Raised when a backend cannot honor an operation in its storage model
 * (e.g. whole-store introspection against a semantic cloud service).
 * Never swallowed — surfaced to the caller with the one-way remedy.
 */
export class BackendUnsupported extends Error {
  constructor(op: string, kind: string) {
    super(
      `'${op}' is not supported by the '${kind}' memory backend. ` +
        `Use HANZO_MEMORY_BACKEND=local (default) or =sync for whole-store operations.`,
    );
    this.name = 'BackendUnsupported';
  }
}

/**
 * The single storage contract. Every memory operation is exactly one method.
 * Implementations: LocalBackend, CloudBackend, SyncBackend.
 */
export interface MemoryBackend {
  readonly kind: 'local' | 'cloud' | 'sync';

  /** Liveness + reachability (cloud: token present and /health ok). */
  available(): Promise<Availability>;

  // Entries — single ops (the hot path a cloud service optimizes server-side)
  store(input: StoreInput): Promise<{ entry: Entry; created: boolean }>;
  update(input: UpdateInput): Promise<Entry | null>;
  recall(q: RecallQuery): Promise<Entry[]>;
  search(q: SearchQuery): Promise<Entry[]>;
  list(q: ListQuery): Promise<ListResult>;
  remove(q: RemoveQuery): Promise<number>;
  clear(namespace?: string): Promise<number>;
  bulk(ops: BulkOps): Promise<BulkResult>;

  // Entries — whole-store ops (LocalBackend complete; CloudBackend may refuse)
  stats(): Promise<Stats>;
  namespaces(): Promise<Record<string, number>>;
  history(key: string): Promise<Entry[]>;
  exportEntries(namespace?: string, tag?: string): Promise<Entry[]>;
  importEntries(entries: Partial<Entry>[], namespace: string, tags?: string[]): Promise<number>;
  merge(key: string): Promise<{ merged: number }>;
  setTag(key: string, namespace: string, tag: string, on: boolean): Promise<Entry | null>;

  // Facts (knowledge base)
  addFact(input: AddFactInput): Promise<Fact>;
  recallFacts(q: FactQuery): Promise<Fact[]>;
  listFacts(q: ListFactsQuery): Promise<ListFactsResult>;
  removeFact(id: string, kb: string): Promise<boolean>;
}
