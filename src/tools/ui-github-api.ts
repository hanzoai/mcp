/**
 * GitHub API integration for fetching UI components from multiple frameworks
 * Supports shadcn/ui, Svelte, Vue, React Native, and Hanzo UI repositories
 */

import * as https from 'https';
import * as path from 'path';
import { Tool, ToolResult } from '../types/index.js';

// GitHub API configuration
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';

// Framework configuration interface
interface FrameworkConfig {
  owner: string;
  repo: string;
  branch: string;
  componentsPath: string;
  blocksPath?: string;
  examplesPath?: string;
  extension: string;
  defaultFramework?: boolean;
}

// Framework repository configurations
export const FRAMEWORK_CONFIGS: Record<string, FrameworkConfig> = {
  hanzo: {
    owner: 'hanzoai',
    repo: 'ui',
    branch: 'main',
    componentsPath: 'packages/ui/src/components',
    blocksPath: 'packages/ui/src/blocks',
    extension: '.tsx',
    defaultFramework: true
  },
  react: {
    owner: 'shadcn-ui',
    repo: 'ui',
    branch: 'main',
    componentsPath: 'apps/v4/registry/new-york-v4/ui',
    blocksPath: 'apps/v4/registry/new-york-v4/blocks',
    examplesPath: 'apps/v4/registry/new-york-v4/examples',
    extension: '.tsx'
  },
  svelte: {
    owner: 'huntabyte',
    repo: 'shadcn-svelte',
    branch: 'main',
    componentsPath: 'apps/www/src/lib/registry/new-york/ui',
    blocksPath: 'apps/www/src/lib/registry/new-york/blocks',
    extension: '.svelte'
  },
  vue: {
    owner: 'unovue',
    repo: 'shadcn-vue',
    branch: 'main',
    componentsPath: 'apps/www/src/lib/registry/new-york/ui',
    blocksPath: 'apps/www/src/lib/registry/new-york/blocks',
    extension: '.vue'
  },
  'react-native': {
    owner: 'founded-labs',
    repo: 'react-native-reusables',
    branch: 'main',
    componentsPath: 'packages/reusables/src',
    extension: '.tsx'
  }
};

export type Framework = keyof typeof FRAMEWORK_CONFIGS;

// Cache configuration
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

class Cache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private ttl: number;

  constructor(ttlMinutes: number = 15) {
    this.ttl = ttlMinutes * 60 * 1000;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Circuit breaker for resilience
class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly threshold: number = 5;
  private readonly timeout: number = 60000; // 1 minute

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open - service unavailable');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      if (this.failures >= this.threshold) {
        this.state = 'open';
      }

      throw error;
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
  }
}

// GitHub API client
export class GitHubAPIClient {
  private token: string | null;
  private cache = new Cache<any>();
  private circuitBreaker = new CircuitBreaker();
  private rateLimitRemaining: number = 60;
  private rateLimitReset: number = Date.now();

  constructor() {
    this.token = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
  }

  private async makeRequest(url: string): Promise<any> {
    // Check rate limit
    if (this.rateLimitRemaining <= 0 && Date.now() < this.rateLimitReset) {
      const waitTime = Math.ceil((this.rateLimitReset - Date.now()) / 1000);
      throw new Error(`GitHub API rate limit exceeded. Reset in ${waitTime} seconds.`);
    }

    // Check cache
    const cacheKey = url;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Execute with circuit breaker
    return this.circuitBreaker.execute(async () => {
      return new Promise((resolve, reject) => {
        const options: any = {
          headers: {
            'User-Agent': 'Hanzo-MCP-UI-Tool',
            'Accept': 'application/vnd.github.v3+json'
          }
        };

        if (this.token) {
          options.headers.Authorization = `token ${this.token}`;
        }

        https.get(url, options, (res) => {
          // Update rate limit info
          if (res.headers['x-ratelimit-remaining']) {
            this.rateLimitRemaining = parseInt(res.headers['x-ratelimit-remaining'] as string, 10);
          }
          if (res.headers['x-ratelimit-reset']) {
            this.rateLimitReset = parseInt(res.headers['x-ratelimit-reset'] as string, 10) * 1000;
          }

          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                this.cache.set(cacheKey, parsed);
                resolve(parsed);
              } catch (e) {
                // Not JSON, return raw
                this.cache.set(cacheKey, data);
                resolve(data);
              }
            } else if (res.statusCode === 403) {
              reject(new Error(`GitHub API rate limit exceeded or authentication required`));
            } else if (res.statusCode === 404) {
              reject(new Error(`Resource not found`));
            } else {
              reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
            }
          });
        }).on('error', reject);
      });
    });
  }

  async getRawContent(owner: string, repo: string, path: string, branch: string): Promise<string> {
    const url = `${GITHUB_RAW_BASE}/${owner}/${repo}/${branch}/${path}`;

    // Check cache first
    const cacheKey = url;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            this.cache.set(cacheKey, data);
            resolve(data);
          } else if (res.statusCode === 404) {
            reject(new Error(`File not found: ${path}`));
          } else {
            reject(new Error(`Failed to fetch raw content: ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });
  }

  async getDirectoryContents(owner: string, repo: string, path: string, branch: string): Promise<any[]> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    return this.makeRequest(url);
  }

  async searchCode(owner: string, repo: string, query: string): Promise<any> {
    const url = `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`;
    return this.makeRequest(url);
  }

  // Component fetching methods
  async fetchComponent(name: string, framework: Framework = 'hanzo'): Promise<string> {
    const config = FRAMEWORK_CONFIGS[framework];
    const componentPath = `${config.componentsPath}/${name}${config.extension}`;

    try {
      return await this.getRawContent(config.owner, config.repo, componentPath, config.branch);
    } catch (error: any) {
      // Try with folder structure (component/index.tsx)
      const indexPath = `${config.componentsPath}/${name}/index${config.extension}`;
      try {
        return await this.getRawContent(config.owner, config.repo, indexPath, config.branch);
      } catch {
        throw new Error(`Component '${name}' not found in ${framework} repository`);
      }
    }
  }

  async fetchComponentDemo(name: string, framework: Framework = 'hanzo'): Promise<string> {
    const config = FRAMEWORK_CONFIGS[framework];

    if (!config.examplesPath && framework !== 'hanzo') {
      throw new Error(`Demo/examples not available for ${framework}`);
    }

    const demoPath = framework === 'hanzo'
      ? `${config.componentsPath}/${name}/demo${config.extension}`
      : `${config.examplesPath}/${name}-demo${config.extension}`;

    try {
      return await this.getRawContent(config.owner, config.repo, demoPath, config.branch);
    } catch (error) {
      throw new Error(`Demo for component '${name}' not found in ${framework} repository`);
    }
  }

  async fetchComponentMetadata(name: string, framework: Framework = 'hanzo'): Promise<any> {
    const config = FRAMEWORK_CONFIGS[framework];
    const metadataPath = `${config.componentsPath}/${name}/metadata.json`;

    try {
      const content = await this.getRawContent(config.owner, config.repo, metadataPath, config.branch);
      return JSON.parse(content);
    } catch {
      // Return basic metadata if file doesn't exist
      return {
        name,
        framework,
        extension: config.extension,
        path: `${config.componentsPath}/${name}`
      };
    }
  }

  async fetchBlock(name: string, framework: Framework = 'hanzo'): Promise<string> {
    const config = FRAMEWORK_CONFIGS[framework];

    if (!config.blocksPath) {
      throw new Error(`Blocks not available for ${framework}`);
    }

    const blockPath = `${config.blocksPath}/${name}${config.extension}`;

    try {
      return await this.getRawContent(config.owner, config.repo, blockPath, config.branch);
    } catch (error: any) {
      // Try with folder structure
      const indexPath = `${config.blocksPath}/${name}/index${config.extension}`;
      try {
        return await this.getRawContent(config.owner, config.repo, indexPath, config.branch);
      } catch {
        throw new Error(`Block '${name}' not found in ${framework} repository`);
      }
    }
  }

  async listComponents(framework: Framework = 'hanzo'): Promise<string[]> {
    const config = FRAMEWORK_CONFIGS[framework];

    try {
      const contents = await this.getDirectoryContents(
        config.owner,
        config.repo,
        config.componentsPath,
        config.branch
      );

      return contents
        .filter((item: any) =>
          item.type === 'dir' ||
          (item.type === 'file' && item.name.endsWith(config.extension))
        )
        .map((item: any) => item.name.replace(config.extension, ''));
    } catch (error) {
      throw new Error(`Failed to list components for ${framework}: ${error}`);
    }
  }

  async listBlocks(framework: Framework = 'hanzo'): Promise<string[]> {
    const config = FRAMEWORK_CONFIGS[framework];

    if (!config.blocksPath) {
      return [];
    }

    try {
      const contents = await this.getDirectoryContents(
        config.owner,
        config.repo,
        config.blocksPath,
        config.branch
      );

      return contents
        .filter((item: any) =>
          item.type === 'dir' ||
          (item.type === 'file' && item.name.endsWith(config.extension))
        )
        .map((item: any) => item.name.replace(config.extension, ''));
    } catch {
      return []; // Blocks might not exist
    }
  }

  async getDirectoryStructure(dirPath: string, framework: Framework = 'hanzo'): Promise<any> {
    const config = FRAMEWORK_CONFIGS[framework];

    try {
      const contents = await this.getDirectoryContents(
        config.owner,
        config.repo,
        dirPath,
        config.branch
      );

      const structure: any = {
        path: dirPath,
        children: []
      };

      for (const item of contents) {
        if (item.type === 'dir') {
          structure.children.push({
            name: item.name,
            type: 'directory',
            path: item.path
          });
        } else if (item.type === 'file') {
          structure.children.push({
            name: item.name,
            type: 'file',
            path: item.path,
            size: item.size
          });
        }
      }

      return structure;
    } catch (error) {
      throw new Error(`Failed to get directory structure: ${error}`);
    }
  }

  // Utility methods
  clearCache(): void {
    this.cache.clear();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  getRateLimitInfo(): { remaining: number; reset: Date } {
    return {
      remaining: this.rateLimitRemaining,
      reset: new Date(this.rateLimitReset)
    };
  }
}

// Export singleton instance
export const githubClient = new GitHubAPIClient();

// MCP Tool definitions
export const fetchComponentTool: Tool = {
  name: 'ui_fetch_component',
  description: 'Fetch a UI component from GitHub repositories (shadcn/ui, Hanzo UI, etc)',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name (e.g., button, card, dialog)'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const content = await githubClient.fetchComponent(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching component: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const fetchComponentDemoTool: Tool = {
  name: 'ui_fetch_demo',
  description: 'Fetch a demo/example for a UI component',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const content = await githubClient.fetchComponentDemo(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching demo: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const fetchBlockTool: Tool = {
  name: 'ui_fetch_block',
  description: 'Fetch a UI block/section from GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Block name (e.g., hero, features, pricing)'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const content = await githubClient.fetchBlock(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching block: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const listComponentsTool: Tool = {
  name: 'ui_list_github_components',
  description: 'List available components from a framework repository',
  inputSchema: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    }
  },
  handler: async (args) => {
    try {
      const components = await githubClient.listComponents(args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: `Available components in ${args.framework || 'hanzo'}:\n${components.join('\n')}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing components: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const listBlocksTool: Tool = {
  name: 'ui_list_github_blocks',
  description: 'List available blocks from a framework repository',
  inputSchema: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    }
  },
  handler: async (args) => {
    try {
      const blocks = await githubClient.listBlocks(args.framework || 'hanzo');
      if (blocks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No blocks available for ${args.framework || 'hanzo'}`
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Available blocks in ${args.framework || 'hanzo'}:\n${blocks.join('\n')}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing blocks: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getComponentMetadataTool: Tool = {
  name: 'ui_component_metadata',
  description: 'Get metadata for a UI component',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const metadata = await githubClient.fetchComponentMetadata(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(metadata, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching metadata: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getBlockTool: Tool = {
  name: 'ui_get_block',
  description: 'Get a UI block implementation with support for complex compositions',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Block name (e.g., dashboard-01, authentication-01, chart-01)'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      },
      includeFiles: {
        type: 'boolean',
        description: 'Include all related files if block has multiple components',
        default: false
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const framework = args.framework || 'hanzo';
      const config = FRAMEWORK_CONFIGS[framework];

      if (!config.blocksPath) {
        return {
          content: [{
            type: 'text',
            text: `Blocks not available for ${framework}`
          }],
          isError: true
        };
      }

      // First try to fetch the main block file
      let content: string;
      let isDirectory = false;

      try {
        content = await githubClient.fetchBlock(args.name, framework);
      } catch {
        // If main file not found, check if it's a directory with multiple files
        try {
          const structure = await githubClient.getDirectoryStructure(
            `${config.blocksPath}/${args.name}`,
            framework
          );
          isDirectory = true;

          if (args.includeFiles && structure.children && structure.children.length > 0) {
            // Fetch all files in the block directory
            const files: any[] = [];
            for (const child of structure.children) {
              if (child.type === 'file' && child.name.endsWith(config.extension)) {
                try {
                  const fileContent = await githubClient.getRawContent(
                    config.owner,
                    config.repo,
                    child.path,
                    config.branch
                  );
                  files.push({
                    path: child.path,
                    name: child.name,
                    content: fileContent
                  });
                } catch {
                  // Skip files that can't be fetched
                }
              }
            }

            if (files.length > 0) {
              const output = files.map(f =>
                `// File: ${f.name}\n// Path: ${f.path}\n\n${f.content}`
              ).join('\n\n' + '='.repeat(80) + '\n\n');

              return {
                content: [{
                  type: 'text',
                  text: output
                }]
              };
            }
          }

          // Return structure if not fetching files
          content = JSON.stringify(structure, null, 2);
        } catch (error) {
          throw new Error(`Block '${args.name}' not found in ${framework} repository`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching block: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const listBlocksTool2: Tool = {
  name: 'ui_list_blocks',
  description: 'List all available UI blocks with categories (dashboard, authentication, charts, etc)',
  inputSchema: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      },
      category: {
        type: 'string',
        description: 'Filter by category (e.g., dashboard, authentication, chart, sidebar)',
      }
    }
  },
  handler: async (args) => {
    try {
      const framework = args.framework || 'hanzo';
      const blocks = await githubClient.listBlocks(framework);

      if (blocks.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No blocks available for ${framework}`
          }]
        };
      }

      // Categorize blocks based on naming patterns
      const categorized: Record<string, string[]> = {};
      const uncategorized: string[] = [];

      for (const block of blocks) {
        // Extract category from block name (e.g., "dashboard-01" -> "dashboard")
        const match = block.match(/^([a-z-]+)-\d+$/);
        if (match) {
          const category = match[1];
          if (!categorized[category]) {
            categorized[category] = [];
          }
          categorized[category].push(block);
        } else if (block.includes('-')) {
          // Try to extract category from first part
          const category = block.split('-')[0];
          if (!categorized[category]) {
            categorized[category] = [];
          }
          categorized[category].push(block);
        } else {
          uncategorized.push(block);
        }
      }

      // Filter by category if specified
      if (args.category) {
        const categoryBlocks = categorized[args.category] || [];
        if (categoryBlocks.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No blocks found in category '${args.category}' for ${framework}\n\nAvailable categories: ${Object.keys(categorized).join(', ')}`
            }]
          };
        }
        return {
          content: [{
            type: 'text',
            text: `${framework} blocks in category '${args.category}':\n${categoryBlocks.join('\n')}`
          }]
        };
      }

      // Format output with categories
      let output = `Available blocks in ${framework}:\n\n`;

      // Sort categories alphabetically
      const sortedCategories = Object.keys(categorized).sort();

      for (const category of sortedCategories) {
        output += `📁 ${category}:\n`;
        categorized[category].sort().forEach(block => {
          output += `  • ${block}\n`;
        });
        output += '\n';
      }

      if (uncategorized.length > 0) {
        output += `📄 Other:\n`;
        uncategorized.sort().forEach(block => {
          output += `  • ${block}\n`;
        });
      }

      return {
        content: [{
          type: 'text',
          text: output.trim()
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing blocks: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getDirectoryStructureTool2: Tool = {
  name: 'ui_get_directory_structure',
  description: 'Browse repository structure to explore available UI components and blocks',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path in the repository (e.g., "apps/www/src/lib/registry/new-york/ui")'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      },
      depth: {
        type: 'number',
        description: 'Maximum depth to traverse (default: 1)',
        default: 1
      }
    },
    required: ['path']
  },
  handler: async (args) => {
    try {
      const framework = args.framework || 'hanzo';
      const depth = args.depth || 1;

      // Helper function to recursively get directory structure
      async function getStructureRecursive(path: string, currentDepth: number): Promise<any> {
        if (currentDepth > depth) {
          return null;
        }

        const structure = await githubClient.getDirectoryStructure(path, framework);

        if (currentDepth < depth && structure.children) {
          // Recursively get subdirectories
          for (let i = 0; i < structure.children.length; i++) {
            const child = structure.children[i];
            if (child.type === 'directory') {
              const subStructure = await getStructureRecursive(child.path, currentDepth + 1);
              if (subStructure && subStructure.children) {
                structure.children[i] = {
                  ...child,
                  children: subStructure.children
                };
              }
            }
          }
        }

        return structure;
      }

      const structure = await getStructureRecursive(args.path, 1);

      // Format the output in a tree-like structure
      function formatTree(node: any, indent: string = ''): string {
        let output = '';

        if (node.children) {
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const isLast = i === node.children.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const extension = isLast ? '    ' : '│   ';

            if (child.type === 'directory') {
              output += `${indent}${connector}📁 ${child.name}/\n`;
              if (child.children) {
                output += formatTree(child, indent + extension);
              }
            } else {
              const icon = child.name.endsWith('.tsx') ? '⚛️' :
                          child.name.endsWith('.ts') ? '📘' :
                          child.name.endsWith('.jsx') ? '⚛️' :
                          child.name.endsWith('.js') ? '📜' :
                          child.name.endsWith('.vue') ? '💚' :
                          child.name.endsWith('.svelte') ? '🔥' :
                          child.name.endsWith('.css') ? '🎨' :
                          child.name.endsWith('.json') ? '📋' :
                          child.name.endsWith('.md') ? '📝' : '📄';
              const size = child.size ? ` (${(child.size / 1024).toFixed(1)}kb)` : '';
              output += `${indent}${connector}${icon} ${child.name}${size}\n`;
            }
          }
        }

        return output;
      }

      const treeOutput = formatTree(structure);
      const header = `📦 ${args.path}\n${treeOutput}`;

      return {
        content: [{
          type: 'text',
          text: header
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error getting directory structure: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getDirectoryStructureTool: Tool = {
  name: 'ui_directory_structure',
  description: 'Get directory structure from a UI framework repository',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path in the repository'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['path']
  },
  handler: async (args) => {
    try {
      const structure = await githubClient.getDirectoryStructure(args.path, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(structure, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error getting directory structure: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getComponentDemoTool: Tool = {
  name: 'ui_get_component_demo',
  description: 'Get component demo/example code from GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const content = await githubClient.fetchComponentDemo(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching component demo: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getComponentMetadataTool2: Tool = {
  name: 'ui_get_component_metadata',
  description: 'Get component dependencies and registry info from GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name'
      },
      framework: {
        type: 'string',
        enum: ['hanzo', 'react', 'svelte', 'vue', 'react-native'],
        description: 'UI framework (default: hanzo)',
        default: 'hanzo'
      }
    },
    required: ['name']
  },
  handler: async (args) => {
    try {
      const metadata = await githubClient.fetchComponentMetadata(args.name, args.framework || 'hanzo');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(metadata, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error fetching component metadata: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

export const getRateLimitTool: Tool = {
  name: 'ui_github_rate_limit',
  description: 'Get current GitHub API rate limit information',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  handler: async () => {
    const info = githubClient.getRateLimitInfo();
    return {
      content: [{
        type: 'text',
        text: `GitHub API Rate Limit:\nRemaining: ${info.remaining}\nReset: ${info.reset.toISOString()}`
      }]
    };
  }
};

// Export all GitHub UI tools
export const githubUITools: Tool[] = [
  fetchComponentTool,
  fetchComponentDemoTool,
  fetchBlockTool,
  getBlockTool,
  listComponentsTool,
  listBlocksTool,
  listBlocksTool2,
  getComponentMetadataTool,
  getComponentDemoTool,
  getComponentMetadataTool2,
  getDirectoryStructureTool,
  getDirectoryStructureTool2,
  getRateLimitTool
];