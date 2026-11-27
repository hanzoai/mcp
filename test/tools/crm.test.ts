import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { crmTool, CRM_ACTIONS, CRM_OBJECTS, resolveCrmObject } from '../../src/tools/crm.js';
import { allUnifiedTools, hanzoTool, legacyToolAliasMap } from '../../src/tools/unified/index.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function mockFetchRouter(
  handler: (call: RecordedCall) => { status: number; body?: unknown },
): { calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers || {}) as Record<string, string>;
    const call: RecordedCall = {
      url,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const resp = handler(call);
    const text = resp.body === undefined ? '' : JSON.stringify(resp.body);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      text: async () => text,
    };
  });
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = realFetch;
    },
  };
}

describe('crm MCP tool (TypeScript)', () => {
  const savedEnv = {
    HANZO_API_BASE: process.env.HANZO_API_BASE,
    HANZO_API_URL: process.env.HANZO_API_URL,
    HANZO_API_KEY: process.env.HANZO_API_KEY,
    HANZO_ORG: process.env.HANZO_ORG,
  };

  beforeEach(() => {
    delete process.env.HANZO_API_BASE;
    process.env.HANZO_API_URL = 'https://crm-test.hanzo.ai';
    process.env.HANZO_API_KEY = 'sk-ts-crm';
    process.env.HANZO_ORG = 'hanzo';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('preserves 19-tool HIP-0300 surface while wiring legacy alias and hanzo router', () => {
    expect(allUnifiedTools).toHaveLength(19);
    expect(allUnifiedTools.some((t) => t.name === 'crm')).toBe(false);
    expect(legacyToolAliasMap.get('crm')).toBe(crmTool);
    expect(hanzoTool.inputSchema.properties.resource.enum).toContain('crm');
    expect(CRM_OBJECTS).toHaveLength(13);
    expect(CRM_OBJECTS).toContain('applications');
    expect(CRM_ACTIONS).toHaveLength(13);
    expect(resolveCrmObject('deals')).toBe('opportunities');
    expect(resolveCrmObject('applications')).toBe('applications');
    expect(() => resolveCrmObject('invoices')).toThrow(/invalid CRM object/);
  });

  test('executes all 13 actions matching hanzo-inc/cloud /v1/crm & /v1/marketing/mail contracts', async () => {
    const mock = mockFetchRouter((call) => {
      const u = new URL(call.url);
      if (call.method === 'DELETE' && u.pathname === '/v1/crm/records/tasks/t_1') {
        return { status: 204 };
      }
      return { status: 200, body: { path: u.pathname, query: u.search, method: call.method } };
    });

    try {
      const cases: Array<Record<string, unknown>> = [
        { action: 'objects' },
        { action: 'search', q: 'acme', objects: ['people', 'deals', 'applications'], limit: 5 },
        { action: 'list', object: 'people', filter: "status='active'", sort: '-created', search: 'ada', page: 2, per_page: 20, expand: 'company' },
        { action: 'get', object: 'deals', id: 'opp_1', expand: 'owner', include: 'timeline,notes' },
        { action: 'create', object: 'companies', data: { name: 'Hanzo AI' }, key: 'domain' },
        { action: 'update', object: 'people', id: 'p_1', data: { title: 'Co-CEO' } },
        { action: 'delete', object: 'tasks', id: 't_1' },
        { action: 'merge', object: 'people', source_id: 'p_1', target_id: 'p_2', fields: { email: 'a@b.co' } },
        { action: 'move_stage', id: 'opp_1', stage: 'customer', next_step: 'Onboarding', note: 'signed' },
        { action: 'log_activity', kind: 'call', subject: 'Intro', body: 'Notes', person: 'p_1', direction: 'outbound', channel: 'phone' },
        { action: 'analytics', pipeline: 'sales', period: '30d', object: 'deals' },
        { action: 'ai_assist', mode: 'summarize', prompt: 'Key risks', object: 'deals', record_id: 'opp_1', model: 'enso-auto' },
        { action: 'send_email', to: 'a@b.co', subject: 'Hi', body: 'Hello', person: 'p_1', in_reply_to: '<m1@acme.io>', org: 'zoo-labs' },
      ];

      for (const args of cases) {
        const res = await crmTool.handler(args);
        expect(res.isError).toBeUndefined();
        const env = JSON.parse(res.content[0].text!);
        expect(env.ok).toBe(true);
        expect(env.meta.tool).toBe('crm');
        expect(env.meta.action).toBe(args.action);
      }

      expect(mock.calls).toHaveLength(13);
      expect(mock.calls[0].url).toBe('https://crm-test.hanzo.ai/v1/crm/objects');
      expect(mock.calls[1].url).toBe('https://crm-test.hanzo.ai/v1/crm/search?q=acme&objects=people%2Copportunities%2Capplications&limit=5');
      expect(mock.calls[3].url).toBe('https://crm-test.hanzo.ai/v1/crm/records/opportunities/opp_1?expand=owner&include=timeline%2Cnotes');
      expect(mock.calls[4].body).toEqual({ record: { name: 'Hanzo AI' }, key: 'domain' });
      expect(mock.calls[5].body).toEqual({ record: { title: 'Co-CEO' } });
      expect(mock.calls[7].url).toBe('https://crm-test.hanzo.ai/v1/crm/records/people/merge');
      expect(mock.calls[8].url).toBe('https://crm-test.hanzo.ai/v1/crm/deals/opp_1/stage');
      expect(mock.calls[8].body).toEqual({ stage: 'customer', next_step: 'Onboarding', note: 'signed' });
      expect(mock.calls[9].url).toBe('https://crm-test.hanzo.ai/v1/crm/timeline');
      expect(mock.calls[9].body).toEqual({
        kind: 'call',
        direction: 'out',
        person_id: 'p_1',
        subject: 'Intro',
        body: 'Notes',
        channel: 'phone',
      });
      expect(mock.calls[10].url).toBe('https://crm-test.hanzo.ai/v1/crm/analytics?pipeline=sales&object=opportunities&period=30d');
      expect(mock.calls[11].url).toBe('https://crm-test.hanzo.ai/v1/crm/ai/assist');
      expect(mock.calls[11].body).toEqual({
        mode: 'summarize',
        prompt: 'Key risks',
        object: 'opportunities',
        record_id: 'opp_1',
        model: 'enso-auto',
      });
      expect(mock.calls[12].url).toBe('https://crm-test.hanzo.ai/v1/marketing/mail');
      expect(mock.calls[12].body).toEqual({
        to: 'a@b.co',
        subject: 'Hi',
        body: 'Hello',
        person: 'p_1',
        in_reply_to: '<m1@acme.io>',
      });
      expect(mock.calls[0].headers['X-Org-Id']).toBe('hanzo');
      expect(mock.calls[12].headers['X-Org-Id']).toBe('zoo-labs');
      expect(mock.calls[0].headers['Authorization']).toBe('Bearer sk-ts-crm');
    } finally {
      mock.restore();
    }
  });

  test('falls back cleanly to /v1/base/collections/{object}/records on HTTP 404 with unwrapped Base payload', async () => {
    const mock = mockFetchRouter((call) => {
      const u = new URL(call.url);
      if (u.pathname.startsWith('/v1/crm/records/')) {
        return { status: 404, body: { error: 'not found' } };
      }
      if (call.method === 'DELETE') return { status: 204 };
      return { status: 200, body: { fallbackPath: u.pathname, query: u.search, body: call.body } };
    });

    try {
      const listRes = await crmTool.handler({ action: 'list', object: 'deals', page: 1, per_page: 10 });
      const listEnv = JSON.parse(listRes.content[0].text!);
      expect(listEnv.ok).toBe(true);
      expect(listEnv.meta.fallback).toBe('base');
      expect(listEnv.data.fallbackPath).toBe('/v1/base/collections/opportunities/records');
      expect(listEnv.data.query).toBe('?page=1&perPage=10');

      const createRes = await crmTool.handler({ action: 'create', object: 'companies', data: { name: 'Fallback Co' } });
      const createEnv = JSON.parse(createRes.content[0].text!);
      expect(createEnv.ok).toBe(true);
      expect(createEnv.meta.fallback).toBe('base');
      expect(createEnv.data.body).toEqual({ name: 'Fallback Co' });

      const delRes = await crmTool.handler({ action: 'delete', object: 'notes', id: 'n_1' });
      const delEnv = JSON.parse(delRes.content[0].text!);
      expect(delEnv.ok).toBe(true);
      expect(delEnv.meta.fallback).toBe('base');
      expect(delEnv.data).toEqual({ deleted: true, object: 'notes', id: 'n_1' });
    } finally {
      mock.restore();
    }
  });

  test('rejects invalid objects, unlinked activities, multi-recipient send_email, and missing credentials without network calls', async () => {
    const mock = mockFetchRouter(() => ({ status: 200, body: {} }));
    try {
      const badObj = await crmTool.handler({ action: 'list', object: '../secrets' });
      expect(badObj.isError).toBe(true);
      expect(JSON.parse(badObj.content[0].text!).error.code).toBe('INVALID_ARGS');

      const unlinkedAct = await crmTool.handler({ action: 'log_activity', kind: 'call', subject: 'No link' });
      expect(unlinkedAct.isError).toBe(true);
      expect(JSON.parse(unlinkedAct.content[0].text!).error.code).toBe('INVALID_ARGS');

      const multiTo = await crmTool.handler({
        action: 'send_email',
        to: ['a@b.co', 'c@d.co'],
        subject: 'Hi',
        body: 'Hello',
      });
      expect(multiTo.isError).toBe(true);
      expect(JSON.parse(multiTo.content[0].text!).error.code).toBe('INVALID_ARGS');

      delete process.env.HANZO_API_KEY;
      const noKey = await crmTool.handler({ action: 'objects' });
      expect(noKey.isError).toBe(true);
      expect(JSON.parse(noKey.content[0].text!).error.code).toBe('NO_API_KEY');
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });
});
