import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createMCPServer } from '../../src/index.js';
import {
  createTestFile,
  readTestFile,
  testFileExists,
  cleanupTestFile,
  TEST_TEMP_DIR
} from '../setup.js';
import * as path from 'path';

/**
 * getConfiguredTools includes orchestration (6), uiRegistry (6), and
 * githubUI (13) tools by default even when enableUI=false and
 * enableAutoGUI=false. This yields 25 "default extras" in addition to
 * any core tools.  The uiRegistry and githubUI tools use the ui_ prefix.
 */
const DEFAULT_EXTRAS_COUNT = 6 + 6 + 13; // 25
const CORE_TOOLS_COUNT = 19;

describe('MCP Server Integration', () => {
  let server: any;

  beforeEach(async () => {
    server = await createMCPServer({
      name: 'test-mcp',
      version: '1.0.0-test',
      toolConfig: {
        enableCore: true,
        enableUI: false,
        enableAutoGUI: false
      }
    });
  });

  afterEach(() => {
    server = null;
  });

  describe('Server Creation', () => {
    test('should create server with proper structure', () => {
      expect(server).toHaveProperty('server');
      expect(server).toHaveProperty('tools');
      expect(server).toHaveProperty('start');
      expect(server).toHaveProperty('addTool');
      expect(server).toHaveProperty('removeTool');
    });

    test('should have core tools available', () => {
      const toolNames = server.tools.map((t: any) => t.name);

      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('bash');
      expect(toolNames).toContain('grep');
    });

    test('should exclude disabled tool categories', () => {
      const toolNames = server.tools.map((t: any) => t.name);

      // Should not have AutoGUI tools (enableAutoGUI: false)
      const autoguiTools = toolNames.filter((name: string) =>
        name.startsWith('autogui_')
      );
      expect(autoguiTools).toHaveLength(0);

      // Should not have the dedicated UI tools from uiTools (enableUI: false)
      // (ui_init, ui_get_component_source, etc. are only added when enableUI: true)
      expect(toolNames).not.toContain('ui_init');
      expect(toolNames).not.toContain('ui_get_component_source');
      expect(toolNames).not.toContain('ui_add_component');

      // uiRegistry and githubUI tools (ui_ prefixed) ARE present because
      // enableUIRegistry and enableGitHubUI default to true
      expect(toolNames).toContain('ui_list_components');
      expect(toolNames).toContain('ui_fetch_component');

      // Total should be core + default extras
      expect(server.tools.length).toBe(CORE_TOOLS_COUNT + DEFAULT_EXTRAS_COUNT);
    });
  });

  describe('Tool Execution Workflow', () => {
    test('should execute complete file operations workflow', async () => {
      // Create a file
      const createTool = server.tools.find((t: any) => t.name === 'create_file');
      expect(createTool).toBeDefined();

      const testContent = 'Integration test content';
      const testPath = path.join(TEST_TEMP_DIR, 'integration-test.txt');

      const createResult = await createTool.handler({
        path: testPath,
        content: testContent
      });

      expect(createResult.isError).toBeFalsy();

      // Read the file
      const readTool = server.tools.find((t: any) => t.name === 'read_file');
      expect(readTool).toBeDefined();

      const readResult = await readTool.handler({ path: testPath });
      expect(readResult.isError).toBeFalsy();
      expect(readResult.content[0].text).toBe(testContent);

      // Edit the file
      const editTool = server.tools.find((t: any) => t.name === 'edit_file');
      expect(editTool).toBeDefined();

      const editResult = await editTool.handler({
        path: testPath,
        oldText: 'Integration',
        newText: 'Updated integration'
      });

      expect(editResult.isError).toBeFalsy();

      // Verify edit
      const readAfterEdit = await readTool.handler({ path: testPath });
      expect(readAfterEdit.content[0].text).toContain('Updated integration');

      // Delete the file
      const deleteTool = server.tools.find((t: any) => t.name === 'delete_file');
      expect(deleteTool).toBeDefined();

      const deleteResult = await deleteTool.handler({ path: testPath });
      expect(deleteResult.isError).toBeFalsy();
    });

    test('should execute search workflow', async () => {
      // Create test files for searching
      await createTestFile('search-integration/file1.js', 'function testFunction() { return "hello"; }');
      await createTestFile('search-integration/file2.py', 'def test_function(): return "world"');
      await createTestFile('search-integration/file3.txt', 'This is a test file with hello world');

      // Test grep tool
      const grepTool = server.tools.find((t: any) => t.name === 'grep');
      expect(grepTool).toBeDefined();

      const grepResult = await grepTool.handler({
        pattern: 'test',
        path: path.join(TEST_TEMP_DIR, 'search-integration')
      });

      expect(grepResult.isError).toBeFalsy();
      const grepOutput = grepResult.content[0].text!;
      expect(grepOutput).toContain('test');

      // Test find files tool
      const findTool = server.tools.find((t: any) => t.name === 'find_files');
      expect(findTool).toBeDefined();

      const findResult = await findTool.handler({
        pattern: '*.js',
        path: path.join(TEST_TEMP_DIR, 'search-integration')
      });

      expect(findResult.isError).toBeFalsy();
      expect(findResult.content[0].text).toContain('file1.js');
    });

    test('should execute shell workflow', async () => {
      const bashTool = server.tools.find((t: any) => t.name === 'bash');
      expect(bashTool).toBeDefined();

      // Test basic command
      const echoResult = await bashTool.handler({
        command: 'echo "Integration test shell"'
      });

      expect(echoResult.isError).toBeFalsy();
      expect(echoResult.content[0].text).toContain('Integration test shell');

      // Test with working directory
      const pwdResult = await bashTool.handler({
        command: 'pwd',
        cwd: TEST_TEMP_DIR
      });

      expect(pwdResult.isError).toBeFalsy();
      expect(pwdResult.content[0].text).toContain(TEST_TEMP_DIR);
    });
  });

  describe('Dynamic Tool Management', () => {
    test('should add and use custom tools', async () => {
      const customTool = {
        name: 'integration_custom_tool',
        description: 'Custom tool for integration testing',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        },
        handler: async (args: any) => ({
          content: [{ type: 'text' as const, text: `Custom: ${args.message}` }]
        })
      };

      // Add tool
      server.addTool(customTool);

      // Verify it's in the tools list
      expect(server.tools.some((t: any) => t.name === 'integration_custom_tool')).toBe(true);

      // Use the tool
      const result = await customTool.handler({ message: 'Hello from custom tool' });
      expect(result.content[0].text).toBe('Custom: Hello from custom tool');

      // Remove tool
      server.removeTool('integration_custom_tool');
      expect(server.tools.some((t: any) => t.name === 'integration_custom_tool')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should handle tool execution errors gracefully', async () => {
      const bashTool = server.tools.find((t: any) => t.name === 'bash');

      // Execute a command that will fail
      const result = await bashTool.handler({
        command: 'this-command-does-not-exist-xyz'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error executing command');
    });

    test('should handle invalid file operations', async () => {
      const readTool = server.tools.find((t: any) => t.name === 'read_file');

      // Try to read non-existent file
      const result = await readTool.handler({
        path: '/this/path/does/not/exist/file.txt'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading file');
    });
  });

  describe('Configuration Integration', () => {
    test('should respect tool configuration in practice', async () => {
      // Create server with limited tools
      const limitedServer = await createMCPServer({
        toolConfig: {
          enableCore: true,
          enabledCategories: ['files'],
          disabledTools: ['write_file']
        }
      });

      const toolNames = limitedServer.tools.map((t: any) => t.name);

      // Should have file tools
      expect(toolNames).toContain('read_file');

      // Should not have disabled tools
      expect(toolNames).not.toContain('write_file');

      // Should not have non-file tools
      expect(toolNames).not.toContain('bash');
      expect(toolNames).not.toContain('grep');
    });

    test('should work with minimal configuration', async () => {
      const minimalServer = await createMCPServer({
        toolConfig: {
          enableCore: false,
          customTools: [{
            name: 'minimal_tool',
            description: 'Minimal test tool',
            inputSchema: {
              type: 'object' as const,
              properties: {},
              required: []
            },
            handler: async () => ({
              content: [{ type: 'text' as const, text: 'Minimal tool works' }]
            })
          }]
        }
      });

      // Custom tool is appended to default extras (orchestration + uiRegistry + githubUI)
      expect(minimalServer.tools.length).toBe(DEFAULT_EXTRAS_COUNT + 1);
      expect(minimalServer.tools.some((t: any) => t.name === 'minimal_tool')).toBe(true);

      // Verify the custom tool executes correctly
      const minimalTool = minimalServer.tools.find((t: any) => t.name === 'minimal_tool');
      expect(minimalTool).toBeDefined();
      const result = await minimalTool!.handler({});
      expect(result.content[0].text).toBe('Minimal tool works');
    });
  });

  describe('Complex Workflows', () => {
    test('should handle multi-step development workflow', async () => {
      // Simulate a development workflow

      // 1. Create a project structure
      const createTool = server.tools.find((t: any) => t.name === 'create_file');
      const bashTool = server.tools.find((t: any) => t.name === 'bash');

      expect(createTool).toBeDefined();
      expect(bashTool).toBeDefined();

      // Create directory
      await bashTool.handler({
        command: `mkdir -p "${path.join(TEST_TEMP_DIR, 'project', 'src')}"`
      });

      // Create main file
      const mainContent = `function main() {
  console.log("Hello, World!");
}

main();`;

      await createTool.handler({
        path: path.join(TEST_TEMP_DIR, 'project', 'src', 'main.js'),
        content: mainContent
      });

      // 2. Search for functions
      const grepTool = server.tools.find((t: any) => t.name === 'grep');
      expect(grepTool).toBeDefined();

      const searchResult = await grepTool.handler({
        pattern: 'function',
        path: path.join(TEST_TEMP_DIR, 'project')
      });

      expect(searchResult.isError).toBeFalsy();
      expect(searchResult.content[0].text).toContain('function main');

      // 3. Edit the file
      const editTool = server.tools.find((t: any) => t.name === 'edit_file');
      expect(editTool).toBeDefined();

      await editTool.handler({
        path: path.join(TEST_TEMP_DIR, 'project', 'src', 'main.js'),
        oldText: 'Hello, World!',
        newText: 'Hello, Integration Test!'
      });

      // 4. Verify changes
      const readTool = server.tools.find((t: any) => t.name === 'read_file');
      expect(readTool).toBeDefined();

      const finalResult = await readTool.handler({
        path: path.join(TEST_TEMP_DIR, 'project', 'src', 'main.js')
      });

      expect(finalResult.content[0].text).toContain('Hello, Integration Test!');

      // 5. Run the file (if Node.js is available)
      try {
        const runResult = await bashTool.handler({
          command: `node "${path.join(TEST_TEMP_DIR, 'project', 'src', 'main.js')}"`
        });

        if (!runResult.isError) {
          expect(runResult.content[0].text).toContain('Hello, Integration Test!');
        }
      } catch {
        // Node.js might not be available in test environment
      }
    });
  });
});