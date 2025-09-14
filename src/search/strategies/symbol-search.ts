/**
 * Symbol search strategy for finding code definitions
 */

import { SearchStrategy, SearchType, SearchOptions, InternalSearchResult } from '../types.js';
import { TextSearchStrategy } from './text-search.js';

export class SymbolSearchStrategy implements SearchStrategy {
  readonly name = SearchType.Symbol;
  private textSearch: TextSearchStrategy;

  constructor() {
    this.textSearch = new TextSearchStrategy();
  }

  shouldApply(query: string): boolean {
    // Apply for single identifiers
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query);
  }

  getPriority(): number {
    return 10; // High priority for precise symbol search
  }

  async search(query: string, options: SearchOptions = {}): Promise<InternalSearchResult[]> {
    // Search for common symbol definition patterns
    const patterns = [
      `function ${query}`,
      `class ${query}`,
      `def ${query}`,
      `interface ${query}`,
      `type ${query}`,
      `const ${query}`,
      `let ${query}`,
      `var ${query}`,
      `struct ${query}`,
      `enum ${query}`,
      `fn ${query}`,
      `impl ${query}`,
      `trait ${query}`,
      `module ${query}`,
      `namespace ${query}`
    ];

    const allResults: InternalSearchResult[] = [];
    
    // Search for each pattern
    for (const pattern of patterns) {
      const results = await this.textSearch.search(pattern, {
        ...options,
        maxResults: 5 // Limit per pattern to avoid too many results
      });
      
      // Adjust results for symbol search
      const symbolResults = results.map(r => ({
        ...r,
        matchType: SearchType.Symbol,
        score: this.calculateSymbolScore(r.matchText, query, pattern),
        title: `${query} (${pattern.split(' ')[0]})`
      }));
      
      allResults.push(...symbolResults);
    }

    // Sort by score and limit results
    allResults.sort((a, b) => b.score - a.score);
    const maxResults = options.maxResults || 20;
    
    return allResults.slice(0, maxResults);
  }

  private calculateSymbolScore(matchText: string, query: string, pattern: string): number {
    // Higher score for exact matches
    if (matchText.includes(`${pattern}`)) {
      return 1.0;
    }
    // Lower score for partial matches
    if (matchText.toLowerCase().includes(query.toLowerCase())) {
      return 0.9;
    }
    return 0.8;
  }
}

/**
 * Create symbol search strategy instance
 */
export function createSymbolSearchStrategy(): SearchStrategy {
  return new SymbolSearchStrategy();
}