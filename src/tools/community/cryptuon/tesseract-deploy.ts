/**
 * tesseract.deploy — community tool (cryptuon)
 *
 * Deploys the tesseract zk-OCR relayer to a target chain.
 *
 * Wraps `scripts/deploy_multichain.py` from upstream
 * github.com/kcolbchain/tesseract. The script must be installed on PATH
 * (or its path overridden via $CRYPTUON_TESSERACT_DEPLOY).
 *
 * Returns the deployment manifest emitted by the script on stdout
 * (addresses, tx hashes, block numbers per chain).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Tool } from '../../../types/index.js';

const execAsync = promisify(exec);

function envelope(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'tesseract.deploy' } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'tesseract.deploy' } }, null, 2) }], isError: true };
}

const ALLOWED_ENVS = ['dev', 'staging', 'mainnet'] as const;

export const tesseractDeployTool: Tool = {
  name: 'tesseract.deploy',
  description: 'Deploy tesseract zk-OCR relayer to a target chain. Wraps cryptuon/tesseract scripts/deploy_multichain.py. Returns deployment manifest JSON with per-chain addresses + tx hashes.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'Target chain id (e.g. "ethereum", "base", "arbitrum", "lux-mainnet")' },
      env: { type: 'string', enum: [...ALLOWED_ENVS], description: 'Deployment environment' },
      config_path: { type: 'string', description: 'Path to deployment config TOML (optional; defaults to ./deploy.toml)' },
    },
    required: ['chain', 'env']
  },
  handler: async (args) => {
    if (!args.chain) return fail('INVALID_PARAMS', 'chain required');
    if (!ALLOWED_ENVS.includes(args.env)) return fail('INVALID_PARAMS', `env must be one of ${ALLOWED_ENVS.join('|')}`);

    const bin = process.env.CRYPTUON_TESSERACT_DEPLOY || 'tesseract-deploy';
    const cmd = [
      JSON.stringify(bin),
      '--chain', JSON.stringify(args.chain),
      '--env', JSON.stringify(args.env),
      ...(args.config_path ? ['--config', JSON.stringify(args.config_path)] : []),
      '--json',
    ].join(' ');

    try {
      const { stdout } = await execAsync(cmd, {
        timeout: 5 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      });
      let manifest: any = stdout.trim();
      try { manifest = JSON.parse(stdout); } catch { /* keep as string */ }
      return envelope({ chain: args.chain, env: args.env, manifest });
    } catch (err: any) {
      return fail('DEPLOY_FAILED', err?.stderr?.toString?.() || err?.message || String(err));
    }
  }
};
