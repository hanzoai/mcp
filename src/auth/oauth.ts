/**
 * IAM OAuth for hanzo-mcp — Authorization Code + PKCE (S256) via a loopback
 * redirect (RFC 8252 native-app flow). One way to authenticate the CLI to the
 * Hanzo cloud; no hand-rolled OAuth, no legacy paths.
 *
 * Endpoints are host-relative to the brand IAM server (HIP-0111):
 *   authorize  ${issuer}/v1/iam/oauth/authorize
 *   token      ${issuer}/v1/iam/oauth/token
 *   userinfo   ${issuer}/v1/iam/oauth/userinfo
 *
 * client_id = `hanzo-mcp` (public client; PKCE, no secret required).
 * Tokens are persisted via the secure credential store.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Credential, getCredential, setCredential } from './credentials.js';

export interface AuthConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  redirectPort: number;
  redirectUri: string;
}

export function authConfig(): AuthConfig {
  const issuer = (process.env.HANZO_IAM_URL || 'https://iam.hanzo.ai').replace(/\/$/, '');
  const clientId = process.env.HANZO_MCP_CLIENT_ID || 'hanzo-mcp';
  const clientSecret = process.env.HANZO_MCP_CLIENT_SECRET || undefined;
  const scope = process.env.HANZO_MCP_SCOPE || 'openid profile email';
  const redirectPort = Number(process.env.HANZO_MCP_REDIRECT_PORT || 53682);
  const redirectUri =
    process.env.HANZO_MCP_REDIRECT_URI || `http://127.0.0.1:${redirectPort}/callback`;
  return { issuer, clientId, clientSecret, scope, redirectPort, redirectUri };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Best-effort decode of a JWT payload (identity extraction only, never authz). */
export function decodeJwt(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    execFile(cmd, args, () => {});
  } catch {
    /* URL is printed for manual open */
  }
}

function tokenAuthHeaders(cfg: AuthConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.clientSecret) {
    // client_secret_basic when a confidential secret is configured.
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  }
  return headers;
}

function identityFrom(tok: { access_token: string; id_token?: string }): { sub?: string; email?: string } {
  const claims = decodeJwt(tok.id_token || tok.access_token) || {};
  const sub = claims.sub || claims.id || claims.name || claims.preferred_username;
  const email = claims.email;
  return { sub: sub ? String(sub) : undefined, email: email ? String(email) : undefined };
}

async function exchange(cfg: AuthConfig, body: Record<string, string>): Promise<Credential> {
  const res = await fetch(`${cfg.issuer}/v1/iam/oauth/token`, {
    method: 'POST',
    headers: tokenAuthHeaders(cfg),
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${text.substring(0, 300)}`);
  }
  let tok: any;
  try {
    tok = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.substring(0, 200)}`);
  }
  if (!tok.access_token) throw new Error(`token response missing access_token: ${text.substring(0, 200)}`);
  const now = Date.now();
  const id = identityFrom(tok);
  return {
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    idToken: tok.id_token,
    expiresAt: now + (Number(tok.expires_in) || 3600) * 1000,
    scope: tok.scope || cfg.scope,
    obtainedAt: now,
    ...id,
  };
}

/**
 * Run the interactive loopback PKCE login. Opens the browser to IAM, captures
 * the redirect on 127.0.0.1, exchanges the code, and persists the credential.
 */
export async function login(
  cfg: AuthConfig = authConfig(),
  log: (m: string) => void = () => {},
): Promise<Credential> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(crypto.randomBytes(16));

  const code: string = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', cfg.redirectUri);
        if (u.pathname !== new URL(cfg.redirectUri).pathname) {
          res.writeHead(404).end('not found');
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<h3>Login failed: ${err}</h3>`);
          server.close();
          reject(new Error(`authorize error: ${err} ${u.searchParams.get('error_description') || ''}`));
          return;
        }
        const got = u.searchParams.get('code');
        const gotState = u.searchParams.get('state');
        if (!got || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h3>Invalid login response</h3>');
          server.close();
          reject(new Error('missing code or state mismatch'));
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<h3>hanzo-mcp is authenticated.</h3><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(got);
      } catch (e: any) {
        try {
          res.writeHead(500).end('error');
        } catch {}
        server.close();
        reject(e);
      }
    });

    server.on('error', reject);
    server.listen(cfg.redirectPort, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const authorize = new URL(`${cfg.issuer}/v1/iam/oauth/authorize`);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', cfg.clientId);
      authorize.searchParams.set('redirect_uri', cfg.redirectUri.replace(String(cfg.redirectPort), String(port)));
      authorize.searchParams.set('scope', cfg.scope);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      const url = authorize.toString();
      log(`Opening browser to authenticate:\n  ${url}\n`);
      openBrowser(url);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('login timed out after 300s'));
    }, 300_000).unref?.();
  });

  const cred = await exchange(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  await setCredential(cred);
  return cred;
}

/** Refresh an access token using the stored refresh token. Persists the result. */
export async function refresh(cfg: AuthConfig, cred: Credential): Promise<Credential> {
  if (!cred.refreshToken) throw new Error('no refresh token; run `hanzo-mcp auth login`');
  const next = await exchange(cfg, {
    grant_type: 'refresh_token',
    refresh_token: cred.refreshToken,
    client_id: cfg.clientId,
  });
  // Casdoor may not re-issue a refresh token; keep the prior one if so.
  if (!next.refreshToken) next.refreshToken = cred.refreshToken;
  if (!next.sub) next.sub = cred.sub;
  if (!next.email) next.email = cred.email;
  await setCredential(next);
  return next;
}

/**
 * Return a non-expired credential, refreshing if needed. `null` when the user
 * is not logged in (the honest "fall back to local" signal for backends).
 */
export async function resolveCredential(cfg: AuthConfig = authConfig()): Promise<Credential | null> {
  const cred = await getCredential(cfg.issuer, cfg.clientId);
  if (!cred) return null;
  const skewMs = 60_000;
  if (Date.now() < cred.expiresAt - skewMs) return cred;
  if (!cred.refreshToken) return null;
  try {
    return await refresh(cfg, cred);
  } catch {
    return null;
  }
}

/** Convenience: a valid bearer access token, or null when unauthenticated. */
export async function getAccessToken(cfg: AuthConfig = authConfig()): Promise<string | null> {
  const cred = await resolveCredential(cfg);
  return cred?.accessToken || null;
}
