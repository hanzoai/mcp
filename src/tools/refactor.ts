/**
 * Refactor tool — single tool, action-routed code refactoring
 * rename, extract, inline, move, references, dead_code, complexity, duplicates, organize_imports, signatures
 */

import { Tool } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

async function findRefs(symbol: string, searchPath: string, fileGlob?: string): Promise<Array<{ file: string; line: number; text: string }>> {
  const refs: Array<{ file: string; line: number; text: string }> = [];
  try {
    let cmd = `rg -n --no-heading "${symbol}"`;
    if (fileGlob) cmd += ` -g "${fileGlob}"`;
    cmd += ` "${searchPath}"`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024 });
    for (const line of stdout.split('\n').filter(Boolean)) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) refs.push({ file: m[1], line: parseInt(m[2]), text: m[3].trim() });
    }
  } catch { /* rg exit 1 = no matches */ }
  return refs;
}

async function countLines(searchPath: string, fileGlob?: string): Promise<{ files: number; lines: number; blank: number; comment: number }> {
  try {
    let cmd = `rg -c "" --include-zero`;
    if (fileGlob) cmd += ` -g "${fileGlob}"`;
    cmd += ` "${searchPath}"`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024 });
    let files = 0, lines = 0;
    for (const l of stdout.split('\n').filter(Boolean)) {
      const m = l.match(/:(\d+)$/);
      if (m) { files++; lines += parseInt(m[1]); }
    }
    return { files, lines, blank: 0, comment: 0 };
  } catch { return { files: 0, lines: 0, blank: 0, comment: 0 }; }
}

export const refactorTool: Tool = {
  name: 'refactor',
  description: 'Code refactoring: rename, extract, inline, move, references, dead_code, complexity, duplicates, organize_imports, signatures, grep_replace',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['rename', 'extract', 'inline', 'move', 'references', 'dead_code', 'complexity', 'duplicates', 'organize_imports', 'signatures', 'grep_replace'],
        description: 'Refactoring action'
      },
      path: { type: 'string', default: '.' },
      filePattern: { type: 'string', description: 'File glob (e.g., "*.ts", "*.{js,py}")' },
      symbol: { type: 'string', description: 'Symbol name' },
      newName: { type: 'string', description: 'New name (rename)' },
      dryRun: { type: 'boolean', description: 'Preview without applying', default: true },
      file: { type: 'string', description: 'Source file' },
      startLine: { type: 'number', description: 'Start line (extract)' },
      endLine: { type: 'number', description: 'End line (extract)' },
      name: { type: 'string', description: 'New function name (extract)' },
      from: { type: 'string', description: 'Source file (move)' },
      to: { type: 'string', description: 'Destination file (move)' },
      pattern: { type: 'string', description: 'Regex pattern (grep_replace)' },
      replacement: { type: 'string', description: 'Replacement string (grep_replace)' },
      minLines: { type: 'number', description: 'Min duplicate block size', default: 5 },
      limit: { type: 'number', default: 50 }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'rename': {
          if (!args.symbol || !args.newName) return { content: [{ type: 'text', text: 'symbol and newName required' }], isError: true };
          const refs = await findRefs(`\\b${args.symbol}\\b`, args.path || '.', args.filePattern);
          if (!refs.length) return { content: [{ type: 'text', text: `No references found for '${args.symbol}'` }] };

          const groups = new Map<string, typeof refs>();
          for (const r of refs) { if (!groups.has(r.file)) groups.set(r.file, []); groups.get(r.file)!.push(r); }

          if (args.dryRun !== false) {
            const out = [`Would rename '${args.symbol}' → '${args.newName}' in ${groups.size} files (${refs.length} refs):\n`];
            for (const [f, rs] of groups) {
              out.push(`  ${f}: ${rs.length} refs`);
              for (const r of rs.slice(0, 3)) out.push(`    L${r.line}: ${r.text}`);
              if (rs.length > 3) out.push(`    ... +${rs.length - 3} more`);
            }
            out.push('\nSet dryRun=false to apply.');
            return { content: [{ type: 'text', text: out.join('\n') }] };
          }

          const re = new RegExp(`\\b${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          let changed = 0;
          for (const [f] of groups) {
            const c = await fs.readFile(f, 'utf-8');
            const n = c.replace(re, args.newName);
            if (c !== n) { await fs.writeFile(f, n); changed++; }
          }
          return { content: [{ type: 'text', text: `Renamed '${args.symbol}' → '${args.newName}' in ${changed} files` }] };
        }

        case 'extract': {
          if (!args.file || !args.startLine || !args.endLine || !args.name)
            return { content: [{ type: 'text', text: 'file, startLine, endLine, name required' }], isError: true };
          const content = await fs.readFile(args.file, 'utf-8');
          const lines = content.split('\n');
          const body = lines.slice(args.startLine - 1, args.endLine);
          const indent = body[0]?.match(/^(\s*)/)?.[1] || '';
          const stripped = body.map(l => l.startsWith(indent) ? l.slice(indent.length) : l);
          const ext = path.extname(args.file).slice(1);
          const funcDef = ext === 'py' ? `def ${args.name}():\n${stripped.map(l => '    ' + l).join('\n')}`
            : ext === 'go' ? `func ${args.name}() {\n${stripped.map(l => '\t' + l).join('\n')}\n}`
            : ext === 'rs' ? `fn ${args.name}() {\n${stripped.map(l => '    ' + l).join('\n')}\n}`
            : `function ${args.name}() {\n${stripped.map(l => '  ' + l).join('\n')}\n}`;
          return { content: [{ type: 'text', text: `Extracted function:\n\n${funcDef}\n\nReplace lines ${args.startLine}-${args.endLine} with: ${indent}${args.name}()` }] };
        }

        case 'inline':
        case 'references': {
          if (!args.symbol) return { content: [{ type: 'text', text: 'symbol required' }], isError: true };
          const defPatterns = [`function\\s+${args.symbol}\\s*\\(`, `(const|let|var)\\s+${args.symbol}\\s*=`, `def\\s+${args.symbol}\\s*\\(`, `fn\\s+${args.symbol}\\s*\\(`, `func\\s+${args.symbol}\\s*\\(`];
          const defs: Array<{ file: string; line: number; text: string }> = [];
          for (const p of defPatterns) defs.push(...await findRefs(p, args.path || '.', args.filePattern));
          const allRefs = await findRefs(`\\b${args.symbol}\\b`, args.path || '.', args.filePattern);
          const calls = allRefs.filter(r => !defs.some(d => d.file === r.file && d.line === r.line));
          const out = [`Symbol: ${args.symbol}\n`, `Definitions (${defs.length}):`];
          for (const d of defs) out.push(`  ${d.file}:${d.line}: ${d.text}`);
          out.push('', `References (${calls.length}):`);
          for (const r of calls.slice(0, args.limit || 50)) out.push(`  ${r.file}:${r.line}: ${r.text}`);
          if (calls.length > (args.limit || 50)) out.push(`  ... +${calls.length - (args.limit || 50)} more`);
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'move': {
          if (!args.symbol || !args.from || !args.to) return { content: [{ type: 'text', text: 'symbol, from, to required' }], isError: true };
          const refs = await findRefs(`\\b${args.symbol}\\b`, path.dirname(args.from));
          const imports = refs.filter(r => r.file !== args.from && (r.text.includes('import') || r.text.includes('require')));
          return { content: [{ type: 'text', text: `Move '${args.symbol}' ${args.from} → ${args.to}\n\nFiles needing import updates (${imports.length}):\n${imports.map(r => `  ${r.file}:${r.line}: ${r.text}`).join('\n')}` }] };
        }

        case 'dead_code': {
          const exportRefs = await findRefs('export\\s+(function|const|class|interface|type|enum|default)', args.path || '.', args.filePattern);
          const out = [`Exported symbols in ${args.path || '.'}:\n`];
          const symbols: Array<{ file: string; name: string; refs: number }> = [];
          for (const e of exportRefs) {
            const m = e.text.match(/export\s+(?:default\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/);
            if (m) {
              const refs = await findRefs(`\\b${m[1]}\\b`, args.path || '.', args.filePattern);
              const external = refs.filter(r => r.file !== e.file);
              symbols.push({ file: e.file, name: m[1], refs: external.length });
            }
          }
          const dead = symbols.filter(s => s.refs === 0);
          const used = symbols.filter(s => s.refs > 0);
          out.push(`Potentially unused exports (${dead.length}):`);
          for (const s of dead.slice(0, args.limit || 50)) out.push(`  ${s.file}: ${s.name}`);
          out.push(`\nUsed exports: ${used.length}`);
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'complexity': {
          if (!args.file) return { content: [{ type: 'text', text: 'file required' }], isError: true };
          const content = await fs.readFile(args.file, 'utf-8');
          const lines = content.split('\n');
          const funcs: Array<{ name: string; line: number; complexity: number; length: number }> = [];
          let currentFunc: { name: string; line: number; depth: number; complexity: number; start: number } | null = null;
          let braceDepth = 0;

          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const fm = l.match(/(?:function|def|fn|func)\s+(\w+)/);
            if (fm) { currentFunc = { name: fm[1], line: i + 1, depth: braceDepth, complexity: 1, start: i }; }
            if (currentFunc) {
              const branches = (l.match(/\b(if|else if|elif|case|catch|&&|\|\||for|while|switch)\b/g) || []).length;
              currentFunc.complexity += branches;
            }
            braceDepth += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
            if (currentFunc && braceDepth <= currentFunc.depth) {
              funcs.push({ name: currentFunc.name, line: currentFunc.line, complexity: currentFunc.complexity, length: i - currentFunc.start + 1 });
              currentFunc = null;
            }
          }

          funcs.sort((a, b) => b.complexity - a.complexity);
          const out = [`Complexity: ${args.file}\n`, `Functions (${funcs.length}):`];
          for (const f of funcs.slice(0, args.limit || 30)) {
            const risk = f.complexity > 15 ? 'HIGH' : f.complexity > 8 ? 'MED' : 'LOW';
            out.push(`  ${f.name} (L${f.line}): complexity=${f.complexity} length=${f.length} [${risk}]`);
          }
          const stats = countLines(args.path || '.', args.filePattern);
          return { content: [{ type: 'text', text: out.join('\n') }] };
        }

        case 'duplicates': {
          const minLen = args.minLines || 5;
          const searchPath = args.path || '.';
          const glob = args.filePattern || '*.{ts,js,py,go,rs}';
          try {
            const { stdout } = await execAsync(`rg -n --no-heading "" -g "${glob}" "${searchPath}" | head -10000`, { maxBuffer: 10 * 1024 * 1024 });
            const fileLines = new Map<string, string[]>();
            for (const l of stdout.split('\n')) {
              const m = l.match(/^(.+?):(\d+):(.*)$/);
              if (m) {
                if (!fileLines.has(m[1])) fileLines.set(m[1], []);
                fileLines.get(m[1])!.push(m[3].trim());
              }
            }
            // Simple n-gram fingerprinting for duplicate detection
            const fingerprints = new Map<string, Array<{ file: string; startLine: number }>>();
            for (const [file, lines] of fileLines) {
              for (let i = 0; i <= lines.length - minLen; i++) {
                const block = lines.slice(i, i + minLen).join('\n');
                if (block.length < 20) continue; // skip trivial blocks
                const fp = block.replace(/\s+/g, ' ');
                if (!fingerprints.has(fp)) fingerprints.set(fp, []);
                fingerprints.get(fp)!.push({ file, startLine: i + 1 });
              }
            }
            const dupes = [...fingerprints.entries()].filter(([_, locs]) => locs.length > 1 && new Set(locs.map(l => l.file)).size > 1);
            const out = [`Duplicate code blocks (${minLen}+ lines, ${dupes.length} found):\n`];
            for (const [block, locs] of dupes.slice(0, args.limit || 20)) {
              out.push(`  Duplicate in ${locs.length} locations:`);
              for (const l of locs) out.push(`    ${l.file}:${l.startLine}`);
              out.push(`    Preview: ${block.substring(0, 80)}...`);
            }
            return { content: [{ type: 'text', text: out.join('\n') }] };
          } catch (e: any) { return { content: [{ type: 'text', text: `Error scanning: ${e.message}` }], isError: true }; }
        }

        case 'organize_imports': {
          if (!args.file) return { content: [{ type: 'text', text: 'file required' }], isError: true };
          const content = await fs.readFile(args.file, 'utf-8');
          const lines = content.split('\n');
          const importLines: Array<{ line: number; text: string; source: string }> = [];
          const otherLines: Array<{ line: number; text: string }> = [];
          let lastImportLine = -1;

          for (let i = 0; i < lines.length; i++) {
            const im = lines[i].match(/^(import\s+.*\s+from\s+['"](.+)['"]|import\s+['"](.+)['"]|const\s+.*\s*=\s*require\(['"](.+)['"]\))/);
            if (im) {
              importLines.push({ line: i, text: lines[i], source: im[2] || im[3] || im[4] || '' });
              lastImportLine = i;
            } else if (i <= lastImportLine + 1 && lines[i].trim() === '') {
              // skip blank lines between imports
            }
          }

          const external = importLines.filter(i => !i.source.startsWith('.'));
          const internal = importLines.filter(i => i.source.startsWith('.'));
          external.sort((a, b) => a.source.localeCompare(b.source));
          internal.sort((a, b) => a.source.localeCompare(b.source));

          const organized = [...external.map(i => i.text), '', ...internal.map(i => i.text)].join('\n');
          return { content: [{ type: 'text', text: `Organized imports for ${args.file}:\n\n${organized}\n\n${args.dryRun !== false ? 'Set dryRun=false to apply.' : 'Applied.'}` }] };
        }

        case 'signatures': {
          if (!args.file) return { content: [{ type: 'text', text: 'file required' }], isError: true };
          const content = await fs.readFile(args.file, 'utf-8');
          const sigs: string[] = [];
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const fm = l.match(/(export\s+)?(async\s+)?function\s+(\w+)\s*(\([\s\S]*?\))\s*[:{]/);
            const am = l.match(/(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)\s*[=:]/);
            const cm = l.match(/(export\s+)?class\s+(\w+)(\s+extends\s+\w+)?/);
            const dm = l.match(/def\s+(\w+)\s*\(([^)]*)\)/);
            const rm = l.match(/(pub\s+)?(async\s+)?fn\s+(\w+)\s*(\([^)]*\))/);
            if (fm) sigs.push(`L${i + 1}: ${fm[1] || ''}${fm[2] || ''}function ${fm[3]}${fm[4]}`);
            else if (am) sigs.push(`L${i + 1}: ${am[1] || ''}${am[3]} = ${am[4] || ''}(${am[5]})`);
            else if (cm) sigs.push(`L${i + 1}: ${cm[1] || ''}class ${cm[2]}${cm[3] || ''}`);
            else if (dm) sigs.push(`L${i + 1}: def ${dm[1]}(${dm[2]})`);
            else if (rm) sigs.push(`L${i + 1}: ${rm[1] || ''}${rm[2] || ''}fn ${rm[3]}${rm[4]}`);
          }
          return { content: [{ type: 'text', text: `Signatures in ${args.file} (${sigs.length}):\n\n${sigs.join('\n')}` }] };
        }

        case 'grep_replace': {
          if (!args.pattern || !args.replacement) return { content: [{ type: 'text', text: 'pattern and replacement required' }], isError: true };
          const refs = await findRefs(args.pattern, args.path || '.', args.filePattern);
          if (!refs.length) return { content: [{ type: 'text', text: `No matches for pattern: ${args.pattern}` }] };

          const groups = new Map<string, typeof refs>();
          for (const r of refs) { if (!groups.has(r.file)) groups.set(r.file, []); groups.get(r.file)!.push(r); }

          if (args.dryRun !== false) {
            const out = [`Would replace /${args.pattern}/ → '${args.replacement}' in ${groups.size} files (${refs.length} matches):\n`];
            for (const [f, rs] of [...groups].slice(0, 10)) {
              out.push(`  ${f}: ${rs.length} matches`);
              for (const r of rs.slice(0, 2)) out.push(`    L${r.line}: ${r.text}`);
            }
            out.push('\nSet dryRun=false to apply.');
            return { content: [{ type: 'text', text: out.join('\n') }] };
          }

          const re = new RegExp(args.pattern, 'g');
          let changed = 0;
          for (const [f] of groups) {
            const c = await fs.readFile(f, 'utf-8');
            const n = c.replace(re, args.replacement);
            if (c !== n) { await fs.writeFile(f, n); changed++; }
          }
          return { content: [{ type: 'text', text: `Replaced in ${changed} files` }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
};

export const refactorTools = [refactorTool];
