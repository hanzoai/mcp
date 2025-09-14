/**
 * MCP Server Process Manager - Language-agnostic server lifecycle management
 */

import { spawn, ChildProcess } from 'child_process';
import { MCPImplementation, MCPServerProcess, MCPRequest, MCPResponse } from './types.js';
import { MCPProtocol, MCPResponseValidator } from './mcp-protocol.js';
import { EventEmitter } from 'events';

export interface ServerManagerEvents {
  'server-ready': (implementation: MCPImplementation) => void;
  'server-error': (implementation: MCPImplementation, error: Error) => void;
  'server-output': (implementation: MCPImplementation, output: string) => void;
  'server-stderr': (implementation: MCPImplementation, output: string) => void;
}

export class MCPServerManager extends EventEmitter {
  private servers = new Map<string, MCPServerProcess>();
  private protocol = new MCPProtocol();
  private validator = new MCPResponseValidator();

  /**
   * Start an MCP server implementation
   */
  async startServer(implementation: MCPImplementation): Promise<MCPServerProcess> {
    if (this.servers.has(implementation.id)) {
      throw new Error(`Server ${implementation.id} is already running`);
    }

    const serverProcess: MCPServerProcess = {
      implementation,
      process: null,
      ready: false
    };

    try {
      // Spawn the process
      const process = spawn(implementation.command, implementation.args, {
        cwd: implementation.cwd || process.cwd(),
        env: { ...process.env, ...implementation.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      serverProcess.process = process;

      // Setup event handlers
      process.stdout?.on('data', (data) => {
        const output = data.toString();
        this.emit('server-output', implementation, output);
      });

      process.stderr?.on('data', (data) => {
        const output = data.toString();
        this.emit('server-stderr', implementation, output);
      });

      process.on('error', (error) => {
        serverProcess.error = error.message;
        this.emit('server-error', implementation, error);
      });

      process.on('exit', (code, signal) => {
        if (code !== 0) {
          const error = new Error(`Server exited with code ${code}, signal ${signal}`);
          serverProcess.error = error.message;
          this.emit('server-error', implementation, error);
        }
        this.servers.delete(implementation.id);
      });

      // Store the server process
      this.servers.set(implementation.id, serverProcess);

      // Initialize the MCP connection
      await this.initializeServer(serverProcess);

      return serverProcess;

    } catch (error) {
      serverProcess.error = (error as Error).message;
      throw error;
    }
  }

  /**
   * Initialize MCP protocol with the server
   */
  private async initializeServer(serverProcess: MCPServerProcess): Promise<void> {
    const { implementation } = serverProcess;
    
    // Send initialize request
    const initRequest = this.protocol.initialize({
      name: 'mcp-test-suite',
      version: '1.0.0'
    });

    try {
      const response = await this.sendRequest(serverProcess, initRequest);
      this.validator.validateInitializeResponse(response);

      // Send initialized notification
      const initializedNotification = this.protocol.initialized();
      await this.sendNotification(serverProcess, initializedNotification);

      serverProcess.ready = true;
      this.emit('server-ready', implementation);

    } catch (error) {
      serverProcess.error = (error as Error).message;
      throw error;
    }
  }

  /**
   * Send a request to an MCP server and wait for response
   */
  async sendRequest(serverProcess: MCPServerProcess, request: MCPRequest): Promise<MCPResponse> {
    return new Promise((resolve, reject) => {
      const { process } = serverProcess;
      
      if (!process || !process.stdin || !process.stdout) {
        reject(new Error('Server process not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`Request timeout: ${request.method}`));
      }, 10000);

      let responseBuffer = '';

      const onData = (data: Buffer) => {
        responseBuffer += data.toString();
        
        // Try to parse complete JSON-RPC messages
        const lines = responseBuffer.split('\n');
        responseBuffer = lines.pop() || ''; // Keep incomplete line
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              
              // Check if this is the response to our request
              if (response.id === request.id) {
                clearTimeout(timeout);
                process.stdout?.off('data', onData);
                
                try {
                  const validatedResponse = this.validator.validateResponse(response);
                  resolve(validatedResponse);
                } catch (validationError) {
                  reject(validationError);
                }
                return;
              }
            } catch (parseError) {
              // Continue trying to parse more data
            }
          }
        }
      };

      process.stdout.on('data', onData);

      // Send the request
      const requestLine = JSON.stringify(request) + '\n';
      process.stdin.write(requestLine);
    });
  }

  /**
   * Send a notification to an MCP server (no response expected)
   */
  async sendNotification(serverProcess: MCPServerProcess, notification: any): Promise<void> {
    const { process } = serverProcess;
    
    if (!process || !process.stdin) {
      throw new Error('Server process not available');
    }

    const notificationLine = JSON.stringify(notification) + '\n';
    process.stdin.write(notificationLine);
  }

  /**
   * Get list of available tools from a server
   */
  async listTools(implementationId: string): Promise<any[]> {
    const serverProcess = this.servers.get(implementationId);
    if (!serverProcess || !serverProcess.ready) {
      throw new Error(`Server ${implementationId} is not ready`);
    }

    const request = this.protocol.listTools();
    const response = await this.sendRequest(serverProcess, request);
    
    this.validator.validateListToolsResponse(response);
    return response.result.tools;
  }

  /**
   * Call a tool on a server
   */
  async callTool(implementationId: string, toolName: string, args: Record<string, any>): Promise<any> {
    const serverProcess = this.servers.get(implementationId);
    if (!serverProcess || !serverProcess.ready) {
      throw new Error(`Server ${implementationId} is not ready`);
    }

    const request = this.protocol.callTool(toolName, args);
    const response = await this.sendRequest(serverProcess, request);
    
    this.validator.validateCallToolResponse(response);
    return response;
  }

  /**
   * Stop a server
   */
  async stopServer(implementationId: string): Promise<void> {
    const serverProcess = this.servers.get(implementationId);
    if (!serverProcess) {
      return;
    }

    return new Promise((resolve) => {
      const { process } = serverProcess;
      
      if (!process) {
        resolve();
        return;
      }

      process.on('exit', () => {
        resolve();
      });

      // Try graceful shutdown first
      process.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (!process.killed) {
          process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  /**
   * Stop all servers
   */
  async stopAllServers(): Promise<void> {
    const stopPromises = Array.from(this.servers.keys()).map(id => 
      this.stopServer(id)
    );
    
    await Promise.all(stopPromises);
  }

  /**
   * Check if a server is running
   */
  isServerRunning(implementationId: string): boolean {
    const serverProcess = this.servers.get(implementationId);
    return serverProcess?.ready === true;
  }

  /**
   * Get server info
   */
  getServerInfo(implementationId: string): MCPServerProcess | undefined {
    return this.servers.get(implementationId);
  }

  /**
   * Get all running servers
   */
  getRunningServers(): MCPServerProcess[] {
    return Array.from(this.servers.values()).filter(s => s.ready);
  }
}

/**
 * Utility functions for server management
 */
export class ServerUtils {
  /**
   * Wait for server to be ready with timeout
   */
  static async waitForServer(manager: MCPServerManager, implementationId: string, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout waiting for server ${implementationId}`));
      }, timeout);

      const checkReady = () => {
        if (manager.isServerRunning(implementationId)) {
          clearTimeout(timeoutId);
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };

      checkReady();
    });
  }

  /**
   * Health check for a server
   */
  static async healthCheck(manager: MCPServerManager, implementationId: string): Promise<boolean> {
    try {
      const tools = await manager.listTools(implementationId);
      return Array.isArray(tools);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get server metrics
   */
  static async getServerMetrics(manager: MCPServerManager, implementationId: string): Promise<{
    toolCount: number;
    responsive: boolean;
    uptime: number;
  }> {
    const serverInfo = manager.getServerInfo(implementationId);
    if (!serverInfo) {
      throw new Error(`Server ${implementationId} not found`);
    }

    try {
      const tools = await manager.listTools(implementationId);
      return {
        toolCount: tools.length,
        responsive: true,
        uptime: Date.now() // This would need to track actual uptime
      };
    } catch (error) {
      return {
        toolCount: 0,
        responsive: false,
        uptime: 0
      };
    }
  }
}