/**
 * Unified Hanzo Cloud credential & endpoint resolution for @hanzo/mcp.
 *
 * Mirrors `rust/src/hanzo_api.rs` 1-to-1:
 *   1. Explicit env keys: HANZO_API_KEY, HANZO_USER_KEY, API_KEY, API_TOKEN, HANZO_TOKEN
 *   2. Active CLI login (`~/.local/bin/hanzo auth token`, cached in memory; never `/usr/bin/hanzo`)
 *      Skipped under Jest (`JEST_WORKER_ID`) unless `HANZO_AUTH_CLI=1` so unit tests that
 *      assert missing-key error handling remain deterministic.
 *   3. Base URL: HANZO_API_BASE, HANZO_API_URL, HANZO_CLOUD_API, API_URL -> https://api.hanzo.ai
 *   4. Org header: HANZO_ORG -> X-Org-Id
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let cachedCliToken: string | null = null;

function resolveCliBinary(): string | null {
  const envBin = process.env.HANZO_BIN?.trim();
  if (envBin && path.resolve(envBin) !== '/usr/bin/hanzo' && path.resolve(envBin) !== '/bin/hanzo') {
    if (fs.existsSync(envBin)) return envBin;
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', 'hanzo');
  if (fs.existsSync(localBin)) return localBin;

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'hanzo');
    const resolved = path.resolve(candidate);
    if (resolved === '/usr/bin/hanzo' || resolved === '/bin/hanzo') continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveHanzoToken(): string {
  const fromEnv = (
    process.env.HANZO_API_KEY ||
    process.env.HANZO_USER_KEY ||
    process.env.API_KEY ||
    process.env.API_TOKEN ||
    process.env.HANZO_TOKEN ||
    ''
  ).trim();
  if (fromEnv) return fromEnv;

  if (process.env.HANZO_AUTH_CLI === '0') return '';
  if (process.env.JEST_WORKER_ID && process.env.HANZO_AUTH_CLI !== '1') return '';

  if (cachedCliToken !== null) return cachedCliToken;
  const bin = resolveCliBinary();
  if (!bin) {
    cachedCliToken = '';
    return '';
  }
  try {
    const out = execFileSync(bin, ['auth', 'token'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    cachedCliToken = out.toString('utf8').trim();
  } catch {
    cachedCliToken = '';
  }
  return cachedCliToken;
}

export function resolveHanzoApiBase(defaultBase = 'https://api.hanzo.ai'): string {
  const raw =
    process.env.HANZO_API_BASE ||
    process.env.HANZO_API_URL ||
    process.env.HANZO_CLOUD_API ||
    process.env.API_URL ||
    defaultBase;
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function applyHanzoOrgHeader(headers: Record<string, string>): Record<string, string> {
  const org = process.env.HANZO_ORG?.trim();
  if (org) headers['X-Org-Id'] = org;
  return headers;
}
