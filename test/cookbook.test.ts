/**
 * Automated test suite for all 15 Hanzo Kai MCP Cookbook Recipes.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { recipes } from '../cookbook/index.js';
import { resolveHanzoToken } from '../src/tools/hanzo-auth.js';

const LIVE_DECISION_RECIPES = new Set(['07', '09', '14', '15']);

describe('15 Hanzo Kai Native MCP Cookbook Recipes', () => {
  const prevAuthCli = process.env.HANZO_AUTH_CLI;

  beforeAll(() => {
    process.env.HANZO_AUTH_CLI = '1';
  });

  afterAll(() => {
    if (prevAuthCli === undefined) delete process.env.HANZO_AUTH_CLI;
    else process.env.HANZO_AUTH_CLI = prevAuthCli;
  });

  for (const r of recipes) {
    test(`Recipe ${r.id}: ${r.name}`, async () => {
      if (LIVE_DECISION_RECIPES.has(r.id) && !process.env.LOCAL_KAI_URL && !resolveHanzoToken()) {
        return;
      }
      const res = await r.runner();
      expect(res.success).toBe(true);
      expect(res.tool).toBeDefined();
      expect(res.output).toBeDefined();
    });
  }
});
