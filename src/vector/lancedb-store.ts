/**
 * LanceDB Vector Store for MCP
 * Local vector database for embeddings and semantic search
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Vector store configuration
export interface VectorStoreConfig {
  dataDir?: string;
  embeddingModel?: string;
  dimensions?: number;
  indexName?: string;
}

// Document types for vector store
export interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
  embedding?: number[];
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'variable' | 'method' | 'interface' | 'type';
  filePath: string;
  lineNumber: number;
  signature?: string;
  docstring?: string;
  embedding?: number[];
}

export interface Memory {
  id: string;
  type: 'conversation' | 'knowledge' | 'code';
  content: string;
  timestamp: Date;
  metadata: Record<string, any>;
  embedding?: number[];
}

/**
 * LanceDB vector store implementation
 */
export class LanceDBStore {
  private config: VectorStoreConfig;
  private dataPath: string;
  private initialized: boolean = false;

  constructor(config: VectorStoreConfig = {}) {
    this.config = {
      dataDir: config.dataDir || path.join(process.env.HOME || '', '.hanzo', 'lancedb'),
      embeddingModel: config.embeddingModel || 'all-MiniLM-L6-v2',
      dimensions: config.dimensions || 384,
      indexName: config.indexName || 'default'
    };
    this.dataPath = path.join(this.config.dataDir!, this.config.indexName!);
  }

  /**
   * Initialize the vector store
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create data directory
    await fs.mkdir(this.dataPath, { recursive: true });

    // Initialize LanceDB tables
    await this.createTables();
    
    this.initialized = true;
  }

  /**
   * Create database tables
   */
  private async createTables(): Promise<void> {
    // Create tables for different data types
    const tables = [
      'documents',
      'symbols',
      'memories',
      'ast_nodes',
      'code_chunks'
    ];

    for (const table of tables) {
      const tablePath = path.join(this.dataPath, `${table}.lance`);
      try {
        await fs.access(tablePath);
      } catch {
        // Table doesn't exist, create it
        await this.createTable(table);
      }
    }
  }

  /**
   * Create a new table
   */
  private async createTable(tableName: string): Promise<void> {
    // This would use LanceDB Python bindings or CLI
    // For now, create directory structure
    const tablePath = path.join(this.dataPath, `${tableName}.lance`);
    await fs.mkdir(tablePath, { recursive: true });
  }

  /**
   * Add document to vector store
   */
  async addDocument(doc: Document): Promise<void> {
    // Generate embedding if not provided
    if (!doc.embedding) {
      doc.embedding = await this.generateEmbedding(doc.content);
    }

    // Store document
    await this.storeVector('documents', {
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      embedding: doc.embedding
    });
  }

  /**
   * Add symbol to vector store
   */
  async addSymbol(symbol: Symbol): Promise<void> {
    // Generate embedding from symbol signature and docstring
    const text = `${symbol.type} ${symbol.name} ${symbol.signature || ''} ${symbol.docstring || ''}`;
    symbol.embedding = await this.generateEmbedding(text);

    // Store symbol
    await this.storeVector('symbols', symbol);
  }

  /**
   * Add memory to vector store
   */
  async addMemory(memory: Memory): Promise<void> {
    // Generate embedding if not provided
    if (!memory.embedding) {
      memory.embedding = await this.generateEmbedding(memory.content);
    }

    // Store memory
    await this.storeVector('memories', memory);
  }

  /**
   * Search for similar vectors
   */
  async search(
    query: string,
    table: string = 'documents',
    limit: number = 10,
    threshold: number = 0.7
  ): Promise<any[]> {
    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Search in table
    return this.searchVectors(table, queryEmbedding, limit, threshold);
  }

  /**
   * Search for similar symbols
   */
  async searchSymbols(
    query: string,
    symbolType?: string,
    limit: number = 10
  ): Promise<Symbol[]> {
    const queryEmbedding = await this.generateEmbedding(query);
    const results = await this.searchVectors('symbols', queryEmbedding, limit, 0.6);
    
    // Filter by symbol type if specified
    if (symbolType) {
      return results.filter((s: Symbol) => s.type === symbolType);
    }
    
    return results;
  }

  /**
   * Search memories
   */
  async searchMemories(
    query: string,
    memoryType?: string,
    limit: number = 10
  ): Promise<Memory[]> {
    const queryEmbedding = await this.generateEmbedding(query);
    const results = await this.searchVectors('memories', queryEmbedding, limit, 0.7);
    
    // Filter by memory type if specified
    if (memoryType) {
      return results.filter((m: Memory) => m.type === memoryType);
    }
    
    return results;
  }

  /**
   * Generate embedding for text
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    // Use sentence-transformers or OpenAI embeddings
    // For now, return mock embedding
    return new Array(this.config.dimensions).fill(0).map(() => Math.random());
  }

  /**
   * Store vector in database
   */
  private async storeVector(table: string, data: any): Promise<void> {
    const tablePath = path.join(this.dataPath, `${table}.lance`);
    const dataFile = path.join(tablePath, `${Date.now()}.json`);
    await fs.writeFile(dataFile, JSON.stringify(data));
  }

  /**
   * Search vectors in table
   */
  private async searchVectors(
    table: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number
  ): Promise<any[]> {
    const tablePath = path.join(this.dataPath, `${table}.lance`);
    const files = await fs.readdir(tablePath);
    
    const results: Array<{ data: any; similarity: number }> = [];
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const data = JSON.parse(
        await fs.readFile(path.join(tablePath, file), 'utf-8')
      );
      
      if (data.embedding) {
        const similarity = this.cosineSimilarity(queryEmbedding, data.embedding);
        if (similarity >= threshold) {
          results.push({ data, similarity });
        }
      }
    }
    
    // Sort by similarity and return top results
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit).map(r => r.data);
  }

  /**
   * Calculate cosine similarity between vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Index code files
   */
  async indexCodebase(directory: string): Promise<void> {
    const files = await this.getCodeFiles(directory);
    
    for (const file of files) {
      await this.indexFile(file);
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const language = this.detectLanguage(filePath);
    
    // Extract symbols using TreeSitter
    const symbols = await this.extractSymbols(content, language);
    
    // Store symbols
    for (const symbol of symbols) {
      await this.addSymbol({
        ...symbol,
        filePath
      });
    }
    
    // Chunk and store document
    const chunks = this.chunkCode(content);
    for (let i = 0; i < chunks.length; i++) {
      await this.addDocument({
        id: `${filePath}:${i}`,
        content: chunks[i],
        metadata: {
          filePath,
          chunkIndex: i,
          language
        }
      });
    }
  }

  /**
   * Get code files from directory
   */
  private async getCodeFiles(directory: string): Promise<string[]> {
    const extensions = ['.ts', '.js', '.py', '.rs', '.go', '.java', '.cpp', '.c'];
    const files: string[] = [];
    
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    };
    
    await walk(directory);
    return files;
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    const langMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c'
    };
    return langMap[ext] || 'text';
  }

  /**
   * Extract symbols from code
   */
  private async extractSymbols(content: string, language: string): Promise<Symbol[]> {
    // This would use TreeSitter to extract symbols
    // For now, use regex patterns
    const symbols: Symbol[] = [];
    const lines = content.split('\n');
    
    // Language-specific patterns
    const patterns: Record<string, RegExp[]> = {
      typescript: [
        /^export\s+(function|const|class|interface|type)\s+(\w+)/,
        /^(function|const|class|interface|type)\s+(\w+)/
      ],
      javascript: [
        /^export\s+(function|const|class)\s+(\w+)/,
        /^(function|const|class)\s+(\w+)/
      ],
      python: [
        /^def\s+(\w+)/,
        /^class\s+(\w+)/
      ],
      rust: [
        /^pub\s+(fn|struct|enum|trait)\s+(\w+)/,
        /^(fn|struct|enum|trait)\s+(\w+)/
      ]
    };
    
    const langPatterns = patterns[language] || [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of langPatterns) {
        const match = line.match(pattern);
        if (match) {
          const type = match[1] as any;
          const name = match[2];
          symbols.push({
            name,
            type: type === 'def' || type === 'fn' ? 'function' : type,
            filePath: '',
            lineNumber: i + 1
          });
        }
      }
    }
    
    return symbols;
  }

  /**
   * Chunk code into segments
   */
  private chunkCode(content: string, chunkSize: number = 1000): string[] {
    const chunks: string[] = [];
    const lines = content.split('\n');
    let currentChunk = '';
    
    for (const line of lines) {
      if (currentChunk.length + line.length > chunkSize && currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      currentChunk += line + '\n';
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    await fs.rm(this.dataPath, { recursive: true, force: true });
    this.initialized = false;
  }
}

// Global vector store instance
let vectorStore: LanceDBStore | null = null;

/**
 * Get or create vector store instance
 */
export async function getVectorStore(config?: VectorStoreConfig): Promise<LanceDBStore> {
  if (!vectorStore) {
    vectorStore = new LanceDBStore(config);
    await vectorStore.initialize();
  }
  return vectorStore;
}

/**
 * Index current project
 */
export async function indexProject(projectPath: string = process.cwd()): Promise<void> {
  const store = await getVectorStore();
  await store.indexCodebase(projectPath);
  console.log(`Indexed project at ${projectPath}`);
}