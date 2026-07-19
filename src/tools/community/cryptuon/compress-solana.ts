/**
 * compress.solana — community tool (cryptuon)
 *
 * Compresses a binary blob using the Solana-tuned compressor from the
 * blockchain-compression Rust crate (github.com/kcolbchain/blockchain-compression).
 *
 * Shells out to the crate's `solana-compress` CLI (cargo install
 * blockchain-compression-cli, or built locally). Binary resolved via
 * $CRYPTUON_SOLANA_COMPRESS or PATH lookup of `solana-compress`.
 *
 * Input blob is passed via stdin as base64. Output includes compressed
 * bytes (base64) and the ratio (compressed / original).
 */

import { spawn } from 'child_process';
import { Tool } from '../../../types/index.js';

function envelope(data: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'compress.solana' } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'compress.solana' } }, null, 2) }], isError: true };
}

const ALLOWED_STRATEGIES = ['default', 'merkle', 'hybrid'] as const;

function runCompress(blobBase64: string, strategy: string, bin: string): Promise<{ compressedBase64: string; ratio: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['--strategy', strategy, '--in', '-', '--out', '-', '--json-meta'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`solana-compress exit ${code}: ${Buffer.concat(err).toString()}`));
      const stdoutStr = Buffer.concat(out).toString();
      // Expect last line to be JSON meta { compressed_base64, ratio }
      const lastNewline = stdoutStr.lastIndexOf('\n', stdoutStr.length - 2);
      const metaLine = stdoutStr.slice(lastNewline + 1).trim();
      try {
        const meta = JSON.parse(metaLine);
        if (typeof meta.compressed_base64 !== 'string' || typeof meta.ratio !== 'number') {
          throw new Error('meta missing fields');
        }
        resolve({ compressedBase64: meta.compressed_base64, ratio: meta.ratio });
      } catch (e: any) {
        reject(new Error(`could not parse compressor meta JSON: ${e?.message || e}`));
      }
    });
    proc.stdin.write(blobBase64);
    proc.stdin.end();
  });
}

export const compressSolanaTool: Tool = {
  name: 'compress.solana',
  description: 'Compress a binary blob with the Solana-tuned compressor from cryptuon/blockchain-compression (SolanaCompressor::compress). Input blob as base64; returns compressed_base64 + ratio.',
  inputSchema: {
    type: 'object',
    properties: {
      blob: { type: 'string', description: 'Input bytes encoded as base64' },
      strategy: { type: 'string', enum: [...ALLOWED_STRATEGIES], default: 'default', description: 'Compression strategy' },
    },
    required: ['blob']
  },
  handler: async (args) => {
    if (typeof args.blob !== 'string' || args.blob.length === 0) {
      return fail('INVALID_PARAMS', 'blob (base64 string) required');
    }
    const strategy = args.strategy || 'default';
    if (!ALLOWED_STRATEGIES.includes(strategy)) {
      return fail('INVALID_PARAMS', `strategy must be one of ${ALLOWED_STRATEGIES.join('|')}`);
    }

    const bin = process.env.CRYPTUON_SOLANA_COMPRESS || 'solana-compress';
    try {
      const { compressedBase64, ratio } = await runCompress(args.blob, strategy, bin);
      return envelope({ strategy, compressed_base64: compressedBase64, ratio });
    } catch (err: any) {
      return fail('COMPRESS_FAILED', err?.message || String(err));
    }
  }
};
