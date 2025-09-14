import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { 
  readFileTool, 
  writeFileTool, 
  listFilesTool, 
  getFileInfoTool, 
  directoryTreeTool,
  fileTools 
} from '../../src/tools/file-ops.js';
import { 
  createTestFile, 
  readTestFile, 
  testFileExists, 
  cleanupTestFile,
  TEST_TEMP_DIR 
} from '../setup.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('File Operations Tools', () => {
  
  describe('readFileTool', () => {
    test('should have correct metadata', () => {
      expect(readFileTool.name).toBe('read_file');
      expect(readFileTool.description).toBe('Read the contents of a file');
      expect(readFileTool.inputSchema.type).toBe('object');
      expect(readFileTool.inputSchema.required).toContain('path');
    });

    test('should read existing file successfully', async () => {
      const testContent = 'Hello, World!';
      const filePath = await createTestFile('test-read.txt', testContent);
      
      const result = await readFileTool.handler({ path: filePath });
      
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(testContent);
    });

    test('should handle non-existent file gracefully', async () => {
      const result = await readFileTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'non-existent.txt') 
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading file');
    });

    test('should support different encodings', async () => {
      const testContent = 'Test with encoding';
      const filePath = await createTestFile('test-encoding.txt', testContent);
      
      const result = await readFileTool.handler({ 
        path: filePath, 
        encoding: 'utf8' 
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe(testContent);
    });
  });

  describe('writeFileTool', () => {
    test('should have correct metadata', () => {
      expect(writeFileTool.name).toBe('write_file');
      expect(writeFileTool.description).toBe('Write content to a file');
      expect(writeFileTool.inputSchema.required).toEqual(['path', 'content']);
    });

    test('should write file successfully', async () => {
      const testContent = 'Hello, File System!';
      const filePath = path.join(TEST_TEMP_DIR, 'test-write.txt');
      
      const result = await writeFileTool.handler({ 
        path: filePath, 
        content: testContent 
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('File written successfully');
      
      const writtenContent = await readTestFile('test-write.txt');
      expect(writtenContent).toBe(testContent);
    });

    test('should create directories recursively', async () => {
      const testContent = 'Nested file content';
      const filePath = path.join(TEST_TEMP_DIR, 'nested', 'deep', 'test.txt');
      
      const result = await writeFileTool.handler({ 
        path: filePath, 
        content: testContent 
      });
      
      expect(result.isError).toBeFalsy();
      const exists = await testFileExists('nested/deep/test.txt');
      expect(exists).toBe(true);
    });

    test('should handle write errors gracefully', async () => {
      // Try to write to a read-only location (simulated by invalid path)
      const result = await writeFileTool.handler({ 
        path: '/root/invalid/path.txt', 
        content: 'test' 
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error writing file');
    });
  });

  describe('listFilesTool', () => {
    beforeEach(async () => {
      // Create test directory structure
      await createTestFile('list-test/file1.txt', 'content1');
      await createTestFile('list-test/file2.txt', 'content2');
      await createTestFile('list-test/.hidden', 'hidden');
      await fs.mkdir(path.join(TEST_TEMP_DIR, 'list-test', 'subdir'), { recursive: true });
    });

    test('should have correct metadata', () => {
      expect(listFilesTool.name).toBe('list_files');
      expect(listFilesTool.description).toBe('List files in a directory');
    });

    test('should list files in directory', async () => {
      const result = await listFilesTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'list-test') 
      });
      
      expect(result.isError).toBeFalsy();
      const fileList = result.content[0].text!.split('\n');
      expect(fileList).toContain('[DIR] subdir');
      expect(fileList.some(f => f.includes('file1.txt'))).toBe(true);
      expect(fileList.some(f => f.includes('file2.txt'))).toBe(true);
    });

    test('should handle non-existent directory', async () => {
      const result = await listFilesTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'non-existent') 
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing files');
    });

    test('should support glob patterns', async () => {
      const result = await listFilesTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'list-test'),
        pattern: '*.txt'
      });
      
      expect(result.isError).toBeFalsy();
      const fileList = result.content[0].text!.split('\n');
      expect(fileList).toContain('file1.txt');
      expect(fileList).toContain('file2.txt');
      expect(fileList).not.toContain('.hidden');
    });
  });

  describe('getFileInfoTool', () => {
    test('should have correct metadata', () => {
      expect(getFileInfoTool.name).toBe('get_file_info');
      expect(getFileInfoTool.description).toBe('Get metadata about a file or directory');
      expect(getFileInfoTool.inputSchema.required).toContain('path');
    });

    test('should get file info successfully', async () => {
      const testContent = 'File info test content';
      const filePath = await createTestFile('fileinfo-test.txt', testContent);
      
      const result = await getFileInfoTool.handler({ path: filePath });
      
      expect(result.isError).toBeFalsy();
      const fileInfo = JSON.parse(result.content[0].text!);
      expect(fileInfo.path).toBe(filePath);
      expect(fileInfo.isFile).toBe(true);
      expect(fileInfo.isDirectory).toBe(false);
      expect(fileInfo.size).toBe(testContent.length);
      expect(fileInfo.lastModified).toBeDefined();
      expect(fileInfo.permissions).toBeDefined();
    });

    test('should get directory info', async () => {
      const result = await getFileInfoTool.handler({ path: TEST_TEMP_DIR });
      
      expect(result.isError).toBeFalsy();
      const dirInfo = JSON.parse(result.content[0].text!);
      expect(dirInfo.isDirectory).toBe(true);
      expect(dirInfo.isFile).toBe(false);
    });

    test('should handle non-existent path', async () => {
      const result = await getFileInfoTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'non-existent') 
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting file info');
    });
  });

  describe('directoryTreeTool', () => {
    beforeEach(async () => {
      // Create nested directory structure for tree testing
      await createTestFile('tree-test/file1.txt', 'content1');
      await createTestFile('tree-test/dir1/file2.txt', 'content2');
      await createTestFile('tree-test/dir1/dir2/file3.txt', 'content3');
      await createTestFile('tree-test/.hidden', 'hidden');
    });

    test('should have correct metadata', () => {
      expect(directoryTreeTool.name).toBe('directory_tree');
      expect(directoryTreeTool.description).toBe('Display a tree view of directory structure');
    });

    test('should display directory tree', async () => {
      const result = await directoryTreeTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'tree-test'),
        maxDepth: 3
      });
      
      expect(result.isError).toBeFalsy();
      const tree = result.content[0].text!;
      expect(tree).toContain('tree-test');
      expect(tree).toContain('├──');
      expect(tree).toContain('└──');
      expect(tree).toContain('file1.txt');
      expect(tree).toContain('dir1');
    });

    test('should respect maxDepth parameter', async () => {
      const result = await directoryTreeTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'tree-test'),
        maxDepth: 1
      });
      
      expect(result.isError).toBeFalsy();
      const tree = result.content[0].text!;
      expect(tree).toContain('file1.txt');
      expect(tree).toContain('dir1');
      expect(tree).not.toContain('file2.txt'); // Should not go deep enough
    });

    test('should handle showHidden parameter', async () => {
      const result = await directoryTreeTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'tree-test'),
        showHidden: true
      });
      
      expect(result.isError).toBeFalsy();
      const tree = result.content[0].text!;
      expect(tree).toContain('.hidden');
    });

    test('should handle non-existent directory', async () => {
      const result = await directoryTreeTool.handler({ 
        path: path.join(TEST_TEMP_DIR, 'non-existent') 
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error building tree');
    });
  });

  describe('fileTools array', () => {
    test('should export all file tools', () => {
      expect(fileTools).toHaveLength(5);
      expect(fileTools).toContain(readFileTool);
      expect(fileTools).toContain(writeFileTool);
      expect(fileTools).toContain(listFilesTool);
      expect(fileTools).toContain(getFileInfoTool);
      expect(fileTools).toContain(directoryTreeTool);
    });

    test('should have unique tool names', () => {
      const names = fileTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(fileTools.length);
    });

    test('should all have valid handler functions', () => {
      fileTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });
  });
});