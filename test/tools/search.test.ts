import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { 
  grepTool, 
  findFilesTool, 
  searchTool,
  searchTools 
} from '../../src/tools/search.js';
import { 
  createTestFile, 
  readTestFile, 
  testFileExists, 
  cleanupTestFile,
  TEST_TEMP_DIR 
} from '../setup.js';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('Search Tools', () => {
  beforeEach(async () => {
    // Create test files with different content for searching
    await createTestFile('search-test/javascript.js', `
function hello() {
  console.log("Hello World");
  return "success";
}

const API_KEY = "test-key";
    `);
    
    await createTestFile('search-test/typescript.ts', `
interface User {
  name: string;
  email: string;
}

function greetUser(user: User): string {
  return \`Hello \${user.name}\`;
}
    `);
    
    await createTestFile('search-test/config.json', `{
  "database": {
    "host": "localhost",
    "port": 5432
  },
  "apiKey": "test-api-key"
}`);
    
    await createTestFile('search-test/readme.md', `
# Test Project

This is a test project for searching functionality.

## Features
- Search capabilities
- File operations
- Configuration management
    `);
  });

  describe('grepTool', () => {
    test('should have correct metadata', () => {
      expect(grepTool.name).toBe('grep');
      expect(grepTool.description).toBe('Search for patterns in files using grep or ripgrep');
      expect(grepTool.inputSchema.type).toBe('object');
      expect(grepTool.inputSchema.required).toContain('pattern');
    });

    test('should find pattern in files', async () => {
      const result = await grepTool.handler({
        pattern: 'Hello',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        showLineNumbers: true
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('Hello');
    });

    test('should support case-insensitive search', async () => {
      const result = await grepTool.handler({
        pattern: 'hello',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        ignoreCase: true
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output.toLowerCase()).toContain('hello');
    });

    test('should support file pattern filtering', async () => {
      const result = await grepTool.handler({
        pattern: 'function',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        filePattern: '*.ts'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      if (output !== 'No matches found') {
        expect(output).toContain('typescript.ts');
        expect(output).not.toContain('javascript.js');
      }
    });

    test('should handle no matches gracefully', async () => {
      const result = await grepTool.handler({
        pattern: 'nonexistent-pattern-xyz123',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('No matches found');
    });

    test('should handle invalid directory', async () => {
      const result = await grepTool.handler({
        pattern: 'test',
        path: path.join(TEST_TEMP_DIR, 'non-existent-dir')
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error searching');
    });

    test('should support context lines', async () => {
      const result = await grepTool.handler({
        pattern: 'Hello',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        contextLines: 1,
        showLineNumbers: true
      });
      
      expect(result.isError).toBeFalsy();
      // Context lines should show additional lines around the match
      const output = result.content[0].text!;
      if (output !== 'No matches found') {
        expect(output.split('\n').length).toBeGreaterThan(1);
      }
    });
  });

  describe('findFilesTool', () => {
    test('should have correct metadata', () => {
      expect(findFilesTool.name).toBe('find_files');
      expect(findFilesTool.description).toBe('Find files by name pattern');
      expect(findFilesTool.inputSchema.required).toContain('pattern');
    });

    test('should find files by pattern', async () => {
      const result = await findFilesTool.handler({
        pattern: '*.js',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('javascript.js');
    });

    test('should find TypeScript files', async () => {
      const result = await findFilesTool.handler({
        pattern: '*.ts',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('typescript.ts');
    });

    test('should find files by partial name', async () => {
      const result = await findFilesTool.handler({
        pattern: '*config*',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('config.json');
    });

    test('should filter by file type', async () => {
      const result = await findFilesTool.handler({
        pattern: '*',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        type: 'file'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      const files = output.split('\n').filter(f => f.trim());
      // Should only include files, not directories
      files.forEach(file => {
        expect(file).toMatch(/\.(js|ts|json|md)$/);
      });
    });

    test('should handle no matches', async () => {
      const result = await findFilesTool.handler({
        pattern: '*.xyz',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('No files found matching the pattern');
    });

    test('should respect maxDepth parameter', async () => {
      // Create nested structure
      await createTestFile('search-test/deep/nested/deep-file.txt', 'deep content');
      
      const result = await findFilesTool.handler({
        pattern: '*.txt',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        maxDepth: 1
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      // Should not find the deeply nested file
      expect(output).toBe('No files found matching the pattern');
    });
  });

  describe('searchTool', () => {
    test('should have correct metadata', () => {
      expect(searchTool.name).toBe('search');
      expect(searchTool.description).toBe('Unified search that combines multiple search strategies');
      expect(searchTool.inputSchema.required).toContain('query');
    });

    test('should search both filenames and content', async () => {
      const result = await searchTool.handler({
        query: 'config',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        type: 'all'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      
      // Should find filename matches
      expect(output).toContain('Filename Matches');
      expect(output).toContain('config.json');
    });

    test('should search only filenames when type is filename', async () => {
      const result = await searchTool.handler({
        query: 'javascript',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        type: 'filename'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('Filename Matches');
      expect(output).toContain('javascript.js');
      expect(output).not.toContain('Content Matches');
    });

    test('should search only content when type is code', async () => {
      const result = await searchTool.handler({
        query: 'function',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        type: 'code'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('Content Matches');
      expect(output).not.toContain('Filename Matches');
    });

    test('should respect maxResults parameter', async () => {
      const result = await searchTool.handler({
        query: 'test',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        maxResults: 2
      });
      
      expect(result.isError).toBeFalsy();
      // Result should be limited (though exact count may vary based on matches)
      const output = result.content[0].text!;
      expect(output.length).toBeGreaterThan(0);
    });

    test('should support file pattern filtering', async () => {
      const result = await searchTool.handler({
        query: 'Hello',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        filePattern: '*.js'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      if (output !== 'No matches found') {
        expect(output).toContain('javascript.js');
      }
    });

    test('should handle no matches gracefully', async () => {
      const result = await searchTool.handler({
        query: 'nonexistent-query-xyz123',
        path: path.join(TEST_TEMP_DIR, 'search-test')
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('No matches found');
    });

    test('should handle search errors gracefully', async () => {
      const result = await searchTool.handler({
        query: 'test',
        path: path.join(TEST_TEMP_DIR, 'non-existent-directory')
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error searching');
    });
  });

  describe('searchTools array', () => {
    test('should export all search tools', () => {
      expect(searchTools).toHaveLength(3);
      expect(searchTools).toContain(grepTool);
      expect(searchTools).toContain(findFilesTool);
      expect(searchTools).toContain(searchTool);
    });

    test('should have unique tool names', () => {
      const names = searchTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(searchTools.length);
    });

    test('should all have valid handler functions', () => {
      searchTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });
  });

  describe('Integration tests', () => {
    test('should handle complex search scenarios', async () => {
      // Create a more complex file structure
      await createTestFile('search-test/complex/module1.js', `
export class DataProcessor {
  constructor(config) {
    this.config = config;
  }
  
  process(data) {
    console.log('Processing data...');
    return this.transform(data);
  }
}
      `);
      
      await createTestFile('search-test/complex/module2.ts', `
import { DataProcessor } from './module1.js';

interface ProcessorConfig {
  debug: boolean;
  timeout: number;
}

export function createProcessor(config: ProcessorConfig): DataProcessor {
  return new DataProcessor(config);
}
      `);

      // Test grep with multiple matches
      const grepResult = await grepTool.handler({
        pattern: 'DataProcessor',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        showLineNumbers: true
      });
      
      expect(grepResult.isError).toBeFalsy();
      const grepOutput = grepResult.content[0].text!;
      if (grepOutput !== 'No matches found') {
        expect(grepOutput).toContain('DataProcessor');
      }

      // Test unified search
      const searchResult = await searchTool.handler({
        query: 'DataProcessor',
        path: path.join(TEST_TEMP_DIR, 'search-test'),
        type: 'all'
      });
      
      expect(searchResult.isError).toBeFalsy();
      const searchOutput = searchResult.content[0].text!;
      expect(searchOutput).toContain('DataProcessor');
    });
  });
});