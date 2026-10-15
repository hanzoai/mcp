import { describe, expect, it } from '@jest/globals';
import { READ_ONLY, listed } from '../src/types/index.js';
import { kaiTools, kaiAgentTools, kaiPurposeBuiltTools } from '../src/tools/kai.js';

// A client that asks before any tool that may write (Codex, by default) refuses every unannotated
// call in a run that never asks, so a tool that only reads or decides must say so.
describe('tool annotations', () => {
  it('lists every Kai decision tool as read-only', () => {
    for (const tool of [...kaiTools, ...kaiAgentTools, ...kaiPurposeBuiltTools]) {
      expect(READ_ONLY.has(tool.name)).toBe(true);
      expect(listed(tool).annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it('claims nothing for a tool that may write', () => {
    const exec = { name: 'exec', description: 'run', inputSchema: { type: 'object' as const, properties: {} }, handler: async () => ({ content: [] }) };
    expect(listed(exec)).not.toHaveProperty('annotations');
  });
});
