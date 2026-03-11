/**
 * code — Unified semantic code tool (HIP-0300)
 *
 * One tool for the Symbols + Semantics axis.
 * Actions: search_symbol, outline, references, metrics, exports, types, hierarchy, rename, grep_replace
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import { Tool } from '../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'code', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'code' } }, null, 2) }], isError: true };
}

const SYMBOL_RE = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|pub\s+fn|pub\s+struct|struct|impl)\s+(\w+)/g;
const IMPORT_RE = /^(?:import|from|require|use)\b.*/gm;

export const codeTool: Tool = {
  name: 'code',
  description: 'Semantic code operations: parse, serialize, symbols, outline, definition, search_symbol, references, summarize, metrics, exports, types, hierarchy, rename, grep_replace, transform',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['parse', 'serialize', 'symbols', 'outline', 'definition', 'search_symbol', 'references', 'summarize', 'metrics', 'exports', 'types', 'hierarchy', 'rename', 'grep_replace', 'transform'], description: 'Code action' },
      query: { type: 'string', description: 'Symbol name or search query' },
      uri: { type: 'string', description: 'File or directory path' },
      path: { type: 'string', description: 'File path (alias for uri)' },
      text: { type: 'string', description: 'Raw text input' },
      scope: { type: 'string', description: 'Search scope (file, directory, project)', default: 'project' },
      pattern: { type: 'string', description: 'File glob pattern' },
      new_name: { type: 'string', description: 'New name for rename' },
      replacement: { type: 'string', description: 'Replacement for grep_replace' },
      max_results: { type: 'number', default: 20 },
      language: { type: 'string', description: 'Filter by language' },
      kind: { type: 'string', description: 'Transform kind: rename, codemod' },
      old_name: { type: 'string', description: 'Old name for transform rename' },
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const uri = args.uri || args.path || '.';

      switch (args.action) {
        case 'search_symbol': {
          if (!args.query) return fail('INVALID_PARAMS', 'query required');
          const filePattern = args.pattern || '**/*.{ts,js,py,rs,go,java,c,cpp,h}';
          const files = await glob(path.join(uri, filePattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/target/**'] });
          const results: any[] = [];
          for (const file of files) {
            if (results.length >= (args.max_results || 20)) break;
            try {
              const content = await fs.readFile(file, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(args.query)) {
                  const match = lines[i].match(SYMBOL_RE);
                  if (match || lines[i].match(new RegExp(`\\b${args.query}\\b`))) {
                    results.push({ uri: file, line: i + 1, text: lines[i].trim(), type: match ? 'definition' : 'reference' });
                    if (results.length >= (args.max_results || 20)) break;
                  }
                }
              }
            } catch {}
          }
          return envelope({ query: args.query, results, count: results.length }, 'search_symbol');
        }

        case 'outline': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const content = await fs.readFile(uri, 'utf-8');
          const lines = content.split('\n');
          const symbols: any[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            SYMBOL_RE.lastIndex = 0;
            let m;
            while ((m = SYMBOL_RE.exec(line)) !== null) {
              const kind = line.match(/\b(class|interface|type|enum|function|const|struct|impl|fn|def)\b/)?.[1] || 'symbol';
              symbols.push({ name: m[1], kind, line: i + 1, exported: /^export\b/.test(line.trim()) || /^pub\b/.test(line.trim()) });
            }
          }
          const imports = (content.match(IMPORT_RE) || []).length;
          return envelope({ uri, symbols, imports, lines: lines.length }, 'outline');
        }

        case 'symbols': {
          // Like outline but keyed on path param
          const filePath = args.path || args.uri;
          if (!filePath || filePath === '.') return fail('INVALID_PARAMS', 'path or uri required');
          let content: string;
          if (args.text) {
            content = args.text;
          } else {
            content = await fs.readFile(filePath, 'utf-8');
          }
          const lines = content.split('\n');
          const symbols: any[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            SYMBOL_RE.lastIndex = 0;
            let m;
            while ((m = SYMBOL_RE.exec(line)) !== null) {
              const kind = line.match(/\b(class|interface|type|enum|function|const|struct|impl|fn|def)\b/)?.[1] || 'symbol';
              symbols.push({ name: m[1], kind, line: i + 1 });
            }
          }
          return envelope({ symbols, count: symbols.length, path: filePath }, 'symbols');
        }

        case 'summarize': {
          const text = args.text || '';
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          const lineCount = text.split('\n').length;
          // Detect if it's a diff
          const isDiff = text.includes('---') && text.includes('+++');
          const summary = isDiff
            ? `Diff: ${lineCount} lines, ${text.split('\n').filter(l => l.startsWith('+')).length - 1} additions, ${text.split('\n').filter(l => l.startsWith('-')).length - 1} deletions`
            : `Text: ${wordCount} words`;
          return envelope({ summary, lines: lineCount, words: wordCount }, 'summarize');
        }

        case 'references': {
          if (!args.query) return fail('INVALID_PARAMS', 'query (symbol name) required');
          let hasRg = false;
          try { await execAsync('which rg'); hasRg = true; } catch {}
          const pattern = args.pattern ? `-g "${args.pattern}"` : '-g "*.{ts,js,py,rs,go,java}"';
          const cmd = hasRg
            ? `rg -n --max-count ${args.max_results || 30} ${pattern} "\\b${args.query}\\b" "${uri}"`
            : `grep -rn "\\b${args.query}\\b" "${uri}" | head -${args.max_results || 30}`;
          try {
            const { stdout } = await execAsync(cmd);
            const refs = stdout.trim().split('\n').filter(Boolean).map(line => {
              const [file, num, ...rest] = line.split(':');
              return { uri: file, line: parseInt(num) || 0, text: rest.join(':').trim() };
            });
            return envelope({ query: args.query, references: refs, count: refs.length }, 'references');
          } catch (e: any) {
            if (e.code === 1) return envelope({ query: args.query, references: [], count: 0 }, 'references');
            throw e;
          }
        }

        case 'metrics': {
          const filePattern = args.pattern || '**/*.{ts,js,py,rs,go}';
          const files = await glob(path.join(uri, filePattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'] });
          const byExt: Record<string, { files: number; lines: number }> = {};
          let totalLines = 0, totalFiles = 0;
          for (const file of files) {
            try {
              const content = await fs.readFile(file, 'utf-8');
              const ext = path.extname(file) || 'other';
              if (!byExt[ext]) byExt[ext] = { files: 0, lines: 0 };
              const lines = content.split('\n').length;
              byExt[ext].files++; byExt[ext].lines += lines;
              totalFiles++; totalLines += lines;
            } catch {}
          }
          return envelope({ total_files: totalFiles, total_lines: totalLines, by_extension: byExt }, 'metrics');
        }

        case 'exports': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const content = await fs.readFile(uri, 'utf-8');
          const exports: string[] = [];
          const lines = content.split('\n');
          for (const line of lines) {
            if (/^export\s/.test(line.trim()) || /^pub\s/.test(line.trim())) {
              exports.push(line.trim());
            }
          }
          return envelope({ uri, exports, count: exports.length }, 'exports');
        }

        case 'types': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const content = await fs.readFile(uri, 'utf-8');
          const types: any[] = [];
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (/(?:interface|type|enum|struct)\s+\w+/.test(lines[i])) {
              const name = lines[i].match(/(?:interface|type|enum|struct)\s+(\w+)/)?.[1];
              if (name) types.push({ name, line: i + 1, text: lines[i].trim() });
            }
          }
          return envelope({ uri, types, count: types.length }, 'types');
        }

        case 'hierarchy': {
          if (!args.query) return fail('INVALID_PARAMS', 'query (class name) required');
          const filePattern = args.pattern || '**/*.{ts,js,py,rs,go,java}';
          const files = await glob(path.join(uri, filePattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'] });
          const classes: Record<string, string[]> = {};
          for (const file of files) {
            try {
              const content = await fs.readFile(file, 'utf-8');
              const classRe = /class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
              let m;
              while ((m = classRe.exec(content)) !== null) {
                if (m[2]) { if (!classes[m[2]]) classes[m[2]] = []; classes[m[2]].push(m[1]); }
                if (!classes[m[1]]) classes[m[1]] = [];
              }
            } catch {}
          }
          const build = (name: string, depth = 0): string => {
            let out = '  '.repeat(depth) + name + '\n';
            for (const child of (classes[name] || [])) out += build(child, depth + 1);
            return out;
          };
          return envelope({ root: args.query, tree: build(args.query), children: classes[args.query] || [] }, 'hierarchy');
        }

        case 'rename': {
          if (!args.query || !args.new_name) return fail('INVALID_PARAMS', 'query (old name) and new_name required');
          const filePattern = args.pattern || '**/*.{ts,js,py,rs,go}';
          const files = await glob(path.join(uri, filePattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'] });
          let totalChanges = 0;
          const changed: string[] = [];
          const re = new RegExp(`\\b${args.query}\\b`, 'g');
          for (const file of files) {
            try {
              const content = await fs.readFile(file, 'utf-8');
              if (re.test(content)) {
                const updated = content.replace(re, args.new_name);
                await fs.writeFile(file, updated, 'utf-8');
                const count = (content.match(re) || []).length;
                totalChanges += count;
                changed.push(`${file}: ${count} replacements`);
              }
            } catch {}
          }
          return envelope({ old_name: args.query, new_name: args.new_name, files_changed: changed.length, total_replacements: totalChanges, changed }, 'rename');
        }

        case 'grep_replace': {
          if (!args.query || args.replacement === undefined) return fail('INVALID_PARAMS', 'query (pattern) and replacement required');
          const filePattern = args.pattern || '**/*.{ts,js,py,rs,go}';
          const files = await glob(path.join(uri, filePattern), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'] });
          let totalChanges = 0;
          const changed: string[] = [];
          const re = new RegExp(args.query, 'g');
          for (const file of files) {
            try {
              const content = await fs.readFile(file, 'utf-8');
              if (re.test(content)) {
                re.lastIndex = 0;
                const count = (content.match(re) || []).length;
                const updated = content.replace(re, args.replacement);
                await fs.writeFile(file, updated, 'utf-8');
                totalChanges += count;
                changed.push(`${file}: ${count}`);
              }
            } catch {}
          }
          return envelope({ pattern: args.query, replacement: args.replacement, files_changed: changed.length, total_replacements: totalChanges, changed }, 'grep_replace');
        }

        case 'parse': {
          if (!uri || uri === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const content = args.text || await fs.readFile(uri, 'utf-8');
          const lines = content.split('\n');
          const ext = path.extname(uri).slice(1) || 'text';
          const syms: any[] = [];
          for (let i = 0; i < lines.length; i++) {
            SYMBOL_RE.lastIndex = 0;
            let m;
            while ((m = SYMBOL_RE.exec(lines[i])) !== null) {
              syms.push({ name: m[1], line: i + 1 });
            }
          }
          const imps = (content.match(IMPORT_RE) || []).length;
          return envelope({ uri, language: args.language || ext, lines: lines.length, symbols: syms.length, imports: imps }, 'parse');
        }

        case 'serialize': {
          return envelope({ hint: 'Serialization requires CST preservation. Use the original source text.', supported: false }, 'serialize');
        }

        case 'definition': {
          if (!args.query) return fail('INVALID_PARAMS', 'query (symbol name) required');
          const defPath = args.uri || args.path;
          if (!defPath || defPath === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const defContent = await fs.readFile(defPath, 'utf-8');
          const defLines = defContent.split('\n');
          for (let i = 0; i < defLines.length; i++) {
            if (defLines[i].includes(args.query) && /\b(function|class|def|fn|struct|interface|type|enum|const|let|var)\b/.test(defLines[i])) {
              return envelope({ uri: defPath, symbol: args.query, line: i + 1, text: defLines[i].trim() }, 'definition');
            }
          }
          return fail('NOT_FOUND', `Symbol '${args.query}' definition not found`);
        }

        case 'transform': {
          const tfPath = args.uri || args.path;
          if (!tfPath || tfPath === '.') return fail('INVALID_PARAMS', 'uri (file) required');
          const tfContent = args.text || await fs.readFile(tfPath, 'utf-8');
          const tfKind = args.kind || 'rename';

          if (tfKind === 'rename') {
            const oldName = args.query || args.old_name;
            if (!oldName || !args.new_name) return fail('INVALID_PARAMS', 'query/old_name and new_name required');
            const re = new RegExp(`\\b${oldName}\\b`, 'g');
            const newContent = tfContent.replace(re, args.new_name);
            const count = (tfContent.match(re) || []).length;
            const diffLines: string[] = [`--- a/${tfPath}`, `+++ b/${tfPath}`];
            const origLines = tfContent.split('\n');
            const newLines = newContent.split('\n');
            for (let i = 0; i < Math.max(origLines.length, newLines.length); i++) {
              if (origLines[i] !== newLines[i]) {
                diffLines.push(`@@ -${i+1} +${i+1} @@`);
                if (origLines[i] !== undefined) diffLines.push(`-${origLines[i]}`);
                if (newLines[i] !== undefined) diffLines.push(`+${newLines[i]}`);
              }
            }
            return envelope({ patch: diffLines.join('\n'), changes_count: count, kind: 'rename' }, 'transform');
          } else if (tfKind === 'codemod') {
            if (!args.query || args.replacement === undefined) return fail('INVALID_PARAMS', 'query (pattern) and replacement required');
            const re = new RegExp(args.query, 'g');
            const count = (tfContent.match(re) || []).length;
            return envelope({ patch: `${count} replacements of /${args.query}/`, changes_count: count, kind: 'codemod' }, 'transform');
          }
          return fail('INVALID_PARAMS', `Unknown transform kind: ${tfKind}`);
        }

        default:
          return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);
      }
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
