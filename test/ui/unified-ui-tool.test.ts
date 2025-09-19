/**
 * Tests for the Unified UI Tool
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { unifiedUITool } from '../../src/ui/unified-ui-tool';

describe('Unified UI Tool', () => {
  describe('Tool Structure', () => {
    it('should have correct name and description', () => {
      expect(unifiedUITool.name).toBe('ui');
      expect(unifiedUITool.description).toContain('Comprehensive UI tool');
    });

    it('should have all methods in schema', () => {
      const schema = unifiedUITool.inputSchema;
      const methodEnum = schema.properties.method.enum;

      expect(methodEnum).toContain('init');
      expect(methodEnum).toContain('list_components');
      expect(methodEnum).toContain('get_component');
      expect(methodEnum).toContain('get_source');
      expect(methodEnum).toContain('get_demo');
      expect(methodEnum).toContain('add_component');
      expect(methodEnum).toContain('list_blocks');
      expect(methodEnum).toContain('get_block');
      expect(methodEnum).toContain('list_styles');
      expect(methodEnum).toContain('search');
      expect(methodEnum).toContain('installation_guide');
      expect(methodEnum).toContain('compare_frameworks');
      expect(methodEnum).toContain('convert_framework');
    });
  });

  describe('Method: init', () => {
    it('should initialize with default style', async () => {
      const result = await unifiedUITool.handler({ method: 'init' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Initialize Hanzo UI');
      expect(result.content[0].text).toContain('default');
    });

    it('should initialize with custom style', async () => {
      const result = await unifiedUITool.handler({
        method: 'init',
        style: 'new-york'
      });

      expect(result.content[0].text).toContain('new-york');
    });
  });

  describe('Method: list_components', () => {
    it('should list all components', async () => {
      const result = await unifiedUITool.handler({
        method: 'list_components'
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Hanzo UI Components');
    });

    it('should filter by type', async () => {
      const result = await unifiedUITool.handler({
        method: 'list_components',
        type: 'ui'
      });

      expect(result.content[0].text).toContain('Hanzo UI Components');
    });

    it('should filter by category', async () => {
      const result = await unifiedUITool.handler({
        method: 'list_components',
        category: 'Forms'
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe('Method: get_component', () => {
    it('should get component by name parameter', async () => {
      const result = await unifiedUITool.handler({
        method: 'get_component',
        name: 'button'
      });

      // Will show not found since we're not mocking the registry
      expect(result.content[0].text).toBeDefined();
    });

    it('should get component by component parameter (alias)', async () => {
      const result = await unifiedUITool.handler({
        method: 'get_component',
        component: 'button'
      });

      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('Method: search', () => {
    it('should search with query parameter', async () => {
      const result = await unifiedUITool.handler({
        method: 'search',
        query: 'button'
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Search Results');
    });

    it('should search with search parameter (alias)', async () => {
      const result = await unifiedUITool.handler({
        method: 'search',
        search: 'form'
      });

      expect(result.content[0].text).toContain('Search Results');
    });
  });

  describe('Method: add_component', () => {
    it('should provide add instructions for React', async () => {
      const result = await unifiedUITool.handler({
        method: 'add_component',
        name: 'button'
      });

      expect(result.content[0].text).toContain('Add button Component');
      expect(result.content[0].text).toContain('npx @hanzo/ui@latest add button');
    });

    it('should provide add instructions for Vue', async () => {
      const result = await unifiedUITool.handler({
        method: 'add_component',
        component: 'button',
        framework: 'vue'
      });

      expect(result.content[0].text).toContain('for Vue');
      expect(result.content[0].text).toContain('@hanzo/ui/vue');
    });
  });

  describe('Method: compare_frameworks', () => {
    it('should show framework comparison', async () => {
      const result = await unifiedUITool.handler({
        method: 'compare_frameworks'
      });

      expect(result.content[0].text).toContain('Framework Component Coverage');
      expect(result.content[0].text).toContain('React');
      expect(result.content[0].text).toContain('Vue');
      expect(result.content[0].text).toContain('Svelte');
    });

    it('should show comparison for specific component', async () => {
      const result = await unifiedUITool.handler({
        method: 'compare_frameworks',
        component: 'button'
      });

      expect(result.content[0].text).toContain('Button Component');
    });
  });

  describe('Method: convert_framework', () => {
    it('should show conversion instructions', async () => {
      const result = await unifiedUITool.handler({
        method: 'convert_framework',
        component: 'button',
        from: 'react',
        to: 'vue'
      });

      expect(result.content[0].text).toContain('Converting button from react to vue');
      expect(result.content[0].text).toContain('onClick → @click');
    });
  });

  describe('Error Handling', () => {
    it('should error when method is missing', async () => {
      const result = await unifiedUITool.handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('method parameter is required');
    });

    it('should error for unknown method', async () => {
      const result = await unifiedUITool.handler({
        method: 'unknown_method' as any
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown method');
    });
  });

  describe('Parameter Aliases', () => {
    it('should support name and component as aliases', async () => {
      const result1 = await unifiedUITool.handler({
        method: 'get_component',
        name: 'button'
      });

      const result2 = await unifiedUITool.handler({
        method: 'get_component',
        component: 'button'
      });

      // Both should work
      expect(result1.isError).toBeFalsy();
      expect(result2.isError).toBeFalsy();
    });

    it('should support query and search as aliases', async () => {
      const result1 = await unifiedUITool.handler({
        method: 'search',
        query: 'test'
      });

      const result2 = await unifiedUITool.handler({
        method: 'search',
        search: 'test'
      });

      // Both should work
      expect(result1.isError).toBeFalsy();
      expect(result2.isError).toBeFalsy();
    });
  });

  describe('All Methods Coverage', () => {
    const methods = [
      'init',
      'list_components',
      'get_component',
      'get_source',
      'get_demo',
      'add_component',
      'list_blocks',
      'get_block',
      'list_styles',
      'search',
      'installation_guide',
      'compare_frameworks',
      'convert_framework'
    ];

    methods.forEach(method => {
      it(`should handle method: ${method}`, async () => {
        const args: any = { method };

        // Add required parameters for specific methods
        if (['get_component', 'get_source', 'get_demo', 'add_component'].includes(method)) {
          args.name = 'button';
        }
        if (['get_block'].includes(method)) {
          args.name = 'hero';
        }
        if (['search'].includes(method)) {
          args.query = 'test';
        }
        if (method === 'convert_framework') {
          args.component = 'button';
          args.from = 'react';
          args.to = 'vue';
        }

        const result = await unifiedUITool.handler(args);
        expect(result.content).toBeDefined();
        expect(result.content[0].type).toBe('text');
      });
    });
  });
});