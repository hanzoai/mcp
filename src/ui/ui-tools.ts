/**
 * Hanzo UI MCP tools for component management and development
 */

import { Tool, ToolResult } from '../types/index.js';
import { registrySchema, Registry, RegistryItem } from './registry-types.js';
import { fetchRegistry, getRegistryItem, getRegistryItemUrl } from './registry-api.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Cache for registry data
let registryCache: Registry | null = null;
let registryCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
    // Return cached version if available, otherwise minimal registry
    return registryCache || {
      name: "hanzo-ui",
      items: [],
    };
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
      // Return the first file's content (usually the main component)
      const mainFile = component.files.find(f => f.type === "registry:ui") || component.files[0];
      return mainFile.content || null;
    }
  } catch (error) {
    console.error(`Failed to get component source for ${componentName}:`, error);
  }
  return null;
}

// UI Tools
export const uiInitTool: Tool = {
  name: 'ui_init',
  description: 'Initialize a new project using @hanzo/ui components and styles.',
  inputSchema: zodToJsonSchema(z.object({
    style: z.string().optional().describe("The style to use for the project (e.g., 'default' or 'new-york')"),
  })) as any,
  handler: async (args) => {
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

## Manual Setup (Alternative)

If you prefer manual setup:

### 1. Install dependencies
\`\`\`bash
npm install tailwindcss-animate class-variance-authority clsx tailwind-merge
\`\`\`

### 2. Configure Tailwind (tailwind.config.js)
\`\`\`javascript
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [require("tailwindcss-animate")],
}
\`\`\`

### 3. Add the cn() utility (lib/utils.ts)
\`\`\`typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
\`\`\`

Your project is ready for Hanzo UI components!`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

export const uiListComponentsTool: Tool = {
  name: 'ui_list_components',
  description: 'List all available components in the registry',
  inputSchema: zodToJsonSchema(z.object({
    type: z.string().optional().describe("Filter components by type (e.g., 'ui', 'block')"),
    category: z.string().optional().describe("Filter components by category"),
  })) as any,
  handler: async (args) => {
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
  }
};

export const uiGetComponentTool: Tool = {
  name: 'ui_get_component',
  description: 'Get detailed information about a specific component',
  inputSchema: zodToJsonSchema(z.object({
    name: z.string().describe("The name of the component to get from the registry"),
  })) as any,
  handler: async (args) => {
    const name = args.name;
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
    
    // Dependencies
    if (component.dependencies && component.dependencies.length > 0) {
      content += `## NPM Dependencies\\n\\n`;
      component.dependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }
    
    // Component dependencies
    if (component.registryDependencies && component.registryDependencies.length > 0) {
      content += `## Required Components\\n\\n`;
      component.registryDependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }
    
    // Installation
    content += `## Installation\\n\\n`;
    content += `\`\`\`bash\\n`;
    content += `npx @hanzo/ui@latest add ${name}\\n`;
    content += `\`\`\`\\n\\n`;
    
    // Files
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
  }
};

export const uiGetComponentSourceTool: Tool = {
  name: 'ui_get_component_source',
  description: 'Get the full source code of a component',
  inputSchema: zodToJsonSchema(z.object({
    name: z.string().describe("The name of the component to get source code for"),
  })) as any,
  handler: async (args) => {
    const name = args.name;
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
  }
};

export const uiGetComponentDemoTool: Tool = {
  name: 'ui_get_component_demo',
  description: 'Get a demo/example implementation of a component',
  inputSchema: zodToJsonSchema(z.object({
    name: z.string().describe("The name of the component to get demo for"),
  })) as any,
  handler: async (args) => {
    const name = args.name;
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

    // Generate a demo based on component type
    let demo = `# ${name} Demo\\n\\n\`\`\`tsx\\n`;
    demo += `import { ${name.charAt(0).toUpperCase() + name.slice(1)} } from "@/components/ui/${name}"\\n\\n`;
    demo += `export default function ${name.charAt(0).toUpperCase() + name.slice(1)}Demo() {\\n`;
    demo += `  return (\\n`;
    demo += `    <div className="space-y-4">\\n`;
    
    // Add component-specific demo content
    if (name === "button") {
      demo += `      <div className="flex gap-4">\\n`;
      demo += `        <${name.charAt(0).toUpperCase() + name.slice(1)}>Default</${name.charAt(0).toUpperCase() + name.slice(1)}>\\n`;
      demo += `        <${name.charAt(0).toUpperCase() + name.slice(1)} variant="outline">Outline</${name.charAt(0).toUpperCase() + name.slice(1)}>\\n`;
      demo += `        <${name.charAt(0).toUpperCase() + name.slice(1)} variant="secondary">Secondary</${name.charAt(0).toUpperCase() + name.slice(1)}>\\n`;
      demo += `        <${name.charAt(0).toUpperCase() + name.slice(1)} variant="destructive">Destructive</${name.charAt(0).toUpperCase() + name.slice(1)}>\\n`;
      demo += `      </div>\\n`;
    } else {
      demo += `      <${name.charAt(0).toUpperCase() + name.slice(1)} />\\n`;
    }
    
    demo += `    </div>\\n`;
    demo += `  )\\n`;
    demo += `}\\n`;
    demo += `\`\`\`\\n\\n`;
    
    // Add usage notes
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
  }
};

export const uiAddComponentTool: Tool = {
  name: 'ui_add_component',
  description: 'Get instructions for adding a component to a project',
  inputSchema: zodToJsonSchema(z.object({
    name: z.string().describe("The name of the component to add"),
    style: z.string().optional().describe("The style to use (default, new-york, etc.)"),
  })) as any,
  handler: async (args) => {
    const name = args.name;
    const style = args.style || 'default';
    
    const content = `# Add ${name} Component

## Using the CLI (Recommended)
\`\`\`bash
npx @hanzo/ui@latest add ${name}
\`\`\`

This will:
- Download the component files
- Install any required dependencies
- Place files in the correct location

## Style Option
If you want to specify a style:
\`\`\`bash
npx @hanzo/ui@latest add ${name} --style=${style}
\`\`\`

## Manual Installation
If you prefer manual installation:

1. **Check component details first:**
   Use \`ui_get_component\` to see dependencies and file structure

2. **Install NPM dependencies:**
   Install any packages listed in the component's dependencies

3. **Add registry dependencies:**
   Add any other components this one depends on

4. **Copy component files:**
   Copy the component source to your project structure

## After Installation
- Import the component: \`import { ${name.charAt(0).toUpperCase() + name.slice(1)} } from "@/components/ui/${name}"\`
- Use in your JSX: \`<${name.charAt(0).toUpperCase() + name.slice(1)} />\`

The component will be ready to use in your project!`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

export const uiListBlocksTool: Tool = {
  name: 'ui_list_blocks',
  description: 'List all available UI blocks/patterns',
  inputSchema: zodToJsonSchema(z.object({
    category: z.string().optional().describe("Filter blocks by category"),
  })) as any,
  handler: async (args) => {
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
          content += `**Install:** \`npx @hanzo/ui@latest add ${item.name}\`\\n\\n`;
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

export const uiGetBlockTool: Tool = {
  name: 'ui_get_block',
  description: 'Get detailed information about a specific block',
  inputSchema: zodToJsonSchema(z.object({
    name: z.string().describe("The name of the block to get"),
  })) as any,
  handler: async (args) => {
    const name = args.name;
    const registry = await getRegistry();
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
    
    // Dependencies
    if (block.dependencies && block.dependencies.length > 0) {
      content += `## NPM Dependencies\\n\\n`;
      block.dependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }
    
    // Component dependencies
    if (block.registryDependencies && block.registryDependencies.length > 0) {
      content += `## Required Components\\n\\n`;
      block.registryDependencies.forEach(dep => {
        content += `- ${dep}\\n`;
      });
      content += "\\n";
    }
    
    // Installation
    content += `## Installation\\n\\n`;
    content += `\`\`\`bash\\n`;
    content += `npx @hanzo/ui@latest add ${name}\\n`;
    content += `\`\`\`\\n\\n`;
    
    // Files
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
  }
};

export const uiListStylesTool: Tool = {
  name: 'ui_list_styles',
  description: 'List all available styles in the registry',
  inputSchema: zodToJsonSchema(z.object({})) as any,
  handler: async (args) => {
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

## Style Differences

The main differences between styles are:
- **Border radius** - Default uses more rounded corners
- **Shadows** - Default uses more prominent shadows  
- **Typography** - Slightly different font sizes and weights
- **Spacing** - Different padding and margin values
- **Colors** - Subtle differences in color palettes

Both styles are fully compatible and provide the same components with different visual presentations.`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

export const uiSearchRegistryTool: Tool = {
  name: 'ui_search_registry',
  description: 'Search the registry for components matching criteria',
  inputSchema: zodToJsonSchema(z.object({
    query: z.string().describe("Search term to look for in component names and descriptions"),
  })) as any,
  handler: async (args) => {
    const query = args.query.toLowerCase();
    const registry = await getRegistry();
    
    const matches = registry.items.filter(item => 
      item.name.toLowerCase().includes(query) || 
      (item.description && item.description.toLowerCase().includes(query))
    );

    let content = `# Search Results for "${args.query}"\\n\\n`;
    
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
        content += `**Install:** \`npx @hanzo/ui@latest add ${item.name}\`\\n\\n`;
      }
    }

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

export const uiGetInstallationGuideTool: Tool = {
  name: 'ui_get_installation_guide',
  description: 'Get the complete installation guide for setting up Hanzo UI',
  inputSchema: zodToJsonSchema(z.object({})) as any,
  handler: async (args) => {
    const content = `# Hanzo UI Complete Installation Guide

## Prerequisites

- Node.js 18.17 or later
- React 18 or later  
- Tailwind CSS 3.4 or later

## Automatic Installation (Recommended)

### Step 1: Create Your Project

Choose your preferred framework:

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

#### Remix
\`\`\`bash
npx create-remix@latest my-app
cd my-app
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
\`\`\`

### Step 2: Initialize Hanzo UI

Run the init command to set up your project:

\`\`\`bash
npx @hanzo/ui@latest init
\`\`\`

You will be asked a few questions:

1. **Style** - Choose between Default and New York styles
2. **Base color** - Choose your base color scheme
3. **CSS variables** - Use CSS variables for theming (recommended)
4. **Components path** - Where to add components (default: @/components)
5. **Utils path** - Where to add the cn utility (default: @/lib/utils)
6. **React Server Components** - Whether to use RSC
7. **Components.json** - Write configuration to components.json

### Step 3: Start Adding Components

\`\`\`bash
# Add individual components
npx @hanzo/ui@latest add button
npx @hanzo/ui@latest add card
npx @hanzo/ui@latest add dialog

# Add multiple at once
npx @hanzo/ui@latest add button card dialog form

# Add all components (use with caution)
npx @hanzo/ui@latest add --all
\`\`\`

## Manual Installation

If you prefer to set up manually:

### Step 1: Install Dependencies

\`\`\`bash
npm install tailwindcss-animate class-variance-authority clsx tailwind-merge lucide-react
\`\`\`

### Step 2: Configure Path Aliases

Update your \`tsconfig.json\`:

\`\`\`json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
\`\`\`

### Step 3: Configure Tailwind

Update \`tailwind.config.js\`:

\`\`\`javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
\`\`\`

### Step 4: Add CSS Variables

Add to your \`globals.css\`:

\`\`\`css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
\`\`\`

### Step 5: Add the cn Utility

Create \`lib/utils.ts\`:

\`\`\`typescript
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
\`\`\`

## Verify Installation

Create a test component to verify everything works:

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

## Next Steps

1. **Explore Components** - Use \`ui_list_components\` to browse available components
2. **Customize Theme** - Adjust CSS variables to match your brand
3. **Add More Components** - Install components as needed
4. **Check Documentation** - Visit ui.hanzo.ai for full docs

## Troubleshooting

### Module Resolution Issues
Ensure your path aliases are correctly configured in both tsconfig.json and your bundler config.

### Styling Not Applied
Make sure Tailwind CSS is properly configured and your CSS file is imported in your app.

### Type Errors
Install TypeScript definitions: \`npm install -D @types/react @types/react-dom\`

### Dark Mode Not Working
Ensure you're toggling the \`dark\` class on your HTML element.

Need help? Visit ui.hanzo.ai or check our GitHub repository.`;

    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
};

// Export all UI tools
export const uiTools: Tool[] = [
  uiInitTool,
  uiListComponentsTool,
  uiGetComponentTool,
  uiGetComponentSourceTool,
  uiGetComponentDemoTool,
  uiAddComponentTool,
  uiListBlocksTool,
  uiGetBlockTool,
  uiListStylesTool,
  uiSearchRegistryTool,
  uiGetInstallationGuideTool,
];