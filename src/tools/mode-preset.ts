/**
 * Mode tool — single tool, action-routed mode/preset switching
 */

import { Tool } from '../types/index.js';
import { getAllRegisteredTools } from './tool-registry.js';

interface Mode { name: string; description: string; tools: string[]; prompt?: string; }
interface Preset { name: string; description: string; modes: string[]; shortcuts?: Record<string, string>; }

const modes: Mode[] = [
  { name: 'developer', description: 'Full development', tools: ['*'] },
  { name: 'research', description: 'Research and exploration', tools: ['read', 'list', 'tree', 'grep', 'find', 'search', 'ast', 'think'] },
  { name: 'editor', description: 'Code editing', tools: ['read', 'write', 'edit', 'patch', 'create', 'delete', 'grep', 'ast'] },
  { name: 'terminal', description: 'Shell operations', tools: ['bash', 'bg', 'kill', 'ps', 'read'] },
  { name: 'cloud_admin', description: 'Cloud administration', tools: ['iam', 'kms', 'paas', 'commerce', 'storage', 'auth', 'api'] },
  { name: 'devops', description: 'DevOps', tools: ['read', 'write', 'edit', 'bash', 'paas', 'git', 'tasks'] },
  { name: 'minimal', description: 'Minimal', tools: ['read', 'write', 'edit', 'grep', 'bash'] },
  { name: '10x', description: 'All tools', tools: ['*'] },
];

const presets: Preset[] = [
  { name: 'default', description: 'Default', modes: ['developer'] },
  { name: 'minimal', description: 'Minimal', modes: ['research', 'editor'] },
  { name: 'power', description: 'Power user', modes: ['developer', 'cloud_admin'] },
  { name: 'cloud', description: 'Cloud admin', modes: ['cloud_admin', 'devops'] },
];

let currentMode = modes[0];
let currentPreset = presets[0];

function toolsForMode(m: Mode): string[] {
  return m.tools.includes('*') ? getAllRegisteredTools().map(t => t.name) : m.tools;
}

export const modeTool: Tool = {
  name: 'mode',
  description: 'Mode/preset system: switch, list modes, select/list presets',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['switch', 'list', 'select_preset', 'list_presets', 'current'] },
      name: { type: 'string', description: 'Mode or preset name' },
      verbose: { type: 'boolean', default: false }
    },
    required: ['action']
  },
  handler: async (args) => {
    switch (args.action) {
      case 'switch': {
        if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
        const m = modes.find(x => x.name === args.name);
        if (!m) return { content: [{ type: 'text', text: `Mode '${args.name}' not found. Available: ${modes.map(x => x.name).join(', ')}` }], isError: true };
        currentMode = m;
        const tools = toolsForMode(m);
        return { content: [{ type: 'text', text: `Switched to ${m.name}: ${m.description} (${tools.length} tools)` }] };
      }
      case 'list':
        return { content: [{ type: 'text', text: modes.map(m => `${m.name}${m === currentMode ? ' *' : ''}: ${m.description}${args.verbose ? ` [${toolsForMode(m).length} tools]` : ''}`).join('\n') }] };
      case 'select_preset': {
        if (!args.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
        const p = presets.find(x => x.name === args.name);
        if (!p) return { content: [{ type: 'text', text: `Preset '${args.name}' not found. Available: ${presets.map(x => x.name).join(', ')}` }], isError: true };
        currentPreset = p;
        const m = modes.find(x => x.name === p.modes[0]);
        if (m) currentMode = m;
        return { content: [{ type: 'text', text: `Selected ${p.name}: ${p.description} (modes: ${p.modes.join(', ')})` }] };
      }
      case 'list_presets':
        return { content: [{ type: 'text', text: presets.map(p => `${p.name}${p === currentPreset ? ' *' : ''}: ${p.description} [${p.modes.join(', ')}]`).join('\n') }] };
      case 'current':
        return { content: [{ type: 'text', text: `Mode: ${currentMode.name}\nPreset: ${currentPreset.name}\nTools: ${toolsForMode(currentMode).length}` }] };
      default:
        return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true };
    }
  }
};

export const modePresetTools = [modeTool];
export const modeUtils = {
  getCurrentMode: () => currentMode,
  getCurrentPreset: () => currentPreset,
  getAvailableTools: () => toolsForMode(currentMode),
  isToolAvailable: (name: string) => toolsForMode(currentMode).includes(name),
};
