/**
 * Tests for UrlHelper - URL generation for search results
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UrlHelper, UrlConfig, getUrlHelper, configureUrlHelper } from '../../src/search/url-helper.js';
import * as secureTunnel from '../../src/search/secure-tunnel.js';
import path from 'path';

// Mock secure tunnel
jest.mock('../../src/search/secure-tunnel.js', () => ({
  getSecureTunnel: jest.fn(() => ({
    getTunnelUrl: jest.fn(() => null)
  }))
}));

describe('UrlHelper', () => {
  let urlHelper: UrlHelper;
  let originalEnv: NodeJS.ProcessEnv;
  let mockGetSecureTunnel: jest.Mock;
  let mockGetTunnelUrl: jest.Mock;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    
    // Clear relevant env vars
    delete process.env.MCP_BASE_URL;
    delete process.env.MCP_SERVE_PATH;
    delete process.env.MCP_ENABLE_FILE_SERVING;
    delete process.env.MCP_WORKSPACE_ROOT;
    
    // Setup mocks
    mockGetTunnelUrl = jest.fn(() => null);
    mockGetSecureTunnel = secureTunnel.getSecureTunnel as jest.Mock;
    mockGetSecureTunnel.mockReturnValue({
      getTunnelUrl: mockGetTunnelUrl
    });
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe('URL Generation', () => {
    it('should generate file:// URL for local files by default', () => {
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toBe('file:///test/file.ts');
    });

    it('should generate VSCode URL with line number', () => {
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts', 42);
      
      expect(url).toBe('vscode://file//test/file.ts:42:1');
    });

    it('should use ngrok tunnel URL when available', () => {
      mockGetTunnelUrl.mockReturnValue('https://abc123.ngrok.io');
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toContain('https://abc123.ngrok.io/files/test/file.ts');
    });

    it('should use configured base URL over tunnel', () => {
      mockGetTunnelUrl.mockReturnValue('https://abc123.ngrok.io');
      urlHelper = new UrlHelper({
        baseUrl: 'https://custom.domain.com',
        servePath: '/api/files'
      });
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toBe('https://custom.domain.com/api/files/test/file.ts');
    });

    it('should add line number as fragment to remote URL', () => {
      urlHelper = new UrlHelper({
        baseUrl: 'https://example.com'
      });
      
      const url = urlHelper.generateFileUrl('/test/file.ts', 100);
      
      expect(url).toBe('https://example.com/files/test/file.ts#L100');
    });

    it('should handle relative paths', () => {
      urlHelper = new UrlHelper({
        workspaceRoot: '/workspace'
      });
      
      const url = urlHelper.generateFileUrl('src/file.ts');
      const expectedPath = path.resolve('/workspace', 'src/file.ts');
      
      expect(url).toBe(`file://${expectedPath}`);
    });

    it('should handle Windows paths correctly', () => {
      urlHelper = new UrlHelper({
        baseUrl: 'https://example.com',
        workspaceRoot: 'C:\\workspace'
      });
      
      const url = urlHelper.generateFileUrl('C:\\workspace\\src\\file.ts');
      
      // Should convert backslashes to forward slashes
      expect(url).toBe('https://example.com/files/src/file.ts');
    });
  });

  describe('Document ID Generation', () => {
    beforeEach(() => {
      urlHelper = new UrlHelper({
        workspaceRoot: '/workspace'
      });
    });

    it('should generate document ID from file path', () => {
      const id = urlHelper.generateDocumentId('/workspace/src/file.ts');
      
      expect(id).toBe('src/file.ts');
    });

    it('should include line number in ID', () => {
      const id = urlHelper.generateDocumentId('/workspace/src/file.ts', 42);
      
      expect(id).toBe('src/file.ts:42');
    });

    it('should include node type in ID', () => {
      const id = urlHelper.generateDocumentId('/workspace/src/file.ts', 42, 'class');
      
      expect(id).toBe('src/file.ts:42:class');
    });

    it('should normalize path separators', () => {
      const id = urlHelper.generateDocumentId('/workspace\\src\\file.ts');
      
      expect(id).toBe('src/file.ts');
    });
  });

  describe('Document ID Parsing', () => {
    beforeEach(() => {
      urlHelper = new UrlHelper({
        workspaceRoot: '/workspace'
      });
    });

    it('should parse simple file ID', () => {
      const parsed = urlHelper.parseDocumentId('src/file.ts');
      
      expect(parsed.filePath).toBe('/workspace/src/file.ts');
      expect(parsed.lineNumber).toBeUndefined();
      expect(parsed.nodeType).toBeUndefined();
    });

    it('should parse ID with line number', () => {
      const parsed = urlHelper.parseDocumentId('src/file.ts:42');
      
      expect(parsed.filePath).toBe('/workspace/src/file.ts');
      expect(parsed.lineNumber).toBe(42);
      expect(parsed.nodeType).toBeUndefined();
    });

    it('should parse ID with line number and node type', () => {
      const parsed = urlHelper.parseDocumentId('src/file.ts:42:class');
      
      expect(parsed.filePath).toBe('/workspace/src/file.ts');
      expect(parsed.lineNumber).toBe(42);
      expect(parsed.nodeType).toBe('class');
    });

    it('should handle special prefixes', () => {
      const parsed1 = urlHelper.parseDocumentId('vector:embedding-123');
      expect(parsed1.filePath).toBe('vector:embedding-123');
      expect(parsed1.lineNumber).toBeUndefined();
      
      const parsed2 = urlHelper.parseDocumentId('memory:context-456');
      expect(parsed2.filePath).toBe('memory:context-456');
      expect(parsed2.lineNumber).toBeUndefined();
    });

    it('should handle non-numeric line values', () => {
      const parsed = urlHelper.parseDocumentId('src/file.ts:abc:class');
      
      expect(parsed.filePath).toBe('/workspace/src/file.ts');
      expect(parsed.lineNumber).toBeUndefined();
      expect(parsed.nodeType).toBeUndefined(); // abc becomes part of path
    });
  });

  describe('Configuration', () => {
    it('should load configuration from environment', () => {
      process.env.MCP_BASE_URL = 'https://env.example.com';
      process.env.MCP_SERVE_PATH = '/custom/files';
      process.env.MCP_ENABLE_FILE_SERVING = 'true';
      process.env.MCP_WORKSPACE_ROOT = '/custom/workspace';
      
      const helper = getUrlHelper();
      const config = helper.getConfig();
      
      expect(config.baseUrl).toBe('https://env.example.com');
      expect(config.servePath).toBe('/custom/files');
      expect(config.enableFileServing).toBe(true);
      expect(config.workspaceRoot).toBe('/custom/workspace');
    });

    it('should use defaults when environment not set', () => {
      const helper = getUrlHelper();
      const config = helper.getConfig();
      
      expect(config.baseUrl).toBeUndefined();
      expect(config.servePath).toBe('/files');
      expect(config.enableFileServing).toBeFalsy();
      expect(config.workspaceRoot).toBe(process.cwd());
    });

    it('should update configuration', () => {
      urlHelper = new UrlHelper();
      
      urlHelper.updateConfig({
        baseUrl: 'https://updated.com',
        servePath: '/new/path'
      });
      
      const config = urlHelper.getConfig();
      expect(config.baseUrl).toBe('https://updated.com');
      expect(config.servePath).toBe('/new/path');
    });

    it('should update workspace root', () => {
      urlHelper = new UrlHelper({
        workspaceRoot: '/old/workspace'
      });
      
      urlHelper.updateConfig({
        workspaceRoot: '/new/workspace'
      });
      
      const id = urlHelper.generateDocumentId('/new/workspace/file.ts');
      expect(id).toBe('file.ts');
    });
  });

  describe('Global Functions', () => {
    it('should create singleton UrlHelper instance', () => {
      const helper1 = getUrlHelper();
      const helper2 = getUrlHelper();
      
      expect(helper1).toBe(helper2);
    });

    it('should configure global instance', () => {
      configureUrlHelper({
        baseUrl: 'https://configured.com'
      });
      
      const helper = getUrlHelper();
      const config = helper.getConfig();
      
      expect(config.baseUrl).toBe('https://configured.com');
    });
  });

  describe('Integration with SecureTunnel', () => {
    it('should prioritize tunnel URL when active', () => {
      mockGetTunnelUrl.mockReturnValue('https://tunnel.ngrok.io');
      
      urlHelper = new UrlHelper({
        baseUrl: 'https://fallback.com'
      });
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toContain('https://tunnel.ngrok.io');
      expect(url).not.toContain('https://fallback.com');
    });

    it('should fall back to base URL when tunnel not active', () => {
      mockGetTunnelUrl.mockReturnValue(null);
      
      urlHelper = new UrlHelper({
        baseUrl: 'https://fallback.com'
      });
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toContain('https://fallback.com');
    });

    it('should use local URL when neither tunnel nor base URL available', () => {
      mockGetTunnelUrl.mockReturnValue(null);
      
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts');
      
      expect(url).toMatch(/^(file:\/\/|vscode:\/\/)/);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty file path', () => {
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('');
      const expectedPath = process.cwd();
      
      expect(url).toBe(`file://${expectedPath}`);
    });

    it('should handle paths with spaces', () => {
      urlHelper = new UrlHelper({
        baseUrl: 'https://example.com',
        workspaceRoot: '/workspace'
      });
      
      const url = urlHelper.generateFileUrl('/workspace/my files/test file.ts');
      
      expect(url).toBe('https://example.com/files/my files/test file.ts');
    });

    it('should handle paths with special characters', () => {
      urlHelper = new UrlHelper({
        baseUrl: 'https://example.com',
        workspaceRoot: '/workspace'
      });
      
      const url = urlHelper.generateFileUrl('/workspace/src/@types/index.d.ts');
      
      expect(url).toBe('https://example.com/files/src/@types/index.d.ts');
    });

    it('should handle very long paths', () => {
      const longPath = '/workspace/' + 'a/'.repeat(100) + 'file.ts';
      urlHelper = new UrlHelper({
        workspaceRoot: '/workspace'
      });
      
      const id = urlHelper.generateDocumentId(longPath);
      
      expect(id).toContain('a/a/a/');
      expect(id).toEndWith('file.ts');
    });

    it('should handle line number 0', () => {
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts', 0);
      
      expect(url).toBe('vscode://file//test/file.ts:0:1');
    });

    it('should handle negative line numbers gracefully', () => {
      urlHelper = new UrlHelper();
      
      const url = urlHelper.generateFileUrl('/test/file.ts', -1);
      
      expect(url).toBe('vscode://file//test/file.ts:-1:1');
    });
  });
});