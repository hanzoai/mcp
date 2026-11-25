/**
 * Clean-room SWE-agent Agent-Computer Interface (ACI) Primitives (HIP-1348)
 *
 * Reference:
 *   Yang et al., "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering",
 *   NeurIPS 2024 (https://papers.nips.cc/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html).
 *
 * Implements three composable ACI primitives plus an opt-in adapter for `@hanzo/mcp` tools:
 *   1. `viewWindow`                 — Bounded line-numbered file viewer with explicit scroll/jump
 *   2. `lintedEdit`                 — Syntax-linter-gated atomic edit with rollback on syntax error
 *   3. `formatCompactToolResponse`  — Budgeted structured command/search output compressor
 *   4. `AciResponseAdapter`         — Opt-in wrapper for canonical `fs`, `exec`, and `code` tools
 *
 * Zero external runtime dependencies; Node.js built-ins only.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vm from 'vm';
import { Tool, ToolResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// Workspace path safety (symlink-normalized for macOS TMPDIR & Linux parity)
// ---------------------------------------------------------------------------

export interface ResolvedWorkspacePath {
  realRoot: string;
  realTarget: string;
  relativePath: string;
}

/**
 * Canonicalizes a workspace root using `fs.realpathSync` so symlinked temp
 * directories (e.g. macOS `/var/...` -> `/private/var/...`) resolve identically
 * to Linux paths.
 */
export function resolveWorkspaceRoot(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  return fs.realpathSync(abs);
}

/**
 * Resolves a target path against a canonical workspace root and rejects any
 * path traversal or symlink escape outside the workspace boundary.
 */
export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  targetPath: string
): ResolvedWorkspacePath {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('PATH_VIOLATION: target path must be a non-empty string');
  }
  const realRoot = resolveWorkspaceRoot(workspaceRoot);
  const candidate = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(realRoot, targetPath);

  let realTarget: string;
  if (fs.existsSync(candidate)) {
    realTarget = fs.realpathSync(candidate);
  } else {
    const parent = path.dirname(candidate);
    if (!fs.existsSync(parent)) {
      throw new Error(`NOT_FOUND: parent directory does not exist for ${targetPath}`);
    }
    const realParent = fs.realpathSync(parent);
    realTarget = path.join(realParent, path.basename(candidate));
  }

  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `PATH_VIOLATION: target "${targetPath}" resolves outside workspace root`
    );
  }

  const normalizedRel = rel.split(path.sep).join('/') || path.basename(realTarget);
  return {
    realRoot,
    realTarget,
    relativePath: normalizedRel,
  };
}

export function computeFileSha256(content: string | Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

export function estimateAciTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function splitLinesPreservingStructure(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, '\n');
  const raw = normalized.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') {
    raw.pop();
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 1. Windowed Line-Numbered File Viewer (`viewWindow`)
// ---------------------------------------------------------------------------

export type ViewWindowScrollMode = 'jump' | 'center' | 'down' | 'up';

export interface ViewWindowOptions {
  filePath: string;
  workspaceRoot?: string;
  startLine?: number;
  centerLine?: number;
  windowSize?: number;
  scroll?: ViewWindowScrollMode;
  scrollStep?: number;
  anchorPattern?: string;
  maxLineChars?: number;
}

export interface ViewWindowLine {
  lineNumber: number;
  text: string;
}

export interface ViewWindowResult {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  linesAbove: number;
  linesBelow: number;
  windowSize: number;
  sha256: string;
  lines: ViewWindowLine[];
  header: string;
  rendered: string;
  bytes: number;
  estimatedTokens: number;
}

/**
 * Renders a bounded line-numbered window over a workspace file.
 * Emits a concise SWE-agent-style header:
 *   `[File: <rel> | lines X–Y of N, M lines above / K lines below]`
 */
export function viewWindow(options: ViewWindowOptions): ViewWindowResult {
  const windowSize = Math.max(5, Math.min(500, Math.floor(options.windowSize ?? 100)));
  const maxLineChars = Math.max(80, Math.min(4000, Math.floor(options.maxLineChars ?? 400)));

  let realTarget: string;
  let relativePath: string;
  if (options.workspaceRoot) {
    const resolved = resolveSafeWorkspacePath(options.workspaceRoot, options.filePath);
    realTarget = resolved.realTarget;
    relativePath = resolved.relativePath;
  } else {
    realTarget = fs.realpathSync(path.resolve(options.filePath));
    relativePath = path.basename(realTarget);
  }

  const rawBuffer = fs.readFileSync(realTarget);
  const sha256 = computeFileSha256(rawBuffer);
  const allLines = splitLinesPreservingStructure(rawBuffer.toString('utf8'));
  const totalLines = allLines.length;

  if (totalLines === 0) {
    const header = `[File: ${relativePath} | lines 0–0 of 0, 0 lines above / 0 lines below]`;
    const rendered = `${header}\n(empty file)`;
    return {
      filePath: realTarget,
      relativePath,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      linesAbove: 0,
      linesBelow: 0,
      windowSize,
      sha256,
      lines: [],
      header,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
    };
  }

  let targetStart = Math.max(1, Math.floor(options.startLine ?? 1));
  const scrollStep = Math.max(1, Math.floor(options.scrollStep ?? Math.max(1, Math.floor(windowSize * 0.8))));

  if (options.anchorPattern && options.anchorPattern.length > 0) {
    const idx = allLines.findIndex((line) => line.includes(options.anchorPattern!));
    if (idx >= 0) {
      const matchLine = idx + 1;
      targetStart = Math.max(1, matchLine - Math.floor(windowSize / 2));
    }
  } else if (typeof options.centerLine === 'number' && Number.isFinite(options.centerLine)) {
    const center = Math.max(1, Math.min(totalLines, Math.floor(options.centerLine)));
    targetStart = Math.max(1, center - Math.floor(windowSize / 2));
  } else if (options.scroll === 'down') {
    targetStart = targetStart + scrollStep;
  } else if (options.scroll === 'up') {
    targetStart = Math.max(1, targetStart - scrollStep);
  }

  const maxStart = Math.max(1, totalLines - windowSize + 1);
  const startLine = Math.max(1, Math.min(targetStart, maxStart));
  const endLine = Math.min(totalLines, startLine + windowSize - 1);
  const linesAbove = startLine - 1;
  const linesBelow = Math.max(0, totalLines - endLine);

  const width = Math.max(4, String(endLine).length);
  const slice = allLines.slice(startLine - 1, endLine);
  const lines: ViewWindowLine[] = slice.map((rawLine, idx) => {
    const lineNumber = startLine + idx;
    const text =
      rawLine.length > maxLineChars
        ? `${rawLine.slice(0, maxLineChars)} ...[+${rawLine.length - maxLineChars} chars]`
        : rawLine;
    return { lineNumber, text };
  });

  const header = `[File: ${relativePath} | lines ${startLine}–${endLine} of ${totalLines}, ${linesAbove} lines above / ${linesBelow} lines below]`;
  const body = lines
    .map((l) => `${String(l.lineNumber).padStart(width, ' ')} | ${l.text}`)
    .join('\n');
  const footerParts: string[] = [];
  if (linesAbove > 0) footerParts.push(`scroll up for ${linesAbove} earlier lines`);
  if (linesBelow > 0) footerParts.push(`scroll down for ${linesBelow} more lines`);
  const footer =
    footerParts.length > 0 ? `\n[nav: ${footerParts.join('; ')} | sha256:${sha256.slice(7, 19)}]` : '';
  const rendered = `${header}\n${body}${footer}`;

  return {
    filePath: realTarget,
    relativePath,
    startLine,
    endLine,
    totalLines,
    linesAbove,
    linesBelow,
    windowSize,
    sha256,
    lines,
    header,
    rendered,
    bytes: Buffer.byteLength(rendered, 'utf8'),
    estimatedTokens: estimateAciTokens(rendered),
  };
}

/**
 * Lightweight stateful cursor wrapper over `viewWindow` for multi-turn file browsing.
 */
export class StatefulWindowViewer {
  private readonly workspaceRoot: string;
  private readonly defaultWindowSize: number;
  private currentFile: string | null = null;
  private currentStartLine = 1;
  private currentWindowSize: number;

  constructor(workspaceRoot: string, defaultWindowSize = 100) {
    this.workspaceRoot = resolveWorkspaceRoot(workspaceRoot);
    this.defaultWindowSize = Math.max(5, Math.min(500, Math.floor(defaultWindowSize)));
    this.currentWindowSize = this.defaultWindowSize;
  }

  public open(filePath: string, centerOrStartLine = 1, windowSize?: number, centered = false): ViewWindowResult {
    this.currentWindowSize = windowSize ?? this.defaultWindowSize;
    const res = viewWindow({
      workspaceRoot: this.workspaceRoot,
      filePath,
      ...(centered ? { centerLine: centerOrStartLine } : { startLine: centerOrStartLine }),
      windowSize: this.currentWindowSize,
    });
    this.currentFile = res.filePath;
    this.currentStartLine = res.startLine;
    return res;
  }

  public scrollDown(step?: number): ViewWindowResult {
    if (!this.currentFile) throw new Error('No file currently open in viewer');
    const res = viewWindow({
      workspaceRoot: this.workspaceRoot,
      filePath: this.currentFile,
      startLine: this.currentStartLine,
      windowSize: this.currentWindowSize,
      scroll: 'down',
      scrollStep: step,
    });
    this.currentStartLine = res.startLine;
    return res;
  }

  public scrollUp(step?: number): ViewWindowResult {
    if (!this.currentFile) throw new Error('No file currently open in viewer');
    const res = viewWindow({
      workspaceRoot: this.workspaceRoot,
      filePath: this.currentFile,
      startLine: this.currentStartLine,
      windowSize: this.currentWindowSize,
      scroll: 'up',
      scrollStep: step,
    });
    this.currentStartLine = res.startLine;
    return res;
  }

  public jumpToLine(line: number): ViewWindowResult {
    if (!this.currentFile) throw new Error('No file currently open in viewer');
    const res = viewWindow({
      workspaceRoot: this.workspaceRoot,
      filePath: this.currentFile,
      centerLine: line,
      windowSize: this.currentWindowSize,
    });
    this.currentStartLine = res.startLine;
    return res;
  }
}

// ---------------------------------------------------------------------------
// 2. Fast Multi-Language Syntax Linter & Atomic Rollback Edit (`lintedEdit`)
// ---------------------------------------------------------------------------

export type SyntaxLintLanguage = 'typescript' | 'javascript' | 'json' | 'python' | 'generic';

export interface SyntaxLintDiagnostic {
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface SyntaxLintResult {
  ok: boolean;
  language: SyntaxLintLanguage;
  diagnostics: SyntaxLintDiagnostic[];
  durationMs: number;
}

export function detectSyntaxLanguage(filePath: string): SyntaxLintLanguage {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  return 'generic';
}

function offsetToLineCol(content: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(content.length, offset));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < clamped; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: clamped - lastNl };
}

function checkMergeConflictMarkers(content: string, diagnostics: SyntaxLintDiagnostic[]): void {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^(<{7}|={7}|>{7})/.test(lines[i])) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'MERGE_CONFLICT_MARKER',
        message: `Unresolved merge conflict marker "${lines[i].slice(0, 7)}"`,
      });
    }
  }
}

function lintJsonSyntax(content: string): SyntaxLintDiagnostic[] {
  const diagnostics: SyntaxLintDiagnostic[] = [];
  try {
    JSON.parse(content);
  } catch (err: any) {
    const msg = String(err?.message ?? 'Invalid JSON syntax');
    const posMatch = msg.match(/position\s+(\d+)/i);
    const lineColMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColMatch) {
      diagnostics.push({
        line: Number(lineColMatch[1]),
        column: Number(lineColMatch[2]),
        code: 'JSON_SYNTAX_ERROR',
        message: msg,
      });
    } else if (posMatch) {
      const lc = offsetToLineCol(content, Number(posMatch[1]));
      diagnostics.push({
        line: lc.line,
        column: lc.column,
        code: 'JSON_SYNTAX_ERROR',
        message: msg,
      });
    } else {
      diagnostics.push({
        line: 1,
        column: 1,
        code: 'JSON_SYNTAX_ERROR',
        message: msg,
      });
    }
  }
  return diagnostics;
}

interface DelimiterFrame {
  char: '(' | '[' | '{';
  line: number;
  column: number;
  isTemplateExpr?: boolean;
}

const MATCHING_CLOSE: Record<'(' | '[' | '{', ')' | ']' | '}'> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

/**
 * String-, comment-, and template-literal-aware balanced delimiter scanner for
 * JS/TS and generic C-like languages.
 */
function scanJsTsDelimiters(content: string): SyntaxLintDiagnostic[] {
  const diagnostics: SyntaxLintDiagnostic[] = [];
  const stack: DelimiterFrame[] = [];
  // Track template literal nesting depth when inside `${...}`
  let inTemplate = false;
  let templateStartLine = 1;
  let templateStartCol = 1;
  const templateBraceDepths: number[] = [];

  let line = 1;
  let col = 1;
  const n = content.length;

  const isRegexAllowedAfter = (prevNonSpace: string): boolean => {
    return (
      prevNonSpace === '' ||
      '([{:;,=!?&|+-*%^~<>'.includes(prevNonSpace)
    );
  };

  let prevNonSpace = '';

  for (let i = 0; i < n; i++) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : '';

    if (ch === '\n') {
      line++;
      col = 1;
      continue;
    }

    if (inTemplate) {
      if (ch === '\\') {
        i++;
        col += 2;
        continue;
      }
      if (ch === '`') {
        inTemplate = false;
        prevNonSpace = '`';
        col++;
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ char: '{', line, column: col, isTemplateExpr: true });
        templateBraceDepths.push(stack.length);
        inTemplate = false;
        prevNonSpace = '{';
        i++;
        col += 2;
        continue;
      }
      col++;
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      while (i + 1 < n && content[i + 1] !== '\n') {
        i++;
        col++;
      }
      col++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      let closed = false;
      while (i < n) {
        if (content[i] === '\n') {
          line++;
          col = 1;
        } else if (content[i] === '*' && i + 1 < n && content[i + 1] === '/') {
          i++;
          col += 2;
          closed = true;
          break;
        } else {
          col++;
        }
        i++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          column: startCol,
          code: 'UNTERMINATED_COMMENT',
          message: 'Unterminated block comment /* ... */',
        });
        return diagnostics;
      }
      continue;
    }

    // Single or double-quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      let closed = false;
      while (i < n) {
        const c = content[i];
        if (c === '\\') {
          i += 2;
          col += 2;
          continue;
        }
        if (c === '\n') {
          break;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        i++;
        col++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          column: startCol,
          code: 'UNTERMINATED_STRING',
          message: `Unterminated ${quote} string literal`,
        });
        return diagnostics;
      }
      prevNonSpace = quote;
      col++;
      continue;
    }

    // Template literal start
    if (ch === '`') {
      inTemplate = true;
      templateStartLine = line;
      templateStartCol = col;
      col++;
      continue;
    }

    // Regex literal heuristic
    if (ch === '/' && next !== '/' && next !== '*' && isRegexAllowedAfter(prevNonSpace)) {
      let j = i + 1;
      let inClass = false;
      let foundEnd = false;
      while (j < n && content[j] !== '\n') {
        if (content[j] === '\\') {
          j += 2;
          continue;
        }
        if (content[j] === '[') inClass = true;
        else if (content[j] === ']') inClass = false;
        else if (content[j] === '/' && !inClass) {
          foundEnd = true;
          break;
        }
        j++;
      }
      if (foundEnd) {
        col += j - i + 1;
        i = j;
        prevNonSpace = '/';
        continue;
      }
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, line, column: col });
      prevNonSpace = ch;
      col++;
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top) {
        diagnostics.push({
          line,
          column: col,
          code: 'UNMATCHED_CLOSING_DELIMITER',
          message: `Unexpected closing "${ch}" with no matching opening delimiter`,
        });
        return diagnostics;
      }
      const expected = MATCHING_CLOSE[top.char];
      if (expected !== ch) {
        diagnostics.push({
          line,
          column: col,
          code: 'MISMATCHED_DELIMITER',
          message: `Expected "${expected}" to close "${top.char}" opened at line ${top.line}:${top.column}, found "${ch}"`,
        });
        return diagnostics;
      }
      if (
        ch === '}' &&
        top.isTemplateExpr &&
        templateBraceDepths.length > 0 &&
        templateBraceDepths[templateBraceDepths.length - 1] === stack.length + 1
      ) {
        templateBraceDepths.pop();
        inTemplate = true;
      }
      prevNonSpace = ch;
      col++;
      continue;
    }

    if (!/\s/.test(ch)) {
      prevNonSpace = ch;
    }
    col++;
  }

  if (inTemplate) {
    diagnostics.push({
      line: templateStartLine,
      column: templateStartCol,
      code: 'UNTERMINATED_TEMPLATE',
      message: 'Unterminated template literal (`...`)',
    });
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    diagnostics.push({
      line: unclosed.line,
      column: unclosed.column,
      code: 'UNCLOSED_DELIMITER',
      message: `Unclosed "${unclosed.char}" opened at line ${unclosed.line}:${unclosed.column}`,
    });
  }

  return diagnostics;
}

/**
 * Normalizes top-level ESM `import` / `export` lines while preserving exact line
 * count so Node's `vm.Script` can verify real JavaScript grammar without needing
 * `--experimental-vm-modules`.
 */
function neutralizeEsmForVmParse(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let inMultilineImport = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (inMultilineImport) {
        if (/\bfrom\s+['"][^'"]+['"]\s*;?$/.test(trimmed)) {
          inMultilineImport = false;
        }
        return '';
      }
      if (/^import\s+type\b/.test(trimmed)) {
        return '';
      }
      if (/^import\b/.test(trimmed) && !/^import\s*\(/.test(trimmed)) {
        // Check obvious broken import syntax: `import { a from './x'`
        if (trimmed.includes('{') && !trimmed.includes('}') && /\bfrom\b/.test(trimmed)) {
          return line; // keep broken line so vm.Script reports real SyntaxError!
        }
        if (/^import\s+['"][^'"]+['"]\s*;?$/.test(trimmed)) {
          return '';
        }
        if (/\bfrom\s+['"][^'"]+['"]\s*;?$/.test(trimmed)) {
          return '';
        }
        if (trimmed.endsWith('{') || trimmed.endsWith(',')) {
          inMultilineImport = true;
          return '';
        }
        return line;
      }
      if (/^export\s+default\b/.test(trimmed)) {
        return line.replace(/^(\s*)export\s+default\b/, '$1void');
      }
      if (/^export\s+(?:async\s+)?(?:function|class|const|let|var)\b/.test(trimmed)) {
        return line.replace(/^(\s*)export\s+/, '$1');
      }
      if (/^export\s*\{[^}]*\}\s*(?:from\s+['"][^'"]+['"])?\s*;?$/.test(trimmed)) {
        return '';
      }
      if (/^export\s*\*\s*(?:as\s+\w+\s*)?from\s+['"][^'"]+['"]\s*;?$/.test(trimmed)) {
        return '';
      }
      return line;
    })
    .join('\n');
}

function lintJavaScriptSyntax(content: string, filePath: string): SyntaxLintDiagnostic[] {
  const diagnostics = scanJsTsDelimiters(content);
  checkMergeConflictMarkers(content, diagnostics);
  if (diagnostics.length > 0) return diagnostics;

  const parseable = neutralizeEsmForVmParse(content);
  try {
    new vm.Script(parseable, { filename: path.basename(filePath) });
  } catch (err: any) {
    const stack = String(err?.stack ?? '');
    const lineMatch = stack.match(/:(\d+)\n/);
    const line = lineMatch ? Number(lineMatch[1]) : 1;
    diagnostics.push({
      line,
      column: 1,
      code: 'JS_SYNTAX_ERROR',
      message: String(err?.message ?? 'JavaScript syntax error'),
    });
  }
  return diagnostics;
}

function lintTypeScriptSyntax(content: string): SyntaxLintDiagnostic[] {
  const diagnostics = scanJsTsDelimiters(content);
  checkMergeConflictMarkers(content, diagnostics);
  if (diagnostics.length > 0) return diagnostics;

  // Additional fast structural checks for common TS agent edit mistakes
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Broken import missing `from` string or malformed brace
    if (/^import\s+\{[^}]*$/.test(trimmed) && /\bfrom\b/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_BROKEN_IMPORT',
        message: 'Malformed import statement: missing closing "}" before "from"',
      });
    }
    if (/^import\s+.*\bfrom\s*$/.test(trimmed) || /^import\s+.*\bfrom\s*;/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_BROKEN_IMPORT',
        message: 'Malformed import statement: missing module specifier after "from"',
      });
    }
    // Empty condition `if ()` or `while ()`
    if (/\b(?:if|while)\s*\(\s*\)/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_EMPTY_CONDITION',
        message: 'Empty condition expression in control-flow statement',
      });
    }
    // Dangling binary operator right before `;` (e.g. `return a + ;`, `const x = a && ;`)
    if (/(?:[+\-*/%&|^]|&&|\|\||===|!==|==|!=|<=|>=)\s*;/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_DANGLING_OPERATOR',
        message: 'Dangling operator before semicolon',
      });
    }
    // Duplicate declaration keyword (`const const`, `let let`, `return return`)
    if (/\b(const|let|var|function|return)\s+\1\b/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_DUPLICATE_KEYWORD',
        message: 'Duplicate keyword token in statement',
      });
    }
    // Missing operand in assignment (`const x = ;` or `let y = ;`)
    if (/\b(?:const|let|var)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*;/.test(trimmed)) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'TS_MISSING_INITIALIZER',
        message: 'Missing initializer expression after "="',
      });
    }
  }

  return diagnostics;
}

function lintPythonSyntax(content: string): SyntaxLintDiagnostic[] {
  const diagnostics: SyntaxLintDiagnostic[] = [];
  checkMergeConflictMarkers(content, diagnostics);
  if (diagnostics.length > 0) return diagnostics;

  // Pass 1: String & delimiter balance
  const stack: DelimiterFrame[] = [];
  let line = 1;
  let col = 1;
  const n = content.length;
  const openDepthAtLineStart: number[] = [0];

  for (let i = 0; i < n; i++) {
    const ch = content[i];
    if (ch === '\n') {
      line++;
      col = 1;
      openDepthAtLineStart[line - 1] = stack.length;
      continue;
    }
    if (ch === '#') {
      while (i + 1 < n && content[i + 1] !== '\n') {
        i++;
        col++;
      }
      col++;
      continue;
    }
    // Triple-quoted strings
    if (
      (ch === '"' && content[i + 1] === '"' && content[i + 2] === '"') ||
      (ch === "'" && content[i + 1] === "'" && content[i + 2] === "'")
    ) {
      const q = ch;
      const startLine = line;
      const startCol = col;
      i += 3;
      col += 3;
      let closed = false;
      while (i < n) {
        if (content[i] === '\\') {
          i += 2;
          col += 2;
          continue;
        }
        if (content[i] === '\n') {
          line++;
          col = 1;
          openDepthAtLineStart[line - 1] = stack.length;
          i++;
          continue;
        }
        if (content[i] === q && content[i + 1] === q && content[i + 2] === q) {
          i += 2;
          col += 3;
          closed = true;
          break;
        }
        i++;
        col++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          column: startCol,
          code: 'PY_UNTERMINATED_STRING',
          message: `Unterminated triple-quoted string (${q}${q}${q})`,
        });
        return diagnostics;
      }
      continue;
    }
    // Single/double string
    if (ch === "'" || ch === '"') {
      const q = ch;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      let closed = false;
      while (i < n) {
        if (content[i] === '\\') {
          i += 2;
          col += 2;
          continue;
        }
        if (content[i] === '\n') break;
        if (content[i] === q) {
          closed = true;
          break;
        }
        i++;
        col++;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          column: startCol,
          code: 'PY_UNTERMINATED_STRING',
          message: `Unterminated ${q} string literal`,
        });
        return diagnostics;
      }
      col++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, line, column: col });
      col++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top) {
        diagnostics.push({
          line,
          column: col,
          code: 'PY_UNMATCHED_CLOSING',
          message: `Unexpected closing "${ch}"`,
        });
        return diagnostics;
      }
      const expected = MATCHING_CLOSE[top.char];
      if (expected !== ch) {
        diagnostics.push({
          line,
          column: col,
          code: 'PY_MISMATCHED_DELIMITER',
          message: `Expected "${expected}" to close "${top.char}" opened at line ${top.line}, found "${ch}"`,
        });
        return diagnostics;
      }
      col++;
      continue;
    }
    col++;
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    diagnostics.push({
      line: unclosed.line,
      column: unclosed.column,
      code: 'PY_UNCLOSED_DELIMITER',
      message: `Unclosed "${unclosed.char}" opened at line ${unclosed.line}:${unclosed.column}`,
    });
    return diagnostics;
  }

  // Pass 2: Indentation & compound-header colon checks
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const indentStack: number[] = [0];
  let expectIndent = false;
  let expectIndentHeaderLine = 0;

  const stripTrailingComment = (s: string): string => {
    let inS = false;
    let inD = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === '#' && !inS && !inD) return s.slice(0, i);
    }
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if ((openDepthAtLineStart[i] ?? 0) > 0) continue;

    const codePart = stripTrailingComment(rawLine).trimEnd();
    const trimmed = codePart.trim();
    if (!trimmed) continue;

    const leadingWs = rawLine.match(/^([ \t]*)/)?.[1] ?? '';
    if (leadingWs.includes(' ') && leadingWs.includes('\t')) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'PY_MIXED_INDENT',
        message: 'Mixed tabs and spaces in indentation',
      });
      return diagnostics;
    }

    const indent = leadingWs.replace(/\t/g, '    ').length;
    const currentIndent = indentStack[indentStack.length - 1];

    if (expectIndent) {
      if (indent <= currentIndent) {
        diagnostics.push({
          line: i + 1,
          column: 1,
          code: 'PY_EXPECTED_INDENT',
          message: `Expected an indented block after compound header on line ${expectIndentHeaderLine}`,
        });
        return diagnostics;
      }
      indentStack.push(indent);
      expectIndent = false;
    } else if (indent > currentIndent) {
      diagnostics.push({
        line: i + 1,
        column: 1,
        code: 'PY_UNEXPECTED_INDENT',
        message: `Unexpected indentation (got ${indent} spaces, expected ${currentIndent})`,
      });
      return diagnostics;
    } else if (indent < currentIndent) {
      while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
        indentStack.pop();
      }
      if (indentStack[indentStack.length - 1] !== indent) {
        diagnostics.push({
          line: i + 1,
          column: 1,
          code: 'PY_DEDENT_MISMATCH',
          message: `Unindent does not match any outer indentation level (got ${indent} spaces)`,
        });
        return diagnostics;
      }
    }

    // Check compound statement headers missing trailing `:`
    const isCompoundStart =
      /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(trimmed);
    const hasOpenParen =
      (trimmed.match(/\(/g)?.length ?? 0) > (trimmed.match(/\)/g)?.length ?? 0);

    if (isCompoundStart && !hasOpenParen) {
      // Allow single-line suites like `if x: return 1`
      if (!trimmed.includes(':')) {
        diagnostics.push({
          line: i + 1,
          column: Math.max(1, codePart.length),
          code: 'PY_MISSING_COLON',
          message: `Compound statement "${trimmed.split(/\s+/)[0]}" is missing trailing ":"`,
        });
        return diagnostics;
      }
    }

    if (trimmed.endsWith(':') && isCompoundStart) {
      expectIndent = true;
      expectIndentHeaderLine = i + 1;
    }
  }

  if (expectIndent) {
    diagnostics.push({
      line: expectIndentHeaderLine,
      column: 1,
      code: 'PY_EXPECTED_INDENT',
      message: `Expected an indented block after line ${expectIndentHeaderLine}`,
    });
  }

  return diagnostics;
}

/**
 * Fast, zero-dependency syntax/structural linter for JSON, JS, TS, Python, and
 * generic bracketed files. Runs in sub-millisecond to low-millisecond time.
 */
export function runFastSyntaxLint(
  content: string,
  filePath: string,
  language?: SyntaxLintLanguage
): SyntaxLintResult {
  const t0 = performance.now();
  const lang = language ?? detectSyntaxLanguage(filePath);
  let diagnostics: SyntaxLintDiagnostic[];

  switch (lang) {
    case 'json':
      diagnostics = lintJsonSyntax(content);
      break;
    case 'javascript':
      diagnostics = lintJavaScriptSyntax(content, filePath);
      break;
    case 'typescript':
      diagnostics = lintTypeScriptSyntax(content);
      break;
    case 'python':
      diagnostics = lintPythonSyntax(content);
      break;
    default:
      diagnostics = scanJsTsDelimiters(content);
      checkMergeConflictMarkers(content, diagnostics);
      break;
  }

  return {
    ok: diagnostics.length === 0,
    language: lang,
    diagnostics,
    durationMs: Number((performance.now() - t0).toFixed(3)),
  };
}

export interface LintedEditOptions {
  filePath: string;
  workspaceRoot?: string;
  /** Exact-anchor replacement mode */
  oldText?: string;
  newText?: string;
  expectedLine?: number;
  /** Bounded line-range replacement mode (1-based inclusive) */
  startLine?: number;
  endLine?: number;
  replacement?: string;
  /** Optional optimistic concurrency guard */
  expectedSha256?: string;
  /** Localized post-edit context lines (default 4) */
  contextLines?: number;
  language?: SyntaxLintLanguage;
  /** Disable syntax lint gate (for matched ablation baselines only) */
  skipSyntaxLint?: boolean;
}

export type LintedEditErrorCode =
  | 'PATH_VIOLATION'
  | 'NOT_FOUND'
  | 'SHA_MISMATCH'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_AMBIGUOUS'
  | 'INVALID_RANGE'
  | 'SYNTAX_LINT_FAILED'
  | 'IO_ERROR';

export interface LintedEditResult {
  ok: boolean;
  applied: boolean;
  rolledBack: boolean;
  filePath: string;
  relativePath: string;
  errorCode?: LintedEditErrorCode;
  originalSha256: string;
  afterSha256: string;
  editedRange?: { startLine: number; endLine: number };
  diagnostics: SyntaxLintDiagnostic[];
  actionableHint?: string;
  snippet: string;
  rendered: string;
  bytes: number;
  estimatedTokens: number;
  lintDurationMs: number;
}

function renderLocalSnippet(
  relativePath: string,
  content: string,
  startLine: number,
  endLine: number,
  contextLines: number
): string {
  const lines = splitLinesPreservingStructure(content);
  const total = lines.length;
  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(total, endLine + contextLines);
  const width = Math.max(4, String(to).length);
  const body = lines
    .slice(from - 1, to)
    .map((text, idx) => {
      const ln = from + idx;
      const marker = ln >= startLine && ln <= endLine ? '>' : ' ';
      return `${marker}${String(ln).padStart(width, ' ')} | ${text}`;
    })
    .join('\n');
  return `[Edited: ${relativePath} | lines ${startLine}–${endLine} (showing ${from}–${to} of ${total})]\n${body}`;
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpName = `.${base}.aci-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Applies a bounded line-range or exact-anchor edit on a workspace file, gated
 * by `runFastSyntaxLint`. If syntax linting fails, the edit is atomically rolled
 * back so the original file's exact bytes and SHA-256 remain untouched on disk.
 */
export function lintedEdit(options: LintedEditOptions): LintedEditResult {
  const contextLines = Math.max(0, Math.min(20, Math.floor(options.contextLines ?? 4)));

  let realTarget: string;
  let relativePath: string;
  try {
    if (options.workspaceRoot) {
      const resolved = resolveSafeWorkspacePath(options.workspaceRoot, options.filePath);
      realTarget = resolved.realTarget;
      relativePath = resolved.relativePath;
    } else {
      realTarget = fs.realpathSync(path.resolve(options.filePath));
      relativePath = path.basename(realTarget);
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const code: LintedEditErrorCode = msg.startsWith('NOT_FOUND') ? 'NOT_FOUND' : 'PATH_VIOLATION';
    const rendered = `[EDIT REJECTED: ${code}] ${msg}`;
    return {
      ok: false,
      applied: false,
      rolledBack: false,
      filePath: options.filePath,
      relativePath: options.filePath,
      errorCode: code,
      originalSha256: '',
      afterSha256: '',
      diagnostics: [],
      actionableHint: 'Ensure filePath exists inside workspaceRoot.',
      snippet: rendered,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
      lintDurationMs: 0,
    };
  }

  if (!fs.existsSync(realTarget)) {
    const rendered = `[EDIT REJECTED: NOT_FOUND] File not found: ${relativePath}`;
    return {
      ok: false,
      applied: false,
      rolledBack: false,
      filePath: realTarget,
      relativePath,
      errorCode: 'NOT_FOUND',
      originalSha256: '',
      afterSha256: '',
      diagnostics: [],
      actionableHint: 'Verify file path via viewWindow or directory listing.',
      snippet: rendered,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
      lintDurationMs: 0,
    };
  }

  const originalRaw = fs.readFileSync(realTarget, 'utf8');
  const originalSha256 = computeFileSha256(originalRaw);

  if (options.expectedSha256 && options.expectedSha256 !== originalSha256) {
    const rendered = `[EDIT REJECTED: SHA_MISMATCH] ${relativePath} changed on disk (expected ${options.expectedSha256.slice(0, 19)}, found ${originalSha256.slice(0, 19)}). Re-read with viewWindow before retrying.`;
    return {
      ok: false,
      applied: false,
      rolledBack: false,
      filePath: realTarget,
      relativePath,
      errorCode: 'SHA_MISMATCH',
      originalSha256,
      afterSha256: originalSha256,
      diagnostics: [],
      actionableHint: `Call viewWindow({ filePath: "${relativePath}" }) to refresh content hash.`,
      snippet: rendered,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
      lintDurationMs: 0,
    };
  }

  let candidate = originalRaw;
  let editStartLine = 1;
  let editEndLine = 1;

  const hasAnchorMode = typeof options.oldText === 'string' && typeof options.newText === 'string';
  const hasRangeMode =
    typeof options.startLine === 'number' &&
    typeof options.endLine === 'number' &&
    typeof options.replacement === 'string';

  if (hasAnchorMode) {
    const oldText = options.oldText!;
    const newText = options.newText!;
    if (oldText.length === 0) {
      const rendered = `[EDIT REJECTED: ANCHOR_NOT_FOUND] oldText must be non-empty.`;
      return {
        ok: false,
        applied: false,
        rolledBack: false,
        filePath: realTarget,
        relativePath,
        errorCode: 'ANCHOR_NOT_FOUND',
        originalSha256,
        afterSha256: originalSha256,
        diagnostics: [],
        actionableHint: 'Provide an exact non-empty oldText block from viewWindow.',
        snippet: rendered,
        rendered,
        bytes: Buffer.byteLength(rendered, 'utf8'),
        estimatedTokens: estimateAciTokens(rendered),
        lintDurationMs: 0,
      };
    }

    const matchOffsets: number[] = [];
    let searchFrom = 0;
    while (searchFrom <= originalRaw.length) {
      const found = originalRaw.indexOf(oldText, searchFrom);
      if (found === -1) break;
      matchOffsets.push(found);
      searchFrom = found + Math.max(1, oldText.length);
    }

    if (matchOffsets.length === 0) {
      const rendered = `[EDIT REJECTED: ANCHOR_NOT_FOUND] Exact oldText block not found in ${relativePath}.`;
      return {
        ok: false,
        applied: false,
        rolledBack: false,
        filePath: realTarget,
        relativePath,
        errorCode: 'ANCHOR_NOT_FOUND',
        originalSha256,
        afterSha256: originalSha256,
        diagnostics: [],
        actionableHint: `Inspect exact lines with viewWindow({ filePath: "${relativePath}" }).`,
        snippet: rendered,
        rendered,
        bytes: Buffer.byteLength(rendered, 'utf8'),
        estimatedTokens: estimateAciTokens(rendered),
        lintDurationMs: 0,
      };
    }

    let chosenOffset = matchOffsets[0];
    if (matchOffsets.length > 1) {
      if (typeof options.expectedLine === 'number') {
        const ranked = matchOffsets
          .map((off) => ({ off, line: offsetToLineCol(originalRaw, off).line }))
          .sort(
            (a, b) =>
              Math.abs(a.line - options.expectedLine!) - Math.abs(b.line - options.expectedLine!)
          );
        if (
          ranked.length >= 2 &&
          Math.abs(ranked[0].line - options.expectedLine) ===
            Math.abs(ranked[1].line - options.expectedLine)
        ) {
          const linesList = ranked.map((r) => r.line).join(', ');
          const rendered = `[EDIT REJECTED: ANCHOR_AMBIGUOUS] oldText matched ${matchOffsets.length} locations in ${relativePath} (lines ${linesList}). Include more surrounding context.`;
          return {
            ok: false,
            applied: false,
            rolledBack: false,
            filePath: realTarget,
            relativePath,
            errorCode: 'ANCHOR_AMBIGUOUS',
            originalSha256,
            afterSha256: originalSha256,
            diagnostics: [],
            actionableHint: 'Expand oldText with unique surrounding lines or specify exact expectedLine.',
            snippet: rendered,
            rendered,
            bytes: Buffer.byteLength(rendered, 'utf8'),
            estimatedTokens: estimateAciTokens(rendered),
            lintDurationMs: 0,
          };
        }
        chosenOffset = ranked[0].off;
      } else {
        const linesList = matchOffsets.map((off) => offsetToLineCol(originalRaw, off).line).join(', ');
        const rendered = `[EDIT REJECTED: ANCHOR_AMBIGUOUS] oldText matched ${matchOffsets.length} locations in ${relativePath} (lines ${linesList}). Provide expectedLine or unique context.`;
        return {
          ok: false,
          applied: false,
          rolledBack: false,
          filePath: realTarget,
          relativePath,
          errorCode: 'ANCHOR_AMBIGUOUS',
          originalSha256,
          afterSha256: originalSha256,
          diagnostics: [],
          actionableHint: `Pass expectedLine (${matchOffsets.map((o) => offsetToLineCol(originalRaw, o).line).join(' or ')}) or add surrounding lines.`,
          snippet: rendered,
          rendered,
          bytes: Buffer.byteLength(rendered, 'utf8'),
          estimatedTokens: estimateAciTokens(rendered),
          lintDurationMs: 0,
        };
      }
    }

    candidate =
      originalRaw.slice(0, chosenOffset) +
      newText +
      originalRaw.slice(chosenOffset + oldText.length);
    editStartLine = offsetToLineCol(originalRaw, chosenOffset).line;
    const newLineCount = Math.max(1, newText.split('\n').length);
    editEndLine = editStartLine + newLineCount - 1;
  } else if (hasRangeMode) {
    const trailingNewline = originalRaw.endsWith('\n');
    const lines = splitLinesPreservingStructure(originalRaw);
    const startLine = Math.floor(options.startLine!);
    const endLine = Math.floor(options.endLine!);
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      const rendered = `[EDIT REJECTED: INVALID_RANGE] Requested lines ${startLine}–${endLine} out of bounds (file has ${lines.length} lines).`;
      return {
        ok: false,
        applied: false,
        rolledBack: false,
        filePath: realTarget,
        relativePath,
        errorCode: 'INVALID_RANGE',
        originalSha256,
        afterSha256: originalSha256,
        diagnostics: [],
        actionableHint: `Choose 1 <= startLine <= endLine <= ${lines.length}.`,
        snippet: rendered,
        rendered,
        bytes: Buffer.byteLength(rendered, 'utf8'),
        estimatedTokens: estimateAciTokens(rendered),
        lintDurationMs: 0,
      };
    }
    const replacementLines = options.replacement!.replace(/\r\n/g, '\n').split('\n');
    const nextLines = [
      ...lines.slice(0, startLine - 1),
      ...replacementLines,
      ...lines.slice(endLine),
    ];
    candidate = nextLines.join('\n') + (trailingNewline ? '\n' : '');
    editStartLine = startLine;
    editEndLine = startLine + replacementLines.length - 1;
  } else {
    const rendered = `[EDIT REJECTED: INVALID_RANGE] Provide either (oldText, newText) or (startLine, endLine, replacement).`;
    return {
      ok: false,
      applied: false,
      rolledBack: false,
      filePath: realTarget,
      relativePath,
      errorCode: 'INVALID_RANGE',
      originalSha256,
      afterSha256: originalSha256,
      diagnostics: [],
      actionableHint: 'Specify oldText/newText or startLine/endLine/replacement.',
      snippet: rendered,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
      lintDurationMs: 0,
    };
  }

  // Gate on fast syntax lint BEFORE touching disk (atomic rollback semantics)
  let lintDurationMs = 0;
  if (!options.skipSyntaxLint) {
    const lint = runFastSyntaxLint(candidate, realTarget, options.language);
    lintDurationMs = lint.durationMs;
    if (!lint.ok) {
      const first = lint.diagnostics[0];
      const diagLines = lint.diagnostics
        .slice(0, 4)
        .map((d) => `  - ${relativePath}:${d.line}:${d.column} [${d.code}] ${d.message}`)
        .join('\n');
      const hint = `Fix syntax error at ${relativePath}:${first.line}:${first.column} (${first.code}) and retry lintedEdit. Original file was preserved unchanged.`;
      const rendered = `[EDIT ROLLED BACK: SYNTAX_LINT_FAILED (${lint.language})]\n${diagLines}\n[hint: ${hint}]`;
      const verifiedAfter = computeFileSha256(fs.readFileSync(realTarget, 'utf8'));
      return {
        ok: false,
        applied: false,
        rolledBack: true,
        filePath: realTarget,
        relativePath,
        errorCode: 'SYNTAX_LINT_FAILED',
        originalSha256,
        afterSha256: verifiedAfter,
        editedRange: { startLine: editStartLine, endLine: editEndLine },
        diagnostics: lint.diagnostics,
        actionableHint: hint,
        snippet: rendered,
        rendered,
        bytes: Buffer.byteLength(rendered, 'utf8'),
        estimatedTokens: estimateAciTokens(rendered),
        lintDurationMs,
      };
    }
  }

  // Atomic commit via sibling temp file + rename
  try {
    atomicWriteFileSync(realTarget, candidate);
  } catch (err: any) {
    // Ensure original content remains intact
    try {
      const current = fs.readFileSync(realTarget, 'utf8');
      if (computeFileSha256(current) !== originalSha256) {
        atomicWriteFileSync(realTarget, originalRaw);
      }
    } catch {
      // Best-effort restore
    }
    const verifiedAfter = computeFileSha256(fs.readFileSync(realTarget, 'utf8'));
    const rendered = `[EDIT ROLLED BACK: IO_ERROR] ${String(err?.message ?? err)}`;
    return {
      ok: false,
      applied: false,
      rolledBack: true,
      filePath: realTarget,
      relativePath,
      errorCode: 'IO_ERROR',
      originalSha256,
      afterSha256: verifiedAfter,
      diagnostics: [],
      actionableHint: 'Check filesystem permissions and retry.',
      snippet: rendered,
      rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimatedTokens: estimateAciTokens(rendered),
      lintDurationMs,
    };
  }

  const afterSha256 = computeFileSha256(candidate);
  const snippet = renderLocalSnippet(relativePath, candidate, editStartLine, editEndLine, contextLines);
  const rendered = `${snippet}\n[ok | lint:pass (${lintDurationMs}ms) | sha256:${afterSha256.slice(7, 19)}]`;

  return {
    ok: true,
    applied: true,
    rolledBack: false,
    filePath: realTarget,
    relativePath,
    originalSha256,
    afterSha256,
    editedRange: { startLine: editStartLine, endLine: editEndLine },
    diagnostics: [],
    snippet,
    rendered,
    bytes: Buffer.byteLength(rendered, 'utf8'),
    estimatedTokens: estimateAciTokens(rendered),
    lintDurationMs,
  };
}

// ---------------------------------------------------------------------------
// 3. Structured Compact Command Response Formatter (`formatCompactToolResponse`)
// ---------------------------------------------------------------------------

export type CompactResponseStatus = 'ok' | 'error' | 'timeout';

export interface CompactResponseMatch {
  file?: string;
  line?: number;
  column?: number;
  preview: string;
}

export interface CompactFirstError {
  file?: string;
  line?: number;
  column?: number;
  symbol?: string;
  category: string;
  message: string;
  excerpt: string[];
}

export interface FormatCompactResponseOptions {
  rawOutput: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  command?: string;
  toolName?: string;
  maxBytes?: number;
  maxTokens?: number;
  maxMatches?: number;
  workspaceRoot?: string;
}

export interface CompactToolResponseEnvelope {
  status: CompactResponseStatus;
  exitCode: number;
  summary: string;
  topMatches: CompactResponseMatch[];
  firstError: CompactFirstError | null;
  truncatedLines: number;
  nextActionHint: string;
  rawBytes: number;
  compactBytes: number;
  rawEstimatedTokens: number;
  compactEstimatedTokens: number;
  compressionRatio: number;
  rendered: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI_OSC_RE = /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~])/g;

function cleanTerminalText(raw: string): string {
  const noAnsi = raw.replace(ANSI_CSI_OSC_RE, '');
  const lines = noAnsi.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r').filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  });
  return lines.join('\n');
}

function normalizePathRelative(rawPath: string, workspaceRoot?: string): string {
  const cleaned = rawPath.replace(/^file:\/\//, '').trim();
  if (!workspaceRoot) return cleaned;
  try {
    const realRoot = resolveWorkspaceRoot(workspaceRoot);
    const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(realRoot, cleaned);
    const rel = path.relative(realRoot, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  } catch {
    // Fall back to cleaned path
  }
  return cleaned;
}

function extractFirstError(
  lines: string[],
  exitCode: number,
  workspaceRoot?: string
): CompactFirstError | null {
  if (exitCode === 0) return null;

  // 1. Python traceback: `File "...", line N, in <symbol>` followed by Error line
  for (let i = 0; i < lines.length; i++) {
    const pyMatch = lines[i].match(/File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/);
    if (pyMatch) {
      // Find the innermost workspace frame (skip test harness if module frame exists below)
      let bestFile = normalizePathRelative(pyMatch[1], workspaceRoot);
      let bestLine = Number(pyMatch[2]);
      let bestSymbol = pyMatch[3];
      let errorLine = '';
      let errorIdx = i;
      for (let j = i; j < Math.min(lines.length, i + 25); j++) {
        const inner = lines[j].match(/File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/);
        if (inner) {
          const norm = normalizePathRelative(inner[1], workspaceRoot);
          if (!norm.includes('test_') || bestFile.includes('test_')) {
            bestFile = norm;
            bestLine = Number(inner[2]);
            bestSymbol = inner[3];
          }
        }
        if (/^(?:[A-Za-z]*Error|AssertionError|Exception):/.test(lines[j].trim())) {
          errorLine = lines[j].trim();
          errorIdx = j;
          break;
        }
      }
      const category = errorLine.split(':')[0] || 'PythonError';
      const excerpt = lines
        .slice(Math.max(0, errorIdx - 2), Math.min(lines.length, errorIdx + 2))
        .map((l) => l.trim())
        .filter(Boolean);
      return {
        file: bestFile,
        line: bestLine,
        symbol: bestSymbol,
        category,
        message: errorLine || lines[i].trim(),
        excerpt,
      };
    }
  }

  // 2. Explicit structured failure marker: `FAIL <file>:<line> [<symbol>] <msg>` or `ERROR <file>:<line>:<col> <msg>`
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /(?:FAIL|ERROR|BUG|SyntaxError|AssertionError|TypeError|ReferenceError)[^/\n]*?\s+([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|js|mjs|cjs|py|json)):(\d+)(?::(\d+))?(?:\s+\[([A-Za-z0-9_$.]+)\])?(?:\s*[-:]\s*(.*))?/
    );
    if (m) {
      const file = normalizePathRelative(m[1], workspaceRoot);
      const line = Number(m[2]);
      const column = m[3] ? Number(m[3]) : undefined;
      const symbol = m[4];
      const msg = (m[5] || lines[i]).trim();
      const excerpt = lines
        .slice(Math.max(0, i - 1), Math.min(lines.length, i + 3))
        .map((l) => l.trim())
        .filter(Boolean);
      const category =
        lines[i].match(/\b(SyntaxError|AssertionError|TypeError|ReferenceError|RangeError|JSONError)\b/)?.[1] ||
        'TestFailure';
      return { file, line, column, symbol, category, message: msg, excerpt };
    }
  }

  // 3. Node / V8 stack trace or compiler diagnostic: `at symbol (path:line:col)` or `path:line:col`
  let errorHeader = '';
  let errorHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\b(SyntaxError|AssertionError|TypeError|ReferenceError|RangeError|Error):/.test(lines[i])) {
      errorHeader = lines[i].trim();
      errorHeaderIdx = i;
      break;
    }
  }

  for (let i = Math.max(0, errorHeaderIdx); i < lines.length; i++) {
    const stackMatch = lines[i].match(
      /at\s+(?:([A-Za-z0-9_$.]+)\s+\()?((?:file:\/\/)?[^():\s]+\.(?:ts|tsx|mts|js|mjs|cjs|json)):(\d+):(\d+)\)?/
    );
    if (stackMatch && !stackMatch[2].includes('node:internal')) {
      const file = normalizePathRelative(stackMatch[2], workspaceRoot);
      const line = Number(stackMatch[3]);
      const column = Number(stackMatch[4]);
      const symbol = stackMatch[1];
      const category = errorHeader.split(':')[0] || 'RuntimeError';
      const excerpt = [errorHeader, lines[i].trim()].filter(Boolean);
      return {
        file,
        line,
        column,
        symbol,
        category,
        message: errorHeader || lines[i].trim(),
        excerpt,
      };
    }
  }

  // 4. Generic `file.ext:line[:col]` match anywhere in failure output
  for (let i = lines.length - 1; i >= 0; i--) {
    const locMatch = lines[i].match(
      /([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|js|mjs|cjs|py|json)):(\d+)(?::(\d+))?/
    );
    if (locMatch) {
      const file = normalizePathRelative(locMatch[1], workspaceRoot);
      return {
        file,
        line: Number(locMatch[2]),
        column: locMatch[3] ? Number(locMatch[3]) : undefined,
        category: errorHeader ? errorHeader.split(':')[0] : 'CommandError',
        message: errorHeader || lines[i].trim(),
        excerpt: [lines[i].trim()],
      };
    }
  }

  const fallback =
    errorHeader ||
    lines.filter((l) => l.trim().length > 0).slice(-2).join(' | ') ||
    `Command exited with code ${exitCode}`;
  return {
    category: 'CommandError',
    message: fallback.slice(0, 240),
    excerpt: [fallback.slice(0, 240)],
  };
}

function extractTopMatches(
  lines: string[],
  maxMatches: number,
  workspaceRoot?: string
): CompactResponseMatch[] {
  const matches: CompactResponseMatch[] = [];
  const seen = new Set<string>();
  const locRe = /^([^:\s][^:]*\.(?:ts|tsx|mts|js|mjs|cjs|py|json|md)):(\d+)(?::(\d+))?:\s*(.*)$/;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const m = trimmed.match(locRe);
    if (!m) continue;
    const file = normalizePathRelative(m[1], workspaceRoot);
    const line = Number(m[2]);
    const column = m[3] ? Number(m[3]) : undefined;
    const preview = m[4].trim().slice(0, 140);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ file, line, column, preview });
    if (matches.length >= maxMatches) break;
  }
  return matches;
}

/**
 * Collapses noisy test, build, compiler, or grep output into a strict-budget
 * structured SWE-agent response envelope preserving exact error file/line/symbol
 * anchors and actionable next-step hints.
 */
export function formatCompactToolResponse(
  options: FormatCompactResponseOptions
): CompactToolResponseEnvelope {
  const exitCode = options.timedOut ? 124 : (options.exitCode ?? 0);
  const status: CompactResponseStatus = options.timedOut
    ? 'timeout'
    : exitCode === 0
      ? 'ok'
      : 'error';
  const maxBytes = Math.max(200, Math.floor(options.maxBytes ?? 1800));
  const maxTokens = Math.max(50, Math.floor(options.maxTokens ?? 450));
  const maxMatches = Math.max(1, Math.min(25, Math.floor(options.maxMatches ?? 8)));

  const combinedRaw = options.stderr
    ? `${options.rawOutput}\n${options.stderr}`
    : options.rawOutput;
  const rawBytes = Buffer.byteLength(combinedRaw, 'utf8');
  const rawEstimatedTokens = estimateAciTokens(combinedRaw);

  const cleaned = cleanTerminalText(combinedRaw);
  const allLines = cleaned.split('\n');
  const nonEmptyLines = allLines.filter((l) => l.trim().length > 0);

  // Deduplicate consecutive identical noisy lines
  const dedupedLines: string[] = [];
  let collapsedDuplicates = 0;
  for (const line of nonEmptyLines) {
    if (dedupedLines.length > 0 && dedupedLines[dedupedLines.length - 1] === line) {
      collapsedDuplicates++;
      continue;
    }
    dedupedLines.push(line);
  }

  const firstError = extractFirstError(dedupedLines, exitCode, options.workspaceRoot);
  const topMatches = extractTopMatches(dedupedLines, maxMatches, options.workspaceRoot);

  // Detect summary counters if present (e.g., "Tests: 14 passed, 1 failed")
  const summaryLine =
    [...dedupedLines]
      .reverse()
      .find((l) =>
        /\b(?:passed|failed|PASS|FAIL|tests?|errors?|matches?)\b/i.test(l) &&
        l.length <= 180
      ) ?? '';

  let summary: string;
  if (status === 'timeout') {
    summary = `Command timed out (exit=${exitCode}); ${dedupedLines.length} output lines captured.`;
  } else if (status === 'ok') {
    if (summaryLine) {
      summary = summaryLine.trim();
    } else if (topMatches.length > 0) {
      summary = `Found ${topMatches.length} match(es) across ${dedupedLines.length} lines.`;
    } else {
      summary = `Succeeded (exit=0, ${dedupedLines.length} lines).`;
    }
  } else if (firstError) {
    const loc = firstError.file
      ? `${firstError.file}${firstError.line ? `:${firstError.line}` : ''}`
      : 'unknown location';
    const sym = firstError.symbol ? ` [${firstError.symbol}]` : '';
    summary = `${firstError.category} at ${loc}${sym}: ${firstError.message.slice(0, 140)}`;
  } else {
    summary = summaryLine || `Command failed with exit code ${exitCode}.`;
  }

  let nextActionHint: string;
  if (status === 'ok') {
    nextActionHint =
      topMatches.length > 0 && topMatches[0].file && topMatches[0].line
        ? `Inspect match via viewWindow({ filePath: "${topMatches[0].file}", centerLine: ${topMatches[0].line} }).`
        : 'Verification passed; no further action required.';
  } else if (firstError?.file && firstError.line) {
    nextActionHint = `Open viewWindow({ filePath: "${firstError.file}", centerLine: ${firstError.line} }) then apply lintedEdit.`;
  } else if (firstError?.file) {
    nextActionHint = `Open viewWindow({ filePath: "${firstError.file}", startLine: 1 }) to inspect failure.`;
  } else {
    nextActionHint = 'Inspect failing test or re-run with targeted filter.';
  }

  const keptLinesCount =
    (firstError ? firstError.excerpt.length : 0) + topMatches.length + (summary ? 1 : 0);
  const truncatedLines = Math.max(0, allLines.length - keptLinesCount) + collapsedDuplicates;

  // Build compact structured text within strict byte & token budget
  const sections: string[] = [
    `[ACI_RESPONSE status=${status} exit=${exitCode} truncated_lines=${truncatedLines}]`,
    `summary: ${summary}`,
  ];

  if (firstError) {
    const loc = firstError.file
      ? `${firstError.file}${firstError.line ? `:${firstError.line}` : ''}${firstError.column ? `:${firstError.column}` : ''}`
      : 'n/a';
    sections.push(
      `first_error: file=${loc}${firstError.symbol ? ` symbol=${firstError.symbol}` : ''} category=${firstError.category}`
    );
    sections.push(`error_msg: ${firstError.message.slice(0, 220)}`);
    if (firstError.excerpt.length > 0) {
      sections.push(`excerpt:\n${firstError.excerpt.slice(0, 4).map((l) => `  ${l.slice(0, 180)}`).join('\n')}`);
    }
  }

  if (topMatches.length > 0) {
    sections.push(
      `top_matches:\n${topMatches
        .map((m) => `  ${m.file ?? ''}:${m.line ?? 0}: ${m.preview}`)
        .join('\n')}`
    );
  } else if (status === 'ok' && dedupedLines.length > 0 && dedupedLines.length <= 8) {
    sections.push(`output:\n${dedupedLines.map((l) => `  ${l.slice(0, 180)}`).join('\n')}`);
  }

  sections.push(`next_action: ${nextActionHint}`);

  let rendered = sections.join('\n');
  const effectiveByteCap = Math.min(maxBytes, maxTokens * 4);
  if (Buffer.byteLength(rendered, 'utf8') > effectiveByteCap) {
    // Preserve header + summary + first_error + next_action strictly within budget
    const essential: string[] = [
      `[ACI_RESPONSE status=${status} exit=${exitCode} truncated_lines=${truncatedLines}]`,
      `summary: ${summary.slice(0, 160)}`,
    ];
    if (firstError) {
      const loc = firstError.file
        ? `${firstError.file}${firstError.line ? `:${firstError.line}` : ''}`
        : 'n/a';
      essential.push(
        `first_error: file=${loc}${firstError.symbol ? ` symbol=${firstError.symbol}` : ''} msg=${firstError.message.slice(0, 140)}`
      );
    }
    essential.push(`next_action: ${nextActionHint.slice(0, 140)}`);
    rendered = essential.join('\n');
    if (Buffer.byteLength(rendered, 'utf8') > effectiveByteCap) {
      rendered = rendered.slice(0, Math.max(80, effectiveByteCap - 3)) + '...';
    }
  }

  const compactBytes = Buffer.byteLength(rendered, 'utf8');
  const compactEstimatedTokens = estimateAciTokens(rendered);
  const compressionRatio = rawBytes > 0 ? Number((compactBytes / rawBytes).toFixed(4)) : 1;

  return {
    status,
    exitCode,
    summary,
    topMatches,
    firstError,
    truncatedLines,
    nextActionHint,
    rawBytes,
    compactBytes,
    rawEstimatedTokens,
    compactEstimatedTokens,
    compressionRatio,
    rendered,
  };
}

// ---------------------------------------------------------------------------
// 4. Opt-in `AciResponseAdapter` for canonical `@hanzo/mcp` tools (`fs`, `exec`, `code`)
// ---------------------------------------------------------------------------

export type AciAdapterMode =
  | 'raw_unbounded_cli'
  | 'naive_head_truncation'
  | 'windowed_viewer_only'
  | 'swe_agent_aci_full'
  | 'over_compressed_negative';

export interface AciResponseAdapterOptions {
  workspaceRoot: string;
  mode?: AciAdapterMode;
  windowSize?: number;
  contextLines?: number;
  maxResponseBytes?: number;
  maxResponseTokens?: number;
  naiveHeadMaxChars?: number;
  overCompressedMaxChars?: number;
}

export interface AciToolResultLike {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; uri?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface AciServerInvoker {
  callTool(toolName: string, args?: Record<string, unknown>): Promise<AciToolResultLike>;
}

function extractTextFromToolResult(res: AciToolResultLike): string {
  return res.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

function parseJsonSafe(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripAnchorsForOverCompression(text: string, maxChars: number): string {
  // Intentionally destructive negative control: removes file paths, line numbers,
  // and collapses output to a tiny summary string.
  const stripped = text
    .replace(/[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|js|mjs|cjs|py|json)(?::\d+(?::\d+)?)?/g, '<file>')
    .replace(/\bline\s+\d+\b/gi, 'line ?')
    .replace(/^\s*\d+\s*[|│]/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, Math.max(16, maxChars - 3)) + '...';
}

/**
 * Opt-in adapter that wraps `@hanzo/mcp` tools (`fs`, `exec`, `code`) without
 * changing the canonical 19-tool HIP-0300 tool names or input schemas.
 */
export class AciResponseAdapter {
  public readonly workspaceRoot: string;
  public readonly mode: AciAdapterMode;
  private readonly windowSize: number;
  private readonly contextLines: number;
  private readonly maxResponseBytes: number;
  private readonly maxResponseTokens: number;
  private readonly naiveHeadMaxChars: number;
  private readonly overCompressedMaxChars: number;

  constructor(options: AciResponseAdapterOptions) {
    this.workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
    this.mode = options.mode ?? 'swe_agent_aci_full';
    this.windowSize = options.windowSize ?? 100;
    this.contextLines = options.contextLines ?? 4;
    this.maxResponseBytes = options.maxResponseBytes ?? 1800;
    this.maxResponseTokens = options.maxResponseTokens ?? 450;
    this.naiveHeadMaxChars = options.naiveHeadMaxChars ?? 1200;
    this.overCompressedMaxChars = options.overCompressedMaxChars ?? 120;
  }

  /**
   * Wraps a single `@hanzo/mcp` `Tool` while keeping its schema and metadata intact.
   */
  public wrapTool(tool: Tool): Tool {
    if (tool.name !== 'fs' && tool.name !== 'exec' && tool.name !== 'code') {
      return tool;
    }
    return {
      ...tool,
      handler: async (args: Record<string, any>): Promise<ToolResult> => {
        return this.executeWithMode(tool.name, args || {}, () => tool.handler(args || {}));
      },
    };
  }

  /**
   * Wraps an array of tools without altering count, ordering, or schema.
   */
  public wrapTools(tools: Tool[]): Tool[] {
    return tools.map((t) => this.wrapTool(t));
  }

  /**
   * Executes a tool call against a live `createMCPServer()` handle using the
   * configured ACI mode.
   */
  public async callTool(
    server: AciServerInvoker,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<ToolResult> {
    if (toolName !== 'fs' && toolName !== 'exec' && toolName !== 'code') {
      return this.normalizeToolResult(await server.callTool(toolName, args));
    }
    return this.executeWithMode(toolName, args, () => server.callTool(toolName, args));
  }

  private normalizeToolResult(res: AciToolResultLike): ToolResult {
    return {
      content: res.content.map((c) => ({
        type: c.type === 'image' || c.type === 'resource' ? c.type : 'text',
        ...(c.text !== undefined ? { text: c.text } : {}),
        ...(c.data !== undefined ? { data: c.data } : {}),
        ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
        ...(c.uri !== undefined ? { uri: c.uri } : {}),
      })),
      ...(res.isError ? { isError: true } : {}),
      ...(res._meta ? { _meta: res._meta } : {}),
    };
  }

  private async executeWithMode(
    toolName: string,
    args: Record<string, any>,
    invokeUnderlying: () => Promise<AciToolResultLike>
  ): Promise<ToolResult> {
    if (this.mode === 'raw_unbounded_cli') {
      return this.normalizeToolResult(await invokeUnderlying());
    }

    // 1. Intercept `fs` read -> windowed line-numbered viewer (in windowed_viewer_only & swe_agent_aci_full)
    if (toolName === 'fs' && args.action === 'read') {
      if (this.mode === 'windowed_viewer_only' || this.mode === 'swe_agent_aci_full') {
        const rawPath = String(args.uri ?? args.path ?? '');
        const cleanPath = rawPath.startsWith('file://') ? rawPath.slice(7) : rawPath;
        try {
          const res = viewWindow({
            workspaceRoot: this.workspaceRoot,
            filePath: cleanPath,
            centerLine: typeof args.center_line === 'number' ? args.center_line : undefined,
            startLine:
              typeof args.start_line === 'number'
                ? args.start_line
                : typeof args.offset === 'number'
                  ? args.offset + 1
                  : undefined,
            windowSize:
              typeof args.window_size === 'number'
                ? args.window_size
                : typeof args.limit === 'number'
                  ? args.limit
                  : this.windowSize,
            anchorPattern: typeof args.anchor_pattern === 'string' ? args.anchor_pattern : undefined,
          });
          return {
            content: [{ type: 'text', text: res.rendered }],
            _meta: {
              aciMode: this.mode,
              sha256: res.sha256,
              startLine: res.startLine,
              endLine: res.endLine,
              totalLines: res.totalLines,
              bytes: res.bytes,
              estimatedTokens: res.estimatedTokens,
            },
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `[ACI_VIEW_ERROR] ${err?.message ?? String(err)}` }],
            isError: true,
          };
        }
      }
    }

    // 2. Intercept `fs` apply_patch -> syntax-linter-gated atomic edit with rollback (in swe_agent_aci_full)
    if (toolName === 'fs' && args.action === 'apply_patch' && this.mode === 'swe_agent_aci_full') {
      const rawPath = String(args.uri ?? args.path ?? '');
      const cleanPath = rawPath.startsWith('file://') ? rawPath.slice(7) : rawPath;
      const editRes = lintedEdit({
        workspaceRoot: this.workspaceRoot,
        filePath: cleanPath,
        oldText: typeof args.old_text === 'string' ? args.old_text : undefined,
        newText: typeof args.new_text === 'string' ? args.new_text : undefined,
        expectedLine: typeof args.expected_line === 'number' ? args.expected_line : undefined,
        startLine: typeof args.start_line === 'number' ? args.start_line : undefined,
        endLine: typeof args.end_line === 'number' ? args.end_line : undefined,
        replacement: typeof args.replacement === 'string' ? args.replacement : undefined,
        expectedSha256: typeof args.base_hash === 'string' ? args.base_hash : undefined,
        contextLines: this.contextLines,
      });
      return {
        content: [{ type: 'text', text: editRes.rendered }],
        ...(editRes.ok ? {} : { isError: true }),
        _meta: {
          aciMode: this.mode,
          applied: editRes.applied,
          rolledBack: editRes.rolledBack,
          errorCode: editRes.errorCode,
          originalSha256: editRes.originalSha256,
          afterSha256: editRes.afterSha256,
          diagnostics: editRes.diagnostics,
          lintDurationMs: editRes.lintDurationMs,
        },
      };
    }

    // Delegate to real underlying `@hanzo/mcp` tool
    const rawResult = this.normalizeToolResult(await invokeUnderlying());
    const rawText = extractTextFromToolResult(rawResult);

    if (this.mode === 'windowed_viewer_only') {
      return rawResult;
    }

    if (this.mode === 'naive_head_truncation') {
      const truncated =
        rawText.length > this.naiveHeadMaxChars
          ? `${rawText.slice(0, this.naiveHeadMaxChars)}\n...[truncated ${rawText.length - this.naiveHeadMaxChars} trailing chars]`
          : rawText;
      return {
        ...rawResult,
        content: [{ type: 'text', text: truncated }],
        _meta: { ...(rawResult._meta ?? {}), aciMode: this.mode, rawBytes: Buffer.byteLength(rawText, 'utf8') },
      };
    }

    if (this.mode === 'over_compressed_negative') {
      const compressed = stripAnchorsForOverCompression(rawText, this.overCompressedMaxChars);
      return {
        ...rawResult,
        content: [{ type: 'text', text: compressed }],
        _meta: { ...(rawResult._meta ?? {}), aciMode: this.mode, rawBytes: Buffer.byteLength(rawText, 'utf8') },
      };
    }

    // `swe_agent_aci_full` formatting for `exec`, `fs.search_text`, and `code`
    if (toolName === 'exec') {
      const parsed = parseJsonSafe(rawText);
      const stdout = typeof parsed?.data?.stdout === 'string' ? parsed.data.stdout : rawText;
      const stderr = typeof parsed?.data?.stderr === 'string' ? parsed.data.stderr : '';
      const exitCode =
        typeof parsed?.data?.exit_code === 'number'
          ? parsed.data.exit_code
          : rawResult.isError
            ? 1
            : 0;
      const envelope = formatCompactToolResponse({
        rawOutput: stdout,
        stderr,
        exitCode,
        command: typeof args.command === 'string' ? args.command : undefined,
        toolName: 'exec',
        maxBytes: this.maxResponseBytes,
        maxTokens: this.maxResponseTokens,
        workspaceRoot: this.workspaceRoot,
      });
      return {
        content: [{ type: 'text', text: envelope.rendered }],
        ...(exitCode !== 0 ? { isError: true } : {}),
        _meta: {
          aciMode: this.mode,
          aciEnvelope: envelope,
        },
      };
    }

    if (
      (toolName === 'fs' && args.action === 'search_text') ||
      toolName === 'code'
    ) {
      const parsed = parseJsonSafe(rawText);
      let flatLines = rawText;
      if (parsed?.data?.matches && Array.isArray(parsed.data.matches)) {
        flatLines = parsed.data.matches
          .map((m: any) => `${m.uri ?? m.file ?? m.path ?? ''}:${m.line ?? 0}: ${m.text ?? m.preview ?? ''}`)
          .join('\n');
      } else if (parsed?.data?.symbols && Array.isArray(parsed.data.symbols)) {
        flatLines = parsed.data.symbols
          .map((s: any) => `${s.uri ?? s.file ?? ''}:${s.line ?? 0}: ${s.kind ?? ''} ${s.name ?? ''}`)
          .join('\n');
      }
      const envelope = formatCompactToolResponse({
        rawOutput: flatLines,
        exitCode: rawResult.isError ? 1 : 0,
        toolName,
        maxBytes: this.maxResponseBytes,
        maxTokens: this.maxResponseTokens,
        workspaceRoot: this.workspaceRoot,
      });
      return {
        content: [{ type: 'text', text: envelope.rendered }],
        ...(rawResult.isError ? { isError: true } : {}),
        _meta: {
          aciMode: this.mode,
          aciEnvelope: envelope,
        },
      };
    }

    return rawResult;
  }
}
