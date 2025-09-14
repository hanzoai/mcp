/**
 * Integration tests for MCP Search implementation
 * Tests the complete search flow with OpenAI MCP specification compliance
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { executeSearch, executeFetch, executeSearchTool } from '../../src/search/index.js';
import { SearchEngine } from '../../src/search/search-engine.js';
import { getSecureTunnel } from '../../src/search/secure-tunnel.js';
import { getUrlHelper } from '../../src/search/url-helper.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Mock child_process for ngrok
jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

// Mock file system for testing
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn(),
    access: jest.fn()
  }
}));

describe('MCP Search Integration', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let testDir: string;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    
    // Set up test directory
    testDir = '/test/workspace';
    process.env.MCP_WORKSPACE_ROOT = testDir;
    
    // Clear security-related env vars
    delete process.env.NGROK_API_KEY;
    delete process.env.NGROK_AUTHTOKEN;
    delete process.env.MCP_ACCESS_TOKEN;
    
    // Mock file system
    const mockFs = fs.promises as jest.Mocked<typeof fs.promises>;
    mockFs.readFile.mockImplementation(async (filePath) => {
      const p = filePath.toString();
      if (p.includes('user.service.ts')) {
        return Buffer.from(`
export class UserService {
  private users: User[] = [];
  
  async getUser(id: string): Promise<User> {
    return this.users.find(u => u.id === id);
  }
  
  async createUser(data: CreateUserDto): Promise<User> {
    const user = new User(data);
    this.users.push(user);
    return user;
  }
}
        `);
      }
      if (p.includes('auth.controller.ts')) {
        return Buffer.from(`
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}
  
  @Post('login')
  async login(@Body() credentials: LoginDto) {
    return this.authService.login(credentials);
  }
}
        `);
      }
      throw new Error(`File not found: ${filePath}`);
    });
    
    mockFs.stat.mockImplementation(async (filePath) => {
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
        mtime: new Date()
      } as any;
    });
    
    mockFs.readdir.mockResolvedValue([
      'user.service.ts',
      'auth.controller.ts',
      'index.ts'
    ] as any);
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe('OpenAI MCP Specification Compliance', () => {
    it('should return search results in correct format', async () => {
      const response = await executeSearch('UserService', {
        maxResults: 10
      });
      
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content[0]).toHaveProperty('type', 'text');
      
      const results = JSON.parse(response.content[0].text);
      expect(results).toHaveProperty('results');
      expect(Array.isArray(results.results)).toBe(true);
      
      // Check each result has required fields
      if (results.results.length > 0) {
        const result = results.results[0];
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('title');
        expect(result).toHaveProperty('url');
        expect(typeof result.id).toBe('string');
        expect(typeof result.title).toBe('string');
        expect(typeof result.url).toBe('string');
      }
    });

    it('should return fetch document in correct format', async () => {
      const response = await executeFetch('src/user.service.ts:2:class');
      
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content[0]).toHaveProperty('type', 'text');
      
      const document = JSON.parse(response.content[0].text);
      expect(document).toHaveProperty('id');
      expect(document).toHaveProperty('title');
      expect(document).toHaveProperty('text');
      expect(document).toHaveProperty('url');
      expect(document).toHaveProperty('metadata');
      expect(typeof document.metadata).toBe('object');
    });

    it('should handle search with file pattern filter', async () => {
      const response = await executeSearch('Service', {
        maxResults: 10,
        filePattern: '*.service.ts'
      });
      
      const results = JSON.parse(response.content[0].text);
      
      // All results should be from service files
      results.results.forEach((result: any) => {
        expect(result.id).toMatch(/\.service\.ts/);
      });
    });

    it('should respect maxResults parameter', async () => {
      const response = await executeSearch('test', {
        maxResults: 5
      });
      
      const results = JSON.parse(response.content[0].text);
      expect(results.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Security Integration', () => {
    it('should not expose URLs without ngrok credentials', async () => {
      const response = await executeSearch('test');
      const results = JSON.parse(response.content[0].text);
      
      if (results.results.length > 0) {
        const url = results.results[0].url;
        // Should be local file URL
        expect(url).toMatch(/^(file:\/\/|vscode:\/\/)/);
        expect(url).not.toMatch(/^https?:\/\//);
      }
    });

    it('should use ngrok URL when credentials present', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      
      // Mock ngrok tunnel
      const mockSpawn = spawn as jest.Mock;
      mockSpawn.mockReturnValue({
        kill: jest.fn(),
        on: jest.fn()
      });
      
      // Mock tunnel URL retrieval
      const tunnel = getSecureTunnel();
      jest.spyOn(tunnel as any, 'fetchTunnelUrl').mockResolvedValue('https://test.ngrok.io');
      
      // Start tunnel
      await tunnel.startTunnel(8080);
      
      const response = await executeSearch('test');
      const results = JSON.parse(response.content[0].text);
      
      if (results.results.length > 0) {
        const url = results.results[0].url;
        expect(url).toContain('https://test.ngrok.io');
      }
    });

    it('should generate secure token when not provided', () => {
      const tunnel = getSecureTunnel();
      const config = tunnel['config'];
      
      expect(config.accessToken).toBeDefined();
      expect(config.accessToken).toHaveLength(64);
      expect(config.requireAuth).toBe(true);
    });
  });

  describe('Tool Handler', () => {
    it('should handle search tool execution', async () => {
      const response = await executeSearchTool('search', {
        query: 'UserService',
        maxResults: 10
      });
      
      expect(response).toHaveProperty('content');
      const results = JSON.parse(response.content[0].text);
      expect(results).toHaveProperty('results');
    });

    it('should handle fetch tool execution', async () => {
      const response = await executeSearchTool('fetch', {
        id: 'test/file.ts:10'
      });
      
      expect(response).toHaveProperty('content');
      const document = JSON.parse(response.content[0].text);
      expect(document).toHaveProperty('id');
      expect(document).toHaveProperty('text');
    });

    it('should throw error for unknown tool', async () => {
      await expect(
        executeSearchTool('unknown', { query: 'test' })
      ).rejects.toThrow('Unknown search tool: unknown');
    });
  });

  describe('Error Handling', () => {
    it('should handle search errors gracefully', async () => {
      // Mock search engine to throw error
      jest.spyOn(SearchEngine.prototype, 'search').mockRejectedValue(
        new Error('Search failed')
      );
      
      const response = await executeSearch('test');
      const result = JSON.parse(response.content[0].text);
      
      expect(result).toHaveProperty('results', []);
      expect(result).toHaveProperty('error', 'Search failed');
    });

    it('should handle fetch errors gracefully', async () => {
      const response = await executeFetch('/nonexistent/file.ts');
      const document = JSON.parse(response.content[0].text);
      
      expect(document).toHaveProperty('id', '/nonexistent/file.ts');
      expect(document).toHaveProperty('title', 'Error');
      expect(document.text).toContain('Failed to fetch document');
      expect(document.metadata).toHaveProperty('error', true);
    });

    it('should handle invalid search query', async () => {
      const response = await executeSearch('');
      const results = JSON.parse(response.content[0].text);
      
      expect(results).toHaveProperty('results');
      expect(Array.isArray(results.results)).toBe(true);
    });
  });

  describe('URL Generation', () => {
    it('should generate correct local URLs', async () => {
      const urlHelper = getUrlHelper();
      const url = urlHelper.generateFileUrl('/test/file.ts', 42);
      
      expect(url).toBe('vscode://file//test/file.ts:42:1');
    });

    it('should generate correct remote URLs with tunnel', () => {
      const urlHelper = getUrlHelper();
      const tunnel = getSecureTunnel();
      
      // Mock tunnel URL
      tunnel['tunnelUrl'] = 'https://test.ngrok.io';
      
      const url = urlHelper.generateFileUrl('/test/file.ts', 42);
      
      expect(url).toBe('https://test.ngrok.io/files/test/file.ts#L42');
    });

    it('should handle document ID generation and parsing', () => {
      const urlHelper = getUrlHelper();
      
      const id = urlHelper.generateDocumentId('/test/workspace/src/file.ts', 42, 'class');
      expect(id).toBe('src/file.ts:42:class');
      
      const parsed = urlHelper.parseDocumentId(id);
      expect(parsed.filePath).toBe('/test/workspace/src/file.ts');
      expect(parsed.lineNumber).toBe(42);
      expect(parsed.nodeType).toBe('class');
    });
  });

  describe('Multi-Strategy Search', () => {
    it('should combine results from multiple strategies', async () => {
      // This would test with real strategy implementations
      // For now, using the mock system to ensure integration works
      
      const response = await executeSearch('class UserService', {
        maxResults: 20
      });
      
      const results = JSON.parse(response.content[0].text);
      
      expect(results.results).toBeDefined();
      expect(Array.isArray(results.results)).toBe(true);
      
      // Results should be ranked by relevance
      if (results.results.length > 1) {
        for (let i = 1; i < results.results.length; i++) {
          const prevScore = results.results[i - 1].score || 0;
          const currScore = results.results[i].score || 0;
          expect(prevScore).toBeGreaterThanOrEqual(currScore);
        }
      }
    });

    it('should handle natural language queries', async () => {
      const response = await executeSearch('how does authentication work');
      
      const results = JSON.parse(response.content[0].text);
      expect(results.results).toBeDefined();
      
      // Should trigger vector/semantic search
      // Results would come from vector strategy in real implementation
    });

    it('should handle code pattern queries', async () => {
      const response = await executeSearch('async login(@Body()');
      
      const results = JSON.parse(response.content[0].text);
      expect(results.results).toBeDefined();
      
      // Should trigger AST search for code patterns
    });
  });

  describe('Performance', () => {
    it('should execute searches within reasonable time', async () => {
      const start = Date.now();
      
      await executeSearch('test', { maxResults: 100 });
      
      const duration = Date.now() - start;
      
      // Should complete within 5 seconds even for large searches
      expect(duration).toBeLessThan(5000);
    });

    it('should handle concurrent searches', async () => {
      const searches = [
        executeSearch('UserService'),
        executeSearch('AuthController'),
        executeSearch('login'),
        executeSearch('createUser')
      ];
      
      const responses = await Promise.all(searches);
      
      responses.forEach(response => {
        expect(response).toHaveProperty('content');
        const results = JSON.parse(response.content[0].text);
        expect(results).toHaveProperty('results');
      });
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete search and fetch workflow', async () => {
      // Step 1: Search for a class
      const searchResponse = await executeSearch('UserService');
      const searchResults = JSON.parse(searchResponse.content[0].text);
      
      expect(searchResults.results.length).toBeGreaterThan(0);
      
      // Step 2: Fetch the first result
      const firstResult = searchResults.results[0];
      const fetchResponse = await executeFetch(firstResult.id);
      const document = JSON.parse(fetchResponse.content[0].text);
      
      expect(document.id).toBe(firstResult.id);
      expect(document.text).toBeDefined();
      expect(document.url).toBe(firstResult.url);
    });

    it('should maintain consistency between search and fetch URLs', async () => {
      // Configure with ngrok
      process.env.NGROK_AUTHTOKEN = 'test-token';
      const tunnel = getSecureTunnel();
      tunnel['tunnelUrl'] = 'https://test.ngrok.io';
      
      // Search
      const searchResponse = await executeSearch('test');
      const searchResults = JSON.parse(searchResponse.content[0].text);
      
      if (searchResults.results.length > 0) {
        const searchUrl = searchResults.results[0].url;
        
        // Fetch
        const fetchResponse = await executeFetch(searchResults.results[0].id);
        const document = JSON.parse(fetchResponse.content[0].text);
        const fetchUrl = document.url;
        
        // URLs should match
        expect(fetchUrl).toBe(searchUrl);
        expect(fetchUrl).toContain('https://test.ngrok.io');
      }
    });
  });
});