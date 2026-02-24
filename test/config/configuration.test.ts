import { describe, test, expect, beforeEach } from '@jest/globals';
import { getConfiguredTools, ToolConfig } from '../../src/tools/index.js';
import { createMCPServer } from '../../src/index.js';

/**
 * getConfiguredTools behavior:
 *
 * Default flags:
 *   enableCore = true
 *   enableUI = false
 *   enableAutoGUI = false
 *   enableOrchestration = true   (6 tools)
 *   enableUIRegistry = true      (6 tools, all ui_ prefixed)
 *   enableGitHubUI = true        (13 tools, all ui_ prefixed)
 *
 * So even with enableUI=false and enableAutoGUI=false, the orchestration,
 * uiRegistry, and githubUI tools (25 total) are always included unless
 * explicitly disabled.
 *
 * Core tools comprise 19 tools across 4 categories:
 *   files (5), search (3), shell (6), edit (5)
 *
 * When enableUI is true, uiTools (11) and multiFrameworkTools (3) are added.
 * When enableAutoGUI is true, autoguiTools (18) are added.
 *
 * There are 5 duplicate tool names across uiTools, uiRegistryTools, and
 * githubUITools: ui_list_components, ui_get_component, ui_get_component_demo,
 * ui_get_block, ui_list_blocks.
 */

// Count of always-on default tools (orchestration + uiRegistry + githubUI)
const DEFAULT_EXTRAS_COUNT = 6 + 6 + 13; // 25
const CORE_TOOLS_COUNT = 19;
const UI_TOOLS_COUNT = 11 + 3; // uiTools + multiFrameworkTools
const AUTOGUI_TOOLS_COUNT = 18;
const DUPLICATE_NAMES_COUNT = 5;

describe('Configuration System', () => {

  describe('getConfiguredTools', () => {
    test('should return core tools plus default extras by default', () => {
      const tools = getConfiguredTools();

      // Default config: enableCore=true + orchestration + uiRegistry + githubUI
      expect(tools.length).toBe(CORE_TOOLS_COUNT + DEFAULT_EXTRAS_COUNT);

      // Should include core file operations
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
      expect(tools.some(t => t.name === 'write_file')).toBe(true);

      // Should include search tools
      expect(tools.some(t => t.name === 'grep')).toBe(true);
      expect(tools.some(t => t.name === 'find_files')).toBe(true);

      // Should include edit tools
      expect(tools.some(t => t.name === 'edit_file')).toBe(true);

      // Should include shell tools
      expect(tools.some(t => t.name === 'bash')).toBe(true);

      // Should include orchestration tools (default enabled)
      expect(tools.some(t => t.name === 'spawn_agent')).toBe(true);

      // Should include UI registry tools (default enabled)
      expect(tools.some(t => t.name === 'ui_list_components')).toBe(true);

      // Should include GitHub UI tools (default enabled)
      expect(tools.some(t => t.name === 'ui_fetch_component')).toBe(true);
    });

    test('should enable only core tools when enableCore is true', () => {
      const config: ToolConfig = {
        enableCore: true,
        enableUI: false,
        enableAutoGUI: false
      };

      const tools = getConfiguredTools(config);

      // Should have core tools
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
      expect(tools.some(t => t.name === 'bash')).toBe(true);

      // Should not have AutoGUI tools (autogui_ prefix)
      const toolNames = tools.map(t => t.name);
      expect(toolNames.some(name => name.startsWith('autogui_'))).toBe(false);

      // uiRegistry and githubUI tools (ui_ prefixed) ARE present because
      // enableUIRegistry and enableGitHubUI default to true
      expect(toolNames.some(name => name.startsWith('ui_'))).toBe(true);

      // But the UI-specific tools from uiTools (ui_init, ui_get_component_source)
      // should NOT be present since enableUI is false
      expect(toolNames).not.toContain('ui_init');
      expect(toolNames).not.toContain('ui_get_component_source');
    });

    test('should disable all tools when enableCore is false', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: false,
        enableAutoGUI: false
      };

      const tools = getConfiguredTools(config);

      // Should not have core tools
      const coreToolNames = ['read_file', 'write_file', 'grep', 'bash'];
      const hasAnyCoreTool = tools.some(t => coreToolNames.includes(t.name));
      expect(hasAnyCoreTool).toBe(false);

      // Should still have default-enabled extras (orchestration, uiRegistry, githubUI)
      expect(tools.length).toBe(DEFAULT_EXTRAS_COUNT);
      expect(tools.some(t => t.name === 'spawn_agent')).toBe(true);
      expect(tools.some(t => t.name === 'ui_list_components')).toBe(true);
    });

    test('should enable UI tools when enableUI is true', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: true,
        enableAutoGUI: false
      };

      const tools = getConfiguredTools(config);

      // Should have UI tools from uiTools and multiFrameworkTools
      expect(tools.some(t => t.name === 'ui_init')).toBe(true);
      expect(tools.some(t => t.name === 'ui_add_multi_framework')).toBe(true);
      expect(tools.some(t => t.name === 'ui_compare_frameworks')).toBe(true);
      expect(tools.some(t => t.name === 'ui_convert_framework')).toBe(true);

      // Total: uiTools(11) + multiFrameworkTools(3) + default extras(25)
      expect(tools.length).toBe(UI_TOOLS_COUNT + DEFAULT_EXTRAS_COUNT);
    });

    test('should enable AutoGUI tools when enableAutoGUI is true', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: false,
        enableAutoGUI: true
      };

      const tools = getConfiguredTools(config);

      // Should have AutoGUI tools
      expect(tools.some(t => t.name === 'autogui_status')).toBe(true);
      expect(tools.some(t => t.name === 'autogui_click')).toBe(true);
      expect(tools.some(t => t.name === 'autogui_screenshot')).toBe(true);

      // Total: autoguiTools(18) + default extras(25)
      expect(tools.length).toBe(AUTOGUI_TOOLS_COUNT + DEFAULT_EXTRAS_COUNT);
    });

    test('should support category filtering', () => {
      const config: ToolConfig = {
        enableCore: true,
        enabledCategories: ['files', 'search']
      };

      const tools = getConfiguredTools(config);

      // Should have file tools
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
      expect(tools.some(t => t.name === 'write_file')).toBe(true);

      // Should have search tools
      expect(tools.some(t => t.name === 'grep')).toBe(true);

      // Should not have edit tools (not in enabled categories)
      expect(tools.some(t => t.name === 'edit_file')).toBe(false);

      // Should not have shell tools (not in enabled categories)
      expect(tools.some(t => t.name === 'bash')).toBe(false);
    });

    test('should disable specific tools', () => {
      const config: ToolConfig = {
        enableCore: true,
        disabledTools: ['bash', 'write_file']
      };

      const tools = getConfiguredTools(config);

      // Should not have disabled tools
      expect(tools.some(t => t.name === 'bash')).toBe(false);
      expect(tools.some(t => t.name === 'write_file')).toBe(false);

      // Should still have other core tools
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
      expect(tools.some(t => t.name === 'grep')).toBe(true);
    });

    test('should add custom tools', () => {
      const customTool = {
        name: 'custom_test_tool',
        description: 'A custom tool for testing',
        inputSchema: {
          type: 'object' as const,
          properties: {
            test: { type: 'string' }
          },
          required: ['test']
        },
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'Custom tool executed' }]
        })
      };

      const config: ToolConfig = {
        enableCore: false,
        customTools: [customTool]
      };

      const tools = getConfiguredTools(config);

      // Custom tool should be present alongside default extras
      expect(tools.length).toBe(DEFAULT_EXTRAS_COUNT + 1);
      expect(tools.some(t => t.name === 'custom_test_tool')).toBe(true);

      // The custom tool object should be the one we passed in
      const found = tools.find(t => t.name === 'custom_test_tool');
      expect(found).toBe(customTool);
    });

    test('should combine multiple configuration options', () => {
      const customTool = {
        name: 'custom_combo_tool',
        description: 'A custom tool for combo testing',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: []
        },
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'Custom combo tool' }]
        })
      };

      const config: ToolConfig = {
        enableCore: true,
        enabledCategories: ['files'],
        disabledTools: ['write_file'],
        customTools: [customTool]
      };

      const tools = getConfiguredTools(config);

      // Should have file tools except disabled ones
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
      expect(tools.some(t => t.name === 'write_file')).toBe(false);

      // Should not have other categories
      expect(tools.some(t => t.name === 'bash')).toBe(false);
      expect(tools.some(t => t.name === 'grep')).toBe(false);

      // Should have custom tool
      expect(tools.some(t => t.name === 'custom_combo_tool')).toBe(true);
    });
  });

  describe('createMCPServer configuration', () => {
    test('should create server with default configuration', async () => {
      const server = await createMCPServer();

      expect(server).toHaveProperty('server');
      expect(server).toHaveProperty('tools');
      expect(server).toHaveProperty('start');
      expect(server).toHaveProperty('addTool');
      expect(server).toHaveProperty('removeTool');

      expect(Array.isArray(server.tools)).toBe(true);
      expect(server.tools.length).toBeGreaterThan(0);
    });

    test('should create server with custom tool configuration', async () => {
      const config = {
        name: 'test-mcp',
        version: '0.1.0',
        toolConfig: {
          enableCore: true,
          enableUI: false,
          enableAutoGUI: false,
          enabledCategories: ['files']
        }
      };

      const server = await createMCPServer(config);

      expect(server.tools.some(t => t.name === 'read_file')).toBe(true);
      expect(server.tools.some(t => t.name === 'bash')).toBe(false);
    });

    test('should add and remove tools dynamically', async () => {
      const server = await createMCPServer({
        toolConfig: { enableCore: false }
      });

      const initialToolCount = server.tools.length;

      const testTool = {
        name: 'dynamic_test_tool',
        description: 'Dynamic test tool',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: []
        },
        handler: async () => ({
          content: [{ type: 'text' as const, text: 'Dynamic tool' }]
        })
      };

      // Add tool
      server.addTool(testTool);
      expect(server.tools.length).toBe(initialToolCount + 1);
      expect(server.tools.some(t => t.name === 'dynamic_test_tool')).toBe(true);

      // Remove tool
      server.removeTool('dynamic_test_tool');
      expect(server.tools.length).toBe(initialToolCount);
      expect(server.tools.some(t => t.name === 'dynamic_test_tool')).toBe(false);
    });

    test('should handle custom tools in server config', async () => {
      const customTool = {
        name: 'server_custom_tool',
        description: 'Server custom tool',
        inputSchema: {
          type: 'object' as const,
          properties: {
            input: { type: 'string' }
          },
          required: ['input']
        },
        handler: async (args: any) => ({
          content: [{ type: 'text' as const, text: `Received: ${args.input}` }]
        })
      };

      const server = await createMCPServer({
        customTools: [customTool],
        toolConfig: {
          enableCore: false
        }
      });

      // Custom tool is appended to default extras (orchestration + uiRegistry + githubUI)
      expect(server.tools.length).toBe(DEFAULT_EXTRAS_COUNT + 1);
      expect(server.tools.some(t => t.name === 'server_custom_tool')).toBe(true);
    });
  });

  describe('Tool validation', () => {
    test('should validate tool structure', () => {
      const tools = getConfiguredTools({ enableCore: true });

      tools.forEach(tool => {
        // Required properties
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('handler');

        // Type checks
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.handler).toBe('function');

        // Schema structure
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');

        // Name should not be empty
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
      });
    });

    test('should have unique tool names', () => {
      const tools = getConfiguredTools({
        enableCore: true,
        enableUI: true,
        enableAutoGUI: true
      });

      const names = tools.map(t => t.name);
      const uniqueNames = new Set(names);

      // There are known duplicate tool names across uiTools, uiRegistryTools,
      // and githubUITools: ui_list_components, ui_get_component,
      // ui_get_component_demo, ui_get_block, ui_list_blocks
      const expectedTotal = CORE_TOOLS_COUNT + UI_TOOLS_COUNT + AUTOGUI_TOOLS_COUNT + DEFAULT_EXTRAS_COUNT;
      expect(names.length).toBe(expectedTotal);
      expect(uniqueNames.size).toBe(expectedTotal - DUPLICATE_NAMES_COUNT);
    });

    test('should validate input schemas are valid JSON schemas', () => {
      const tools = getConfiguredTools({ enableCore: true });

      tools.forEach(tool => {
        const schema = tool.inputSchema;

        // Should be object type
        expect(schema.type).toBe('object');

        // Should have properties
        expect(schema).toHaveProperty('properties');
        expect(typeof schema.properties).toBe('object');

        // Required should be array if present
        if (schema.required) {
          expect(Array.isArray(schema.required)).toBe(true);
          schema.required.forEach(req => {
            expect(typeof req).toBe('string');
            expect(schema.properties).toHaveProperty(req);
          });
        }
      });
    });
  });

  describe('Error handling in configuration', () => {
    test('should handle invalid category names gracefully', () => {
      const config: ToolConfig = {
        enableCore: true,
        enabledCategories: ['invalid-category', 'files']
      };

      const tools = getConfiguredTools(config);

      // Should still work and include valid categories
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
    });

    test('should handle invalid disabled tool names gracefully', () => {
      const config: ToolConfig = {
        enableCore: true,
        disabledTools: ['invalid-tool', 'bash']
      };

      const tools = getConfiguredTools(config);

      // Should still work and disable valid tools
      expect(tools.some(t => t.name === 'bash')).toBe(false);
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
    });

    test('should handle empty configurations', () => {
      const emptyConfig: ToolConfig = {};
      const tools = getConfiguredTools(emptyConfig);

      // Should use defaults
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some(t => t.name === 'read_file')).toBe(true);
    });
  });
});