/**
 * npx, uvx and jq as python-sdk offers them: a package run is exec's argv
 * runner, backgrounded past its deadline into exec's process table; jq takes
 * its filter as one argv word.
 */

import { describe, test, expect } from '@jest/globals';
import { argv, npxTool, jqTool } from '../../src/tools/packages.js';
import { execTool, run } from '../../src/tools/unified/exec.js';

const body = (r: any) => JSON.parse(r.content[0].text);

describe('package runners', () => {
  test('argv matches python', () => {
    expect(argv('npx', { package: 'prettier', args: '--write  src/a.js' })).toEqual(['npx', '-y', 'prettier', '--write', 'src/a.js']);
    expect(argv('npx', { package: 'x', yes: false })).toEqual(['npx', 'x']);
    expect(argv('uvx', { package: 'ruff', args: 'check .', python: '3.12' })).toEqual(['uvx', '--python', '3.12', 'ruff', 'check', '.']);
    expect(() => argv('uvx', {})).toThrow('package required');
  });

  test('npx runs its argv', async () => {
    const r = body(await npxTool.handler({ package: '--version', yes: false }));
    expect(r.ok).toBe(true);
    expect(r.data.stdout.trim()).toMatch(/^\d/);
  });

  test('a run past its deadline keeps going under a proc_id exec can read', async () => {
    const started = body(await run('npx', ['sh', '-c', 'echo early; sleep 1; echo late'], undefined, 200));
    expect(started.data.status).toBe('running');
    const waited = body(await execTool.handler({ action: 'wait', proc_id: started.data.proc_id }));
    expect(waited.data).toMatchObject({ exit_code: 0, stdout: 'early\nlate\n' });
  });
});

describe('jq', () => {
  test('filters without a shell', async () => {
    const r: any = await jqTool.handler({ filter: '.items[] | select(.on != false) | .name', input: '{"items":[{"name":"a","on":true},{"name":"b","on":false}]}', raw: true });
    expect([r.content[0].text, r.isError]).toEqual(['a', undefined]);
    expect(((await jqTool.handler({ filter: '.', input: '{nope' })) as any).content[0].text).toMatch(/^Error: Invalid JSON input/);
    expect(((await jqTool.handler({ filter: '.' })) as any).content[0].text).toBe("Error: Either 'input' or 'file' is required");
  });
});
