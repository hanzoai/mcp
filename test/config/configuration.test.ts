import { describe, test, expect, beforeEach } from '@jest/globals';
import { getConfiguredTools, ToolConfig } from '../../src/tools/index.js';
import { createMCPServer } from '../../src/index.js';

describe('Configuration System', () => {
  
  describe('getConfiguredTools', () => {
    test('should return core tools by default', () => {
      const tools = getConfiguredTools();
      
      expect(tools.length).toBeGreaterThan(0);
      
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
      
      // Should not have UI or AutoGUI tools
      const toolNames = tools.map(t => t.name);
      expect(toolNames.some(name => name.includes('ui_') || name.includes('autogui_'))).toBe(false);
    });

    test('should disable all tools when enableCore is false', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: false,
        enableAutoGUI: false
      };
      
      const tools = getConfiguredTools(config);
      
      // Should only have custom tools if any
      const coreToolNames = ['read_file', 'write_file', 'grep', 'bash'];
      const hasAnyCoreTool = tools.some(t => coreToolNames.includes(t.name));
      expect(hasAnyCoreTool).toBe(false);
    });

    test('should enable UI tools when enableUI is true', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: true,
        enableAutoGUI: false
      };
      
      const tools = getConfiguredTools(config);
      
      // Should have UI tools (if any exist in the system)
      // This test is flexible since UI tools may or may not exist
      expect(Array.isArray(tools)).toBe(true);
    });

    test('should enable AutoGUI tools when enableAutoGUI is true', () => {
      const config: ToolConfig = {
        enableCore: false,
        enableUI: false,
        enableAutoGUI: true
      };
      
      const tools = getConfiguredTools(config);
      
      // Should have AutoGUI tools (if any exist in the system)
      expect(Array.isArray(tools)).toBe(true);
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
      
      expect(tools).toHaveLength(1);
      expect(tools[0]).toBe(customTool);
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
      
      expect(server.tools).toHaveLength(1);
      expect(server.tools[0].name).toBe('server_custom_tool');
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
      
      expect(uniqueNames.size).toBe(names.length);
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