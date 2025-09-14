/**
 * Unified search engine that composes multiple search strategies
 */

import path from 'path';
import { promises as fs } from 'fs';
import {
  SearchStrategy,
  SearchOptions,
  SearchResult,
  InternalSearchResult,
  Document,
  FetchStrategy,
  SearchResponse
} from './types.js';
import { getUrlHelper } from './url-helper.js';

/**
 * Search engine configuration
 */
export interface SearchEngineConfig {
  strategies?: SearchStrategy[];
  fetchStrategies?: FetchStrategy[];
  enableParallel?: boolean;
  defaultOptions?: SearchOptions;
}

/**
 * Unified search engine
 */
export class SearchEngine {
  private strategies: SearchStrategy[];
  private fetchStrategies: FetchStrategy[];
  private enableParallel: boolean;
  private defaultOptions: SearchOptions;

  constructor(config: SearchEngineConfig = {}) {
    this.strategies = config.strategies || [];
    this.fetchStrategies = config.fetchStrategies || [];
    this.enableParallel = config.enableParallel ?? true;
    this.defaultOptions = config.defaultOptions || {
      maxResults: 20,
      contextLines: 3
    };
  }

  /**
   * Add a search strategy
   */
  addStrategy(strategy: SearchStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Add a fetch strategy
   */
  addFetchStrategy(strategy: FetchStrategy): void {
    this.fetchStrategies.push(strategy);
  }

  /**
   * Execute search across all applicable strategies
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    try {
      const mergedOptions = { ...this.defaultOptions, ...options };
      
      // Determine which strategies to use
      const applicableStrategies = this.strategies.filter(s => s.shouldApply(query));
      
      // If no strategies apply, use text search as fallback
      if (applicableStrategies.length === 0) {
        const textStrategy = this.strategies.find(s => s.name === 'text');
        if (textStrategy) {
          applicableStrategies.push(textStrategy);
        }
      }

      // Execute searches
      let allResults: InternalSearchResult[] = [];
      
      if (this.enableParallel) {
        // Parallel execution
        const searchPromises = applicableStrategies.map(strategy => 
          strategy.search(query, mergedOptions)
        );
        const results = await Promise.all(searchPromises);
        allResults = results.flat();
      } else {
        // Sequential execution
        for (const strategy of applicableStrategies) {
          const results = await strategy.search(query, mergedOptions);
          allResults.push(...results);
        }
      }

      // Rank and deduplicate
      const rankedResults = this.rankAndDeduplicate(allResults, mergedOptions.maxResults || 20);
      
      // Convert to standard format
      const searchResults: SearchResult[] = rankedResults.map(r => ({
        id: this.generateDocumentId(r),
        title: this.generateTitle(r),
        url: this.generateUrl(r)
      }));

      return {
        results: searchResults
      };
    } catch (error: any) {
      return {
        results: [],
        error: error.message
      };
    }
  }

  /**
   * Fetch document by ID
   */
  async fetch(id: string): Promise<Document> {
    // Try custom fetch strategies first
    for (const strategy of this.fetchStrategies) {
      if (strategy.canHandle(id)) {
        return strategy.fetch(id);
      }
    }

    // Default fetch implementation
    const docInfo = this.parseDocumentId(id);
    
    if (docInfo.type === 'file') {
      const content = await fs.readFile(docInfo.path, 'utf-8');
      const title = path.basename(docInfo.path);
      
      let text = content;
      const metadata: Record<string, any> = {
        type: 'file',
        language: this.detectLanguage(docInfo.path),
        lines: content.split('\n').length
      };

      // If specific line requested, extract relevant section
      if (docInfo.lineNumber) {
        const lines = content.split('\n');
        const startLine = Math.max(0, docInfo.lineNumber - 50);
        const endLine = Math.min(lines.length, docInfo.lineNumber + 50);
        text = lines.slice(startLine, endLine).join('\n');
        metadata.excerpt = true;
        metadata.startLine = startLine + 1;
        metadata.endLine = endLine;
      }

      const urlHelper = getUrlHelper();
      return {
        id,
        title,
        text,
        url: urlHelper.generateFileUrl(docInfo.path, docInfo.lineNumber),
        metadata
      };
    }

    throw new Error(`Unable to fetch document: ${id}`);
  }

  /**
   * Rank and deduplicate results
   */
  private rankAndDeduplicate(
    results: InternalSearchResult[], 
    maxResults: number
  ): InternalSearchResult[] {
    // Deduplicate by ID
    const seen = new Set<string>();
    const unique: InternalSearchResult[] = [];
    
    for (const result of results) {
      const id = this.generateDocumentId(result);
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(result);
      }
    }

    // Sort by score and strategy priority
    const strategyPriority = new Map<string, number>();
    this.strategies.forEach(s => {
      strategyPriority.set(s.name, s.getPriority());
    });

    unique.sort((a, b) => {
      // First by score
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
      
      // Then by strategy priority
      const aPriority = strategyPriority.get(a.matchType) || 100;
      const bPriority = strategyPriority.get(b.matchType) || 100;
      return aPriority - bPriority;
    });

    return unique.slice(0, maxResults);
  }

  /**
   * Generate document ID from result
   */
  private generateDocumentId(result: InternalSearchResult): string {
    if (result.matchType === 'vector' || result.matchType === 'memory') {
      return result.id;
    }
    
    const urlHelper = getUrlHelper();
    return urlHelper.generateDocumentId(
      result.filePath,
      result.lineNumber > 0 ? result.lineNumber : undefined,
      result.nodeType
    );
  }

  /**
   * Generate title from result
   */
  private generateTitle(result: InternalSearchResult): string {
    if (result.title) return result.title;
    
    const fileName = path.basename(result.filePath);
    if (result.lineNumber > 0) {
      return `${fileName}:${result.lineNumber}`;
    }
    return fileName;
  }

  /**
   * Generate URL from result
   */
  private generateUrl(result: InternalSearchResult): string {
    if (result.url) return result.url;
    
    const urlHelper = getUrlHelper();
    return urlHelper.generateFileUrl(
      result.filePath,
      result.lineNumber > 0 ? result.lineNumber : undefined
    );
  }

  /**
   * Parse document ID
   */
  private parseDocumentId(id: string): any {
    if (id.startsWith('vector:')) {
      return { type: 'vector', id: id.substring(7) };
    }
    if (id.startsWith('memory:')) {
      return { type: 'memory', id: id.substring(7) };
    }
    
    const urlHelper = getUrlHelper();
    const parsed = urlHelper.parseDocumentId(id);
    
    return {
      type: 'file',
      path: parsed.filePath,
      lineNumber: parsed.lineNumber,
      nodeType: parsed.nodeType
    };
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript',
      '.py': 'python', '.rs': 'rust',
      '.go': 'go', '.java': 'java',
      '.cpp': 'cpp', '.c': 'c'
    };
    return langMap[ext] || 'text';
  }
}