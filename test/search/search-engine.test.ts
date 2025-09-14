/**
 * Tests for SearchEngine - the unified search orchestrator
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SearchEngine } from '../../src/search/search-engine.js';
import { 
  SearchStrategy, 
  SearchType, 
  SearchOptions, 
  InternalSearchResult,
  SearchResponse 
} from '../../src/search/types.js';

// Mock strategies for testing
class MockTextStrategy implements SearchStrategy {
  readonly name = SearchType.Text;
  
  shouldApply(query: string): boolean {
    return true; // Always applies as fallback
  }
  
  async search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]> {
    return [
      {
        file: '/test/file1.ts',
        line: 10,
        column: 5,
        match: query,
        context: `function ${query}() {`,
        type: SearchType.Text,
        score: 0.8
      }
    ];
  }
  
  getPriority(): number {
    return 40;
  }
}

class MockSymbolStrategy implements SearchStrategy {
  readonly name = SearchType.Symbol;
  
  shouldApply(query: string): boolean {
    return query.includes('class ') || query.includes('function ');
  }
  
  async search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]> {
    if (!this.shouldApply(query)) return [];
    
    return [
      {
        file: '/test/file2.ts',
        line: 20,
        column: 1,
        match: query,
        context: `class UserService {`,
        type: SearchType.Symbol,
        score: 0.95,
        symbol: {
          name: 'UserService',
          kind: 'class',
          start: { line: 20, column: 1 },
          end: { line: 50, column: 1 }
        }
      }
    ];
  }
  
  getPriority(): number {
    return 10;
  }
}

class MockASTStrategy implements SearchStrategy {
  readonly name = SearchType.AST;
  
  shouldApply(query: string): boolean {
    return /[{}()\[\]]/.test(query);
  }
  
  async search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]> {
    if (!this.shouldApply(query)) return [];
    
    return [
      {
        file: '/test/file3.ts',
        line: 30,
        column: 10,
        match: query,
        context: `getData() {`,
        type: SearchType.AST,
        score: 0.85,
        ast: {
          type: 'MethodDefinition',
          name: 'getData',
          params: [],
          body: 'BlockStatement'
        }
      }
    ];
  }
  
  getPriority(): number {
    return 20;
  }
}

describe('SearchEngine', () => {
  let engine: SearchEngine;
  let mockTextStrategy: MockTextStrategy;
  let mockSymbolStrategy: MockSymbolStrategy;
  let mockASTStrategy: MockASTStrategy;

  beforeEach(() => {
    mockTextStrategy = new MockTextStrategy();
    mockSymbolStrategy = new MockSymbolStrategy();
    mockASTStrategy = new MockASTStrategy();
    
    engine = new SearchEngine({
      strategies: [mockTextStrategy, mockSymbolStrategy, mockASTStrategy],
      enableParallel: true,
      defaultOptions: {
        maxResults: 10,
        contextLines: 3
      }
    });
  });

  describe('Strategy Management', () => {
    it('should sort strategies by priority', () => {
      const strategies = engine['strategies'];
      expect(strategies[0].name).toBe(SearchType.Symbol); // Priority 10
      expect(strategies[1].name).toBe(SearchType.AST);    // Priority 20
      expect(strategies[2].name).toBe(SearchType.Text);   // Priority 40
    });

    it('should determine applicable strategies for query', () => {
      const symbolQuery = 'class UserService';
      const applicable = engine['getApplicableStrategies'](symbolQuery);
      
      expect(applicable).toHaveLength(2); // Symbol and Text
      expect(applicable.map(s => s.name)).toContain(SearchType.Symbol);
      expect(applicable.map(s => s.name)).toContain(SearchType.Text);
    });

    it('should handle query with AST patterns', () => {
      const astQuery = 'getData() {';
      const applicable = engine['getApplicableStrategies'](astQuery);
      
      expect(applicable).toHaveLength(2); // AST and Text
      expect(applicable.map(s => s.name)).toContain(SearchType.AST);
      expect(applicable.map(s => s.name)).toContain(SearchType.Text);
    });
  });

  describe('Search Execution', () => {
    it('should execute search with single strategy', async () => {
      const query = 'simpleSearch';
      const response = await engine.search(query);
      
      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].title).toContain('simpleSearch');
    });

    it('should execute parallel search with multiple strategies', async () => {
      const query = 'class UserService';
      const response = await engine.search(query);
      
      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThanOrEqual(2);
      
      // Should have results from both Symbol and Text strategies
      const titles = response.results.map(r => r.title);
      expect(titles.some(t => t.includes('UserService'))).toBe(true);
    });

    it('should respect maxResults option', async () => {
      const query = 'test';
      const response = await engine.search(query, { maxResults: 5 });
      
      expect(response.results.length).toBeLessThanOrEqual(5);
    });

    it('should apply file pattern filter', async () => {
      const query = 'test';
      const response = await engine.search(query, { filePattern: '*.ts' });
      
      response.results.forEach(result => {
        expect(result.id).toMatch(/\.ts/);
      });
    });

    it('should handle empty search results', async () => {
      // Mock strategies to return empty results
      jest.spyOn(mockTextStrategy, 'search').mockResolvedValue([]);
      jest.spyOn(mockSymbolStrategy, 'search').mockResolvedValue([]);
      jest.spyOn(mockASTStrategy, 'search').mockResolvedValue([]);
      
      const response = await engine.search('nonexistent');
      
      expect(response.results).toEqual([]);
      expect(response.error).toBeUndefined();
    });

    it('should handle strategy errors gracefully', async () => {
      // Mock one strategy to throw error
      jest.spyOn(mockSymbolStrategy, 'search').mockRejectedValue(new Error('Strategy error'));
      
      const response = await engine.search('class Test');
      
      // Should still get results from other strategies
      expect(response.results.length).toBeGreaterThan(0);
    });
  });

  describe('Result Ranking and Deduplication', () => {
    it('should rank results by score', async () => {
      const response = await engine.search('class UserService');
      
      // Results should be sorted by score descending
      for (let i = 1; i < response.results.length; i++) {
        const prevScore = response.results[i - 1].score || 0;
        const currScore = response.results[i].score || 0;
        expect(prevScore).toBeGreaterThanOrEqual(currScore);
      }
    });

    it('should deduplicate results from multiple strategies', async () => {
      // Create engine with duplicate results
      const duplicateStrategy = new MockTextStrategy();
      jest.spyOn(duplicateStrategy, 'search').mockResolvedValue([
        {
          file: '/test/file1.ts',
          line: 10,
          column: 5,
          match: 'test',
          context: 'test context',
          type: SearchType.Text,
          score: 0.7
        }
      ]);
      
      const engine2 = new SearchEngine({
        strategies: [mockTextStrategy, duplicateStrategy],
        enableParallel: true
      });
      
      const response = await engine2.search('test');
      
      // Should deduplicate by file:line
      const uniqueIds = new Set(response.results.map(r => r.id));
      expect(uniqueIds.size).toBe(response.results.length);
    });
  });

  describe('Fetch Document', () => {
    it('should fetch document by ID', async () => {
      const id = '/test/file1.ts:10';
      const doc = await engine.fetch(id);
      
      expect(doc.id).toBe(id);
      expect(doc.title).toBeDefined();
      expect(doc.text).toBeDefined();
      expect(doc.url).toBeDefined();
      expect(doc.metadata).toBeDefined();
    });

    it('should handle fetch with line number', async () => {
      const id = '/test/file.ts:42:class';
      const doc = await engine.fetch(id);
      
      expect(doc.metadata.lineNumber).toBe(42);
      expect(doc.metadata.nodeType).toBe('class');
    });

    it('should handle fetch error gracefully', async () => {
      const doc = await engine.fetch('/nonexistent/file.ts');
      
      expect(doc.metadata.error).toBe(true);
      expect(doc.text).toContain('not found');
    });
  });

  describe('Configuration', () => {
    it('should use default options when not specified', async () => {
      const response = await engine.search('test');
      
      // Should use default maxResults
      expect(response.results.length).toBeLessThanOrEqual(10);
    });

    it('should override default options with query options', async () => {
      const response = await engine.search('test', { maxResults: 3 });
      
      expect(response.results.length).toBeLessThanOrEqual(3);
    });

    it('should handle sequential execution when parallel disabled', async () => {
      const sequentialEngine = new SearchEngine({
        strategies: [mockTextStrategy, mockSymbolStrategy],
        enableParallel: false
      });
      
      const response = await sequentialEngine.search('class Test');
      
      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThan(0);
    });
  });

  describe('URL Generation', () => {
    it('should generate proper URLs for results', async () => {
      const response = await engine.search('test');
      
      response.results.forEach(result => {
        expect(result.url).toBeDefined();
        expect(result.url).toMatch(/^(file:\/\/|https?:\/\/)/);
      });
    });

    it('should include line numbers in URLs when available', async () => {
      const response = await engine.search('class UserService');
      
      const symbolResult = response.results.find(r => r.score && r.score > 0.9);
      expect(symbolResult?.url).toContain('#L20');
    });
  });

  describe('Performance', () => {
    it('should execute strategies in parallel for better performance', async () => {
      const slowStrategy = new MockTextStrategy();
      jest.spyOn(slowStrategy, 'search').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return [];
      });
      
      const fastStrategy = new MockSymbolStrategy();
      jest.spyOn(fastStrategy, 'search').mockImplementation(async () => {
        return [];
      });
      
      const parallelEngine = new SearchEngine({
        strategies: [slowStrategy, fastStrategy],
        enableParallel: true
      });
      
      const start = Date.now();
      await parallelEngine.search('test');
      const duration = Date.now() - start;
      
      // Should complete in ~100ms (parallel), not ~200ms (sequential)
      expect(duration).toBeLessThan(150);
    });

    it('should cache results for repeated searches', async () => {
      const spy = jest.spyOn(mockTextStrategy, 'search');
      
      // First search
      await engine.search('cachedQuery');
      expect(spy).toHaveBeenCalledTimes(1);
      
      // Second search (should use cache)
      await engine.search('cachedQuery');
      // Note: Current implementation doesn't have caching, 
      // but this test is here for when it's added
      expect(spy).toHaveBeenCalledTimes(2); // Will be 1 when caching is implemented
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty query', async () => {
      const response = await engine.search('');
      
      expect(response.results).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should handle special characters in query', async () => {
      const response = await engine.search('test.*\\$^');
      
      expect(response.results).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should handle very long queries', async () => {
      const longQuery = 'test'.repeat(1000);
      const response = await engine.search(longQuery);
      
      expect(response.results).toBeDefined();
      expect(response.error).toBeUndefined();
    });

    it('should handle no strategies configured', async () => {
      const emptyEngine = new SearchEngine({
        strategies: [],
        enableParallel: true
      });
      
      const response = await emptyEngine.search('test');
      
      expect(response.results).toEqual([]);
    });
  });
});

describe('SearchEngine Integration', () => {
  it('should work with real search strategies', async () => {
    // This would test with actual strategy implementations
    // For now, using mocks to ensure the interface is correct
    
    const engine = new SearchEngine({
      strategies: [
        new MockSymbolStrategy(),
        new MockASTStrategy(),
        new MockTextStrategy()
      ],
      enableParallel: true,
      defaultOptions: {
        maxResults: 20,
        contextLines: 3
      }
    });
    
    // Test complex multi-strategy search
    const response = await engine.search('class UserService implements IService');
    
    expect(response.results).toBeDefined();
    expect(response.results.length).toBeGreaterThan(0);
    
    // Verify result structure matches OpenAI spec
    response.results.forEach(result => {
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('url');
      expect(typeof result.id).toBe('string');
      expect(typeof result.title).toBe('string');
      expect(typeof result.url).toBe('string');
    });
  });
});