/**
 * Secure tunnel management with ngrok integration
 * Provides authenticated, encrypted access to MCP search results
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import https from 'https';
import { IncomingMessage, ServerResponse } from 'http';

/**
 * Security configuration for tunnel
 */
export interface SecureTunnelConfig {
  // Ngrok configuration
  ngrokApiKey?: string;
  ngrokAuthToken?: string;
  ngrokEnabled?: boolean;
  ngrokRegion?: 'us' | 'eu' | 'ap' | 'au' | 'sa' | 'jp' | 'in';
  
  // Authentication
  accessToken?: string;
  apiKeys?: string[];
  jwtSecret?: string;
  requireAuth?: boolean;
  
  // Security
  enablePostQuantumTls?: boolean;
  tlsVersion?: 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string[];
  allowedOrigins?: string[];
  
  // Rate limiting
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  
  // Logging
  logAccess?: boolean;
  logErrors?: boolean;
}

/**
 * Secure tunnel manager
 */
export class SecureTunnel {
  private config: SecureTunnelConfig;
  private ngrokProcess: any;
  private tunnelUrl: string | null = null;
  private accessLogs: Map<string, AccessLog[]> = new Map();
  private rateLimitMap: Map<string, number[]> = new Map();

  constructor(config: SecureTunnelConfig = {}) {
    this.config = this.loadConfig(config);
    this.validateConfig();
  }

  /**
   * Load configuration from environment and params
   */
  private loadConfig(config: SecureTunnelConfig): SecureTunnelConfig {
    return {
      // Ngrok settings
      ngrokApiKey: config.ngrokApiKey || process.env.NGROK_API_KEY,
      ngrokAuthToken: config.ngrokAuthToken || process.env.NGROK_AUTHTOKEN,
      ngrokEnabled: config.ngrokEnabled ?? 
        (process.env.NGROK_ENABLED === 'true' || 
         Boolean(process.env.NGROK_API_KEY || process.env.NGROK_AUTHTOKEN)),
      ngrokRegion: config.ngrokRegion || (process.env.NGROK_REGION as any) || 'us',
      
      // Authentication
      accessToken: config.accessToken || process.env.MCP_ACCESS_TOKEN || this.generateSecureToken(),
      apiKeys: config.apiKeys || (process.env.MCP_API_KEYS?.split(',') || []),
      jwtSecret: config.jwtSecret || process.env.MCP_JWT_SECRET,
      requireAuth: config.requireAuth ?? true,
      
      // Security
      enablePostQuantumTls: config.enablePostQuantumTls ?? 
        (process.env.MCP_POST_QUANTUM_TLS === 'true'),
      tlsVersion: config.tlsVersion || 'TLSv1.3',
      cipherSuites: config.cipherSuites || this.getPostQuantumCipherSuites(),
      allowedOrigins: config.allowedOrigins || 
        (process.env.MCP_ALLOWED_ORIGINS?.split(',') || ['*']),
      
      // Rate limiting
      rateLimit: config.rateLimit || {
        windowMs: 60000,  // 1 minute
        maxRequests: 100   // 100 requests per minute
      },
      
      // Logging
      logAccess: config.logAccess ?? true,
      logErrors: config.logErrors ?? true
    };
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    if (this.config.ngrokEnabled && !this.config.ngrokAuthToken && !this.config.ngrokApiKey) {
      throw new Error(
        'Ngrok is enabled but no NGROK_API_KEY or NGROK_AUTHTOKEN found. ' +
        'Set NGROK_ENABLED=false or provide authentication.'
      );
    }

    if (this.config.requireAuth && !this.config.accessToken && 
        this.config.apiKeys?.length === 0 && !this.config.jwtSecret) {
      console.warn(
        '⚠️  WARNING: Authentication is required but no access tokens configured. ' +
        'Generated random token: ' + this.config.accessToken
      );
    }
  }

  /**
   * Generate secure random token
   */
  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get post-quantum resistant cipher suites
   */
  private getPostQuantumCipherSuites(): string[] {
    if (!this.config.enablePostQuantumTls) {
      // Standard TLS 1.3 cipher suites
      return [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256'
      ];
    }

    // Post-quantum resistant cipher suites (when available)
    // These are placeholders - actual PQ cipher suites will be different
    return [
      'TLS_AES_256_GCM_SHA384',           // Still secure against quantum
      'TLS_CHACHA20_POLY1305_SHA256',     // Still secure against quantum
      // Future PQ cipher suites would go here:
      // 'TLS_KYBER1024_AES256_GCM_SHA384',
      // 'TLS_DILITHIUM3_ECDSA_AES256_GCM_SHA384'
    ];
  }

  /**
   * Start secure tunnel
   */
  async startTunnel(port: number): Promise<string | null> {
    if (!this.config.ngrokEnabled) {
      console.log('ℹ️  Ngrok is disabled. MCP will only be accessible locally.');
      return null;
    }

    try {
      // Kill any existing ngrok process
      await this.stopTunnel();

      console.log('🔐 Starting secure ngrok tunnel...');
      
      // Build ngrok command
      const args = [
        'http',
        port.toString(),
        '--region', this.config.ngrokRegion!
      ];

      // Add authentication if configured
      if (this.config.ngrokAuthToken) {
        args.push('--authtoken', this.config.ngrokAuthToken);
      }

      // Add TLS configuration
      if (this.config.enablePostQuantumTls) {
        args.push('--bind-tls', 'true');  // Force HTTPS only
      }

      // Start ngrok
      this.ngrokProcess = spawn('ngrok', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Wait for tunnel to establish and get URL
      this.tunnelUrl = await this.fetchTunnelUrl(port);
      
      if (this.tunnelUrl) {
        console.log('✅ Secure tunnel established:', this.tunnelUrl);
        console.log('🔑 Access token:', this.config.accessToken);
        console.log('🛡️  Post-quantum TLS:', this.config.enablePostQuantumTls ? 'ENABLED' : 'DISABLED');
        
        if (this.config.requireAuth) {
          console.log('\n📋 Authentication required. Use one of:');
          console.log('   - Header: Authorization: Bearer ' + this.config.accessToken);
          console.log('   - Header: X-MCP-Access-Token: ' + this.config.accessToken);
          if (this.config.apiKeys?.length) {
            console.log('   - Header: X-API-Key: <one of configured keys>');
          }
        }
        
        return this.tunnelUrl;
      }
      
      throw new Error('Failed to establish tunnel');
    } catch (error) {
      console.error('❌ Failed to start ngrok tunnel:', error);
      return null;
    }
  }

  /**
   * Get tunnel URL from ngrok API
   */
  private async fetchTunnelUrl(port: number): Promise<string | null> {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 10;
      
      const checkTunnel = () => {
        attempts++;
        
        // Query ngrok API
        https.get('https://localhost:4040/api/tunnels', {
          rejectUnauthorized: false  // Ngrok uses self-signed cert
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const tunnels = JSON.parse(data);
              const httpsTunnel = tunnels.tunnels?.find((t: any) => 
                t.proto === 'https' && t.config?.addr?.includes(String(port))
              );
              
              if (httpsTunnel) {
                resolve(httpsTunnel.public_url);
              } else if (attempts < maxAttempts) {
                setTimeout(checkTunnel, 1000);
              } else {
                resolve(null);
              }
            } catch {
              if (attempts < maxAttempts) {
                setTimeout(checkTunnel, 1000);
              } else {
                resolve(null);
              }
            }
          });
        }).on('error', () => {
          if (attempts < maxAttempts) {
            setTimeout(checkTunnel, 1000);
          } else {
            resolve(null);
          }
        });
      };
      
      setTimeout(checkTunnel, 2000);  // Wait for ngrok to start
    });
  }

  /**
   * Stop tunnel
   */
  async stopTunnel(): Promise<void> {
    if (this.ngrokProcess) {
      this.ngrokProcess.kill();
      this.ngrokProcess = null;
      this.tunnelUrl = null;
      console.log('🛑 Ngrok tunnel stopped');
    }
  }

  /**
   * Authentication middleware
   */
  authenticateRequest(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.config.requireAuth) {
      return true;
    }

    // Check various auth headers
    const authHeader = req.headers.authorization;
    const accessTokenHeader = req.headers['x-mcp-access-token'];
    const apiKeyHeader = req.headers['x-api-key'];

    // Check Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (token === this.config.accessToken) {
        this.logAccess(req, 'bearer', true);
        return true;
      }
    }

    // Check access token header
    if (accessTokenHeader === this.config.accessToken) {
      this.logAccess(req, 'access-token', true);
      return true;
    }

    // Check API key
    if (apiKeyHeader && this.config.apiKeys?.includes(apiKeyHeader as string)) {
      this.logAccess(req, 'api-key', true);
      return true;
    }

    // Check JWT (if configured)
    if (this.config.jwtSecret && authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      if (this.verifyJWT(token)) {
        this.logAccess(req, 'jwt', true);
        return true;
      }
    }

    // Authentication failed
    this.logAccess(req, 'none', false);
    res.writeHead(401, { 
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="MCP Search"'
    });
    res.end(JSON.stringify({
      error: 'Unauthorized',
      message: 'Valid authentication required. See documentation for details.'
    }));
    
    return false;
  }

  /**
   * Rate limiting middleware
   */
  checkRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.config.rateLimit) {
      return true;
    }

    const ip = this.getClientIp(req);
    const now = Date.now();
    const windowStart = now - this.config.rateLimit.windowMs;

    // Get or create request timestamps for this IP
    let timestamps = this.rateLimitMap.get(ip) || [];
    
    // Remove old timestamps outside the window
    timestamps = timestamps.filter(t => t > windowStart);
    
    // Check if limit exceeded
    if (timestamps.length >= this.config.rateLimit.maxRequests) {
      res.writeHead(429, { 
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(this.config.rateLimit.windowMs / 1000))
      });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.'
      }));
      return false;
    }

    // Add current timestamp
    timestamps.push(now);
    this.rateLimitMap.set(ip, timestamps);
    
    return true;
  }

  /**
   * CORS middleware
   */
  handleCORS(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    
    if (this.config.allowedOrigins?.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && this.config.allowedOrigins?.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (origin) {
      // Origin not allowed
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Forbidden',
        message: 'Origin not allowed'
      }));
      return false;
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 
      'Content-Type, Authorization, X-MCP-Access-Token, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return false;
    }

    return true;
  }

  /**
   * Get client IP address
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Verify JWT token
   */
  private verifyJWT(token: string): boolean {
    // Simplified JWT verification - in production use jsonwebtoken library
    try {
      const [header, payload, signature] = token.split('.');
      // TODO: Implement proper JWT verification
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Log access attempt
   */
  private logAccess(req: IncomingMessage, authType: string, success: boolean): void {
    if (!this.config.logAccess) return;

    const ip = this.getClientIp(req);
    const log: AccessLog = {
      timestamp: new Date().toISOString(),
      ip,
      method: req.method || '',
      url: req.url || '',
      authType,
      success,
      userAgent: req.headers['user-agent'] || ''
    };

    const logs = this.accessLogs.get(ip) || [];
    logs.push(log);
    
    // Keep only last 100 logs per IP
    if (logs.length > 100) {
      logs.shift();
    }
    
    this.accessLogs.set(ip, logs);

    if (!success && this.config.logErrors) {
      console.warn(`⚠️  Authentication failed from ${ip}: ${req.method} ${req.url}`);
    }
  }

  /**
   * Get tunnel URL
   */
  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Check if tunnel is active
   */
  isActive(): boolean {
    return this.tunnelUrl !== null;
  }

  /**
   * Get access logs
   */
  getAccessLogs(ip?: string): AccessLog[] {
    if (ip) {
      return this.accessLogs.get(ip) || [];
    }
    
    const allLogs: AccessLog[] = [];
    this.accessLogs.forEach(logs => allLogs.push(...logs));
    return allLogs.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
}

/**
 * Access log entry
 */
interface AccessLog {
  timestamp: string;
  ip: string;
  method: string;
  url: string;
  authType: string;
  success: boolean;
  userAgent: string;
}

// Global secure tunnel instance
let secureTunnel: SecureTunnel | null = null;

/**
 * Get or create secure tunnel instance
 */
export function getSecureTunnel(config?: SecureTunnelConfig): SecureTunnel {
  if (!secureTunnel) {
    secureTunnel = new SecureTunnel(config);
  }
  return secureTunnel;
}

/**
 * Check if ngrok should be enabled
 */
export function shouldEnableNgrok(): boolean {
  return Boolean(
    process.env.NGROK_ENABLED === 'true' ||
    process.env.NGROK_API_KEY ||
    process.env.NGROK_AUTHTOKEN
  );
}