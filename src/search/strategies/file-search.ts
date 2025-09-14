/**
 * File search strategy using glob patterns
 */

import * as glob from 'glob';
import path from 'path';
import { SearchStrategy, SearchType, SearchOptions, InternalSearchResult } from '../types.js';

export class FileSearchStrategy implements SearchStrategy {
  readonly name = SearchType.File;

  shouldApply(query: string): boolean {
    // Apply when query looks like a file path or pattern
    return query.includes('/') || 
           query.includes('.') || 
           query.includes('*') ||
           /\.(ts|js|tsx|jsx|py|rs|go|java|cpp|c|h)$/i.test(query);
  }

  getPriority(): number {
    return 50; // Lower priority, specific use case
  }

  async search(query: string, options: SearchOptions = {}): Promise<InternalSearchResult[]> {
    const { maxResults = 10 } = options;
    
    // Create glob pattern
    let pattern = query;
    if (!pattern.includes('*')) {
      pattern = `**/*${pattern}*`;
    }

    try {
      const files = await glob.glob(pattern, {
        cwd: process.cwd(),
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        absolute: true
      });

      return files.slice(0, maxResults).map(file => ({
        id: `file:${file}`,
        title: path.basename(file),
        url: `file://${file}`,
        filePath: file,
        lineNumber: 0,
        column: 0,
        matchText: path.basename(file),
        contextBefore: [],
        contextAfter: [],
        matchType: SearchType.File,
        score: this.calculateFileScore(file, query)
      }));
    } catch (error) {
      console.error('File search error:', error);
      return [];
    }
  }

  private calculateFileScore(filePath: string, query: string): number {
    const fileName = path.basename(filePath);
    const queryLower = query.toLowerCase();
    const fileNameLower = fileName.toLowerCase();
    
    // Exact match
    if (fileNameLower === queryLower) {
      return 1.0;
    }
    // Starts with query
    if (fileNameLower.startsWith(queryLower)) {
      return 0.9;
    }
    // Contains query
    if (fileNameLower.includes(queryLower)) {
      return 0.8;
    }
    // Partial match
    return 0.7;
  }
}

/**
 * Create file search strategy instance
 */
export function createFileSearchStrategy(): SearchStrategy {
  return new FileSearchStrategy();
}