import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { 
  bashTool, 
  runCommandTool, 
  runBackgroundTool, 
  listProcessesTool, 
  getProcessOutputTool, 
  killProcessTool,
  shellTools 
} from '../../src/tools/shell.js';
import { 
  createTestFile, 
  readTestFile, 
  testFileExists, 
  cleanupTestFile,
  TEST_TEMP_DIR 
} from '../setup.js';
import * as path from 'path';

describe('Shell Tools', () => {
  // Store process IDs to clean up
  const processIds: string[] = [];

  afterEach(async () => {
    // Clean up any background processes created during tests
    for (const id of processIds) {
      try {
        await killProcessTool.handler({ id });
      } catch {
        // Process might already be dead
      }
    }
    processIds.length = 0;
  });
  
  describe('bashTool', () => {
    test('should have correct metadata', () => {
      expect(bashTool.name).toBe('bash');
      expect(bashTool.description).toBe('Execute a bash command');
      expect(bashTool.inputSchema.type).toBe('object');
      expect(bashTool.inputSchema.required).toContain('command');
    });

    test('should execute simple bash command', async () => {
      const result = await bashTool.handler({
        command: 'echo "Hello from shell"'
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Hello from shell');
    });

    test('should handle command with no output', async () => {
      const result = await bashTool.handler({
        command: 'true' // Command that succeeds but produces no output
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('Command completed with no output');
    });

    test('should capture stderr output', async () => {
      const result = await bashTool.handler({
        command: 'echo "error message" >&2'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('[stderr]');
      expect(output).toContain('error message');
    });

    test('should handle command that fails', async () => {
      const result = await bashTool.handler({
        command: 'exit 1'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error executing command');
    });

    test('should respect working directory', async () => {
      const result = await bashTool.handler({
        command: 'pwd',
        cwd: TEST_TEMP_DIR
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(TEST_TEMP_DIR);
    });

    test('should support environment variables', async () => {
      const result = await bashTool.handler({
        command: 'echo $TEST_VAR',
        env: { TEST_VAR: 'test_value' }
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('test_value');
    });

    test('should handle timeout', async () => {
      const result = await bashTool.handler({
        command: 'sleep 2',
        timeout: 100 // 100ms timeout
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error executing command');
    }, 5000);

    test('should handle commands that produce large output', async () => {
      const result = await bashTool.handler({
        command: 'for i in {1..100}; do echo "Line $i"; done'
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 100');
    });
  });

  describe('runCommandTool', () => {
    test('should have correct metadata', () => {
      expect(runCommandTool.name).toBe('run_command');
      expect(runCommandTool.description).toBe('Execute a shell command (alias for bash)');
    });

    test('should work identically to bashTool', async () => {
      const command = 'echo "test output"';
      
      const bashResult = await bashTool.handler({ command });
      const runResult = await runCommandTool.handler({ command });
      
      expect(bashResult.isError).toBe(runResult.isError);
      expect(bashResult.content[0].text).toBe(runResult.content[0].text);
    });
  });

  describe('runBackgroundTool', () => {
    test('should have correct metadata', () => {
      expect(runBackgroundTool.name).toBe('run_background');
      expect(runBackgroundTool.description).toBe('Run a command in the background');
      expect(runBackgroundTool.inputSchema.required).toEqual(['command', 'id']);
    });

    test('should start background process', async () => {
      const processId = 'test-bg-1';
      processIds.push(processId);
      
      const result = await runBackgroundTool.handler({
        command: 'sleep 2',
        id: processId
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Background process started');
      expect(result.content[0].text).toContain(processId);
      expect(result.content[0].text).toContain('PID:');
    });

    test('should prevent duplicate process IDs', async () => {
      const processId = 'test-duplicate';
      processIds.push(processId);
      
      // Start first process
      await runBackgroundTool.handler({
        command: 'sleep 1',
        id: processId
      });
      
      // Try to start second process with same ID
      const result = await runBackgroundTool.handler({
        command: 'sleep 1',
        id: processId
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already exists');
    });

    test('should support working directory for background process', async () => {
      const processId = 'test-bg-cwd';
      processIds.push(processId);
      
      // Create a test file to verify working directory
      await createTestFile('bg-test-dir/test.txt', 'test');
      const testDir = path.join(TEST_TEMP_DIR, 'bg-test-dir');
      
      const result = await runBackgroundTool.handler({
        command: 'pwd',
        id: processId,
        cwd: testDir
      });
      
      expect(result.isError).toBeFalsy();
      
      // Wait a bit and check output
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const outputResult = await getProcessOutputTool.handler({ id: processId });
      expect(outputResult.content[0].text).toContain(testDir);
    });
  });

  describe('listProcessesTool', () => {
    test('should have correct metadata', () => {
      expect(listProcessesTool.name).toBe('list_processes');
      expect(listProcessesTool.description).toBe('List running background processes');
    });

    test('should show no processes when none running', async () => {
      const result = await listProcessesTool.handler({});
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('No background processes running');
    });

    test('should list running background processes', async () => {
      const processId1 = 'test-list-1';
      const processId2 = 'test-list-2';
      processIds.push(processId1, processId2);
      
      // Start two background processes
      await runBackgroundTool.handler({
        command: 'sleep 3',
        id: processId1
      });
      
      await runBackgroundTool.handler({
        command: 'sleep 3',
        id: processId2
      });
      
      const result = await listProcessesTool.handler({});
      
      expect(result.isError).toBeFalsy();
      const processes = JSON.parse(result.content[0].text!);
      expect(Array.isArray(processes)).toBe(true);
      expect(processes.length).toBeGreaterThanOrEqual(2);
      
      const ids = processes.map((p: any) => p.id);
      expect(ids).toContain(processId1);
      expect(ids).toContain(processId2);
      
      processes.forEach((proc: any) => {
        expect(proc).toHaveProperty('id');
        expect(proc).toHaveProperty('pid');
        expect(proc).toHaveProperty('running');
        expect(typeof proc.pid).toBe('number');
        expect(typeof proc.running).toBe('boolean');
      });
    });
  });

  describe('getProcessOutputTool', () => {
    test('should have correct metadata', () => {
      expect(getProcessOutputTool.name).toBe('get_process_output');
      expect(getProcessOutputTool.description).toBe('Get output from a background process');
      expect(getProcessOutputTool.inputSchema.required).toContain('id');
    });

    test('should return error for non-existent process', async () => {
      const result = await getProcessOutputTool.handler({
        id: 'nonexistent-process'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No process found');
    });

    test('should get output from background process', async () => {
      const processId = 'test-output';
      processIds.push(processId);
      
      // Start process that produces output
      await runBackgroundTool.handler({
        command: 'echo "background output"',
        id: processId
      });
      
      // Wait for process to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const result = await getProcessOutputTool.handler({
        id: processId
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('background output');
    });

    test('should show no output for process with no output yet', async () => {
      const processId = 'test-no-output';
      processIds.push(processId);
      
      // Start long-running process with no immediate output
      await runBackgroundTool.handler({
        command: 'sleep 10',
        id: processId
      });
      
      const result = await getProcessOutputTool.handler({
        id: processId
      });
      
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('No output yet');
    });

    test('should respect tail parameter', async () => {
      const processId = 'test-tail';
      processIds.push(processId);
      
      // Start process that produces multiple lines
      await runBackgroundTool.handler({
        command: 'for i in {1..10}; do echo "Line $i"; done',
        id: processId
      });
      
      // Wait for process to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const result = await getProcessOutputTool.handler({
        id: processId,
        tail: 2
      });
      
      expect(result.isError).toBeFalsy();
      const output = result.content[0].text!;
      // Should only show last 2 lines
      expect(output).toContain('Line 9');
      expect(output).toContain('Line 10');
      expect(output).not.toContain('Line 1');
    });
  });

  describe('killProcessTool', () => {
    test('should have correct metadata', () => {
      expect(killProcessTool.name).toBe('kill_process');
      expect(killProcessTool.description).toBe('Kill a background process');
      expect(killProcessTool.inputSchema.required).toContain('id');
    });

    test('should return error for non-existent process', async () => {
      const result = await killProcessTool.handler({
        id: 'nonexistent-kill'
      });
      
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No process found');
    });

    test('should kill background process', async () => {
      const processId = 'test-kill';
      
      // Start long-running process
      await runBackgroundTool.handler({
        command: 'sleep 30',
        id: processId
      });
      
      // Verify process is listed
      let listResult = await listProcessesTool.handler({});
      let processes = JSON.parse(listResult.content[0].text!);
      expect(processes.some((p: any) => p.id === processId)).toBe(true);
      
      // Kill the process
      const killResult = await killProcessTool.handler({
        id: processId
      });
      
      expect(killResult.isError).toBeFalsy();
      expect(killResult.content[0].text).toContain('killed');
      
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify process is no longer listed
      listResult = await listProcessesTool.handler({});
      if (listResult.content[0].text !== 'No background processes running') {
        processes = JSON.parse(listResult.content[0].text!);
        expect(processes.some((p: any) => p.id === processId)).toBe(false);
      }
    });
  });

  describe('shellTools array', () => {
    test('should export all shell tools', () => {
      expect(shellTools).toHaveLength(6);
      expect(shellTools).toContain(bashTool);
      expect(shellTools).toContain(runCommandTool);
      expect(shellTools).toContain(runBackgroundTool);
      expect(shellTools).toContain(listProcessesTool);
      expect(shellTools).toContain(getProcessOutputTool);
      expect(shellTools).toContain(killProcessTool);
    });

    test('should have unique tool names', () => {
      const names = shellTools.map(tool => tool.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(shellTools.length);
    });

    test('should all have valid handler functions', () => {
      shellTools.forEach(tool => {
        expect(typeof tool.handler).toBe('function');
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeTruthy();
      });
    });
  });

  describe('Integration tests', () => {
    test('should handle complex shell workflow', async () => {
      // Create a test script file
      const scriptContent = `#!/bin/bash
echo "Starting script"
for i in {1..3}; do
  echo "Iteration $i"
  sleep 0.1
done
echo "Script completed"
`;
      
      const scriptPath = await createTestFile('test-script.sh', scriptContent);
      
      // Make script executable
      const chmodResult = await bashTool.handler({
        command: `chmod +x "${scriptPath}"`
      });
      expect(chmodResult.isError).toBeFalsy();
      
      // Run script in background
      const processId = 'test-script-bg';
      processIds.push(processId);
      
      const bgResult = await runBackgroundTool.handler({
        command: scriptPath,
        id: processId
      });
      expect(bgResult.isError).toBeFalsy();
      
      // Wait for script to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get output
      const outputResult = await getProcessOutputTool.handler({
        id: processId
      });
      expect(outputResult.isError).toBeFalsy();
      
      const output = outputResult.content[0].text!;
      expect(output).toContain('Starting script');
      expect(output).toContain('Iteration 1');
      expect(output).toContain('Iteration 2');
      expect(output).toContain('Iteration 3');
      expect(output).toContain('Script completed');
    });

    test('should handle file operations via shell commands', async () => {
      const testDir = path.join(TEST_TEMP_DIR, 'shell-file-ops');
      
      // Create directory via shell
      const mkdirResult = await bashTool.handler({
        command: `mkdir -p "${testDir}"`
      });
      expect(mkdirResult.isError).toBeFalsy();
      
      // Create file via shell
      const createResult = await bashTool.handler({
        command: `echo "Shell created file" > "${path.join(testDir, 'shell-file.txt')}"`
      });
      expect(createResult.isError).toBeFalsy();
      
      // List files via shell
      const listResult = await bashTool.handler({
        command: `ls "${testDir}"`
      });
      expect(listResult.isError).toBeFalsy();
      expect(listResult.content[0].text).toContain('shell-file.txt');
      
      // Read file via shell
      const readResult = await bashTool.handler({
        command: `cat "${path.join(testDir, 'shell-file.txt')}"`
      });
      expect(readResult.isError).toBeFalsy();
      expect(readResult.content[0].text).toContain('Shell created file');
    });
  });
});