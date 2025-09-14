/**
 * Search implementation
 * Follows OpenAI specification for search and fetch tools
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SearchEngine } from './search-engine.js';
import { createTextSearchStrategy } from './strategies/text-search.js';
import { createASTSearchStrategy } from './strategies/ast-search.js';
import { createSymbolSearchStrategy } from './strategies/symbol-search.js';
import { createVectorSearchStrategy } from './strategies/vector-search.js';
import { createFileSearchStrategy } from './strategies/file-search.js';

// Initialize search engine with all strategies
let searchEngine: SearchEngine | null = null;

function getSearchEngine(): SearchEngine {
  if (!searchEngine) {
    searchEngine = new SearchEngine({
      strategies: [
        createSymbolSearchStrategy(),  // Priority 10
        createASTSearchStrategy(),     // Priority 20
        createVectorSearchStrategy(),  // Priority 30
        createTextSearchStrategy(),    // Priority 40
        createFileSearchStrategy(),    // Priority 50
      ],
      enableParallel: true,
      defaultOptions: {
        maxResults: 20,
        contextLines: 3
      }
    });
  }
  return searchEngine;
}

/**
 * Search tool
 * Returns search results from multiple sources
 */
export const searchTool: Tool = {
  name: 'search',
  description: 'Search across codebase, documentation, and knowledge base using unified multi-modal search',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 20
      },
      filePattern: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts", "src/**/*.js")'
      }
    },
    required: ['query']
  }
};

/**
 * Fetch tool
 * Retrieves full content of a document by ID
 */
export const fetchTool: Tool = {
  name: 'fetch',
  description: 'Fetch the full content of a document or code file by its ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Unique identifier for the document to fetch'
      }
    },
    required: ['id']
  }
};

/**
 * Execute search
 */
export async function executeSearch(
  query: string, 
  options?: { maxResults?: number; filePattern?: string }
): Promise<{ content: any[] }> {
  try {
    const engine = getSearchEngine();
    const response = await engine.search(query, options);
    
    // Return standard response
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ results: [], error: error.message })
      }]
    };
  }
}

/**
 * Execute fetch
 */
export async function executeFetch(id: string): Promise<{ content: any[] }> {
  try {
    const engine = getSearchEngine();
    const document = await engine.fetch(id);
    
    // Return response
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(document)
      }]
    };
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id,
          title: 'Error',
          text: `Failed to fetch document: ${error.message}`,
          url: '',
          metadata: { error: true }
        })
      }]
    };
  }
}

/**
 * Execute search tool handler
 */
export async function executeSearchTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'search':
      return executeSearch(args.query, {
        maxResults: args.maxResults,
        filePattern: args.filePattern
      });
    
    case 'fetch':
      return executeFetch(args.id);
    
    default:
      throw new Error(`Unknown search tool: ${name}`);
  }
}

// Export search tools
export const searchTools: Tool[] = [searchTool, fetchTool];

// Export types and strategies for extensibility
export * from './types.js';
export * from './search-engine.js';
export { createTextSearchStrategy } from './strategies/text-search.js';
export { createASTSearchStrategy } from './strategies/ast-search.js';
export { createSymbolSearchStrategy } from './strategies/symbol-search.js';
export { createVectorSearchStrategy } from './strategies/vector-search.js';
export { createFileSearchStrategy } from './strategies/file-search.js';

// Export URL and file serving utilities
export * from './url-helper.js';
export * from './file-server.js';
export * from './secure-tunnel.js';