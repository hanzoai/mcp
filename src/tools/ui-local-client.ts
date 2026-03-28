/**
 * Local filesystem client for reading UI components from ~/work/hanzo/ui.
 *
 * When the hanzo/ui repo is cloned locally, reads component source
 * directly from disk — no GitHub API calls, no rate limits, always
 * up-to-date with the developer's working tree.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const DEFAULT_UI_PATH = path.join(homedir(), 'work', 'hanzo', 'ui');

const COMPONENT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

export class LocalUIClient {
  private uiPath: string;

  constructor(uiPath?: string) {
    this.uiPath = uiPath || process.env.HANZO_UI_PATH || DEFAULT_UI_PATH;
  }

  /** Check if the local UI repo exists. */
  get available(): boolean {
    return existsSync(path.join(this.uiPath, 'pkg', 'ui'));
  }

  /** List all components from the local primitives directory. */
  async listComponents(_framework: string = 'hanzo'): Promise<any[]> {
    const primitivesDir = path.join(this.uiPath, 'pkg', 'ui', 'primitives');
    try {
      const entries = await fs.readdir(primitivesDir, { withFileTypes: true });
      const components: any[] = [];

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name.startsWith('index'))
          continue;

        if (entry.isDirectory()) {
          components.push({
            name: entry.name,
            type: 'dir',
            path: `pkg/ui/primitives/${entry.name}`,
          });
        } else if (entry.isFile() && COMPONENT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
          const ext = path.extname(entry.name);
          components.push({
            name: entry.name.replace(ext, ''),
            type: 'file',
            path: `pkg/ui/primitives/${entry.name}`,
          });
        }
      }

      return components;
    } catch {
      return [];
    }
  }

  /** Fetch component source code from local filesystem. */
  async fetchComponent(name: string, _framework: string = 'hanzo'): Promise<string> {
    const searchDirs = [
      path.join(this.uiPath, 'pkg', 'ui', 'primitives'),
      path.join(this.uiPath, 'pkg', 'ui', 'src'),
      path.join(this.uiPath, 'pkg', 'react', 'src', 'components'),
    ];

    for (const baseDir of searchDirs) {
      // Try direct file match
      for (const ext of COMPONENT_EXTENSIONS) {
        const candidate = path.join(baseDir, `${name}${ext}`);
        try {
          return await fs.readFile(candidate, 'utf-8');
        } catch {
          /* continue */
        }
      }

      // Try directory with index file
      for (const ext of COMPONENT_EXTENSIONS) {
        const indexFile = path.join(baseDir, name, `index${ext}`);
        try {
          return await fs.readFile(indexFile, 'utf-8');
        } catch {
          /* continue */
        }
      }
    }

    // Try src barrel exports
    try {
      return await fs.readFile(path.join(this.uiPath, 'pkg', 'ui', 'src', `${name}.ts`), 'utf-8');
    } catch {
      /* continue */
    }

    throw new Error(`Component '${name}' not found locally in hanzo/ui`);
  }

  /** Fetch component demo from local filesystem. */
  async fetchComponentDemo(name: string, _framework: string = 'hanzo'): Promise<string> {
    const demoDirs = [
      path.join(this.uiPath, 'demo'),
      path.join(this.uiPath, 'apps'),
    ];

    for (const demoDir of demoDirs) {
      for (const ext of COMPONENT_EXTENSIONS) {
        try {
          return await fs.readFile(path.join(demoDir, `${name}${ext}`), 'utf-8');
        } catch {
          /* continue */
        }
      }
    }

    // Check for demo file alongside component
    const compDir = path.join(this.uiPath, 'pkg', 'ui', 'primitives', name);
    for (const ext of COMPONENT_EXTENSIONS) {
      try {
        return await fs.readFile(path.join(compDir, `demo${ext}`), 'utf-8');
      } catch {
        /* continue */
      }
    }

    throw new Error(`Demo for '${name}' not found locally`);
  }

  /** Fetch component metadata from local filesystem. */
  async fetchComponentMetadata(name: string, _framework: string = 'hanzo'): Promise<any> {
    const primitivesDir = path.join(this.uiPath, 'pkg', 'ui', 'primitives');

    // Check for metadata.json
    try {
      const content = await fs.readFile(path.join(primitivesDir, name, 'metadata.json'), 'utf-8');
      return JSON.parse(content);
    } catch {
      /* continue */
    }

    // Build metadata from file info
    for (const ext of COMPONENT_EXTENSIONS) {
      const compFile = path.join(primitivesDir, `${name}${ext}`);
      try {
        const stat = await fs.stat(compFile);
        return {
          name,
          framework: 'hanzo',
          path: `pkg/ui/primitives/${name}${ext}`,
          size: stat.size,
          extension: ext,
          source: 'local',
        };
      } catch {
        /* continue */
      }
    }

    return { name, framework: 'hanzo', source: 'local' };
  }

  /** List blocks from local filesystem. */
  async listBlocks(_framework: string = 'hanzo'): Promise<any[]> {
    const blocksIndex = path.join(this.uiPath, 'pkg', 'ui', 'primitives', 'index-blocks.ts');
    try {
      const content = await fs.readFile(blocksIndex, 'utf-8');
      const blocks: any[] = [];
      for (const line of content.split('\n')) {
        if (line.trim().startsWith('export')) {
          const match = line.split('from').pop()?.trim().replace(/[';\"]/g, '').split('/').pop();
          if (match) {
            blocks.push({ name: match, type: 'export' });
          }
        }
      }
      return blocks;
    } catch {
      return [];
    }
  }

  /** Fetch block source code. */
  async fetchBlock(name: string, framework: string = 'hanzo'): Promise<string> {
    return this.fetchComponent(name, framework);
  }

  /** Browse directory structure of the local UI repo. */
  async getDirectoryStructure(dirPath: string, _framework: string = 'hanzo'): Promise<any> {
    const target = dirPath ? path.join(this.uiPath, dirPath) : path.join(this.uiPath, 'pkg');

    const entries = await fs.readdir(target, { withFileTypes: true });
    const children: any[] = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const item: any = {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        path: path.relative(this.uiPath, path.join(target, entry.name)),
      };

      if (entry.isFile()) {
        const stat = await fs.stat(path.join(target, entry.name));
        item.size = stat.size;
      }

      children.push(item);
    }

    return { path: dirPath || 'pkg/', children };
  }

  /** List all UI packages available locally. */
  async listPackages(): Promise<any[]> {
    const pkgDir = path.join(this.uiPath, 'pkg');
    try {
      const entries = await fs.readdir(pkgDir, { withFileTypes: true });
      const packages: any[] = [];

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const info: any = {
          name: entry.name,
          path: `pkg/${entry.name}`,
        };

        try {
          const pkgJson = JSON.parse(
            await fs.readFile(path.join(pkgDir, entry.name, 'package.json'), 'utf-8'),
          );
          info.version = pkgJson.version || 'unknown';
          info.description = pkgJson.description || '';
        } catch {
          /* no package.json */
        }

        packages.push(info);
      }

      return packages;
    } catch {
      return [];
    }
  }

  /** Read any file from the UI repo by relative path. */
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(path.join(this.uiPath, filePath), 'utf-8');
  }

  /** Search component files by name. */
  async searchComponents(query: string): Promise<any[]> {
    const queryLower = query.toLowerCase();
    const results: any[] = [];
    const seen = new Set<string>();

    const primitivesDir = path.join(this.uiPath, 'pkg', 'ui', 'primitives');
    try {
      const entries = await fs.readdir(primitivesDir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name.startsWith('index'))
          continue;

        const name = entry.isFile() ? path.parse(entry.name).name : entry.name;
        if (name.toLowerCase().includes(queryLower)) {
          seen.add(name);
          results.push({
            name,
            type: entry.isDirectory() ? 'dir' : 'file',
            path: `pkg/ui/primitives/${entry.name}`,
            match: 'name',
          });
        }
      }
    } catch {
      /* continue */
    }

    // Also search src modules
    const srcDir = path.join(this.uiPath, 'pkg', 'ui', 'src');
    try {
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const name = entry.isFile() ? path.parse(entry.name).name : entry.name;
        if (name.toLowerCase().includes(queryLower) && !seen.has(name)) {
          results.push({
            name,
            type: entry.isDirectory() ? 'dir' : 'file',
            path: `pkg/ui/src/${entry.name}`,
            match: 'name',
          });
        }
      }
    } catch {
      /* continue */
    }

    return results;
  }
}
