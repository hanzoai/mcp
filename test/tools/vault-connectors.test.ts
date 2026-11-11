/**
 * Unit & wire tests for `vault` and `connectors` MCP tools.
 *
 * Exercises:
 *   - Unified HIP-0300 registration & schema validation
 *   - Complete registry coverage (all 16 compatible apps + LastPass + Hanzo Post + 15 socials)
 *   - Zero secret/cookie value leakage across KMS seal, LastPass CSV sync, TOTP, and ZAP session discovery
 *   - Multi-step CSP-safe `browser_login` (`hanzo.snapshot` + `hanzo.act` + TOTP) & CAPTCHA halt guard
 *   - 3-tier `connectors` execution: Native KMS API / Streamable-HTTP MCP -> Automatic ZAP Browser Fallback
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zap from '../../src/zap.js';
import {
  vaultTool,
  generateTotp,
  resolveHanzoBin,
  setVaultExecOverride,
} from '../../src/tools/vault.js';
import {
  connectorsTool,
  CONNECTORS,
  COMPATIBLE_16_APPS,
} from '../../src/tools/connectors.js';
import { allUnifiedTools, optionalTools } from '../../src/tools/unified/index.js';

// ── In-process ZAP mock router over a 0700 Unix domain socket ────────────────

function encodeStr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function encodeU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function encodeProvidersList(nodes: Array<{ id: string; role: number; brand: string; caps: string[] }>): Buffer {
  const parts: Buffer[] = [encodeU16(nodes.length)];
  for (const n of nodes) {
    parts.push(
      encodeStr(n.id),
      Buffer.from([n.role]),
      encodeStr(n.brand),
      encodeU16(n.caps.length),
      ...n.caps.map(encodeStr),
      encodeU16(0), // attrs
    );
  }
  return Buffer.concat(parts);
}

function decodeCmd(p: Buffer): { method: string; params: Record<string, string> } {
  let o = 0;
  const s = (n: number) => {
    const v = p.toString('utf8', o, o + n);
    o += n;
    return v;
  };
  const method = s(p.readUInt16LE((o += 2) - 2));
  const params: Record<string, string> = {};
  for (let n = p.readUInt16LE((o += 2) - 2); n > 0; n--) {
    const k = s(p.readUInt16LE((o += 2) - 2));
    params[k] = s(p.readUInt32LE((o += 4) - 4));
  }
  return { method, params };
}

const parseBody = (res: any) => JSON.parse(res.content[0].text);

describe('vault and connectors MCP tools', () => {
  let tmpDir: string;
  let zapServer: net.Server;
  let prevXdg: string | undefined;
  let routeHandler: (method: string, params: Record<string, string>) => string;
  const recordedZapCalls: Array<{ method: string; params: Record<string, string> }> = [];

  // Simulated in-memory KMS store (never touches real org KMS during unit tests)
  const mockKms = new Map<string, { path: string; name: string; value: string; env: string }>();
  let mockLpassCsv = '';
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    prevXdg = process.env.XDG_RUNTIME_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzo-vault-zap-'));
    const zapDir = path.join(tmpDir, 'zap');
    fs.mkdirSync(zapDir, { mode: 0o700 });
    const sockPath = path.join(zapDir, 'zapd.sock');
    process.env.XDG_RUNTIME_DIR = tmpDir;
    zap.getSeat().close();

    zapServer = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      let clientId = 'mcp/test';
      sock.on('data', (chunk: Buffer) => {
        let frames: zap.Frame[];
        [frames, buf] = zap.decodeFrames(Buffer.concat([buf, chunk]));
        for (const f of frames) {
          if (f.t === zap.HELLO) {
            clientId = f.from || clientId;
            sock.write(zap.encodeFrame(zap.WELCOME, 'zapd', clientId));
          } else if (f.t === zap.PROVIDERS_LIST) {
            const payload = encodeProvidersList([
              {
                id: 'browser/local/chrome-mock',
                role: zap.ROLE_PROVIDER,
                brand: 'hanzo',
                caps: ['browser.tabs', 'social.sessions'],
              },
            ]);
            sock.write(zap.encodeFrame(zap.PROVIDERS, 'zapd', clientId, payload));
          } else if (f.t === zap.ROUTE) {
            const { method, params } = decodeCmd(f.payload);
            recordedZapCalls.push({ method, params });
            const reply = routeHandler(method, params);
            sock.write(zap.encodeFrame(zap.RESPONSE, f.to, clientId, Buffer.from(reply, 'utf8')));
          }
        }
      });
    });

    await new Promise<void>((resolve) => zapServer.listen(sockPath, () => resolve()));
  });

  afterAll(async () => {
    setVaultExecOverride(null);
    globalThis.fetch = origFetch;
    zap.getSeat().close();
    await new Promise<void>((resolve) => zapServer.close(() => resolve()));
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockKms.clear();
    recordedZapCalls.length = 0;
    mockLpassCsv = [
      'url,username,password,extra,name,totp',
      'https://login.salesforce.com,ops@hanzo.ai,"s3cr3t,Pass!","Line 1\nLine 2",Salesforce,JBSWY3DPEHPK3PXP',
      'https://www.klaviyo.com/login,growth@hanzo.ai,klavPass99,,Klaviyo,',
    ].join('\n');

    routeHandler = (method, params) => {
      if (method === 'Target.getTargets') {
        return JSON.stringify({
          targetInfos: [
            { targetId: 'tab-42', type: 'page', title: 'Inbox - Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' },
          ],
        });
      }
      if (method === 'Target.createTarget') {
        return JSON.stringify({ targetId: 'tab-99', tabId: 99 });
      }
      if (method === 'Target.activateTarget') {
        return JSON.stringify({ success: true });
      }
      if (method === 'social.sessions') {
        return JSON.stringify({
          success: true,
          sessions: [
            { provider: 'x', domain: 'x.com', authenticated: true, cookieNames: ['auth_token', 'ct0'] },
            { provider: 'linkedin', domain: 'linkedin.com', authenticated: false, cookieNames: [] },
          ],
        });
      }
      if (method === 'hanzo.getCookies') {
        return JSON.stringify({
          cookies: [
            { name: 'SID', value: 'SUPER_SECRET_COOKIE_VALUE_NEVER_LEAK' },
            { name: '__Secure-1PSID', value: 'ANOTHER_SECRET_COOKIE_VALUE_NEVER_LEAK' },
          ],
        });
      }
      if (method === 'hanzo.read') {
        return JSON.stringify({
          title: 'Inbox (3) - Gmail',
          url: params.url || 'https://mail.google.com/mail/u/0/#inbox',
          markdown: '# Inbox\n- Welcome to Hanzo Sovereign Cloud',
        });
      }
      if (method === 'hanzo.snapshot') {
        return JSON.stringify({
          title: 'Sign in',
          url: 'https://accounts.example.com/login',
          refs: 2,
          tree: '- textbox "Email or phone" [ref=e2]\n- button "Next" [ref=e3]',
        });
      }
      return JSON.stringify({ success: true, method, params });
    };

    setVaultExecOverride(async (bin, args) => {
      if (bin === 'lpass') {
        if (args[0] === 'status') return { stdout: 'Logged in as ops@hanzo.ai.\n', stderr: '' };
        if (args[0] === 'ls') {
          return {
            stdout: JSON.stringify([{ id: '1', name: 'Salesforce', username: 'ops@hanzo.ai', url: 'https://login.salesforce.com' }]),
            stderr: '',
          };
        }
        if (args[0] === 'export') return { stdout: mockLpassCsv, stderr: '' };
      }
      // Simulated `hanzo kms ...`
      if (args[0] === 'kms' && args[1] === 'health') {
        return { stdout: JSON.stringify({ ready: true, status: 'ok', service: 'kms' }), stderr: '' };
      }
      if (args[0] === 'kms' && args[1] === 'secrets' && args[2] === 'create') {
        const env = args[args.indexOf('--env') + 1] || 'prod';
        const p = args[args.indexOf('--path') + 1] || '';
        const name = args[args.indexOf('--name') + 1] || '';
        const value = args[args.indexOf('--value') + 1] || '';
        mockKms.set(`${env}:${p}/${name}`, { path: `/orgs/hanzo/${p}`, name, value, env });
        return { stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      if (args[0] === 'kms' && args[1] === 'secrets' && args[2] === 'list') {
        const env = args[args.indexOf('--env') + 1] || 'prod';
        const secrets = [...mockKms.values()]
          .filter((s) => s.env === env)
          .map(({ env: e, name, path: sp }) => ({ env: e, name, path: sp, scheme: 'aes-256-gcm' }));
        return { stdout: JSON.stringify({ secrets, total: secrets.length }), stderr: '' };
      }
      if (args[0] === 'kms' && args[1] === 'secrets' && args[2] === 'get') {
        const ref = args[3];
        const env = args[args.indexOf('--env') + 1] || 'prod';
        const hit = mockKms.get(`${env}:${ref}`);
        if (!hit) throw new Error('404 secret not found');
        return { stdout: JSON.stringify({ env, name: hit.name, value: hit.value }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${bin} ${args.join(' ')}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('registers vault and connectors in HIP-0300 optionalTools and allUnifiedTools', () => {
    expect(optionalTools.some((t) => t.name === 'vault')).toBe(true);
    expect(optionalTools.some((t) => t.name === 'connectors')).toBe(true);
    expect(allUnifiedTools.some((t) => t.name === 'vault')).toBe(true);
    expect(allUnifiedTools.some((t) => t.name === 'connectors')).toBe(true);
    expect(vaultTool.inputSchema.required).toEqual(['action']);
    expect(connectorsTool.inputSchema.required).toEqual(['action']);
  });

  test('covers all 16 compatible business apps, LastPass, Hanzo Post, and 15 socials', () => {
    const expected16 = [
      'gmail',
      'google_calendar',
      'google_drive',
      'salesforce',
      'microsoft_teams',
      'github',
      'google_forms',
      'woocommerce',
      'intercom',
      'facebook_lead_ads',
      'docusign',
      'google_ads',
      'klaviyo',
      'linkedin',
      'quickbooks',
      'google_analytics',
    ];
    expect(COMPATIBLE_16_APPS.sort()).toEqual([...expected16].sort());

    const expectedSocialsAndHub = [
      'lastpass',
      'hanzo_post',
      'x',
      'youtube',
      'instagram',
      'threads',
      'tiktok',
      'reddit',
      'facebook',
      'bluesky',
      'mastodon',
      'discord',
      'slack',
      'telegram',
      'devto',
      'hashnode',
      'medium',
    ];
    for (const id of [...expected16, ...expectedSocialsAndHub]) {
      expect(CONNECTORS[id]).toBeDefined();
      expect(CONNECTORS[id].webUrl).toMatch(/^https?:\/\/|^\{site_url\}/);
      expect(CONNECTORS[id].kmsPath).toBeTruthy();
    }
    expect(CONNECTORS.klaviyo.extraHeaders?.revision).toBe('2024-10-15');
    expect(CONNECTORS.hanzo_post.mcpEndpoint).toBe('https://post.hanzo.ai/mcp');
  });

  test('resolveHanzoBin never selects /usr/bin/hanzo', () => {
    const prev = process.env.HANZO_BIN;
    process.env.HANZO_BIN = '/usr/bin/hanzo';
    try {
      expect(resolveHanzoBin()).not.toBe('/usr/bin/hanzo');
    } finally {
      if (prev === undefined) delete process.env.HANZO_BIN;
      else process.env.HANZO_BIN = prev;
    }
  });

  test('vault seal, sync_lastpass, list, and totp never leak secret values', async () => {
    const sealRes = await vaultTool.handler({
      action: 'seal',
      app: 'GitHub',
      username: 'dev@hanzo.ai',
      password: 'UltraSecretPassword!123',
      totp_secret: 'JBSWY3DPEHPK3PXP',
    });
    const rawSealText = sealRes.content[0].text!;
    expect(rawSealText).not.toContain('UltraSecretPassword!123');
    expect(rawSealText).not.toContain('JBSWY3DPEHPK3PXP');
    expect(parseBody(sealRes)).toMatchObject({
      ok: true,
      app: 'github',
      path: 'credentials/github',
      keysSealed: ['USERNAME', 'PASSWORD', 'TOTP_SECRET'],
    });

    const syncRes = await vaultTool.handler({ action: 'sync_lastpass' });
    const rawSyncText = syncRes.content[0].text!;
    expect(rawSyncText).not.toContain('s3cr3t,Pass!');
    expect(rawSyncText).not.toContain('klavPass99');
    expect(parseBody(syncRes)).toMatchObject({
      ok: true,
      syncedCount: 2,
      apps: ['klaviyo', 'salesforce'],
    });

    const listRes = await vaultTool.handler({ action: 'list' });
    const rawListText = listRes.content[0].text!;
    expect(rawListText).not.toContain('UltraSecretPassword!123');
    expect(rawListText).not.toContain('s3cr3t,Pass!');
    expect(parseBody(listRes).credentials.some((c: any) => c.app === 'salesforce' && c.source === 'kms')).toBe(true);

    // TOTP generation check + ZAP fill without exposing 6-digit code or secret
    const directTotp = generateTotp('JBSWY3DPEHPK3PXP', 1_700_000_000_000);
    expect(directTotp.code).toMatch(/^\d{6}$/);

    const totpMeta = await vaultTool.handler({ action: 'totp', app: 'github' });
    expect(totpMeta.content[0].text).not.toContain('JBSWY3DPEHPK3PXP');
    expect(parseBody(totpMeta)).toMatchObject({ ok: true, app: 'github', filled: false });

    const totpFill = await vaultTool.handler({
      action: 'totp',
      app: 'github',
      fillSelector: '@e7',
      tabId: 'tab-42',
    });
    expect(totpFill.content[0].text).not.toContain(directTotp.code);
    expect(parseBody(totpFill)).toMatchObject({ ok: true, app: 'github', filled: true, selector: '@e7' });
    expect(recordedZapCalls.some((c) => c.method === 'hanzo.act' && c.params.op === 'fill' && c.params.selector === '@e7')).toBe(true);
  });

  test('vault browser_login handles multi-step username -> Next -> password -> TOTP without Runtime.evaluate', async () => {
    await vaultTool.handler({
      action: 'seal',
      app: 'x',
      username: '@hanzoai',
      password: 'XSecretLogin!99',
      totp_secret: 'JBSWY3DPEHPK3PXP',
    });

    let step = 0;
    routeHandler = (method, params) => {
      if (method === 'Target.createTarget') return JSON.stringify({ targetId: 'tab-77', tabId: 77 });
      if (method === 'hanzo.snapshot') {
        step++;
        if (step === 1) {
          return JSON.stringify({
            title: 'Log in to X',
            url: 'https://x.com/i/flow/login',
            refs: 2,
            tree: '- textbox "Phone, email, or username" [ref=e2]\n- button "Next" [ref=e3]',
          });
        }
        if (step === 2) {
          return JSON.stringify({
            title: 'Enter your password',
            url: 'https://x.com/i/flow/login',
            refs: 2,
            tree: '- textbox "Password" [ref=e5]\n- button "Log in" [ref=e6]',
          });
        }
        if (step === 3) {
          return JSON.stringify({
            title: 'Enter your verification code',
            url: 'https://x.com/i/flow/login',
            refs: 2,
            tree: '- textbox "Verification code" [ref=e8]\n- button "Next" [ref=e9]',
          });
        }
        return JSON.stringify({
          title: 'Home / X',
          url: 'https://x.com/home',
          refs: 1,
          tree: '- link "Home" [ref=e1]',
        });
      }
      if (method === 'hanzo.read') {
        return JSON.stringify({ title: 'X', url: 'https://x.com/home', markdown: 'Home timeline' });
      }
      return JSON.stringify({ ok: true, method, params });
    };

    const res = await vaultTool.handler({ action: 'browser_login', app: 'x' });
    const rawText = res.content[0].text!;
    expect(rawText).not.toContain('XSecretLogin!99');
    expect(rawText).not.toContain('JBSWY3DPEHPK3PXP');

    const body = parseBody(res);
    expect(body).toMatchObject({
      ok: true,
      status: 'submitted',
      app: 'x',
      tabId: '77',
      stepsCompleted: [
        'username_filled',
        'username_submitted',
        'password_filled',
        'password_submitted',
        'totp_filled',
        'totp_submitted',
      ],
    });
    expect(recordedZapCalls.some((c) => c.method === 'Runtime.evaluate')).toBe(false);
  });

  test('vault browser_login halts immediately and activates tab when a CAPTCHA gate appears', async () => {
    await vaultTool.handler({
      action: 'seal',
      app: 'quickbooks',
      username: 'finance@hanzo.ai',
      password: 'QBOPassword!1',
    });

    routeHandler = (method) => {
      if (method === 'Target.createTarget') return JSON.stringify({ targetId: 'tab-88', tabId: 88 });
      if (method === 'hanzo.snapshot') {
        return JSON.stringify({
          title: 'Security Check',
          url: 'https://accounts.intuit.com/app/sign-in',
          refs: 1,
          tree: '- iframe "reCAPTCHA challenge" [ref=e1]',
        });
      }
      if (method === 'hanzo.read') {
        return JSON.stringify({
          title: 'Security Check',
          url: 'https://accounts.intuit.com/app/sign-in',
          markdown: 'Please verify you are human to continue.',
        });
      }
      return JSON.stringify({ success: true });
    };

    const res = await vaultTool.handler({ action: 'browser_login', app: 'quickbooks' });
    const body = parseBody(res);
    expect(body).toMatchObject({
      ok: true,
      status: 'awaiting_user_verification',
      reason: 'captcha',
      tabId: '88',
    });
    expect(recordedZapCalls.some((c) => c.method === 'Target.activateTarget' && c.params.tabId === '88')).toBe(true);
    expect(recordedZapCalls.some((c) => c.method === 'hanzo.act' && c.params.op === 'fill')).toBe(false);
  });

  test('connectors list reports live KMS + ZAP cookie names without ever exposing cookie values', async () => {
    await vaultTool.handler({
      action: 'seal',
      app: 'klaviyo',
      api_key: 'pk_live_secret_klaviyo_key',
    });

    const res = await connectorsTool.handler({ action: 'list' });
    const rawText = res.content[0].text!;
    expect(rawText).not.toContain('SUPER_SECRET_COOKIE_VALUE_NEVER_LEAK');
    expect(rawText).not.toContain('ANOTHER_SECRET_COOKIE_VALUE_NEVER_LEAK');
    expect(rawText).not.toContain('pk_live_secret_klaviyo_key');

    const body = parseBody(res);
    expect(body.compatibleAppsCount).toBe(16);

    const gmail = body.connectors.find((c: any) => c.id === 'gmail');
    expect(gmail.browser).toMatchObject({
      zapConnected: true,
      authenticated: true,
      openTabId: '42',
      matchedCookieNames: ['SID', '__Secure-1PSID'],
    });
    expect(gmail.readyTier).toBe('tier2_browser_session');

    const klaviyo = body.connectors.find((c: any) => c.id === 'klaviyo');
    expect(klaviyo.kms.keys).toEqual(['API_KEY']);
    expect(klaviyo.readyTier).toBe('tier1_kms_api');
  });

  test('connectors request executes Tier 1 KMS API / Postiz MCP and falls back to Agentic Browser on missing/401 token', async () => {
    // 1. Tier 1 Native API with Klaviyo revision header
    await vaultTool.handler({ action: 'seal', app: 'klaviyo', api_key: 'pk_test_klaviyo' });

    const seenRequests: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (jest.fn(async (input: any, init?: any) => {
      const url = String(input);
      seenRequests.push({ url, headers: (init?.headers || {}) as Record<string, string> });
      if (url.startsWith('https://a.klaviyo.com/api/lists')) {
        return new Response(JSON.stringify({ data: [{ id: 'list-1', name: 'VIP' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://post.hanzo.ai/mcp') {
        return new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"integrations":["x","linkedin"]}}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response('Unauthorized', { status: 401 });
    }) as unknown) as typeof fetch;

    const klavRes = parseBody(
      await connectorsTool.handler({
        action: 'request',
        connector: 'klaviyo',
        path: '/lists',
      }),
    );
    expect(klavRes).toMatchObject({
      ok: true,
      mode: 'native_api',
      connector: 'klaviyo',
      status: 200,
      data: { data: [{ id: 'list-1', name: 'VIP' }] },
    });
    expect(seenRequests[0].headers.Authorization).toBe('Klaviyo-API-Key pk_test_klaviyo');
    expect(seenRequests[0].headers.revision).toBe('2024-10-15');

    // 2. Streamable-HTTP MCP via `hanzo_post` (`https://post.hanzo.ai/mcp`)
    await connectorsTool.handler({
      action: 'configure',
      connector: 'hanzo_post',
      token: 'postiz_secret_api_key',
    });
    const mcpRes = parseBody(
      await connectorsTool.handler({
        action: 'request',
        connector: 'linkedin',
        mcpTool: 'list_integrations',
      }),
    );
    expect(mcpRes).toMatchObject({
      ok: true,
      mode: 'mcp',
      connector: 'linkedin',
      endpoint: 'https://post.hanzo.ai/mcp',
    });

    // 3. Automatic ZAP Agentic Browser Fallback when Gmail has no KMS API token
    const fallbackRes = parseBody(
      await connectorsTool.handler({
        action: 'request',
        connector: 'gmail',
        path: '/messages',
      }),
    );
    expect(fallbackRes).toMatchObject({
      ok: true,
      mode: 'browser_fallback',
      fallbackReason: 'missing_api_credentials',
      connector: 'gmail',
      tabId: '42',
      title: 'Inbox (3) - Gmail',
    });
    expect(fallbackRes.content).toContain('Welcome to Hanzo Sovereign Cloud');
  });

  test('connectors configure opens setup page via ZAP or registers remote MCP server on api.hanzo.ai', async () => {
    const prevKey = process.env.HANZO_API_KEY;
    process.env.HANZO_API_KEY = 'hk-test-iam-token';
    let registeredPayload: any = null;
    globalThis.fetch = (jest.fn(async (input: any, init?: any) => {
      if (String(input) === 'https://api.hanzo.ai/v1/tool/mcp/servers') {
        registeredPayload = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({ id: 'mcp-srv-1' }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown) as typeof fetch;

    try {
      const cfgRes = parseBody(
        await connectorsTool.handler({
          action: 'configure',
          connector: 'hanzo_post',
          registerMcpServer: true,
          openBrowser: true,
          viaHanzoPost: true,
        }),
      );
      expect(cfgRes.mcpRegistration).toMatchObject({
        registered: true,
        status: 201,
        mcpServerUrl: 'https://post.hanzo.ai/mcp',
      });
      expect(registeredPayload).toMatchObject({
        name: 'hanzo_post-mcp',
        url: 'https://post.hanzo.ai/mcp',
      });
      expect(cfgRes.browserOpened).toMatchObject({
        tabId: '99',
        url: 'https://post.hanzo.ai/launches',
      });
    } finally {
      if (prevKey === undefined) delete process.env.HANZO_API_KEY;
      else process.env.HANZO_API_KEY = prevKey;
    }
  });
});
