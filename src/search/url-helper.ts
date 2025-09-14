/**
 * URL helper for generating accessible URLs for search results
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getSecureTunnel } from './secure-tunnel.js';

/**
 * URL configuration for the MCP server
 */
export interface UrlConfig {
  baseUrl?: string;           // Remote base URL (e.g., https://abc123.ngrok.io)
  servePath?: string;         // Path prefix for served files (e.g., /files)
  enableFileServing?: boolean; // Whether to serve files via HTTP
  workspaceRoot?: string;     // Root directory for the workspace
}

/**
 * URL helper class
 */
export class UrlHelper {
  private config: UrlConfig;
  private workspaceRoot: string;

  constructor(config: UrlConfig = {}) {
    this.config = config;
    this.workspaceRoot = config.workspaceRoot || process.cwd();
  }

  /**
   * Generate URL for a file
   */
  generateFileUrl(filePath: string, lineNumber?: number): string {
    const absolutePath = path.isAbsolute(filePath) 
      ? filePath 
      : path.resolve(this.workspaceRoot, filePath);

    // Check if secure tunnel is active
    const secureTunnel = getSecureTunnel();
    const tunnelUrl = secureTunnel.getTunnelUrl();
    
    // Use tunnel URL if available
    const baseUrl = tunnelUrl || this.config.baseUrl;
    
    // If we have a remote base URL (ngrok, etc.)
    if (baseUrl) {
      const relativePath = path.relative(this.workspaceRoot, absolutePath);
      const servePath = this.config.servePath || '/files';
      let url = `${baseUrl}${servePath}/${relativePath}`;
      
      // Add line number as fragment
      if (lineNumber) {
        url += `#L${lineNumber}`;
      }
      
      return url.replace(/\\/g, '/'); // Ensure forward slashes
    }

    // VSCode-style URL for local development
    // This format is recognized by many editors and IDEs
    if (lineNumber) {
      return `vscode://file/${absolutePath}:${lineNumber}:1`;
    }

    // Standard file:// URL for local files
    // Most systems can handle this
    return `file://${absolutePath}`;
  }

  /**
   * Generate document ID that can be parsed back
   */
  generateDocumentId(filePath: string, lineNumber?: number, nodeType?: string): string {
    const relativePath = path.relative(this.workspaceRoot, filePath);
    let id = relativePath;
    
    if (lineNumber) {
      id += `:${lineNumber}`;
    }
    if (nodeType) {
      id += `:${nodeType}`;
    }
    
    // Ensure consistent path separators
    return id.replace(/\\/g, '/');
  }

  /**
   * Parse document ID back to components
   */
  parseDocumentId(id: string): {
    filePath: string;
    lineNumber?: number;
    nodeType?: string;
  } {
    // Handle special prefixes
    if (id.startsWith('vector:') || id.startsWith('memory:')) {
      return { filePath: id };
    }

    const parts = id.split(':');
    const filePath = path.resolve(this.workspaceRoot, parts[0]);
    
    const result: any = { filePath };
    
    if (parts[1] && /^\d+$/.test(parts[1])) {
      result.lineNumber = parseInt(parts[1]);
    }
    if (parts[2]) {
      result.nodeType = parts[2];
    }
    
    return result;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<UrlConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.workspaceRoot) {
      this.workspaceRoot = config.workspaceRoot;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): UrlConfig {
    return { ...this.config };
  }
}

// Global URL helper instance
let urlHelper: UrlHelper | null = null;

/**
 * Get or create URL helper instance
 */
export function getUrlHelper(): UrlHelper {
  if (!urlHelper) {
    // Check for environment variables
    const config: UrlConfig = {
      baseUrl: process.env.MCP_BASE_URL,
      servePath: process.env.MCP_SERVE_PATH || '/files',
      enableFileServing: process.env.MCP_ENABLE_FILE_SERVING === 'true',
      workspaceRoot: process.env.MCP_WORKSPACE_ROOT || process.cwd()
    };
    
    urlHelper = new UrlHelper(config);
  }
  return urlHelper;
}

/**
 * Configure URL helper
 */
export function configureUrlHelper(config: UrlConfig): void {
  if (!urlHelper) {
    urlHelper = new UrlHelper(config);
  } else {
    urlHelper.updateConfig(config);
  }
}