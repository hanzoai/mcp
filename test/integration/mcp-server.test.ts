import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createMCPServer } from '../../src/index.js';
import {
  createTestFile,
  TEST_TEMP_DIR,
} from '../setup.js';
import * as path from 'path';

// HIP-0300 unified tool names
const UNIFIED_TOOLS = ['fs', 'exec', 'code', 'git', 'fetch', 'workspace', 'ui', 'think', 'memory', 'hanzo', 'plan', 'tasks', 'mode'];

describe('MCP Server Integration', () => {
  let server: any;

  beforeEach(async () => {
    server = await createMCPServer({
      name: 'test-mcp',
      version: '1.0.0-test',
    });
  });

  afterEach(() => {
    server = null;
  });

  test('creates server with HIP-0300 unified toolset', () => {
    const toolNames = server.tools.map((t: any) => t.name);

    for (const name of UNIFIED_TOOLS) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames).toHaveLength(UNIFIED_TOOLS.length);

    // No UI extensions by default
    expect(toolNames.some((name: string) => name.startsWith('autogui_'))).toBe(false);
    expect(toolNames).not.toContain('spawn_agent');
  });

  test('executes complete file workflow via fs tool', async () => {
    const fsTool = server.tools.find((t: any) => t.name === 'fs');
    expect(fsTool).toBeDefined();

    const testPath = path.join(TEST_TEMP_DIR, 'integration-test.txt');

    // Write (create)
    await fsTool.handler({ action: 'write', uri: testPath, content: 'Integration test content' });

    // Read
    const readResult = await fsTool.handler({ action: 'read', uri: testPath });
    expect(readResult.isError).toBeFalsy();
    const readData = JSON.parse(readResult.content[0].text);
    expect(readData.ok).toBe(true);
    expect(readData.data.content).toContain('Integration test content');

    // Edit (apply_patch)
    await fsTool.handler({
      action: 'apply_patch',
      uri: testPath,
      patch: 'Integration',
      new_text: 'Updated integration',
    });

    // Read after edit
    const readAfter = await fsTool.handler({ action: 'read', uri: testPath });
    const readAfterData = JSON.parse(readAfter.content[0].text);
    expect(readAfterData.data.content).toContain('Updated integration');

    // Delete (rm)
    const deleteResult = await fsTool.handler({ action: 'rm', uri: testPath, confirm: true });
    expect(deleteResult.isError).toBeFalsy();
  });

  test('executes search workflow via fs tool', async () => {
    await createTestFile('search-integration/file1.js', 'function testFunction() { return "hello"; }');
    await createTestFile('search-integration/file2.py', 'def test_function(): return "world"');
    await createTestFile('search-integration/file3.txt', 'This is a test file with hello world');

    const fsTool = server.tools.find((t: any) => t.name === 'fs');
    expect(fsTool).toBeDefined();

    // search_text (replaces grep)
    const searchResult = await fsTool.handler({
      action: 'search_text',
      uri: path.join(TEST_TEMP_DIR, 'search-integration'),
      query: 'test',
    });
    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0].text).toContain('test');

    // list with pattern (replaces find)
    const listResult = await fsTool.handler({
      action: 'list',
      uri: path.join(TEST_TEMP_DIR, 'search-integration'),
      pattern: '*.js',
    });
    expect(listResult.isError).toBeFalsy();
    expect(listResult.content[0].text).toContain('file1.js');
  });

  test('executes shell workflow via exec tool', async () => {
    const execTool = server.tools.find((t: any) => t.name === 'exec');
    expect(execTool).toBeDefined();

    const echoResult = await execTool.handler({
      action: 'exec',
      command: 'echo "Integration test shell"',
    });

    expect(echoResult.isError).toBeFalsy();
    const data = JSON.parse(echoResult.content[0].text);
    expect(data.data.stdout).toContain('Integration test shell');
  });

  test('handles command and file errors gracefully', async () => {
    const execTool = server.tools.find((t: any) => t.name === 'exec');
    const fsTool = server.tools.find((t: any) => t.name === 'fs');

    const badCmd = await execTool.handler({ action: 'exec', command: 'this-command-does-not-exist-xyz' });
    expect(badCmd.isError).toBe(true);

    const badRead = await fsTool.handler({ action: 'read', uri: '/this/path/does/not/exist/file.txt' });
    expect(badRead.isError).toBe(true);
  });

  test('respects disabled tools in unified mode', async () => {
    const limitedServer = await createMCPServer({
      toolConfig: {
        disabledTools: ['fetch', 'hanzo', 'memory'],
      },
    });

    const names = limitedServer.tools.map((t: any) => t.name);
    expect(names).toContain('fs');
    expect(names).toContain('exec');
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('hanzo');
    expect(names).not.toContain('memory');
  });

  test('supports full-surface with UI extensions enabled', async () => {
    const fullServer = await createMCPServer({
      toolConfig: {
        enableUI: true,
        enableAutoGUI: true,
        enableOrchestration: true,
        enableUIRegistry: true,
        enableGitHubUI: true,
      },
    });

    const names = fullServer.tools.map((t: any) => t.name);
    // Unified core present
    expect(names).toContain('fs');
    expect(names).toContain('exec');
    // UI extensions present
    expect(names).toContain('spawn_agent');
    expect(names).toContain('autogui_status');
  });

  test('works with minimal custom-only configuration', async () => {
    const minimalServer = await createMCPServer({
      toolConfig: {
        unified: false,
        enableLegacy: true,
        enableCore: false,
        enableAI: false,
        enableAST: false,
        enableVector: false,
        enableTodo: false,
        enableModes: false,
        enableCloud: false,
        enableVCS: false,
        enableRefactor: false,
        enableMemory: false,
        enablePlan: false,
        customTools: [
          {
            name: 'minimal_tool',
            description: 'Minimal test tool',
            inputSchema: {
              type: 'object' as const,
              properties: {},
              required: [],
            },
            handler: async () => ({
              content: [{ type: 'text' as const, text: 'Minimal tool works' }],
            }),
          },
        ],
      },
    });

    expect(minimalServer.tools).toHaveLength(1);
    expect(minimalServer.tools[0].name).toBe('minimal_tool');
  });
});
