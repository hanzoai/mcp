/**
 * AST search strategy using grep-ast
 */

import { spawn } from 'child_process';
import path from 'path';
import { SearchStrategy, SearchType, SearchOptions, InternalSearchResult } from '../types.js';

export class ASTSearchStrategy implements SearchStrategy {
  readonly name = SearchType.AST;

  shouldApply(query: string): boolean {
    // Apply for code patterns
    const codePatterns = [
      /class\s+\w+/, /function\s+\w+/, /def\s+\w+/, /interface\s+\w+/,
      /struct\s+\w+/, /enum\s+\w+/, /type\s+\w+/, /const\s+\w+/,
      /let\s+\w+/, /var\s+\w+/, /import\s+/, /from\s+/,
      /fn\s+\w+/, /impl\s+/, /trait\s+/, /pub\s+/
    ];
    
    return codePatterns.some(pattern => pattern.test(query));
  }

  getPriority(): number {
    return 20; // Higher priority for structured code search
  }

  async search(query: string, options: SearchOptions = {}): Promise<InternalSearchResult[]> {
    const { maxResults = 20 } = options;

    return new Promise((resolve) => {
      const grepAst = spawn('grep-ast', [
        query, 
        '.', 
        '--json', 
        '--max-count', maxResults.toString()
      ]);
      
      const results: InternalSearchResult[] = [];
      let buffer = '';

      grepAst.stdout.on('data', (data) => {
        buffer += data.toString();
      });

      grepAst.on('close', () => {
        try {
          const lines = buffer.split('\n').filter(l => l);
          for (const line of lines) {
            const json = JSON.parse(line);
            results.push({
              id: `${json.file}:${json.line}:ast`,
              title: `${path.basename(json.file)} - ${json.node_type || 'AST'}`,
              url: `file://${json.file}`,
              filePath: json.file,
              lineNumber: json.line,
              column: json.column || 0,
              matchText: json.match,
              contextBefore: json.context_before || [],
              contextAfter: json.context_after || [],
              matchType: SearchType.AST,
              score: 0.95,
              nodeType: json.node_type,
              semanticContext: json.semantic_context
            });
          }
        } catch (e) {
          // Fallback on error
        }
        resolve(results);
      });

      grepAst.on('error', () => resolve([]));
    });
  }
}

/**
 * Create AST search strategy instance
 */
export function createASTSearchStrategy(): SearchStrategy {
  return new ASTSearchStrategy();
}