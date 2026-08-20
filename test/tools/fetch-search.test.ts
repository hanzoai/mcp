import { fetchTool } from '../../src/tools/unified/fetch.js';

/**
 * The regression these pin is BLINDNESS RENDERED AS EMPTINESS.
 *
 * `fetch:search` used to scrape html.duckduckgo.com and pull results out with a
 * regex. Measured 2026-08-20 that page answers HTTP 202 (an anti-bot challenge)
 * and carries no `result__title`, so the regex matched nothing and the tool
 * reported `{results: [], count: 0}` — the same answer it gives for a query the
 * web genuinely has nothing for. A caller could not tell the two apart, which is
 * the whole reason it went unnoticed.
 *
 * So the assertions are about the SHAPE OF A FAILURE, not about search quality:
 * when we cannot search, the tool must say so.
 */
function body(res: any) {
  return JSON.parse(res.content[0].text);
}

const KEYS = ['HANZO_API_KEY', 'API_KEY', 'API_TOKEN', 'HANZO_TOKEN', 'API_URL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('fetch:search', () => {
  it('refuses loudly with no credential, instead of reporting zero results', async () => {
    const res: any = await fetchTool.handler({ action: 'search', query: 'anything' });
    expect(res.isError).toBe(true);
    const b = body(res);
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('NO_CREDENTIAL');
    // The failure must never be mistakable for a successful empty search.
    expect(b.data).toBeNull();
  });

  it('still requires a query', async () => {
    process.env.HANZO_API_KEY = 'sk-test';
    const res: any = await fetchTool.handler({ action: 'search' });
    expect(res.isError).toBe(true);
    expect(body(res).error.code).toBe('INVALID_PARAMS');
  });

  it("passes cloud's own refusal through verbatim rather than flattening it", async () => {
    process.env.HANZO_API_KEY = 'sk-test';
    process.env.API_URL = 'https://api.example.invalid';
    const spy = jest.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"status":401,"error":"sign in to search the web"}',
    } as any);
    try {
      const res: any = await fetchTool.handler({ action: 'search', query: 'q' });
      expect(res.isError).toBe(true);
      const b = body(res);
      expect(b.error.code).toBe('SEARCH_FAILED');
      expect(b.error.message).toContain('401');
      expect(b.error.message).toContain('sign in to search the web');
    } finally {
      spy.mockRestore();
    }
  });

  it('asks OUR api, and maps its envelope', async () => {
    process.env.HANZO_API_KEY = 'sk-test';
    process.env.API_URL = 'https://api.example.invalid';
    const seen: any = {};
    const spy = jest.spyOn(globalThis, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
      seen.url = String(url);
      seen.auth = init?.headers?.Authorization;
      seen.body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            query: 'q',
            number_of_results: 2,
            engines: ['bing', 'mojeek'],
            results: [{ url: 'https://a.example', title: 'A', content: 'snippet a' }],
          }),
      } as any;
    });
    try {
      const res: any = await fetchTool.handler({ action: 'search', query: 'q' });
      expect(seen.url).toBe('https://api.example.invalid/v1/websearch');
      expect(seen.auth).toBe('Bearer sk-test');
      expect(seen.body).toEqual({ q: 'q' });
      const b = body(res);
      expect(b.ok).toBe(true);
      expect(b.data.results).toEqual([{ url: 'https://a.example', title: 'A', snippet: 'snippet a' }]);
      // Which engines answered: an empty result WITH engines is a real empty,
      // one with none is a search that never happened.
      expect(b.data.engines).toEqual(['bing', 'mojeek']);
    } finally {
      spy.mockRestore();
    }
  });
});
