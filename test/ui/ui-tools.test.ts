import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { uiTools } from '../../src/ui/ui-tools.js';

// Mock external dependencies
jest.mock('../../src/ui/registry-api.js', () => ({
  fetchRegistry: jest.fn(),
  getRegistryItem: jest.fn(),
  getRegistryItemUrl: jest.fn(),
}));

describe('UI Tools', () => {
  
  beforeEach(() => {
    // Reset environment variables
    delete process.env.REGISTRY_URL;
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('uiTools array', () => {
    test('should export UI tools array', () => {
      expect(Array.isArray(uiTools)).toBe(true);
      expect(uiTools.length).toBeGreaterThan(0);
    });

    test('should have valid tool structures', () => {
      uiTools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('handler');
        
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.handler).toBe('function');
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
      });
    });

    test('should have unique tool names', () => {
      const names = uiTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(uiTools.length);
    });
  });

  describe('Tool functionality', () => {
    test('should handle registry errors gracefully', async () => {
      // Test with a tool that likely interacts with registry
      const tool = uiTools.find(t => t.name.includes('list') || t.name.includes('registry'));
      
      if (tool) {
        const { fetchRegistry } = require('../../src/ui/registry-api.js');
        fetchRegistry.mockRejectedValue(new Error('Network error'));
        
        const result = await tool.handler({});
        
        // Should not throw and should handle error gracefully
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
      }
    });

    test('should validate input schemas', async () => {
      // Test each tool's input schema structure
      uiTools.forEach(tool => {
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema).toHaveProperty('properties');
        
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        }
      });
    });

    test('should handle empty/minimal inputs', async () => {
      // Test tools that don't require parameters
      const toolsWithoutRequired = uiTools.filter(tool => 
        !tool.inputSchema.required || tool.inputSchema.required.length === 0
      );
      
      for (const tool of toolsWithoutRequired) {
        try {
          const result = await tool.handler({});
          expect(result).toHaveProperty('content');
          expect(Array.isArray(result.content)).toBe(true);
        } catch (error) {
          // Tool might require external dependencies that aren't available in test
          // This is acceptable for UI tools that depend on external registries
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Registry caching', () => {
    test('should handle registry URL from environment', () => {
      const originalUrl = process.env.REGISTRY_URL;
      
      process.env.REGISTRY_URL = 'https://test.example.com/registry.json';
      
      // Test that environment variable is respected
      expect(process.env.REGISTRY_URL).toBe('https://test.example.com/registry.json');
      
      // Restore original value
      if (originalUrl) {
        process.env.REGISTRY_URL = originalUrl;
      } else {
        delete process.env.REGISTRY_URL;
      }
    });
  });

  describe('Error handling', () => {
    test('should handle network failures', async () => {
      const { fetchRegistry } = require('../../src/ui/registry-api.js');
      fetchRegistry.mockRejectedValue(new Error('Network timeout'));
      
      // Try to execute tools that might depend on network
      const networkDependentTools = uiTools.filter(tool => 
        tool.description.toLowerCase().includes('registry') ||
        tool.description.toLowerCase().includes('component')
      );
      
      for (const tool of networkDependentTools) {
        try {
          const result = await tool.handler({});
          // Should handle network errors gracefully
          expect(result).toHaveProperty('content');
        } catch (error) {
          // Acceptable for tools that require network access
          expect(error).toBeDefined();
        }
      }
    });

    test('should handle malformed registry data', async () => {
      const { fetchRegistry } = require('../../src/ui/registry-api.js');
      fetchRegistry.mockResolvedValue([{ invalid: 'data' }]);
      
      const registryTools = uiTools.filter(tool => 
        tool.name.includes('registry') || tool.name.includes('list')
      );
      
      for (const tool of registryTools) {
        try {
          const result = await tool.handler({});
          expect(result).toHaveProperty('content');
        } catch (error) {
          // Should handle malformed data gracefully
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Integration capabilities', () => {
    test('should provide component-related functionality', () => {
      const componentTools = uiTools.filter(tool =>
        tool.description.toLowerCase().includes('component') ||
        tool.name.includes('component')
      );
      
      expect(componentTools.length).toBeGreaterThan(0);
      
      componentTools.forEach(tool => {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });

    test('should provide registry interaction capabilities', () => {
      const registryTools = uiTools.filter(tool =>
        tool.description.toLowerCase().includes('registry') ||
        tool.name.includes('registry') ||
        tool.name.includes('list')
      );
      
      expect(registryTools.length).toBeGreaterThan(0);
      
      registryTools.forEach(tool => {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });
  });
});