/**
 * MCP Protocol utilities and validators
 */

import { MCPRequest, MCPResponse, MCPNotification } from './types.js';

export class MCPProtocolError extends Error {
  constructor(message: string, public code?: number, public data?: any) {
    super(message);
    this.name = 'MCPProtocolError';
  }
}

/**
 * MCP Protocol message builder
 */
export class MCPProtocol {
  private nextId = 1;

  /**
   * Create an initialize request
   */
  initialize(clientInfo: { name: string; version: string }): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        clientInfo
      }
    };
  }

  /**
   * Create a list_tools request
   */
  listTools(): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {}
    };
  }

  /**
   * Create a call_tool request
   */
  callTool(name: string, arguments_?: Record<string, any>): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: {
        name,
        arguments: arguments_ || {}
      }
    };
  }

  /**
   * Create a list_resources request
   */
  listResources(): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'resources/list',
      params: {}
    };
  }

  /**
   * Create a read_resource request
   */
  readResource(uri: string): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'resources/read',
      params: { uri }
    };
  }

  /**
   * Create a list_prompts request
   */
  listPrompts(): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'prompts/list',
      params: {}
    };
  }

  /**
   * Create a get_prompt request
   */
  getPrompt(name: string, arguments_?: Record<string, any>): MCPRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'prompts/get',
      params: {
        name,
        arguments: arguments_ || {}
      }
    };
  }

  /**
   * Create an initialized notification
   */
  initialized(): MCPNotification {
    return {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
  }
}

/**
 * MCP Response validator
 */
export class MCPResponseValidator {
  /**
   * Validate a JSON-RPC 2.0 response
   */
  validateResponse(response: any): MCPResponse {
    if (!response || typeof response !== 'object') {
      throw new MCPProtocolError('Response must be an object');
    }

    if (response.jsonrpc !== '2.0') {
      throw new MCPProtocolError('Response must have jsonrpc: "2.0"');
    }

    if (!('id' in response)) {
      throw new MCPProtocolError('Response must have an id field');
    }

    if ('error' in response && 'result' in response) {
      throw new MCPProtocolError('Response cannot have both error and result');
    }

    if (!('error' in response) && !('result' in response)) {
      throw new MCPProtocolError('Response must have either error or result');
    }

    if ('error' in response) {
      this.validateError(response.error);
    }

    return response as MCPResponse;
  }

  /**
   * Validate an error object
   */
  validateError(error: any): void {
    if (!error || typeof error !== 'object') {
      throw new MCPProtocolError('Error must be an object');
    }

    if (typeof error.code !== 'number') {
      throw new MCPProtocolError('Error must have a numeric code');
    }

    if (typeof error.message !== 'string') {
      throw new MCPProtocolError('Error must have a string message');
    }
  }

  /**
   * Validate initialize response
   */
  validateInitializeResponse(response: MCPResponse): void {
    if (response.error) {
      throw new MCPProtocolError(`Initialize failed: ${response.error.message}`, response.error.code);
    }

    const result = response.result;
    if (!result || typeof result !== 'object') {
      throw new MCPProtocolError('Initialize response must have a result object');
    }

    if (!result.capabilities || typeof result.capabilities !== 'object') {
      throw new MCPProtocolError('Initialize response must have capabilities');
    }

    if (!result.serverInfo || typeof result.serverInfo !== 'object') {
      throw new MCPProtocolError('Initialize response must have serverInfo');
    }
  }

  /**
   * Validate list_tools response
   */
  validateListToolsResponse(response: MCPResponse): void {
    if (response.error) {
      throw new MCPProtocolError(`List tools failed: ${response.error.message}`, response.error.code);
    }

    const result = response.result;
    if (!result || typeof result !== 'object') {
      throw new MCPProtocolError('List tools response must have a result object');
    }

    if (!Array.isArray(result.tools)) {
      throw new MCPProtocolError('List tools response must have a tools array');
    }

    for (const tool of result.tools) {
      this.validateToolDefinition(tool);
    }
  }

  /**
   * Validate a tool definition
   */
  validateToolDefinition(tool: any): void {
    if (!tool || typeof tool !== 'object') {
      throw new MCPProtocolError('Tool definition must be an object');
    }

    if (typeof tool.name !== 'string' || !tool.name) {
      throw new MCPProtocolError('Tool must have a non-empty name');
    }

    if (typeof tool.description !== 'string') {
      throw new MCPProtocolError('Tool must have a description string');
    }

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new MCPProtocolError('Tool must have an inputSchema');
    }

    // Basic JSON Schema validation
    if (tool.inputSchema.type !== 'object') {
      throw new MCPProtocolError('Tool inputSchema must be of type "object"');
    }
  }

  /**
   * Validate call_tool response
   */
  validateCallToolResponse(response: MCPResponse): void {
    if (response.error) {
      // Tool call errors are expected for some test cases
      return;
    }

    const result = response.result;
    if (!result || typeof result !== 'object') {
      throw new MCPProtocolError('Call tool response must have a result object');
    }

    if (!Array.isArray(result.content)) {
      throw new MCPProtocolError('Call tool response must have a content array');
    }

    for (const content of result.content) {
      this.validateContent(content);
    }
  }

  /**
   * Validate content object
   */
  validateContent(content: any): void {
    if (!content || typeof content !== 'object') {
      throw new MCPProtocolError('Content must be an object');
    }

    if (!content.type || typeof content.type !== 'string') {
      throw new MCPProtocolError('Content must have a type string');
    }

    switch (content.type) {
      case 'text':
        if (typeof content.text !== 'string') {
          throw new MCPProtocolError('Text content must have a text string');
        }
        break;
      case 'image':
        if (typeof content.data !== 'string' && typeof content.url !== 'string') {
          throw new MCPProtocolError('Image content must have data or url');
        }
        if (typeof content.mimeType !== 'string') {
          throw new MCPProtocolError('Image content must have mimeType');
        }
        break;
      case 'resource':
        if (typeof content.resource !== 'object') {
          throw new MCPProtocolError('Resource content must have resource object');
        }
        break;
      default:
        throw new MCPProtocolError(`Unknown content type: ${content.type}`);
    }
  }
}

/**
 * Common MCP protocol constants
 */
export const MCP_CONSTANTS = {
  PROTOCOL_VERSION: '2024-11-05',
  
  METHODS: {
    INITIALIZE: 'initialize',
    LIST_TOOLS: 'tools/list',
    CALL_TOOL: 'tools/call',
    LIST_RESOURCES: 'resources/list',
    READ_RESOURCE: 'resources/read',
    LIST_PROMPTS: 'prompts/list',
    GET_PROMPT: 'prompts/get'
  },
  
  NOTIFICATIONS: {
    INITIALIZED: 'notifications/initialized',
    PROGRESS: 'notifications/progress',
    LOG: 'notifications/message',
    RESOURCE_UPDATED: 'notifications/resources/updated',
    RESOURCE_LIST_CHANGED: 'notifications/resources/list_changed',
    TOOL_LIST_CHANGED: 'notifications/tools/list_changed',
    PROMPT_LIST_CHANGED: 'notifications/prompts/list_changed'
  },

  ERROR_CODES: {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603
  }
} as const;