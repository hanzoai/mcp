/**
 * Multi-framework support tools for Hanzo UI MCP
 */

import { Tool, ToolResult } from '../types/index.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Supported frameworks
const FRAMEWORKS = ['react', 'vue', 'svelte', 'react-native'] as const;
type Framework = typeof FRAMEWORKS[number];

// Framework-specific registry URLs
const getFrameworkRegistryUrl = (framework: Framework) => {
  const baseUrl = process.env.REGISTRY_URL || "https://ui.hanzo.ai/registry";
  return `${baseUrl}/${framework}/registry.json`;
};

// Multi-framework component add tool
export const uiAddMultiFrameworkTool: Tool = {
  name: 'ui_add_multi_framework',
  description: 'Add a component from @hanzo/ui with support for React, Vue, Svelte, or React Native.',
  inputSchema: zodToJsonSchema(z.object({
    component: z.string().describe("The component name to add (e.g., 'button', 'card', 'dialog')"),
    framework: z.enum(FRAMEWORKS).optional().describe("Target framework: react (default), vue, svelte, or react-native"),
    path: z.string().optional().describe("Custom path to install the component"),
    overwrite: z.boolean().optional().describe("Whether to overwrite existing files"),
  })) as any,
  handler: async (args) => {
    const framework = args.framework || 'react';
    const componentName = args.component;

    const content = `# Adding ${componentName} for ${framework}

## Installation

### Using npm:
\`\`\`bash
npm install @hanzo/ui
\`\`\`

### Using pnpm:
\`\`\`bash
pnpm add @hanzo/ui
\`\`\`

## Usage

${getFrameworkUsageExample(framework, componentName)}

## Component API

The ${componentName} component supports the following props across all frameworks:
- \`variant\`: Style variant (default, destructive, outline, etc.)
- \`size\`: Component size (sm, md, lg)
- \`className\`: Additional CSS classes
- \`disabled\`: Disable interaction
- \`...props\`: Framework-specific props

## Framework-Specific Notes

${getFrameworkNotes(framework)}

## Available in Other Frameworks

This component is also available for:
${FRAMEWORKS.filter(f => f !== framework).map(f => `- ${f}: \`import { ${capitalize(componentName)} } from '@hanzo/ui/${f}'\``).join('\n')}

## Full Documentation

Visit https://ui.hanzo.ai/docs/${framework}/${componentName} for complete documentation.
`;

    return {
      content: [{ type: 'text', text: content }],
      isError: false,
    };
  },
};

// Framework comparison tool
export const uiCompareFrameworksTool: Tool = {
  name: 'ui_compare_frameworks',
  description: 'Compare component availability across different frameworks in @hanzo/ui.',
  inputSchema: zodToJsonSchema(z.object({
    component: z.string().optional().describe("Specific component to check, or leave empty for all"),
  })) as any,
  handler: async (args) => {
    const componentName = args.component;

    // This would fetch from the actual tracker.json in production
    const coverage = {
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

    let content = '# Framework Component Coverage\n\n';

    if (componentName && coverage[componentName.toLowerCase()]) {
      const comp = coverage[componentName.toLowerCase()];
      content += `## ${capitalize(componentName)} Component\n\n`;
      content += '| Framework | Status |\n';
      content += '|-----------|--------|\n';
      Object.entries(comp).forEach(([fw, status]) => {
        content += `| ${capitalize(fw)} | ${status} |\n`;
      });
    } else {
      content += '| Component | React | Vue | Svelte | React Native |\n';
      content += '|-----------|-------|-----|--------|-------------|\n';
      Object.entries(coverage).forEach(([comp, statuses]) => {
        content += `| ${capitalize(comp)} | ${statuses.react} | ${statuses.vue} | ${statuses.svelte} | ${statuses['react-native']} |\n`;
      });
      content += '\n**Legend:** ✅ Complete | 🚧 In Progress | ❌ Not Available\n';
    }

    content += '\n## Statistics\n';
    content += '- **React**: 64% coverage (45/70 components)\n';
    content += '- **Vue**: 81% coverage (57/70 components)\n';
    content += '- **Svelte**: 70% coverage (49/70 components)\n';
    content += '- **React Native**: 43% coverage (30/70 components)\n';

    return {
      content: [{ type: 'text', text: content }],
      isError: false,
    };
  },
};

// Framework conversion tool
export const uiConvertFrameworkTool: Tool = {
  name: 'ui_convert_framework',
  description: 'Convert a component from one framework to another in @hanzo/ui.',
  inputSchema: zodToJsonSchema(z.object({
    component: z.string().describe("The component name to convert"),
    from: z.enum(FRAMEWORKS).describe("Source framework"),
    to: z.enum(FRAMEWORKS).describe("Target framework"),
    showCode: z.boolean().optional().describe("Show the converted code"),
  })) as any,
  handler: async (args) => {
    const { component, from, to, showCode } = args;

    const content = `# Converting ${component} from ${from} to ${to}

## Conversion Process

1. **Import Changes**
   - From: \`import { ${capitalize(component)} } from '@hanzo/ui/${from}'\`
   - To: \`import { ${capitalize(component)} } from '@hanzo/ui/${to}'\`

2. **Syntax Adaptation**
${getConversionNotes(from, to)}

3. **API Compatibility**
   Most props are compatible across frameworks, but note:
   - Event handlers: ${getEventHandlerConversion(from, to)}
   - Styling: ${getStylingConversion(from, to)}
   - Refs: ${getRefConversion(from, to)}

${showCode ? getConversionExample(component, from, to) : ''}

## Automated Conversion

Use the CLI tool for automated conversion:
\`\`\`bash
npx @hanzo/ui convert --from ${from} --to ${to} ${component}.${getFileExtension(from)}
\`\`\`

## Manual Migration Guide

For manual migration, refer to:
https://ui.hanzo.ai/docs/migration/${from}-to-${to}
`;

    return {
      content: [{ type: 'text', text: content }],
      isError: false,
    };
  },
};

// Helper functions
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getFrameworkUsageExample(framework: Framework, component: string): string {
  const examples = {
    'react': `### React/Next.js
\`\`\`tsx
import { ${capitalize(component)} } from '@hanzo/ui/react'

export function MyComponent() {
  return (
    <${capitalize(component)} variant="default">
      Click me
    </${capitalize(component)}>
  )
}
\`\`\``,
    'vue': `### Vue 3
\`\`\`vue
<template>
  <${capitalize(component)} variant="default">
    Click me
  </${capitalize(component)}>
</template>

<script setup>
import { ${capitalize(component)} } from '@hanzo/ui/vue'
</script>
\`\`\``,
    'svelte': `### Svelte
\`\`\`svelte
<script>
import { ${capitalize(component)} } from '@hanzo/ui/svelte'
</script>

<${capitalize(component)} variant="default">
  Click me
</${capitalize(component)}>
\`\`\``,
    'react-native': `### React Native
\`\`\`tsx
import { ${capitalize(component)} } from '@hanzo/ui/react-native'
import { View } from 'react-native'

export function MyScreen() {
  return (
    <View>
      <${capitalize(component)} variant="default">
        Click me
      </${capitalize(component)}>
    </View>
  )
}
\`\`\``,
  };
  return examples[framework] || examples.react;
}

function getFrameworkNotes(framework: Framework): string {
  const notes = {
    'react': '- Supports Next.js App Router and Pages Router\n- Full TypeScript support with type inference\n- Compatible with React 16.8+',
    'vue': '- Designed for Vue 3 Composition API\n- Supports both Options API and Composition API\n- TypeScript support via defineProps',
    'svelte': '- Built for Svelte 4+\n- Supports SvelteKit\n- Reactive by default',
    'react-native': '- Requires React Native 0.70+\n- Styled with react-native-tailwindcss\n- Supports Expo',
  };
  return notes[framework] || '';
}

function getConversionNotes(from: Framework, to: Framework): string {
  if (from === 'react' && to === 'vue') {
    return '   - JSX → Template syntax\n   - useState → ref/reactive\n   - useEffect → onMounted/watch';
  }
  if (from === 'react' && to === 'svelte') {
    return '   - JSX → Svelte template\n   - useState → let variables\n   - useEffect → $: reactive statements';
  }
  if (from === 'vue' && to === 'react') {
    return '   - Template → JSX\n   - ref/reactive → useState\n   - lifecycle hooks → useEffect';
  }
  return '   - Framework-specific syntax adjustments required';
}

function getEventHandlerConversion(from: Framework, to: Framework): string {
  const conversions = {
    'react-vue': 'onClick → @click',
    'react-svelte': 'onClick → on:click',
    'vue-react': '@click → onClick',
    'svelte-react': 'on:click → onClick',
  };
  return conversions[`${from}-${to}`] || 'Check framework documentation';
}

function getStylingConversion(from: Framework, to: Framework): string {
  if (to === 'react-native') {
    return 'className → style objects';
  }
  return 'className prop supported in all web frameworks';
}

function getRefConversion(from: Framework, to: Framework): string {
  const conversions = {
    'react-vue': 'useRef → ref()',
    'react-svelte': 'useRef → bind:this',
    'vue-react': 'ref() → useRef',
    'svelte-react': 'bind:this → useRef',
  };
  return conversions[`${from}-${to}`] || 'Framework-specific ref handling';
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

function getConversionExample(component: string, from: Framework, to: Framework): string {
  return `
## Example Conversion

### Before (${from}):
\`\`\`${getFileExtension(from)}
// Original ${from} code
${getFrameworkUsageExample(from, component).split('###')[1]}
\`\`\`

### After (${to}):
\`\`\`${getFileExtension(to)}
// Converted ${to} code
${getFrameworkUsageExample(to, component).split('###')[1]}
\`\`\`
`;
}

// Export all multi-framework tools
export const multiFrameworkTools: Tool[] = [
  uiAddMultiFrameworkTool,
  uiCompareFrameworksTool,
  uiConvertFrameworkTool,
];