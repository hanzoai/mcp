/**
 * The cloud surface is GENERATED, so what is asserted here is the generation —
 * that every subsystem the catalog names is offered, that nothing is offered
 * that the catalog does not name, and that the default surface did not grow.
 *
 * The last of those is the one worth having: the package collapses its catalog
 * into action-routed tools on purpose, so a change that quietly pushed 115 tools
 * into the default list would undo that without failing anything else.
 */

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

  it('reaches every subsystem through that one tool', () => {
    const hanzo = getConfiguredTools({}).find((t) => t.name === 'hanzo')!;
    expect(hanzo.inputSchema.properties.resource.enum).toEqual(cloudTools.map((t) => t.name).sort());
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
