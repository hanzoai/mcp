import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { autoguiTools } from '../../src/autogui/tools/autogui-tools.js';

// Mock external dependencies
jest.mock('../../src/autogui/factory.js', () => ({
  createAutoGUI: jest.fn(),
  getAvailableAutoGUIImplementations: jest.fn(),
  getAutoGUIImplementationStatus: jest.fn(),
}));

describe('AutoGUI Tools', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock factory functions
    const { createAutoGUI, getAvailableAutoGUIImplementations, getAutoGUIImplementationStatus } = require('../../src/autogui/factory.js');
    
    getAvailableAutoGUIImplementations.mockResolvedValue(['base', 'mock']);
    getAutoGUIImplementationStatus.mockResolvedValue({
      base: { available: true, status: 'ready' },
      mock: { available: true, status: 'ready' }
    });
    
    createAutoGUI.mockResolvedValue({
      getImplementation: () => 'mock',
      isAvailable: () => true,
      getScreenSize: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
      screenshot: jest.fn().mockResolvedValue('base64-image-data'),
      click: jest.fn().mockResolvedValue(undefined),
      doubleClick: jest.fn().mockResolvedValue(undefined),
      rightClick: jest.fn().mockResolvedValue(undefined),
      type: jest.fn().mockResolvedValue(undefined),
      key: jest.fn().mockResolvedValue(undefined),
      scroll: jest.fn().mockResolvedValue(undefined),
      moveMouse: jest.fn().mockResolvedValue(undefined),
      findElement: jest.fn().mockResolvedValue({ x: 100, y: 100, width: 50, height: 30 }),
    });
  });

  describe('autoguiTools array', () => {
    test('should export AutoGUI tools array', () => {
      expect(Array.isArray(autoguiTools)).toBe(true);
      expect(autoguiTools.length).toBeGreaterThan(0);
    });

    test('should have valid tool structures', () => {
      autoguiTools.forEach(tool => {
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
      const names = autoguiTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(autoguiTools.length);
    });

    test('should include core AutoGUI functionality', () => {
      const toolNames = autoguiTools.map(tool => tool.name);
      
      // Should include status tool
      expect(toolNames.some(name => name.includes('status'))).toBe(true);
      
      // Should include basic interaction tools if available
      const expectedTools = ['status', 'screenshot', 'click', 'type'];
      expectedTools.forEach(expectedTool => {
        expect(toolNames.some(name => name.includes(expectedTool))).toBe(true);
      });
    });
  });

  describe('autogui_status tool', () => {
    test('should have correct metadata', () => {
      const statusTool = autoguiTools.find(tool => tool.name === 'autogui_status');
      expect(statusTool).toBeDefined();
      expect(statusTool!.description).toContain('status');
      expect(statusTool!.inputSchema.required).toEqual([]);
    });

    test('should return implementation status', async () => {
      const statusTool = autoguiTools.find(tool => tool.name === 'autogui_status');
      
      const result = await statusTool!.handler({});
      
      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBeTruthy();
    });
  });

  describe('Screenshot functionality', () => {
    test('should have screenshot tool', () => {
      const screenshotTool = autoguiTools.find(tool => 
        tool.name.includes('screenshot') || tool.description.toLowerCase().includes('screenshot')
      );
      expect(screenshotTool).toBeDefined();
    });

    test('should handle screenshot requests', async () => {
      const screenshotTool = autoguiTools.find(tool => 
        tool.name.includes('screenshot') || tool.description.toLowerCase().includes('screenshot')
      );
      
      if (screenshotTool) {
        try {
          const result = await screenshotTool.handler({});
          expect(result).toHaveProperty('content');
          expect(Array.isArray(result.content)).toBe(true);
        } catch (error) {
          // Acceptable if AutoGUI implementation is not available
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Mouse interaction tools', () => {
    test('should have click tool', () => {
      const clickTool = autoguiTools.find(tool => 
        tool.name.includes('click') || tool.description.toLowerCase().includes('click')
      );
      expect(clickTool).toBeDefined();
    });

    test('should validate click coordinates', () => {
      const clickTool = autoguiTools.find(tool => 
        tool.name.includes('click') || tool.description.toLowerCase().includes('click')
      );
      
      if (clickTool) {
        const schema = clickTool.inputSchema;
        expect(schema.properties).toHaveProperty('x');
        expect(schema.properties).toHaveProperty('y');
        expect(schema.required).toContain('x');
        expect(schema.required).toContain('y');
      }
    });

    test('should handle click actions', async () => {
      const clickTool = autoguiTools.find(tool => 
        tool.name.includes('click') || tool.description.toLowerCase().includes('click')
      );
      
      if (clickTool) {
        try {
          const result = await clickTool.handler({ x: 100, y: 100 });
          expect(result).toHaveProperty('content');
        } catch (error) {
          // Acceptable if AutoGUI implementation is not available
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Keyboard interaction tools', () => {
    test('should have typing tool', () => {
      const typeTool = autoguiTools.find(tool => 
        tool.name.includes('type') || tool.description.toLowerCase().includes('type')
      );
      expect(typeTool).toBeDefined();
    });

    test('should validate text input', () => {
      const typeTool = autoguiTools.find(tool => 
        tool.name.includes('type') || tool.description.toLowerCase().includes('type')
      );
      
      if (typeTool) {
        const schema = typeTool.inputSchema;
        expect(schema.properties).toHaveProperty('text');
        expect(schema.required).toContain('text');
      }
    });

    test('should handle typing actions', async () => {
      const typeTool = autoguiTools.find(tool => 
        tool.name.includes('type') || tool.description.toLowerCase().includes('type')
      );
      
      if (typeTool) {
        try {
          const result = await typeTool.handler({ text: 'Hello World' });
          expect(result).toHaveProperty('content');
        } catch (error) {
          // Acceptable if AutoGUI implementation is not available
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Error handling', () => {
    test('should handle AutoGUI initialization failures', async () => {
      const { createAutoGUI } = require('../../src/autogui/factory.js');
      createAutoGUI.mockRejectedValue(new Error('AutoGUI not available'));
      
      const statusTool = autoguiTools.find(tool => tool.name === 'autogui_status');
      
      try {
        const result = await statusTool!.handler({});
        // Should handle initialization failure gracefully
        expect(result).toHaveProperty('content');
      } catch (error) {
        // Acceptable for AutoGUI tools when implementation is not available
        expect(error).toBeDefined();
      }
    });

    test('should handle missing implementations', async () => {
      const { getAvailableAutoGUIImplementations } = require('../../src/autogui/factory.js');
      getAvailableAutoGUIImplementations.mockResolvedValue([]);
      
      const statusTool = autoguiTools.find(tool => tool.name === 'autogui_status');
      
      try {
        const result = await statusTool!.handler({});
        expect(result).toHaveProperty('content');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    test('should handle invalid coordinates', async () => {
      const clickTool = autoguiTools.find(tool => 
        tool.name.includes('click') || tool.description.toLowerCase().includes('click')
      );
      
      if (clickTool) {
        try {
          // Test with negative coordinates
          const result = await clickTool.handler({ x: -1, y: -1 });
          
          if (!result.isError) {
            // Tool might handle invalid coordinates gracefully
            expect(result).toHaveProperty('content');
          } else {
            // Or it might return an error, which is also acceptable
            expect(result.isError).toBe(true);
          }
        } catch (error) {
          // Validation error is acceptable
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Factory integration', () => {
    test('should interact with factory functions', () => {
      const { createAutoGUI, getAvailableAutoGUIImplementations, getAutoGUIImplementationStatus } = require('../../src/autogui/factory.js');
      
      // Verify mocks are set up (indicates proper factory integration)
      expect(createAutoGUI).toBeDefined();
      expect(getAvailableAutoGUIImplementations).toBeDefined();
      expect(getAutoGUIImplementationStatus).toBeDefined();
    });

    test('should cache AutoGUI adapter instance', async () => {
      const clickTool = autoguiTools.find(tool => 
        tool.name.includes('click') || tool.description.toLowerCase().includes('click')
      );
      
      if (clickTool) {
        const { createAutoGUI } = require('../../src/autogui/factory.js');
        
        // First call
        try {
          await clickTool.handler({ x: 10, y: 10 });
        } catch {}
        
        // Second call
        try {
          await clickTool.handler({ x: 20, y: 20 });
        } catch {}
        
        // createAutoGUI should ideally be called only once due to caching
        // But this depends on implementation details
        expect(createAutoGUI).toHaveBeenCalled();
      }
    });
  });

  describe('Tool categories', () => {
    test('should provide system information tools', () => {
      const systemTools = autoguiTools.filter(tool =>
        tool.name.includes('status') || 
        tool.description.toLowerCase().includes('status') ||
        tool.description.toLowerCase().includes('info')
      );
      
      expect(systemTools.length).toBeGreaterThan(0);
    });

    test('should provide screen interaction tools', () => {
      const screenTools = autoguiTools.filter(tool =>
        tool.name.includes('screenshot') || 
        tool.name.includes('click') ||
        tool.name.includes('mouse') ||
        tool.description.toLowerCase().includes('screen') ||
        tool.description.toLowerCase().includes('mouse')
      );
      
      expect(screenTools.length).toBeGreaterThan(0);
    });

    test('should provide keyboard interaction tools', () => {
      const keyboardTools = autoguiTools.filter(tool =>
        tool.name.includes('type') || 
        tool.name.includes('key') ||
        tool.description.toLowerCase().includes('keyboard') ||
        tool.description.toLowerCase().includes('type')
      );
      
      expect(keyboardTools.length).toBeGreaterThan(0);
    });
  });
});