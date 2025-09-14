/**
 * Unified Search Tool for MCP
 * Combines text, AST, symbol, vector, and memory search
 */

import { z } from 'zod';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import * as glob from 'glob';

// Search result types
export interface SearchResult {
  filePath: string;
  lineNumber: number;
  column: number;
  matchText: string;
  contextBefore: string[];
  contextAfter: string[];
  matchType: 'text' | 'ast' | 'vector' | 'symbol' | 'memory' | 'file';
  score: number;
  nodeType?: string;
  semanticContext?: string;
}

// Search modality enum
export enum SearchModality {
  Text = 'text',
  AST = 'ast',
  Symbol = 'symbol',
  Vector = 'vector',
  Memory = 'memory',
  File = 'file'
}

/**
 * Unified search tool combining multiple search strategies
 */
export const unifiedSearchTool: Tool = {
  name: 'unified_search',
  description: 'Intelligent multi-modal search combining text, AST, symbol, vector, and memory search',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (natural language, code pattern, or regex)'
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in',
        default: '.'
      },
      modalities: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['text', 'ast', 'symbol', 'vector', 'memory', 'file']
        },
        description: 'Search modalities to use (auto-detected if not specified)'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results per modality',
        default: 20
      },
      contextLines: {
        type: 'number',
        description: 'Lines of context around matches',
        default: 3
      },
      filePattern: {
        type: 'string',
        description: 'File pattern to include (e.g., "*.ts")'
      },
      language: {
        type: 'string',
        description: 'Programming language for AST parsing',
        enum: ['python', 'javascript', 'typescript', 'rust', 'go', 'java', 'cpp', 'c']
      }
    },
    required: ['query']
  }
};

/**
 * AST search tool using TreeSitter
 */
export const astSearchTool: Tool = {
  name: 'ast_search',
  description: 'Search code using TreeSitter AST parsing for semantic understanding',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'AST pattern or code to search for'
      },
      path: {
        type: 'string',
        description: 'Directory or file to search',
        default: '.'
      },
      language: {
        type: 'string',
        description: 'Programming language',
        enum: ['python', 'javascript', 'typescript', 'rust', 'go', 'java', 'cpp', 'c']
      },
      nodeTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'AST node types to match (e.g., "function_definition", "class_definition")'
      },
      includeContext: {
        type: 'boolean',
        description: 'Include surrounding AST context',
        default: true
      }
    },
    required: ['pattern']
  }
};

/**
 * Symbol search tool for finding definitions
 */
export const symbolSearchTool: Tool = {
  name: 'symbol_search',
  description: 'Search for symbol definitions (functions, classes, variables) across codebase',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Symbol name to search for'
      },
      symbolType: {
        type: 'string',
        enum: ['function', 'class', 'variable', 'method', 'interface', 'type', 'any'],
        description: 'Type of symbol to find',
        default: 'any'
      },
      path: {
        type: 'string',
        description: 'Directory to search',
        default: '.'
      },
      includeReferences: {
        type: 'boolean',
        description: 'Include references to the symbol',
        default: false
      }
    },
    required: ['symbol']
  }
};

/**
 * Vector search tool using embeddings
 */
export const vectorSearchTool: Tool = {
  name: 'vector_search',
  description: 'Semantic search using vector embeddings for finding similar code or documentation',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query or code snippet'
      },
      path: {
        type: 'string',
        description: 'Directory to search',
        default: '.'
      },
      threshold: {
        type: 'number',
        description: 'Similarity threshold (0-1)',
        default: 0.7
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return',
        default: 10
      },
      indexName: {
        type: 'string',
        description: 'Vector index to use',
        default: 'default'
      }
    },
    required: ['query']
  }
};

/**
 * Execute unified search
 */
export async function executeUnifiedSearch(args: any): Promise<SearchResult[]> {
  const { query, path: searchPath = '.', modalities, maxResults = 20, contextLines = 3 } = args;
  
  // Auto-detect search modalities if not specified
  const searchModalities = modalities || detectSearchModalities(query);
  
  // Execute searches in parallel
  const searchPromises = searchModalities.map((modality: SearchModality) => {
    switch (modality) {
      case SearchModality.Text:
        return executeTextSearch(query, searchPath, maxResults, contextLines);
      case SearchModality.AST:
        return executeASTSearch(query, searchPath, maxResults, contextLines);
      case SearchModality.Symbol:
        return executeSymbolSearch(query, searchPath, maxResults);
      case SearchModality.Vector:
        return executeVectorSearch(query, searchPath, maxResults);
      case SearchModality.Memory:
        return executeMemorySearch(query, maxResults);
      case SearchModality.File:
        return executeFileSearch(query, searchPath, maxResults);
      default:
        return Promise.resolve([]);
    }
  });
  
  // Wait for all searches and combine results
  const allResults = await Promise.all(searchPromises);
  const combinedResults = allResults.flat();
  
  // Deduplicate and rank results
  return rankAndDeduplicate(combinedResults, maxResults);
}

/**
 * Detect appropriate search modalities based on query
 */
function detectSearchModalities(query: string): SearchModality[] {
  const modalities: SearchModality[] = [];
  
  // Natural language query - use vector search
  if (query.split(' ').length > 3 && !hasCodePattern(query)) {
    modalities.push(SearchModality.Vector);
  }
  
  // Code patterns - use AST search
  if (hasCodePattern(query)) {
    modalities.push(SearchModality.AST);
  }
  
  // Single identifier - use symbol search
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query)) {
    modalities.push(SearchModality.Symbol);
  }
  
  // Always include text search as fallback
  modalities.push(SearchModality.Text);
  
  // File pattern
  if (query.includes('/') || query.includes('.')) {
    modalities.push(SearchModality.File);
  }
  
  return [...new Set(modalities)];
}

/**
 * Check if query contains code patterns
 */
function hasCodePattern(query: string): boolean {
  const codePatterns = [
    /class\s+\w+/,
    /function\s+\w+/,
    /def\s+\w+/,
    /interface\s+\w+/,
    /struct\s+\w+/,
    /enum\s+\w+/,
    /type\s+\w+/,
    /const\s+\w+/,
    /let\s+\w+/,
    /var\s+\w+/,
    /import\s+/,
    /from\s+/,
    /\w+\(.*\)/,  // Function calls
    /\w+\.\w+/,   // Method calls
  ];
  
  return codePatterns.some(pattern => pattern.test(query));
}

/**
 * Execute text search using ripgrep
 */
async function executeTextSearch(
  query: string,
  searchPath: string,
  maxResults: number,
  contextLines: number
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--max-count', maxResults.toString(),
      '-C', contextLines.toString(),
      query,
      searchPath
    ];
    
    const rg = spawn('rg', args);
    const results: SearchResult[] = [];
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
            results.push({
              filePath: json.data.path.text,
              lineNumber: json.data.line_number,
              column: json.data.submatches[0]?.start || 0,
              matchText: json.data.lines.text,
              contextBefore: [],
              contextAfter: [],
              matchType: 'text',
              score: 1.0
            });
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    });
    
    rg.on('close', () => resolve(results));
    rg.on('error', () => resolve([])); // Fallback on error
  });
}

/**
 * Execute AST search using grep-ast
 */
async function executeASTSearch(
  query: string,
  searchPath: string,
  maxResults: number,
  contextLines: number
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    // Use grep-ast if available
    const args = [
      query,
      searchPath,
      '--json',
      '--max-count', maxResults.toString()
    ];
    
    const grepAst = spawn('grep-ast', args);
    const results: SearchResult[] = [];
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
            filePath: json.file,
            lineNumber: json.line,
            column: json.column || 0,
            matchText: json.match,
            contextBefore: json.context_before || [],
            contextAfter: json.context_after || [],
            matchType: 'ast',
            score: 0.95,
            nodeType: json.node_type,
            semanticContext: json.semantic_context
          });
        }
      } catch (e) {
        // Fallback to text search if grep-ast fails
      }
      resolve(results);
    });
    
    grepAst.on('error', () => resolve([]));
  });
}

/**
 * Execute symbol search
 */
async function executeSymbolSearch(
  query: string,
  searchPath: string,
  maxResults: number
): Promise<SearchResult[]> {
  // Use ctags or tree-sitter for symbol search
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
    `enum ${query}`
  ];
  
  const results: SearchResult[] = [];
  
  for (const pattern of patterns) {
    const textResults = await executeTextSearch(pattern, searchPath, maxResults, 0);
    results.push(...textResults.map(r => ({
      ...r,
      matchType: 'symbol' as const,
      score: 0.9
    })));
  }
  
  return results;
}

/**
 * Execute vector search using embeddings
 */
async function executeVectorSearch(
  query: string,
  searchPath: string,
  maxResults: number
): Promise<SearchResult[]> {
  // This would integrate with LanceDB or another vector store
  // For now, return empty array as placeholder
  console.log('Vector search not yet implemented in TypeScript');
  return [];
}

/**
 * Execute memory search
 */
async function executeMemorySearch(
  query: string,
  maxResults: number
): Promise<SearchResult[]> {
  // This would search conversation history and knowledge base
  // For now, return empty array as placeholder
  console.log('Memory search not yet implemented in TypeScript');
  return [];
}

/**
 * Execute file search
 */
async function executeFileSearch(
  query: string,
  searchPath: string,
  maxResults: number
): Promise<SearchResult[]> {
  const pattern = `**/*${query}*`;
  const files = await glob.glob(pattern, {
    cwd: searchPath,
    ignore: ['node_modules/**', '.git/**'],
    absolute: true
  });
  
  return files.slice(0, maxResults).map(file => ({
    filePath: file,
    lineNumber: 0,
    column: 0,
    matchText: path.basename(file),
    contextBefore: [],
    contextAfter: [],
    matchType: 'file' as const,
    score: 0.8
  }));
}

/**
 * Rank and deduplicate search results
 */
function rankAndDeduplicate(results: SearchResult[], maxResults: number): SearchResult[] {
  // Deduplicate by file path and line number
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  
  for (const result of results) {
    const key = `${result.filePath}:${result.lineNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(result);
    }
  }
  
  // Sort by score and match type priority
  const priority: Record<string, number> = {
    'symbol': 1,
    'ast': 2,
    'vector': 3,
    'text': 4,
    'memory': 5,
    'file': 6
  };
  
  unique.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.1) return scoreDiff;
    
    const aPriority = priority[a.matchType] || 10;
    const bPriority = priority[b.matchType] || 10;
    return aPriority - bPriority;
  });
  
  return unique.slice(0, maxResults);
}

/**
 * Execute search tool handler
 */
export async function executeSearchTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'unified_search':
      const results = await executeUnifiedSearch(args);
      return {
        content: [{
          type: 'text',
          text: formatSearchResults(results)
        }]
      };
    
    case 'ast_search':
      const astResults = await executeASTSearch(
        args.pattern,
        args.path || '.',
        20,
        args.includeContext ? 3 : 0
      );
      return {
        content: [{
          type: 'text',
          text: formatSearchResults(astResults)
        }]
      };
    
    case 'symbol_search':
      const symbolResults = await executeSymbolSearch(
        args.symbol,
        args.path || '.',
        20
      );
      return {
        content: [{
          type: 'text',
          text: formatSearchResults(symbolResults)
        }]
      };
    
    case 'vector_search':
      const vectorResults = await executeVectorSearch(
        args.query,
        args.path || '.',
        args.maxResults || 10
      );
      return {
        content: [{
          type: 'text',
          text: formatSearchResults(vectorResults)
        }]
      };
    
    default:
      throw new Error(`Unknown search tool: ${name}`);
  }
}

/**
 * Format search results for display
 */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found';
  }
  
  const grouped = new Map<string, SearchResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.filePath) || [];
    existing.push(result);
    grouped.set(result.filePath, existing);
  }
  
  let output = `Found ${results.length} results in ${grouped.size} files:\n\n`;
  
  for (const [file, fileResults] of grouped) {
    output += `${file}:\n`;
    for (const result of fileResults) {
      output += `  Line ${result.lineNumber}: ${result.matchText.trim()}`;
      if (result.nodeType) {
        output += ` [${result.nodeType}]`;
      }
      output += ` (${result.matchType}, score: ${result.score.toFixed(2)})\n`;
    }
    output += '\n';
  }
  
  return output;
}

// Export all search tools
export const searchTools: Tool[] = [
  unifiedSearchTool,
  astSearchTool,
  symbolSearchTool,
  vectorSearchTool
];