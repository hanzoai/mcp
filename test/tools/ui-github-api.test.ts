/**
 * Tests for GitHub API UI component integration
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  GitHubAPIClient,
  FRAMEWORK_CONFIGS,
  fetchComponentTool,
  listComponentsTool,
  githubClient
} from '../../src/tools/ui-github-api';

describe('GitHub API UI Integration', () => {
  describe('GitHubAPIClient', () => {
    let client: GitHubAPIClient;

    beforeEach(() => {
      client = new GitHubAPIClient();
      client.clearCache();
    });

    describe('Framework Configurations', () => {
      it('should have all required frameworks configured', () => {
        expect(FRAMEWORK_CONFIGS).toHaveProperty('hanzo');
        expect(FRAMEWORK_CONFIGS).toHaveProperty('react');
        expect(FRAMEWORK_CONFIGS).toHaveProperty('svelte');
        expect(FRAMEWORK_CONFIGS).toHaveProperty('vue');
        expect(FRAMEWORK_CONFIGS).toHaveProperty('react-native');
      });

      it('should have Hanzo as default framework', () => {
        expect(FRAMEWORK_CONFIGS.hanzo.defaultFramework).toBe(true);
      });

      it('should have correct repository configurations', () => {
        // Verify Hanzo config
        expect(FRAMEWORK_CONFIGS.hanzo.owner).toBe('hanzoai');
        expect(FRAMEWORK_CONFIGS.hanzo.repo).toBe('ui');
        expect(FRAMEWORK_CONFIGS.hanzo.extension).toBe('.tsx');

        // Verify React config
        expect(FRAMEWORK_CONFIGS.react.owner).toBe('shadcn-ui');
        expect(FRAMEWORK_CONFIGS.react.repo).toBe('ui');
        expect(FRAMEWORK_CONFIGS.react.extension).toBe('.tsx');

        // Verify Svelte config
        expect(FRAMEWORK_CONFIGS.svelte.owner).toBe('huntabyte');
        expect(FRAMEWORK_CONFIGS.svelte.repo).toBe('shadcn-svelte');
        expect(FRAMEWORK_CONFIGS.svelte.extension).toBe('.svelte');

        // Verify Vue config
        expect(FRAMEWORK_CONFIGS.vue.owner).toBe('unovue');
        expect(FRAMEWORK_CONFIGS.vue.repo).toBe('shadcn-vue');
        expect(FRAMEWORK_CONFIGS.vue.extension).toBe('.vue');

        // Verify React Native config
        expect(FRAMEWORK_CONFIGS['react-native'].owner).toBe('founded-labs');
        expect(FRAMEWORK_CONFIGS['react-native'].repo).toBe('react-native-reusables');
      });
    });

    describe('Cache Management', () => {
      it('should cache responses', async () => {
        // Test cache directly
        const cache = (client as any).cache;
        const testData = { test: 'data' };

        // Should not have data initially
        expect(cache.get('test-key')).toBeNull();

        // Set data in cache
        cache.set('test-key', testData);

        // Should retrieve data from cache
        expect(cache.get('test-key')).toEqual(testData);
      });

      it('should clear cache', () => {
        client.clearCache();
        // Cache should be empty after clear
        expect((client as any).cache.cache.size).toBe(0);
      });
    });

    describe('Rate Limiting', () => {
      it('should track rate limit information', () => {
        const info = client.getRateLimitInfo();
        expect(info).toHaveProperty('remaining');
        expect(info).toHaveProperty('reset');
        expect(info.reset).toBeInstanceOf(Date);
      });

      it('should handle rate limit exceeded', async () => {
        // Set rate limit to 0
        (client as any).rateLimitRemaining = 0;
        (client as any).rateLimitReset = Date.now() + 60000; // 1 minute in future

        await expect((client as any).makeRequest('test-url')).rejects.toThrow(/rate limit exceeded/i);
      });
    });

    describe('Circuit Breaker', () => {
      it('should reset circuit breaker', () => {
        client.resetCircuitBreaker();
        // Circuit breaker should be in closed state
        expect((client as any).circuitBreaker.state).toBe('closed');
      });

      it('should open circuit after threshold failures', async () => {
        const breaker = (client as any).circuitBreaker;
        const mockFn = jest.fn(() => Promise.reject(new Error('API Error')));

        // Simulate failures
        for (let i = 0; i < 5; i++) {
          try {
            await breaker.execute(mockFn);
          } catch {
            // Expected to fail
          }
        }

        // Circuit should be open
        expect(breaker.state).toBe('open');

        // Next call should fail immediately
        await expect(breaker.execute(mockFn)).rejects.toThrow(/circuit breaker is open/i);
      });
    });

    describe('Component Methods', () => {
      // These tests would require mocking HTTP requests or using actual API
      // For unit tests, we'll test the method signatures and error handling

      it('should handle component not found', async () => {
        // Mock getRawContent to throw error
        const spy = jest.spyOn(client, 'getRawContent');
        spy.mockRejectedValue(new Error('File not found'));

        await expect(client.fetchComponent('non-existent', 'hanzo')).rejects.toThrow(/not found/i);
        spy.mockRestore();
      });

      it('should construct correct component paths', async () => {
        const spy = jest.spyOn(client, 'getRawContent');
        spy.mockResolvedValue('component content');

        await client.fetchComponent('button', 'react');

        expect(spy).toHaveBeenCalledWith(
          'shadcn-ui',
          'ui',
          'apps/v4/registry/new-york-v4/ui/button.tsx',
          'main'
        );

        spy.mockRestore();
      });

      it('should handle components with index files', async () => {
        const spy = jest.spyOn(client, 'getRawContent');
        spy.mockRejectedValueOnce(new Error('Not found'))
           .mockResolvedValueOnce('index content');

        const result = await client.fetchComponent('dialog', 'hanzo');

        expect(result).toBe('index content');
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenNthCalledWith(2,
          'hanzoai',
          'ui',
          'packages/ui/src/components/dialog/index.tsx',
          'main'
        );

        spy.mockRestore();
      });
    });
  });

  describe('MCP Tools', () => {
    describe('fetchComponentTool', () => {
      it('should have correct schema', () => {
        expect(fetchComponentTool.name).toBe('ui_fetch_component');
        expect(fetchComponentTool.inputSchema.properties).toHaveProperty('name');
        expect(fetchComponentTool.inputSchema.properties).toHaveProperty('framework');
        expect(fetchComponentTool.inputSchema.required).toContain('name');
      });

      it('should handle errors gracefully', async () => {
        const spy = jest.spyOn(githubClient, 'fetchComponent');
        spy.mockRejectedValue(new Error('Test error'));

        const result = await fetchComponentTool.handler({ name: 'button' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Error fetching component');

        spy.mockRestore();
      });

      it('should use default framework', async () => {
        const spy = jest.spyOn(githubClient, 'fetchComponent');
        spy.mockResolvedValue('component code');

        await fetchComponentTool.handler({ name: 'button' });

        expect(spy).toHaveBeenCalledWith('button', 'hanzo');

        spy.mockRestore();
      });
    });

    describe('listComponentsTool', () => {
      it('should have correct schema', () => {
        expect(listComponentsTool.name).toBe('ui_list_github_components');
        expect(listComponentsTool.inputSchema.properties).toHaveProperty('framework');
      });

      it('should format component list correctly', async () => {
        const spy = jest.spyOn(githubClient, 'listComponents');
        spy.mockResolvedValue(['button', 'card', 'dialog']);

        const result = await listComponentsTool.handler({ framework: 'react' });

        expect(result.content[0].text).toContain('Available components in react:');
        expect(result.content[0].text).toContain('button');
        expect(result.content[0].text).toContain('card');
        expect(result.content[0].text).toContain('dialog');

        spy.mockRestore();
      });
    });
  });

  describe('Integration Scenarios', () => {
    it('should support multiple framework component fetching', async () => {
      const frameworks = ['hanzo', 'react', 'svelte', 'vue', 'react-native'] as const;
      const spy = jest.spyOn(githubClient, 'fetchComponent');
      spy.mockResolvedValue('component content');

      for (const framework of frameworks) {
        await githubClient.fetchComponent('button', framework);
        expect(spy).toHaveBeenCalledWith('button', framework);
      }

      spy.mockRestore();
    });

    it('should handle authentication token from environment', () => {
      // Save original env
      const originalToken = process.env.GITHUB_TOKEN;

      // Set test token
      process.env.GITHUB_TOKEN = 'test-token-123';

      // Create new client
      const testClient = new GitHubAPIClient();
      expect((testClient as any).token).toBe('test-token-123');

      // Restore original env
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    });

    it('should fallback to GITHUB_PERSONAL_ACCESS_TOKEN', () => {
      // Save original env
      const originalToken = process.env.GITHUB_TOKEN;
      const originalPAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

      // Clear GITHUB_TOKEN and set PAT
      delete process.env.GITHUB_TOKEN;
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'pat-token-456';

      // Create new client
      const testClient = new GitHubAPIClient();
      expect((testClient as any).token).toBe('pat-token-456');

      // Restore original env
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      }
      if (originalPAT) {
        process.env.GITHUB_PERSONAL_ACCESS_TOKEN = originalPAT;
      } else {
        delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      }
    });
  });
});