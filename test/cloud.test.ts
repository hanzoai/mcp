/**
 * The cloud surface is GENERATED, so what is asserted here is the generation —
 * that every subsystem the catalog names is offered, that nothing is offered
 * that the catalog does not name, and that the default surface did not grow.
 *
 * The last of those is the one worth having: the package collapses its catalog
 * into action-routed tools on purpose, so a change that quietly pushed 115 tools
 * into the default list would undo that without failing anything else.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { cloudTools, operations } from '../src/tools/cloud.js';
import { getConfiguredTools } from '../src/tools/index.js';
import catalog from '../src/tools/catalog.json';

const fleet = catalog as Record<string, { ops: string[] }>;

describe('the cloud surface is the catalog', () => {
  it('offers describe plus one tool per subsystem, and nothing else', () => {
    const offered = cloudTools.map((t) => t.name).sort();
    const expected = ['describe', ...Object.keys(fleet)].sort();
    expect(offered).toEqual(expected);
  });

  it('puts describe first, where a truncating client still keeps it', () => {
    expect(cloudTools[0].name).toBe('describe');
  });

  it('carries every operation the catalog names', () => {
    const enumerated = cloudTools
      .filter((t) => t.name !== 'describe')
      .reduce((n, t) => n + (t.inputSchema.properties.op?.enum?.length ?? 0), 0);
    expect(enumerated).toBe(operations);
    expect(operations).toBe(Object.values(fleet).reduce((n, e) => n + e.ops.length, 0));
  });

  it('names an operation rather than describing it, so the list stays small', () => {
    // The whole argument for grouping: a flat projection of the same surface is
    // roughly a megabyte, which a model pays for on every turn.
    const listed = JSON.stringify(cloudTools.map(({ handler, ...rest }) => rest));
    expect(listed.length).toBeLessThan(200_000);
  });
});

describe('the default surface did not grow', () => {
  it('stays action-routed, with the fleet behind one tool', () => {
    const names = getConfiguredTools({}).map((t) => t.name);
    expect(names).toContain('hanzo');
    expect(names).not.toContain('iam');
    expect(names.length).toBeLessThan(40);
  });

  it('reaches every subsystem, and describe, through that one tool', () => {
    const hanzo = getConfiguredTools({}).find((t) => t.name === 'hanzo')!;
    expect(hanzo.inputSchema.properties.resource.enum).toEqual(['describe', ...Object.keys(fleet)].sort());
  });
});

/** sent runs fn against a stand-in fleet and returns the params of every call it made. */
async function sent(fn: () => Promise<unknown>): Promise<unknown[]> {
  const key = process.env.HANZO_API_KEY;
  process.env.HANZO_API_KEY = 'test-key';
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }),
  });
  const real = globalThis.fetch;
  (globalThis as any).fetch = fetchMock;
  try {
    await fn();
    return (fetchMock.mock.calls as [string, { body: string }][]).map(([url, init]) => {
      expect(url).toMatch(/\/v1\/mcp$/);
      return JSON.parse(init.body).params;
    });
  } finally {
    (globalThis as any).fetch = real;
    if (key === undefined) delete process.env.HANZO_API_KEY;
    else process.env.HANZO_API_KEY = key;
  }
}

describe('the hanzo tool', () => {
  const hanzo = () => getConfiguredTools({}).find((t) => t.name === 'hanzo')!;

  it('reads what an action takes, through describe', async () => {
    const calls = await sent(() => hanzo().handler({ resource: 'describe', args: { subsystem: 'graph', op: 'graphPath' } }));
    expect(calls).toEqual([{ name: 'describe', arguments: { subsystem: 'graph', op: 'graphPath' } }]);
  });

  it('refuses arguments it would send as some other call', async () => {
    const calls = await sent(async () => {
      for (const call of [
        { resource: 'graph', action: 'graphResolve', args: '{"entity":"a","relation":"b"}' },
        { resource: 'graph', action: 'graphResolve', args: ['a', 'b'] },
        { resource: 'graph', action: 'graphResolve', input: { entity: 'a', relation: 'b' } },
      ]) {
        const r = await hanzo().handler(call);
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.content[0].text!).error.code).toBe('INVALID_ARGS');
      }
    });
    expect(calls).toEqual([]);
  });
});

describe('the graph is on the surface', () => {
  // Every operation cloud's graph serves. The names are this test's claim; the
  // enum it is held against is cloud's generated catalog.
  const ops = [
    'graphAnswer', 'graphAssert', 'graphCommunities', 'graphDiff', 'graphErase',
    'graphExtract', 'graphIngest', 'graphNeighbors', 'graphPath', 'graphRead',
    'graphResolve', 'graphSearch', 'graphVocabulary',
  ];
  const graph = () => cloudTools.find((t) => t.name === 'graph')!;

  it('offers every graph operation in the graph tool', () => {
    expect(graph().inputSchema.properties.op.enum).toEqual(expect.arrayContaining(ops));
  });

  it('lists every graph operation as an action of the hanzo tool', async () => {
    const hanzo = getConfiguredTools({}).find((t) => t.name === 'hanzo')!;
    const r = await hanzo.handler({ resource: 'graph' });
    expect(JSON.parse(r.content[0].text!).data.actions).toEqual(expect.arrayContaining(ops));
  });

  it('sends an operation to the fleet as the graph tool, with its input', async () => {
    const input = { from: 'acme/svc/api', to: 'acme/team/core', as_of: '2026-09-01T00:00:00Z' };
    const want = { name: 'graph', arguments: { op: 'graphPath', input } };
    const hanzo = getConfiguredTools({}).find((t) => t.name === 'hanzo')!;
    const calls = await sent(async () => {
      await graph().handler({ op: 'graphPath', input });
      // The default surface reaches it through hanzo, and must send the same call.
      await hanzo.handler({ resource: 'graph', action: 'graphPath', args: input });
    });
    expect(calls).toEqual([want, want]);
  });
});

describe('a refusal is reported as one', () => {
  const key = process.env.HANZO_API_KEY;
  afterEach(() => {
    if (key === undefined) delete process.env.HANZO_API_KEY;
    else process.env.HANZO_API_KEY = key;
  });

  it('refuses without a credential rather than calling', async () => {
    delete process.env.HANZO_API_KEY;
    delete process.env.API_KEY;
    delete process.env.API_TOKEN;
    delete process.env.HANZO_TOKEN;
    const r = await cloudTools.find((t) => t.name === 'iam')!.handler({ op: 'get_iam_users' });
    expect(r.isError).toBe(true);
  });

  it("passes the fleet's own isError through instead of burying it in a body", async () => {
    // The failure this pins: wrapping the answer in a fresh envelope reports a
    // refusal as a success whose text happens to say it failed, which a client
    // acts on.
    process.env.HANZO_API_KEY = 'test-key';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'forbidden' }], isError: true },
        }),
    });
    const real = globalThis.fetch;
    (globalThis as any).fetch = fetchMock;
    try {
      const r = await cloudTools.find((t) => t.name === 'iam')!.handler({ op: 'get_iam_users' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe('forbidden');
    } finally {
      (globalThis as any).fetch = real;
    }
  });
});
