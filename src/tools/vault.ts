/**
 * vault — Sovereign credential custody & agentic browser auto-login.
 *
 * Unifies:
 *   1. Hanzo KMS (`~/.local/bin/hanzo kms`) — the sole persistence layer for secrets
 *   2. LastPass CLI (`lpass`) & LastPass Enterprise API (`enterpriseapi.php`) — zero-disk import & metadata listing
 *   3. ZAP Agentic Browser Auto-Login — fills username, multi-step password, and RFC 6238 TOTP
 *      directly over ZAP (`hanzo.snapshot` / `hanzo.act` / `hanzo.fill` / `hanzo.press`) without
 *      ever exposing plaintext secrets, tokens, TOTP codes, or cookies in tool output or on disk.
 */

import { execFile as nodeExecFile } from 'child_process';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, ToolResult } from '../types/index.js';
import * as zap from '../zap.js';

export type ExecFileFn = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

let execOverride: ExecFileFn | null = null;

/** Inject a custom execFile implementation for unit tests; pass null to restore default. */
export function setVaultExecOverride(fn: ExecFileFn | null): void {
  execOverride = fn;
}

function defaultExecFile(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      bin,
      args,
      {
        timeout: opts?.timeoutMs ?? 20_000,
        maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e: any = new Error(stderr?.toString().trim() || err.message);
          e.code = (err as any).code;
          e.stderr = stderr?.toString() ?? '';
          reject(e);
          return;
        }
        resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      },
    );
  });
}

async function runExec(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
  redactValues: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  const fn = execOverride ?? defaultExecFile;
  try {
    return await fn(bin, args, opts);
  } catch (err: any) {
    let msg = String(err?.message || err);
    for (const secret of redactValues) {
      if (secret && secret.length >= 3) {
        msg = msg.split(secret).join('[REDACTED]');
      }
    }
    const clean = new Error(msg);
    (clean as any).code = err?.code;
    throw clean;
  }
}

/**
 * Resolve the sovereign `hanzo` CLI binary.
 * NEVER uses `/usr/bin/hanzo` (per Hanzo workspace rules).
 */
export function resolveHanzoBin(): string {
  const envBin = process.env.HANZO_BIN?.trim();
  if (envBin && path.resolve(envBin) !== '/usr/bin/hanzo') {
    return envBin;
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', 'hanzo');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'hanzo');
    if (path.resolve(candidate) === '/usr/bin/hanzo' || path.resolve(candidate) === '/bin/hanzo') {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return localBin;
}

/** Normalize an app or connector identifier into a safe KMS path slug. */
export function slugifyApp(input: string): string {
  const clean = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || 'default';
}

function hostnameSlug(urlStr: string): string {
  try {
    const u = new URL(urlStr.includes('://') ? urlStr : `https://${urlStr}`);
    const parts = u.hostname.replace(/^www\./, '').split('.');
    return slugifyApp(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
  } catch {
    return 'unknown';
  }
}

/** Strip `/orgs/<org>/` prefixes returned by KMS list responses into canonical relative paths. */
export function normalizeKmsPath(rawPath: string): string {
  let p = String(rawPath || '').trim().replace(/^\/+|\/+$/g, '');
  while (/^orgs\/[^/]+\//.test(p)) {
    p = p.replace(/^orgs\/[^/]+\//, '');
  }
  return p || 'root';
}

export interface VaultCredentialGroup {
  app: string;
  path: string;
  keys: string[];
  source: 'kms' | 'lastpass';
  env?: string;
}

/** List KMS secret metadata (keys & paths ONLY — never values). */
export async function kmsListSecrets(env = 'prod'): Promise<VaultCredentialGroup[]> {
  const bin = resolveHanzoBin();
  const seen = new Map<string, Set<string>>();

  const collect = (rawStdout: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(rawStdout);
    } catch {
      return;
    }
    const items: any[] = Array.isArray(parsed)
      ? parsed
      : parsed?.secrets || parsed?.items || parsed?.data || [];
    for (const item of items) {
      const name = String(item?.name ?? item?.key ?? item?.secretKey ?? '').trim();
      if (!name) continue;
      const normPath = normalizeKmsPath(item?.path ?? item?.secretPath ?? '');
      if (!seen.has(normPath)) seen.set(normPath, new Set());
      seen.get(normPath)!.add(name);
    }
  };

  const baseRes = await runExec(bin, ['kms', 'secrets', 'list', '--env', env], { timeoutMs: 12_000 });
  collect(baseRes.stdout);

  try {
    const credRes = await runExec(
      bin,
      ['kms', 'secrets', 'list', '--env', env, '--path', '/credentials'],
      { timeoutMs: 12_000 },
    );
    collect(credRes.stdout);
  } catch {
    // `/credentials` path may not exist yet; base list already succeeded.
  }

  const groups: VaultCredentialGroup[] = [];
  for (const [normPath, keySet] of seen.entries()) {
    const segments = normPath.split('/').filter(Boolean);
    const app = segments.length >= 2 && (segments[0] === 'credentials' || segments[0] === 'channels')
      ? segments[1]
      : segments[segments.length - 1] || normPath;
    groups.push({
      app,
      path: normPath,
      keys: [...keySet].sort(),
      source: 'kms',
      env,
    });
  }
  return groups.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read a single secret value in-memory from Hanzo KMS. Returns null if missing. */
export async function kmsGetSecret(secretRef: string, env = 'prod'): Promise<string | null> {
  const bin = resolveHanzoBin();
  const cleanRef = secretRef.replace(/^\/+/, '');
  try {
    const { stdout } = await runExec(bin, ['kms', 'secrets', 'get', cleanRef, '--env', env], { timeoutMs: 10_000 });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const val = obj?.value ?? obj?.secret?.value ?? obj?.secretValue;
        return typeof val === 'string' && val.length > 0 ? val : null;
      } catch {
        return null;
      }
    }
    return trimmed;
  } catch {
    return null;
  }
}

/** Seal a single secret value into Hanzo KMS using `execFile` (zero shell interpolation, zero disk files). */
export async function kmsSetSecret(
  secretPath: string,
  keyName: string,
  secretValue: string,
  env = 'prod',
): Promise<void> {
  const bin = resolveHanzoBin();
  const cleanPath = secretPath.replace(/^\/+|\/+$/g, '');
  const createArgs = [
    'kms',
    'secrets',
    'create',
    '--env',
    env,
    '--path',
    cleanPath,
    '--name',
    keyName,
    '--value',
    secretValue,
  ];
  try {
    await runExec(bin, createArgs, { timeoutMs: 15_000 }, [secretValue]);
  } catch (err: any) {
    if (/unrecognized subcommand ['"]?create['"]?/i.test(String(err?.message || ''))) {
      const setArgs = [
        'kms',
        'secrets',
        'set',
        '--env',
        env,
        '--path',
        cleanPath,
        '--name',
        keyName,
        '--value',
        secretValue,
      ];
      await runExec(bin, setArgs, { timeoutMs: 15_000 }, [secretValue]);
      return;
    }
    throw err;
  }
}

export interface SealInput {
  app: string;
  path?: string;
  env?: string;
  username?: string;
  password?: string;
  api_key?: string;
  oauth_token?: string;
  totp_secret?: string;
  url?: string;
  notes?: string;
  custom?: Record<string, string>;
}

/** Seal structured credentials for an app into KMS under `credentials/<app>/<KEY>`. */
export async function sealAppCredentials(input: SealInput): Promise<{
  app: string;
  path: string;
  env: string;
  keysSealed: string[];
}> {
  const app = slugifyApp(input.app);
  const env = input.env || 'prod';
  const targetPath = (input.path || `credentials/${app}`).replace(/^\/+|\/+$/g, '');

  const entries: Array<[string, string | undefined]> = [
    ['USERNAME', input.username],
    ['PASSWORD', input.password],
    ['API_KEY', input.api_key],
    ['OAUTH_TOKEN', input.oauth_token],
    ['TOTP_SECRET', input.totp_secret],
    ['URL', input.url],
    ['NOTES', input.notes],
  ];
  if (input.custom && typeof input.custom === 'object') {
    for (const [k, v] of Object.entries(input.custom)) {
      const safeKey = k.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (safeKey && typeof v === 'string' && v.length > 0) {
        entries.push([safeKey, v]);
      }
    }
  }

  const keysSealed: string[] = [];
  for (const [key, val] of entries) {
    if (typeof val === 'string' && val.length > 0) {
      await kmsSetSecret(targetPath, key, val, env);
      keysSealed.push(key);
    }
  }

  return { app, path: targetPath, env, keysSealed };
}

// ── RFC 6238 TOTP (Pure Node crypto, Base32 + otpauth:// support) ────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(raw: string): Buffer {
  const clean = raw.toUpperCase().replace(/[\s\-=]+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character in TOTP secret`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Compute live RFC 6238 TOTP code in-memory.
 * Supports raw Base32 secrets or `otpauth://totp/...` URIs.
 * Callers in MCP handlers MUST NOT return `code` in tool output!
 */
export function generateTotp(
  secretOrUri: string,
  nowMs: number = Date.now(),
): { code: string; expiresInSeconds: number; period: number; digits: number } {
  let base32 = secretOrUri.trim();
  let digits = 6;
  let period = 30;
  let algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1';

  if (base32.toLowerCase().startsWith('otpauth://')) {
    const u = new URL(base32);
    const s = u.searchParams.get('secret');
    if (!s) throw new Error('otpauth URI missing secret parameter');
    base32 = s;
    const d = Number(u.searchParams.get('digits'));
    if (d === 6 || d === 7 || d === 8) digits = d;
    const p = Number(u.searchParams.get('period'));
    if (Number.isFinite(p) && p > 0) period = p;
    const alg = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    if (alg === 'SHA256') algorithm = 'sha256';
    else if (alg === 'SHA512') algorithm = 'sha512';
  }

  const key = decodeBase32(base32);
  if (key.length === 0) throw new Error('Empty TOTP secret');

  const nowSec = Math.floor(nowMs / 1000);
  const counter = Math.floor(nowSec / period);
  const expiresInSeconds = period - (nowSec % period);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(algorithm, key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % 10 ** digits).padStart(digits, '0');

  return { code, expiresInSeconds, period, digits };
}

// ── RFC 4180 CSV parser for in-memory `lpass export` ─────────────────────────

export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (csvText[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  return rows;
}

// ── Canonical Login URLs for Multi-Step & Single-Step Apps ───────────────────

export const KNOWN_LOGIN_URLS: Record<string, string> = {
  lastpass: 'https://lastpass.com/?ac=1',
  gmail: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/',
  google: 'https://accounts.google.com/',
  google_calendar: 'https://accounts.google.com/ServiceLogin?service=cl&continue=https://calendar.google.com/',
  google_drive: 'https://accounts.google.com/ServiceLogin?service=wise&continue=https://drive.google.com/',
  google_forms: 'https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/forms/',
  google_ads: 'https://accounts.google.com/ServiceLogin?continue=https://ads.google.com/aw/overview',
  google_analytics: 'https://accounts.google.com/ServiceLogin?continue=https://analytics.google.com/analytics/web/',
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://studio.youtube.com/',
  salesforce: 'https://login.salesforce.com/',
  microsoft_teams: 'https://login.microsoftonline.com/',
  microsoft: 'https://login.microsoftonline.com/',
  github: 'https://github.com/login',
  intercom: 'https://app.intercom.com/admins/sign_in',
  facebook_lead_ads: 'https://www.facebook.com/login.php?next=https://business.facebook.com/latest/instant_forms',
  facebook: 'https://www.facebook.com/login',
  docusign: 'https://account.docusign.com/',
  klaviyo: 'https://www.klaviyo.com/login',
  linkedin: 'https://www.linkedin.com/login',
  quickbooks: 'https://accounts.intuit.com/app/sign-in?app_group=QBO',
  hanzo_post: 'https://post.hanzo.ai/auth/login',
  x: 'https://x.com/i/flow/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  threads: 'https://www.threads.com/login',
  tiktok: 'https://www.tiktok.com/login/phone-or-email/email',
  reddit: 'https://www.reddit.com/login/',
  bluesky: 'https://bsky.app/',
  mastodon: 'https://mastodon.social/auth/sign_in',
  discord: 'https://discord.com/login',
  slack: 'https://slack.com/signin',
  telegram: 'https://web.telegram.org/k/',
  devto: 'https://dev.to/enter',
  hashnode: 'https://hashnode.com/onboard',
  medium: 'https://medium.com/m/signin',
};

interface SnapshotNode {
  role: string;
  label: string;
  ref: string;
  raw: string;
}

function parseSnapshotTree(treeText: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  for (const line of String(treeText || '').split('\n')) {
    const refMatch = line.match(/\[ref=(e\d+)\]/);
    if (!refMatch) continue;
    const roleMatch = line.match(/-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?/);
    if (!roleMatch) continue;
    nodes.push({
      role: roleMatch[1].toLowerCase(),
      label: roleMatch[2] || '',
      ref: `@${refMatch[1]}`,
      raw: line.trim(),
    });
  }
  return nodes;
}

const CAPTCHA_RE =
  /\b(recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha)\b|verify you are human|are you a robot|complete the security check|cloudflare.*challenge/i;
const PUSH_2FA_RE =
  /check your phone|tap yes on the prompt|approve sign[- ]in request|approve the notification|waiting for approval|open the authenticator app to approve/i;

function detectVerificationGate(
  title: string,
  url: string,
  tree: string,
  markdown: string,
  hasOtpField: boolean,
): 'captcha' | 'push_2fa' | null {
  const hay = `${title}\n${url}\n${tree}\n${markdown}`;
  if (CAPTCHA_RE.test(hay)) return 'captcha';
  if (!hasOtpField && PUSH_2FA_RE.test(hay)) return 'push_2fa';
  return null;
}

function pickLoginRefs(nodes: SnapshotNode[]) {
  const inputs = nodes.filter((n) => ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(n.role));
  const otpNode = inputs.find((n) =>
    /verification\s*code|authenticator|totp|one[- ]time|two[- ]factor|2fa|6[- ]digit|security\s*code|enter\s*code|\botp\b/i.test(
      `${n.label} ${n.raw}`,
    ),
  );
  const passwordNode = inputs.find((n) => /password|passcode|passwd/i.test(`${n.label} ${n.raw}`));
  const usernameNode =
    inputs.find(
      (n) =>
        n !== passwordNode &&
        n !== otpNode &&
        /email|user\s*name|phone|login|identifier|account|work\s*email|handle/i.test(`${n.label} ${n.raw}`) &&
        !/search/i.test(n.label),
    ) ||
    (inputs.length === 1 && !passwordNode && !otpNode && !/search/i.test(inputs[0].label) ? inputs[0] : undefined);

  const submitBtn = nodes.find(
    (n) =>
      n.role === 'button' &&
      /\b(next|continue|sign\s*in|log\s*in|submit|verify|confirm)\b/i.test(n.label) &&
      !/sign\s*in\s*with|continue\s*with|google|apple|github|microsoft|facebook|passkey|sso|forgot|reset|create\s*account|sign\s*up/i.test(
        n.label,
      ),
  );

  return { usernameNode, passwordNode, otpNode, submitBtn };
}

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  '#identifierId',
  'input[name="loginfmt"]',
  '#username',
  '#login_field',
  'input[name="username"]',
  'input[name="email"]',
  'input[name="login"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  'input[name="Passwd"]',
  'input[name="passwd"]',
  'input[name="password"]',
  '#password',
];

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  '#idTxtBx_SAOTCC_OTC',
  'input[name="totp"]',
  'input[name="otp"]',
  'input[name="pin"]',
  'input[id*="totp"]',
  'input[id*="otp"]',
];

function cleanTabId(tabId?: string | number | null): string | undefined {
  if (tabId === undefined || tabId === null || tabId === '') return undefined;
  return String(tabId).replace(/^tab-/, '');
}

async function zapJson(provider: string, method: string, params: Record<string, string>, ms = 20_000): Promise<any> {
  const raw = await zap.route(provider, method, params, ms);
  if (raw.startsWith('ERR:')) {
    throw new Error(raw.slice(4));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function takePageState(provider: string, tabId: string): Promise<{
  title: string;
  url: string;
  tree: string;
  markdown: string;
  nodes: SnapshotNode[];
}> {
  let title = '';
  let url = '';
  let tree = '';
  let markdown = '';

  try {
    const snap = await zapJson(provider, 'hanzo.snapshot', { tabId, interactive: 'true' });
    if (snap && typeof snap === 'object') {
      title = String(snap.title || '');
      url = String(snap.url || '');
      tree = String(snap.tree || '');
    }
  } catch {
    // Snapshot engine unavailable on mock/older target; continue with read/tabInfo.
  }

  try {
    const rd = await zapJson(provider, 'hanzo.read', { tabId });
    if (rd && typeof rd === 'object') {
      title = title || String(rd.title || '');
      url = url || String(rd.url || '');
      markdown = String(rd.markdown || '');
    }
  } catch {
    // Ignore if read unavailable.
  }

  if (!url) {
    try {
      const info = await zapJson(provider, 'hanzo.tabInfo', { tabId });
      title = title || String(info?.title || '');
      url = url || String(info?.url || '');
    } catch {
      // Ignore
    }
  }

  return { title, url, tree, markdown, nodes: parseSnapshotTree(tree) };
}

async function fillSecretField(
  provider: string,
  tabId: string,
  refSelector: string | undefined,
  fallbackSelectors: string[],
  secretValue: string,
): Promise<boolean> {
  if (refSelector) {
    try {
      await zapJson(provider, 'hanzo.act', {
        tabId,
        op: 'fill',
        selector: refSelector,
        text: secretValue,
      });
      return true;
    } catch {
      // Fall through to CSS selectors
    }
  }

  for (const selector of fallbackSelectors) {
    try {
      const res = await zapJson(provider, 'hanzo.act', {
        tabId,
        op: 'fill',
        selector,
        text: secretValue,
      });
      if (res !== false && res?.success !== false) return true;
    } catch {
      try {
        const res2 = await zapJson(provider, 'hanzo.fill', {
          tabId,
          selector,
          value: secretValue,
        });
        if (res2?.success === true) return true;
      } catch {
        // Try next selector
      }
    }
  }
  return false;
}

async function submitStep(provider: string, tabId: string, submitRef?: string): Promise<void> {
  if (submitRef) {
    try {
      await zapJson(provider, 'hanzo.act', { tabId, op: 'click', selector: submitRef });
      return;
    } catch {
      // Fall back to Enter key
    }
  }
  try {
    await zapJson(provider, 'hanzo.press', { tabId, key: 'Enter' });
  } catch {
    await zapJson(provider, 'hanzo.act', { tabId, op: 'press', key: 'Enter' });
  }
}

async function waitSettle(provider: string, tabId: string, ms = 1200): Promise<void> {
  try {
    await zapJson(provider, 'hanzo.wait', { tabId, timeout: String(ms) });
  } catch {
    // Ignore wait errors
  }
  await new Promise((r) => setTimeout(r, Math.min(ms, 800)));
}

export interface BrowserLoginResult {
  success: boolean;
  status: 'submitted' | 'awaiting_user_verification' | 'missing_credentials';
  reason?: string;
  app: string;
  tabId?: string;
  url?: string;
  stepsCompleted?: string[];
}

/**
 * Perform KMS-backed auto-login in the user's connected Agentic Browser over ZAP.
 * Uses `hanzo.navigate`, `hanzo.snapshot`, `hanzo.read`, `hanzo.act`, `hanzo.fill`, and `hanzo.press`
 * (CSP-safe isolated-world / native dispatch — never `Runtime.evaluate`).
 * Immediately halts and activates the tab for the user if a CAPTCHA or push-2FA gate appears.
 */
export async function browserAutoLogin(opts: {
  app: string;
  loginUrl?: string;
  env?: string;
  tabId?: string | number;
  targetBrowser?: string;
  clientId?: string;
}): Promise<BrowserLoginResult> {
  const app = slugifyApp(opts.app);
  const env = opts.env || 'prod';
  const basePath = `credentials/${app}`;

  const [username, password, totpSecret, storedUrl] = await Promise.all([
    kmsGetSecret(`${basePath}/USERNAME`, env),
    kmsGetSecret(`${basePath}/PASSWORD`, env),
    kmsGetSecret(`${basePath}/TOTP_SECRET`, env),
    kmsGetSecret(`${basePath}/URL`, env),
  ]);

  if (!username && !password) {
    return {
      success: false,
      status: 'missing_credentials',
      reason: `No USERNAME or PASSWORD sealed in Hanzo KMS under ${basePath}`,
      app,
    };
  }

  const provider = await zap.resolve(opts.targetBrowser ?? null, opts.clientId ?? null);
  if (!provider) {
    throw new Error('No Agentic Browser connected on the ZAP router');
  }

  const targetUrl = opts.loginUrl || storedUrl || KNOWN_LOGIN_URLS[app];
  if (!targetUrl) {
    throw new Error(`No loginUrl provided and no URL stored in KMS for app "${app}"`);
  }

  let tabId = cleanTabId(opts.tabId);
  if (!tabId) {
    const created = await zapJson(provider, 'Target.createTarget', { url: targetUrl });
    tabId = cleanTabId(created?.tabId ?? created?.targetId);
    if (!tabId) throw new Error('Failed to open login tab via ZAP');
    await waitSettle(provider, tabId, 1500);
  } else {
    try {
      await zapJson(provider, 'hanzo.navigate', { tabId, url: targetUrl });
    } catch {
      await zapJson(provider, 'Page.navigate', { tabId, url: targetUrl });
      await waitSettle(provider, tabId, 1500);
    }
  }

  const stepsCompleted: string[] = [];
  let state = await takePageState(provider, tabId);
  let refs = pickLoginRefs(state.nodes);

  // Guard 1: Check CAPTCHA / anti-bot gate before interacting
  const initialGate = detectVerificationGate(state.title, state.url, state.tree, state.markdown, !!refs.otpNode);
  if (initialGate) {
    await zap.route(provider, 'Target.activateTarget', { tabId }).catch(() => {});
    return {
      success: false,
      status: 'awaiting_user_verification',
      reason: initialGate,
      app,
      tabId,
      url: state.url || targetUrl,
      stepsCompleted,
    };
  }

  // Step 1: Fill username (supports both single-page and multi-step username -> Next -> password)
  if (username) {
    const filledUser = await fillSecretField(
      provider,
      tabId,
      refs.usernameNode?.ref,
      USERNAME_SELECTORS,
      username,
    );
    if (filledUser) {
      stepsCompleted.push('username_filled');
      // If password field isn't visible yet, advance multi-step flow (Google, Microsoft, X, Salesforce, Intuit, LastPass)
      if (!refs.passwordNode) {
        await submitStep(provider, tabId, refs.submitBtn?.ref);
        stepsCompleted.push('username_submitted');
        await waitSettle(provider, tabId, 1400);
        state = await takePageState(provider, tabId);
        refs = pickLoginRefs(state.nodes);

        const midGate = detectVerificationGate(state.title, state.url, state.tree, state.markdown, !!refs.otpNode);
        if (midGate) {
          await zap.route(provider, 'Target.activateTarget', { tabId }).catch(() => {});
          return {
            success: false,
            status: 'awaiting_user_verification',
            reason: midGate,
            app,
            tabId,
            url: state.url || targetUrl,
            stepsCompleted,
          };
        }
      }
    }
  }

  // Step 2: Fill password & submit
  if (password) {
    const filledPass = await fillSecretField(
      provider,
      tabId,
      refs.passwordNode?.ref,
      PASSWORD_SELECTORS,
      password,
    );
    if (filledPass) {
      stepsCompleted.push('password_filled');
      await submitStep(provider, tabId, refs.submitBtn?.ref);
      stepsCompleted.push('password_submitted');
      await waitSettle(provider, tabId, 1600);
      state = await takePageState(provider, tabId);
      refs = pickLoginRefs(state.nodes);
    }
  }

  // Guard 2: Post-password CAPTCHA or Push-2FA gate
  const postGate = detectVerificationGate(state.title, state.url, state.tree, state.markdown, !!refs.otpNode);
  if (postGate) {
    await zap.route(provider, 'Target.activateTarget', { tabId }).catch(() => {});
    return {
      success: false,
      status: 'awaiting_user_verification',
      reason: postGate,
      app,
      tabId,
      url: state.url || targetUrl,
      stepsCompleted,
    };
  }

  // Step 3: Fill TOTP if an OTP prompt is shown
  const otpPromptVisible =
    Boolean(refs.otpNode) ||
    /\b(two[- ]factor|verification code|authenticator|6[- ]digit code|enter the code)\b/i.test(
      `${state.title}\n${state.markdown}`,
    );

  if (otpPromptVisible) {
    if (!totpSecret) {
      await zap.route(provider, 'Target.activateTarget', { tabId }).catch(() => {});
      return {
        success: false,
        status: 'awaiting_user_verification',
        reason: '2fa_totp_secret_not_sealed',
        app,
        tabId,
        url: state.url || targetUrl,
        stepsCompleted,
      };
    }
    const { code } = generateTotp(totpSecret);
    const filledOtp = await fillSecretField(provider, tabId, refs.otpNode?.ref, OTP_SELECTORS, code);
    if (filledOtp) {
      stepsCompleted.push('totp_filled');
      await submitStep(provider, tabId, refs.submitBtn?.ref);
      stepsCompleted.push('totp_submitted');
      await waitSettle(provider, tabId, 1200);
      state = await takePageState(provider, tabId);
    } else {
      await zap.route(provider, 'Target.activateTarget', { tabId }).catch(() => {});
      return {
        success: false,
        status: 'awaiting_user_verification',
        reason: 'otp_input_not_reachable',
        app,
        tabId,
        url: state.url || targetUrl,
        stepsCompleted,
      };
    }
  }

  return {
    success: true,
    status: 'submitted',
    app,
    tabId,
    url: state.url || targetUrl,
    stepsCompleted,
  };
}

// ── Tool Envelope Helpers ────────────────────────────────────────────────────

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...extra }, null, 2) }],
    isError: true,
  };
}

const ACTIONS = ['status', 'list', 'seal', 'sync_lastpass', 'totp', 'browser_login'] as const;

export const vaultTool: Tool = {
  name: 'vault',
  description:
    'Sovereign credential vault unifying Hanzo KMS (`~/.local/bin/hanzo kms`), LastPass (`lpass` CLI + Enterprise API), ' +
    'and ZAP Agentic Browser Auto-Login. Secrets live ONLY in Hanzo KMS and are NEVER returned or written to disk.\n' +
    'Actions:\n' +
    '- status: check Hanzo KMS health, LastPass CLI / Enterprise API readiness, and connected ZAP browsers\n' +
    '- list: list credential metadata (app, path, keys, source) from KMS and LastPass without values\n' +
    '- seal: seal app credentials (username, password, api_key, oauth_token, totp_secret, url, notes) into KMS\n' +
    '- sync_lastpass: stream items from `lpass export` in-memory into Hanzo KMS (`credentials/<slug>/*`) with zero disk writes\n' +
    '- totp: compute RFC 6238 TOTP from KMS `TOTP_SECRET` (fills directly into ZAP browser when fillSelector is given; never exposes code)\n' +
    '- browser_login: sign in to an app in the Agentic Browser over ZAP using KMS credentials + multi-step + TOTP (pauses cleanly on CAPTCHAs)',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Vault operation: status | list | seal | sync_lastpass | totp | browser_login',
      },
      app: {
        type: 'string',
        description: 'App or connector slug (e.g. gmail, salesforce, x, lastpass, quickbooks)',
      },
      env: {
        type: 'string',
        description: 'Hanzo KMS environment (default: prod)',
      },
      path: {
        type: 'string',
        description: 'Custom KMS secret path override (default: credentials/<app>)',
      },
      username: { type: 'string', description: 'seal: account username or email' },
      password: { type: 'string', description: 'seal: account password (sealed to KMS, never echoed)' },
      api_key: { type: 'string', description: 'seal: API key (sealed to KMS, never echoed)' },
      oauth_token: { type: 'string', description: 'seal: OAuth bearer token (sealed to KMS, never echoed)' },
      totp_secret: { type: 'string', description: 'seal: Base32 TOTP secret or otpauth:// URI (sealed to KMS)' },
      url: { type: 'string', description: 'seal: login or app URL' },
      notes: { type: 'string', description: 'seal: non-echoed credential notes' },
      custom: {
        type: 'object',
        description: 'seal: additional key/value secrets to seal under credentials/<app>/<KEY>',
      },
      loginUrl: {
        type: 'string',
        description: 'browser_login: explicit login URL override',
      },
      fillSelector: {
        type: 'string',
        description: 'totp: snapshot ref (@eN) or CSS selector to fill the live 6-digit TOTP code into via ZAP',
      },
      submit: {
        type: 'boolean',
        description: 'totp: press Enter after filling the TOTP code into the browser',
      },
      tabId: {
        type: ['string', 'integer'],
        description: 'totp / browser_login: target browser tab ID',
      },
      targetBrowser: {
        type: 'string',
        description: 'ZAP browser filter (chrome | firefox)',
      },
      clientId: {
        type: 'string',
        description: 'Explicit ZAP browser node ID',
      },
      filterApp: {
        type: 'string',
        description: 'sync_lastpass: optional app substring filter',
      },
    },
    required: ['action'],
  },
  async handler(args: Record<string, any> = {}): Promise<ToolResult> {
    const action = String(args.action || 'status');
    const env = String(args.env || 'prod');

    try {
      switch (action) {
        case 'status': {
          const hanzoBin = resolveHanzoBin();
          let kmsStatus: Record<string, unknown> = { binary: hanzoBin, available: false, ready: false };
          let kmsGroups: VaultCredentialGroup[] = [];
          try {
            const { stdout } = await runExec(hanzoBin, ['kms', 'health'], { timeoutMs: 6_000 });
            const parsed = JSON.parse(stdout);
            kmsStatus = {
              binary: hanzoBin,
              available: true,
              ready: Boolean(parsed?.ready ?? parsed?.status === 'ok'),
              status: parsed?.status ?? 'ok',
            };
            kmsGroups = await kmsListSecrets(env).catch(() => []);
          } catch (e: any) {
            kmsStatus = { binary: hanzoBin, available: fs.existsSync(hanzoBin), ready: false, error: e.message };
          }

          let lpassCli: Record<string, unknown> = { installed: false, loggedIn: false };
          try {
            const { stdout } = await runExec('lpass', ['status'], { timeoutMs: 4_000 });
            const loggedIn = /logged in as/i.test(stdout) && !/not logged in/i.test(stdout);
            lpassCli = { installed: true, loggedIn };
          } catch (e: any) {
            const installed = e?.code !== 'ENOENT';
            lpassCli = { installed, loggedIn: false };
          }

          const hasEnvEnterprise = Boolean(
            process.env.LASTPASS_CID && process.env.LASTPASS_PROVISIONING_HASH,
          );
          const hasKmsEnterprise = kmsGroups.some(
            (g) =>
              g.keys.includes('LASTPASS_CID') ||
              (g.app === 'lastpass' && g.keys.includes('PROVISIONING_HASH')) ||
              g.keys.includes('LASTPASS_PROVISIONING_HASH'),
          );

          let zapStatus: Record<string, unknown> = { connected: false, count: 0, browsers: [] };
          try {
            const nodes = await zap.browsers();
            zapStatus = {
              connected: nodes.length > 0,
              count: nodes.length,
              browsers: nodes.map((n) => ({ id: n.id, brand: n.brand, caps: n.caps })),
            };
          } catch (e: any) {
            zapStatus = { connected: false, count: 0, browsers: [], note: e.message };
          }

          return ok({
            action: 'status',
            kms: kmsStatus,
            lastpass: {
              cli: lpassCli,
              enterpriseConfigured: hasEnvEnterprise || hasKmsEnterprise,
              enterpriseSource: hasKmsEnterprise ? 'kms' : hasEnvEnterprise ? 'env' : null,
            },
            zap: zapStatus,
          });
        }

        case 'list': {
          const credentials: VaultCredentialGroup[] = [];
          const warnings: string[] = [];

          try {
            const kmsItems = await kmsListSecrets(env);
            credentials.push(...kmsItems);
          } catch (e: any) {
            warnings.push(`kms: ${e.message}`);
          }

          // Check LastPass CLI metadata (`lpass ls --json`) without reading passwords
          try {
            const { stdout } = await runExec('lpass', ['ls', '--json'], { timeoutMs: 8_000 });
            const items = JSON.parse(stdout);
            if (Array.isArray(items)) {
              const grouped = new Map<string, Set<string>>();
              for (const item of items) {
                const name = String(item?.name || item?.fullname || '').trim();
                if (!name) continue;
                const slug = slugifyApp(name);
                if (!grouped.has(slug)) grouped.set(slug, new Set());
                grouped.get(slug)!.add('LPASS_ENTRY');
                if (item?.username) grouped.get(slug)!.add('USERNAME');
                if (item?.url) grouped.get(slug)!.add('URL');
              }
              for (const [slug, keys] of grouped.entries()) {
                credentials.push({
                  app: slug,
                  path: `lastpass/${slug}`,
                  keys: [...keys].sort(),
                  source: 'lastpass',
                });
              }
            }
          } catch {
            // lpass CLI optional; check Enterprise API metadata if configured
            const cid =
              (await kmsGetSecret('credentials/lastpass/LASTPASS_CID', env)) ||
              process.env.LASTPASS_CID ||
              null;
            const provhash =
              (await kmsGetSecret('credentials/lastpass/LASTPASS_PROVISIONING_HASH', env)) ||
              process.env.LASTPASS_PROVISIONING_HASH ||
              null;
            if (cid && provhash) {
              try {
                const res = await fetch('https://lastpass.com/enterpriseapi.php', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cid, provhash, cmd: 'getuserdata' }),
                });
                if (res.ok) {
                  const data: any = await res.json();
                  const userCount =
                    data?.Users && typeof data.Users === 'object' ? Object.keys(data.Users).length : 0;
                  credentials.push({
                    app: 'lastpass_enterprise',
                    path: 'enterprise/users',
                    keys: [`ACTIVE_USERS_${userCount}`],
                    source: 'lastpass',
                  });
                }
              } catch {
                // Ignore network failure during metadata list
              }
            }
          }

          const filtered = args.app
            ? credentials.filter((c) => c.app === slugifyApp(args.app) || c.path.includes(slugifyApp(args.app)))
            : credentials;

          return ok({
            action: 'list',
            env,
            count: filtered.length,
            credentials: filtered,
            ...(warnings.length ? { warnings } : {}),
          });
        }

        case 'seal': {
          if (!args.app) return fail('app is required for action="seal"');
          const res = await sealAppCredentials({
            app: args.app,
            path: args.path,
            env,
            username: args.username,
            password: args.password,
            api_key: args.api_key,
            oauth_token: args.oauth_token,
            totp_secret: args.totp_secret,
            url: args.url,
            notes: args.notes,
            custom: args.custom,
          });
          if (res.keysSealed.length === 0) {
            return fail(
              'No credential fields provided to seal (pass username, password, api_key, oauth_token, totp_secret, url, notes, or custom)',
            );
          }
          return ok({ action: 'seal', ...res });
        }

        case 'sync_lastpass': {
          let stdout = '';
          try {
            ({ stdout } = await runExec(
              'lpass',
              ['export', '--sync=now', '--fields=url,username,password,extra,name,totp'],
              { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 },
            ));
          } catch (e: any) {
            if (/totp|unknown field|invalid/i.test(String(e?.message || ''))) {
              ({ stdout } = await runExec(
                'lpass',
                ['export', '--sync=now', '--fields=url,username,password,extra,name'],
                { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 },
              ));
            } else {
              return fail(`Failed to export from LastPass CLI: ${e.message}`);
            }
          }

          const rows = parseCsvRows(stdout);
          stdout = ''; // Drop raw buffer reference immediately
          if (rows.length <= 1) {
            return ok({ action: 'sync_lastpass', env, syncedCount: 0, apps: [] });
          }

          const header = rows[0].map((h) => h.trim().toLowerCase());
          const idx = (col: string) => header.indexOf(col);
          const iUrl = idx('url');
          const iUser = idx('username');
          const iPass = idx('password');
          const iExtra = idx('extra');
          const iName = idx('name');
          const iTotp = idx('totp');

          const filterSlug = args.filterApp ? slugifyApp(args.filterApp) : null;
          const syncedApps: string[] = [];

          for (let r = 1; r < rows.length; r++) {
            const cols = rows[r];
            const rawUrl = iUrl >= 0 ? cols[iUrl] || '' : '';
            const rawUser = iUser >= 0 ? cols[iUser] || '' : '';
            const rawPass = iPass >= 0 ? cols[iPass] || '' : '';
            const rawExtra = iExtra >= 0 ? cols[iExtra] || '' : '';
            const rawName = iName >= 0 ? cols[iName] || '' : '';
            let rawTotp = iTotp >= 0 ? cols[iTotp] || '' : '';

            if (!rawTotp && rawExtra) {
              const otpMatch = rawExtra.match(/otpauth:\/\/[^\s]+/i);
              if (otpMatch) rawTotp = otpMatch[0];
            }

            const slug = slugifyApp(rawName || hostnameSlug(rawUrl));
            if (!slug || slug === 'unknown') continue;
            if (filterSlug && !slug.includes(filterSlug)) continue;
            if (!rawUser && !rawPass && !rawTotp) continue;

            await sealAppCredentials({
              app: slug,
              env,
              username: rawUser || undefined,
              password: rawPass || undefined,
              url: rawUrl && rawUrl !== 'http://sn' ? rawUrl : undefined,
              totp_secret: rawTotp || undefined,
            });
            if (!syncedApps.includes(slug)) syncedApps.push(slug);
          }

          return ok({
            action: 'sync_lastpass',
            env,
            syncedCount: syncedApps.length,
            apps: syncedApps.sort(),
          });
        }

        case 'totp': {
          if (!args.app) return fail('app is required for action="totp"');
          const app = slugifyApp(args.app);
          const secretPath = (args.path || `credentials/${app}`).replace(/^\/+|\/+$/g, '');
          const secret = await kmsGetSecret(`${secretPath}/TOTP_SECRET`, env);
          if (!secret) {
            return fail(`No TOTP_SECRET sealed in Hanzo KMS at ${secretPath}/TOTP_SECRET`);
          }

          const { code, expiresInSeconds } = generateTotp(secret);

          if (args.fillSelector) {
            const provider = await zap.resolve(args.targetBrowser ?? null, args.clientId ?? null);
            if (!provider) {
              return fail('No Agentic Browser connected on ZAP router to fill TOTP');
            }
            const tabId = cleanTabId(args.tabId);
            const selector = String(args.fillSelector);
            let filled = false;
            try {
              await zapJson(provider, 'hanzo.act', {
                ...(tabId ? { tabId } : {}),
                op: 'fill',
                selector,
                text: code,
              });
              filled = true;
            } catch {
              const res = await zapJson(provider, 'hanzo.fill', {
                ...(tabId ? { tabId } : {}),
                selector,
                value: code,
              });
              filled = res?.success !== false;
            }
            if (args.submit) {
              await zap.route(provider, 'hanzo.press', { ...(tabId ? { tabId } : {}), key: 'Enter' }).catch(() => {});
            }
            return ok({
              action: 'totp',
              app,
              filled,
              tabId: tabId ?? 'active',
              selector,
              expiresInSeconds,
            });
          }

          return ok({
            action: 'totp',
            app,
            filled: false,
            expiresInSeconds,
            hint: 'Pass fillSelector (and optional tabId) to type the live TOTP code directly into the browser over ZAP without exposing it.',
          });
        }

        case 'browser_login': {
          if (!args.app) return fail('app is required for action="browser_login"');
          const result = await browserAutoLogin({
            app: args.app,
            loginUrl: args.loginUrl,
            env,
            tabId: args.tabId,
            targetBrowser: args.targetBrowser,
            clientId: args.clientId,
          });
          if (!result.success && result.status === 'missing_credentials') {
            return fail(result.reason || 'Missing credentials in KMS', { ...result });
          }
          return ok({ action: 'browser_login', ...result });
        }

        default:
          return fail(`Unknown vault action "${action}". Valid actions: ${ACTIONS.join(', ')}`);
      }
    } catch (e: any) {
      return fail(e?.message || String(e), { action });
    }
  },
};

export const vaultTools: Tool[] = [vaultTool];
