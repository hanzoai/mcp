/**
 * Unit tests for kai_compact tool (typed context compaction).
 */

import { describe, test, expect } from '@jest/globals';
import { kaiCompactTool } from '../../src/tools/compact.js';

const body = (r: any) => JSON.parse(r.content[0].text);

describe('kai_compact', () => {
  test('preserves error diagnostics while compacting long outputs', async () => {
    const messages = [
      { role: 'user', content: 'Fix the failing test in tests/agent.rs' },
      { 
        role: 'assistant', 
        content: 'Running cargo test...', 
        tool_calls: [{ id: 'tc_1', function: { name: 'exec', arguments: { command: 'cargo test' } } }] 
      },
      { 
        role: 'tool', 
        tool_call_id: 'tc_1', 
        content: '   Compiling dev v0.1.0\nerror: aborting due to 1 previous error\nerror[E0425]: cannot find value `foo` in this scope\n' + 'x'.repeat(4000) 
      },
      { role: 'assistant', content: 'I see the error, fixing it now.' },
      { role: 'user', content: 'Did it work?' },
    ];

    const res = await kaiCompactTool.handler({
      messages,
      preserve_recent: 2,
    });

    const parsed = body(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.metrics.initial_messages).toBe(5);
    expect(parsed.metrics.tokens_saved).toBeGreaterThan(0);

    // Verify error signature retained
    const toolResult = parsed.compacted_messages[2];
    expect(toolResult.content).toContain('cannot find value `foo`');
    expect(toolResult.content).toContain('[Diagnostics retained verbatim]');
  });

  test('handles empty message array gracefully', async () => {
    const res = await kaiCompactTool.handler({ messages: [] });
    const parsed = body(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.compacted_messages).toEqual([]);
  });
});
