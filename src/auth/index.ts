/**
 * hanzo-mcp cloud auth — IAM OAuth (PKCE) + secure credential store.
 * One way to authenticate; the CloudBackend reads tokens from here.
 */

export {
  authConfig,
  decodeJwt,
  getAccessToken,
  login,
  refresh,
  resolveCredential,
  type AuthConfig,
} from './oauth.js';

export {
  clearCredential,
  credentialLocation,
  getCredential,
  setCredential,
  type Credential,
} from './credentials.js';
