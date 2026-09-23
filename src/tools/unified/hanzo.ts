/**
 * hanzo — Unified Hanzo platform tool (HIP-0300)
 *
 * One tool for the Platform axis: `resource` names a fleet subsystem and
 * `action` one of its operations, whose arguments ride in `args`. The call is
 * the subsystem tool's own, `{op: action, input: args}`, the same shape the Rust
 * runtime sends (rust/src/tools/hanzo_tool.rs). `describe` is a resource too:
 * its args are `{subsystem, op}`, and it answers what that operation takes.
 */

import { Tool } from '../../types/index.js';

// The fleet's own subsystems, generated from cloud's typed operations.
import { cloudTools } from '../cloud.js';

// Derived, never listed: a subsystem the fleet gains is reachable here the day
// it is generated, and a name that stopped existing cannot be offered.
const cloudToolMap = new Map(cloudTools.map(t => [t.name, t]));
const RESOURCES = cloudTools.map(t => t.name).sort();

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
    'No resource lists the subsystems; no action lists the resource\'s actions; ' +
    'resource "describe" with args {subsystem, op} says what an operation takes.',
  inputSchema: {
    type: 'object',
    properties: {
      resource: { type: 'string', enum: RESOURCES, description: 'The fleet subsystem to act on, or describe.' },
      action: { type: 'string', description: 'The operation to run.' },
      args: { type: 'object', description: "The operation's own arguments." },
    },
    required: []
  },
  handler: async ({ resource, action, args = {}, ...stray }: any = {}) => {
    try {
      if (!resource) {
        return envelope({
          resources: RESOURCES,
          hint: 'Call hanzo(resource="graph") to see that resource\'s actions',
        }, 'list');
      }

      const tool = cloudToolMap.get(resource);
      if (!tool) return fail('NOT_FOUND', `Unknown resource: ${resource}. Available: ${RESOURCES.join(', ')}`);

      // One object, in args. A string or a key beside it would reach the fleet
      // as some other call.
      const extra = Object.keys(stray);
      if (extra.length || typeof args !== 'object' || args === null || Array.isArray(args)) {
        return fail('INVALID_ARGS', `Pass the arguments as one object in args${extra.length ? `, not in ${extra.join(', ')}` : ''}.`);
      }

      if (resource === 'describe') return await tool.handler(args);

      if (!action) {
        return envelope({
          resource,
          actions: tool.inputSchema.properties.op?.enum ?? [],
          hint: `Call hanzo(resource="describe", args={subsystem: "${resource}", op: "<action>"}) to read what one takes, ` +
            `then hanzo(resource="${resource}", action="<action>", args={...})`,
        }, 'help');
      }

      return await tool.handler({ op: action, input: args });
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  }
};
