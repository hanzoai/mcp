/**
 * File server for serving local files via HTTP
 * Enables remote access to files when MCP server is exposed
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { promises as fs } from 'fs';
import path from 'path';
import { lookup } from 'mime-types';
import { getSecureTunnel, SecureTunnel } from './secure-tunnel.js';

/**
 * File server configuration
 */
export interface FileServerConfig {
  port?: number;
  host?: string;
  basePath?: string;
  servePath?: string;
  enableCors?: boolean;
  allowedExtensions?: string[];
  maxFileSize?: number;
}

/**
 * File server class
 */
export class FileServer {
  private config: FileServerConfig;
  private server: any;
  private basePath: string;
  private secureTunnel: SecureTunnel;
  private tunnelUrl: string | null = null;

  constructor(config: FileServerConfig = {}) {
    this.config = {
      port: config.port || 8080,
      host: config.host || 'localhost',
      basePath: config.basePath || process.cwd(),
      servePath: config.servePath || '/files',
      enableCors: config.enableCors ?? true,
      allowedExtensions: config.allowedExtensions || [
        '.ts', '.tsx', '.js', '.jsx', '.json',
        '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h',
        '.md', '.txt', '.yml', '.yaml', '.toml',
        '.html', '.css', '.scss', '.sass'
      ],
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024 // 10MB
    };
    this.basePath = path.resolve(this.config.basePath!);
    this.secureTunnel = getSecureTunnel();
  }

  /**
   * Start the file server
   */
  async start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this));
      
      this.server.listen(this.config.port, this.config.host, async () => {
        console.log(`📁 File server running at http://${this.config.host}:${this.config.port}${this.config.servePath}`);
        
        // Start secure tunnel if configured
        this.tunnelUrl = await this.secureTunnel.startTunnel(this.config.port!);
        if (this.tunnelUrl) {
          console.log(`🌐 Files accessible at: ${this.tunnelUrl}${this.config.servePath}`);
        }
        
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop the file server
   */
  async stop(): Promise<void> {
    return new Promise(async (resolve) => {
      // Stop secure tunnel
      await this.secureTunnel.stopTunnel();
      
      if (this.server) {
        this.server.close(() => {
          console.log('📁 File server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle HTTP requests
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Check authentication if tunnel is active
    if (this.secureTunnel.isActive()) {
      if (!this.secureTunnel.authenticateRequest(req, res)) {
        return; // Authentication failed, response already sent
      }
      
      // Check rate limiting
      if (!this.secureTunnel.checkRateLimit(req, res)) {
        return; // Rate limit exceeded, response already sent
      }
    }
    
    // Handle CORS
    if (this.config.enableCors || this.secureTunnel.isActive()) {
      if (!this.secureTunnel.handleCORS(req, res)) {
        return; // CORS handling or preflight response sent
      }
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Parse URL
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Check if path starts with serve path
    if (!pathname.startsWith(this.config.servePath!)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Get relative file path
    const relativePath = pathname.substring(this.config.servePath!.length);
    const filePath = path.join(this.basePath, relativePath);

    // Security: Ensure file is within base path
    if (!filePath.startsWith(this.basePath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      // Check if file exists
      const stats = await fs.stat(filePath);
      
      // Don't serve directories
      if (stats.isDirectory()) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Directory listing not allowed');
        return;
      }

      // Check file size
      if (stats.size > this.config.maxFileSize!) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('File too large');
        return;
      }

      // Check file extension
      const ext = path.extname(filePath);
      if (!this.config.allowedExtensions!.includes(ext)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('File type not allowed');
        return;
      }

      // Read and serve file
      const content = await fs.readFile(filePath);
      const mimeType = lookup(filePath) || 'text/plain';
      
      // Parse line number from fragment
      const lineNumber = url.hash ? parseInt(url.hash.substring(2)) : null;
      
      // Add metadata headers
      res.setHeader('Content-Type', mimeType);
      res.setHeader('X-File-Path', relativePath);
      if (lineNumber) {
        res.setHeader('X-Line-Number', lineNumber.toString());
      }

      // If line number specified and it's a text file, highlight the line
      if (lineNumber && mimeType.startsWith('text/')) {
        const lines = content.toString().split('\n');
        if (lineNumber <= lines.length) {
          // Add line highlighting metadata
          res.setHeader('X-Highlight-Line', lineNumber.toString());
          
          // For HTML preview, wrap in basic HTML with line numbers
          if (url.searchParams.get('preview') === 'true') {
            const html = this.generateHtmlPreview(lines, lineNumber, filePath);
            res.setHeader('Content-Type', 'text/html');
            res.writeHead(200);
            res.end(html);
            return;
          }
        }
      }

      res.writeHead(200);
      res.end(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      } else {
        console.error('File server error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  }

  /**
   * Generate HTML preview with line highlighting
   */
  private generateHtmlPreview(lines: string[], highlightLine: number, filePath: string): string {
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).substring(1);
    
    const lineHtml = lines.map((line, idx) => {
      const lineNum = idx + 1;
      const isHighlighted = lineNum === highlightLine;
      const className = isHighlighted ? 'highlight' : '';
      return `<div class="line ${className}" id="L${lineNum}">
        <span class="line-number">${lineNum}</span>
        <span class="line-content">${this.escapeHtml(line)}</span>
      </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <title>${fileName}</title>
  <style>
    body {
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      margin: 0;
      padding: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
    }
    .header {
      padding: 10px;
      background: #2d2d2d;
      border-radius: 4px;
      margin-bottom: 20px;
    }
    .file-path {
      color: #569cd6;
    }
    .line {
      display: flex;
      line-height: 1.5;
      white-space: pre;
    }
    .line:hover {
      background: #2a2a2a;
    }
    .line.highlight {
      background: #3a3a00;
      border-left: 3px solid #ffcc00;
    }
    .line-number {
      width: 50px;
      color: #858585;
      text-align: right;
      padding-right: 15px;
      user-select: none;
    }
    .line-content {
      flex: 1;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="file-path">${filePath}</span>
    <span class="language">${ext}</span>
  </div>
  <div class="code">
    ${lineHtml}
  </div>
  <script>
    // Auto-scroll to highlighted line
    const highlight = document.querySelector('.highlight');
    if (highlight) {
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Get server URL
   */
  getServerUrl(): string {
    // Return tunnel URL if active, otherwise local URL
    if (this.tunnelUrl) {
      return `${this.tunnelUrl}${this.config.servePath}`;
    }
    return `http://${this.config.host}:${this.config.port}${this.config.servePath}`;
  }
}

// Global file server instance
let fileServer: FileServer | null = null;

/**
 * Get or create file server instance
 */
export function getFileServer(config?: FileServerConfig): FileServer {
  if (!fileServer) {
    fileServer = new FileServer(config);
  }
  return fileServer;
}

/**
 * Start the global file server
 */
export async function startFileServer(config?: FileServerConfig): Promise<string> {
  const server = getFileServer(config);
  await server.start();
  return server.getServerUrl();
}

/**
 * Stop the global file server
 */
export async function stopFileServer(): Promise<void> {
  if (fileServer) {
    await fileServer.stop();
    fileServer = null;
  }
}