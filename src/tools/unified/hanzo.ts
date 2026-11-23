/**
 * hanzo — Unified Hanzo Cloud platform router (HIP-0300).
 *
 * Absorbs `auth`, `vault` (`kms` / `vault`), and `connectors` (`connection`),
 * alongside `describe` and all 120+ generated `catalog.json` fleet subsystems.
 */

import { Tool } from '../../types/index.js';
import { cloudTools } from '../cloud.js';
import { connectorsTool } from '../connectors.js';
import { vaultTool } from '../vault.js';

const cloudToolMap = new Map(cloudTools.map((t) => [t.name, t]));
const VAULT_ACTIONS = ['status', 'list', 'seal', 'sync_lastpass', 'totp', 'browser_login'];
const CONNECTOR_ACTIONS = ['list', 'request', 'view', 'act', 'configure'];
const AUTH_ACTIONS = ['whoami', 'status', 'list'];

const RESOURCES = [...new Set(['auth', 'vault', 'connectors', ...cloudTools.map((t) => t.name)])].sort();

function envelope(data: any, action: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data, error: null, meta: { tool: 'hanzo', action } }, null, 2) }] };
}

function fail(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, data: null, error: { code, message }, meta: { tool: 'hanzo' } }, null, 2) }], isError: true };
}

function keyPrefix(k: string): string {
  if (k.startsWith('sk-')) return 'sk-…';
  if (k.startsWith('pk-')) return 'pk-…';
  return '…';
}

export const hanzoTool: Tool = {
  name: 'hanzo',
  description:
    'Hanzo Cloud platform router: resource names a subsystem (auth, iam, kms/vault, connectors, platform, compute, billing, s3, social, and all 120+ fleet services), action one of its operations, args its arguments. ' +
    'No resource lists the subsystems; no action lists the resource\'s actions; ' +
    'resource "describe" with args {subsystem, op} says what an operation takes.',
  inputSchema: {
    type: 'object',
    properties: {
      resource: { type: 'string', enum: RESOURCES, description: 'The fleet subsystem to act on (alias: service), or describe.' },
      service: { type: 'string', description: 'Alias for resource.' },
      action: { type: 'string', description: 'The operation to run.' },
      args: { type: 'object', description: "The operation's own arguments." },
    },
    required: [],
  },
  handler: async ({ resource, service, action, args = {}, ...stray }: any = {}) => {
    try {
      const target = String(resource ?? service ?? '').trim();
      if (!target) {
        return envelope(
          {
            resources: RESOURCES,
            hint: 'Call hanzo(resource="graph") to see that resource\'s actions',
          },
          'list',
        );
      }

      const normalized = target.toLowerCase() === 'connection' ? 'connectors' : target;

      if (normalized === 'auth') {
        if (!action) {
          return envelope({ resource: 'auth', actions: AUTH_ACTIONS }, 'help');
        }
        const envKey = (
          process.env.HANZO_API_KEY ||
          process.env.HANZO_USER_KEY ||
          process.env.API_KEY ||
          process.env.HANZO_TOKEN ||
          ''
        ).trim();
        return envelope(
          {
            authenticated: Boolean(envKey),
            source: envKey ? 'env' : null,
            ...(envKey ? { key: keyPrefix(envKey) } : {}),
          },
          action,
        );
      }

      if (normalized === 'vault' || (normalized === 'kms' && action && VAULT_ACTIONS.includes(action))) {
        if (!action) {
          return envelope({ resource: 'vault', actions: VAULT_ACTIONS }, 'help');
        }
        return vaultTool.handler({ ...(typeof args === 'object' && args ? args : {}), action });
      }

      if (normalized === 'connectors') {
        if (!action) {
          return envelope({ resource: 'connectors', actions: CONNECTOR_ACTIONS }, 'help');
        }
        return connectorsTool.handler({ ...(typeof args === 'object' && args ? args : {}), action });
      }

      const tool = cloudToolMap.get(normalized);
      if (!tool) return fail('NOT_FOUND', `Unknown resource: ${target}. Available: ${RESOURCES.join(', ')}`);

      const extra = Object.keys(stray);
      if (extra.length || typeof args !== 'object' || args === null || Array.isArray(args)) {
        return fail('INVALID_ARGS', `Pass the arguments as one object in args${extra.length ? `, not in ${extra.join(', ')}` : ''}.`);
      }

      if (normalized === 'describe') return await tool.handler(args);

      if (!action) {
        return envelope(
          {
            resource: normalized,
            actions: tool.inputSchema.properties.op?.enum ?? [],
            hint:
              `Call hanzo(resource="describe", args={subsystem: "${normalized}", op: "<action>"}) to read what one takes, ` +
              `then hanzo(resource="${normalized}", action="<action>", args={...})`,
          },
          'help',
        );
      }

      return await tool.handler({ op: action, input: args });
    } catch (error: any) {
      return fail('ERROR', error.message);
    }
  },
};
