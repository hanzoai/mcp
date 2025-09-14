/**
 * Tests for SecureTunnel - ngrok integration and authentication
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { SecureTunnel, SecureTunnelConfig, getSecureTunnel, shouldEnableNgrok } from '../../src/search/secure-tunnel.js';
import { spawn } from 'child_process';

// Mock child_process spawn
jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

describe('SecureTunnel', () => {
  let tunnel: SecureTunnel;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    
    // Clear relevant env vars for clean testing
    delete process.env.NGROK_API_KEY;
    delete process.env.NGROK_AUTHTOKEN;
    delete process.env.NGROK_ENABLED;
    delete process.env.MCP_ACCESS_TOKEN;
    delete process.env.MCP_API_KEYS;
    delete process.env.MCP_JWT_SECRET;
    delete process.env.MCP_POST_QUANTUM_TLS;
    delete process.env.MCP_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe('Configuration Loading', () => {
    it('should detect ngrok from NGROK_API_KEY', () => {
      process.env.NGROK_API_KEY = 'test-api-key';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].ngrokEnabled).toBe(true);
      expect(tunnel['config'].ngrokApiKey).toBe('test-api-key');
    });

    it('should detect ngrok from NGROK_AUTHTOKEN', () => {
      process.env.NGROK_AUTHTOKEN = 'test-auth-token';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].ngrokEnabled).toBe(true);
      expect(tunnel['config'].ngrokAuthToken).toBe('test-auth-token');
    });

    it('should not enable ngrok without credentials', () => {
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].ngrokEnabled).toBe(false);
    });

    it('should generate access token if not provided', () => {
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].accessToken).toBeDefined();
      expect(tunnel['config'].accessToken).toHaveLength(64); // 32 bytes hex = 64 chars
    });

    it('should use provided access token', () => {
      process.env.MCP_ACCESS_TOKEN = 'custom-token';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].accessToken).toBe('custom-token');
    });

    it('should parse API keys from environment', () => {
      process.env.MCP_API_KEYS = 'key1,key2,key3';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].apiKeys).toEqual(['key1', 'key2', 'key3']);
    });

    it('should enable post-quantum TLS when configured', () => {
      process.env.MCP_POST_QUANTUM_TLS = 'true';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].enablePostQuantumTls).toBe(true);
      expect(tunnel['config'].tlsVersion).toBe('TLSv1.3');
    });

    it('should parse allowed origins', () => {
      process.env.MCP_ALLOWED_ORIGINS = 'https://app1.com,https://app2.com';
      tunnel = new SecureTunnel();
      
      expect(tunnel['config'].allowedOrigins).toEqual(['https://app1.com', 'https://app2.com']);
    });

    it('should throw error when ngrok enabled without credentials', () => {
      process.env.NGROK_ENABLED = 'true';
      
      expect(() => new SecureTunnel()).toThrow('Ngrok is enabled but no NGROK_API_KEY');
    });
  });

  describe('Authentication', () => {
    let mockReq: IncomingMessage;
    let mockRes: ServerResponse;

    beforeEach(() => {
      mockReq = {
        headers: {},
        socket: {
          remoteAddress: '127.0.0.1'
        } as Socket
      } as IncomingMessage;
      
      mockRes = {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn()
      } as unknown as ServerResponse;
      
      process.env.MCP_ACCESS_TOKEN = 'test-token';
      tunnel = new SecureTunnel();
    });

    it('should authenticate with Bearer token', () => {
      mockReq.headers.authorization = 'Bearer test-token';
      
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    it('should authenticate with X-MCP-Access-Token header', () => {
      mockReq.headers['x-mcp-access-token'] = 'test-token';
      
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    it('should authenticate with API key', () => {
      process.env.MCP_API_KEYS = 'key1,key2,key3';
      tunnel = new SecureTunnel();
      
      mockReq.headers['x-api-key'] = 'key2';
      
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    it('should reject invalid Bearer token', () => {
      mockReq.headers.authorization = 'Bearer wrong-token';
      
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(false);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Unauthorized'));
    });

    it('should reject request without authentication', () => {
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(false);
      expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    it('should allow request when authentication not required', () => {
      tunnel = new SecureTunnel({ requireAuth: false });
      
      const result = tunnel.authenticateRequest(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.writeHead).not.toHaveBeenCalled();
    });
  });

  describe('Rate Limiting', () => {
    let mockReq: IncomingMessage;
    let mockRes: ServerResponse;

    beforeEach(() => {
      mockReq = {
        headers: {},
        socket: {
          remoteAddress: '192.168.1.1'
        } as Socket
      } as IncomingMessage;
      
      mockRes = {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn()
      } as unknown as ServerResponse;
      
      tunnel = new SecureTunnel({
        rateLimit: {
          windowMs: 1000, // 1 second
          maxRequests: 3
        }
      });
    });

    it('should allow requests within rate limit', () => {
      expect(tunnel.checkRateLimit(mockReq, mockRes)).toBe(true);
      expect(tunnel.checkRateLimit(mockReq, mockRes)).toBe(true);
      expect(tunnel.checkRateLimit(mockReq, mockRes)).toBe(true);
    });

    it('should block requests exceeding rate limit', () => {
      // Use up the limit
      tunnel.checkRateLimit(mockReq, mockRes);
      tunnel.checkRateLimit(mockReq, mockRes);
      tunnel.checkRateLimit(mockReq, mockRes);
      
      // This should be blocked
      const result = tunnel.checkRateLimit(mockReq, mockRes);
      
      expect(result).toBe(false);
      expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Too Many Requests'));
    });

    it('should reset rate limit after window expires', async () => {
      // Use up the limit
      tunnel.checkRateLimit(mockReq, mockRes);
      tunnel.checkRateLimit(mockReq, mockRes);
      tunnel.checkRateLimit(mockReq, mockRes);
      
      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should be allowed again
      expect(tunnel.checkRateLimit(mockReq, mockRes)).toBe(true);
    });

    it('should track rate limits per IP', () => {
      const req1 = { ...mockReq, socket: { remoteAddress: '192.168.1.1' } as Socket } as IncomingMessage;
      const req2 = { ...mockReq, socket: { remoteAddress: '192.168.1.2' } as Socket } as IncomingMessage;
      
      // Use up limit for IP 1
      tunnel.checkRateLimit(req1, mockRes);
      tunnel.checkRateLimit(req1, mockRes);
      tunnel.checkRateLimit(req1, mockRes);
      
      // IP 2 should still be allowed
      expect(tunnel.checkRateLimit(req2, mockRes)).toBe(true);
      
      // IP 1 should be blocked
      expect(tunnel.checkRateLimit(req1, mockRes)).toBe(false);
    });
  });

  describe('CORS Handling', () => {
    let mockReq: IncomingMessage;
    let mockRes: ServerResponse;

    beforeEach(() => {
      mockReq = {
        headers: {},
        method: 'GET'
      } as IncomingMessage;
      
      mockRes = {
        writeHead: jest.fn(),
        end: jest.fn(),
        setHeader: jest.fn()
      } as unknown as ServerResponse;
    });

    it('should allow all origins when * configured', () => {
      tunnel = new SecureTunnel({ allowedOrigins: ['*'] });
      mockReq.headers.origin = 'https://any-site.com';
      
      const result = tunnel.handleCORS(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });

    it('should allow specific configured origin', () => {
      tunnel = new SecureTunnel({ allowedOrigins: ['https://app.com'] });
      mockReq.headers.origin = 'https://app.com';
      
      const result = tunnel.handleCORS(mockReq, mockRes);
      
      expect(result).toBe(true);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.com');
    });

    it('should block non-allowed origin', () => {
      tunnel = new SecureTunnel({ allowedOrigins: ['https://app.com'] });
      mockReq.headers.origin = 'https://evil.com';
      
      const result = tunnel.handleCORS(mockReq, mockRes);
      
      expect(result).toBe(false);
      expect(mockRes.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('Origin not allowed'));
    });

    it('should handle preflight OPTIONS request', () => {
      tunnel = new SecureTunnel({ allowedOrigins: ['*'] });
      mockReq.method = 'OPTIONS';
      
      const result = tunnel.handleCORS(mockReq, mockRes);
      
      expect(result).toBe(false); // Returns false to indicate response was sent
      expect(mockRes.writeHead).toHaveBeenCalledWith(204);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should set proper CORS headers', () => {
      tunnel = new SecureTunnel({ allowedOrigins: ['*'] });
      
      tunnel.handleCORS(mockReq, mockRes);
      
      expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-MCP-Access-Token, X-API-Key'
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
    });
  });

  describe('Ngrok Tunnel Management', () => {
    let mockSpawn: jest.Mock;

    beforeEach(() => {
      mockSpawn = spawn as jest.Mock;
      mockSpawn.mockReturnValue({
        kill: jest.fn(),
        on: jest.fn()
      });
    });

    it('should not start tunnel when ngrok disabled', async () => {
      tunnel = new SecureTunnel({ ngrokEnabled: false });
      
      const url = await tunnel.startTunnel(8080);
      
      expect(url).toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should start tunnel with auth token', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      tunnel = new SecureTunnel();
      
      // Mock fetchTunnelUrl to return immediately
      jest.spyOn(tunnel as any, 'fetchTunnelUrl').mockResolvedValue('https://test.ngrok.io');
      
      const url = await tunnel.startTunnel(8080);
      
      expect(mockSpawn).toHaveBeenCalledWith('ngrok', expect.arrayContaining([
        'http',
        '8080',
        '--region', 'us',
        '--authtoken', 'test-token'
      ]), expect.any(Object));
      
      expect(url).toBe('https://test.ngrok.io');
    });

    it('should add TLS flag when post-quantum enabled', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      process.env.MCP_POST_QUANTUM_TLS = 'true';
      tunnel = new SecureTunnel();
      
      jest.spyOn(tunnel as any, 'fetchTunnelUrl').mockResolvedValue('https://test.ngrok.io');
      
      await tunnel.startTunnel(8080);
      
      expect(mockSpawn).toHaveBeenCalledWith('ngrok', expect.arrayContaining([
        '--bind-tls', 'true'
      ]), expect.any(Object));
    });

    it('should stop tunnel properly', async () => {
      const mockKill = jest.fn();
      tunnel = new SecureTunnel();
      tunnel['ngrokProcess'] = { kill: mockKill };
      tunnel['tunnelUrl'] = 'https://test.ngrok.io';
      
      await tunnel.stopTunnel();
      
      expect(mockKill).toHaveBeenCalled();
      expect(tunnel['ngrokProcess']).toBeNull();
      expect(tunnel.getTunnelUrl()).toBeNull();
    });
  });

  describe('Access Logging', () => {
    let mockReq: IncomingMessage;
    let mockRes: ServerResponse;

    beforeEach(() => {
      mockReq = {
        headers: {
          'user-agent': 'TestAgent/1.0'
        },
        method: 'GET',
        url: '/test',
        socket: {
          remoteAddress: '192.168.1.1'
        } as Socket
      } as IncomingMessage;
      
      mockRes = {
        writeHead: jest.fn(),
        end: jest.fn()
      } as unknown as ServerResponse;
      
      process.env.MCP_ACCESS_TOKEN = 'test-token';
      tunnel = new SecureTunnel({ logAccess: true });
    });

    it('should log successful authentication', () => {
      mockReq.headers.authorization = 'Bearer test-token';
      
      tunnel.authenticateRequest(mockReq, mockRes);
      
      const logs = tunnel.getAccessLogs('192.168.1.1');
      expect(logs).toHaveLength(1);
      expect(logs[0].success).toBe(true);
      expect(logs[0].authType).toBe('bearer');
      expect(logs[0].userAgent).toBe('TestAgent/1.0');
    });

    it('should log failed authentication', () => {
      mockReq.headers.authorization = 'Bearer wrong-token';
      
      tunnel.authenticateRequest(mockReq, mockRes);
      
      const logs = tunnel.getAccessLogs('192.168.1.1');
      expect(logs).toHaveLength(1);
      expect(logs[0].success).toBe(false);
      expect(logs[0].authType).toBe('none');
    });

    it('should retrieve all logs when no IP specified', () => {
      // Log from IP 1
      mockReq.headers.authorization = 'Bearer test-token';
      tunnel.authenticateRequest(mockReq, mockRes);
      
      // Log from IP 2
      const req2 = { 
        ...mockReq, 
        socket: { remoteAddress: '192.168.1.2' } as Socket 
      } as IncomingMessage;
      tunnel.authenticateRequest(req2, mockRes);
      
      const allLogs = tunnel.getAccessLogs();
      expect(allLogs).toHaveLength(2);
    });

    it('should limit logs per IP to 100', () => {
      // Add 105 logs
      for (let i = 0; i < 105; i++) {
        tunnel['logAccess'](mockReq, 'test', true);
      }
      
      const logs = tunnel.getAccessLogs('192.168.1.1');
      expect(logs).toHaveLength(100);
    });
  });

  describe('Helper Functions', () => {
    it('should check if tunnel is active', () => {
      tunnel = new SecureTunnel();
      
      expect(tunnel.isActive()).toBe(false);
      
      tunnel['tunnelUrl'] = 'https://test.ngrok.io';
      expect(tunnel.isActive()).toBe(true);
    });

    it('should get tunnel URL', () => {
      tunnel = new SecureTunnel();
      
      expect(tunnel.getTunnelUrl()).toBeNull();
      
      tunnel['tunnelUrl'] = 'https://test.ngrok.io';
      expect(tunnel.getTunnelUrl()).toBe('https://test.ngrok.io');
    });
  });

  describe('Global Functions', () => {
    it('should create singleton SecureTunnel instance', () => {
      const tunnel1 = getSecureTunnel();
      const tunnel2 = getSecureTunnel();
      
      expect(tunnel1).toBe(tunnel2);
    });

    it('should detect ngrok enablement from environment', () => {
      expect(shouldEnableNgrok()).toBe(false);
      
      process.env.NGROK_API_KEY = 'test-key';
      expect(shouldEnableNgrok()).toBe(true);
      
      delete process.env.NGROK_API_KEY;
      process.env.NGROK_AUTHTOKEN = 'test-token';
      expect(shouldEnableNgrok()).toBe(true);
      
      delete process.env.NGROK_AUTHTOKEN;
      process.env.NGROK_ENABLED = 'true';
      expect(shouldEnableNgrok()).toBe(true);
    });
  });

  describe('Security Features', () => {
    it('should use strong cipher suites for post-quantum TLS', () => {
      tunnel = new SecureTunnel({ enablePostQuantumTls: true });
      
      const ciphers = tunnel['config'].cipherSuites;
      expect(ciphers).toContain('TLS_AES_256_GCM_SHA384');
      expect(ciphers).toContain('TLS_CHACHA20_POLY1305_SHA256');
    });

    it('should generate cryptographically secure tokens', () => {
      tunnel = new SecureTunnel();
      
      const token = tunnel['generateSecureToken']();
      expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      
      // Should be different each time
      const token2 = tunnel['generateSecureToken']();
      expect(token2).not.toBe(token);
    });

    it('should handle X-Forwarded-For header for IP detection', () => {
      const mockReq = {
        headers: {
          'x-forwarded-for': '203.0.113.1, 198.51.100.2'
        },
        socket: {
          remoteAddress: '10.0.0.1'
        } as Socket
      } as IncomingMessage;
      
      tunnel = new SecureTunnel();
      const ip = tunnel['getClientIp'](mockReq);
      
      expect(ip).toBe('203.0.113.1'); // Should use first IP from X-Forwarded-For
    });
  });
});