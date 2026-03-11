import { describe, test, expect } from '@jest/globals';
import { getConfiguredTools, ToolConfig } from '../../src/tools/index.js';
import { createMCPServer } from '../../src/index.js';

// HIP-0300 unified tool surface
const UNIFIED_TOOLSET = [
  'fs', 'exec', 'code', 'git', 'fetch', 'workspace', 'ui',   // core
  'think', 'memory', 'hanzo', 'plan', 'tasks', 'mode',         // optional
];

describe('Configuration System', () => {
  describe('getConfiguredTools', () => {
    test('returns HIP-0300 unified surface by default', () => {
      const tools = getConfiguredTools();
      const names = tools.map((t) => t.name);

      expect(names).toHaveLength(UNIFIED_TOOLSET.length);
      expect(new Set(names).size).toBe(names.length);
      for (const name of UNIFIED_TOOLSET) {
        expect(names).toContain(name);
      }
    });

    test('supports full-surface with UI extensions enabled', () => {
      const tools = getConfiguredTools({
        enableUI: true,
        enableAutoGUI: true,
        enableOrchestration: true,
        enableUIRegistry: true,
        enableGitHubUI: true,
        enableDesktop: true,
        dedupeTools: true,
      });

      const names = tools.map((t) => t.name);

      // Unified core + UI extensions
      expect(names.length).toBeGreaterThan(UNIFIED_TOOLSET.length);
      for (const name of UNIFIED_TOOLSET) {
        expect(names).toContain(name);
      }
      expect(names).toContain('spawn_agent');
      expect(names).toContain('autogui_click');
      expect(names).toContain('hanzo_desktop');
      expect(names).toContain('playwright_control');
      expect(new Set(names).size).toBe(names.length);
    });

    test('supports category filtering in legacy mode', () => {
      const tools = getConfiguredTools({
        unified: false,
        enableLegacy: true,
        enableCore: true,
        enabledCategories: ['files'],
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
      });

      const names = tools.map((t) => t.name);
      expect(names).toContain('read');
      expect(names).toContain('write');
      expect(names).toContain('list');
      expect(names).toContain('info');
      expect(names).toContain('tree');
      expect(names).not.toContain('grep');
      expect(names).not.toContain('bash');
      expect(names).not.toContain('edit');
    });

    test('disables specific unified tools', () => {
      const tools = getConfiguredTools({
        disabledTools: ['fetch', 'hanzo'],
      });

      const names = tools.map((t) => t.name);
      expect(names).not.toContain('fetch');
      expect(names).not.toContain('hanzo');
      expect(names).toContain('fs');
      expect(names).toContain('exec');
      expect(names).toContain('code');
    });

    test('supports custom tools with minimal config', () => {
      const customTool = {
        name: 'custom_test_tool',
        description: 'A custom tool for testing',
        inputSchema: {
          type: 'object' as const,
          properties: { test: { type: 'string' } },
          required: ['test'],
        },
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'Custom tool executed' }],
        }),
      };

      const tools = getConfiguredTools({
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
        customTools: [customTool],
      });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('custom_test_tool');
    });
  });

  describe('createMCPServer configuration', () => {
    test('creates server with HIP-0300 unified surface by default', async () => {
      const server = await createMCPServer();
      const names = server.tools.map((t) => t.name);

      // All unified tools present
      for (const name of UNIFIED_TOOLSET) {
        expect(names).toContain(name);
      }
      expect(names).toHaveLength(UNIFIED_TOOLSET.length);
    });

    test('supports full-surface server configuration', async () => {
      const server = await createMCPServer({
        toolConfig: {
          enableUI: true,
          enableAutoGUI: true,
          enableOrchestration: true,
          enableUIRegistry: true,
          enableGitHubUI: true,
          dedupeTools: true,
        },
      });

      const names = server.tools.map((t) => t.name);
      expect(names).toContain('fs');
      expect(names).toContain('exec');
      expect(names).toContain('spawn_agent');
      expect(names).toContain('autogui_status');
    });

    test('supports dynamic add/remove tool lifecycle', async () => {
      const server = await createMCPServer();
      const initialCount = server.tools.length;

      const testTool = {
        name: 'dynamic_test_tool',
        description: 'Dynamic test tool',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'Dynamic tool' }],
        }),
      };

      server.addTool(testTool);
      expect(server.tools.length).toBe(initialCount + 1);
      expect(server.tools.some((t) => t.name === 'dynamic_test_tool')).toBe(true);

      server.removeTool('dynamic_test_tool');
      expect(server.tools.length).toBe(initialCount);
      expect(server.tools.some((t) => t.name === 'dynamic_test_tool')).toBe(false);
    });
  });

  describe('Tool validation', () => {
    test('validates tool schema structure and uniqueness', () => {
      const tools = getConfiguredTools({
        enableUI: true,
        enableAutoGUI: true,
        enableOrchestration: true,
        enableUIRegistry: true,
        enableGitHubUI: true,
      });

      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);

      tools.forEach((tool) => {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.handler).toBe('function');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });
    });

    test('handles invalid category/disabled tool names gracefully', () => {
      // Category filtering is a legacy concept
      const withBadCategory = getConfiguredTools({
        unified: false,
        enableLegacy: true,
        enableCore: true,
        enabledCategories: ['invalid-category', 'files'],
      });
      expect(withBadCategory.some((t) => t.name === 'read')).toBe(true);

      // Disabled tools work on unified surface
      const withBadDisabled = getConfiguredTools({
        disabledTools: ['invalid-tool', 'exec'],
      });
      expect(withBadDisabled.some((t) => t.name === 'exec')).toBe(false);
      expect(withBadDisabled.some((t) => t.name === 'fs')).toBe(true);
    });
  });
});
