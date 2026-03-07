/**
 * AST tool — single tool, action-routed code intelligence
 * search, find_symbol, dependencies, outline, metrics, exports, types, calls, hierarchy
 */

import { Tool } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

const PATTERNS: Record<string, RegExp[]> = {
  function_declaration: [/function\s+(\w+)\s*\(/, /def\s+(\w+)\s*\(/, /fn\s+(\w+)\s*\(/, /func\s+(\w+)\s*\(/],
  class_definition: [/class\s+(\w+)/, /struct\s+(\w+)/, /interface\s+(\w+)/],
  method_call: [/(\w+)\s*\.\s*(\w+)\s*\(/, /(\w+)::\s*(\w+)\s*\(/],
  import_statement: [/import\s+.+\s+from\s+['"]/, /import\s+['"]/, /require\s*\(['"]/, /use\s+\w+/, /import\s+\w+/],
  variable_declaration: [/(let|const|var)\s+(\w+)/, /(\w+)\s*:=\s*/, /let\s+(mut\s+)?(\w+)/],
  type_definition: [/type\s+(\w+)\s*=/, /interface\s+(\w+)/, /enum\s+(\w+)/, /typedef\s+/],
  decorator: [/@\w+/, /#\[\w+/],
  export_statement: [/export\s+(default\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/]
};

async function getFiles(p: string, pattern?: string): Promise<string[]> {
  const s = await fs.stat(p).catch(() => null);
  if (s?.isFile()) return [p];
  const pats = pattern ? [pattern] : ['**/*.js', '**/*.ts', '**/*.tsx', '**/*.py', '**/*.rs', '**/*.go', '**/*.java', '**/*.rb', '**/*.php', '**/*.c', '**/*.cpp', '**/*.h'];
  const files: string[] = [];
  for (const pat of pats)
    files.push(...await glob(path.join(p, pat), { ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/target/**', '**/build/**'], maxDepth: 10 }));
  return files;
}

export const astTool: Tool = {
  name: 'ast',
  description: 'Code intelligence: search patterns, find symbols, analyze dependencies, outline file structure, metrics, list exports/types/calls, class hierarchy',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'search', 'find_symbol', 'dependencies',
        'outline', 'metrics', 'exports', 'types', 'calls', 'hierarchy'
      ], description: 'AST action' },
      pattern: { type: 'string', description: 'AST pattern (function_declaration, class_definition, etc.) or regex' },
      symbol: { type: 'string', description: 'Symbol name to find' },
      type: { type: 'string', enum: ['all', 'function', 'class', 'variable', 'method', 'type'], default: 'all' },
      path: { type: 'string', default: '.' },
      file: { type: 'string', description: 'Specific file (outline, metrics)' },
      filePattern: { type: 'string', description: 'File glob filter (e.g., "**/*.ts")' },
      exact: { type: 'boolean', default: false },
      maxResults: { type: 'number', default: 50 },
      showExternal: { type: 'boolean', default: true },
      showInternal: { type: 'boolean', default: true },
      depth: { type: 'number', description: 'Hierarchy depth', default: 3 }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const results: string[] = [];

      switch (args.action) {
        case 'search': {
          if (!args.pattern) return { content: [{ type: 'text', text: 'pattern required. Built-in: ' + Object.keys(PATTERNS).join(', ') }], isError: true };
          const files = await getFiles(args.path || '.', args.filePattern);
          const pats = PATTERNS[args.pattern] || [new RegExp(args.pattern, 'g')];
          let total = 0;
          for (const f of files) {
            if (total >= (args.maxResults || 50)) break;
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const matches: string[] = [];
            lines.forEach((line, i) => { for (const re of pats) if (re.test(line)) { matches.push(`  ${i + 1}: ${line.trim()}`); total++; break; } });
            if (matches.length) results.push(`${f}:\n${matches.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : 'No matches' }] };
        }

        case 'find_symbol': {
          if (!args.symbol) return { content: [{ type: 'text', text: 'symbol required' }], isError: true };
          const files = await getFiles(args.path || '.', args.filePattern);
          const s = args.exact ? args.symbol : `\\w*${args.symbol}\\w*`;
          const typePats: Record<string, RegExp[]> = {
            function: [new RegExp(`function\\s+${s}\\s*\\(`, 'i'), new RegExp(`def\\s+${s}\\s*\\(`, 'i'), new RegExp(`fn\\s+${s}\\s*\\(`, 'i'), new RegExp(`func\\s+${s}\\s*\\(`, 'i')],
            class: [new RegExp(`class\\s+${s}`, 'i'), new RegExp(`struct\\s+${s}`, 'i'), new RegExp(`interface\\s+${s}`, 'i')],
            variable: [new RegExp(`(let|const|var)\\s+${s}\\s*[:=]`, 'i')],
            method: [new RegExp(`\\.\\s*${s}\\s*\\(`, 'i')],
            type: [new RegExp(`type\\s+${s}\\s*[={]`, 'i'), new RegExp(`interface\\s+${s}`, 'i'), new RegExp(`enum\\s+${s}`, 'i')]
          };
          const pats = args.type === 'all' ? Object.values(typePats).flat() : typePats[args.type || 'all'] || [];
          for (const f of files) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const matches: string[] = [];
            lines.forEach((line, i) => { for (const p of pats) if (p.test(line)) { matches.push(`  ${i + 1}: ${line.trim()}`); break; } });
            if (matches.length) results.push(`${f}:\n${matches.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : `Symbol '${args.symbol}' not found` }] };
        }

        case 'dependencies': {
          const files = await getFiles(args.path || '.', args.filePattern);
          const importPats = [/import\s+.*\s+from\s+['"](.*)['"]/,/import\s+['"](.*)['"]/,/require\s*\(['"](.*)['"]\)/,/from\s+(\S+)\s+import/,/import\s+"(.*)"/,/use\s+(\S+);/];
          for (const f of files) {
            const deps: string[] = [];
            for (const line of (await fs.readFile(f, 'utf-8')).split('\n')) {
              for (const p of importPats) { const m = line.match(p); if (m?.[1]) { deps.push(m[1]); break; } }
            }
            if (!deps.length) continue;
            const ext = deps.filter(d => !d.startsWith('.')), int = deps.filter(d => d.startsWith('.'));
            const out = [f + ':'];
            if (args.showExternal !== false && ext.length) out.push('  External: ' + ext.join(', '));
            if (args.showInternal !== false && int.length) out.push('  Internal: ' + int.join(', '));
            results.push(out.join('\n'));
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n') : 'No dependencies found' }] };
        }

        case 'outline': {
          const targetFile = args.file || args.path || '.';
          const files = await getFiles(targetFile, args.filePattern);
          for (const f of files.slice(0, 5)) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const items: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const l = lines[i];
              const im = l.match(/^(import|from|use|require)/);
              const ex = l.match(/export\s+(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/);
              const fn = l.match(/(?:async\s+)?(?:function|def|fn|func)\s+(\w+)\s*\(/);
              const cl = l.match(/(class|struct|interface|trait|enum)\s+(\w+)/);
              const tp = l.match(/(?:export\s+)?type\s+(\w+)\s*[={]/);
              if (ex) items.push(`  ${i + 1}: export ${ex[3]} ${ex[4]}`);
              else if (cl) items.push(`  ${i + 1}: ${cl[1]} ${cl[2]}`);
              else if (fn && !im) items.push(`  ${i + 1}: fn ${fn[1]}`);
              else if (tp) items.push(`  ${i + 1}: type ${tp[1]}`);
            }
            if (items.length) results.push(`${f} (${lines.length} lines):\n${items.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : 'No symbols found' }] };
        }

        case 'metrics': {
          const files = await getFiles(args.file || args.path || '.', args.filePattern);
          let totalLines = 0, totalFiles = files.length, totalFuncs = 0, totalClasses = 0, totalImports = 0;
          const byExt: Record<string, { files: number; lines: number }> = {};
          for (const f of files) {
            const content = await fs.readFile(f, 'utf-8');
            const lines = content.split('\n');
            const ext = path.extname(f) || 'other';
            if (!byExt[ext]) byExt[ext] = { files: 0, lines: 0 };
            byExt[ext].files++;
            byExt[ext].lines += lines.length;
            totalLines += lines.length;
            for (const l of lines) {
              if (/(?:function|def|fn|func)\s+\w+\s*\(/.test(l)) totalFuncs++;
              if (/(?:class|struct|interface)\s+\w+/.test(l)) totalClasses++;
              if (/(?:import|require|use|from)\s/.test(l)) totalImports++;
            }
          }
          const extSummary = Object.entries(byExt).sort((a, b) => b[1].lines - a[1].lines).map(([ext, s]) => `  ${ext}: ${s.files} files, ${s.lines} lines`);
          return { content: [{ type: 'text', text: `Metrics:\n  Files: ${totalFiles}\n  Lines: ${totalLines}\n  Functions: ${totalFuncs}\n  Classes: ${totalClasses}\n  Imports: ${totalImports}\n\nBy extension:\n${extSummary.join('\n')}` }] };
        }

        case 'exports': {
          const files = await getFiles(args.path || '.', args.filePattern);
          for (const f of files) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const exports: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const m = lines[i].match(/export\s+(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/);
              if (m) exports.push(`  ${i + 1}: ${m[1] || ''}${m[3]} ${m[4]}`);
              const re = lines[i].match(/module\.exports\s*=\s*(\{[\s\S]*?\}|\w+)/);
              if (re) exports.push(`  ${i + 1}: module.exports = ${re[1].substring(0, 60)}`);
            }
            if (exports.length) results.push(`${f}:\n${exports.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : 'No exports found' }] };
        }

        case 'types': {
          const files = await getFiles(args.path || '.', args.filePattern);
          for (const f of files) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const types: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const l = lines[i];
              const tm = l.match(/(?:export\s+)?(?:type|interface|enum)\s+(\w+)/);
              const sm = l.match(/(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/);
              if (tm) types.push(`  ${i + 1}: ${l.trim().substring(0, 80)}`);
              else if (sm) types.push(`  ${i + 1}: ${l.trim().substring(0, 80)}`);
            }
            if (types.length) results.push(`${f}:\n${types.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : 'No type definitions found' }] };
        }

        case 'calls': {
          if (!args.symbol) return { content: [{ type: 'text', text: 'symbol required' }], isError: true };
          const files = await getFiles(args.path || '.', args.filePattern);
          const callPat = new RegExp(`\\b${args.symbol}\\s*\\(`, 'g');
          for (const f of files) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            const matches: string[] = [];
            lines.forEach((line, i) => { if (callPat.test(line)) matches.push(`  ${i + 1}: ${line.trim()}`); });
            if (matches.length) results.push(`${f}:\n${matches.join('\n')}`);
          }
          return { content: [{ type: 'text', text: results.length ? results.join('\n\n') : `No calls to '${args.symbol}' found` }] };
        }

        case 'hierarchy': {
          if (!args.symbol) return { content: [{ type: 'text', text: 'symbol (class name) required' }], isError: true };
          const files = await getFiles(args.path || '.', args.filePattern);
          const classes: Array<{ name: string; parent?: string; file: string; line: number }> = [];
          for (const f of files) {
            const lines = (await fs.readFile(f, 'utf-8')).split('\n');
            for (let i = 0; i < lines.length; i++) {
              const m = lines[i].match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);
              if (m) classes.push({ name: m[1], parent: m[2], file: f, line: i + 1 });
              const sm = lines[i].match(/struct\s+(\w+)/);
              if (sm) classes.push({ name: sm[1], file: f, line: i + 1 });
            }
          }
          // Build tree from target
          function buildTree(name: string, depth: number): string[] {
            if (depth <= 0) return [];
            const out: string[] = [];
            const children = classes.filter(c => c.parent === name);
            for (const c of children) {
              out.push(`${'  '.repeat((args.depth || 3) - depth + 1)}├─ ${c.name} (${c.file}:${c.line})`);
              out.push(...buildTree(c.name, depth - 1));
            }
            return out;
          }
          const root = classes.find(c => c.name === args.symbol);
          const out = [root ? `${args.symbol} (${root.file}:${root.line})` : args.symbol];
          if (root?.parent) out.push(`  extends: ${root.parent}`);
          out.push(...buildTree(args.symbol, args.depth || 3));
          const siblings = classes.filter(c => c.parent === root?.parent && c.name !== args.symbol);
          if (siblings.length) { out.push('\nSiblings:'); for (const s of siblings) out.push(`  ${s.name} (${s.file}:${s.line})`); }
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const astTools = [astTool];
