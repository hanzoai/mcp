/**
 * Vector search strategy using LanceDB
 */

import { SearchStrategy, SearchType, SearchOptions, InternalSearchResult } from '../types.js';
import { getVectorStore } from '../../vector/lancedb-store.js';

export class VectorSearchStrategy implements SearchStrategy {
  readonly name = SearchType.Vector;

  shouldApply(query: string): boolean {
    // Apply for natural language queries (not code patterns)
    const words = query.split(/\s+/);
    const hasCodePattern = /[{}()<>\[\];,.]/.test(query);
    const isNaturalLanguage = words.length > 3 && !hasCodePattern;
    
    return isNaturalLanguage;
  }

  getPriority(): number {
    return 30; // Medium priority for semantic search
  }

  async search(query: string, options: SearchOptions = {}): Promise<InternalSearchResult[]> {
    const { 
      maxResults = 10,
      minScore = 0.7 
    } = options;

    try {
      const store = await getVectorStore();
      const results = await store.search(query, 'documents', maxResults, minScore);
      
      return results.map((doc, idx) => ({
        id: `vector:${doc.id}`,
        title: doc.metadata.title || `Vector Result ${idx + 1}`,
        url: doc.metadata.url || `vector://${doc.id}`,
        filePath: doc.metadata.file_path || '',
        lineNumber: doc.metadata.line_number || 0,
        column: 0,
        matchText: doc.content.substring(0, 200),
        contextBefore: [],
        contextAfter: [],
        matchType: SearchType.Vector,
        score: doc.score,
        semanticContext: doc.content
      }));
    } catch (error) {
      console.error('Vector search error:', error);
      return [];
    }
  }
}

/**
 * Create vector search strategy instance
 */
export function createVectorSearchStrategy(): SearchStrategy {
  return new VectorSearchStrategy();
}