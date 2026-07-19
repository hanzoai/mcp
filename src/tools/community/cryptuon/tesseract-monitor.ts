/**
 * tesseract.monitor — community tool (cryptuon)
 *
 * Streams matching contract events for a given address + topic on a chain.
 * Returns the matched events array (one-shot poll; not a long-lived stream).
 *
 * Wraps `scripts/monitor_events.py` from github.com/kcolbchain/tesseract.
 * Binary resolved via $CRYPTUON_TESSERACT_MONITOR or PATH lookup of
 * `tesseract-monitor`.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'tesseract.monitor' } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'tesseract.monitor' } }, null, 2) }], isError: true };
}

export const tesseractMonitorTool: Tool = {
  name: 'tesseract.monitor',
  description: 'Poll matching contract events for an address + topic on a target chain. Wraps cryptuon/tesseract scripts/monitor_events.py. Returns matched events array.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'Target chain id' },
      address: { type: 'string', description: 'Contract address to monitor' },
      event_topic: { type: 'string', description: 'Event topic hash (keccak256 of event signature) or canonical event signature' },
      from_block: { type: 'string', description: 'Starting block (number or "latest"); optional, defaults to latest-1000' },
    },
    required: ['chain', 'address', 'event_topic']
  },
  handler: async (args) => {
    if (!args.chain || !args.address || !args.event_topic) {
      return fail('INVALID_PARAMS', 'chain, address, event_topic required');
    }

    const bin = process.env.CRYPTUON_TESSERACT_MONITOR || 'tesseract-monitor';
    const parts = [
      JSON.stringify(bin),
      '--chain', JSON.stringify(args.chain),
      '--address', JSON.stringify(args.address),
      '--topic', JSON.stringify(args.event_topic),
      ...(args.from_block ? ['--from-block', JSON.stringify(args.from_block)] : []),
      '--json',
    ];

    try {
      const { stdout } = await execAsync(parts.join(' '), {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      });
      let events: any = stdout.trim();
      try { events = JSON.parse(stdout); } catch { /* keep as string */ }
      return envelope({ chain: args.chain, address: args.address, event_topic: args.event_topic, events });
    } catch (err: any) {
      return fail('MONITOR_FAILED', err?.stderr?.toString?.() || err?.message || String(err));
    }
  }
};
