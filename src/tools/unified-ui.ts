/**
 * Unified UI Tool for Hanzo MCP
 * Single tool with methods for all UI component operations
 * Supports multiple frameworks and registries with Hanzo as default
 *
 * Local-first: when ~/work/hanzo/ui exists, reads directly from disk
 * for the hanzo framework. Falls back to GitHub API otherwise.
 */

import { Tool } from '../types/index.js';
import { GitHubAPIClient, FRAMEWORK_CONFIGS } from './ui-github-api.js';
import { LocalUIClient } from './ui-local-client.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Hanzo-first framework configurations
const HANZO_FRAMEWORKS: Record<string, { name: string; registry?: string; github: any }> = {
  // Hanzo implementations
  'hanzo': {
    name: 'Hanzo UI (React)',
    registry: 'https://ui.hanzo.ai/registry',
    github: {
      owner: 'hanzoai',
      repo: 'ui',
      branch: 'main',
      componentsPath: 'pkg/ui/primitives',
      blocksPath: 'pkg/ui/primitives',
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

// Local-first client for reading from ~/work/hanzo/ui
const localClient = new LocalUIClient();
const localAvailable = localClient.available;

if (localAvailable) {
  console.error('[ui] Local hanzo/ui repo detected, using local-first mode');
}

/** Use local client for hanzo frameworks when repo is available. */
function useLocal(framework: string): boolean {
  return framework.startsWith('hanzo') && localAvailable;
}

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

    let components: any[];
    let source: string;

    if (useLocal(framework)) {
      components = await localClient.listComponents(framework);
      source = 'local';
    } else {
      const client = getGitHubClient();
      components = await client.listComponents(framework);
      source = 'github';
    }

    let filtered = components;
    if (category) {
      filtered = components.filter((c: any) => c.category === category);
    }

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      source,
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

    // Try local first for hanzo frameworks
    if (useLocal(framework)) {
      try {
        const component = await localClient.fetchComponent(name, framework);
        return {
          framework: HANZO_FRAMEWORKS[framework]?.name || framework,
          component: name,
          source: component,
          backend: 'local'
        };
      } catch {
        // Fall through to GitHub
      }
    }

    const client = getGitHubClient();
    const component = await client.fetchComponent(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      source: component,
      backend: 'github'
    };
  },

  // Get component demo/examples
  async get_demo(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Component name is required');
    }

    if (useLocal(framework)) {
      try {
        const demo = await localClient.fetchComponentDemo(name, framework);
        return {
          framework: HANZO_FRAMEWORKS[framework]?.name || framework,
          component: name,
          demo,
          backend: 'local'
        };
      } catch {
        // Fall through to GitHub
      }
    }

    const client = getGitHubClient();
    const demo = await client.fetchComponentDemo(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      demo
    };
  },

  // Get component metadata
  async get_metadata(args: any) {
    const name = args.component || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Component name is required');
    }

    if (useLocal(framework)) {
      const metadata = await localClient.fetchComponentMetadata(name, framework);
      return {
        framework: HANZO_FRAMEWORKS[framework]?.name || framework,
        component: name,
        metadata
      };
    }

    const client = getGitHubClient();
    const metadata = await client.fetchComponentMetadata(name, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      component: name,
      metadata
    };
  },

  // List UI blocks
  async list_blocks(args: any) {
    const framework = args.framework || currentFramework;
    const category = args.category;

    let blocks: any[];
    let source: string;

    if (useLocal(framework)) {
      blocks = await localClient.listBlocks(framework);
      source = 'local';
    } else {
      const client = getGitHubClient();
      blocks = await client.listBlocks(framework);
      source = 'github';
    }

    let filtered = blocks;
    if (category) {
      filtered = blocks.filter((b: any) => b.category === category);
    }

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      source,
      total: filtered.length,
      blocks: filtered
    };
  },

  // Get block implementation
  async get_block(args: any) {
    const name = args.block || args.name;
    const framework = args.framework || currentFramework;

    if (!name) {
      throw new Error('Block name is required');
    }

    if (useLocal(framework)) {
      try {
        const block = await localClient.fetchBlock(name, framework);
        return {
          framework: HANZO_FRAMEWORKS[framework]?.name || framework,
          block: name,
          implementation: block,
          backend: 'local'
        };
      } catch {
        // Fall through to GitHub
      }
    }

    const client = getGitHubClient();
    const block = await client.fetchBlock(name, framework);

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

    if (useLocal(framework)) {
      const matches = await localClient.searchComponents(query);
      return {
        framework: HANZO_FRAMEWORKS[framework]?.name || framework,
        query,
        source: 'local',
        results: matches
      };
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
      query,
      source: 'github',
      results: matches
    };
  },

  // Get directory structure
  async get_structure(args: any) {
    const dirPath = args.path || '';
    const framework = args.framework || currentFramework;

    if (useLocal(framework)) {
      const structure = await localClient.getDirectoryStructure(dirPath, framework);
      return {
        framework: HANZO_FRAMEWORKS[framework]?.name || framework,
        path: dirPath || 'pkg/',
        source: 'local',
        structure
      };
    }

    const client = getGitHubClient();
    const structure = await client.getDirectoryStructure(dirPath, framework);

    return {
      framework: HANZO_FRAMEWORKS[framework]?.name || framework,
      path: dirPath || '/',
      source: 'github',
      structure
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
      localAvailable: localAvailable,
      available: Object.entries(HANZO_FRAMEWORKS).map(([key, config]) => ({
        key: key,
        name: config.name,
        hasRegistry: !!config.registry
      })),
      hanzoRegistryStatus: isHanzoRegistryLive ? 'online' : 'offline'
    };
  },

  // List all local UI packages
  async list_packages(args: any) {
    if (!localAvailable) {
      throw new Error('Local hanzo/ui repo not found. Set HANZO_UI_PATH or clone to ~/work/hanzo/ui');
    }

    const packages = await localClient.listPackages();
    return {
      source: 'local',
      total: packages.length,
      packages
    };
  },

  // Read any file from the UI repo by relative path
  async read_file(args: any) {
    const filePath = args.path || args.file;
    if (!filePath) {
      throw new Error('File path is required (relative to hanzo/ui root)');
    }

    if (!localAvailable) {
      throw new Error('Local hanzo/ui repo not found. Set HANZO_UI_PATH or clone to ~/work/hanzo/ui');
    }

    const content = await localClient.readFile(filePath);
    return {
      path: filePath,
      source: 'local',
      content
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
          'create_composition',
          'list_packages',
          'read_file'
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
      },
      file: {
        type: 'string',
        description: 'File path (for read_file, relative to hanzo/ui root)'
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
          output += `Local Repo: ${result.localAvailable ? 'available' : 'not found'}\n`;
          output += `Hanzo Registry: ${result.hanzoRegistryStatus}\n\n`;
          output += 'Available Frameworks:\n';
          for (const fw of result.available) {
            output += `• ${fw.key}: ${fw.name}`;
            if (fw.hasRegistry) output += ' [registry]';
            output += '\n';
          }
          break;

        case 'list_packages':
          output = `UI Packages (${result.total} total, local)\n\n`;
          for (const pkg of result.packages) {
            output += `• ${pkg.name}`;
            if (pkg.version) output += ` v${pkg.version}`;
            if (pkg.description) output += ` - ${pkg.description}`;
            output += '\n';
          }
          break;

        case 'read_file':
          output = `File: ${result.path}\n\n`;
          output += result.content;
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