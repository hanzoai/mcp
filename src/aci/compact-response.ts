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
import * as fsSync from 'fs';
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


// ============================================================================
// Stateful SWE-agent ACI Optimization Primitives (HIP-1347 / #48 / #44)
//   - Workspace & multi-tenant sandbox backends (NodeFs + InMemory VFS)
//   - WindowedFileViewer (stateful 100-line viewport + bounded index search)
//   - preflightSyntaxCheck & GuardedFileEditor (uniqueness + pre-flight lint gate)
//   - compactCommandOutput (head/tail + stack-frame dedup + ANSI strip + footer)
// ============================================================================

export type AciAccessErrorCode =
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'DENIED_PATH'
  | 'TENANT_ISOLATION_VIOLATION'
  | 'ROLE_DENIED'
  | 'FILE_NOT_FOUND'
  | 'NO_OPEN_FILE'
  | 'INVALID_ARGUMENT';

export class AciAccessError extends Error {
  public readonly code: AciAccessErrorCode;

  constructor(code: AciAccessErrorCode, message: string) {
    super(message);
    this.name = 'AciAccessError';
    this.code = code;
  }
}

export interface AciSecurityOptions {
  /** Optional sandbox root directory; paths outside this root are rejected. */
  workspaceRoot?: string;
  /** Relative POSIX path prefixes blocked from read/search/edit access. */
  deniedPathPrefixes?: string[];
  /** Caller tenant identifier for multi-tenant isolation. */
  tenantId?: string;
  /** Caller RBAC roles evaluated against file allowedRoles metadata. */
  roles?: string[];
  /** Reject unlabeled files when tenantId is provided (default: false). */
  requireTenantMatch?: boolean;
}

export interface AciFileEntry {
  content: string;
  tenantId?: string;
  allowedRoles?: string[];
}

export interface AciWorkspaceBackend {
  resolvePath(targetPath: string, caller?: AciSecurityOptions): string;
  displayPath(targetPath: string, caller?: AciSecurityOptions): string;
  exists(targetPath: string, caller?: AciSecurityOptions): boolean;
  readText(targetPath: string, caller?: AciSecurityOptions): string;
  writeTextAtomic(targetPath: string, content: string, caller?: AciSecurityOptions): void;
  listFiles?(caller?: AciSecurityOptions): string[];
}

function assertCleanPathInput(rawPath: string): void {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new AciAccessError('INVALID_ARGUMENT', 'File path must be a non-empty string');
  }
  if (rawPath.includes('\0')) {
    throw new AciAccessError('PATH_OUTSIDE_WORKSPACE', 'Null byte in file path is forbidden');
  }
}

function normalizePosixRelPath(relPath: string): string {
  const unified = relPath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(unified).replace(/^(\.\/)+/, '');
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new AciAccessError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path "${relPath}" escapes workspace root`
    );
  }
  return normalized;
}

function checkDeniedPrefixes(relPosix: string, deniedPrefixes?: string[]): void {
  if (!deniedPrefixes || deniedPrefixes.length === 0) return;
  const candidate = relPosix.replace(/^\/+/, '');
  for (const rawPrefix of deniedPrefixes) {
    const prefix = rawPrefix.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!prefix) continue;
    if (
      candidate === prefix ||
      candidate.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) ||
      ( !prefix.endsWith('/') && candidate.startsWith(prefix) && prefix.startsWith('.') )
    ) {
      throw new AciAccessError(
        'DENIED_PATH',
        `Access to "${relPosix}" is blocked by denied path policy ("${rawPrefix}")`
      );
    }
  }
}

function authorizeEntryMetadata(
  displayPath: string,
  entry: { tenantId?: string; allowedRoles?: string[] },
  caller?: AciSecurityOptions
): void {
  const callerTenant = caller?.tenantId;
  const requireMatch = caller?.requireTenantMatch === true;

  if (entry.tenantId !== undefined) {
    if (!callerTenant || entry.tenantId !== callerTenant) {
      throw new AciAccessError(
        'TENANT_ISOLATION_VIOLATION',
        `Cross-tenant access denied for "${displayPath}"`
      );
    }
  } else if (callerTenant && requireMatch) {
    throw new AciAccessError(
      'TENANT_ISOLATION_VIOLATION',
      `Unlabeled resource "${displayPath}" denied under strict tenant match`
    );
  }

  if (Array.isArray(entry.allowedRoles) && entry.allowedRoles.length > 0) {
    const callerRoles = new Set(caller?.roles ?? []);
    const permitted = entry.allowedRoles.some((r) => callerRoles.has(r));
    if (!permitted) {
      throw new AciAccessError(
        'ROLE_DENIED',
        `Caller lacks required role to access "${displayPath}"`
      );
    }
  }
}

/**
 * Real filesystem backend enforcing workspace root containment, symlink-escape checks,
 * denied path prefixes, and atomic temp-file + rename persistence.
 */
export class NodeFsWorkspaceBackend implements AciWorkspaceBackend {
  private readonly root: string | null;
  private readonly defaultSecurity: AciSecurityOptions;

  constructor(options: AciSecurityOptions = {}) {
    this.defaultSecurity = options;
    this.root = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
  }

  private effectiveSecurity(caller?: AciSecurityOptions): AciSecurityOptions {
    return {
      ...this.defaultSecurity,
      ...caller,
      deniedPathPrefixes: caller?.deniedPathPrefixes ?? this.defaultSecurity.deniedPathPrefixes,
    };
  }

  public resolvePath(targetPath: string, caller?: AciSecurityOptions): string {
    assertCleanPathInput(targetPath);
    const sec = this.effectiveSecurity(caller);
    const rootDir = sec.workspaceRoot ? path.resolve(sec.workspaceRoot) : this.root;

    if (!rootDir) {
      const abs = path.resolve(targetPath);
      checkDeniedPrefixes(path.basename(abs), sec.deniedPathPrefixes);
      return abs;
    }

    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(rootDir, targetPath);

    const rel = path.relative(rootDir, resolved);
    const relPosix = normalizePosixRelPath(rel === '' ? '.' : rel);
    checkDeniedPrefixes(relPosix, sec.deniedPathPrefixes);

    // Prevent symlink escape outside workspaceRoot when path or parent exists on disk
    if (fsSync.existsSync(rootDir)) {
      const realRoot = fsSync.realpathSync(rootDir);
      const probePath = fsSync.existsSync(resolved) ? resolved : path.dirname(resolved);
      if (fsSync.existsSync(probePath)) {
        const realProbe = fsSync.realpathSync(probePath);
        const realRel = path.relative(realRoot, realProbe);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          throw new AciAccessError(
            'PATH_OUTSIDE_WORKSPACE',
            `Symlink target for "${targetPath}" escapes workspace root`
          );
        }
      }
    }

    return resolved;
  }

  public displayPath(targetPath: string, caller?: AciSecurityOptions): string {
    const resolved = this.resolvePath(targetPath, caller);
    const sec = this.effectiveSecurity(caller);
    const rootDir = sec.workspaceRoot ? path.resolve(sec.workspaceRoot) : this.root;
    if (rootDir) {
      const rel = path.relative(rootDir, resolved).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) return rel;
    }
    return targetPath.replace(/\\/g, '/');
  }

  public exists(targetPath: string, caller?: AciSecurityOptions): boolean {
    const resolved = this.resolvePath(targetPath, caller);
    try {
      return fsSync.statSync(resolved).isFile();
    } catch {
      return false;
    }
  }

  public readText(targetPath: string, caller?: AciSecurityOptions): string {
    const resolved = this.resolvePath(targetPath, caller);
    if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isFile()) {
      throw new AciAccessError('FILE_NOT_FOUND', `File not found: ${targetPath}`);
    }
    return fsSync.readFileSync(resolved, 'utf8');
  }

  public writeTextAtomic(targetPath: string, content: string, caller?: AciSecurityOptions): void {
    const resolved = this.resolvePath(targetPath, caller);
    const dir = path.dirname(resolved);
    fsSync.mkdirSync(dir, { recursive: true });
    const nonce = crypto.randomBytes(6).toString('hex');
    const tmpFile = path.join(dir, `.${path.basename(resolved)}.aci-${process.pid}-${nonce}.tmp`);
    try {
      fsSync.writeFileSync(tmpFile, content, 'utf8');
      fsSync.renameSync(tmpFile, resolved);
    } catch (err) {
      try {
        if (fsSync.existsSync(tmpFile)) fsSync.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }
}

/**
 * Deterministic in-memory VFS workspace backend compatible with Hanzo VFS
 * multi-tenant isolation rules (tenantId + RBAC role enforcement before read/edit).
 */
export class InMemoryVfsWorkspaceBackend implements AciWorkspaceBackend {
  private readonly store = new Map<string, AciFileEntry>();
  private readonly defaultSecurity: AciSecurityOptions;

  constructor(
    initialFiles: Record<string, string | AciFileEntry> = {},
    security: AciSecurityOptions = {}
  ) {
    this.defaultSecurity = security;
    for (const [rawKey, val] of Object.entries(initialFiles)) {
      const key = normalizePosixRelPath(rawKey);
      if (typeof val === 'string') {
        this.store.set(key, { content: val, tenantId: security.tenantId });
      } else {
        this.store.set(key, { ...val });
      }
    }
  }

  private effectiveSecurity(caller?: AciSecurityOptions): AciSecurityOptions {
    return {
      ...this.defaultSecurity,
      ...caller,
      deniedPathPrefixes: caller?.deniedPathPrefixes ?? this.defaultSecurity.deniedPathPrefixes,
    };
  }

  public resolvePath(targetPath: string, caller?: AciSecurityOptions): string {
    assertCleanPathInput(targetPath);
    const sec = this.effectiveSecurity(caller);
    const key = normalizePosixRelPath(targetPath);
    checkDeniedPrefixes(key, sec.deniedPathPrefixes);
    return key;
  }

  public displayPath(targetPath: string, caller?: AciSecurityOptions): string {
    return this.resolvePath(targetPath, caller);
  }

  public putFile(targetPath: string, entry: string | AciFileEntry): void {
    const key = normalizePosixRelPath(targetPath);
    if (typeof entry === 'string') {
      this.store.set(key, { content: entry, tenantId: this.defaultSecurity.tenantId });
    } else {
      this.store.set(key, { ...entry });
    }
  }

  public exists(targetPath: string, caller?: AciSecurityOptions): boolean {
    const key = this.resolvePath(targetPath, caller);
    const entry = this.store.get(key);
    if (!entry) return false;
    authorizeEntryMetadata(key, entry, this.effectiveSecurity(caller));
    return true;
  }

  public readText(targetPath: string, caller?: AciSecurityOptions): string {
    const key = this.resolvePath(targetPath, caller);
    const entry = this.store.get(key);
    if (!entry) {
      throw new AciAccessError('FILE_NOT_FOUND', `File not found in VFS: ${key}`);
    }
    authorizeEntryMetadata(key, entry, this.effectiveSecurity(caller));
    return entry.content;
  }

  public writeTextAtomic(targetPath: string, content: string, caller?: AciSecurityOptions): void {
    const key = this.resolvePath(targetPath, caller);
    const sec = this.effectiveSecurity(caller);
    const existing = this.store.get(key);
    if (existing) {
      authorizeEntryMetadata(key, existing, sec);
      this.store.set(key, { ...existing, content });
    } else {
      this.store.set(key, {
        content,
        tenantId: sec.tenantId,
        allowedRoles: sec.roles,
      });
    }
  }

  public listFiles(caller?: AciSecurityOptions): string[] {
    const sec = this.effectiveSecurity(caller);
    const visible: string[] = [];
    for (const [key, entry] of this.store.entries()) {
      try {
        checkDeniedPrefixes(key, sec.deniedPathPrefixes);
        authorizeEntryMetadata(key, entry, sec);
        visible.push(key);
      } catch {
        // Omit unauthorized entries prior to listing
      }
    }
    return visible.sort();
  }
}

export interface WindowedFileViewerOptions {
  /** Default viewport size in lines (SWE-agent canonical default: 100). */
  windowSize?: number;
  /** Default line overlap when scrolling up/down without explicit step (default: 0). */
  scrollOverlap?: number;
  /** Maximum characters per rendered line before truncation (default: 240). */
  maxLineLength?: number;
  /** Column separator between line number and source text (default: '|'). */
  separator?: string;
  /** Optional workspace root directory when using local filesystem backend. */
  workspaceRoot?: string;
  /** Optional security and multi-tenant isolation settings. */
  security?: AciSecurityOptions;
  /** Custom or VFS workspace backend. */
  backend?: AciWorkspaceBackend;
  /** Convenience initial VFS files (automatically creates InMemoryVfsWorkspaceBackend). */
  files?: Record<string, string | AciFileEntry>;
}

export interface ViewerCursorSnapshot {
  filePath: string;
  resolvedPath: string;
  startLine: number;
  endLine: number;
  windowSize: number;
  totalLines: number;
  hash: string;
  navigationCount: number;
}

export interface SearchFileOptions {
  /** Optional target file path; defaults to the currently open file in the viewer. */
  filePath?: string;
  /** Case-insensitive string search when query is a string (default: false). */
  caseInsensitive?: boolean;
  /** Maximum match previews rendered inline before summarizing remaining indices (default: 20). */
  maxMatchesShown?: number;
  /** Maximum characters per matched line preview (default: 120). */
  maxPreviewChars?: number;
  /** Automatically jump the viewer cursor to the Nth match (1-based) when true. */
  autoJump?: boolean;
  /** Which 1-based match occurrence to center on when autoJump is true (default: 1). */
  occurrence?: number;
}

export interface SearchFileMatch {
  line: number;
  column: number;
  preview: string;
}

export interface SearchFileResult {
  filePath: string;
  hash: string;
  query: string;
  totalMatches: number;
  matchLines: number[];
  matches: SearchFileMatch[];
  truncated: boolean;
  rendered: string;
  window?: FileWindowResult;
  metrics: CompressionMetrics;
}

/**
 * Stateful SWE-agent line-numbered windowed file viewer.
 * Maintains a bounded viewport (default 100 lines) with open, scroll_down,
 * scroll_up, goto_line, and search_file (returning compact match line indices
 * rather than flooding agent context with entire files).
 */
export class WindowedFileViewer {
  private readonly backend: AciWorkspaceBackend;
  private readonly security: AciSecurityOptions;
  private readonly defaultWindowSize: number;
  private readonly scrollOverlap: number;
  private readonly maxLineLength: number;
  private readonly separator: string;
  private cursor: ViewerCursorSnapshot | null = null;

  constructor(options: WindowedFileViewerOptions = {}) {
    this.security = {
      ...options.security,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    };
    if (options.backend) {
      this.backend = options.backend;
    } else if (options.files) {
      this.backend = new InMemoryVfsWorkspaceBackend(options.files, this.security);
    } else {
      this.backend = new NodeFsWorkspaceBackend(this.security);
    }
    this.defaultWindowSize = Math.max(1, Math.floor(options.windowSize ?? 100));
    this.scrollOverlap = Math.max(0, Math.floor(options.scrollOverlap ?? 0));
    this.maxLineLength = Math.max(40, Math.floor(options.maxLineLength ?? 240));
    this.separator = options.separator ?? '|';
  }

  public getBackend(): AciWorkspaceBackend {
    return this.backend;
  }

  public getSecurityOptions(): AciSecurityOptions {
    return { ...this.security };
  }

  public getState(): ViewerCursorSnapshot | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  /**
   * Open a file at a 100-line (or custom) viewport starting at startLine (default 1).
   */
  public open(filePath: string, startLine = 1, windowSize?: number): FileWindowResult {
    const resolvedPath = this.backend.resolvePath(filePath, this.security);
    const shownPath = this.backend.displayPath(filePath, this.security);
    const content = this.backend.readText(filePath, this.security);
    const vpSize = Math.max(1, Math.floor(windowSize ?? this.defaultWindowSize));
    const win = renderFileWindow(content, {
      filePath: shownPath,
      startLine: Math.max(1, Math.floor(startLine)),
      windowSize: vpSize,
      maxLineLength: this.maxLineLength,
      separator: this.separator,
    });
    this.cursor = {
      filePath: shownPath,
      resolvedPath,
      startLine: Math.max(1, win.startLine),
      endLine: win.endLine,
      windowSize: vpSize,
      totalLines: win.totalLines,
      hash: win.hash,
      navigationCount: (this.cursor?.navigationCount ?? 0) + 1,
    };
    return win;
  }

  /**
   * Scroll the current file viewport downward by stepLines (defaults to windowSize - scrollOverlap).
   */
  public scroll_down(stepLines?: number): FileWindowResult {
    if (!this.cursor) {
      throw new AciAccessError('NO_OPEN_FILE', 'No file is currently open; call open(filePath) first');
    }
    const content = this.backend.readText(this.cursor.resolvedPath, this.security);
    const totalLines = splitLines(content).length;
    const vpSize = this.cursor.windowSize;
    const defaultStep = Math.max(1, vpSize - Math.min(Math.floor(vpSize / 2), this.scrollOverlap));
    const step = Math.max(1, Math.floor(stepLines ?? defaultStep));
    const maxStart = Math.max(1, totalLines - vpSize + 1);
    const nextStart = Math.min(Math.max(this.cursor.startLine, maxStart), this.cursor.startLine + step);

    const win = renderFileWindow(content, {
      filePath: this.cursor.filePath,
      startLine: nextStart,
      windowSize: vpSize,
      maxLineLength: this.maxLineLength,
      separator: this.separator,
    });
    this.cursor = {
      ...this.cursor,
      startLine: Math.max(1, win.startLine),
      endLine: win.endLine,
      totalLines: win.totalLines,
      hash: win.hash,
      navigationCount: this.cursor.navigationCount + 1,
    };
    return win;
  }

  public scrollDown(stepLines?: number): FileWindowResult {
    return this.scroll_down(stepLines);
  }

  /**
   * Scroll the current file viewport upward by stepLines (defaults to windowSize - scrollOverlap).
   */
  public scroll_up(stepLines?: number): FileWindowResult {
    if (!this.cursor) {
      throw new AciAccessError('NO_OPEN_FILE', 'No file is currently open; call open(filePath) first');
    }
    const content = this.backend.readText(this.cursor.resolvedPath, this.security);
    const vpSize = this.cursor.windowSize;
    const defaultStep = Math.max(1, vpSize - Math.min(Math.floor(vpSize / 2), this.scrollOverlap));
    const step = Math.max(1, Math.floor(stepLines ?? defaultStep));
    const nextStart = Math.max(1, this.cursor.startLine - step);

    const win = renderFileWindow(content, {
      filePath: this.cursor.filePath,
      startLine: nextStart,
      windowSize: vpSize,
      maxLineLength: this.maxLineLength,
      separator: this.separator,
    });
    this.cursor = {
      ...this.cursor,
      startLine: Math.max(1, win.startLine),
      endLine: win.endLine,
      totalLines: win.totalLines,
      hash: win.hash,
      navigationCount: this.cursor.navigationCount + 1,
    };
    return win;
  }

  public scrollUp(stepLines?: number): FileWindowResult {
    return this.scroll_up(stepLines);
  }

  /**
   * Center the active viewport on the requested 1-based line number and highlight it.
   */
  public goto_line(line: number): FileWindowResult {
    if (!this.cursor) {
      throw new AciAccessError('NO_OPEN_FILE', 'No file is currently open; call open(filePath) first');
    }
    if (!Number.isFinite(line) || line < 1) {
      throw new AciAccessError('INVALID_ARGUMENT', `Invalid target line number: ${line}`);
    }
    const content = this.backend.readText(this.cursor.resolvedPath, this.security);
    const totalLines = splitLines(content).length;
    const clampedTarget = totalLines > 0 ? Math.max(1, Math.min(totalLines, Math.floor(line))) : 1;

    const win = renderFileWindow(content, {
      filePath: this.cursor.filePath,
      centerLine: clampedTarget,
      windowSize: this.cursor.windowSize,
      maxLineLength: this.maxLineLength,
      separator: this.separator,
      highlightLines: totalLines > 0 ? [clampedTarget] : [],
    });
    this.cursor = {
      ...this.cursor,
      startLine: Math.max(1, win.startLine),
      endLine: win.endLine,
      totalLines: win.totalLines,
      hash: win.hash,
      navigationCount: this.cursor.navigationCount + 1,
    };
    return win;
  }

  public gotoLine(line: number): FileWindowResult {
    return this.goto_line(line);
  }

  /**
   * Search a file and return match line indices + bounded one-line previews
   * without dumping the full file into context.
   */
  public search_file(query: string | RegExp, options: SearchFileOptions = {}): SearchFileResult {
    const targetInput = options.filePath ?? this.cursor?.resolvedPath;
    if (!targetInput) {
      throw new AciAccessError(
        'NO_OPEN_FILE',
        'No file specified and no file is currently open in viewer'
      );
    }
    if (typeof query === 'string' && query.length === 0) {
      throw new AciAccessError('INVALID_ARGUMENT', 'Search query must be non-empty');
    }

    const resolvedPath = this.backend.resolvePath(targetInput, this.security);
    const shownPath = this.backend.displayPath(targetInput, this.security);
    const content = this.backend.readText(resolvedPath, this.security);
    const hash = computeContentHash(content);
    const lines = splitLines(content);

    const maxMatchesShown = Math.max(1, Math.floor(options.maxMatchesShown ?? 20));
    const maxPreviewChars = Math.max(40, Math.floor(options.maxPreviewChars ?? 120));

    let matcher: RegExp;
    let queryLabel: string;
    if (query instanceof RegExp) {
      const cleanFlags = query.flags.replace(/g/g, '');
      matcher = new RegExp(query.source, cleanFlags);
      queryLabel = query.toString();
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matcher = new RegExp(escaped, options.caseInsensitive ? 'i' : '');
      queryLabel = JSON.stringify(query);
    }

    const matchLines: number[] = [];
    const matches: SearchFileMatch[] = [];
    let totalMatches = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const globalRx = new RegExp(matcher.source, matcher.flags + 'g');
      let m: RegExpExecArray | null;
      let matchedOnLine = false;
      let firstCol = 1;

      while ((m = globalRx.exec(lineText)) !== null) {
        if (!matchedOnLine) {
          matchedOnLine = true;
          firstCol = m.index + 1;
        }
        totalMatches++;
        if (m[0].length === 0) globalRx.lastIndex++;
      }

      if (matchedOnLine) {
        const lineNum = i + 1;
        matchLines.push(lineNum);
        if (matches.length < maxMatchesShown) {
          const trimmed = lineText.trim();
          const preview =
            trimmed.length > maxPreviewChars
              ? `${trimmed.slice(0, maxPreviewChars)}...`
              : trimmed;
          matches.push({ line: lineNum, column: firstCol, preview });
        }
      }
    }

    const truncated = matchLines.length > maxMatchesShown;
    const out: string[] = [];
    if (matchLines.length === 0) {
      out.push(`[Search ${queryLabel} in ${shownPath} (${lines.length} lines): 0 matches]`);
    } else {
      const shownIndices = matchLines.slice(0, maxMatchesShown).join(', ');
      const extraIndices = truncated
        ? `, ... (+${matchLines.length - maxMatchesShown} more lines)`
        : '';
      out.push(
        `[Search ${queryLabel} in ${shownPath}: ${totalMatches} match(es) on ${matchLines.length} line(s) [${shownIndices}${extraIndices}]]`
      );
      for (const item of matches) {
        out.push(`  L${item.line}:${item.column} | ${item.preview}`);
      }
      if (truncated) {
        const remainingPreview = matchLines.slice(maxMatchesShown, maxMatchesShown + 15).join(', ');
        out.push(`  ... (${matchLines.length - maxMatchesShown} additional matching line(s): ${remainingPreview}${matchLines.length > maxMatchesShown + 15 ? ', ...' : ''})`);
      }
    }

    let jumpedWindow: FileWindowResult | undefined;
    if (options.autoJump && matchLines.length > 0) {
      const occ = Math.max(0, Math.min(matchLines.length - 1, (options.occurrence ?? 1) - 1));
      const targetLine = matchLines[occ];
      this.cursor = {
        filePath: shownPath,
        resolvedPath,
        startLine: 1,
        endLine: Math.min(lines.length, this.defaultWindowSize),
        windowSize: this.cursor?.windowSize ?? this.defaultWindowSize,
        totalLines: lines.length,
        hash,
        navigationCount: (this.cursor?.navigationCount ?? 0) + 1,
      };
      jumpedWindow = this.goto_line(targetLine);
    }

    const rendered = out.join('\n');
    return {
      filePath: shownPath,
      hash,
      query: typeof query === 'string' ? query : query.source,
      totalMatches,
      matchLines,
      matches,
      truncated,
      rendered,
      ...(jumpedWindow ? { window: jumpedWindow } : {}),
      metrics: buildMetrics(content, rendered, lines.length, out.length),
    };
  }

  public searchFile(query: string | RegExp, options?: SearchFileOptions): SearchFileResult {
    return this.search_file(query, options);
  }

  /**
   * Synchronize the viewer's cursor after an external/guarded edit on the same file.
   */
  public syncAfterEdit(filePath: string, centerLine: number): void {
    const resolved = this.backend.resolvePath(filePath, this.security);
    if (!this.cursor || this.cursor.resolvedPath !== resolved) {
      const shown = this.backend.displayPath(filePath, this.security);
      const content = this.backend.readText(resolved, this.security);
      const totalLines = splitLines(content).length;
      const vpSize = this.defaultWindowSize;
      const half = Math.floor(vpSize / 2);
      const startLine =
        totalLines === 0
          ? 1
          : Math.max(1, Math.min(Math.max(1, totalLines - vpSize + 1), centerLine - half));
      this.cursor = {
        filePath: shown,
        resolvedPath: resolved,
        startLine,
        endLine: Math.min(totalLines, startLine + vpSize - 1),
        windowSize: vpSize,
        totalLines,
        hash: computeContentHash(content),
        navigationCount: (this.cursor?.navigationCount ?? 0) + 1,
      };
      return;
    }
    this.goto_line(Math.max(1, centerLine));
  }
}

export type PreflightDiagnosticCode =
  | 'JSON_SYNTAX_ERROR'
  | 'MERGE_CONFLICT_MARKER'
  | 'TRUNCATED_PLACEHOLDER'
  | 'UNCLOSED_STRING'
  | 'UNCLOSED_TEMPLATE'
  | 'UNCLOSED_COMMENT'
  | 'UNMATCHED_CLOSING_DELIMITER'
  | 'MISMATCHED_DELIMITER'
  | 'UNCLOSED_DELIMITER'
  | 'INVALID_TOKEN_SEQUENCE'
  | 'CUSTOM_LINT_ERROR';

export interface PreflightSyntaxDiagnostic {
  line: number;
  column: number;
  code: PreflightDiagnosticCode;
  message: string;
}

export interface PreflightSyntaxOptions {
  filePath?: string;
  language?: 'ts' | 'js' | 'json' | 'rust' | 'python' | 'go' | 'auto';
  /** Reject lazy comment placeholders such as `// ... existing code ...` (default: true). */
  rejectStubPlaceholders?: boolean;
  /** Optional caller-supplied AST/compiler syntax validator. */
  customValidator?: (
    content: string,
    filePath: string,
    language: string
  ) => PreflightSyntaxDiagnostic[];
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const clamped = Math.max(0, Math.min(text.length, offset));
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'instanceof',
  'await',
  'yield',
  'new',
  'else',
  'do',
]);

function canStartJsRegex(prevToken: { kind: string; value: string } | null): boolean {
  if (!prevToken) return true;
  if (prevToken.kind === 'keyword') {
    return REGEX_PRECEDING_KEYWORDS.has(prevToken.value);
  }
  if (prevToken.kind === 'punct') {
    if (prevToken.value === ')' || prevToken.value === ']' || prevToken.value === '}' || prevToken.value === '++' || prevToken.value === '--' || prevToken.value === '<' || prevToken.value === '>') {
      return false;
    }
    return true;
  }
  return false;
}

function tryScanSingleLineRegex(content: string, slashIndex: number): number | null {
  let i = slashIndex + 1;
  let inCharClass = false;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i++;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      i++;
      continue;
    }
    if (ch === '/' && !inCharClass) {
      i++;
      while (i < content.length && /[dgimsuvy]/.test(content[i])) i++;
      return i;
    }
    i++;
  }
  return null;
}

const STUB_PLACEHOLDER_RE =
  /(?:\.\.\.|…)\s*(?:existing|remaining|unchanged|rest\s+of(?:\s+the)?)\s+(?:code|implementation|file|lines|methods|functions|body)\b/i;

/**
 * Deterministic pre-flight syntax & structural validator for TypeScript, JavaScript,
 * JSON, Rust, Python, and Go. Detects broken delimiters, nested template-expression
 * mismatches, unclosed literals/comments, JSON errors, conflict markers, lazy elision
 * placeholders, and invalid TS/JS token transitions with exact 1-based line and column.
 */
export function preflightSyntaxCheck(
  content: string,
  options: PreflightSyntaxOptions = {}
): PreflightSyntaxDiagnostic[] {
  const filePath = options.filePath ?? '<buffer>';
  const lang = detectLanguage(filePath, options.language);
  const rejectStubs = options.rejectStubPlaceholders !== false;
  const diagnostics: PreflightSyntaxDiagnostic[] = [];

  if (lang === 'json') {
    try {
      JSON.parse(content);
    } catch (err: any) {
      const msg = String(err?.message ?? 'Invalid JSON');
      let line = 1;
      let column = 1;
      const lineColMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
      const posMatch = msg.match(/position\s+(\d+)/i);
      if (lineColMatch) {
        line = Number(lineColMatch[1]);
        column = Number(lineColMatch[2]);
      } else if (posMatch) {
        const lc = offsetToLineColumn(content, Number(posMatch[1]));
        line = lc.line;
        column = lc.column;
      }
      diagnostics.push({
        line,
        column,
        code: 'JSON_SYNTAX_ERROR',
        message: `Invalid JSON: ${msg}`,
      });
    }
    if (options.customValidator) {
      diagnostics.push(...options.customValidator(content, filePath, lang));
    }
    return diagnostics;
  }

  // Check for unresolved Git merge conflict markers on raw lines
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  for (let idx = 0; idx < rawLines.length; idx++) {
    const ln = rawLines[idx];
    if (/^(?:<{7}\s|={7}$|>{7}\s)/.test(ln)) {
      diagnostics.push({
        line: idx + 1,
        column: 1,
        code: 'MERGE_CONFLICT_MARKER',
        message: `Unresolved merge conflict marker "${ln.slice(0, 7)}"`,
      });
    }
  }

  type StackFrame =
    | { kind: 'delim'; open: '(' | '[' | '{'; expected: ')' | ']' | '}'; line: number; column: number }
    | { kind: 'template'; line: number; column: number }
    | { kind: 'template_expr'; line: number; column: number };

  const stack: StackFrame[] = [];
  const delimExpected: Record<string, ')' | ']' | '}'> = { '(': ')', '[': ']', '{': '}' };
  const isJsLike = lang === 'ts' || lang === 'js';
  const supportsSlashComments = lang !== 'python';

  interface LexToken {
    kind: 'ident' | 'keyword' | 'number' | 'string' | 'punct';
    value: string;
    line: number;
    column: number;
  }

  const JS_KEYWORDS = new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'class',
    'extends',
    'implements',
    'interface',
    'type',
    'import',
    'export',
    'from',
    'as',
    'new',
    'typeof',
    'void',
    'delete',
    'in',
    'of',
    'instanceof',
    'await',
    'yield',
    'async',
  ]);

  const tokens: LexToken[] = [];
  let line = 1;
  let col = 1;
  let i = 0;

  const advance = (count = 1) => {
    for (let k = 0; k < count && i < content.length; k++) {
      if (content.charCodeAt(i) === 10) {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const currentMode = (): 'code' | 'template' => {
    const top = stack[stack.length - 1];
    return top && top.kind === 'template' ? 'template' : 'code';
  };

  while (i < content.length) {
    if (currentMode() === 'template') {
      const ch = content[i];
      const next = content[i + 1] ?? '';
      if (ch === '\\') {
        advance(2);
        continue;
      }
      if (ch === '`') {
        stack.pop();
        tokens.push({ kind: 'string', value: '`', line, column: col });
        advance(1);
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'template_expr', line, column: col });
        tokens.push({ kind: 'punct', value: '${', line, column: col });
        advance(2);
        continue;
      }
      advance(1);
      continue;
    }

    const ch = content[i];
    const next = content[i + 1] ?? '';
    const next2 = content[i + 2] ?? '';

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    // Python '#' line comments
    if (lang === 'python' && ch === '#') {
      const commentLine = line;
      const commentCol = col;
      const startIdx = i;
      while (i < content.length && content[i] !== '\n') advance(1);
      const commentBody = content.slice(startIdx, i);
      if (rejectStubs && STUB_PLACEHOLDER_RE.test(commentBody)) {
        diagnostics.push({
          line: commentLine,
          column: commentCol,
          code: 'TRUNCATED_PLACEHOLDER',
          message: 'Comment contains truncated code placeholder stub',
        });
      }
      continue;
    }

    // '//' line comments
    if (supportsSlashComments && ch === '/' && next === '/') {
      const commentLine = line;
      const commentCol = col;
      const startIdx = i;
      while (i < content.length && content[i] !== '\n') advance(1);
      const commentBody = content.slice(startIdx, i);
      if (rejectStubs && STUB_PLACEHOLDER_RE.test(commentBody)) {
        diagnostics.push({
          line: commentLine,
          column: commentCol,
          code: 'TRUNCATED_PLACEHOLDER',
          message: 'Comment contains truncated code placeholder stub',
        });
      }
      continue;
    }

    // '/* ... */' block comments
    if (supportsSlashComments && ch === '/' && next === '*') {
      const openLine = line;
      const openCol = col;
      const startIdx = i;
      advance(2);
      let closed = false;
      while (i < content.length) {
        if (content[i] === '*' && content[i + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        diagnostics.push({
          line: openLine,
          column: openCol,
          code: 'UNCLOSED_COMMENT',
          message: `Unclosed block comment '/*' opened at line ${openLine}:${openCol}`,
        });
      } else if (rejectStubs && STUB_PLACEHOLDER_RE.test(content.slice(startIdx, i))) {
        diagnostics.push({
          line: openLine,
          column: openCol,
          code: 'TRUNCATED_PLACEHOLDER',
          message: 'Block comment contains truncated code placeholder stub',
        });
      }
      continue;
    }

    // Python triple-quoted strings
    if (lang === 'python' && ((ch === '"' && next === '"' && next2 === '"') || (ch === "'" && next === "'" && next2 === "'"))) {
      const quote3 = ch.repeat(3);
      const openLine = line;
      const openCol = col;
      advance(3);
      let closed = false;
      while (i < content.length) {
        if (content[i] === '\\') {
          advance(2);
          continue;
        }
        if (content.startsWith(quote3, i)) {
          advance(3);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        diagnostics.push({
          line: openLine,
          column: openCol,
          code: 'UNCLOSED_STRING',
          message: `Unclosed triple-quoted string (${quote3}) opened at line ${openLine}:${openCol}`,
        });
      }
      tokens.push({ kind: 'string', value: quote3, line: openLine, column: openCol });
      continue;
    }

    // Rust raw strings r#"..."#
    if (lang === 'rust' && ch === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let scan = i + 1;
      while (scan < content.length && content[scan] === '#') {
        hashes++;
        scan++;
      }
      if (content[scan] === '"') {
        const openLine = line;
        const openCol = col;
        const closingSeq = '"' + '#'.repeat(hashes);
        advance(scan - i + 1);
        let closed = false;
        while (i < content.length) {
          if (content.startsWith(closingSeq, i)) {
            advance(closingSeq.length);
            closed = true;
            break;
          }
          advance(1);
        }
        if (!closed) {
          diagnostics.push({
            line: openLine,
            column: openCol,
            code: 'UNCLOSED_STRING',
            message: `Unclosed Rust raw string opened at line ${openLine}:${openCol}`,
          });
        }
        tokens.push({ kind: 'string', value: 'r""', line: openLine, column: openCol });
        continue;
      }
    }

    // Go raw backtick multiline strings
    if (lang === 'go' && ch === '`') {
      const openLine = line;
      const openCol = col;
      advance(1);
      let closed = false;
      while (i < content.length) {
        if (content[i] === '`') {
          advance(1);
          closed = true;
          break;
        }
        advance(1);
      }
      if (!closed) {
        diagnostics.push({
          line: openLine,
          column: openCol,
          code: 'UNCLOSED_STRING',
          message: `Unclosed raw string (\`) opened at line ${openLine}:${openCol}`,
        });
      }
      tokens.push({ kind: 'string', value: '`', line: openLine, column: openCol });
      continue;
    }

    // JS/TS template literals (handled via unified stack for ${...} nesting)
    if (isJsLike && ch === '`') {
      stack.push({ kind: 'template', line, column: col });
      advance(1);
      continue;
    }

    // Single or double quoted string literals
    if (ch === '"' || ch === "'") {
      if (lang === 'rust' && ch === "'") {
        // Distinguish Rust character literals ('x', '\n', '\u{...}') from tick labels ('a, 'static)
        const charLitMatch = content.slice(i).match(/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^'\\\n])'/);
        if (charLitMatch) {
          tokens.push({ kind: 'string', value: charLitMatch[0], line, column: col });
          advance(charLitMatch[0].length);
          continue;
        }
        const labelMatch = content.slice(i).match(/^'[a-zA-Z_][a-zA-Z0-9_]*/);
        if (labelMatch) {
          tokens.push({ kind: 'ident', value: labelMatch[0], line, column: col });
          advance(labelMatch[0].length);
          continue;
        }
      }

      const quote = ch;
      const openLine = line;
      const openCol = col;
      const allowMultiline = lang === 'rust';
      advance(1);
      let closed = false;
      while (i < content.length) {
        const c = content[i];
        if (c === '\\') {
          advance(2);
          continue;
        }
        if (c === quote) {
          advance(1);
          closed = true;
          break;
        }
        if ((c === '\n' || c === '\r') && !allowMultiline) {
          break;
        }
        advance(1);
      }
      if (!closed) {
        diagnostics.push({
          line: openLine,
          column: openCol,
          code: 'UNCLOSED_STRING',
          message: `Unclosed string literal (${quote}) at line ${openLine}:${openCol}`,
        });
      }
      tokens.push({ kind: 'string', value: quote, line: openLine, column: openCol });
      continue;
    }

    // JS/TS single-line regex literals
    if (isJsLike && ch === '/' && next !== '/' && next !== '*' && next !== '=') {
      const prevTok = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      if (canStartJsRegex(prevTok)) {
        const regexEnd = tryScanSingleLineRegex(content, i);
        if (regexEnd !== null) {
          const tokLine = line;
          const tokCol = col;
          advance(regexEnd - i);
          tokens.push({ kind: 'string', value: '/regex/', line: tokLine, column: tokCol });
          continue;
        }
      }
    }

    // Delimiters
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({
        kind: 'delim',
        open: ch,
        expected: delimExpected[ch],
        line,
        column: col,
      });
      tokens.push({ kind: 'punct', value: ch, line, column: col });
      advance(1);
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      const closeLine = line;
      const closeCol = col;
      const top = stack.pop();
      if (!top) {
        diagnostics.push({
          line: closeLine,
          column: closeCol,
          code: 'UNMATCHED_CLOSING_DELIMITER',
          message: `Unmatched closing '${ch}' at line ${closeLine}:${closeCol}`,
        });
      } else if (top.kind === 'template_expr') {
        if (ch !== '}') {
          diagnostics.push({
            line: closeLine,
            column: closeCol,
            code: 'MISMATCHED_DELIMITER',
            message: `Mismatched '${ch}' at line ${closeLine}:${closeCol}; expected '}' to close template expression opened at line ${top.line}:${top.column}`,
          });
        }
      } else if (top.kind === 'delim' && top.expected !== ch) {
        diagnostics.push({
          line: closeLine,
          column: closeCol,
          code: 'MISMATCHED_DELIMITER',
          message: `Mismatched '${ch}' at line ${closeLine}:${closeCol}; expected '${top.expected}' for '${top.open}' opened at line ${top.line}:${top.column}`,
        });
      }
      tokens.push({ kind: 'punct', value: ch, line: closeLine, column: closeCol });
      advance(1);
      continue;
    }

    // Identifiers & keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const tokLine = line;
      const tokCol = col;
      const start = i;
      while (i < content.length && /[a-zA-Z0-9_$]/.test(content[i])) {
        advance(1);
      }
      const word = content.slice(start, i);
      const isKw = isJsLike && JS_KEYWORDS.has(word);
      tokens.push({ kind: isKw ? 'keyword' : 'ident', value: word, line: tokLine, column: tokCol });
      continue;
    }

    // Numeric literals
    if (/[0-9]/.test(ch)) {
      const tokLine = line;
      const tokCol = col;
      const start = i;
      while (i < content.length && /[0-9a-fA-FxXoObBn_.]/.test(content[i])) {
        advance(1);
      }
      tokens.push({ kind: 'number', value: content.slice(start, i), line: tokLine, column: tokCol });
      continue;
    }

    // Multi-character operators & punctuation
    const tokLine = line;
    const tokCol = col;
    const three = content.slice(i, i + 3);
    const two = content.slice(i, i + 2);
    if (three === '===' || three === '!==' || three === '...' || three === '>>>' || three === '??=' || three === '&&=' || three === '||=') {
      tokens.push({ kind: 'punct', value: three, line: tokLine, column: tokCol });
      advance(3);
      continue;
    }
    if (
      two === '=>' ||
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||' ||
      two === '??' ||
      two === '?.' ||
      two === '++' ||
      two === '--' ||
      two === '+=' ||
      two === '-=' ||
      two === '*=' ||
      two === '/='
    ) {
      tokens.push({ kind: 'punct', value: two, line: tokLine, column: tokCol });
      advance(2);
      continue;
    }

    tokens.push({ kind: 'punct', value: ch, line: tokLine, column: tokCol });
    advance(1);
  }

  // Drain any unclosed frames on the stack
  for (const frame of stack) {
    if (frame.kind === 'template') {
      diagnostics.push({
        line: frame.line,
        column: frame.column,
        code: 'UNCLOSED_TEMPLATE',
        message: `Unclosed template literal (\`) opened at line ${frame.line}:${frame.column}`,
      });
    } else if (frame.kind === 'template_expr') {
      diagnostics.push({
        line: frame.line,
        column: frame.column,
        code: 'UNCLOSED_DELIMITER',
        message: `Unclosed template expression '\${' opened at line ${frame.line}:${frame.column}`,
      });
    } else {
      diagnostics.push({
        line: frame.line,
        column: frame.column,
        code: 'UNCLOSED_DELIMITER',
        message: `Unclosed '${frame.open}' opened at line ${frame.line}:${frame.column}`,
      });
    }
  }

  // Token-stream structural checks for TypeScript & JavaScript
  if (isJsLike && diagnostics.length === 0) {
    const DANGLING_OPS = new Set([
      '=',
      '+=',
      '-=',
      '*=',
      '/=',
      '===',
      '!==',
      '==',
      '!=',
      '&&',
      '||',
      '??',
    ]);
    const CLOSERS = new Set([';', ')', ']', '}']);
    const DUP_KEYWORDS = new Set(['function', 'return', 'class', 'import', 'export', 'const', 'let']);
    const PAREN_CONTROL = new Set(['if', 'while', 'for', 'switch']);

    for (let t = 0; t < tokens.length - 1; t++) {
      const cur = tokens[t];
      const nxt = tokens[t + 1];
      const prv = t > 0 ? tokens[t - 1] : null;
      const isPropAccess = prv !== null && (prv.value === '.' || prv.value === '?.');

      if (cur.kind === 'punct' && DANGLING_OPS.has(cur.value) && nxt.kind === 'punct' && CLOSERS.has(nxt.value)) {
        diagnostics.push({
          line: nxt.line,
          column: nxt.column,
          code: 'INVALID_TOKEN_SEQUENCE',
          message: `Unexpected '${nxt.value}' immediately after operator '${cur.value}' (missing expression)`,
        });
      } else if (cur.kind === 'punct' && cur.value === '=>' && nxt.kind === 'punct' && (nxt.value === ';' || nxt.value === ')' || nxt.value === ']' || nxt.value === '}')) {
        diagnostics.push({
          line: nxt.line,
          column: nxt.column,
          code: 'INVALID_TOKEN_SEQUENCE',
          message: `Arrow '=>' missing body expression before '${nxt.value}'`,
        });
      } else if (!isPropAccess && cur.kind === 'keyword' && cur.value === 'const' && nxt.kind === 'punct' && (nxt.value === ';' || nxt.value === '=')) {
        diagnostics.push({
          line: cur.line,
          column: cur.column,
          code: 'INVALID_TOKEN_SEQUENCE',
          message: `Invalid 'const ${nxt.value}' declaration (missing binding identifier)`,
        });
      } else if (!isPropAccess && cur.kind === 'keyword' && DUP_KEYWORDS.has(cur.value) && nxt.kind === 'keyword' && nxt.value === cur.value) {
        diagnostics.push({
          line: nxt.line,
          column: nxt.column,
          code: 'INVALID_TOKEN_SEQUENCE',
          message: `Duplicate consecutive keyword '${cur.value} ${nxt.value}'`,
        });
      } else if (!isPropAccess && cur.kind === 'keyword' && PAREN_CONTROL.has(cur.value) && nxt.kind === 'punct' && nxt.value === '{') {
        diagnostics.push({
          line: nxt.line,
          column: nxt.column,
          code: 'INVALID_TOKEN_SEQUENCE',
          message: `'${cur.value}' statement requires parenthesized header before '{'`,
        });
      }
    }
  }

  if (options.customValidator) {
    for (const d of options.customValidator(content, filePath, lang)) {
      diagnostics.push({
        line: d.line,
        column: d.column ?? 1,
        code: d.code ?? 'CUSTOM_LINT_ERROR',
        message: d.message,
      });
    }
  }

  return diagnostics;
}

export type GuardedEditErrorCode =
  | 'STALE_HASH'
  | 'SEARCH_BLOCK_NOT_FOUND'
  | 'NON_UNIQUE_SEARCH_BLOCK'
  | 'NO_OP_EDIT'
  | 'INVALID_SEARCH_BLOCK'
  | 'SYNTAX_LINT_REJECTED'
  | 'OVERLAPPING_HUNKS'
  | 'LINE_ANCHOR_MISMATCH'
  | 'ACCESS_DENIED';

export interface GuardedEditRequest {
  filePath: string;
  searchBlock: string;
  replaceBlock: string;
  /** Optional sha256 precondition hash. */
  baseHash?: string;
  /** Optional 1-based expected start line when disambiguating duplicate regions. */
  expectedStartLine?: number;
  expectedEndLine?: number;
  /** Localized +/- context lines returned in snippet (default: 4). */
  contextLines?: number;
  language?: 'ts' | 'js' | 'json' | 'rust' | 'python' | 'go' | 'auto';
}

export interface GuardedEditResult {
  applied: boolean;
  status: 'applied' | 'rejected';
  errorCode: GuardedEditErrorCode | null;
  filePath: string;
  previousHash: string;
  newHash: string;
  linesAdded: number;
  linesRemoved: number;
  editedRange: { startLine: number; endLine: number } | null;
  matchingLines?: number[];
  closestLine?: number;
  syntaxDiagnostics: PreflightSyntaxDiagnostic[];
  /** Concise localized +/- context snippet on success, or exact line-numbered diagnostic on rejection. */
  snippet: string;
  metrics: CompressionMetrics;
}

export interface GuardedFileEditorOptions {
  /** Context lines shown above and below the edit or error locus (default: 4). */
  contextLines?: number;
  /** Enforce pre-flight syntax gate before writing to disk (default: true). */
  strictSyntax?: boolean;
  /** Reject lazy truncation placeholder comments (default: true). */
  rejectStubPlaceholders?: boolean;
  workspaceRoot?: string;
  security?: AciSecurityOptions;
  backend?: AciWorkspaceBackend;
  /** Optional paired WindowedFileViewer whose cursor auto-syncs to applied edits. */
  viewer?: WindowedFileViewer;
  customValidator?: (
    content: string,
    filePath: string,
    language: string
  ) => PreflightSyntaxDiagnostic[];
}

function findBestFuzzyLine(content: string, searchBlock: string): { line: number } | null {
  const fileLines = splitLines(content);
  const needleLines = splitLines(searchBlock).map((l) => l.trim()).filter(Boolean);
  if (fileLines.length === 0 || needleLines.length === 0) return null;

  const tokenizeSubwords = (s: string): string[] => {
    const raw = s.match(/[a-zA-Z0-9_]+|[+\-*/%&|^=!<>]=?/g) ?? [];
    const expanded: string[] = [];
    for (const tok of raw) {
      expanded.push(tok);
      const camel = tok.split(/(?=[A-Z])|_/).filter((p) => p.length >= 3);
      for (const c of camel) expanded.push(c.toLowerCase());
    }
    return expanded;
  };

  const firstNeedle = needleLines[0];
  const needleTokens = tokenizeSubwords(firstNeedle);
  let bestLine = 1;
  let bestScore = 0;

  for (let i = 0; i < fileLines.length; i++) {
    const cand = fileLines[i].trim();
    if (!cand) continue;
    let score = 0;
    if (cand === firstNeedle) {
      score += 30;
    } else if (cand.includes(firstNeedle) || firstNeedle.includes(cand)) {
      score += 15;
    } else {
      const candSet = new Set(tokenizeSubwords(cand));
      for (const tok of needleTokens) {
        if (candSet.has(tok)) score += 2;
      }
    }
    for (let k = 1; k < Math.min(needleLines.length, fileLines.length - i); k++) {
      const nextCand = fileLines[i + k].trim();
      if (nextCand === needleLines[k]) {
        score += 12;
      } else {
        const subSet = new Set(tokenizeSubwords(nextCand));
        for (const tok of tokenizeSubwords(needleLines[k])) {
          if (subSet.has(tok)) score += 1;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i + 1;
    }
  }

  return bestScore > 0 ? { line: bestLine } : findClosestSnippet(content, searchBlock);
}

function renderNumberedDiagnosticSnippet(
  text: string,
  focusLine: number,
  radius: number,
  markerLine?: number
): string {
  const lines = splitLines(text);
  if (lines.length === 0) return '(empty file)';
  const clamped = Math.max(1, Math.min(lines.length, focusLine));
  const start = Math.max(1, clamped - radius);
  const end = Math.min(lines.length, clamped + radius);
  const width = Math.max(4, String(end).length);
  const rows: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    const mark = markerLine === ln ? '!' : ' ';
    rows.push(`${mark}${String(ln).padStart(width)}|${lines[ln - 1]}`);
  }
  return rows.join('\n');
}

/**
 * Guarded atomic SWE-agent search-replace editor.
 * Enforces exact search-block uniqueness, optimistic baseHash concurrency,
 * and pre-flight TypeScript/JS/JSON/Rust/Python/Go syntax verification BEFORE
 * persisting to disk, so broken edits never corrupt workspace files.
 */
export class GuardedFileEditor {
  private readonly backend: AciWorkspaceBackend;
  private readonly security: AciSecurityOptions;
  private readonly contextLines: number;
  private readonly strictSyntax: boolean;
  private readonly rejectStubPlaceholders: boolean;
  private readonly viewer?: WindowedFileViewer;
  private readonly customValidator?: GuardedFileEditorOptions['customValidator'];
  private readonly fileLocks = new Map<string, Promise<void>>();

  constructor(options: GuardedFileEditorOptions = {}) {
    this.security = {
      ...(options.viewer?.getSecurityOptions() ?? {}),
      ...options.security,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    };
    this.backend =
      options.backend ??
      options.viewer?.getBackend() ??
      new NodeFsWorkspaceBackend(this.security);
    this.contextLines = Math.max(1, Math.floor(options.contextLines ?? 4));
    this.strictSyntax = options.strictSyntax !== false;
    this.rejectStubPlaceholders = options.rejectStubPlaceholders !== false;
    this.viewer = options.viewer;
    this.customValidator = options.customValidator;
  }

  /**
   * Synchronously validate and atomically apply a single search-replace edit.
   */
  public edit(request: GuardedEditRequest): GuardedEditResult {
    let resolvedPath: string;
    let shownPath: string;
    let originalContent: string;

    try {
      resolvedPath = this.backend.resolvePath(request.filePath, this.security);
      shownPath = this.backend.displayPath(request.filePath, this.security);
      originalContent = this.backend.readText(resolvedPath, this.security);
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      const snippet = `[Edit REJECTED: ${request.filePath} | ACCESS_DENIED]\n- ${msg}`;
      return {
        applied: false,
        status: 'rejected',
        errorCode: 'ACCESS_DENIED',
        filePath: request.filePath,
        previousHash: '',
        newHash: '',
        linesAdded: 0,
        linesRemoved: 0,
        editedRange: null,
        syntaxDiagnostics: [],
        snippet,
        metrics: buildMetrics(snippet, snippet),
      };
    }

    const previousHash = computeContentHash(originalContent);
    const ctxRadius = Math.max(1, Math.floor(request.contextLines ?? this.contextLines));

    const reject = (
      errorCode: GuardedEditErrorCode,
      headline: string,
      detailBlock?: string,
      extra?: {
        matchingLines?: number[];
        closestLine?: number;
        syntaxDiagnostics?: PreflightSyntaxDiagnostic[];
      }
    ): GuardedEditResult => {
      const parts = [`[Edit REJECTED: ${shownPath} | ${errorCode} | disk untouched (${previousHash})]`];
      parts.push(`- ${headline}`);
      if (detailBlock) parts.push(detailBlock);
      const snippet = parts.join('\n');
      return {
        applied: false,
        status: 'rejected',
        errorCode,
        filePath: shownPath,
        previousHash,
        newHash: previousHash,
        linesAdded: 0,
        linesRemoved: 0,
        editedRange: null,
        ...(extra?.matchingLines ? { matchingLines: extra.matchingLines } : {}),
        ...(extra?.closestLine !== undefined ? { closestLine: extra.closestLine } : {}),
        syntaxDiagnostics: extra?.syntaxDiagnostics ?? [],
        snippet,
        metrics: buildMetrics(originalContent, snippet),
      };
    };

    if (request.baseHash && request.baseHash !== previousHash) {
      return reject(
        'STALE_HASH',
        `Precondition baseHash mismatch: expected ${request.baseHash}, current ${previousHash}`
      );
    }

    if (typeof request.searchBlock !== 'string' || request.searchBlock.length === 0) {
      return reject('INVALID_SEARCH_BLOCK', 'searchBlock must be a non-empty string');
    }
    if (typeof request.replaceBlock !== 'string') {
      return reject('INVALID_SEARCH_BLOCK', 'replaceBlock must be a string');
    }

    // Harmonize CRLF if target file uses CRLF while caller supplied LF
    const fileUsesCrlf = originalContent.includes('\r\n');
    const effectiveSearch =
      fileUsesCrlf && !request.searchBlock.includes('\r\n')
        ? request.searchBlock.replace(/\n/g, '\r\n')
        : request.searchBlock;
    const effectiveReplace =
      fileUsesCrlf && !request.replaceBlock.includes('\r\n')
        ? request.replaceBlock.replace(/\n/g, '\r\n')
        : request.replaceBlock;

    if (effectiveSearch === effectiveReplace) {
      return reject('NO_OP_EDIT', 'searchBlock and replaceBlock are identical (no-op edit)');
    }

    // Uniqueness check across entire file
    const positions: number[] = [];
    let fromIdx = 0;
    while (fromIdx <= originalContent.length) {
      const found = originalContent.indexOf(effectiveSearch, fromIdx);
      if (found === -1) break;
      positions.push(found);
      fromIdx = found + Math.max(1, effectiveSearch.length);
    }

    if (positions.length === 0) {
      const closest = findBestFuzzyLine(originalContent, request.searchBlock);
      const hintBlock = closest
        ? `  Closest region near line ${closest.line}:\n${renderNumberedDiagnosticSnippet(
            originalContent,
            closest.line,
            ctxRadius,
            closest.line
          )}`
        : undefined;
      return reject(
        'SEARCH_BLOCK_NOT_FOUND',
        'searchBlock did not match any exact text in file; verify exact indentation and lines.',
        hintBlock,
        closest ? { closestLine: closest.line } : undefined
      );
    }

    const matchingLines = positions.map((pos) => lineNumberAtOffset(originalContent, pos));
    let targetOffset = positions[0];

    if (positions.length > 1) {
      if (typeof request.expectedStartLine === 'number') {
        const searchSpan = Math.max(1, splitLines(effectiveSearch).length);
        const endBound = request.expectedEndLine ?? request.expectedStartLine + searchSpan + 2;
        const candidates = positions.filter((pos) => {
          const ln = lineNumberAtOffset(originalContent, pos);
          return ln >= request.expectedStartLine! - 2 && ln <= endBound;
        });
        if (candidates.length === 1) {
          targetOffset = candidates[0];
        } else {
          return reject(
            'NON_UNIQUE_SEARCH_BLOCK',
            `searchBlock matched ${positions.length} locations (lines ${matchingLines.join(', ')}) and expectedStartLine=${request.expectedStartLine} did not uniquely disambiguate.`,
            undefined,
            { matchingLines }
          );
        }
      } else {
        return reject(
          'NON_UNIQUE_SEARCH_BLOCK',
          `searchBlock is not unique: matched ${positions.length} locations at lines ${matchingLines.join(', ')}. Include surrounding context lines or specify expectedStartLine.`,
          undefined,
          { matchingLines }
        );
      }
    } else if (typeof request.expectedStartLine === 'number') {
      const actualLine = matchingLines[0];
      const endBound = request.expectedEndLine ?? request.expectedStartLine;
      if (actualLine < request.expectedStartLine - 5 || actualLine > endBound + 5) {
        return reject(
          'LINE_ANCHOR_MISMATCH',
          `Unique match at line ${actualLine} lies outside expectedStartLine anchor (${request.expectedStartLine}-${endBound}).`,
          renderNumberedDiagnosticSnippet(originalContent, actualLine, ctxRadius, actualLine),
          { matchingLines }
        );
      }
    }

    // Construct candidate file content in memory BEFORE writing to disk
    const candidateContent =
      originalContent.slice(0, targetOffset) +
      effectiveReplace +
      originalContent.slice(targetOffset + effectiveSearch.length);

    // Pre-flight syntax & delimiter verification gate
    const lang = detectLanguage(shownPath, request.language);
    let syntaxDiagnostics: PreflightSyntaxDiagnostic[] = [];
    if (this.strictSyntax) {
      const beforeDiags = preflightSyntaxCheck(originalContent, {
        filePath: shownPath,
        language: request.language,
        rejectStubPlaceholders: this.rejectStubPlaceholders,
        customValidator: this.customValidator,
      });
      const afterDiags = preflightSyntaxCheck(candidateContent, {
        filePath: shownPath,
        language: request.language,
        rejectStubPlaceholders: this.rejectStubPlaceholders,
        customValidator: this.customValidator,
      });
      const baselineSignatures = new Set(beforeDiags.map((d) => `${d.code}:${d.message}`));
      syntaxDiagnostics =
        lang === 'json'
          ? afterDiags
          : afterDiags.filter((d) => !baselineSignatures.has(`${d.code}:${d.message}`));

      if (syntaxDiagnostics.length > 0) {
        const primary = syntaxDiagnostics[0];
        const diagLines = syntaxDiagnostics
          .slice(0, 5)
          .map((d) => `  Line ${d.line}:${d.column} [${d.code}]: ${d.message}`)
          .join('\n');
        const candidateWindow = renderNumberedDiagnosticSnippet(
          candidateContent,
          primary.line,
          ctxRadius,
          primary.line
        );
        return reject(
          'SYNTAX_LINT_REJECTED',
          `Pre-flight syntax check failed with ${syntaxDiagnostics.length} error(s); edit rolled back before disk write:`,
          `${diagLines}\n  Candidate context around line ${primary.line}:\n${candidateWindow}`,
          { syntaxDiagnostics }
        );
      }
    }

    // Persist atomically only after all guards succeed
    this.backend.writeTextAtomic(resolvedPath, candidateContent, this.security);

    const newHash = computeContentHash(candidateContent);
    const startLine = lineNumberAtOffset(originalContent, targetOffset);
    const oldLinesCount = effectiveSearch === '' ? 0 : splitLines(effectiveSearch).length || 1;
    const newLinesCount = effectiveReplace === '' ? 0 : splitLines(effectiveReplace).length || 1;
    const endLine = Math.max(startLine, startLine + Math.max(1, newLinesCount) - 1);

    const updatedLines = splitLines(candidateContent);
    const totalUpdatedLines = updatedLines.length;
    const winStart = Math.max(1, startLine - ctxRadius);
    const winEnd = Math.min(totalUpdatedLines, endLine + ctxRadius);
    const numWidth = Math.max(4, String(Math.max(1, winEnd)).length);

    const snippetRows: string[] = [
      `[Edit APPLIED: ${shownPath} | +${newLinesCount}/-${oldLinesCount} lines | lines ${startLine}-${endLine} | ${newHash}]`,
    ];
    if (winStart > 1) {
      snippetRows.push(`... (${winStart - 1} lines above) ...`);
    }
    for (let ln = winStart; ln <= winEnd; ln++) {
      const edited = newLinesCount > 0 && ln >= startLine && ln <= endLine;
      const prefix = edited ? '+' : ' ';
      snippetRows.push(`${prefix}${String(ln).padStart(numWidth)}|${updatedLines[ln - 1] ?? ''}`);
    }
    if (winEnd < totalUpdatedLines) {
      snippetRows.push(`... (${totalUpdatedLines - winEnd} lines below) ...`);
    }

    if (this.viewer) {
      this.viewer.syncAfterEdit(resolvedPath, startLine);
    }

    const snippet = snippetRows.join('\n');
    return {
      applied: true,
      status: 'applied',
      errorCode: null,
      filePath: shownPath,
      previousHash,
      newHash,
      linesAdded: newLinesCount,
      linesRemoved: oldLinesCount,
      editedRange: { startLine, endLine },
      syntaxDiagnostics: [],
      snippet,
      metrics: buildMetrics(candidateContent, snippet, totalUpdatedLines, snippetRows.length),
    };
  }

  /**
   * Async FIFO-locked atomic edit ensuring race-free serialization across
   * concurrent agent calls targeting the same file.
   */
  public async editAsync(request: GuardedEditRequest): Promise<GuardedEditResult> {
    let lockKey = request.filePath;
    try {
      lockKey = this.backend.resolvePath(request.filePath, this.security);
    } catch {
      // Let edit() return structured ACCESS_DENIED
    }

    const previous = this.fileLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.fileLocks.set(lockKey, chained);

    await previous;
    try {
      return this.edit(request);
    } finally {
      release();
      if (this.fileLocks.get(lockKey) === chained) {
        this.fileLocks.delete(lockKey);
      }
    }
  }
}

export interface CompactCommandOutputOptions {
  /** Process exit status included in structured footer (default: 0). */
  exitCode?: number;
  /** Wall-clock execution duration in milliseconds (default: 0). */
  elapsedMs?: number;
  /** Number of leading lines to preserve (default: 15). */
  headLines?: number;
  /** Number of trailing lines to preserve (default: 20). */
  tailLines?: number;
  /** Hard cap on output body lines before footer (default: 60). */
  maxLines?: number;
  /** Hard cap on output body UTF-8 bytes before footer (default: 4096). */
  maxBytes?: number;
  /** Preserve middle compiler/assertion diagnostic lines + 1-line context (default: true). */
  preserveDiagnostics?: boolean;
  /** Collapse consecutive or cyclic duplicate stack frames (default: true). */
  collapseStackFrames?: boolean;
  /** Collapse contiguous runs (>2) of internal runtime/vendor frames (default: true). */
  collapseInternalFrames?: boolean;
}

export interface CompactCommandOutputResult {
  /** Full bounded text including structured footer. */
  output: string;
  /** Bounded command output body prior to footer. */
  body: string;
  /** Structured footer: `[exit_code=... | elapsed_ms=... | truncated_bytes=...]`. */
  footer: string;
  exitCode: number;
  elapsedMs: number;
  originalBytes: number;
  outputBytes: number;
  truncatedBytes: number;
  originalLines: number;
  outputLines: number;
  ansiSequencesStripped: number;
  collapsedStackFrames: number;
  collapsedInternalFrames: number;
  omittedLines: number;
  category: BuildFailureCategory;
  extractedLocations: string[];
  metrics: CompressionMetrics;
}

const FULL_ANSI_OSC_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

const STACK_FRAME_LINE_RE =
  /^\s*(?:at\s+\S+|File\s+"[^"]+",\s+line\s+\d+|\d+:\s+(?:0x[0-9a-fA-F]+\s+-\s+)?[a-zA-Z0-9_:<>]+|[a-zA-Z0-9_./-]+\.go:\d+\s)/;

const INTERNAL_RUNTIME_FRAME_RE =
  /^\s*(?:at\s+.*(?:\(node:[^)]+\)|node:internal\/|\/node_modules\/|\\node_modules\\)|File\s+"[^"]*\/site-packages\/|\d+:\s+.*(?:::std::|\/rustc\/))/;

function normalizeStackFrameSignature(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function truncateUtf8BytesHeadTail(text: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return text;

  const markerTemplate = (droppedBytes: number) =>
    `\n... [truncated ${droppedBytes} bytes to enforce ${maxBytes}-byte ceiling] ...\n`;
  const reserveBytes = Buffer.byteLength(markerTemplate(totalBytes), 'utf8') + 16;
  const usable = Math.max(32, maxBytes - reserveBytes);
  const headBudget = Math.floor(usable * 0.45);
  const tailBudget = Math.max(16, usable - headBudget);

  const buf = Buffer.from(text, 'utf8');
  const headStr = buf.subarray(0, headBudget).toString('utf8').replace(/\uFFFD+$/, '');
  const tailStr = buf.subarray(buf.length - tailBudget).toString('utf8').replace(/^\uFFFD+/, '');
  const keptBytes = Buffer.byteLength(headStr, 'utf8') + Buffer.byteLength(tailStr, 'utf8');
  const dropped = Math.max(1, totalBytes - keptBytes);
  return `${headStr}${markerTemplate(dropped)}${tailStr}`;
}

/**
 * Bounded command-output compressor (`compactCommandOutput`):
 *   - Strips ANSI CSI/OSC color & cursor sequences and resolves `\r` overwrites
 *   - Collapses consecutive and 2-cycle recursive stack frames + internal runtime frames
 *   - Preserves head lines, high-signal error diagnostics, and tail summary lines
 *   - Appends deterministic `[exit_code=... | elapsed_ms=... | truncated_bytes=...]` footer
 */
export function compactCommandOutput(
  rawOutput: string | Buffer,
  options: CompactCommandOutputOptions = {}
): CompactCommandOutputResult {
  const rawString = Buffer.isBuffer(rawOutput) ? rawOutput.toString('utf8') : String(rawOutput ?? '');
  const originalBytes = Buffer.byteLength(rawString, 'utf8');

  const exitCode = Number.isFinite(options.exitCode) ? Math.trunc(options.exitCode!) : 0;
  const elapsedMs = Number.isFinite(options.elapsedMs) ? Math.max(0, Math.round(options.elapsedMs!)) : 0;
  const headLines = Math.max(1, Math.floor(options.headLines ?? 15));
  const tailLines = Math.max(1, Math.floor(options.tailLines ?? 20));
  const maxLines = Math.max(8, Math.floor(options.maxLines ?? 60));
  const maxBytes = Math.max(256, Math.floor(options.maxBytes ?? 4096));
  const preserveDiagnostics = options.preserveDiagnostics !== false;
  const shouldCollapseFrames = options.collapseStackFrames !== false;
  const shouldCollapseInternal = options.collapseInternalFrames !== false;

  // 1. Strip ANSI sequences and resolve carriage-return progress overwrites
  let ansiSequencesStripped = 0;
  const stripped = rawString.replace(FULL_ANSI_OSC_RE, () => {
    ansiSequencesStripped++;
    return '';
  });

  const splitRaw = stripped.replace(/\r\n/g, '\n').split('\n');
  const cleanLines: string[] = [];
  for (const rawLine of splitRaw) {
    if (rawLine.includes('\r')) {
      const segments = rawLine.split('\r').filter((s) => s.length > 0);
      cleanLines.push(segments.length > 0 ? segments[segments.length - 1] : '');
    } else {
      cleanLines.push(rawLine);
    }
  }
  while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === '') {
    cleanLines.pop();
  }

  const originalLines = cleanLines.length;
  const normalizedJoined = cleanLines.join('\n');

  // Classify failure root cause and extract file:line(:col) spans before truncation
  let category: BuildFailureCategory = exitCode === 0 ? 'clean' : 'unknown';
  for (const [cat, rx] of FAILURE_RULES) {
    if (rx.test(normalizedJoined)) {
      category = cat;
      break;
    }
  }
  const extractedLocations = Array.from(new Set(normalizedJoined.match(FILE_SPAN_RE) ?? [])).slice(0, 15);

  if (originalLines === 0) {
    const body = '(no output)';
    const footer = `[exit_code=${exitCode} | elapsed_ms=${elapsedMs} | truncated_bytes=0]`;
    const output = `${body}\n${footer}`;
    return {
      output,
      body,
      footer,
      exitCode,
      elapsedMs,
      originalBytes,
      outputBytes: Buffer.byteLength(output, 'utf8'),
      truncatedBytes: 0,
      originalLines: 0,
      outputLines: 2,
      ansiSequencesStripped,
      collapsedStackFrames: 0,
      collapsedInternalFrames: 0,
      omittedLines: 0,
      category,
      extractedLocations,
      metrics: buildMetrics(rawString, output, 0, 2),
    };
  }

  // 2. Collapse consecutive duplicate stack frames, 2-frame mutual recursion cycles,
  //    and long internal runtime/vendor stack frame runs
  let collapsedStackFrames = 0;
  let collapsedInternalFrames = 0;
  const dedupedLines: string[] = [];

  if (shouldCollapseFrames) {
    let idx = 0;
    while (idx < cleanLines.length) {
      const line = cleanLines[idx];
      if (!STACK_FRAME_LINE_RE.test(line)) {
        dedupedLines.push(line);
        idx++;
        continue;
      }

      const sigA = normalizeStackFrameSignature(line);

      // Direct consecutive recursion: frame A repeated >= 2 times
      let dupRun = 1;
      while (
        idx + dupRun < cleanLines.length &&
        STACK_FRAME_LINE_RE.test(cleanLines[idx + dupRun]) &&
        normalizeStackFrameSignature(cleanLines[idx + dupRun]) === sigA
      ) {
        dupRun++;
      }
      if (dupRun >= 2) {
        dedupedLines.push(line);
        const hidden = dupRun - 1;
        dedupedLines.push(`    ... [${hidden} duplicate stack frame(s) collapsed] ...`);
        collapsedStackFrames += hidden;
        idx += dupRun;
        continue;
      }

      // Mutual 2-frame recursion cycle: (A, B) repeated >= 2 cycles
      if (idx + 3 < cleanLines.length && STACK_FRAME_LINE_RE.test(cleanLines[idx + 1])) {
        const sigB = normalizeStackFrameSignature(cleanLines[idx + 1]);
        if (sigB !== sigA) {
          let cycles = 1;
          while (
            idx + cycles * 2 + 1 < cleanLines.length &&
            STACK_FRAME_LINE_RE.test(cleanLines[idx + cycles * 2]) &&
            STACK_FRAME_LINE_RE.test(cleanLines[idx + cycles * 2 + 1]) &&
            normalizeStackFrameSignature(cleanLines[idx + cycles * 2]) === sigA &&
            normalizeStackFrameSignature(cleanLines[idx + cycles * 2 + 1]) === sigB
          ) {
            cycles++;
          }
          if (cycles >= 2) {
            dedupedLines.push(cleanLines[idx]);
            dedupedLines.push(cleanLines[idx + 1]);
            const hidden = (cycles - 1) * 2;
            dedupedLines.push(`    ... [${hidden} cyclic stack frame(s) collapsed] ...`);
            collapsedStackFrames += hidden;
            idx += cycles * 2;
            continue;
          }
        }
      }

      // Internal runtime / node_modules stack runs (> 2 contiguous internal frames)
      if (shouldCollapseInternal && INTERNAL_RUNTIME_FRAME_RE.test(line)) {
        let internalRun = 1;
        while (
          idx + internalRun < cleanLines.length &&
          INTERNAL_RUNTIME_FRAME_RE.test(cleanLines[idx + internalRun])
        ) {
          internalRun++;
        }
        if (internalRun > 2) {
          dedupedLines.push(line);
          const hidden = internalRun - 1;
          dedupedLines.push(`    ... [${hidden} internal runtime frame(s) collapsed] ...`);
          collapsedInternalFrames += hidden;
          idx += internalRun;
          continue;
        }
      }

      dedupedLines.push(line);
      idx++;
    }
  } else {
    dedupedLines.push(...cleanLines);
  }

  // 3. Head + diagnostic anchors + tail selection within maxLines budget
  const totalDeduped = dedupedLines.length;
  const keepIndices = new Set<number>();

  for (let i = 0; i < Math.min(totalDeduped, headLines); i++) {
    keepIndices.add(i);
  }
  for (let i = Math.max(0, totalDeduped - tailLines); i < totalDeduped; i++) {
    keepIndices.add(i);
  }

  if (preserveDiagnostics) {
    for (let i = 0; i < totalDeduped; i++) {
      if (DIAGNOSTIC_LINE_RE.test(dedupedLines[i]) || SUMMARY_LINE_RE.test(dedupedLines[i])) {
        keepIndices.add(Math.max(0, i - 1));
        keepIndices.add(i);
        keepIndices.add(Math.min(totalDeduped - 1, i + 1));
      }
    }
  }

  let selected = Array.from(keepIndices).sort((a, b) => a - b);
  if (selected.length > maxLines) {
    const prioritized = new Set<number>();
    const headKeep = Math.min(headLines, Math.max(2, Math.floor(maxLines * 0.3)));
    const tailKeep = Math.min(tailLines, Math.max(3, Math.floor(maxLines * 0.4)));

    for (let i = 0; i < Math.min(totalDeduped, headKeep); i++) prioritized.add(i);
    for (let i = Math.max(0, totalDeduped - tailKeep); i < totalDeduped; i++) prioritized.add(i);

    for (const idx of selected) {
      if (prioritized.size >= maxLines) break;
      if (DIAGNOSTIC_LINE_RE.test(dedupedLines[idx]) || SUMMARY_LINE_RE.test(dedupedLines[idx])) {
        prioritized.add(idx);
      }
    }
    for (const idx of selected) {
      if (prioritized.size >= maxLines) break;
      prioritized.add(idx);
    }
    selected = Array.from(prioritized).sort((a, b) => a - b);
  }

  const assembled: string[] = [];
  let prevIdx = -1;
  let omittedLines = 0;

  for (const idx of selected) {
    const gap = idx - prevIdx - 1;
    if (gap > 0) {
      const skippedBytes = dedupedLines
        .slice(prevIdx + 1, idx)
        .reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0);
      assembled.push(`... [omitted ${gap} line(s) (${skippedBytes} bytes)] ...`);
      omittedLines += gap;
    }
    assembled.push(dedupedLines[idx]);
    prevIdx = idx;
  }

  if (prevIdx < totalDeduped - 1) {
    const tailGap = totalDeduped - 1 - prevIdx;
    const skippedBytes = dedupedLines
      .slice(prevIdx + 1)
      .reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0);
    assembled.push(`... [omitted ${tailGap} trailing line(s) (${skippedBytes} bytes)] ...`);
    omittedLines += tailGap;
  }

  // 4. Enforce hard maxBytes ceiling on body and append structured footer
  const body = truncateUtf8BytesHeadTail(assembled.join('\n'), maxBytes);
  const keptRawEstimate =
    omittedLines === 0 &&
    collapsedStackFrames === 0 &&
    collapsedInternalFrames === 0 &&
    ansiSequencesStripped === 0 &&
    Buffer.byteLength(body, 'utf8') >= originalBytes
      ? originalBytes
      : Math.min(originalBytes, Buffer.byteLength(body, 'utf8'));
  const truncatedBytes = Math.max(0, originalBytes - keptRawEstimate);

  const footer = `[exit_code=${exitCode} | elapsed_ms=${elapsedMs} | truncated_bytes=${truncatedBytes}]`;
  const output = `${body}\n${footer}`;
  const outputLines = splitLines(output).length;

  return {
    output,
    body,
    footer,
    exitCode,
    elapsedMs,
    originalBytes,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    truncatedBytes,
    originalLines,
    outputLines,
    ansiSequencesStripped,
    collapsedStackFrames,
    collapsedInternalFrames,
    omittedLines,
    category,
    extractedLocations,
    metrics: buildMetrics(rawString, output, originalLines, outputLines),
  };
}
