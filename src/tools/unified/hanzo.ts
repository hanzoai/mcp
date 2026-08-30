/**
 * hanzo — Unified Hanzo platform tool (HIP-0300)
 *
 * One tool for the Platform axis.
 * resource + action two-level routing: iam, kms, paas, commerce, storage, auth, api
 *
 * Delegates to the existing cloud tool handlers.
 */

import { Tool } from '../../types/index.js';

// The fleet's own subsystems, generated from cloud's typed operations.
import { cloudTools } from '../cloud.js';

const cloudToolMap = new Map(cloudTools.map(t => [t.name, t]));

// Derived, never listed: a subsystem the fleet gains is reachable here the day
// it is generated, and a name that stopped existing cannot be offered.
const RESOURCES = cloudTools.map(t => t.name).sort();

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'hanzo', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'hanzo' } }, null, 2) }], isError: true };
}

export const hanzoTool: Tool = {
  name: 'hanzo',
  description: 'Hanzo platform: iam, kms, paas, commerce, storage, auth, api — specify resource to see actions',
  inputSchema: {
    type: 'object',
    properties: {
      resource: { type: 'string', enum: RESOURCES, description: 'The fleet subsystem to act on.' },
      action: { type: 'string', description: 'Resource action' },
      // Pass-through params for cloud tools
      id: { type: 'string' },
      data: { type: 'object' },
      query: { type: 'string' },
      method: { type: 'string' },
      path: { type: 'string' },
      body: { type: 'object' },
      // Commerce sub-routing
      sub_resource: { type: 'string' },
      // General
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    required: []
  },
  handler: async (args) => {
    try {
      // No resource — show available resources
      if (!args.resource) {
        return envelope({
          resources: RESOURCES,
          hint: 'Call hanzo(resource="iam") to see available actions for that resource',
        }, 'list');
      }

      // Find the matching cloud tool
      const tool = cloudToolMap.get(args.resource);
      if (!tool) return fail('NOT_FOUND', `Unknown resource: ${args.resource}. Available: ${RESOURCES.join(', ')}`);

      // Delegate to the existing cloud tool handler with all args forwarded
      return await tool.handler(args);
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
