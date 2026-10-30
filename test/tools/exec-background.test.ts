/**
 * exec's background path split the command string on spaces, so a quoted
 * argument or shell syntax ran as different words than the same command in
 * the foreground. Backgrounding now runs the string through the shell,
 * exactly like foreground exec.
 */

import { describe, test, expect } from '@jest/globals';
import { execSync } from 'child_process';
import { execTool } from '../../src/tools/unified/exec.js';

const body = (r: any) => JSON.parse(r.content[0].text);

describe('exec background commands', () => {
  test('quoted arguments survive backgrounding', async () => {
    const started = body(await execTool.handler({ action: 'exec', command: 'echo "hello world"', background: true }));
    expect(started.ok).toBe(true);
    const waited = body(await execTool.handler({ action: 'wait', proc_id: started.data.proc_id, timeout: 5000 }));
    expect(waited.data.exit_code).toBe(0);
    expect(waited.data.stdout).toBe('hello world\n');
  });

  test('shell operators work the same as foreground', async () => {
    const started = body(await execTool.handler({ action: 'exec', command: 'echo first && echo second', background: true }));
    expect(started.ok).toBe(true);
    const waited = body(await execTool.handler({ action: 'wait', proc_id: started.data.proc_id, timeout: 5000 }));
    expect(waited.data.exit_code).toBe(0);
    expect(waited.data.stdout).toBe('first\nsecond\n');
  });

  test('background and foreground agree on the same command', async () => {
    const fg = body(await execTool.handler({ action: 'exec', command: 'printf "a b\\n"' }));
    expect(fg.ok).toBe(true);
    const bg = body(await execTool.handler({ action: 'exec', command: 'printf "a b\\n"', background: true }));
    expect(bg.ok).toBe(true);
    const waited = body(await execTool.handler({ action: 'wait', proc_id: bg.data.proc_id, timeout: 5000 }));
    expect(waited.data.exit_code).toBe(0);
    expect(waited.data.stdout).toBe(fg.data.stdout);
  });

  test('kill terminates a backgrounded compound command, not just the shell', async () => {
    if (process.platform === 'win32') return; // process-group kill is POSIX-only
    const started = body(await execTool.handler({ action: 'exec', command: 'sleep 47 && echo done', background: true }));
    expect(started.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const killed = body(await execTool.handler({ action: 'kill', proc_id: started.data.proc_id }));
    expect(killed.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    // [s] trick: the pattern must not match the pgrep command line itself.
    const survivors = execSync('pgrep -f "[s]leep 47" || true').toString().trim();
    expect(survivors).toBe('');
  }, 15000);
});

