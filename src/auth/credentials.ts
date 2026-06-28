/**
 * Secure credential storage for hanzo-mcp cloud auth.
 *
 * Tokens are secrets — never plaintext-in-repo, never an env-baked literal.
 * Default store: ~/.hanzo/credentials.json with 0600 perms (owner-only),
 * which is where a headless MCP server can reliably read them. On macOS the
 * store can be backed by the login keychain instead (HANZO_MCP_KEYCHAIN=1).
 *
 * One credential per (issuer, clientId).
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const pexec = promisify(execFile);

export interface Credential {
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** epoch millis when the access token expires */
  expiresAt: number;
  scope?: string;
  /** subject / user id from the token (per-user memory scoping) */
  sub?: string;
  email?: string;
  obtainedAt: number;
}

const KEYCHAIN_SERVICE = 'hanzo-mcp';

function credKey(issuer: string, clientId: string): string {
  return `${issuer}|${clientId}`;
}

function credFile(): string {
  return process.env.HANZO_CREDENTIALS_FILE || path.join(os.homedir(), '.hanzo', 'credentials.json');
}

function keychainEnabled(): boolean {
  return process.platform === 'darwin' && process.env.HANZO_MCP_KEYCHAIN === '1';
}

// --- macOS keychain (opt-in) ---------------------------------------------

async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainSet(account: string, secret: string): Promise<void> {
  // -U updates if present; no interactive prompt for same-app add/update.
  await pexec('security', [
    'add-generic-password',
    '-U',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    account,
    '-w',
    secret,
  ]);
}

async function keychainDelete(account: string): Promise<void> {
  try {
    await pexec('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
  } catch {
    /* absent is fine */
  }
}

// --- 0600 file store (default) -------------------------------------------

async function fileReadAll(): Promise<Record<string, Credential>> {
  try {
    return JSON.parse(await fs.readFile(credFile(), 'utf-8'));
  } catch {
    return {};
  }
}

async function fileWriteAll(all: Record<string, Credential>): Promise<void> {
  const f = credFile();
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(all, null, 2), { mode: 0o600 });
  // Enforce perms even if the file pre-existed with a looser mode.
  await fs.chmod(f, 0o600).catch(() => {});
}

// --- public API -----------------------------------------------------------

export async function getCredential(issuer: string, clientId: string): Promise<Credential | null> {
  const key = credKey(issuer, clientId);
  if (keychainEnabled()) {
    const raw = await keychainGet(key);
    if (raw) {
      try {
        return JSON.parse(raw) as Credential;
      } catch {
        return null;
      }
    }
    return null;
  }
  const all = await fileReadAll();
  return all[key] || null;
}

export async function setCredential(cred: Credential): Promise<void> {
  const key = credKey(cred.issuer, cred.clientId);
  if (keychainEnabled()) {
    await keychainSet(key, JSON.stringify(cred));
    return;
  }
  const all = await fileReadAll();
  all[key] = cred;
  await fileWriteAll(all);
}

export async function clearCredential(issuer: string, clientId: string): Promise<boolean> {
  const key = credKey(issuer, clientId);
  if (keychainEnabled()) {
    await keychainDelete(key);
    return true;
  }
  const all = await fileReadAll();
  if (!(key in all)) return false;
  delete all[key];
  await fileWriteAll(all);
  return true;
}

/** Where credentials are stored (for `auth status` reporting). */
export function credentialLocation(): string {
  return keychainEnabled() ? `macOS keychain (service=${KEYCHAIN_SERVICE})` : credFile();
}
