/**
 * Unified UI Tool for Hanzo MCP
 * Consolidates all UI operations into a single tool with method-based routing
 */

import { Tool, ToolResult } from '../types/index.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  registrySchema,
  Registry,
  RegistryItem
} from './registry-types.js';
import {
  fetchRegistry,
  getRegistryItem,
  getRegistryItemUrl
} from './registry-api.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Cache for registry data
let registryCache: Registry | null = null;
let registryCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Supported frameworks for multi-framework operations
const FRAMEWORKS = ['react', 'vue', 'svelte', 'react-native'] as const;
type Framework = typeof FRAMEWORKS[number];

/**
 * Fetches and caches the registry
 */
async function getRegistry(): Promise<Registry> {
  const now = Date.now();
  if (registryCache && now - registryCacheTime < CACHE_DURATION) {
    return registryCache;
  }

  try {
    const registryUrl = process.env.REGISTRY_URL || "https://ui.hanzo.ai/registry/registry.json";
    const [registryJson] = await fetchRegistry([registryUrl], {
      useCache: false,
    });
    registryCache = registrySchema.parse(registryJson);
    registryCacheTime = now;
    return registryCache;
  } catch (error) {
    console.error("Failed to fetch registry:", error);
    return registryCache || { name: "hanzo-ui", items: [] };
  }
}

/**
 * Get the source code of a component from the registry
 */
async function getComponentSource(componentName: string): Promise<string | null> {
  try {
    const registryUrl = process.env.REGISTRY_URL || "https://ui.hanzo.ai/registry/registry.json";
    const itemUrl = getRegistryItemUrl(componentName, registryUrl);
    const component = await getRegistryItem(itemUrl, "");

    if (component && component.files && component.files.length > 0) {
      const mainFile = component.files.find(f => f.type === "registry:ui") || component.files[0];
      return mainFile.content || null;
    }
  } catch (error) {
    console.error(`Failed to get component source for ${componentName}:`, error);
  }
  return null;
}

// Helper functions for multi-framework support
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getFileExtension(framework: Framework): string {
  const extensions = {
    'react': 'tsx',
    'vue': 'vue',
    'svelte': 'svelte',
    'react-native': 'tsx',
  };
  return extensions[framework];
}

/**
 * Method handlers for each UI operation
 */
const methodHandlers: Record<string, (args: any) => Promise<ToolResult>> = {
  /**
   * Initialize a new project with Hanzo UI
   */
  async init(args: any): Promise<ToolResult> {
    const style = args.style || 'default';

    const content = `# Initialize Hanzo UI Project

To initialize a new project with Hanzo UI:

## Step 1: Initialize your project
\`\`\`bash
npx @hanzo/ui@latest init
\`\`\`

This will:
- Install dependencies (tailwindcss-animate, class-variance-authority, clsx, tailwind-merge)
- Configure Tailwind CSS
- Set up the project structure
- Add the cn() utility function
- Configure component path aliases

## Step 2: Choose your style
The initialization will prompt you to choose a style:
- **default**: Standard shadcn/ui styling
- **new-york**: Alternative styling with different aesthetics

Selected style: **${style}**

## Step 3: Start adding components
After initialization, you can add components:
\`\`\`bash
npx @hanzo/ui@latest add button card dialog
\`\`\`

Your project is ready for Hanzo UI components!`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * List all available components
   */
  async list_components(args: any): Promise<ToolResult> {
    const registry = await getRegistry();
    const typeFilter = args.type;
    const categoryFilter = args.category;

    let components = registry.items.filter(item => item.type.includes("ui:"));

    if (typeFilter) {
      components = components.filter(item => item.type.includes(typeFilter));
    }

    if (categoryFilter) {
      components = components.filter(item => item.category === categoryFilter);
    }

    const grouped = components.reduce((acc, item) => {
      const category = item.category || "Uncategorized";
      if (!acc[category]) acc[category] = [];
      acc[category].push(item);
      return acc;
    }, {} as Record<string, RegistryItem[]>);

    let content = "# Hanzo UI Components\\n\\n";

    if (components.length === 0) {
      content += "No components found";
      if (typeFilter) content += ` with type '${typeFilter}'`;
      if (categoryFilter) content += ` in category '${categoryFilter}'`;
      content += ".\\n";
    } else {
      for (const [category, items] of Object.entries(grouped)) {
        content += `## ${category}\\n\\n`;
        for (const item of items) {
          content += `### ${item.name}\\n`;
          content += `${item.description || 'No description'}\\n\\n`;
          content += `**Command:** \`npx @hanzo/ui@latest add ${item.name}\`\\n\\n`;
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Get detailed information about a component
   */
  async get_component(args: any): Promise<ToolResult> {
    const name = args.name || args.component;
    const registry = await getRegistry();
    const component = registry.items.find(item => item.name === name);

    if (!component) {
      return {
        content: [{
          type: 'text',
          text: `Component '${name}' not found in registry`
        }],
        isError: true
      };
    }

    let content = `# ${component.name}\\n\\n`;
    content += `${component.description || 'No description'}\\n\\n`;

    if (component.category) {
      content += `**Category:** ${component.category}\\n\\n`;
    }

    if (component.dependencies && component.dependencies.length > 0) {
      content += `## NPM Dependencies\\n\\n`;
      component.dependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }

    if (component.registryDependencies && component.registryDependencies.length > 0) {
      content += `## Required Components\\n\\n`;
      component.registryDependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }

    content += `## Installation\\n\\n`;
    content += `\`\`\`bash\\n`;
    content += `npx ${config.package}@latest add ${name}\\n`;
    content += `\`\`\`\\n\\n`;

    if (component.files && component.files.length > 0) {
      content += `## Files\\n\\n`;
      component.files.forEach(file => {
        content += `- \`${file.path}\` (${file.type})\\n`;
      });
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Get component source code
   */
  async get_source(args: any): Promise<ToolResult> {
    const name = args.name || args.component;
    const source = await getComponentSource(name);

    if (!source) {
      return {
        content: [{
          type: 'text',
          text: `Could not find source code for component '${name}'`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: `# Source Code: ${name}\\n\\n\`\`\`tsx\\n${source}\\n\`\`\``
      }]
    };
  },

  /**
   * Get demo/example for a component
   */
  async get_demo(args: any): Promise<ToolResult> {
    const name = args.name || args.component;
    const registry = await getRegistry();
    const component = registry.items.find(item => item.name === name);

    if (!component) {
      return {
        content: [{
          type: 'text',
          text: `Component '${name}' not found`
        }],
        isError: true
      };
    }

    let demo = `# ${name} Demo\\n\\n\`\`\`tsx\\n`;
    demo += `import { ${capitalize(name)} } from "@/components/ui/${name}"\\n\\n`;
    demo += `export default function ${capitalize(name)}Demo() {\\n`;
    demo += `  return (\\n`;
    demo += `    <div className="space-y-4">\\n`;

    if (name === "button") {
      demo += `      <div className="flex gap-4">\\n`;
      demo += `        <${capitalize(name)}>Default</${capitalize(name)}>\\n`;
      demo += `        <${capitalize(name)} variant="outline">Outline</${capitalize(name)}>\\n`;
      demo += `        <${capitalize(name)} variant="secondary">Secondary</${capitalize(name)}>\\n`;
      demo += `        <${capitalize(name)} variant="destructive">Destructive</${capitalize(name)}>\\n`;
      demo += `      </div>\\n`;
    } else {
      demo += `      <${capitalize(name)} />\\n`;
    }

    demo += `    </div>\\n`;
    demo += `  )\\n`;
    demo += `}\\n`;
    demo += `\`\`\`\\n\\n`;

    demo += `## Usage Notes\\n\\n`;
    demo += `- Import the component from \`@/components/ui/${name}\`\\n`;
    demo += `- ${component.description || 'No description available'}\\n`;

    if (component.dependencies && component.dependencies.length > 0) {
      demo += `\\n## Required Dependencies\\n\\n`;
      component.dependencies.forEach(dep => {
        demo += `- ${dep}\\n`;
      });
    }

    return {
      content: [{
        type: 'text',
        text: demo
      }]
    };
  },

  /**
   * Add component instructions
   */
  async add_component(args: any): Promise<ToolResult> {
    const name = args.name || args.component;
    const style = args.style || 'default';
    const framework = args.framework || 'react';

    let content = `# Add ${name} Component`;

    // Multi-framework support
    if (framework !== 'react') {
      content += ` for ${capitalize(framework)}`;
    }

    content += `

## Using the CLI (Recommended)
\`\`\`bash
npx @hanzo/ui@latest add ${name}`;

    if (style !== 'default') {
      content += ` --style=${style}`;
    }

    content += `
\`\`\`

This will:
- Download the component files
- Install any required dependencies
- Place files in the correct location`;

    // Add framework-specific usage
    if (framework !== 'react') {
      content += `

## Framework-Specific Usage

### ${capitalize(framework)}
\`\`\`${getFileExtension(framework)}
import { ${capitalize(name)} } from '@hanzo/ui/${framework}'

// Use in your ${framework} component
<${capitalize(name)} variant="default">
  Click me
</${capitalize(name)}>
\`\`\``;
    }

    content += `

## After Installation
- Import the component: \`import { ${capitalize(name)} } from "@/components/ui/${name}"\`
- Use in your JSX: \`<${capitalize(name)} />\`

The component will be ready to use in your project!`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * List available blocks/patterns
   */
  async list_blocks(args: any): Promise<ToolResult> {
    const registry = await getRegistry();
    const blocks = registry.items.filter(item =>
      item.type.includes("block") || item.type.includes("section")
    );

    const categoryFilter = args.category;
    const filtered = categoryFilter
      ? blocks.filter(b => b.category === categoryFilter)
      : blocks;

    let content = "# Available UI Blocks\\n\\n";

    if (filtered.length === 0) {
      content += "No blocks found";
      if (categoryFilter) {
        content += ` in category '${categoryFilter}'`;
      }
      content += ".\\n";
    } else {
      const byCategory = filtered.reduce((acc, block) => {
        const cat = block.category || "Uncategorized";
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(block);
        return acc;
      }, {} as Record<string, typeof blocks>);

      for (const [category, items] of Object.entries(byCategory)) {
        content += `## ${category}\\n\\n`;
        for (const item of items) {
          content += `### ${item.name}\\n`;
          content += `${item.description || 'No description'}\\n`;
          content += `**Install:** \`npx ${config.package}@latest add ${item.name}\`\\n\\n`;
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Get block details
   */
  async get_block(args: any): Promise<ToolResult> {
    const name = args.name || args.block;
    const framework = args.framework || DEFAULT_FRAMEWORK;
    const config = FRAMEWORK_CONFIGS[framework];
    const registry = await getRegistry(framework);
    const block = registry.items.find(item =>
      item.name === name && (item.type.includes("block") || item.type.includes("section"))
    );

    if (!block) {
      return {
        content: [{
          type: 'text',
          text: `Block '${name}' not found`
        }],
        isError: true
      };
    }

    let content = `# ${block.name} Block\\n\\n`;
    content += `${block.description || 'No description'}\\n\\n`;

    if (block.category) {
      content += `**Category:** ${block.category}\\n\\n`;
    }

    if (block.dependencies && block.dependencies.length > 0) {
      content += `## NPM Dependencies\\n\\n`;
      block.dependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }

    if (block.registryDependencies && block.registryDependencies.length > 0) {
      content += `## Required Components\\n\\n`;
      block.registryDependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }

    content += `## Installation\\n\\n`;
    content += `\`\`\`bash\\n`;
    content += `npx ${config.package}@latest add ${name}\\n`;
    content += `\`\`\`\\n\\n`;

    if (block.files && block.files.length > 0) {
      content += `## Files\\n\\n`;
      block.files.forEach(file => {
        content += `- \`${file.path}\` (${file.type})\\n`;
      });
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * List available styles
   */
  async list_styles(args: any): Promise<ToolResult> {
    const content = `# Available Hanzo UI Styles

## Default Style
The standard shadcn/ui styling approach with:
- Clean, modern aesthetics
- Subtle shadows and borders
- Standard spacing and typography

## New York Style
An alternative styling approach with:
- Flatter design elements
- Minimized shadows
- Tighter spacing
- Different visual hierarchy

## Selecting a Style

When initializing your project:
\`\`\`bash
npx @hanzo/ui@latest init
\`\`\`

You'll be prompted to choose between styles, or you can specify:
\`\`\`bash
npx @hanzo/ui@latest init --style=new-york
\`\`\`

Both styles are fully compatible and provide the same components with different visual presentations.`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Search the registry
   */
  async search(args: any): Promise<ToolResult> {
    const query = (args.query || args.search || '').toLowerCase();
    const framework = args.framework || DEFAULT_FRAMEWORK;
    const config = FRAMEWORK_CONFIGS[framework];
    const registry = await getRegistry(framework);

    const matches = registry.items.filter(item =>
      item.name.toLowerCase().includes(query) ||
      (item.description && item.description.toLowerCase().includes(query))
    );

    let content = `# Search Results for "${args.query || args.search}"\\n\\n`;

    if (matches.length === 0) {
      content += "No components found matching your search.\\n";
    } else {
      content += `Found ${matches.length} matching component(s):\\n\\n`;

      for (const item of matches) {
        content += `## ${item.name}\\n`;
        content += `**Type:** ${item.type}\\n`;
        if (item.category) {
          content += `**Category:** ${item.category}\\n`;
        }
        content += `**Description:** ${item.description || 'No description'}\\n`;
        content += `**Install:** \`npx ${config.package}@latest add ${item.name}\`\\n\\n`;
      }
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Get installation guide
   */
  async installation_guide(args: any): Promise<ToolResult> {
    const framework = args.framework || 'nextjs';

    const content = `# Hanzo UI Installation Guide

## Prerequisites
- Node.js 18.17 or later
- React 18 or later
- Tailwind CSS 3.4 or later

## Automatic Installation (Recommended)

### Step 1: Create Your Project

#### Next.js
\`\`\`bash
npx create-next-app@latest my-app --typescript --tailwind --app
cd my-app
\`\`\`

#### Vite
\`\`\`bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
\`\`\`

### Step 2: Initialize Hanzo UI

\`\`\`bash
npx @hanzo/ui@latest init
\`\`\`

You will be asked:
1. **Style** - Choose between Default and New York styles
2. **Base color** - Choose your base color scheme
3. **CSS variables** - Use CSS variables for theming (recommended)
4. **Components path** - Where to add components (default: @/components)

### Step 3: Start Adding Components

\`\`\`bash
npx @hanzo/ui@latest add button card dialog
\`\`\`

## Verify Installation

\`\`\`tsx
// app/page.tsx or src/App.tsx
import { Button } from "@/components/ui/button"

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Button>Hello Hanzo UI!</Button>
    </div>
  )
}
\`\`\`

Need help? Visit ui.hanzo.ai or check our GitHub repository.`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Compare frameworks
   */
  async compare_frameworks(args: any): Promise<ToolResult> {
    const componentName = args.component;

    // Mock coverage data - in production this would fetch from tracker.json
    const coverage: Record<string, Record<string, string>> = {
      'button': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '✅' },
      'card': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '✅' },
      'dialog': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '✅' },
      'dropdown': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '🚧' },
      'form': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '🚧' },
      'popover': { react: '✅', vue: '✅', svelte: '🚧', 'react-native': '❌' },
      'sheet': { react: '✅', vue: '✅', svelte: '🚧', 'react-native': '❌' },
      'table': { react: '✅', vue: '✅', svelte: '✅', 'react-native': '❌' },
      'tooltip': { react: '✅', vue: '✅', svelte: '🚧', 'react-native': '❌' },
    };

    let content = '# Framework Component Coverage\\n\\n';

    if (componentName) {
      const componentKey = componentName.toLowerCase();
      if (coverage[componentKey]) {
        const comp = coverage[componentKey];
        content += `## ${capitalize(componentName)} Component\\n\\n`;
        content += '| Framework | Status |\\n';
        content += '|-----------|--------|\\n';
        Object.entries(comp).forEach(([fw, status]) => {
          content += `| ${capitalize(fw)} | ${status} |\\n`;
        });
      } else {
        content += `Component '${componentName}' not found in coverage data.\\n`;
      }
    } else {
      content += '| Component | React | Vue | Svelte | React Native |\\n';
      content += '|-----------|-------|-----|--------|-------------|\\n';
      Object.entries(coverage).forEach(([comp, statuses]) => {
        content += `| ${capitalize(comp)} | ${statuses.react} | ${statuses.vue} | ${statuses.svelte} | ${statuses['react-native']} |\\n`;
      });
      content += '\\n**Legend:** ✅ Complete | 🚧 In Progress | ❌ Not Available\\n';
    }

    content += '\\n## Statistics\\n';
    content += '- **React**: 64% coverage (45/70 components)\\n';
    content += '- **Vue**: 81% coverage (57/70 components)\\n';
    content += '- **Svelte**: 70% coverage (49/70 components)\\n';
    content += '- **React Native**: 43% coverage (30/70 components)\\n';

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  },

  /**
   * Convert component between frameworks
   */
  async convert_framework(args: any): Promise<ToolResult> {
    const component = args.component;
    const from = args.from || 'react';
    const to = args.to || 'vue';
    const showCode = args.show_code !== false;

    const content = `# Converting ${component} from ${from} to ${to}

## Conversion Process

1. **Import Changes**
   - From: \`import { ${capitalize(component)} } from '@hanzo/ui/${from}'\`
   - To: \`import { ${capitalize(component)} } from '@hanzo/ui/${to}'\`

2. **Syntax Adaptation**
   - Event handlers: ${from === 'react' && to === 'vue' ? 'onClick → @click' : '@click → onClick'}
   - State management: ${from === 'react' && to === 'vue' ? 'useState → ref/reactive' : 'ref/reactive → useState'}
   - Styling: className prop supported in all web frameworks

3. **API Compatibility**
   Most props are compatible across frameworks, with minor adjustments for event handlers and refs.

## Automated Conversion

Use the CLI tool for automated conversion:
\`\`\`bash
npx @hanzo/ui convert --from ${from} --to ${to} ${component}.${getFileExtension(from)}
\`\`\`

## Manual Migration Guide

For manual migration, refer to:
https://ui.hanzo.ai/docs/migration/${from}-to-${to}`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

/**
 * Unified UI Tool - Single tool that handles all UI operations
 */
export const unifiedUITool: Tool = {
  name: 'ui',
  description: `Comprehensive UI tool for Hanzo UI components and operations.

Available methods:
- init: Initialize a new project
- list_components: List all available components
- get_component: Get details about a specific component
- get_source: Get component source code
- get_demo: Get component demo/example
- add_component: Get instructions for adding a component
- list_blocks: List available UI blocks/patterns
- get_block: Get details about a specific block
- list_styles: List available styles
- search: Search the registry
- installation_guide: Get installation guide
- compare_frameworks: Compare component availability across frameworks
- convert_framework: Convert component between frameworks`,

  inputSchema: zodToJsonSchema(z.object({
    method: z.enum([
      'init',
      'list_components',
      'get_component',
      'get_source',
      'get_demo',
      'add_component',
      'list_blocks',
      'get_block',
      'list_styles',
      'search',
      'installation_guide',
      'compare_frameworks',
      'convert_framework'
    ]).describe('The UI operation to perform'),

    // Common parameters
    name: z.string().optional().describe('Component or block name'),
    component: z.string().optional().describe('Component name (alias for name)'),
    block: z.string().optional().describe('Block name (alias for name)'),

    // Filtering parameters
    type: z.string().optional().describe('Filter by type (ui, block, etc.)'),
    category: z.string().optional().describe('Filter by category'),

    // Style and framework
    style: z.string().optional().describe('Style to use (default, new-york)'),
    framework: z.enum(FRAMEWORKS).optional().describe('Target framework (react, vue, svelte, react-native)'),

    // Search
    query: z.string().optional().describe('Search query'),
    search: z.string().optional().describe('Search query (alias for query)'),

    // Framework conversion
    from: z.enum(FRAMEWORKS).optional().describe('Source framework for conversion'),
    to: z.enum(FRAMEWORKS).optional().describe('Target framework for conversion'),
    show_code: z.boolean().optional().describe('Show code examples in conversion'),

    // Other
    path: z.string().optional().describe('Custom installation path'),
    overwrite: z.boolean().optional().describe('Whether to overwrite existing files'),
  })) as any,

  handler: async (args) => {
    const method = args.method;

    if (!method) {
      return {
        content: [{
          type: 'text',
          text: 'Error: method parameter is required. Available methods: init, list_components, get_component, get_source, get_demo, add_component, list_blocks, get_block, list_styles, search, installation_guide, compare_frameworks, convert_framework'
        }],
        isError: true
      };
    }

    const handler = methodHandlers[method];

    if (!handler) {
      return {
        content: [{
          type: 'text',
          text: `Error: Unknown method '${method}'. Available methods: ${Object.keys(methodHandlers).join(', ')}`
        }],
        isError: true
      };
    }

    try {
      return await handler(args);
    } catch (error) {
      console.error(`Error in UI method ${method}:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error executing ${method}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// Export for use in MCP
export default unifiedUITool;