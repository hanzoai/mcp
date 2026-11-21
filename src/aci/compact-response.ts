/**
 * SWE-agent ACI Compact Interface (HIP-1347 / Bounty #38).
 *
 * Clean-room TypeScript implementation of Agent-Computer Interface (ACI)
 * primitives inspired by SWE-agent (NeurIPS '24):
 *   1. Line-numbered file windowing & in-context search/scroll navigation
 *   2. Hunk-validated edits with stale-hash, ambiguity, and syntax-balance checks
 *      plus inline post-edit window summaries (eliminating follow-up read calls)
 *   3. Structure-preserving head/tail + diagnostic build-output compression
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface CompressionMetrics {
  originalLines: number;
  renderedLines: number;
  originalChars: number;
  renderedChars: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  tokensSaved: number;
  savingsRatio: number;
}

export interface FileWindowOptions {
  filePath?: string;
  hash?: string;
  /** 1-based start line of the window. Ignored if centerLine is provided. */
  startLine?: number;
  /** 1-based line to center the window around. */
  centerLine?: number;
  /** Maximum lines to show in one window (default: 100). */
  windowSize?: number;
  /** Truncate single lines exceeding this length (default: 240). */
  maxLineLength?: number;
  /** Separator between line number and content (default: '│'). */
  separator?: string;
  /** 1-based line numbers to highlight with '>' marker. */
  highlightLines?: number[];
}

export interface FileWindowState {
  filePath: string;
  startLine: number;
  windowSize: number;
  totalLines: number;
}

export interface FileWindowResult {
  filePath: string;
  hash: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  windowSize: number;
  linesAbove: number;
  linesBelow: number;
  rendered: string;
  state: FileWindowState;
  metrics: CompressionMetrics;
}

export type WindowNavigationCommand =
  | { type: 'goto'; line: number }
  | { type: 'scroll_down'; overlap?: number }
  | { type: 'scroll_up'; overlap?: number }
  | { type: 'search_open'; pattern: string | RegExp; occurrence?: number };

export interface EditHunk {
  oldText: string;
  newText: string;
  /** Optional 1-based inclusive bounds anchoring where oldText should appear. */
  expectedStartLine?: number;
  expectedEndLine?: number;
}

export interface EditValidationOptions {
  filePath?: string;
  /** Optimistic concurrency precondition (`sha256:<hex>`). */
  baseHash?: string;
  language?: 'ts' | 'js' | 'json' | 'rust' | 'python' | 'go' | 'auto';
  /** Run structural bracket/string/JSON validation after applying hunks (default: true). */
  lintCheck?: boolean;
  /** Reject atomically if edit introduces new syntax balance errors (default: true). */
  lintStrict?: boolean;
  /** Context lines to include around each edited region in summary window (default: 5). */
  contextLines?: number;
}

export type EditErrorCode =
  | 'STALE_HASH'
  | 'INVALID_HUNKS'
  | 'HUNK_NOT_FOUND'
  | 'AMBIGUOUS_HUNK'
  | 'LINE_ANCHOR_MISMATCH'
  | 'OVERLAPPING_HUNKS'
  | 'LINT_ERROR';

export interface EditHunkDiagnostic {
  hunkIndex: number;
  code: EditErrorCode;
  message: string;
  matchingLines?: number[];
  closestLine?: number;
  closestSnippet?: string;
}

export interface SyntaxDiagnostic {
  line: number;
  message: string;
}

export interface ValidatedEditResult {
  applied: boolean;
  filePath: string;
  previousHash: string;
  newHash: string;
  content: string;
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
  editedRanges: Array<{ startLine: number; endLine: number }>;
  summaryText: string;
  errors: EditHunkDiagnostic[];
  lintDiagnostics: SyntaxDiagnostic[];
  metrics: CompressionMetrics;
}

export interface BuildOutputCompressionOptions {
  headLines?: number;
  tailLines?: number;
  diagnosticContextLines?: number;
  maxOutputLines?: number;
  maxChars?: number;
  collapsePassingTests?: boolean;
}

export type BuildFailureCategory =
  | 'clean'
  | 'resources'
  | 'network'
  | 'timeout'
  | 'permission'
  | 'dependency'
  | 'compile'
  | 'test'
  | 'crash'
  | 'unknown';

export interface BuildOutputCompressionResult {
  compressedText: string;
  category: BuildFailureCategory;
  extractedFileSpans: string[];
  preservedDiagnostics: string[];
  omittedLines: number;
  collapsedRuns: number;
  metrics: CompressionMetrics;
}

export function computeContentHash(content: string | Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

export function estimateTokens(chars: number): number {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function buildMetrics(
  originalText: string,
  renderedText: string,
  originalLinesCount?: number,
  renderedLinesCount?: number
): CompressionMetrics {
  const originalLines = originalLinesCount ?? splitLines(originalText).length;
  const renderedLines = renderedLinesCount ?? splitLines(renderedText).length;
  const originalChars = originalText.length;
  const renderedChars = renderedText.length;
  const estimatedTokensBefore = estimateTokens(originalChars);
  const estimatedTokensAfter = estimateTokens(renderedChars);
  const tokensSaved = Math.max(0, estimatedTokensBefore - estimatedTokensAfter);
  const savingsRatio =
    originalChars > 0
      ? Number((Math.max(0, originalChars - renderedChars) / originalChars).toFixed(4))
      : 0;

  return {
    originalLines,
    renderedLines,
    originalChars,
    renderedChars,
    estimatedTokensBefore,
    estimatedTokensAfter,
    tokensSaved,
    savingsRatio,
  };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function formatLineNumber(lineNum: number, width: number, highlighted: boolean, sep: string): string {
  const prefix = highlighted ? '>' : ' ';
  return `${prefix}${String(lineNum).padStart(width)}${sep}`;
}

/**
 * Render a line-numbered SWE-agent ACI window over a file's contents.
 */
export function renderFileWindow(
  content: string,
  options: FileWindowOptions = {}
): FileWindowResult {
  const filePath = options.filePath ?? '<buffer>';
  const hash = options.hash ?? computeContentHash(content);
  const windowSize = Math.max(1, Math.floor(options.windowSize ?? 100));
  const maxLineLength = Math.max(40, Math.floor(options.maxLineLength ?? 240));
  const sep = options.separator ?? '│';
  const highlights = new Set(options.highlightLines ?? []);

  const lines = splitLines(content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    const emptyRendered = `[File: ${filePath} (0 lines total) | ${hash}]\n(empty file)`;
    return {
      filePath,
      hash,
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      windowSize,
      linesAbove: 0,
      linesBelow: 0,
      rendered: emptyRendered,
      state: { filePath, startLine: 1, windowSize, totalLines: 0 },
      metrics: buildMetrics(content, emptyRendered, 0, 2),
    };
  }

  let startLine: number;
  if (typeof options.centerLine === 'number') {
    const clampedCenter = Math.max(1, Math.min(totalLines, Math.floor(options.centerLine)));
    const half = Math.floor(windowSize / 2);
    startLine = Math.max(1, Math.min(Math.max(1, totalLines - windowSize + 1), clampedCenter - half));
  } else {
    const requestedStart = Math.floor(options.startLine ?? 1);
    startLine = Math.max(1, Math.min(totalLines, requestedStart));
  }

  const endLine = Math.min(totalLines, startLine + windowSize - 1);
  const linesAbove = startLine - 1;
  const linesBelow = totalLines - endLine;
  const numWidth = Math.max(4, String(endLine).length);

  const out: string[] = [
    `[File: ${filePath} (${totalLines} lines total) | ${hash} | Window: lines ${startLine}-${endLine}]`,
    linesAbove > 0 ? `(${linesAbove} more lines above)` : '(at top of file)',
  ];

  for (let ln = startLine; ln <= endLine; ln++) {
    let text = lines[ln - 1];
    if (text.length > maxLineLength) {
      const extra = text.length - maxLineLength;
      text = `${text.slice(0, maxLineLength)}... (+${extra} chars)`;
    }
    out.push(`${formatLineNumber(ln, numWidth, highlights.has(ln), sep)}${text}`);
  }

  out.push(linesBelow > 0 ? `(${linesBelow} more lines below)` : '(at end of file)');

  const rendered = out.join('\n');
  return {
    filePath,
    hash,
    totalLines,
    startLine,
    endLine,
    windowSize,
    linesAbove,
    linesBelow,
    rendered,
    state: { filePath, startLine, windowSize, totalLines },
    metrics: buildMetrics(content, rendered, totalLines, out.length),
  };
}

/**
 * Navigate an open file window via goto, scroll_down, scroll_up, or search_open.
 */
export function navigateFileWindow(
  content: string,
  state: FileWindowState,
  command: WindowNavigationCommand
): FileWindowResult {
  const lines = splitLines(content);
  const totalLines = lines.length;
  const overlap =
    command.type === 'scroll_down' || command.type === 'scroll_up'
      ? Math.max(0, Math.min(Math.floor(state.windowSize / 2), command.overlap ?? 10))
      : 0;

  if (command.type === 'goto') {
    return renderFileWindow(content, {
      filePath: state.filePath,
      centerLine: command.line,
      windowSize: state.windowSize,
    });
  }

  if (command.type === 'scroll_down') {
    const nextStart = Math.min(
      Math.max(1, totalLines - state.windowSize + 1),
      state.startLine + Math.max(1, state.windowSize - overlap)
    );
    return renderFileWindow(content, {
      filePath: state.filePath,
      startLine: nextStart,
      windowSize: state.windowSize,
    });
  }

  if (command.type === 'scroll_up') {
    const nextStart = Math.max(1, state.startLine - Math.max(1, state.windowSize - overlap));
    return renderFileWindow(content, {
      filePath: state.filePath,
      startLine: nextStart,
      windowSize: state.windowSize,
    });
  }

  // search_open: find matching line(s) and center window around requested occurrence in one call
  const rx =
    command.pattern instanceof RegExp
      ? new RegExp(command.pattern.source, command.pattern.flags.replace('g', ''))
      : new RegExp(command.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const matchingLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (rx.test(lines[i])) matchingLines.push(i + 1);
  }

  if (matchingLines.length === 0) {
    const fallback = renderFileWindow(content, {
      filePath: state.filePath,
      startLine: state.startLine,
      windowSize: state.windowSize,
    });
    return {
      ...fallback,
      rendered: `[No matches for ${String(command.pattern)} in ${state.filePath}]\n${fallback.rendered}`,
    };
  }

  const occIdx = Math.max(
    0,
    Math.min(matchingLines.length - 1, (command.occurrence ?? 1) - 1)
  );
  return renderFileWindow(content, {
    filePath: state.filePath,
    centerLine: matchingLines[occIdx],
    windowSize: state.windowSize,
    highlightLines: matchingLines,
  });
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findClosestSnippet(
  content: string,
  targetOldText: string
): { line: number; snippet: string } | null {
  const fileLines = splitLines(content);
  const needleLines = splitLines(targetOldText).map((l) => l.trim()).filter(Boolean);
  if (fileLines.length === 0 || needleLines.length === 0) return null;

  const firstNeedle = needleLines[0];
  let bestLine = 1;
  let bestScore = -1;

  for (let i = 0; i < fileLines.length; i++) {
    const trimmed = fileLines[i].trim();
    if (!trimmed) continue;
    let score = 0;
    if (trimmed === firstNeedle) score += 10;
    else if (trimmed.includes(firstNeedle) || firstNeedle.includes(trimmed)) score += 6;
    else {
      const words = firstNeedle.split(/\s+/).filter((w) => w.length > 2);
      for (const w of words) {
        if (trimmed.includes(w)) score += 1;
      }
    }
    // Check subsequent lines for multi-line match strength
    for (let k = 1; k < Math.min(needleLines.length, fileLines.length - i); k++) {
      if (fileLines[i + k].trim() === needleLines[k]) score += 4;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i + 1;
    }
  }

  if (bestScore <= 0) return null;
  const snippet = fileLines
    .slice(Math.max(0, bestLine - 1), Math.min(fileLines.length, bestLine + 2))
    .map((l, idx) => `${bestLine + idx}|${l}`)
    .join('\n');
  return { line: bestLine, snippet };
}

function detectLanguage(
  filePath: string,
  explicit?: EditValidationOptions['language']
): 'ts' | 'js' | 'json' | 'rust' | 'python' | 'go' | 'generic' {
  if (explicit && explicit !== 'auto') return explicit;
  const ext = path.posix.extname(filePath.toLowerCase());
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.json') return 'json';
  if (ext === '.rs') return 'rust';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  return 'generic';
}

/**
 * Lightweight deterministic syntax & delimiter balance checker.
 * Compares pre-edit vs post-edit diagnostics so preexisting quirks don't block valid fixes.
 */
export function checkSyntaxBalance(
  content: string,
  language: 'ts' | 'js' | 'json' | 'rust' | 'python' | 'go' | 'generic'
): SyntaxDiagnostic[] {
  const diagnostics: SyntaxDiagnostic[] = [];
  if (language === 'json') {
    try {
      JSON.parse(content);
    } catch (err: any) {
      diagnostics.push({ line: 1, message: `Invalid JSON: ${err.message}` });
    }
    return diagnostics;
  }

  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  let line = 1;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const supportsSlashComments = language !== 'python';

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1] ?? '';

    if (ch === '\n') {
      line++;
      inLineComment = false;
      inSingle = false;
      inDouble = false;
      continue;
    }

    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingle || inDouble || inBacktick) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (inSingle && ch === "'") inSingle = false;
      else if (inDouble && ch === '"') inDouble = false;
      else if (inBacktick && ch === '`') inBacktick = false;
      continue;
    }

    if (language === 'python' && ch === '#') {
      inLineComment = true;
      continue;
    }
    if (supportsSlashComments && ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (supportsSlashComments && ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'" && language !== 'rust') {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`' && (language === 'ts' || language === 'js' || language === 'go')) {
      inBacktick = true;
      continue;
    }

    if (pairs[ch]) {
      stack.push({ char: ch, line });
    } else if (closing[ch]) {
      const top = stack.pop();
      if (!top) {
        diagnostics.push({ line, message: `Unmatched closing '${ch}'` });
      } else if (pairs[top.char] !== ch) {
        diagnostics.push({
          line,
          message: `Mismatched '${ch}' (expected '${pairs[top.char]}' for opener at line ${top.line})`,
        });
      }
    }
  }

  if (inBacktick) {
    diagnostics.push({ line, message: 'Unclosed template literal (`)' });
  }
  if (inBlockComment) {
    diagnostics.push({ line, message: 'Unclosed block comment (/*)' });
  }
  for (const unclosed of stack) {
    diagnostics.push({
      line: unclosed.line,
      message: `Unclosed '${unclosed.char}' opened at line ${unclosed.line}`,
    });
  }

  return diagnostics;
}

/**
 * Validate and atomically apply one or more exact hunks, returning either
 * structured recovery diagnostics or a compact post-edit numbered window summary.
 */
export function validateAndApplyHunks(
  originalContent: string,
  hunks: EditHunk[],
  options: EditValidationOptions = {}
): ValidatedEditResult {
  const filePath = options.filePath ?? '<buffer>';
  const previousHash = computeContentHash(originalContent);
  const contextLines = Math.max(1, Math.floor(options.contextLines ?? 5));
  const lintCheck = options.lintCheck !== false;
  const lintStrict = options.lintStrict !== false;
  const errors: EditHunkDiagnostic[] = [];

  const failResult = (
    errs: EditHunkDiagnostic[],
    lintDiagnostics: SyntaxDiagnostic[] = []
  ): ValidatedEditResult => {
    const summaryText = [
      `[Edit REJECTED: ${filePath} | ${errs.length} validation error(s)]`,
      ...errs.map((e) => {
        const extra = e.closestSnippet
          ? `\n  Closest match near line ${e.closestLine}:\n${e.closestSnippet}`
          : '';
        return `- Hunk #${e.hunkIndex} (${e.code}): ${e.message}${extra}`;
      }),
    ].join('\n');
    return {
      applied: false,
      filePath,
      previousHash,
      newHash: previousHash,
      content: originalContent,
      hunksApplied: 0,
      linesAdded: 0,
      linesRemoved: 0,
      editedRanges: [],
      summaryText,
      errors: errs,
      lintDiagnostics,
      metrics: buildMetrics(originalContent, summaryText),
    };
  };

  if (options.baseHash && options.baseHash !== previousHash) {
    return failResult([
      {
        hunkIndex: 0,
        code: 'STALE_HASH',
        message: `base_hash mismatch: expected ${options.baseHash}, actual ${previousHash}`,
      },
    ]);
  }

  if (!Array.isArray(hunks) || hunks.length === 0) {
    return failResult([
      {
        hunkIndex: 0,
        code: 'INVALID_HUNKS',
        message: 'At least one edit hunk is required',
      },
    ]);
  }

  interface LocatedHunk {
    hunkIndex: number;
    startOffset: number;
    endOffset: number;
    newText: string;
    oldLineCount: number;
    newLineCount: number;
  }

  const located: LocatedHunk[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (!h || typeof h.oldText !== 'string' || typeof h.newText !== 'string' || h.oldText.length === 0) {
      errors.push({
        hunkIndex: i,
        code: 'INVALID_HUNKS',
        message: 'Each hunk must specify a non-empty oldText string and newText string',
      });
      continue;
    }

    const positions: number[] = [];
    let searchFrom = 0;
    while (searchFrom <= originalContent.length) {
      const idx = originalContent.indexOf(h.oldText, searchFrom);
      if (idx === -1) break;
      positions.push(idx);
      searchFrom = idx + Math.max(1, h.oldText.length);
    }

    if (positions.length === 0) {
      const closest = findClosestSnippet(originalContent, h.oldText);
      errors.push({
        hunkIndex: i,
        code: 'HUNK_NOT_FOUND',
        message: 'oldText did not match any region in the file',
        ...(closest ? { closestLine: closest.line, closestSnippet: closest.snippet } : {}),
      });
      continue;
    }

    let chosenOffset = positions[0];
    const matchingLines = positions.map((p) => lineNumberAtOffset(originalContent, p));

    if (positions.length > 1) {
      if (typeof h.expectedStartLine === 'number') {
        const anchored = positions.filter((p) => {
          const ln = lineNumberAtOffset(originalContent, p);
          const endBound = h.expectedEndLine ?? h.expectedStartLine! + splitLines(h.oldText).length + 2;
          return ln >= h.expectedStartLine! - 2 && ln <= endBound;
        });
        if (anchored.length === 1) {
          chosenOffset = anchored[0];
        } else {
          errors.push({
            hunkIndex: i,
            code: 'AMBIGUOUS_HUNK',
            message: `oldText matched ${positions.length} locations (lines ${matchingLines.join(', ')}) and anchor did not uniquely disambiguate`,
            matchingLines,
          });
          continue;
        }
      } else {
        errors.push({
          hunkIndex: i,
          code: 'AMBIGUOUS_HUNK',
          message: `oldText matched ${positions.length} locations (lines ${matchingLines.join(', ')}); provide more context or expectedStartLine`,
          matchingLines,
        });
        continue;
      }
    } else if (typeof h.expectedStartLine === 'number') {
      const actualLine = matchingLines[0];
      const endBound = h.expectedEndLine ?? h.expectedStartLine;
      if (actualLine < h.expectedStartLine - 5 || actualLine > endBound + 5) {
        errors.push({
          hunkIndex: i,
          code: 'LINE_ANCHOR_MISMATCH',
          message: `Unique match is at line ${actualLine}, outside anchored lines ${h.expectedStartLine}-${endBound}`,
          matchingLines,
        });
        continue;
      }
    }

    located.push({
      hunkIndex: i,
      startOffset: chosenOffset,
      endOffset: chosenOffset + h.oldText.length,
      newText: h.newText,
      oldLineCount: splitLines(h.oldText).length || 1,
      newLineCount: splitLines(h.newText).length || (h.newText === '' ? 0 : 1),
    });
  }

  if (errors.length > 0) {
    return failResult(errors);
  }

  // Sort by offset and verify non-overlap
  located.sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 1; i < located.length; i++) {
    if (located[i].startOffset < located[i - 1].endOffset) {
      return failResult([
        {
          hunkIndex: located[i].hunkIndex,
          code: 'OVERLAPPING_HUNKS',
          message: `Hunk #${located[i].hunkIndex} overlaps with hunk #${located[i - 1].hunkIndex}`,
        },
      ]);
    }
  }

  // Reconstruct updated content in ascending order and track updated line ranges
  let updated = '';
  let cursor = 0;
  let lineDelta = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const editedRanges: Array<{ startLine: number; endLine: number }> = [];

  for (const loc of located) {
    updated += originalContent.slice(cursor, loc.startOffset);
    const startLineInNew = lineNumberAtOffset(originalContent, loc.startOffset) + lineDelta;
    updated += loc.newText;
    cursor = loc.endOffset;

    const endLineInNew = Math.max(startLineInNew, startLineInNew + Math.max(1, loc.newLineCount) - 1);
    editedRanges.push({ startLine: startLineInNew, endLine: endLineInNew });

    lineDelta += loc.newLineCount - loc.oldLineCount;
    linesRemoved += loc.oldLineCount;
    linesAdded += loc.newLineCount;
  }
  updated += originalContent.slice(cursor);

  const lang = detectLanguage(filePath, options.language);
  let lintDiagnostics: SyntaxDiagnostic[] = [];
  if (lintCheck) {
    const beforeDiags = checkSyntaxBalance(originalContent, lang);
    const afterDiags = checkSyntaxBalance(updated, lang);
    // Report only newly introduced syntax errors (or any JSON error)
    const beforeSet = new Set(beforeDiags.map((d) => d.message));
    lintDiagnostics = afterDiags.filter((d) => !beforeSet.has(d.message) || lang === 'json');
    if (lintStrict && lintDiagnostics.length > 0) {
      return failResult(
        lintDiagnostics.map((d) => ({
          hunkIndex: 0,
          code: 'LINT_ERROR' as EditErrorCode,
          message: `Line ${d.line}: ${d.message}`,
        })),
        lintDiagnostics
      );
    }
  }

  const newHash = computeContentHash(updated);
  const newLines = splitLines(updated);
  const totalNewLines = newLines.length;

  // Build merged post-edit numbered windows around each edited range
  const windows: Array<{ start: number; end: number }> = [];
  for (const r of editedRanges) {
    const wStart = Math.max(1, r.startLine - contextLines);
    const wEnd = Math.min(totalNewLines, r.endLine + contextLines);
    const prev = windows[windows.length - 1];
    if (prev && wStart <= prev.end + 1) {
      prev.end = Math.max(prev.end, wEnd);
    } else {
      windows.push({ start: wStart, end: wEnd });
    }
  }

  const editedLineSet = new Set<number>();
  for (const r of editedRanges) {
    for (let ln = r.startLine; ln <= r.endLine; ln++) editedLineSet.add(ln);
  }

  const numWidth = Math.max(4, String(totalNewLines).length);
  const summaryParts: string[] = [
    `[Edit applied: ${filePath} | ${located.length} hunk(s) | +${linesAdded}/-${linesRemoved} lines | ${previousHash} -> ${newHash}]`,
  ];

  for (const w of windows) {
    if (w.start > 1) summaryParts.push(`... (lines 1-${w.start - 1} omitted) ...`);
    for (let ln = w.start; ln <= w.end; ln++) {
      const marker = editedLineSet.has(ln) ? '*' : ' ';
      summaryParts.push(`${marker}${String(ln).padStart(numWidth)}│${newLines[ln - 1] ?? ''}`);
    }
    if (w.end < totalNewLines) {
      summaryParts.push(`... (lines ${w.end + 1}-${totalNewLines} omitted) ...`);
    }
  }

  if (lintDiagnostics.length > 0) {
    summaryParts.push(
      `[Lint warnings: ${lintDiagnostics.map((d) => `line ${d.line}: ${d.message}`).join('; ')}]`
    );
  }

  const summaryText = summaryParts.join('\n');

  return {
    applied: true,
    filePath,
    previousHash,
    newHash,
    content: updated,
    hunksApplied: located.length,
    linesAdded,
    linesRemoved,
    editedRanges,
    summaryText,
    errors: [],
    lintDiagnostics,
    metrics: buildMetrics(updated, summaryText),
  };
}

/**
 * Read a file from disk, validate & apply hunks atomically, and persist only on success.
 */
export async function applyValidatedFileEdit(
  filePath: string,
  hunks: EditHunk[],
  options: EditValidationOptions = {}
): Promise<ValidatedEditResult> {
  const original = await fs.readFile(filePath, 'utf8');
  const res = validateAndApplyHunks(original, hunks, { ...options, filePath });
  if (res.applied) {
    await fs.writeFile(filePath, res.content, 'utf8');
  }
  return res;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const FILE_SPAN_RE =
  /(?:[\w./-]+\/)?[\w.-]+\.(?:rs|ts|tsx|js|jsx|mjs|py|go|c|cc|cpp|h|hpp|java|kt|rb|swift|cs|json|yaml|toml):\d+(?::\d+)?/g;

const FAILURE_RULES: Array<[BuildFailureCategory, RegExp]> = [
  [
    'resources',
    /\bout of memory\b|\bOOM\b|OutOfMemoryError|heap out of memory|Cannot allocate memory|\bKilled\b|exit code 137|No space left on device|\bENOSPC\b/i,
  ],
  [
    'network',
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|Could not resolve host|Connection (?:reset|refused|timed out)|429 Too Many Requests|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  ],
  ['timeout', /\btimed? ?out\b|deadline exceeded|exceeded the maximum execution time/i],
  ['permission', /permission denied|\bEACCES\b|\bEPERM\b|\b40[13]\b|Unauthorized|Forbidden/i],
  [
    'dependency',
    /ModuleNotFoundError|No module named|Cannot find module|Module not found|\bERESOLVE\b|npm ERR! code E404|Could not resolve dependencies/i,
  ],
  [
    'compile',
    /error\[E\d{4}\]|could not compile|error TS\d+|SyntaxError|IndentationError|compilation failed|cannot find symbol|undefined reference to|\.(?:c|cc|cpp|ts|tsx|js|rs|go|py):\d+(?::\d+)?:\s*(?:fatal\s+)?error/i,
  ],
  [
    'test',
    /test result: FAILED|^FAILED |^\s*FAIL\s|--- FAIL:|AssertionError|assert(?:ion)? failed|\b[1-9]\d* failed\b|Tests:\s+[1-9]\d* failed|Expected:? .{0,80}|Received:/im,
  ],
  [
    'crash',
    /panicked at|Segmentation fault|SIGSEGV|SIGABRT|Traceback \(most recent call last\)|Unhandled(?:Promise)?Rejection|uncaught exception/i,
  ],
];

const DIAGNOSTIC_LINE_RE =
  /\berror(?:\[E\d+\]|\s+TS\d+|:)|\bfatal error\b|^\s*FAIL\s|--- FAIL:|test result: FAILED|AssertionError|Expected:|Received:|panicked at|Traceback \(most recent call last\)|^E\s+assert|^\s*-->\s+|\bSyntaxError\b|\bTypeError\b|\bReferenceError\b|Command failed|ELIFECYCLE|exit(?:ed)? (?:with )?(?:status|code) [1-9]/i;

const SUMMARY_LINE_RE =
  /^(?:Tests:|Test Suites:|test result:|Found \d+ errors?|Ran all test suites|Finished `?\w+`? target|FAIL\s|\d+ failed)/i;

const BUILD_NOISE_RE =
  /^\s*(?:Compiling |Downloading |Downloaded |Fetching |Updating |Locking |Installing |Fresh |Checking |Building |Unpacking |added \d+ packages|audited \d+ packages|\[\s*\d+\/\d+\]|\[\s*\d+%\]|✓\s+|ok\s+\S+|\.{5,}|npm http fetch|GET https?:\/\/)/i;

const INTERNAL_STACK_RE = /^\s+at\s+.*node_modules\//;

function normalizeBuildLines(rawOutput: string): string[] {
  const stripped = rawOutput.replace(ANSI_RE, '');
  const rawLines = stripped.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if (line.includes('\r')) {
      const segs = line.split('\r').filter((s) => s.trim().length > 0);
      out.push(segs.length > 0 ? segs[segs.length - 1] : '');
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Compress noisy build / compiler / test runner output using head/tail anchoring,
 * diagnostic-preserving context windows, and repetitive noise collapse.
 */
export function compressBuildOutput(
  rawOutput: string,
  options: BuildOutputCompressionOptions = {}
): BuildOutputCompressionResult {
  const headLines = Math.max(1, Math.floor(options.headLines ?? 10));
  const tailLines = Math.max(1, Math.floor(options.tailLines ?? 16));
  const ctxRadius = Math.max(0, Math.floor(options.diagnosticContextLines ?? 2));
  const maxOutputLines = Math.max(20, Math.floor(options.maxOutputLines ?? 80));
  const maxChars = Math.max(1000, Math.floor(options.maxChars ?? 12000));
  const collapsePassing = options.collapsePassingTests !== false;

  const lines = normalizeBuildLines(rawOutput);
  const fullText = lines.join('\n');

  if (lines.length === 0) {
    return {
      compressedText: '(no output)',
      category: 'clean',
      extractedFileSpans: [],
      preservedDiagnostics: [],
      omittedLines: 0,
      collapsedRuns: 0,
      metrics: buildMetrics(rawOutput, '(no output)', 0, 1),
    };
  }

  // Classify failure category and file spans on the full normalized output
  let category: BuildFailureCategory = 'clean';
  for (const [cat, rx] of FAILURE_RULES) {
    if (rx.test(fullText)) {
      category = cat;
      break;
    }
  }
  if (category === 'clean' && DIAGNOSTIC_LINE_RE.test(fullText)) {
    category = 'unknown';
  }
  const extractedFileSpans = Array.from(new Set(fullText.match(FILE_SPAN_RE) ?? [])).slice(0, 15);

  // Deduplicate immediate consecutive identical lines & collapse internal noise metadata
  const isNoise = (line: string) =>
    BUILD_NOISE_RE.test(line) ||
    INTERNAL_STACK_RE.test(line) ||
    (collapsePassing && /^\s*(?:✓|PASS\b|ok\s+\d+|test .+ \.\.\. ok$)/.test(line));

  const kept = new Set<number>();
  const diagnosticLines: string[] = [];

  // 1. Keep high-signal diagnostic and summary anchors (+ surrounding context)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DIAGNOSTIC_LINE_RE.test(line) || SUMMARY_LINE_RE.test(line)) {
      if (DIAGNOSTIC_LINE_RE.test(line) && diagnosticLines.length < 25) {
        diagnosticLines.push(line.trim());
      }
      for (let j = Math.max(0, i - ctxRadius); j <= Math.min(lines.length - 1, i + ctxRadius); j++) {
        if (!isNoise(lines[j]) || j === i) kept.add(j);
      }
    }
  }

  // 2. Keep head lines (skipping repetitive noise runs after the first 2 lines)
  let headNoiseRun = 0;
  for (let i = 0; i < Math.min(lines.length, headLines); i++) {
    if (isNoise(lines[i])) {
      headNoiseRun++;
      if (headNoiseRun <= 2) kept.add(i);
    } else {
      headNoiseRun = 0;
      kept.add(i);
    }
  }

  // 3. Keep tail lines (skipping repetitive noise runs except last 3 non-empty lines)
  const tailStart = Math.max(0, lines.length - tailLines);
  for (let i = tailStart; i < lines.length; i++) {
    if (!isNoise(lines[i]) || i >= lines.length - 3) {
      kept.add(i);
    }
  }

  // Enforce maxOutputLines budget while prioritizing diagnostics, summaries, tail, and head
  let sortedKept = Array.from(kept).sort((a, b) => a - b);
  if (sortedKept.length > maxOutputLines) {
    const budget = new Set<number>();
    const tiers: Array<(idx: number) => boolean> = [
      (idx) => DIAGNOSTIC_LINE_RE.test(lines[idx]) || SUMMARY_LINE_RE.test(lines[idx]),
      (idx) => idx >= lines.length - tailLines,
      (idx) => idx < Math.min(4, headLines),
      () => true,
    ];
    for (const pred of tiers) {
      for (const idx of sortedKept) {
        if (budget.size >= maxOutputLines) break;
        if (pred(idx)) budget.add(idx);
      }
      if (budget.size >= maxOutputLines) break;
    }
    sortedKept = Array.from(budget).sort((a, b) => a - b);
  }

  // Assemble compressed output with omission markers and collapse consecutive duplicates
  const outLines: string[] = [];
  let prevIdx = -1;
  let omittedLines = 0;
  let collapsedRuns = 0;
  let lastLineText: string | null = null;
  let repeatCount = 0;

  const flushRepeat = () => {
    if (repeatCount > 0) {
      outLines.push(`... [${repeatCount} identical line(s) collapsed] ...`);
      collapsedRuns++;
      repeatCount = 0;
    }
  };

  for (const idx of sortedKept) {
    const gap = idx - prevIdx - 1;
    if (gap > 0) {
      flushRepeat();
      const gapChars = lines.slice(prevIdx + 1, idx).reduce((sum, l) => sum + l.length + 1, 0);
      outLines.push(`... [omitted ${gap} lines (~${estimateTokens(gapChars)} tokens) of build output] ...`);
      omittedLines += gap;
      collapsedRuns++;
    }
    const line = lines[idx];
    if (line === lastLineText && line.trim() !== '') {
      repeatCount++;
      omittedLines++;
    } else {
      flushRepeat();
      outLines.push(line);
      lastLineText = line;
    }
    prevIdx = idx;
  }
  flushRepeat();

  if (prevIdx < lines.length - 1) {
    const tailGap = lines.length - 1 - prevIdx;
    const tailChars = lines.slice(prevIdx + 1).reduce((sum, l) => sum + l.length + 1, 0);
    outLines.push(`... [omitted ${tailGap} trailing lines (~${estimateTokens(tailChars)} tokens)] ...`);
    omittedLines += tailGap;
    collapsedRuns++;
  }

  let compressedText = outLines.join('\n');
  if (compressedText.length > maxChars) {
    const headBudget = Math.floor(maxChars * 0.45);
    const tailBudget = Math.floor(maxChars * 0.45);
    compressedText = `${compressedText.slice(0, headBudget)}\n... [truncated ${compressedText.length - headBudget - tailBudget} chars to fit ${maxChars}-char budget] ...\n${compressedText.slice(-tailBudget)}`;
  }

  return {
    compressedText,
    category,
    extractedFileSpans,
    preservedDiagnostics: diagnosticLines,
    omittedLines,
    collapsedRuns,
    metrics: buildMetrics(rawOutput, compressedText, lines.length, outLines.length),
  };
}
