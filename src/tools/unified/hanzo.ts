/**
 * hanzo — Unified Hanzo platform tool (HIP-0300)
 *
 * One tool for the Platform axis.
 * resource + action two-level routing: iam, kms, paas, commerce, storage, auth, api
 *
 * Delegates to the existing cloud tool handlers.
 */

import { Tool } from '../../types/index.js';

// Import existing cloud tools for delegation
import { hanzoCloudTools } from '../hanzo-cloud.js';

const cloudToolMap = new Map(hanzoCloudTools.map(t => [t.name, t]));

const RESOURCES = ['iam', 'kms', 'paas', 'commerce', 'storage', 'auth', 'api'] as const;

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
      resource: { type: 'string', enum: [...RESOURCES], description: 'Platform resource (iam, kms, paas, commerce, storage, auth, api)' },
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
          resources: RESOURCES.map(r => r),
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
