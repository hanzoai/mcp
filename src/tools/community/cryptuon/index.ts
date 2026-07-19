/**
 * Cryptuon community tools — wraps upstream cryptuon scripts/crates as MCP
 * tools. Pure descriptors + subprocess shell-outs; no upstream code is
 * vendored here. Disabled by default; enable via `--enable-community-cryptuon`
 * (CLI) or `enableCommunityCryptuon: true` (ToolConfig).
 *
 * Upstream:
 *   - github.com/kcolbchain/tesseract            (deploy / health / monitor)
 *   - github.com/kcolbchain/blockchain-compression (Solana compressor)
 *
 * Each tool resolves its binary via an env var override (see per-tool docs)
 * with a PATH fallback. If the upstream binary is not installed, the tool
 * surfaces a structured error envelope on first call — registration itself
 * has no runtime side effects.
 */

import { Tool } from '../../../types/index.js';
import { tesseractDeployTool } from './tesseract-deploy.js';
import { tesseractHealthCheckTool } from './tesseract-health-check.js';
import { tesseractMonitorTool } from './tesseract-monitor.js';
import { compressSolanaTool } from './compress-solana.js';

export const cryptuonCommunityTools: Tool[] = [
  tesseractDeployTool,
  tesseractHealthCheckTool,
  tesseractMonitorTool,
  compressSolanaTool,
];

export {
  tesseractDeployTool,
  tesseractHealthCheckTool,
  tesseractMonitorTool,
  compressSolanaTool,
};
