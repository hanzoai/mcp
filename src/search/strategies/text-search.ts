/**
 * Text search strategy using ripgrep
 */

import { spawn } from 'child_process';
import path from 'path';
import { SearchStrategy, SearchType, SearchOptions, InternalSearchResult } from '../types.js';

export class TextSearchStrategy implements SearchStrategy {
  readonly name = SearchType.Text;

  shouldApply(query: string): boolean {
    // Text search is always applicable as a fallback
    return true;
  }

  getPriority(): number {
    return 40; // Lower priority, used as fallback
  }

  async search(query: string, options: SearchOptions = {}): Promise<InternalSearchResult[]> {
    const {
      maxResults = 20,
      contextLines = 3,
      caseSensitive = false,
      filePattern
    } = options;

    return new Promise((resolve) => {
      const args = [
        '--json',
        '--max-count', maxResults.toString(),
        '-C', contextLines.toString()
      ];

      if (!caseSensitive) {
        args.push('-i');
      }

      if (filePattern) {
        args.push('--glob', filePattern);
      }

      args.push(query, '.');

      const rg = spawn('rg', args);
      const results: InternalSearchResult[] = [];
      let buffer = '';

      rg.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line) continue;
          try {
            const json = JSON.parse(line);
            if (json.type === 'match') {
              const data = json.data;
              
              // Extract context
              const contextBefore: string[] = [];
              const contextAfter: string[] = [];
              
              if (data.lines.before) {
                contextBefore.push(...data.lines.before.map((l: any) => l.text));
              }
              if (data.lines.after) {
                contextAfter.push(...data.lines.after.map((l: any) => l.text));
              }

              results.push({
                id: `${data.path.text}:${data.line_number}`,
                title: path.basename(data.path.text),
                url: `file://${data.path.text}`,
                filePath: data.path.text,
                lineNumber: data.line_number,
                column: data.submatches?.[0]?.start || 0,
                matchText: data.lines.text,
                contextBefore,
                contextAfter,
                matchType: SearchType.Text,
                score: 1.0
              });
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      });

      rg.on('close', () => resolve(results));
      rg.on('error', () => resolve([]));
    });
  }
}

/**
 * Create text search strategy instance
 */
export function createTextSearchStrategy(): SearchStrategy {
  return new TextSearchStrategy();
}