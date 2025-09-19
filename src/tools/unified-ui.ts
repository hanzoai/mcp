/**
 * Unified UI Tool for Hanzo MCP
 * Single tool with methods for all UI component operations
 * Supports multiple frameworks and registries with Hanzo as default
 */

import { Tool } from '../types.js';
import { GitHubAPIClient, FRAMEWORK_CONFIGS } from './ui-github-api.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Hanzo-first framework configurations
const HANZO_FRAMEWORKS = {
  // Hanzo implementations
  'hanzo': {
    name: 'Hanzo UI (React)',
    registry: 'https://ui.hanzo.ai/registry',
    github: {
      owner: 'hanzoai',
      repo: 'ui',
      branch: 'main',
      componentsPath: 'packages/ui/src/components',
      blocksPath: 'packages/ui/src/blocks',
      extension: '.tsx'
    }
  },
  'hanzo-native': {
    name: 'Hanzo UI Native (React Native)',
    registry: 'https://ui.hanzo.ai/registry/native',
    github: {
      owner: 'hanzoai',
      repo: 'ui-native',
      branch: 'main',
      componentsPath: 'packages/native/src/components',
      extension: '.tsx'
    }
  },
  'hanzo-vue': {
    name: 'Hanzo UI Vue',
    registry: 'https://ui.hanzo.ai/registry/vue',
    github: {
      owner: 'hanzoai',
      repo: 'ui-vue',
      branch: 'main',
      componentsPath: 'packages/vue/src/components',
      extension: '.vue'
    }
  },
  'hanzo-svelte': {
    name: 'Hanzo UI Svelte',
    registry: 'https://ui.hanzo.ai/registry/svelte',
    github: {
      owner: 'hanzoai',
      repo: 'ui-svelte',
      branch: 'main',
      componentsPath: 'packages/svelte/src/components',
      extension: '.svelte'
    }
  },
  // External frameworks
  'shadcn': {
    name: 'shadcn/ui',
    registry: 'https://ui.shadcn.com/registry',
    github: FRAMEWORK_CONFIGS.react
  },
  'react': {
    name: 'shadcn/ui (React)',
    registry: 'https://ui.shadcn.com/registry',
    github: FRAMEWORK_CONFIGS.react
  },
  'svelte': {
    name: 'Svelte (shadcn)',
    github: FRAMEWORK_CONFIGS.svelte
  },
  'vue': {
    name: 'Vue (shadcn)',
    github: FRAMEWORK_CONFIGS.vue
  },
  'react-native': {
    name: 'React Native Reusables',
    github: FRAMEWORK_CONFIGS['react-native']
  }
};

// Current framework (default to Hanzo)
let currentFramework = 'hanzo';

// Cache for registry data
const registryCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get GitHub client for current framework
 */
function getGitHubClient(): GitHubAPIClient {
  return new GitHubAPIClient();
}

/**
 * Check if Hanzo registry is available
 */
async function checkHanzoRegistry(): Promise<boolean> {
  try {
    const response = await fetch('https://ui.hanzo.ai/registry/index.json');
    return response.ok;
  } catch {
    // Try alternate endpoints
    try {
      const response = await fetch('https://ui.hanzo.ai/api/registry');
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Method handlers for the unified UI tool
 */
const methodHandlers: Record<string, (args: any) => Promise<any>> = {
  // List available components
  async list_components(args: any) {
    const framework = args.framework || currentFramework;
    const category = args.category;

    const client = getGitHubClient();
    const components = await client.listComponents(framework);

    let filtered = components;
    if (category) {
      filtered = components.filter((c: any) => c.category === category);
    }

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      total: filtered.length,
      components: filtered
    };
  },

  // Get component details
  async get_component(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Component name is required');
    }

    const client = getGitHubClient();
    const component = await client.fetchComponent(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      source: component
    };
  },

  // Get component demo/examples
  async get_demo(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Component name is required');
    }

    const client = getGitHubClient();
    const demo = await client.fetchComponentDemo(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      demo: demo
    };
  },

  // Get component metadata
  async get_metadata(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Component name is required');
    }

    const client = getGitHubClient();
    const metadata = await client.fetchComponentMetadata(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      metadata: metadata
    };
  },

  // List UI blocks
  async list_blocks(args: any) {
    const framework = args.framework || currentFramework;
    const category = args.category;

    const client = getGitHubClient();
    const blocks = await client.listBlocks(framework);

    let filtered = blocks;
    if (category) {
      filtered = blocks.filter((b: any) => b.category === category);
    }

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      total: filtered.length,
      blocks: filtered
    };
  },

  // Get block implementation
  async get_block(args: any) {
    const name = args.block || args.name;
    const framework = args.framework || currentFramework;
    const includeFiles = args.include_files !== false;

    if (!name) {
      throw new Error('Block name is required');
    }

    const client = getGitHubClient();
    const block = await client.fetchBlock(name, framework, includeFiles);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      block: name,
      implementation: block
    };
  },

  // Search components
  async search(args: any) {
    const query = args.query || args.search;
    const framework = args.framework || currentFramework;

    if (!query) {
      throw new Error('Search query is required');
    }

    const client = getGitHubClient();
    const components = await client.listComponents(framework);

    const matches = components.filter((c: any) =>
      c.name?.toLowerCase().includes(query.toLowerCase()) ||
      c.description?.toLowerCase().includes(query.toLowerCase()) ||
      c.category?.toLowerCase().includes(query.toLowerCase())
    );

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      query: query,
      results: matches
    };
  },

  // Get directory structure
  async get_structure(args: any) {
    const path = args.path || '';
    const framework = args.framework || currentFramework;
    const depth = args.depth || 3;

    const client = getGitHubClient();
    const structure = await client.getDirectoryStructure(path, framework, depth);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      path: path || '/',
      structure: structure
    };
  },

  // Install component
  async install(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;
    const overwrite = args.overwrite || false;

    if (!name) {
      throw new Error('Component name is required');
    }

    let command = '';

    if (framework.startsWith('hanzo')) {
      // Use Hanzo CLI
      command = `npx @hanzo/ui add ${name}${overwrite ? ' --overwrite' : ''}`;
    } else if (framework === 'shadcn' || framework === 'react') {
      // Use shadcn CLI
      command = `npx shadcn@latest add ${name}${overwrite ? ' --overwrite' : ''}`;
    } else {
      throw new Error(`Installation not supported for framework: ${framework}`);
    }

    const { stdout, stderr } = await execAsync(command);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      command: command,
      output: stdout,
      warnings: stderr
    };
  },

  // Set current framework
  async set_framework(args: any) {
    const framework = args.framework;

    if (!framework) {
      throw new Error('Framework is required');
    }

    if (!HANZO_FRAMEWORKS[framework]) {
      throw new Error(`Unknown framework: ${framework}. Available: ${Object.keys(HANZO_FRAMEWORKS).join(', ')}`);
    }

    currentFramework = framework;

    return {
      success: true,
      framework: HANZO_FRAMEWORKS[framework].name,
      message: `Switched to ${HANZO_FRAMEWORKS[framework].name}`
    };
  },

  // Get current framework
  async get_framework(args: any) {
    const isHanzoRegistryLive = await checkHanzoRegistry();

    return {
      current: HANZO_FRAMEWORKS[currentFramework].name,
      framework: currentFramework,
      available: Object.entries(HANZO_FRAMEWORKS).map(([key, config]) => ({
        key: key,
        name: config.name,
        hasRegistry: !!config.registry
      })),
      hanzoRegistryStatus: isHanzoRegistryLive ? 'online' : 'offline'
    };
  },

  // Create composition
  async create_composition(args: any) {
    const name = args.name;
    const components = args.components || [];
    const description = args.description;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Composition name is required');
    }

    let code = `/**\n * ${name}\n`;
    if (description) {
      code += ` * ${description}\n`;
    }
    code += ` * Framework: ${HANZO_FRAMEWORKS[framework].name}\n`;
    code += ` * Components: ${components.join(', ')}\n`;
    code += ` */\n\n`;

    // Generate imports based on framework
    if (framework.startsWith('hanzo')) {
      for (const comp of components) {
        const pascalCase = comp.split('-').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        code += `import { ${pascalCase} } from "@hanzo/ui/${comp}"\n`;
      }
    } else if (framework === 'shadcn' || framework === 'react') {
      for (const comp of components) {
        const pascalCase = comp.split('-').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        code += `import { ${pascalCase} } from "@/components/ui/${comp}"\n`;
      }
    }

    // Generate component code
    code += `\nexport function ${name}() {\n`;
    code += `  return (\n`;
    code += `    <div className="container mx-auto p-6">\n`;

    // Add components
    for (const comp of components) {
      const pascalCase = comp.split('-').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
      code += `      <${pascalCase} />\n`;
    }

    code += `    </div>\n`;
    code += `  )\n`;
    code += `}\n`;

    return {
      framework: HANZO_FRAMEWORKS[framework].name,
      name: name,
      code: code,
      components: components
    };
  }
};

/**
 * Unified UI Tool - Single tool for all UI operations
 */
export const unifiedUITool: Tool = {
  name: 'ui',
  description: 'Unified tool for UI component operations - browse, search, install, and manage UI components from Hanzo and other registries',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'The operation to perform',
        enum: [
          'list_components',
          'get_component',
          'get_demo',
          'get_metadata',
          'list_blocks',
          'get_block',
          'search',
          'get_structure',
          'install',
          'set_framework',
          'get_framework',
          'create_composition'
        ]
      },
      // Common parameters
      framework: {
        type: 'string',
        description: 'UI framework to use (default: hanzo)',
        enum: Object.keys(HANZO_FRAMEWORKS)
      },
      component: {
        type: 'string',
        description: 'Component name (alias: name)'
      },
      name: {
        type: 'string',
        description: 'Component or block name (alias for component/block)'
      },
      block: {
        type: 'string',
        description: 'Block name'
      },
      category: {
        type: 'string',
        description: 'Filter by category'
      },
      query: {
        type: 'string',
        description: 'Search query (alias: search)'
      },
      search: {
        type: 'string',
        description: 'Search query (alias for query)'
      },
      path: {
        type: 'string',
        description: 'Directory path for structure'
      },
      depth: {
        type: 'number',
        description: 'Directory traversal depth (default: 3)'
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite existing files during installation'
      },
      include_files: {
        type: 'boolean',
        description: 'Include all files when fetching blocks (default: true)'
      },
      components: {
        type: 'array',
        description: 'List of components for composition',
        items: { type: 'string' }
      },
      description: {
        type: 'string',
        description: 'Description for composition'
      }
    },
    required: ['method']
  },
  handler: async (args: any) => {
    const method = args.method;

    if (!method) {
      return {
        content: [{
          type: 'text',
          text: 'Error: method is required. Available methods: ' + Object.keys(methodHandlers).join(', ')
        }],
        isError: true
      };
    }

    const handler = methodHandlers[method];

    if (!handler) {
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown method "${method}". Available methods: ${Object.keys(methodHandlers).join(', ')}`
        }],
        isError: true
      };
    }

    try {
      const result = await handler(args);

      // Format response based on method
      let output = '';

      switch (method) {
        case 'list_components':
          output = `📦 ${result.framework} Components (${result.total} total)\n\n`;
          for (const comp of result.components) {
            output += `• ${comp.name}`;
            if (comp.description) output += ` - ${comp.description}`;
            output += '\n';
          }
          break;

        case 'get_component':
          output = `📦 ${result.component} (${result.framework})\n\n`;
          output += '```tsx\n' + result.source + '\n```';
          break;

        case 'get_demo':
          output = `📦 ${result.component} Demo (${result.framework})\n\n`;
          output += '```tsx\n' + result.demo + '\n```';
          break;

        case 'get_metadata':
          output = `📦 ${result.component} Metadata (${result.framework})\n\n`;
          output += JSON.stringify(result.metadata, null, 2);
          break;

        case 'list_blocks':
          output = `🎨 ${result.framework} Blocks (${result.total} total)\n\n`;
          for (const block of result.blocks) {
            output += `• ${block.name}`;
            if (block.category) output += ` [${block.category}]`;
            output += '\n';
          }
          break;

        case 'search':
          output = `🔍 Search Results for "${result.query}" (${result.framework})\n\n`;
          if (result.results.length === 0) {
            output += 'No components found.';
          } else {
            for (const comp of result.results) {
              output += `• ${comp.name}`;
              if (comp.description) output += ` - ${comp.description}`;
              output += '\n';
            }
          }
          break;

        case 'install':
          output = `✅ Installed ${result.component} (${result.framework})\n\n`;
          output += `Command: ${result.command}\n`;
          if (result.output) output += `\nOutput:\n${result.output}`;
          break;

        case 'set_framework':
          output = result.message;
          break;

        case 'get_framework':
          output = `Current Framework: ${result.current}\n`;
          output += `Hanzo Registry: ${result.hanzoRegistryStatus}\n\n`;
          output += 'Available Frameworks:\n';
          for (const fw of result.available) {
            output += `• ${fw.key}: ${fw.name}`;
            if (fw.hasRegistry) output += ' [registry]';
            output += '\n';
          }
          break;

        default:
          output = JSON.stringify(result, null, 2);
      }

      return {
        content: [{
          type: 'text',
          text: output
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error in ${method}: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Export as default and named
export default unifiedUITool;