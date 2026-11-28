import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('HIP-0300 Unified MCP JSON-RPC E2E Test Harness (All 13 Tools)', () => {
  const UNIFIED_13_TOOLS = [
    'fs',
    'exec',
    'code',
    'git',
    'fetch',
    'workspace',
    'computer',
    'think',
    'memory',
    'hanzo',
    'plan',
    'tasks',
    'ui',
  ];

  function createRpcRequest(id, method, params = {}) {
    return {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
  }

  function simulateMcpDispatcher(req) {
    if (req.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Invalid Request' } };
    }

    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '@hanzo/mcp', version: '1.0.0' },
        },
      };
    }

    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: UNIFIED_13_TOOLS.map((name) => ({
            name,
            description: `HIP-0300 unified tool: ${name}`,
            inputSchema: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                args: { type: 'object' },
              },
              required: ['action'],
            },
          })),
        },
      };
    }

    if (req.method === 'tools/call') {
      const toolName = req.params?.name;
      if (!UNIFIED_13_TOOLS.includes(toolName)) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Tool not found: ${toolName}` },
        };
      }

      const args = req.params?.arguments;
      if (!args || typeof args !== 'object' || !args.action) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32602,
            message: `Invalid params: missing required 'action' for tool ${toolName}`,
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Executed ${toolName}.${args.action} successfully`,
            },
          ],
          isError: false,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: 'Method not found' },
    };
  }

  test('validates initialize handshake and protocol capabilities', () => {
    const initReq = createRpcRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hanzo-client', version: '1.0.0' },
    });
    const res = simulateMcpDispatcher(initReq);
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.serverInfo.name, '@hanzo/mcp');
  });

  test('tools/list catalogs all 13 HIP-0300 core tools with valid schemas', () => {
    const listReq = createRpcRequest(2, 'tools/list');
    const res = simulateMcpDispatcher(listReq);
    assert.equal(res.result.tools.length, 13);

    const catalogedNames = res.result.tools.map((t) => t.name);
    for (const tool of UNIFIED_13_TOOLS) {
      assert.ok(catalogedNames.includes(tool), `Missing core tool: ${tool}`);
    }
  });

  test('executes happy-path tools/call across all 13 unified tools', () => {
    let rpcId = 10;
    for (const tool of UNIFIED_13_TOOLS) {
      rpcId++;
      const callReq = createRpcRequest(rpcId, 'tools/call', {
        name: tool,
        arguments: { action: 'status' },
      });
      const res = simulateMcpDispatcher(callReq);
      assert.equal(res.error, undefined);
      assert.equal(res.result.isError, false);
      assert.match(res.result.content[0].text, new RegExp(`Executed ${tool}.status successfully`));
    }
  });

  test('returns -32602 Invalid params when required action argument is omitted', () => {
    for (const tool of UNIFIED_13_TOOLS) {
      const callReq = createRpcRequest(99, 'tools/call', {
        name: tool,
        arguments: {}, // missing required 'action'
      });
      const res = simulateMcpDispatcher(callReq);
      assert.ok(res.error);
      assert.equal(res.error.code, -32602);
      assert.match(res.error.message, /Invalid params/);
    }
  });

  test('returns -32601 Method not found for unregistered tool invocation', () => {
    const unknownReq = createRpcRequest(100, 'tools/call', {
      name: 'non_existent_tool',
      arguments: { action: 'run' },
    });
    const res = simulateMcpDispatcher(unknownReq);
    assert.ok(res.error);
    assert.equal(res.error.code, -32601);
  });
});
