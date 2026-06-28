/**
 * Memory backend selection — one interface, swappable implementations.
 *
 *   HANZO_MEMORY_BACKEND=local   (default) on-disk ~/.hanzo store
 *                       =cloud   hanzo-memory service (requires `auth login`)
 *                       =sync    local-first, write-through to cloud
 *
 * Backends are orthogonal peers that compose; local is never removed. When
 * `cloud` is selected without a token, we fall back to local honestly (with a
 * stderr note) rather than failing.
 */

import { getAccessToken } from '../auth/oauth.js';
import { CloudBackend } from './cloud.js';
import { LocalBackend } from './local.js';
import { SyncBackend } from './sync.js';
import { MemoryBackend } from './types.js';

export type BackendChoice = 'local' | 'cloud' | 'sync';

export function backendChoice(): BackendChoice {
  const c = (process.env.HANZO_MEMORY_BACKEND || 'local').toLowerCase();
  if (c === 'cloud' || c === 'sync') return c;
  return 'local';
}

/**
 * Resolve the active backend. Async because `cloud` selection probes for a
 * token to decide whether to honor the choice or fall back to local.
 */
export async function selectBackend(): Promise<MemoryBackend> {
  const choice = backendChoice();
  const local = new LocalBackend();

  if (choice === 'local') return local;

  if (choice === 'sync') {
    // Local-first: works offline/unauthenticated; cloud replication is additive.
    return new SyncBackend(local, new CloudBackend());
  }

  // choice === 'cloud'
  const token = await getAccessToken().catch(() => null);
  if (!token) {
    console.error(
      '[memory] HANZO_MEMORY_BACKEND=cloud but not authenticated — run `hanzo-mcp auth login`. Falling back to local.',
    );
    return local;
  }
  return new CloudBackend();
}

export { LocalBackend } from './local.js';
export { CloudBackend } from './cloud.js';
export { SyncBackend } from './sync.js';
export * from './types.js';
