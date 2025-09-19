/**
 * UI Registry Tools for @hanzo/ui and shadcn/ui components
 * Provides MCP tools for browsing, searching, and installing UI components
 */

import { Tool } from '../types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Registry configuration
const REGISTRIES = {
  shadcn: 'https://ui.shadcn.com/registry',
  hanzo: 'https://hanzo.ai/registry',
  acme: 'https://acme.com/r'
};

// Component categories
const COMPONENT_CATEGORIES = {
  layout: ['sidebar', 'navbar', 'footer', 'container', 'grid'],
  forms: ['input', 'textarea', 'select', 'checkbox', 'radio', 'switch', 'form'],
  feedback: ['alert', 'toast', 'dialog', 'modal', 'tooltip', 'popover'],
  navigation: ['menu', 'tabs', 'breadcrumb', 'pagination', 'stepper'],
  data: ['table', 'list', 'tree', 'timeline', 'calendar'],
  display: ['card', 'avatar', 'badge', 'chip', 'tag', 'progress', 'skeleton'],
  charts: ['line-chart', 'bar-chart', 'pie-chart', 'area-chart', 'radial-chart']
};

// Available components from @hanzo/ui and shadcn/ui
const AVAILABLE_COMPONENTS = [
  // shadcn/ui components
  { name: 'accordion', category: 'display', registry: 'shadcn', description: 'A vertically stacked set of interactive headings' },
  { name: 'alert', category: 'feedback', registry: 'shadcn', description: 'Displays a callout for user attention' },
  { name: 'alert-dialog', category: 'feedback', registry: 'shadcn', description: 'A modal dialog that interrupts the user with important content' },
  { name: 'aspect-ratio', category: 'layout', registry: 'shadcn', description: 'Displays content within a desired ratio' },
  { name: 'avatar', category: 'display', registry: 'shadcn', description: 'An image element with a fallback for representing the user' },
  { name: 'badge', category: 'display', registry: 'shadcn', description: 'Displays a badge or a component that looks like a badge' },
  { name: 'breadcrumb', category: 'navigation', registry: 'shadcn', description: 'Displays a breadcrumb navigation' },
  { name: 'button', category: 'forms', registry: 'shadcn', description: 'Displays a button or a component that looks like a button' },
  { name: 'calendar', category: 'data', registry: 'shadcn', description: 'A date field component that allows users to enter and edit date' },
  { name: 'card', category: 'display', registry: 'shadcn', description: 'Displays a card with header, content, and footer' },
  { name: 'carousel', category: 'display', registry: 'shadcn', description: 'A carousel with motion and swipe built in' },
  { name: 'chart', category: 'charts', registry: 'shadcn', description: 'Charts built with Recharts' },
  { name: 'checkbox', category: 'forms', registry: 'shadcn', description: 'A control that allows the user to toggle between checked and not checked' },
  { name: 'collapsible', category: 'display', registry: 'shadcn', description: 'An interactive component which expands/collapses a panel' },
  { name: 'combobox', category: 'forms', registry: 'shadcn', description: 'Autocomplete input and command palette with a list of suggestions' },
  { name: 'command', category: 'forms', registry: 'shadcn', description: 'Fast, composable, unstyled command menu for React' },
  { name: 'context-menu', category: 'navigation', registry: 'shadcn', description: 'Displays a menu to the user on right click' },
  { name: 'data-table', category: 'data', registry: 'shadcn', description: 'Powerful table and datagrids built with Tanstack Table' },
  { name: 'date-picker', category: 'forms', registry: 'shadcn', description: 'A date picker component with range and presets' },
  { name: 'dialog', category: 'feedback', registry: 'shadcn', description: 'A window overlaid on primary content' },
  { name: 'drawer', category: 'feedback', registry: 'shadcn', description: 'A drawer component for navigation and forms' },
  { name: 'dropdown-menu', category: 'navigation', registry: 'shadcn', description: 'Displays a menu to the user' },
  { name: 'hover-card', category: 'display', registry: 'shadcn', description: 'For sighted users to preview content on hover' },
  { name: 'input', category: 'forms', registry: 'shadcn', description: 'Displays a form input field' },
  { name: 'input-otp', category: 'forms', registry: 'shadcn', description: 'Accessible one-time password component' },
  { name: 'label', category: 'forms', registry: 'shadcn', description: 'Renders an accessible label associated with controls' },
  { name: 'menubar', category: 'navigation', registry: 'shadcn', description: 'A visually persistent menu for frequently used commands' },
  { name: 'navigation-menu', category: 'navigation', registry: 'shadcn', description: 'A collection of links for navigating websites' },
  { name: 'pagination', category: 'navigation', registry: 'shadcn', description: 'Pagination with page navigation, next and previous links' },
  { name: 'popover', category: 'feedback', registry: 'shadcn', description: 'Displays rich content in a portal, triggered by a button' },
  { name: 'progress', category: 'display', registry: 'shadcn', description: 'Displays an indicator showing completion of a task' },
  { name: 'radio-group', category: 'forms', registry: 'shadcn', description: 'A set of checkable buttons where only one can be checked' },
  { name: 'resizable', category: 'layout', registry: 'shadcn', description: 'Accessible resizable panel groups and layouts' },
  { name: 'scroll-area', category: 'layout', registry: 'shadcn', description: 'Augments native scroll functionality for custom styling' },
  { name: 'select', category: 'forms', registry: 'shadcn', description: 'Displays a list of options for the user to pick from' },
  { name: 'separator', category: 'layout', registry: 'shadcn', description: 'Visually or semantically separates content' },
  { name: 'sheet', category: 'feedback', registry: 'shadcn', description: 'Extends the Dialog component for a panel on screen edges' },
  { name: 'sidebar', category: 'layout', registry: 'shadcn', description: 'A composable, themeable sidebar component' },
  { name: 'skeleton', category: 'display', registry: 'shadcn', description: 'Use to show a placeholder while content is loading' },
  { name: 'slider', category: 'forms', registry: 'shadcn', description: 'An input where the user selects a value from within a range' },
  { name: 'sonner', category: 'feedback', registry: 'shadcn', description: 'An opinionated toast component for React' },
  { name: 'switch', category: 'forms', registry: 'shadcn', description: 'A control that allows toggling between checked and not checked' },
  { name: 'table', category: 'data', registry: 'shadcn', description: 'A responsive table component' },
  { name: 'tabs', category: 'navigation', registry: 'shadcn', description: 'A set of layered sections of content' },
  { name: 'textarea', category: 'forms', registry: 'shadcn', description: 'Displays a form textarea field' },
  { name: 'toast', category: 'feedback', registry: 'shadcn', description: 'A succinct message that appears temporarily' },
  { name: 'toggle', category: 'forms', registry: 'shadcn', description: 'A two-state button that can be either on or off' },
  { name: 'toggle-group', category: 'forms', registry: 'shadcn', description: 'A set of two-state buttons that can be toggled' },
  { name: 'tooltip', category: 'feedback', registry: 'shadcn', description: 'A popup that displays information on hover' },

  // @hanzo/ui custom components
  { name: 'hero', category: 'layout', registry: 'hanzo', description: 'Hero section with CTA and background' },
  { name: 'features', category: 'layout', registry: 'hanzo', description: 'Feature grid with icons and descriptions' },
  { name: 'testimonials', category: 'display', registry: 'hanzo', description: 'Customer testimonials carousel' },
  { name: 'pricing', category: 'display', registry: 'hanzo', description: 'Pricing cards with feature lists' },
  { name: 'login-form', category: 'forms', registry: 'hanzo', description: 'Complete login form with validation' },
  { name: 'checkout', category: 'forms', registry: 'hanzo', description: 'E-commerce checkout flow' },
  { name: 'product-card', category: 'display', registry: 'hanzo', description: 'Product display card with image and details' },
  { name: 'dashboard', category: 'layout', registry: 'hanzo', description: 'Admin dashboard layout' }
];

/**
 * List all available UI components
 */
export const listUIComponents: Tool = {
  name: 'ui_list_components',
  description: 'List all available UI components from @hanzo/ui and shadcn/ui registries',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Filter by category (layout, forms, feedback, navigation, data, display, charts)',
        enum: Object.keys(COMPONENT_CATEGORIES)
      },
      registry: {
        type: 'string',
        description: 'Filter by registry (shadcn, hanzo, all)',
        enum: ['shadcn', 'hanzo', 'all'],
        default: 'all'
      }
    }
  },
  handler: async (args: any) => {
    const { category, registry = 'all' } = args;

    let components = AVAILABLE_COMPONENTS;

    // Filter by category
    if (category) {
      components = components.filter(c => c.category === category);
    }

    // Filter by registry
    if (registry !== 'all') {
      components = components.filter(c => c.registry === registry);
    }

    // Group by category
    const grouped = components.reduce((acc, comp) => {
      if (!acc[comp.category]) {
        acc[comp.category] = [];
      }
      acc[comp.category].push(comp);
      return acc;
    }, {} as Record<string, typeof components>);

    let output = `📦 Available UI Components (${components.length} total)\n\n`;

    for (const [cat, comps] of Object.entries(grouped)) {
      output += `${cat.toUpperCase()}\n`;
      output += `${'─'.repeat(40)}\n`;
      for (const comp of comps) {
        output += `  • ${comp.name} (${comp.registry}): ${comp.description}\n`;
      }
      output += '\n';
    }

    return {
      content: [{
        type: 'text',
        text: output
      }]
    };
  }
};

/**
 * Search for UI components
 */
export const searchUIComponents: Tool = {
  name: 'ui_search_components',
  description: 'Search for UI components by name or functionality',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (name or functionality)'
      }
    },
    required: ['query']
  },
  handler: async (args: any) => {
    const { query } = args;
    const searchTerm = query.toLowerCase();

    const matches = AVAILABLE_COMPONENTS.filter(comp =>
      comp.name.toLowerCase().includes(searchTerm) ||
      comp.description.toLowerCase().includes(searchTerm) ||
      comp.category.toLowerCase().includes(searchTerm)
    );

    if (matches.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No components found matching "${query}"`
        }]
      };
    }

    let output = `🔍 Search Results for "${query}" (${matches.length} matches)\n\n`;

    for (const comp of matches) {
      output += `📦 ${comp.name}\n`;
      output += `  Registry: ${comp.registry}\n`;
      output += `  Category: ${comp.category}\n`;
      output += `  Description: ${comp.description}\n\n`;
    }

    return {
      content: [{
        type: 'text',
        text: output
      }]
    };
  }
};

/**
 * Get detailed information about a component
 */
export const getUIComponent: Tool = {
  name: 'ui_get_component',
  description: 'Get detailed information about a specific UI component',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name (e.g., button, card, dialog)'
      }
    },
    required: ['name']
  },
  handler: async (args: any) => {
    const { name } = args;

    const component = AVAILABLE_COMPONENTS.find(c => c.name === name);

    if (!component) {
      return {
        content: [{
          type: 'text',
          text: `Component "${name}" not found. Use ui_list_components to see available components.`
        }]
      };
    }

    let output = `📦 Component: ${component.name}\n`;
    output += `${'═'.repeat(50)}\n\n`;
    output += `Registry: ${component.registry}\n`;
    output += `Category: ${component.category}\n`;
    output += `Description: ${component.description}\n\n`;

    // Add installation instructions
    output += `Installation:\n`;
    output += `${'─'.repeat(40)}\n`;

    if (component.registry === 'shadcn') {
      output += `npx shadcn@latest add ${component.name}\n\n`;
    } else if (component.registry === 'hanzo') {
      output += `npx @hanzo/ui add ${component.name}\n\n`;
    }

    // Add usage example
    output += `Basic Usage:\n`;
    output += `${'─'.repeat(40)}\n`;
    output += `\`\`\`tsx\n`;

    if (component.name === 'button') {
      output += `import { Button } from "@/components/ui/button"\n\n`;
      output += `export function Example() {\n`;
      output += `  return (\n`;
      output += `    <Button>Click me</Button>\n`;
      output += `  )\n`;
      output += `}\n`;
    } else if (component.name === 'card') {
      output += `import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"\n\n`;
      output += `export function Example() {\n`;
      output += `  return (\n`;
      output += `    <Card>\n`;
      output += `      <CardHeader>\n`;
      output += `        <CardTitle>Card Title</CardTitle>\n`;
      output += `        <CardDescription>Card Description</CardDescription>\n`;
      output += `      </CardHeader>\n`;
      output += `      <CardContent>\n`;
      output += `        <p>Card Content</p>\n`;
      output += `      </CardContent>\n`;
      output += `    </Card>\n`;
      output += `  )\n`;
      output += `}\n`;
    } else {
      output += `import { ${component.name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')} } from "@/components/ui/${component.name}"\n\n`;
      output += `// See documentation for usage examples\n`;
    }

    output += `\`\`\`\n`;

    return {
      content: [{
        type: 'text',
        text: output
      }]
    };
  }
};

/**
 * Install a UI component
 */
export const installUIComponent: Tool = {
  name: 'ui_install_component',
  description: 'Install a UI component from @hanzo/ui or shadcn/ui registry',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name to install'
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite existing files',
        default: false
      }
    },
    required: ['name']
  },
  handler: async (args: any) => {
    const { name, overwrite = false } = args;

    const component = AVAILABLE_COMPONENTS.find(c => c.name === name);

    if (!component) {
      return {
        content: [{
          type: 'text',
          text: `Component "${name}" not found. Use ui_list_components to see available components.`
        }]
      };
    }

    try {
      let command = '';

      if (component.registry === 'shadcn') {
        command = `npx shadcn@latest add ${name}${overwrite ? ' --overwrite' : ''}`;
      } else if (component.registry === 'hanzo') {
        command = `npx @hanzo/ui add ${name}${overwrite ? ' --overwrite' : ''}`;
      }

      const { stdout, stderr } = await execAsync(command);

      let output = `✅ Successfully installed ${name} component\n\n`;
      output += `Command executed: ${command}\n\n`;

      if (stdout) {
        output += `Output:\n${stdout}\n`;
      }

      if (stderr) {
        output += `Warnings:\n${stderr}\n`;
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
          text: `Failed to install ${name}: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

/**
 * Create a UI component composition
 */
export const createUIComposition: Tool = {
  name: 'ui_create_composition',
  description: 'Create a composition using multiple UI components',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the composition (e.g., LoginPage, Dashboard)'
      },
      components: {
        type: 'array',
        description: 'List of components to use',
        items: { type: 'string' }
      },
      description: {
        type: 'string',
        description: 'Description of what the composition should do'
      }
    },
    required: ['name', 'components']
  },
  handler: async (args: any) => {
    const { name, components, description } = args;

    // Validate components exist
    const validComponents = components.filter((c: string) =>
      AVAILABLE_COMPONENTS.find(comp => comp.name === c)
    );

    if (validComponents.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No valid components specified. Use ui_list_components to see available components.'
        }]
      };
    }

    // Generate composition code
    let code = `/**\n * ${name}\n`;
    if (description) {
      code += ` * ${description}\n`;
    }
    code += ` * Composed with: ${validComponents.join(', ')}\n`;
    code += ` */\n\n`;

    // Add imports
    for (const comp of validComponents) {
      const componentInfo = AVAILABLE_COMPONENTS.find(c => c.name === comp);
      if (componentInfo) {
        const pascalCase = comp.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        code += `import { ${pascalCase} } from "@/components/ui/${comp}"\n`;
      }
    }

    code += `\n`;
    code += `export function ${name}() {\n`;
    code += `  return (\n`;
    code += `    <div className="container mx-auto p-6">\n`;

    // Add component usage based on type
    if (components.includes('card')) {
      code += `      <Card>\n`;
      code += `        <CardHeader>\n`;
      code += `          <CardTitle>${name}</CardTitle>\n`;
      if (description) {
        code += `          <CardDescription>${description}</CardDescription>\n`;
      }
      code += `        </CardHeader>\n`;
      code += `        <CardContent>\n`;
    } else {
      code += `      <div className="space-y-6">\n`;
    }

    // Add other components
    for (const comp of validComponents) {
      if (comp === 'card') continue;

      const pascalCase = comp.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

      if (comp === 'button') {
        code += `          <Button>Action</Button>\n`;
      } else if (comp === 'input') {
        code += `          <Input placeholder="Enter text..." />\n`;
      } else if (comp === 'select') {
        code += `          <Select>\n`;
        code += `            <SelectTrigger>\n`;
        code += `              <SelectValue placeholder="Select an option" />\n`;
        code += `            </SelectTrigger>\n`;
        code += `            <SelectContent>\n`;
        code += `              <SelectItem value="option1">Option 1</SelectItem>\n`;
        code += `              <SelectItem value="option2">Option 2</SelectItem>\n`;
        code += `            </SelectContent>\n`;
        code += `          </Select>\n`;
      } else {
        code += `          <${pascalCase} />\n`;
      }
    }

    if (components.includes('card')) {
      code += `        </CardContent>\n`;
      code += `      </Card>\n`;
    } else {
      code += `      </div>\n`;
    }

    code += `    </div>\n`;
    code += `  )\n`;
    code += `}\n`;

    let output = `✨ Created ${name} composition\n\n`;
    output += `\`\`\`tsx\n${code}\`\`\`\n\n`;
    output += `To use this composition:\n`;
    output += `1. Install required components: ${validComponents.join(', ')}\n`;
    output += `2. Create a new file and paste the code\n`;
    output += `3. Import and use in your application\n`;

    return {
      content: [{
        type: 'text',
        text: output
      }]
    };
  }
};

/**
 * Get UI registry configuration
 */
export const getUIRegistry: Tool = {
  name: 'ui_get_registry',
  description: 'Get information about UI component registries',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  handler: async () => {
    let output = `🎨 UI Component Registries\n`;
    output += `${'═'.repeat(50)}\n\n`;

    output += `Available Registries:\n`;
    output += `${'─'.repeat(40)}\n`;
    output += `• shadcn - Official shadcn/ui components\n`;
    output += `  URL: ${REGISTRIES.shadcn}\n`;
    output += `  Components: ${AVAILABLE_COMPONENTS.filter(c => c.registry === 'shadcn').length}\n\n`;

    output += `• @hanzo/ui - Hanzo custom components\n`;
    output += `  URL: ${REGISTRIES.hanzo}\n`;
    output += `  Components: ${AVAILABLE_COMPONENTS.filter(c => c.registry === 'hanzo').length}\n\n`;

    output += `Configuration:\n`;
    output += `${'─'.repeat(40)}\n`;
    output += `Add to your components.json:\n\n`;
    output += `\`\`\`json\n`;
    output += `{\n`;
    output += `  "registries": {\n`;
    output += `    "@hanzo": "${REGISTRIES.hanzo}/{name}.json",\n`;
    output += `    "@acme": "${REGISTRIES.acme}/{name}.json"\n`;
    output += `  }\n`;
    output += `}\n`;
    output += `\`\`\`\n\n`;

    output += `Component Categories:\n`;
    output += `${'─'.repeat(40)}\n`;
    for (const [category, items] of Object.entries(COMPONENT_CATEGORIES)) {
      output += `• ${category}: ${items.join(', ')}\n`;
    }

    return {
      content: [{
        type: 'text',
        text: output
      }]
    };
  }
};

// Export all UI registry tools
export const uiRegistryTools: Tool[] = [
  listUIComponents,
  searchUIComponents,
  getUIComponent,
  installUIComponent,
  createUIComposition,
  getUIRegistry
];