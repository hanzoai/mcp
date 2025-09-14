/**
 * Basic tests for MCP Search implementation
 * Validates core functionality and OpenAI spec compliance
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { executeSearch, executeFetch } from '../../src/search/index.js';

describe('MCP Search Basic Tests', () => {
  beforeEach(() => {
    // Clear environment for clean testing
    delete process.env.NGROK_API_KEY;
    delete process.env.NGROK_AUTHTOKEN;
  });

  describe('Search Functionality', () => {
    it('should return results in OpenAI MCP format', async () => {
      const response = await executeSearch('test');
      
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content[0]).toHaveProperty('type', 'text');
      
      const results = JSON.parse(response.content[0].text);
      expect(results).toHaveProperty('results');
      expect(Array.isArray(results.results)).toBe(true);
    });

    it('should handle search with options', async () => {
      const response = await executeSearch('test', {
        maxResults: 5,
        filePattern: '*.ts'
      });
      
      const results = JSON.parse(response.content[0].text);
      expect(results).toHaveProperty('results');
    });
  });

  describe('Fetch Functionality', () => {
    it('should return document in OpenAI MCP format', async () => {
      const response = await executeFetch('test/file.ts:10');
      
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      
      const document = JSON.parse(response.content[0].text);
      expect(document).toHaveProperty('id');
      expect(document).toHaveProperty('title');
      expect(document).toHaveProperty('text');
      expect(document).toHaveProperty('url');
      expect(document).toHaveProperty('metadata');
    });
  });

  describe('Error Handling', () => {
    it('should handle search errors gracefully', async () => {
      const response = await executeSearch('');
      const results = JSON.parse(response.content[0].text);
      
      expect(results).toHaveProperty('results');
      expect(Array.isArray(results.results)).toBe(true);
    });

    it('should handle fetch errors gracefully', async () => {
      const response = await executeFetch('nonexistent');
      const document = JSON.parse(response.content[0].text);
      
      expect(document).toHaveProperty('id');
      expect(document).toHaveProperty('title');
      expect(document).toHaveProperty('text');
    });
  });
});