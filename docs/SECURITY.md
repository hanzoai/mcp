# MCP Search Security Documentation

## Overview

The MCP Search system provides secure, authenticated access to search results and file content. It automatically detects when ngrok credentials are available and establishes a secure tunnel with proper authentication and encryption.

## Security Features

### 1. Automatic Ngrok Detection

The system **ONLY** exposes files over the internet when:
- `NGROK_API_KEY` or `NGROK_AUTHTOKEN` environment variable is set
- OR `NGROK_ENABLED=true` is explicitly set
- Otherwise, MCP remains local-only for security

```bash
# Enable ngrok with API key (recommended)
export NGROK_API_KEY="your-api-key"
export NGROK_AUTHTOKEN="your-auth-token"

# Or explicitly enable (requires auth token)
export NGROK_ENABLED=true
export NGROK_AUTHTOKEN="your-auth-token"

# Disable ngrok (default if no credentials)
export NGROK_ENABLED=false
```

### 2. Authentication Methods

When ngrok is enabled, **authentication is REQUIRED** by default. The system generates a secure random access token if none is configured.

#### Access Token (Default)
```bash
# Set custom access token
export MCP_ACCESS_TOKEN="your-secure-token-here"

# Use in requests
curl -H "Authorization: Bearer your-secure-token-here" https://tunnel.ngrok.io/files/src/index.ts
curl -H "X-MCP-Access-Token: your-secure-token-here" https://tunnel.ngrok.io/files/src/index.ts
```

#### API Keys
```bash
# Configure multiple API keys
export MCP_API_KEYS="key1,key2,key3"

# Use in requests
curl -H "X-API-Key: key1" https://tunnel.ngrok.io/files/src/index.ts
```

#### JWT Tokens (Advanced)
```bash
# Configure JWT secret
export MCP_JWT_SECRET="your-jwt-secret"

# Use JWT bearer token
curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." https://tunnel.ngrok.io/files/src/index.ts
```

### 3. Post-Quantum TLS

Enable post-quantum resistant encryption:

```bash
# Enable post-quantum TLS (when available)
export MCP_POST_QUANTUM_TLS=true
```

Features:
- Forces TLS 1.3 with strongest cipher suites
- Prepares for quantum-resistant algorithms
- Currently uses AES-256-GCM and ChaCha20-Poly1305
- Ready for Kyber and Dilithium when standardized

### 4. Rate Limiting

Automatic rate limiting to prevent abuse:
- Default: 100 requests per minute per IP
- Configurable via environment variables
- Returns 429 Too Many Requests when exceeded

### 5. CORS Protection

Configure allowed origins:
```bash
# Allow specific origins
export MCP_ALLOWED_ORIGINS="https://app.example.com,https://chat.openai.com"

# Allow all origins (not recommended for production)
export MCP_ALLOWED_ORIGINS="*"
```

### 6. File Access Control

Security restrictions:
- Only serves allowed file extensions (source code, docs)
- Maximum file size limit (10MB default)
- Prevents directory traversal attacks
- No access outside workspace root

## Configuration Examples

### Local Development (Default - Secure)
```bash
# No configuration needed - local only
npm start
# Files accessible at: file:///path/to/file.ts
```

### Remote Access for Testing
```bash
# Minimal setup with auto-generated token
export NGROK_AUTHTOKEN="your-ngrok-token"
npm start

# Server output:
# 🔐 Starting secure ngrok tunnel...
# ✅ Secure tunnel established: https://abc123.ngrok.io
# 🔑 Access token: a1b2c3d4e5f6... (auto-generated)
```

### Production Setup
```bash
# Full security configuration
export NGROK_API_KEY="your-ngrok-api-key"
export NGROK_AUTHTOKEN="your-ngrok-token"
export NGROK_REGION="us"
export MCP_ACCESS_TOKEN="strong-random-token-here"
export MCP_POST_QUANTUM_TLS=true
export MCP_ALLOWED_ORIGINS="https://your-app.com"
export MCP_JWT_SECRET="your-jwt-secret"

npm start
```

### ChatGPT Integration
```bash
# Configure for ChatGPT access
export NGROK_AUTHTOKEN="your-token"
export MCP_ACCESS_TOKEN="chatgpt-access-token"
export MCP_ALLOWED_ORIGINS="https://chat.openai.com"

npm start

# Share with ChatGPT:
# - Tunnel URL: https://abc123.ngrok.io
# - Access Token: chatgpt-access-token
# - Search endpoint: https://abc123.ngrok.io/search
# - Files endpoint: https://abc123.ngrok.io/files/
```

## Security Best Practices

### 1. Token Management
- **NEVER** commit access tokens to version control
- Use environment variables or secure vaults
- Rotate tokens regularly
- Use different tokens for different environments

### 2. Environment Files
```bash
# .env.local (git-ignored)
NGROK_AUTHTOKEN=your-token
MCP_ACCESS_TOKEN=secure-random-token
MCP_POST_QUANTUM_TLS=true
```

### 3. Access Logs
The system logs all access attempts:
```javascript
// View access logs programmatically
import { getSecureTunnel } from '@hanzo/mcp/search';

const tunnel = getSecureTunnel();
const logs = tunnel.getAccessLogs();
// Returns: [{timestamp, ip, method, url, authType, success, userAgent}]
```

### 4. Monitoring
Monitor for suspicious activity:
- Failed authentication attempts
- Rate limit violations
- Unusual access patterns
- Unauthorized origin attempts

## API Usage Examples

### Search with Authentication
```javascript
// JavaScript/TypeScript
const response = await fetch('https://tunnel.ngrok.io/search', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: 'function getData' })
});

const results = await response.json();
```

### Fetch File Content
```javascript
const response = await fetch('https://tunnel.ngrok.io/files/src/utils.ts', {
  headers: {
    'X-MCP-Access-Token': accessToken
  }
});

const content = await response.text();
```

### Python Example
```python
import requests

# Search
response = requests.post(
    'https://tunnel.ngrok.io/search',
    headers={'Authorization': f'Bearer {access_token}'},
    json={'query': 'class UserService'}
)
results = response.json()

# Fetch file
response = requests.get(
    'https://tunnel.ngrok.io/files/src/service.py',
    headers={'X-MCP-Access-Token': access_token}
)
content = response.text
```

## Troubleshooting

### Ngrok Not Starting
```bash
# Check if ngrok is installed
ngrok version

# Install ngrok
brew install ngrok  # macOS
# Or download from https://ngrok.com/download

# Verify credentials
ngrok config check
```

### Authentication Failures
1. Check token is correctly set in environment
2. Verify header format (Bearer prefix for Authorization)
3. Check CORS origins if browser-based
4. Review access logs for details

### Rate Limiting Issues
- Default: 100 requests/minute per IP
- Increase limit if needed (not recommended)
- Implement client-side throttling
- Use caching to reduce requests

## Security Incident Response

If you suspect unauthorized access:

1. **Immediately revoke tokens:**
   ```bash
   # Generate new token
   export MCP_ACCESS_TOKEN=$(openssl rand -hex 32)
   # Restart server
   ```

2. **Check access logs:**
   - Review recent authentication attempts
   - Identify suspicious IPs or patterns
   - Export logs for analysis

3. **Rotate ngrok tunnel:**
   - Stop current tunnel
   - Start new tunnel (gets new URL)
   - Update authorized clients with new URL

4. **Enable stricter security:**
   ```bash
   export MCP_POST_QUANTUM_TLS=true
   export MCP_ALLOWED_ORIGINS="https://trusted-domain.com"
   # Use JWT with short expiry instead of static tokens
   ```

## Compliance

The MCP Search security implementation follows:
- OWASP security guidelines
- Zero-trust architecture principles
- Defense in depth strategy
- Principle of least privilege

## Future Enhancements

Planned security improvements:
- Hardware security module (HSM) integration
- Multi-factor authentication (MFA)
- Full post-quantum cryptography suite
- Advanced threat detection
- Security audit logging to SIEM

## Contact

For security concerns or vulnerability reports:
- Email: security@hanzo.ai
- GPG Key: [public key]
- Bug Bounty: https://hanzo.ai/security/bounty