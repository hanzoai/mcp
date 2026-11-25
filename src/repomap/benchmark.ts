/**
 * Reproducible Matched-Baseline Benchmark for Symbol-Graph RepoMap
 * (HIP-1347 / hanzoai/mcp#36).
 *
 * Compares three context-selection strategies under an identical token budget,
 * identical corpus, and a strategy-blind localization & task-completion judge:
 *   1. naive_dump_100: lexicographic 100-file truncated workspace dump
 *   2. lexical_topk: BM25 lexical keyword top-k file & snippet selector
 *   3. symbol_graph_repomap: Personalized PageRank RepoMap over the symbol graph
 *
 * Also evaluates a disconnected flat-script negative control (0 cross-file edges)
 * to verify falsifiability: when no symbol graph edges exist, graph ranking adds
 * zero lift over lexical retrieval.
 */

import {
  AccessControlPolicy,
  BuildSymbolGraphOptions,
  RepoMapQueryContext,
  SourceBlobRecord,
  SymbolGraph,
  authorizeSourceBlobs,
  buildSymbolGraph,
  estimateRepoMapTokens,
  generateRepoMap,
  splitIdentifierSubtokens,
} from './repo-map.js';

export type BenchmarkStrategyId =
  | 'naive_dump_100'
  | 'lexical_topk'
  | 'symbol_graph_repomap';

export interface BenchmarkTaskCase {
  id: string;
  description: string;
  context: RepoMapQueryContext;
  /** Primary root-cause file where the first useful edit must land. */
  primaryEditFile: string;
  /** Primary root-cause symbol inside primaryEditFile. */
  primaryEditSymbol: string;
  /** Complete set of causal files that must be localized to finish the task. */
  requiredTargetFiles: string[];
}

export interface StrategyMapOutput {
  strategy: BenchmarkStrategyId;
  text: string;
  includedFiles: string[];
  estimatedTokens: number;
  latencyMs: number;
}

export interface TaskEvaluationOutcome {
  taskId: string;
  strategy: BenchmarkStrategyId;
  mapTokens: number;
  targetFileRecall: number;
  fullTargetSetSelected: boolean;
  tokensBeforeFirstUsefulEdit: number;
  navigationToolCalls: number;
  taskCompleted: boolean;
  latencyMs: number;
}

export interface StrategyAggregateMetrics {
  strategy: BenchmarkStrategyId;
  taskCount: number;
  tokenBudget: number;
  meanMapTokens: number;
  meanTargetFileRecall: number;
  fullTargetSelectionRate: number;
  meanTokensBeforeFirstUsefulEdit: number;
  meanNavigationToolCalls: number;
  taskCompletionRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** Estimated input prompt cost per 1,000 tasks at $3.00 / 1M input tokens. */
  estimatedCostPer1kTasksUsd: number;
}

export interface NegativeControlReport {
  taskCount: number;
  graphEdgeCount: number;
  lexicalRecall: number;
  repoMapRecall: number;
  recallLiftOverLexical: number;
  lexicalTaskCompletionRate: number;
  repoMapTaskCompletionRate: number;
}

export interface RepoMapBenchmarkOptions extends BuildSymbolGraphOptions {
  /** Shared token budget enforced identically on all three strategies. Default: 650. */
  maxTokens?: number;
  /** Maximum navigation tool calls allowed before an agent run is marked incomplete. Default: 4. */
  maxNavigationCalls?: number;
  /** Maximum cumulative context tokens before an agent run exceeds budget. Default: 2400. */
  maxCumulativeTokens?: number;
  /** Input token price per 1M tokens for cost reporting. Default: 3.0 ($3/1M). */
  inputPricePerMillionUsd?: number;
}

export interface RepoMapBenchmarkReport {
  tokenBudget: number;
  corpusFileCount: number;
  corpusEdgeCount: number;
  taskCount: number;
  strategies: Record<BenchmarkStrategyId, StrategyAggregateMetrics>;
  perTaskOutcomes: TaskEvaluationOutcome[];
  negativeControl: NegativeControlReport;
}

// ---------------------------------------------------------------------------
// Baseline 1: Naive 100-File Truncated Dump (Matched Token Budget)
// ---------------------------------------------------------------------------

export function runNaiveDump100Baseline(
  records: SourceBlobRecord[],
  maxTokens: number,
  accessControl?: AccessControlPolicy
): StrategyMapOutput {
  const start = performance.now();
  const auth = authorizeSourceBlobs(records, accessControl);
  const candidateFiles = auth.authorized.slice(0, 100);

  const sections: string[] = [];
  const includedFiles: string[] = [];

  for (const blob of candidateFiles) {
    const snippetLines = blob.content.split(/\r?\n/).slice(0, 14).join('\n');
    const block = `=== ${blob.filePath} ===\n${snippetLines}`;
    const nextText = sections.length > 0 ? `${sections.join('\n\n')}\n\n${block}` : block;

    if (estimateRepoMapTokens(nextText) <= maxTokens) {
      sections.push(block);
      includedFiles.push(blob.filePath);
    } else {
      const remainingChars = Math.max(0, maxTokens * 4 - sections.join('\n\n').length - 4);
      if (remainingChars > blob.filePath.length + 12) {
        sections.push(block.slice(0, remainingChars));
        includedFiles.push(blob.filePath);
      }
      break;
    }
  }

  const text = sections.join('\n\n');
  return {
    strategy: 'naive_dump_100',
    text,
    includedFiles,
    estimatedTokens: estimateRepoMapTokens(text),
    latencyMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Baseline 2: Lexical BM25 Keyword Top-K Selector (Matched Token Budget)
// ---------------------------------------------------------------------------

export function runLexicalTopKBaseline(
  records: SourceBlobRecord[],
  context: RepoMapQueryContext,
  maxTokens: number,
  accessControl?: AccessControlPolicy
): StrategyMapOutput {
  const start = performance.now();
  const auth = authorizeSourceBlobs(records, accessControl ?? context.accessControl);
  const docs = auth.authorized;

  if (docs.length === 0) {
    return {
      strategy: 'lexical_topk',
      text: '',
      includedFiles: [],
      estimatedTokens: 0,
      latencyMs: performance.now() - start,
    };
  }

  const rawQueryParts = [
    context.taskQuery ?? '',
    ...(context.mentionedSymbols ?? []),
    ...(context.activeFiles ?? []),
    ...(context.gitDiffPaths ?? []),
    context.diagnosticText ?? '',
    ...(context.errorSpans ?? []).map((s) => `${s.filePath} ${s.symbolName ?? ''} ${s.message ?? ''}`),
  ];
  const queryTerms = Array.from(new Set(splitIdentifierSubtokens(rawQueryParts.join(' '))));

  const docTermCounts: Array<Map<string, number>> = [];
  const docLengths: number[] = [];
  const docFreq = new Map<string, number>();
  let totalLen = 0;

  for (const blob of docs) {
    const tokens = splitIdentifierSubtokens(`${blob.filePath} ${blob.content}`);
    docLengths.push(tokens.length);
    totalLen += tokens.length;

    const counts = new Map<string, number>();
    for (const tok of tokens) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    docTermCounts.push(counts);
    for (const term of counts.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const avgDocLen = Math.max(1, totalLen / docs.length);
  const k1 = 1.5;
  const b = 0.75;

  const activeSet = new Set(context.activeFiles ?? []);

  const scoredDocs = docs.map((blob, idx) => {
    const counts = docTermCounts[idx];
    const dl = docLengths[idx];
    let score = activeSet.has(blob.filePath) ? 3.5 : 0;

    for (const qTerm of queryTerms) {
      const tf = counts.get(qTerm) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(qTerm) ?? 1;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDocLen)));
      score += idf * tfNorm;
    }

    return { blob, score };
  });

  scoredDocs.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.blob.filePath.localeCompare(b.blob.filePath)
  );

  const sections: string[] = [];
  const includedFiles: string[] = [];

  for (const { blob, score } of scoredDocs) {
    const lines = blob.content
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, 10);
    const block = `${blob.filePath} [bm25=${score.toFixed(2)}]\n${lines.map((l) => `  ${l}`).join('\n')}`;
    const candidate = sections.length > 0 ? `${sections.join('\n\n')}\n\n${block}` : block;
    if (estimateRepoMapTokens(candidate) <= maxTokens) {
      sections.push(block);
      includedFiles.push(blob.filePath);
    } else if (sections.length === 0) {
      const clipped = block.slice(0, Math.max(1, maxTokens * 4));
      sections.push(clipped);
      includedFiles.push(blob.filePath);
      break;
    }
  }

  const text = sections.join('\n\n');
  return {
    strategy: 'lexical_topk',
    text,
    includedFiles,
    estimatedTokens: estimateRepoMapTokens(text),
    latencyMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Strategy-Blind Agent Localization & Task Completion Judge
// ---------------------------------------------------------------------------

function evaluateMapOnTask(
  mapOutput: StrategyMapOutput,
  task: BenchmarkTaskCase,
  graph: SymbolGraph,
  lexicalFallbackOrder: string[],
  maxNavigationCalls: number,
  maxCumulativeTokens: number
): TaskEvaluationOutcome {
  const requiredSet = new Set(task.requiredTargetFiles);
  const includedSet = new Set(mapOutput.includedFiles);

  let directHits = 0;
  for (const req of requiredSet) {
    if (includedSet.has(req)) directHits++;
  }

  const targetFileRecall =
    requiredSet.size > 0 ? Number((directHits / requiredSet.size).toFixed(4)) : 1;
  const fullTargetSetSelected = directHits === requiredSet.size;

  // Reading a localized file reveals ONLY its forward outgoing imports/references
  // (never reverse callers across the monorepo, unless <- caller was rendered in mapOutput.text),
  // and the agent NEVER peeks at ground-truth requiredTargetFiles when choosing what to open next.
  const forwardImportsByFile = new Map<string, string[]>();
  for (const fp of graph.files.keys()) {
    forwardImportsByFile.set(fp, []);
  }
  for (const edge of graph.edges) {
    const fwd = forwardImportsByFile.get(edge.fromFile);
    if (fwd && !fwd.includes(edge.toFile)) {
      fwd.push(edge.toFile);
    }
  }

  // Extract any cross-file edge paths explicitly surfaced in mapOutput.text (e.g. -> or <- lines).
  const mapMentionedPaths: string[] = [];
  for (const fp of graph.files.keys()) {
    if (mapOutput.text.includes(fp) && !includedSet.has(fp)) {
      mapMentionedPaths.push(fp);
    }
  }

  const localized = new Set<string>(mapOutput.includedFiles);
  const localizedQueue: string[] = [...mapOutput.includedFiles];
  for (const af of task.context.activeFiles ?? []) {
    if (!localized.has(af)) {
      localized.add(af);
      localizedQueue.unshift(af);
    }
  }

  let navigationToolCalls = 0;
  let cumulativeTokens = mapOutput.estimatedTokens;
  let tokensBeforeFirstUsefulEdit: number | null = null;

  if (localized.has(task.primaryEditFile)) {
    const hasSignatureInMap = mapOutput.text.includes(task.primaryEditSymbol);
    const readCost = hasSignatureInMap ? 120 : 280;
    navigationToolCalls += 1;
    cumulativeTokens += readCost;
    tokensBeforeFirstUsefulEdit = cumulativeTokens;
  }

  let mapMentionCursor = 0;
  let lexicalCursor = 0;
  const allKnownFiles = Array.from(graph.files.keys()).sort((a, b) => a.localeCompare(b));
  let scanCursor = 0;

  while (navigationToolCalls < maxNavigationCalls) {
    const allDone =
      task.requiredTargetFiles.every((f) => localized.has(f)) &&
      tokensBeforeFirstUsefulEdit !== null;
    if (allDone) {
      break;
    }

    // Priority 1 (oracle-free): open a file explicitly linked via call-edge in mapOutput.text.
    let nextExplicitEdgeFile: string | undefined;
    while (mapMentionCursor < mapMentionedPaths.length) {
      const cand = mapMentionedPaths[mapMentionCursor++];
      if (!localized.has(cand)) {
        nextExplicitEdgeFile = cand;
        break;
      }
    }

    if (nextExplicitEdgeFile) {
      navigationToolCalls += 1;
      cumulativeTokens += 220;
      localized.add(nextExplicitEdgeFile);
      localizedQueue.push(nextExplicitEdgeFile);
    } else {
      // Priority 2 (oracle-free): follow next unvisited forward import from already-localized files in BFS order.
      let nextForwardImport: string | undefined;
      for (const loc of localizedQueue) {
        const outs = forwardImportsByFile.get(loc) ?? [];
        const unvisitedOut = outs.find((target) => !localized.has(target));
        if (unvisitedOut) {
          nextForwardImport = unvisitedOut;
          break;
        }
      }

      if (nextForwardImport) {
        navigationToolCalls += 1;
        cumulativeTokens += 260;
        localized.add(nextForwardImport);
        localizedQueue.push(nextForwardImport);
      } else {
        // Priority 3 (oracle-free): run exploratory lexical search + file read (2 tool calls).
        navigationToolCalls += 2;
        cumulativeTokens += 480;
        let candidate: string | undefined;
        while (lexicalCursor < lexicalFallbackOrder.length) {
          const cand = lexicalFallbackOrder[lexicalCursor++];
          if (!localized.has(cand)) {
            candidate = cand;
            break;
          }
        }
        if (!candidate) {
          while (scanCursor < allKnownFiles.length) {
            const cand = allKnownFiles[scanCursor++];
            if (!localized.has(cand)) {
              candidate = cand;
              break;
            }
          }
        }
        if (candidate) {
          localized.add(candidate);
          localizedQueue.push(candidate);
        }
      }
    }

    if (tokensBeforeFirstUsefulEdit === null && localized.has(task.primaryEditFile)) {
      tokensBeforeFirstUsefulEdit = cumulativeTokens;
    }
  }

  if (tokensBeforeFirstUsefulEdit === null) {
    tokensBeforeFirstUsefulEdit = cumulativeTokens + 520;
  }

  const allTargetsFound = task.requiredTargetFiles.every((f) => localized.has(f));
  const taskCompleted =
    allTargetsFound &&
    navigationToolCalls <= maxNavigationCalls &&
    cumulativeTokens <= maxCumulativeTokens;

  return {
    taskId: task.id,
    strategy: mapOutput.strategy,
    mapTokens: mapOutput.estimatedTokens,
    targetFileRecall,
    fullTargetSetSelected,
    tokensBeforeFirstUsefulEdit,
    navigationToolCalls,
    taskCompleted,
    latencyMs: mapOutput.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Default Reproducible 125-File Polyglot Monorepo Suite + Negative Control
// ---------------------------------------------------------------------------

export function buildDefaultRepoMapBenchmarkCorpus(): {
  corpus: SourceBlobRecord[];
  tasks: BenchmarkTaskCase[];
} {
  const corpus: SourceBlobRecord[] = [];

  // Ubiquitous utility logger imported by 60+ background files (tests hub damping).
  corpus.push({
    filePath: 'packages/common/src/logger.ts',
    content: [
      'export interface LogMeta { requestId?: string; component?: string; }',
      'export function logStructuredEvent(level: string, msg: string, meta?: LogMeta): void {',
      '  void level; void msg; void meta;',
      '}',
    ].join('\n'),
  });

  // 105 realistic UI, admin, analytics, CLI, and reporting modules containing surface
  // symptom terms ("merchant", "payout", "rounding", "batch", "epoch", "checkpoint",
  // "validator", "nightly", "statement", "reconciliation", "escrow", "unlock", "duplicate",
  // "tenant", "quota", "429") without participating in the core backend call chains.
  const symptomTemplates = [
    {
      slug: 'merchant-payout-report',
      lines: [
        'export interface MerchantPayoutReportRow { merchantId: string; roundingNote: string; smallBatch: boolean; }',
        'export function formatMerchantPayoutRoundingSummary(row: MerchantPayoutReportRow): string {',
        '  logStructuredEvent("info", "rendering merchant payout rounding discrepancy card");',
        '  return `${row.merchantId}: ${row.roundingNote} (smallBatch=${row.smallBatch})`;',
        '}',
      ],
    },
    {
      slug: 'gateway-receipt-admin',
      lines: [
        'export interface AdminReceiptFilter { currencyCode: string; batchStatus: string; }',
        'export function renderGatewayReceiptRefactorNotice(filter: AdminReceiptFilter): string {',
        '  logStructuredEvent("info", "gateway handler receipt signature preview");',
        '  return `${filter.currencyCode}:${filter.batchStatus}`;',
        '}',
      ],
    },
    {
      slug: 'epoch-checkpoint-monitor',
      lines: [
        'export interface EpochCheckpointAlert { epoch: number; validatorCount: number; }',
        'export function formatEpochCheckpointRejectedBanner(alert: EpochCheckpointAlert): string {',
        '  logStructuredEvent("warn", "epoch checkpoint proof rejected during settlement commit");',
        '  return `epoch=${alert.epoch} validators=${alert.validatorCount}`;',
        '}',
      ],
    },
    {
      slug: 'nightly-statement-dashboard',
      lines: [
        'export interface NightlyStatementCard { archivedRows: number; divisionWarning: string; }',
        'export function renderNightlyStatementReconciliationCard(card: NightlyStatementCard): string {',
        '  logStructuredEvent("info", "nightly statement reconciliation job zero rate alert");',
        '  return `${card.archivedRows}:${card.divisionWarning}`;',
        '}',
      ],
    },
    {
      slug: 'escrow-unlock-audit',
      lines: [
        'export interface EscrowUnlockAuditEntry { requestId: string; duplicateSubmission: boolean; }',
        'export function formatEscrowUnlockDuplicateNotice(entry: EscrowUnlockAuditEntry): string {',
        '  logStructuredEvent("info", "prevent duplicate unlock request submission");',
        '  return `${entry.requestId}:${entry.duplicateSubmission}`;',
        '}',
      ],
    },
    {
      slug: 'tenant-quota-banner',
      lines: [
        'export interface TenantQuotaStatus { tenantId: string; status429Count: number; }',
        'export function renderTenantBurstQuotaLockoutBanner(status: TenantQuotaStatus): string {',
        '  logStructuredEvent("warn", "tenant rate quota 429 lockout after host migration");',
        '  return `${status.tenantId}:${status.status429Count}`;',
        '}',
      ],
    },
  ];

  for (let i = 0; i < 105; i++) {
    const tpl = symptomTemplates[i % symptomTemplates.length];
    const pkgIdx = String(i + 1).padStart(3, '0');
    corpus.push({
      filePath: `apps/console-${pkgIdx}/src/${tpl.slug}-${pkgIdx}.ts`,
      content: [
        `import { logStructuredEvent } from '../../../packages/common/src/logger.js';`,
        `// Console view module ${pkgIdx} for operator telemetry and status cards`,
        ...tpl.lines.map((l) => l.replace(/\b(Row|Filter|Alert|Card|Entry|Status|Summary|Notice|Banner)\b/g, `$1_${pkgIdx}`)),
        `export const VIEW_VERSION_${pkgIdx} = 'v1.${i}.0';`,
        `export function describeViewMeta_${pkgIdx}(): string { return VIEW_VERSION_${pkgIdx}; }`,
      ].join('\n'),
    });
  }

  // --- Causal Cluster 1 & 2: TypeScript Gateway -> Ledger Barrel -> Transfer Engine -> Basis Schedule ---
  corpus.push({
    filePath: 'packages/fees/src/basis-schedule.ts',
    content: [
      'export interface BasisTier {',
      '  ceilingUnits: number;',
      '  bps: number;',
      '}',
      '',
      'export function computeTieredBasisPoints(notionalUnits: number, schedule: BasisTier[]): number {',
      '  const matched = schedule.find((tier) => notionalUnits <= tier.ceilingUnits);',
      '  const bps = matched ? matched.bps : 25;',
      '  return Math.trunc((notionalUnits * bps) / 10000);',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/ledger/src/types.ts',
    content: [
      'export interface SettlementReceipt {',
      '  transferId: string;',
      '  netUnits: number;',
      '  levyUnits: number;',
      '  committedIso: string;',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/ledger/src/transfer-engine.ts',
    content: [
      `import { computeTieredBasisPoints, BasisTier } from '../../fees/src/basis-schedule.js';`,
      `import { SettlementReceipt } from './types.js';`,
      `import { logStructuredEvent } from '../../common/src/logger.js';`,
      '',
      'const DEFAULT_TIERS: BasisTier[] = [{ ceilingUnits: 10000, bps: 30 }];',
      '',
      'export function executeLedgerTransfer(transferId: string, grossUnits: number): SettlementReceipt {',
      '  logStructuredEvent("info", transferId);',
      '  const levyUnits = computeTieredBasisPoints(grossUnits, DEFAULT_TIERS);',
      '  return {',
      '    transferId,',
      '    netUnits: grossUnits - levyUnits,',
      '    levyUnits,',
      '    committedIso: new Date(0).toISOString(),',
      '  };',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/ledger/src/index.ts',
    content: [
      `export { executeLedgerTransfer } from './transfer-engine.js';`,
      `export type { SettlementReceipt } from './types.js';`,
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/gateway/src/routes/payout.ts',
    content: [
      `import { executeLedgerTransfer, SettlementReceipt } from '../../../ledger/src/index.js';`,
      `import { logStructuredEvent } from '../../../common/src/logger.js';`,
      '',
      'export function handleMerchantPayoutRequest(merchantId: string, amountCents: number): SettlementReceipt {',
      '  logStructuredEvent("info", merchantId);',
      '  if (amountCents <= 0) {',
      '    throw new Error("amountCents must be positive");',
      '  }',
      '  return executeLedgerTransfer(`tx_${merchantId}`, amountCents);',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/webhooks/src/outbound-sender.ts',
    content: [
      `import { executeLedgerTransfer, SettlementReceipt } from '../../ledger/src/index.js';`,
      '',
      'export function replayDeadLetterTransfer(envelopeId: string, retryUnits: number): SettlementReceipt {',
      '  return executeLedgerTransfer(envelopeId, retryUnits);',
      '}',
    ].join('\n'),
  });

  // --- Causal Cluster 3: Rust Settlement Engine -> Merkle Verifier -> Leaf Codec ---
  corpus.push({
    filePath: 'crates/crypto/src/leaf_codec.rs',
    content: [
      'pub struct CanonicalLeafDigest {',
      '    pub bytes: [u8; 32],',
      '}',
      '',
      'pub fn encode_domain_separated_leaf(subject: &[u8], sequence: u64) -> CanonicalLeafDigest {',
      '    let mut bytes = [0u8; 32];',
      '    bytes[0] = (sequence & 0xff) as u8;',
      '    if !subject.is_empty() { bytes[1] = subject[0]; }',
      '    CanonicalLeafDigest { bytes }',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'crates/settlement/src/merkle_verifier.rs',
    content: [
      'use crypto::leaf_codec::{CanonicalLeafDigest, encode_domain_separated_leaf};',
      '',
      'pub fn verify_merkle_inclusion(subject: &[u8], sequence: u64, root: &[u8; 32]) -> bool {',
      '    let leaf: CanonicalLeafDigest = encode_domain_separated_leaf(subject, sequence);',
      '    &leaf.bytes == root',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'crates/settlement/src/engine.rs',
    content: [
      'use crate::merkle_verifier::verify_merkle_inclusion;',
      '',
      'pub fn commit_epoch_checkpoint(subject: &[u8], sequence: u64, root: &[u8; 32]) -> Result<(), String> {',
      '    if !verify_merkle_inclusion(subject, sequence, root) {',
      '        return Err(String::from("checkpoint inclusion proof rejected"));',
      '    }',
      '    Ok(())',
      '}',
    ].join('\n'),
  });

  // --- Causal Cluster 4: Python Reconciler Runner -> Differ -> Spot Curve ---
  corpus.push({
    filePath: 'services/reconciler/spot_curve.py',
    content: [
      'def invert_midmarket_factor(minor_units: int, mid_factor: float) -> int:',
      '    if mid_factor <= 0:',
      '        raise ValueError("mid_factor must be positive")',
      '    return round(minor_units / mid_factor)',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'services/reconciler/differ.py',
    content: [
      'from .spot_curve import invert_midmarket_factor',
      '',
      'def compute_row_variance(domestic_units: int, foreign_units: int, factor: float) -> int:',
      '    converted = invert_midmarket_factor(foreign_units, factor)',
      '    return domestic_units - converted',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'services/reconciler/runner.py',
    content: [
      'from .differ import compute_row_variance',
      '',
      'def run_nightly_statement_job(records: list) -> list:',
      '    out = []',
      '    for dom, fgn, fac in records:',
      '        out.append(compute_row_variance(dom, fgn, fac))',
      '    return out',
    ].join('\n'),
  });

  // --- Causal Cluster 5: Go Escrow Keeper -> Vault -> Multisig Bitmap ---
  corpus.push({
    filePath: 'internal/multisig/bitmap.go',
    content: [
      'package multisig',
      '',
      'type StakeTable map[string]uint64',
      '',
      'func AccumulateQuorumPower(stakes StakeTable,keys []string, threshold uint64) bool {',
      '    var acc uint64 = 0',
      '    for _, k := range keys {',
      '        acc += stakes[k]',
      '    }',
      '    return acc >= threshold',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'internal/escrow/vault_state.go',
    content: [
      'package escrow',
      '',
      'import "github.com/hanzoai/demo/internal/multisig"',
      '',
      'func ReleaseTimelockVault(stakes multisig.StakeTable, keys []string, floor uint64) bool {',
      '    return multisig.AccumulateQuorumPower(stakes, keys, floor)',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'internal/escrow/keeper.go',
    content: [
      'package escrow',
      '',
      'import "github.com/hanzoai/demo/internal/multisig"',
      '',
      'func ProcessUnlockMsg(stakes multisig.StakeTable, keys []string) bool {',
      '    return ReleaseTimelockVault(stakes, keys, 67)',
      '}',
    ].join('\n'),
  });

  // --- Causal Cluster 6: TypeScript Rate Guard -> Limiter Window -> Monotonic Clock ---
  corpus.push({
    filePath: 'packages/limiter/src/hrtime-skew.ts',
    content: [
      'export function alignMonotonicMillis(sampleMs: number, watermarkMs: number): number {',
      '  return sampleMs < watermarkMs ? watermarkMs : sampleMs;',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/limiter/src/bucket-window.ts',
    content: [
      `import { alignMonotonicMillis } from './hrtime-skew.js';`,
      '',
      'export class SlidingBurstWindow {',
      '  private watermarkMs = 0;',
      '  acquirePermit(sampleMs: number, ceiling: number): boolean {',
      '    const aligned = alignMonotonicMillis(sampleMs, this.watermarkMs);',
      '    this.watermarkMs = aligned;',
      '    return ceiling > 0;',
      '  }',
      '}',
    ].join('\n'),
  });

  corpus.push({
    filePath: 'packages/gateway/src/middleware/rate-guard.ts',
    content: [
      `import { SlidingBurstWindow } from '../../../limiter/src/bucket-window.js';`,
      `import { logStructuredEvent } from '../../../common/src/logger.js';`,
      '',
      'const sharedWindow = new SlidingBurstWindow();',
      '',
      'export function enforceTenantBurstQuota(tenantKey: string, timestampMs: number): boolean {',
      '  logStructuredEvent("debug", tenantKey);',
      '  return sharedWindow.acquirePermit(timestampMs, 50);',
      '}',
    ].join('\n'),
  });

  const tasks: BenchmarkTaskCase[] = [
    {
      id: 'ts-payout-subcent-truncation',
      description:
        'Merchant payout requests lose sub-cent precision on small batches due to integer truncation',
      context: {
        activeFiles: ['packages/gateway/src/routes/payout.ts'],
        taskQuery: 'fix merchant payout rounding discrepancy on small batches',
        diagnosticText:
          'AssertionError: expected netUnits 99.7 to equal 99.70 at packages/gateway/src/routes/payout.ts:9:10',
      },
      primaryEditFile: 'packages/fees/src/basis-schedule.ts',
      primaryEditSymbol: 'computeTieredBasisPoints',
      requiredTargetFiles: [
        'packages/gateway/src/routes/payout.ts',
        'packages/ledger/src/transfer-engine.ts',
        'packages/fees/src/basis-schedule.ts',
      ],
    },
    {
      id: 'ts-diff-receipt-caller-impact',
      description:
        'Propagate updated SettlementReceipt currency field from recent git diff to all callers',
      context: {
        taskQuery: 'update handlers after SettlementReceipt signature refactor',
        gitDiffText: [
          '--- a/packages/ledger/src/transfer-engine.ts',
          '+++ b/packages/ledger/src/transfer-engine.ts',
          '@@ -6,6 +6,6 @@',
        ].join('\n'),
        gitDiffPaths: ['packages/ledger/src/types.ts'],
      },
      primaryEditFile: 'packages/webhooks/src/outbound-sender.ts',
      primaryEditSymbol: 'replayDeadLetterTransfer',
      requiredTargetFiles: [
        'packages/ledger/src/types.ts',
        'packages/ledger/src/transfer-engine.ts',
        'packages/gateway/src/routes/payout.ts',
        'packages/webhooks/src/outbound-sender.ts',
      ],
    },
    {
      id: 'rust-checkpoint-domain-tag',
      description:
        'Fix epoch checkpoint rejection caused by single-byte slice in leaf digest encoding',
      context: {
        taskQuery: 'epoch checkpoint proof rejected during settlement commit',
        diagnosticText:
          'error: checkpoint verification failed\n  --> crates/settlement/src/engine.rs:4:9',
      },
      primaryEditFile: 'crates/crypto/src/leaf_codec.rs',
      primaryEditSymbol: 'encode_domain_separated_leaf',
      requiredTargetFiles: [
        'crates/settlement/src/engine.rs',
        'crates/settlement/src/merkle_verifier.rs',
        'crates/crypto/src/leaf_codec.rs',
      ],
    },
    {
      id: 'py-reconciler-zero-quote-crash',
      description:
        'Nightly statement reconciliation job crashes with division error on archived rows',
      context: {
        taskQuery: 'fix nightly statement reconciliation job division crash on archived rows',
        diagnosticText:
          'Traceback (most recent call last):\n  File "services/reconciler/runner.py", line 6, in run_nightly_statement_job',
      },
      primaryEditFile: 'services/reconciler/spot_curve.py',
      primaryEditSymbol: 'invert_midmarket_factor',
      requiredTargetFiles: [
        'services/reconciler/runner.py',
        'services/reconciler/differ.py',
        'services/reconciler/spot_curve.py',
      ],
    },
    {
      id: 'go-escrow-duplicate-signer-quorum',
      description:
        'Prevent duplicate unlock request submission from double-counting toward vault threshold',
      context: {
        activeFiles: ['internal/escrow/keeper.go'],
        taskQuery: 'prevent duplicate unlock request submission during escrow processing',
      },
      primaryEditFile: 'internal/multisig/bitmap.go',
      primaryEditSymbol: 'AccumulateQuorumPower',
      requiredTargetFiles: [
        'internal/escrow/keeper.go',
        'internal/escrow/vault_state.go',
        'internal/multisig/bitmap.go',
      ],
    },
    {
      id: 'ts-burst-limiter-ntp-rollback',
      description:
        'Tenant burst quota returns 429 lockout immediately after host live migration',
      context: {
        activeFiles: ['packages/gateway/src/middleware/rate-guard.ts'],
        mentionedSymbols: ['SlidingBurstWindow'],
        taskQuery: 'fix tenant rate quota 429 lockout after host migration',
      },
      primaryEditFile: 'packages/limiter/src/hrtime-skew.ts',
      primaryEditSymbol: 'alignMonotonicMillis',
      requiredTargetFiles: [
        'packages/gateway/src/middleware/rate-guard.ts',
        'packages/limiter/src/bucket-window.ts',
        'packages/limiter/src/hrtime-skew.ts',
      ],
    },
  ];

  return { corpus, tasks };
}

/**
 * Builds a 50-file disconnected flat-script corpus with ZERO cross-file imports
 * or symbol edges. Used as a falsifiable boundary / negative control.
 */
export function buildDisconnectedNegativeControlSuite(): {
  corpus: SourceBlobRecord[];
  tasks: BenchmarkTaskCase[];
} {
  const corpus: SourceBlobRecord[] = [];
  for (let i = 0; i < 50; i++) {
    const idx = String(i + 1).padStart(2, '0');
    corpus.push({
      filePath: `scripts/standalone_job_${idx}.py`,
      content: [
        `def execute_standalone_script_${idx}(payload_size: int) -> int:`,
        `    return payload_size * ${i + 2}`,
      ].join('\n'),
    });
  }

  const tasks: BenchmarkTaskCase[] = [
    {
      id: 'flat-script-17',
      description: 'Update multiplier in standalone_job_17',
      context: {
        taskQuery: 'fix multiplier inside execute_standalone_script_17',
      },
      primaryEditFile: 'scripts/standalone_job_17.py',
      primaryEditSymbol: 'execute_standalone_script_17',
      requiredTargetFiles: ['scripts/standalone_job_17.py'],
    },
    {
      id: 'flat-script-42',
      description: 'Update multiplier in standalone_job_42',
      context: {
        taskQuery: 'fix multiplier inside execute_standalone_script_42',
      },
      primaryEditFile: 'scripts/standalone_job_42.py',
      primaryEditSymbol: 'execute_standalone_script_42',
      requiredTargetFiles: ['scripts/standalone_job_42.py'],
    },
  ];

  return { corpus, tasks };
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

function aggregateOutcomes(
  strategy: BenchmarkStrategyId,
  outcomes: TaskEvaluationOutcome[],
  tokenBudget: number,
  inputPricePerMillionUsd: number
): StrategyAggregateMetrics {
  const n = Math.max(1, outcomes.length);
  const sum = (fn: (o: TaskEvaluationOutcome) => number) =>
    outcomes.reduce((acc, o) => acc + fn(o), 0);

  const meanMapTokens = Number((sum((o) => o.mapTokens) / n).toFixed(2));
  const meanTokensBeforeFirstUsefulEdit = Number(
    (sum((o) => o.tokensBeforeFirstUsefulEdit) / n).toFixed(2)
  );
  const latencies = outcomes.map((o) => o.latencyMs);

  const estimatedCostPer1kTasksUsd = Number(
    (((meanTokensBeforeFirstUsefulEdit * 1000) / 1_000_000) * inputPricePerMillionUsd).toFixed(4)
  );

  return {
    strategy,
    taskCount: outcomes.length,
    tokenBudget,
    meanMapTokens,
    meanTargetFileRecall: Number((sum((o) => o.targetFileRecall) / n).toFixed(4)),
    fullTargetSelectionRate: Number(
      (outcomes.filter((o) => o.fullTargetSetSelected).length / n).toFixed(4)
    ),
    meanTokensBeforeFirstUsefulEdit,
    meanNavigationToolCalls: Number((sum((o) => o.navigationToolCalls) / n).toFixed(2)),
    taskCompletionRate: Number(
      (outcomes.filter((o) => o.taskCompleted).length / n).toFixed(4)
    ),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    estimatedCostPer1kTasksUsd,
  };
}

export function evaluateRepoMapBenchmark(
  customSuite?: { corpus: SourceBlobRecord[]; tasks: BenchmarkTaskCase[] },
  options: RepoMapBenchmarkOptions = {}
): RepoMapBenchmarkReport {
  const maxTokens = options.maxTokens ?? 650;
  const maxNavigationCalls = options.maxNavigationCalls ?? 4;
  const maxCumulativeTokens = options.maxCumulativeTokens ?? 2400;
  const inputPricePerMillionUsd = options.inputPricePerMillionUsd ?? 3.0;

  const { corpus, tasks } = customSuite ?? buildDefaultRepoMapBenchmarkCorpus();
  const baseGraph = buildSymbolGraph(corpus, {
    accessControl: options.accessControl,
    adapters: options.adapters,
    enableHubDamping: options.enableHubDamping,
  });

  const perTaskOutcomes: TaskEvaluationOutcome[] = [];

  for (const task of tasks) {
    const effectiveAcl = task.context.accessControl ?? options.accessControl;

    const fullLexicalOrder = runLexicalTopKBaseline(
      corpus,
      task.context,
      100_000,
      effectiveAcl
    ).includedFiles;

    const naiveOut = runNaiveDump100Baseline(corpus, maxTokens, effectiveAcl);
    const lexicalOut = runLexicalTopKBaseline(corpus, task.context, maxTokens, effectiveAcl);

    const repoStart = performance.now();
    const repoRes = generateRepoMap(corpus, task.context, {
      accessControl: effectiveAcl,
      adapters: options.adapters,
      enableHubDamping: options.enableHubDamping,
      maxTokens,
      maxSymbolsPerFile: 4,
      maxEdgesPerSymbol: 2,
    });
    const repoOut: StrategyMapOutput = {
      strategy: 'symbol_graph_repomap',
      text: repoRes.text,
      includedFiles: repoRes.includedFiles,
      estimatedTokens: repoRes.metrics.estimatedTokens,
      latencyMs: performance.now() - repoStart,
    };

    for (const out of [naiveOut, lexicalOut, repoOut]) {
      perTaskOutcomes.push(
        evaluateMapOnTask(
          out,
          task,
          baseGraph,
          fullLexicalOrder,
          maxNavigationCalls,
          maxCumulativeTokens
        )
      );
    }
  }

  const byStrategy = (s: BenchmarkStrategyId) =>
    perTaskOutcomes.filter((o) => o.strategy === s);

  const negSuite = buildDisconnectedNegativeControlSuite();
  const negGraph = buildSymbolGraph(negSuite.corpus);
  const negLexOutcomes: TaskEvaluationOutcome[] = [];
  const negRepoOutcomes: TaskEvaluationOutcome[] = [];

  for (const nTask of negSuite.tasks) {
    const fallbackOrder = runLexicalTopKBaseline(
      negSuite.corpus,
      nTask.context,
      100_000
    ).includedFiles;
    const lex = runLexicalTopKBaseline(negSuite.corpus, nTask.context, maxTokens);
    const rmStart = performance.now();
    const rm = generateRepoMap(negSuite.corpus, nTask.context, { maxTokens });
    const rmOut: StrategyMapOutput = {
      strategy: 'symbol_graph_repomap',
      text: rm.text,
      includedFiles: rm.includedFiles,
      estimatedTokens: rm.metrics.estimatedTokens,
      latencyMs: performance.now() - rmStart,
    };
    negLexOutcomes.push(
      evaluateMapOnTask(lex, nTask, negGraph, fallbackOrder, maxNavigationCalls, maxCumulativeTokens)
    );
    negRepoOutcomes.push(
      evaluateMapOnTask(rmOut, nTask, negGraph, fallbackOrder, maxNavigationCalls, maxCumulativeTokens)
    );
  }

  const negLexAgg = aggregateOutcomes(
    'lexical_topk',
    negLexOutcomes,
    maxTokens,
    inputPricePerMillionUsd
  );
  const negRepoAgg = aggregateOutcomes(
    'symbol_graph_repomap',
    negRepoOutcomes,
    maxTokens,
    inputPricePerMillionUsd
  );

  return {
    tokenBudget: maxTokens,
    corpusFileCount: baseGraph.authorizedBlobs,
    corpusEdgeCount: baseGraph.edges.length,
    taskCount: tasks.length,
    strategies: {
      naive_dump_100: aggregateOutcomes(
        'naive_dump_100',
        byStrategy('naive_dump_100'),
        maxTokens,
        inputPricePerMillionUsd
      ),
      lexical_topk: aggregateOutcomes(
        'lexical_topk',
        byStrategy('lexical_topk'),
        maxTokens,
        inputPricePerMillionUsd
      ),
      symbol_graph_repomap: aggregateOutcomes(
        'symbol_graph_repomap',
        byStrategy('symbol_graph_repomap'),
        maxTokens,
        inputPricePerMillionUsd
      ),
    },
    perTaskOutcomes,
    negativeControl: {
      taskCount: negSuite.tasks.length,
      graphEdgeCount: negGraph.edges.length,
      lexicalRecall: negLexAgg.meanTargetFileRecall,
      repoMapRecall: negRepoAgg.meanTargetFileRecall,
      recallLiftOverLexical: Number(
        (negRepoAgg.meanTargetFileRecall - negLexAgg.meanTargetFileRecall).toFixed(4)
      ),
      lexicalTaskCompletionRate: negLexAgg.taskCompletionRate,
      repoMapTaskCompletionRate: negRepoAgg.taskCompletionRate,
    },
  };
}
