/**
 * Core types for the search system
 */

/**
 * Search result structure following OpenAI specification
 */
export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

/**
 * Document structure for fetch operations
 */
export interface Document {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, any>;
}

/**
 * Internal search result with extended details
 */
export interface InternalSearchResult extends SearchResult {
  filePath: string;
  lineNumber: number;
  column: number;
  matchText: string;
  contextBefore: string[];
  contextAfter: string[];
  matchType: SearchType;
  score: number;
  nodeType?: string;
  semanticContext?: string;
}

/**
 * Search types enumeration
 */
export enum SearchType {
  Text = 'text',
  AST = 'ast',
  Symbol = 'symbol',
  Vector = 'vector',
  Memory = 'memory',
  File = 'file'
}

/**
 * Search options
 */
export interface SearchOptions {
  maxResults?: number;
  contextLines?: number;
  caseSensitive?: boolean;
  filePattern?: string;
  language?: string;
  minScore?: number;
}

/**
 * Base search strategy interface
 */
export interface SearchStrategy {
  /**
   * Strategy name
   */
  readonly name: SearchType;
  
  /**
   * Check if this strategy should be used for the given query
   */
  shouldApply(query: string): boolean;
  
  /**
   * Execute the search
   */
  search(query: string, options?: SearchOptions): Promise<InternalSearchResult[]>;
  
  /**
   * Get priority for result ranking (lower is higher priority)
   */
  getPriority(): number;
}

/**
 * Fetch strategy interface
 */
export interface FetchStrategy {
  /**
   * Check if this strategy can handle the document ID
   */
  canHandle(id: string): boolean;
  
  /**
   * Fetch the document
   */
  fetch(id: string): Promise<Document>;
}

/**
 * Search response structure
 */
export interface SearchResponse {
  results: SearchResult[];
  error?: string;
}