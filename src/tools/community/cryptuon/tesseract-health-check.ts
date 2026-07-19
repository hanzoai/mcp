/**
 * tesseract.health_check — community tool (cryptuon)
 *
 * Probes a set of deployed tesseract addresses on a given chain and returns
 * a per-address health record (live, latency_ms, last_block).
 *
 * Wraps `scripts/health_check.py` from github.com/kcolbchain/tesseract.
 * Binary resolved via $CRYPTUON_TESSERACT_HEALTH or PATH lookup of
 * `tesseract-health-check`.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'tesseract.health_check' } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'tesseract.health_check' } }, null, 2) }], isError: true };
}

export const tesseractHealthCheckTool: Tool = {
  name: 'tesseract.health_check',
  description: 'Probe deployed tesseract addresses on a target chain. Returns per-address health: { live, latency_ms, last_block }. Wraps cryptuon/tesseract scripts/health_check.py.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'Target chain id' },
      addresses: { type: 'array', items: { type: 'string' }, description: 'Contract addresses to probe' },
    },
    required: ['chain', 'addresses']
  },
  handler: async (args) => {
    if (!args.chain) return fail('INVALID_PARAMS', 'chain required');
    if (!Array.isArray(args.addresses) || args.addresses.length === 0) return fail('INVALID_PARAMS', 'addresses must be a non-empty string[]');

    const bin = process.env.CRYPTUON_TESSERACT_HEALTH || 'tesseract-health-check';
    const addrArgs = args.addresses.map((a: string) => `--address ${JSON.stringify(a)}`).join(' ');
    const cmd = `${JSON.stringify(bin)} --chain ${JSON.stringify(args.chain)} ${addrArgs} --json`;

    try {
      const { stdout } = await execAsync(cmd, {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env },
      });
      let report: any = stdout.trim();
      try { report = JSON.parse(stdout); } catch { /* keep as string */ }
      return envelope({ chain: args.chain, addresses: args.addresses, report });
    } catch (err: any) {
      return fail('HEALTH_CHECK_FAILED', err?.stderr?.toString?.() || err?.message || String(err));
    }
  }
};
