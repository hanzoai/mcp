/**
 * Automated test suite for all 15 Hanzo Kai MCP Cookbook Recipes.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { recipes } from '../cookbook/index.js';

describe('15 Hanzo Kai Native MCP Cookbook Recipes', () => {
  for (const r of recipes) {
    test(`Recipe ${r.id}: ${r.name}`, async () => {
      const res = await r.runner();
      expect(res.success).toBe(true);
      expect(res.tool).toBeDefined();
      expect(res.output).toBeDefined();
    });
  }
});
