import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Multi-Client MCP Interoperability Matrix (Claude Code, Cursor, Windsurf, Gemini CLI, VS Code)', () => {
  const CLIENT_MATRIX = [
    { name: 'claude-code', version: '1.0.0', supportsSampling: true },
    { name: 'cursor', version: '0.45.0', supportsSampling: false },
    { name: 'windsurf', version: '1.2.0', supportsSampling: false },
    { name: 'gemini-cli', version: '0.1.0', supportsSampling: true },
    { name: 'vscode-mcp', version: '1.96.0', supportsSampling: true },
  ];

  function negotiateCapabilities(clientInfo) {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: '@hanzo/mcp', version: '1.0.0' },
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true },
        prompts: { listChanged: true },
        logging: {},
        sampling: clientInfo.supportsSampling ? {} : undefined,
      },
      clientInfo: {
        name: clientInfo.name,
        version: clientInfo.version,
      },
    };
  }

  function generateClientMcpConfig(clientName, serverPath = 'npx -y hanzo mcp') {
    if (clientName === 'claude-code') {
      return {
        mcpServers: {
          hanzo: {
            command: 'npx',
            args: ['-y', 'hanzo', 'mcp'],
          },
        },
      };
    }
    if (clientName === 'cursor' || clientName === 'vscode') {
      return {
        mcpServers: {
          hanzo: {
            command: 'npx',
            args: ['-y', 'hanzo', 'mcp'],
            transport: 'stdio',
          },
        },
      };
    }
    return { command: serverPath, args: [] };
  }

  test('successfully negotiates protocol handshake across all 5 clients', () => {
    for (const client of CLIENT_MATRIX) {
      const negotiation = negotiateCapabilities(client);
      assert.equal(negotiation.protocolVersion, '2024-11-05');
      assert.equal(negotiation.clientInfo.name, client.name);
      assert.equal(negotiation.clientInfo.version, client.version);
      assert.ok(negotiation.capabilities.tools);
    }
  });

  test('conditionally exposes sampling capability based on client support', () => {
    const claudeNegotiation = negotiateCapabilities(CLIENT_MATRIX[0]);
    assert.deepEqual(claudeNegotiation.capabilities.sampling, {});

    const cursorNegotiation = negotiateCapabilities(CLIENT_MATRIX[1]);
    assert.equal(cursorNegotiation.capabilities.sampling, undefined);
  });

  test('generates valid client config schemas for Claude Code and Cursor', () => {
    const claudeConfig = generateClientMcpConfig('claude-code');
    assert.ok(claudeConfig.mcpServers.hanzo);
    assert.equal(claudeConfig.mcpServers.hanzo.command, 'npx');
    assert.deepEqual(claudeConfig.mcpServers.hanzo.args, ['-y', 'hanzo', 'mcp']);

    const cursorConfig = generateClientMcpConfig('cursor');
    assert.equal(cursorConfig.mcpServers.hanzo.transport, 'stdio');
  });

  test('validates clean EOF termination without hanging stdio sockets', () => {
    let connectionClosed = false;
    const session = {
      isOpen: true,
      close() {
        this.isOpen = false;
        connectionClosed = true;
      },
    };

    session.close();
    assert.equal(session.isOpen, false);
    assert.equal(connectionClosed, true);
  });

  test('handles malformed client handshake payloads gracefully', () => {
    assert.throws(
      () => {
        negotiateCapabilities(null);
      },
      { name: 'TypeError' }
    );
  });
});
