/**
 * hanzo — Unified Hanzo platform tool (HIP-0300)
 *
 * One tool for the Platform axis: `resource` names a fleet subsystem and
 * `action` one of its operations, whose arguments ride in `args`. The call is
 * the subsystem tool's own, `{op: action, input: args}`, the same shape the Rust
 * runtime sends (rust/src/tools/hanzo_tool.rs).
 */

import { Tool } from '../../types/index.js';

// The fleet's own subsystems, generated from cloud's typed operations.
import { cloudTools } from '../cloud.js';

// Derived, never listed: a subsystem the fleet gains is reachable here the day
// it is generated, and a name that stopped existing cannot be offered. `describe`
// is not a subsystem and takes no {op, input}, so it is not a resource.
const subsystems = cloudTools.filter(t => t.name !== 'describe');
const cloudToolMap = new Map(subsystems.map(t => [t.name, t]));
const RESOURCES = subsystems.map(t => t.name).sort();

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'hanzo', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'hanzo' } }, null, 2) }], isError: true };
}

export const hanzoTool: Tool = {
  name: 'hanzo',
  description:
    'Hanzo Cloud: resource names a subsystem, action one of its operations, args its arguments. ' +
    'No resource lists the subsystems; no action lists the resource\'s actions.',
  inputSchema: {
    type: 'object',
    properties: {
      resource: { type: 'string', enum: RESOURCES, description: 'The fleet subsystem to act on.' },
      action: { type: 'string', description: 'The operation to run.' },
      args: { type: 'object', description: "The operation's own arguments (alias: data)." },
    },
    required: []
  },
  handler: async ({ resource, action, args, data, ...rest }: any = {}) => {
    try {
      if (!resource) {
        return envelope({
          resources: RESOURCES,
          hint: 'Call hanzo(resource="graph") to see that resource\'s actions',
        }, 'list');
      }

      const tool = cloudToolMap.get(resource);
      if (!tool) return fail('NOT_FOUND', `Unknown resource: ${resource}. Available: ${RESOURCES.join(', ')}`);

      if (!action) {
        return envelope({
          resource,
          actions: tool.inputSchema.properties.op?.enum ?? [],
          hint: `Call hanzo(resource="${resource}", action="<action>", args={...})`,
        }, 'help');
      }

      // Top-level keys, then the bag: a caller may spell an argument either way.
      return await tool.handler({ op: action, input: { ...rest, ...data, ...args } });
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
