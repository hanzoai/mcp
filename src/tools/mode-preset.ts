/**
 * Mode tool — single tool, action-routed mode/preset switching
 */

import { Tool } from '../types/index.js';
import { getAllRegisteredTools } from './tool-registry.js';

interface Mode { name: string; description: string; tools: string[]; skills?: string[]; prompt?: string; }
interface Preset { name: string; description: string; modes: string[]; skills: string[]; shortcuts?: Record<string, string>; }

export const DEFAULT_ENABLED_SKILLS = [
  'dev',
  'code-review',
  'ui',
  'hanzo-code',
  'hanzo-cloud',
  'xlsx',
  'pptx',
  'pdf',
  'docx',
];

const modes: Mode[] = [
  { name: 'developer', description: 'Senior Dev (Ponytail) + Thermo-Nuclear Code Review + Full Engineering', tools: ['*'], skills: ['dev', 'code-review', 'qa', 'cyber', 'it', 'data', 'sci', 'auto', 'hanzo-code', 'hanzo-cloud'] },
  { name: 'code-review', description: 'Thermo-nuclear code quality, Code Judo simplification, pstack blast-radius & runtime proof', tools: ['read', 'list', 'tree', 'grep', 'find', 'search', 'ast', 'bash', 'think'], skills: ['code-review', 'dev', 'qa', 'cyber'] },
  { name: 'designer', description: 'UI Design & Multi-Viewport Visual Parity (@hanzo/ui) + Creative Suite', tools: ['*'], skills: ['ui', 'des', 'art', 'mu', 'doc', 'edu', 'lang'] },
  { name: 'marketer', description: 'Product Marketing, Launch Strategy, CRO, SEO & Developer Community', tools: ['*'], skills: ['mark', 'com', 'art', 'doc', 'lang'] },
  { name: 'sales', description: 'MEDDPICC Sales, Revenue & Pricing, Support Triage & Customer Success', tools: ['*'], skills: ['sal', 'rev', 'su', 'cust', 'hanzo-commerce'] },
  { name: 'executive', description: 'CEO Strategy (Vi), Operations (Opera), Product (Mana) & People (Huma)', tools: ['*'], skills: ['vi', 'opera', 'mana', 'huma'] },
  { name: 'finance-legal', description: 'Finance, Procurement, Supply Chain, Corp Dev, Legal, Compliance, Risk, Audit & Office Suite', tools: ['*'], skills: ['fin', 'proc', 'supply', 'corp', 'law', 'comp', 'risk', 'audit', 'gov', 'xlsx', 'docx', 'pdf', 'pptx'] },
  { name: 'research', description: 'Research and exploration', tools: ['read', 'list', 'tree', 'grep', 'find', 'search', 'ast', 'think'], skills: ['sci', 'data', 'doc'] },
  { name: 'editor', description: 'Code editing', tools: ['read', 'write', 'edit', 'patch', 'create', 'delete', 'grep', 'ast'], skills: ['dev', 'code-review', 'ui'] },
  { name: 'terminal', description: 'Shell operations', tools: ['bash', 'bg', 'kill', 'ps', 'read'], skills: ['dev', 'it', 'auto'] },
  { name: 'cloud_admin', description: 'Cloud administration', tools: ['iam', 'kms', 'paas', 'commerce', 'storage', 'auth', 'api'], skills: ['hanzo-cloud', 'it', 'cyber', 'comp'] },
  { name: 'devops', description: 'DevOps', tools: ['read', 'write', 'edit', 'bash', 'paas', 'git', 'tasks'], skills: ['auto', 'it', 'cyber', 'hanzo-cloud'] },
  { name: 'minimal', description: 'Minimal', tools: ['read', 'write', 'edit', 'grep', 'bash'], skills: ['dev', 'code-review'] },
  { name: '10x', description: 'All tools and all 32 agent seat skills', tools: ['*'], skills: DEFAULT_ENABLED_SKILLS },
];

const presets: Preset[] = [
  { name: 'default', description: 'Default (9 Core Skills: dev, code-review, ui, hanzo-code, hanzo-cloud, xlsx, pptx, pdf, docx)', modes: ['developer', 'code-review'], skills: DEFAULT_ENABLED_SKILLS },
  { name: 'developer', description: 'Developer & Engineering Role Set (Seats 11–17)', modes: ['developer', 'code-review', 'devops'], skills: ['dev', 'code-review', 'qa', 'cyber', 'it', 'data', 'sci', 'auto', 'hanzo-code', 'hanzo-cloud'] },
  { name: 'designer', description: 'Designer & Creative Role Set (Seats 18–23)', modes: ['designer', 'editor'], skills: ['ui', 'des', 'art', 'mu', 'doc', 'edu', 'lang'] },
  { name: 'marketer', description: 'Marketer & Growth Role Set (Seats 6 & 10)', modes: ['marketer'], skills: ['mark', 'com', 'art', 'doc', 'lang'] },
  { name: 'sales', description: 'Sales, Revenue & Customer Role Set (Seats 5, 7, 8, 9)', modes: ['sales'], skills: ['sal', 'rev', 'su', 'cust', 'hanzo-commerce'] },
  { name: 'executive', description: 'Executive, Product & People Role Set (Seats 1–4)', modes: ['executive'], skills: ['vi', 'opera', 'mana', 'huma'] },
  { name: 'finance-legal', description: 'Finance, Legal & Governance Role Set (Seats 24–32)', modes: ['finance-legal'], skills: ['fin', 'proc', 'supply', 'corp', 'law', 'comp', 'risk', 'audit', 'gov', 'xlsx', 'docx', 'pdf', 'pptx'] },
  { name: 'minimal', description: 'Minimal (dev + code-review)', modes: ['research', 'editor'], skills: ['dev', 'code-review'] },
  { name: 'power', description: 'Power user', modes: ['developer', 'cloud_admin'], skills: DEFAULT_ENABLED_SKILLS },
  { name: 'cloud', description: 'Cloud admin', modes: ['cloud_admin', 'devops'], skills: ['hanzo-cloud', 'it', 'cyber', 'auto'] },
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
