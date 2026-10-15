/**
 * Shared helper utilities for Hanzo Kai MCP Cookbook recipes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMCPServer } from "../dist/index.js";

export interface RecipeResult {
  recipe: string;
  tool: string;
  success: boolean;
  latency_ms?: number;
  output: any;
  explanation: string;
}

/**
 * Creates an in-process MCP client connected directly to the Hanzo MCP server.
 * Enables zero-overhead execution for recipes and automated test suites.
 */
export async function createRecipeClient() {
  // Kai is reached as every client reaches it: api.hanzo.ai with HANZO_API_KEY, or LOCAL_KAI_URL for a local `kai serve`.
  const server = await createMCPServer({ name: "kai-cookbook-server", version: "2.4.19" });
  // Call tools directly via server handlers or in-memory transport
  return {
    server,
    async callTool(name: string, args: Record<string, any>) {
      const tool = server.tools.find((t: any) => t.name === name);
      if (!tool) throw new Error(`Tool '${name}' not found on server`);
      const start = performance.now();
      const res = await tool.handler(args);
      const elapsed = performance.now() - start;
      if (res.isError) {
        return {
          isError: true,
          error: res.content?.[0]?.text || "Unknown error",
          latency_ms: elapsed
        };
      }
      let parsed = {};
      try {
        parsed = JSON.parse(res.content?.[0]?.text || "{}");
      } catch {
        parsed = { raw: res.content?.[0]?.text };
      }
      return {
        isError: false,
        data: parsed,
        latency_ms: elapsed
      };
    }
  };
}

export function logRecipe(result: RecipeResult) {
  console.log(`\n======================================================`);
  console.log(`📖 Recipe: ${result.recipe}`);
  console.log(`🛠️  Tool:   ${result.tool}`);
  console.log(`⚡ Latency: ${result.latency_ms?.toFixed(2)} ms`);
  console.log(`📝 Output:\n${JSON.stringify(result.output, null, 2)}`);
  console.log(`💡 ${result.explanation}`);
  console.log(`======================================================\n`);
}
