import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { 
  editFileTool, 
  multiEditTool, 
  createFileTool, 
  deleteFileTool, 
  moveFileTool,
  editTools 
} from '../../src/tools/edit.js';
import { 
  createTestFile, 
  readTestFile, 
  testFileExists, 
  cleanupTestFile,
  TEST_TEMP_DIR 
} from '../setup.js';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('Edit Tools', () => {
  
  describe('editFileTool', () => {
    test('should have correct metadata', () => {
      expect(editFileTool.name).toBe('edit_file');
      expect(editFileTool.description).toBe('Replace text in a file');
      expect(editFileTool.inputSchema.type).toBe('object');
      expect(editFileTool.inputSchema.required).toEqual(['path', 'oldText', 'newText']);
    });

    test('should successfully replace text in file', async () => {
      const originalContent = `function hello() {
  console.log("Hello World");
  return "success";
}`;
      const filePath = await createTestFile('edit-test.js', originalContent);
      
      const result = await editFileTool.handler({
        path: filePath,
        oldText: 'Hello World',
        newText: 'Hello Universe'
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Successfully replaced text');
      
      const updatedContent = await readTestFile('edit-test.js');
      expect(updatedContent).toContain('Hello Universe');
      expect(updatedContent).not.toContain('Hello World');
    });

    test('should handle oldText not found', async () => {
      const filePath = await createTestFile('edit-fail.js', 'console.log("test");');
      
      const result = await editFileTool.handler({
        path: filePath,
        oldText: 'nonexistent text',
        newText: 'replacement'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('oldText not found in file');
    });

    test('should handle multiple occurrences error', async () => {
      const filePath = await createTestFile('edit-multiple.js', 'test\ntest\ntest');
      
      const result = await editFileTool.handler({
        path: filePath,
        oldText: 'test',
        newText: 'replacement'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('found 3 times');
      expect(result.content[0].text).toContain('Please make it unique');
    });

    test('should handle file not found', async () => {
      const result = await editFileTool.handler({
        path: path.join(TEST_TEMP_DIR, 'nonexistent.js'),
        oldText: 'test',
        newText: 'replacement'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error editing file');
    });

    test('should preserve whitespace and formatting', async () => {
      const originalContent = `  function  test()  {
    console.log( "spaced" );
  }`;
      const filePath = await createTestFile('whitespace-test.js', originalContent);
      
      const result = await editFileTool.handler({
        path: filePath,
        oldText: 'console.log( "spaced" );',
        newText: 'console.log("no-spaces");'
      });
      
      expect(result.isError).toBeFalsy();
      
      const updatedContent = await readTestFile('whitespace-test.js');
      expect(updatedContent).toContain('console.log("no-spaces");');
      expect(updatedContent).toContain('  function  test()  {'); // Preserve other spacing
    });
  });

  describe('multiEditTool', () => {
    test('should have correct metadata', () => {
      expect(multiEditTool.name).toBe('multi_edit');
      expect(multiEditTool.description).toBe('Make multiple edits to a file in one operation');
      expect(multiEditTool.inputSchema.required).toEqual(['path', 'edits']);
    });

    test('should apply multiple edits successfully', async () => {
      const originalContent = `const name = "World";
const greeting = "Hello";
const message = greeting + " " + name;
console.log(message);`;
      
      const filePath = await createTestFile('multi-edit.js', originalContent);
      
      const result = await multiEditTool.handler({
        path: filePath,
        edits: [
          { oldText: '"World"', newText: '"Universe"' },
          { oldText: '"Hello"', newText: '"Greetings"' },
          { oldText: 'console.log(message);', newText: 'console.log("Result:", message);' }
        ]
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Edits completed');
      expect(result.content[0].text).toContain('✓ Replaced');
      
      const updatedContent = await readTestFile('multi-edit.js');
      expect(updatedContent).toContain('"Universe"');
      expect(updatedContent).toContain('"Greetings"');
      expect(updatedContent).toContain('"Result:", message');
    });

    test('should handle partial success in multi-edit', async () => {
      const filePath = await createTestFile('partial-edit.js', 'const test = "value";');
      
      const result = await multiEditTool.handler({
        path: filePath,
        edits: [
          { oldText: '"value"', newText: '"new-value"' }, // Should work
          { oldText: 'nonexistent', newText: 'replacement' }  // Should fail
        ]
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('✓ Replaced');
      expect(output).toContain('❌ oldText not found');
      
      const updatedContent = await readTestFile('partial-edit.js');
      expect(updatedContent).toContain('"new-value"');
    });

    test('should handle duplicate oldText in multi-edit', async () => {
      const filePath = await createTestFile('duplicate-edit.js', 'test\ntest\nother');
      
      const result = await multiEditTool.handler({
        path: filePath,
        edits: [
          { oldText: 'test', newText: 'replacement' },
          { oldText: 'other', newText: 'different' }
        ]
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('❌ oldText found 2 times');
      expect(output).toContain('✓ Replaced');
    });
  });

  describe('createFileTool', () => {
    test('should have correct metadata', () => {
      expect(createFileTool.name).toBe('create_file');
      expect(createFileTool.description).toBe('Create a new file with content');
      expect(createFileTool.inputSchema.required).toEqual(['path', 'content']);
    });

    test('should create new file successfully', async () => {
      const filePath = path.join(TEST_TEMP_DIR, 'new-file.js');
      const content = 'console.log("New file created");';
      
      const result = await createFileTool.handler({
        path: filePath,
        content: content
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('File created');
      
      const exists = await testFileExists('new-file.js');
      expect(exists).toBe(true);
      
      const createdContent = await readTestFile('new-file.js');
      expect(createdContent).toBe(content);
    });

    test('should create directories recursively', async () => {
      const filePath = path.join(TEST_TEMP_DIR, 'deep', 'nested', 'path', 'file.js');
      const content = 'console.log("Deep file");';
      
      const result = await createFileTool.handler({
        path: filePath,
        content: content
      });
      
      expect(result.isError).toBeFalsy();
      
      const exists = await testFileExists('deep/nested/path/file.js');
      expect(exists).toBe(true);
    });

    test('should prevent overwriting existing file without flag', async () => {
      const filePath = await createTestFile('existing.js', 'original content');
      
      const result = await createFileTool.handler({
        path: filePath,
        content: 'new content'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('File already exists');
      
      const content = await readTestFile('existing.js');
      expect(content).toBe('original content');
    });

    test('should overwrite existing file with flag', async () => {
      const filePath = await createTestFile('overwrite.js', 'original content');
      
      const result = await createFileTool.handler({
        path: filePath,
        content: 'new content',
        overwrite: true
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('File created');
      
      const content = await readTestFile('overwrite.js');
      expect(content).toBe('new content');
    });
  });

  describe('deleteFileTool', () => {
    test('should have correct metadata', () => {
      expect(deleteFileTool.name).toBe('delete_file');
      expect(deleteFileTool.description).toBe('Delete a file or empty directory');
      expect(deleteFileTool.inputSchema.required).toContain('path');
    });

    test('should delete file successfully', async () => {
      const filePath = await createTestFile('to-delete.js', 'delete me');
      
      const result = await deleteFileTool.handler({
        path: filePath
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Deleted');
      
      const exists = await testFileExists('to-delete.js');
      expect(exists).toBe(false);
    });

    test('should delete empty directory', async () => {
      const dirPath = path.join(TEST_TEMP_DIR, 'empty-dir');
      await fs.mkdir(dirPath, { recursive: true });
      
      const result = await deleteFileTool.handler({
        path: dirPath
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Deleted');
      
      try {
        await fs.access(dirPath);
        fail('Directory should have been deleted');
      } catch {
        // Expected - directory was deleted
      }
    });

    test('should delete directory recursively with flag', async () => {
      // Create nested structure
      await createTestFile('recursive-dir/nested/file.txt', 'content');
      const dirPath = path.join(TEST_TEMP_DIR, 'recursive-dir');
      
      const result = await deleteFileTool.handler({
        path: dirPath,
        recursive: true
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Deleted');
      
      try {
        await fs.access(dirPath);
        fail('Directory should have been deleted');
      } catch {
        // Expected - directory was deleted
      }
    });

    test('should handle non-existent file', async () => {
      const result = await deleteFileTool.handler({
        path: path.join(TEST_TEMP_DIR, 'nonexistent.js')
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error deleting');
    });
  });

  describe('moveFileTool', () => {
    test('should have correct metadata', () => {
      expect(moveFileTool.name).toBe('move_file');
      expect(moveFileTool.description).toBe('Move or rename a file or directory');
      expect(moveFileTool.inputSchema.required).toEqual(['source', 'destination']);
    });

    test('should move file successfully', async () => {
      const sourceContent = 'file to move';
      const sourcePath = await createTestFile('source.js', sourceContent);
      const destPath = path.join(TEST_TEMP_DIR, 'destination.js');
      
      const result = await moveFileTool.handler({
        source: sourcePath,
        destination: destPath
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Moved');
      
      const sourceExists = await testFileExists('source.js');
      expect(sourceExists).toBe(false);
      
      const destExists = await testFileExists('destination.js');
      expect(destExists).toBe(true);
      
      const destContent = await readTestFile('destination.js');
      expect(destContent).toBe(sourceContent);
    });

    test('should rename file (move in same directory)', async () => {
      const content = 'rename me';
      const oldPath = await createTestFile('old-name.js', content);
      const newPath = path.join(TEST_TEMP_DIR, 'new-name.js');
      
      const result = await moveFileTool.handler({
        source: oldPath,
        destination: newPath
      });
      
      expect(result.isError).toBeFalsy();
      
      const oldExists = await testFileExists('old-name.js');
      expect(oldExists).toBe(false);
      
      const newExists = await testFileExists('new-name.js');
      expect(newExists).toBe(true);
    });

    test('should create destination directory if needed', async () => {
      const sourcePath = await createTestFile('move-deep.js', 'content');
      const destPath = path.join(TEST_TEMP_DIR, 'new', 'deep', 'path', 'moved.js');
      
      const result = await moveFileTool.handler({
        source: sourcePath,
        destination: destPath
      });
      
      expect(result.isError).toBeFalsy();
      
      const destExists = await testFileExists('new/deep/path/moved.js');
      expect(destExists).toBe(true);
    });

    test('should prevent overwriting without flag', async () => {
      const sourcePath = await createTestFile('move-source.js', 'source');
      const destPath = await createTestFile('move-dest.js', 'destination');
      
      const result = await moveFileTool.handler({
        source: sourcePath,
        destination: destPath
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Destination already exists');
      
      // Both files should still exist
      const sourceExists = await testFileExists('move-source.js');
      expect(sourceExists).toBe(true);
      
      const destContent = await readTestFile('move-dest.js');
      expect(destContent).toBe('destination'); // Should be unchanged
    });

    test('should overwrite with flag', async () => {
      const sourcePath = await createTestFile('overwrite-source.js', 'source');
      const destPath = await createTestFile('overwrite-dest.js', 'destination');
      
      const result = await moveFileTool.handler({
        source: sourcePath,
        destination: destPath,
        overwrite: true
      });
      
      expect(result.isError).toBeFalsy();
      
      const sourceExists = await testFileExists('overwrite-source.js');
      expect(sourceExists).toBe(false);
      
      const destContent = await readTestFile('overwrite-dest.js');
      expect(destContent).toBe('source');
    });

    test('should handle non-existent source', async () => {
      const result = await moveFileTool.handler({
        source: path.join(TEST_TEMP_DIR, 'nonexistent.js'),
        destination: path.join(TEST_TEMP_DIR, 'dest.js')
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error moving file');
    });
  });

  describe('editTools array', () => {
    test('should export all edit tools', () => {
      expect(editTools).toHaveLength(5);
      expect(editTools).toContain(editFileTool);
      expect(editTools).toContain(multiEditTool);
      expect(editTools).toContain(createFileTool);
      expect(editTools).toContain(deleteFileTool);
      expect(editTools).toContain(moveFileTool);
    });

    test('should have unique tool names', () => {
      const names = editTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(editTools.length);
    });

    test('should all have valid handler functions', () => {
      editTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });
  });

  describe('Integration tests', () => {
    test('should handle complex editing workflow', async () => {
      // Create initial file
      const content = `class Calculator {
  add(a, b) {
    return a + b;
  }
  
  multiply(a, b) {
    return a * b;
  }
}`;
      
      const createResult = await createFileTool.handler({
        path: path.join(TEST_TEMP_DIR, 'calculator.js'),
        content: content
      });
      expect(createResult.isError).toBeFalsy();
      
      // Edit the file to add more methods
      const editResult = await editFileTool.handler({
        path: path.join(TEST_TEMP_DIR, 'calculator.js'),
        oldText: '  multiply(a, b) {\n    return a * b;\n  }\n}',
        newText: `  multiply(a, b) {
    return a * b;
  }
  
  subtract(a, b) {
    return a - b;
  }
  
  divide(a, b) {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
}`
      });
      expect(editResult.isError).toBeFalsy();
      
      // Verify the edit
      const finalContent = await readTestFile('calculator.js');
      expect(finalContent).toContain('subtract(a, b)');
      expect(finalContent).toContain('divide(a, b)');
      expect(finalContent).toContain('Division by zero');
    });
  });
});