/**
 * Hanzo Cloud — each service is ONE tool with action routing
 *
 * IAM  (iam.hanzo.ai)        — identity: users, orgs, roles, apps, providers, tokens
 * KMS  (kms.hanzo.ai)        — secrets: CRUD, rotate, versions, folders, audit
 * PaaS (platform.hanzo.ai)   — platform: projects, envs, containers, domains, scaling
 * Commerce (api.hanzo.ai/v1) — full commerce engine (products, orders, carts, checkout,
 *                               subscriptions, billing, collections, coupons, discounts,
 *                               customers, inventory, stores, fulfillment, analytics,
 *                               referrals, affiliates, webhooks, reviews, promotions,
 *                               pricing, tax, returns, payment methods, invoices, meters)
 * Storage (api.hanzo.ai/v1)  — object storage: buckets, objects, upload, presign
 * Auth (iam.hanzo.ai)        — authentication: login, token, account, sessions, whoami, mfa
 * API  (api.hanzo.ai/v1)     — LLM gateway: models, chat, embeddings, images, audio, files
 */

import { Tool } from '../types/index.js';

const API_URL  = process.env.API_URL  || 'https://api.hanzo.ai';
const IAM_URL  = process.env.IAM_URL  || 'https://iam.hanzo.ai';
const KMS_URL  = process.env.KMS_URL  || 'https://kms.hanzo.ai';
const PAAS_URL = process.env.PAAS_URL || 'https://platform.hanzo.ai';

function token(): string { return process.env.HANZO_API_KEY || process.env.API_KEY || process.env.API_TOKEN || process.env.HANZO_TOKEN || ''; }

async function api(base: string, path: string, opts: RequestInit = {}): Promise<any> {
  const t = token();
  if (!t) throw new Error('HANZO_API_KEY required');
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}`, ...(opts.headers || {}) } });
  if (!r.ok) { const b = await r.text().catch(() => ''); throw new Error(`${r.status}: ${b.substring(0, 200)}`); }
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

function j(d: any): string { return JSON.stringify(d, null, 2); }
function ok(t: string) { return { content: [{ type: 'text' as const, text: t }] }; }
function fail(m: string) { return { content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true as const }; }
function arr(d: any, ...keys: string[]): any[] {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
  return d?.data || [];
}

// =============================================
// IAM — identity, users, orgs, roles, apps, providers, tokens
// =============================================

export const iamTool: Tool = {
  name: 'iam',
  description: 'Identity & access management: users, orgs, roles, apps, providers, tokens, permissions, sessions',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list_users', 'get_user', 'create_user', 'update_user', 'delete_user',
        'list_orgs', 'get_org', 'create_org', 'update_org', 'delete_org',
        'list_roles', 'get_role', 'create_role', 'update_role', 'delete_role',
        'list_apps', 'get_app', 'create_app',
        'list_providers', 'list_tokens', 'create_token', 'delete_token',
        'list_permissions', 'assign_role', 'remove_role',
        'list_sessions', 'delete_session',
        'health'
      ] },
      owner: { type: 'string', default: 'admin' },
      id: { type: 'string', description: 'Entity ID (owner/name format for users)' },
      name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' },
      displayName: { type: 'string' }, phone: { type: 'string' },
      organization: { type: 'string', default: 'hanzo' },
      role: { type: 'string', description: 'Role name (assign_role, remove_role)' },
      user: { type: 'string', description: 'User ID (assign_role, remove_role)' },
      data: { type: 'object', description: 'Create/update payload' },
      limit: { type: 'number', default: 50 }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const o = args.owner || 'admin';
      const lim = args.limit || 50;
      switch (args.action) {
        case 'list_users': {
          const u = arr(await api(IAM_URL, `/api/get-users?owner=${o}&limit=${lim}`));
          return ok(`Users (${u.length}):\n${u.map((x: any) => `${x.name} <${x.email || ''}> [${x.type || 'normal-user'}]`).join('\n')}`);
        }
        case 'get_user': {
          if (!args.id) return fail('id required');
          return ok(j(await api(IAM_URL, `/api/get-user?id=${args.id.includes('/') ? args.id : `admin/${args.id}`}`)));
        }
        case 'create_user': {
          if (!args.name || !args.email || !args.password) return fail('name, email, password required');
          await api(IAM_URL, '/api/add-user', { method: 'POST', body: JSON.stringify({ owner: o, name: args.name, email: args.email, password: args.password, organization: args.organization || 'hanzo', type: 'normal-user' }) });
          return ok(`Created: ${args.name} <${args.email}>`);
        }
        case 'update_user': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const u = await api(IAM_URL, `/api/get-user?id=${id}`);
          if (args.email) u.email = args.email;
          if (args.displayName) u.displayName = args.displayName;
          if (args.phone) u.phone = args.phone;
          if (args.data) Object.assign(u, args.data);
          await api(IAM_URL, '/api/update-user', { method: 'POST', body: JSON.stringify(u) });
          return ok(`Updated: ${id}`);
        }
        case 'delete_user': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const [ow, nm] = id.split('/');
          await api(IAM_URL, '/api/delete-user', { method: 'POST', body: JSON.stringify({ owner: ow, name: nm }) });
          return ok(`Deleted: ${id}`);
        }
        case 'list_orgs': {
          const orgs = arr(await api(IAM_URL, `/api/get-organizations?owner=${o}`));
          return ok(`Orgs (${orgs.length}):\n${orgs.map((x: any) => `${x.name}: ${x.displayName || ''} [${(x.users || []).length} members]`).join('\n')}`);
        }
        case 'get_org': {
          if (!args.id) return fail('id required');
          return ok(j(await api(IAM_URL, `/api/get-organization?id=${args.id.includes('/') ? args.id : `admin/${args.id}`}`)));
        }
        case 'create_org': {
          if (!args.name) return fail('name required');
          await api(IAM_URL, '/api/add-organization', { method: 'POST', body: JSON.stringify({ owner: o, name: args.name, displayName: args.displayName || args.name, ...(args.data || {}) }) });
          return ok(`Created org: ${args.name}`);
        }
        case 'update_org': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const org = await api(IAM_URL, `/api/get-organization?id=${id}`);
          if (args.displayName) org.displayName = args.displayName;
          if (args.data) Object.assign(org, args.data);
          await api(IAM_URL, '/api/update-organization', { method: 'POST', body: JSON.stringify(org) });
          return ok(`Updated org: ${id}`);
        }
        case 'delete_org': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const [ow, nm] = id.split('/');
          await api(IAM_URL, '/api/delete-organization', { method: 'POST', body: JSON.stringify({ owner: ow, name: nm }) });
          return ok(`Deleted org: ${id}`);
        }
        case 'list_roles': {
          const roles = arr(await api(IAM_URL, `/api/get-roles?owner=${o}`));
          return ok(`Roles (${roles.length}):\n${roles.map((x: any) => `${x.name}: ${(x.users || []).length} users, ${(x.roles || []).length} sub-roles`).join('\n')}`);
        }
        case 'get_role': {
          if (!args.id) return fail('id required');
          return ok(j(await api(IAM_URL, `/api/get-role?id=${args.id.includes('/') ? args.id : `admin/${args.id}`}`)));
        }
        case 'create_role': {
          if (!args.name) return fail('name required');
          await api(IAM_URL, '/api/add-role', { method: 'POST', body: JSON.stringify({ owner: o, name: args.name, displayName: args.displayName || args.name, ...(args.data || {}) }) });
          return ok(`Created role: ${args.name}`);
        }
        case 'update_role': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const role = await api(IAM_URL, `/api/get-role?id=${id}`);
          if (args.data) Object.assign(role, args.data);
          await api(IAM_URL, '/api/update-role', { method: 'POST', body: JSON.stringify(role) });
          return ok(`Updated role: ${id}`);
        }
        case 'delete_role': {
          if (!args.id) return fail('id required');
          const id = args.id.includes('/') ? args.id : `admin/${args.id}`;
          const [ow, nm] = id.split('/');
          await api(IAM_URL, '/api/delete-role', { method: 'POST', body: JSON.stringify({ owner: ow, name: nm }) });
          return ok(`Deleted role: ${id}`);
        }
        case 'list_apps': {
          const apps = arr(await api(IAM_URL, `/api/get-applications?owner=${o}`));
          return ok(`Apps (${apps.length}):\n${apps.map((x: any) => `${x.name}: ${x.displayName || ''} [${x.clientId || ''}]`).join('\n')}`);
        }
        case 'get_app': {
          if (!args.id) return fail('id required');
          return ok(j(await api(IAM_URL, `/api/get-application?id=${args.id.includes('/') ? args.id : `admin/${args.id}`}`)));
        }
        case 'create_app': {
          if (!args.name) return fail('name required');
          await api(IAM_URL, '/api/add-application', { method: 'POST', body: JSON.stringify({ owner: o, name: args.name, displayName: args.displayName || args.name, organization: args.organization || 'hanzo', ...(args.data || {}) }) });
          return ok(`Created app: ${args.name}`);
        }
        case 'list_providers': return ok(j(await api(IAM_URL, `/api/get-providers?owner=${o}`)));
        case 'list_tokens': return ok(j(await api(IAM_URL, `/api/get-tokens?owner=${o}&limit=${lim}`)));
        case 'create_token': {
          if (!args.name) return fail('name required');
          return ok(j(await api(IAM_URL, '/api/add-token', { method: 'POST', body: JSON.stringify({ owner: o, name: args.name, ...(args.data || {}) }) })));
        }
        case 'delete_token': {
          if (!args.id) return fail('id required');
          await api(IAM_URL, '/api/delete-token', { method: 'POST', body: JSON.stringify({ owner: o, name: args.id }) });
          return ok(`Deleted token: ${args.id}`);
        }
        case 'list_permissions': return ok(j(await api(IAM_URL, `/api/get-permissions?owner=${o}`)));
        case 'assign_role': {
          if (!args.role || !args.user) return fail('role and user required');
          const r = await api(IAM_URL, `/api/get-role?id=${args.role.includes('/') ? args.role : `admin/${args.role}`}`);
          r.users = r.users || [];
          r.users.push(args.user);
          await api(IAM_URL, '/api/update-role', { method: 'POST', body: JSON.stringify(r) });
          return ok(`Assigned role ${args.role} to ${args.user}`);
        }
        case 'remove_role': {
          if (!args.role || !args.user) return fail('role and user required');
          const r = await api(IAM_URL, `/api/get-role?id=${args.role.includes('/') ? args.role : `admin/${args.role}`}`);
          r.users = (r.users || []).filter((u: string) => u !== args.user);
          await api(IAM_URL, '/api/update-role', { method: 'POST', body: JSON.stringify(r) });
          return ok(`Removed role ${args.role} from ${args.user}`);
        }
        case 'list_sessions': return ok(j(await api(IAM_URL, `/api/get-sessions?owner=${o}&limit=${lim}`)));
        case 'delete_session': {
          if (!args.id) return fail('id required');
          await api(IAM_URL, '/api/delete-session', { method: 'POST', body: JSON.stringify({ owner: o, name: args.id }) });
          return ok(`Deleted session: ${args.id}`);
        }
        case 'health': return ok(j(await api(IAM_URL, '/api/health')));
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// KMS — secrets management with rotate, versions, folders, audit
// =============================================

export const kmsTool: Tool = {
  name: 'kms',
  description: 'Secrets management: list, get, create, update, delete, rotate, versions, folders, audit, import, export',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list', 'get', 'create', 'update', 'delete',
        'rotate', 'versions', 'rollback',
        'folders', 'create_folder',
        'audit', 'import', 'export',
        'projects', 'environments'
      ] },
      project: { type: 'string', description: 'Project slug' },
      key: { type: 'string', description: 'Secret name' },
      value: { type: 'string', description: 'Secret value' },
      environment: { type: 'string', default: 'production' },
      path: { type: 'string', default: '/' },
      comment: { type: 'string' },
      version: { type: 'number', description: 'Secret version (rollback)' },
      folder: { type: 'string', description: 'Folder name (create_folder)' },
      secrets: { type: 'object', description: 'Key-value map for batch import' },
      limit: { type: 'number', default: 50 }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const env = args.environment || 'production';
      const sp = encodeURIComponent(args.path || '/');
      switch (args.action) {
        case 'list': {
          if (!args.project) return fail('project required');
          const s = arr(await api(KMS_URL, `/api/v3/secrets?workspaceSlug=${args.project}&environment=${env}&secretPath=${sp}`), 'secrets');
          return ok(`Secrets (${s.length}):\n${s.map((x: any) => `${x.secretKey || x.key}: ${(x.secretValue || x.value || '').substring(0, 8)}...`).join('\n')}`);
        }
        case 'get': {
          if (!args.project || !args.key) return fail('project and key required');
          return ok(j(await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(args.key)}?workspaceSlug=${args.project}&environment=${env}&secretPath=${sp}`)));
        }
        case 'create': {
          if (!args.project || !args.key || !args.value) return fail('project, key, value required');
          await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(args.key)}`, { method: 'POST', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/', secretValue: args.value, secretComment: args.comment || '' }) });
          return ok(`Created: ${args.key}`);
        }
        case 'update': {
          if (!args.project || !args.key || !args.value) return fail('project, key, value required');
          await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(args.key)}`, { method: 'PATCH', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/', secretValue: args.value }) });
          return ok(`Updated: ${args.key}`);
        }
        case 'delete': {
          if (!args.project || !args.key) return fail('project and key required');
          await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(args.key)}`, { method: 'DELETE', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/' }) });
          return ok(`Deleted: ${args.key}`);
        }
        case 'rotate': {
          if (!args.project || !args.key || !args.value) return fail('project, key, new value required');
          await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(args.key)}`, { method: 'PATCH', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/', secretValue: args.value }) });
          return ok(`Rotated: ${args.key} (new version created)`);
        }
        case 'versions': {
          if (!args.project || !args.key) return fail('project and key required');
          const d = await api(KMS_URL, `/api/v1/secret/${encodeURIComponent(args.key)}/versions?workspaceSlug=${args.project}&environment=${env}&secretPath=${sp}`);
          const v = arr(d, 'versions', 'secretVersions');
          return ok(`Versions of ${args.key} (${v.length}):\n${v.map((x: any, i: number) => `v${x.version || i + 1}: ${x.createdAt || ''} ${x.secretValue ? x.secretValue.substring(0, 8) + '...' : ''}`).join('\n')}`);
        }
        case 'rollback': {
          if (!args.project || !args.key || !args.version) return fail('project, key, version required');
          await api(KMS_URL, `/api/v1/secret/${encodeURIComponent(args.key)}/rollback`, { method: 'POST', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/', version: args.version }) });
          return ok(`Rolled back ${args.key} to v${args.version}`);
        }
        case 'folders': {
          if (!args.project) return fail('project required');
          const d = await api(KMS_URL, `/api/v1/folders?workspaceSlug=${args.project}&environment=${env}&parentPath=${sp}`);
          const f = arr(d, 'folders');
          return ok(`Folders:\n${f.map((x: any) => `${x.name || x.id}`).join('\n') || '(root only)'}`);
        }
        case 'create_folder': {
          if (!args.project || !args.folder) return fail('project and folder required');
          await api(KMS_URL, '/api/v1/folders', { method: 'POST', body: JSON.stringify({ workspaceSlug: args.project, environment: env, folderName: args.folder, parentPath: args.path || '/' }) });
          return ok(`Created folder: ${args.folder}`);
        }
        case 'audit': {
          if (!args.project) return fail('project required');
          const d = await api(KMS_URL, `/api/v1/audit-logs?workspaceSlug=${args.project}&limit=${args.limit || 50}`);
          const logs = arr(d, 'auditLogs', 'logs');
          return ok(`Audit (${logs.length}):\n${logs.map((x: any) => `${x.createdAt || ''} ${x.actor || ''}: ${x.event || x.action || ''} ${x.secretKey || ''}`).join('\n')}`);
        }
        case 'import': {
          if (!args.project || !args.secrets) return fail('project and secrets (key-value map) required');
          let count = 0;
          for (const [k, v] of Object.entries(args.secrets)) {
            await api(KMS_URL, `/api/v3/secrets/${encodeURIComponent(k)}`, { method: 'POST', body: JSON.stringify({ workspaceSlug: args.project, environment: env, secretPath: args.path || '/', secretValue: String(v) }) });
            count++;
          }
          return ok(`Imported ${count} secrets`);
        }
        case 'export': {
          if (!args.project) return fail('project required');
          const s = arr(await api(KMS_URL, `/api/v3/secrets?workspaceSlug=${args.project}&environment=${env}&secretPath=${sp}`), 'secrets');
          const map: Record<string, string> = {};
          for (const x of s) map[x.secretKey || x.key] = x.secretValue || x.value || '';
          return ok(j(map));
        }
        case 'projects': return ok(j(await api(KMS_URL, '/api/v2/workspace')));
        case 'environments': {
          if (!args.project) return fail('project required');
          return ok(j(await api(KMS_URL, `/api/v2/workspace/${args.project}/environments`)));
        }
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// PaaS — platform deployments, scaling, domains, env vars
// =============================================

export const paasTool: Tool = {
  name: 'paas',
  description: 'Platform as a Service: projects, environments, containers, deploy, scale, restart, domains, env vars, rollback, metrics, builds, logs',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list', 'get', 'deploy', 'delete', 'logs',
        'scale', 'restart', 'status',
        'domains', 'add_domain', 'remove_domain',
        'env_vars', 'set_env', 'unset_env',
        'rollback', 'builds', 'metrics',
        'environments', 'create_env', 'containers'
      ] },
      org: { type: 'string', default: 'hanzo' },
      project: { type: 'string' }, environment: { type: 'string' }, container: { type: 'string' },
      image: { type: 'string' }, env: { type: 'object', description: 'Env vars map' },
      domain: { type: 'string' },
      replicas: { type: 'number', description: 'Scale target' },
      cpu: { type: 'string', description: 'CPU limit (e.g., "500m", "2")' },
      memory: { type: 'string', description: 'Memory limit (e.g., "512Mi", "2Gi")' },
      version: { type: 'string', description: 'Rollback target version/build' },
      key: { type: 'string', description: 'Env var key' },
      value: { type: 'string', description: 'Env var value' },
      lines: { type: 'number', default: 100 }, since: { type: 'string' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      const org = args.org || 'hanzo';
      const base = `/v1/org/${org}`;
      switch (args.action) {
        case 'list': {
          const d = await api(PAAS_URL, `${base}/project`);
          const p = arr(d, 'projects');
          return ok(`Projects (${p.length}):\n${p.map((x: any) => `${x.name || x.iid}: [${x.environments?.length || 0} envs]`).join('\n')}`);
        }
        case 'get': {
          if (!args.project) return fail('project required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}`)));
        }
        case 'deploy': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          const body: any = {};
          if (args.image) body.image = args.image;
          if (args.env) body.variables = args.env;
          if (args.replicas) body.replicas = args.replicas;
          if (args.cpu) body.cpuLimit = args.cpu;
          if (args.memory) body.memoryLimit = args.memory;
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}`, { method: 'PUT', body: JSON.stringify(body) })));
        }
        case 'delete': {
          if (!args.project) return fail('project required');
          await api(PAAS_URL, `${base}/project/${args.project}`, { method: 'DELETE' });
          return ok(`Deleted: ${args.project}`);
        }
        case 'logs': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          const params = `lines=${args.lines || 100}${args.since ? `&since=${args.since}` : ''}`;
          const d = await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/logs?${params}`);
          return ok(typeof d === 'string' ? d : d?.logs || j(d));
        }
        case 'scale': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          if (!args.replicas) return fail('replicas required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/scale`, { method: 'POST', body: JSON.stringify({ replicas: args.replicas }) })));
        }
        case 'restart': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/restart`, { method: 'POST' })));
        }
        case 'status': {
          if (!args.project) return fail('project required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/status`)));
        }
        case 'domains': {
          if (!args.project || !args.environment) return fail('project and environment required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/domains`)));
        }
        case 'add_domain': {
          if (!args.project || !args.environment || !args.domain) return fail('project, environment, domain required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/domains`, { method: 'POST', body: JSON.stringify({ domain: args.domain }) })));
        }
        case 'remove_domain': {
          if (!args.project || !args.environment || !args.domain) return fail('project, environment, domain required');
          await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/domains/${encodeURIComponent(args.domain)}`, { method: 'DELETE' });
          return ok(`Removed domain: ${args.domain}`);
        }
        case 'env_vars': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/variables`)));
        }
        case 'set_env': {
          if (!args.project || !args.environment || !args.container || !args.key || !args.value) return fail('project, environment, container, key, value required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/variables`, { method: 'POST', body: JSON.stringify({ [args.key]: args.value }) })));
        }
        case 'unset_env': {
          if (!args.project || !args.environment || !args.container || !args.key) return fail('project, environment, container, key required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/variables/${encodeURIComponent(args.key)}`, { method: 'DELETE' })));
        }
        case 'rollback': {
          if (!args.project || !args.environment || !args.container || !args.version) return fail('project, environment, container, version required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/rollback`, { method: 'POST', body: JSON.stringify({ version: args.version }) })));
        }
        case 'builds': {
          if (!args.project) return fail('project required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/builds?limit=${args.lines || 20}`)));
        }
        case 'metrics': {
          if (!args.project || !args.environment || !args.container) return fail('project, environment, container required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container/${args.container}/metrics`)));
        }
        case 'environments': {
          if (!args.project) return fail('project required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env`)));
        }
        case 'create_env': {
          if (!args.project || !args.environment) return fail('project and environment required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env`, { method: 'POST', body: JSON.stringify({ name: args.environment }) })));
        }
        case 'containers': {
          if (!args.project || !args.environment) return fail('project and environment required');
          return ok(j(await api(PAAS_URL, `${base}/project/${args.project}/env/${args.environment}/container`)));
        }
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// Commerce — full commerce engine (absorbs billing)
// Products, orders, carts, checkout, subscriptions, billing,
// collections, coupons, discounts, customers, inventory,
// stores, fulfillment, analytics, referrals, affiliates,
// webhooks, reviews, promotions, pricing, tax, returns
// =============================================

const COMMERCE_RESOURCES: Record<string, { path: string; label: string; hint: string }> = {
  products:      { path: '/v1/product',           label: 'Products',      hint: 'list, get, create, update, delete, search' },
  orders:        { path: '/v1/order',             label: 'Orders',        hint: 'list, get, create, update, authorize, capture, charge, refund, status, payments, returns, confirm' },
  carts:         { path: '/v1/cart',              label: 'Carts',         hint: 'get, create, update, set, discard' },
  checkout:      { path: '/v1/checkout',          label: 'Checkout',      hint: 'authorize, charge, capture, confirm, cancel, session' },
  subscriptions: { path: '/v1/subscribe',         label: 'Subscriptions', hint: 'list, get, create, update, cancel, apply_promotion' },
  billing:       { path: '/v1/billing',           label: 'Billing',       hint: 'balance, usage, invoices, plans, payment_methods, deposit, credit, refund, disputes, payouts, meters, portal, tier, events' },
  collections:   { path: '/v1/collection',        label: 'Collections',   hint: 'list, get, create, update, delete' },
  coupons:       { path: '/v1/coupon',            label: 'Coupons',       hint: 'list, get, create, update, delete, generate_codes' },
  discounts:     { path: '/v1/discount',          label: 'Discounts',     hint: 'list, get, create, update, delete' },
  customers:     { path: '/v1/customergroup',     label: 'Customers',     hint: 'list, get, create, update, delete, members, add_member, remove_member' },
  inventory:     { path: '/v1/inventory',         label: 'Inventory',     hint: 'list, get, create, update, delete, adjust' },
  stores:        { path: '/v1/store',             label: 'Stores',        hint: 'list, get, create, update, delete, listings' },
  fulfillment:   { path: '/v1/fulfillment',       label: 'Fulfillment',   hint: 'ship, cancel, track' },
  analytics:     { path: '/v1/counter',           label: 'Analytics',     hint: 'dashboard, topline, events' },
  referrals:     { path: '/v1/referral',          label: 'Referrals',     hint: 'list, get, create' },
  affiliates:    { path: '/v1/affiliate',         label: 'Affiliates',    hint: 'list, get, create, connect' },
  webhooks:      { path: '/v1/webhook-endpoints', label: 'Webhooks',      hint: 'list, get, create, update, delete' },
  reviews:       { path: '/v1/review',            label: 'Reviews',       hint: 'list, get, create, update, delete' },
  promotions:    { path: '/v1/promotion',         label: 'Promotions',    hint: 'list, get, create, update, delete, evaluate' },
  pricing:       { path: '/v1/pricing',           label: 'Pricing',       hint: 'calculate, rules, create_rule, update_rule, delete_rule' },
  tax:           { path: '/v1/tax',               label: 'Tax',           hint: 'calculate, rates, regions' },
  returns:       { path: '/v1/return',            label: 'Returns',       hint: 'list, get, create, update' },
};

export const commerceTool: Tool = {
  name: 'commerce',
  description: 'Full commerce engine with billing: ' + Object.keys(COMMERCE_RESOURCES).join(', ') + '. Call with just resource to see available actions. Covers products, orders, carts, checkout, subscriptions, billing (balance/usage/invoices/credits/payment methods/meters/disputes/payouts), collections, coupons, discounts, customers, inventory, stores, fulfillment, analytics, referrals, affiliates, webhooks, reviews, promotions, pricing, tax, returns.',
  inputSchema: {
    type: 'object',
    properties: {
      resource: { type: 'string', enum: Object.keys(COMMERCE_RESOURCES), description: 'Commerce resource. Omit to see all available resources.' },
      action: { type: 'string', description: 'Operation to perform. Call with just resource to discover available actions.' },
      id: { type: 'string', description: 'Resource ID' },
      data: { type: 'object', description: 'Create/update payload (all fields)' },
      query: { type: 'string', description: 'Search query or filter' },
      status: { type: 'string', description: 'Filter by status' },
      limit: { type: 'number', default: 50 },
      page: { type: 'number', default: 1 },
      period: { type: 'string', description: 'Billing period: current, previous, YYYY-MM' },
      amount: { type: 'number', description: 'Amount in cents (deposit, credit, refund)' },
      currency: { type: 'string', default: 'usd' },
      user: { type: 'string', description: 'User scope (billing)' },
      code: { type: 'string', description: 'Coupon/promotion code' },
      count: { type: 'number', description: 'Number of codes to generate' },
      items: { type: 'array', items: { type: 'object' }, description: 'Line items (cart, order)' },
      address: { type: 'object', description: 'Shipping/billing address' },
      member: { type: 'string', description: 'Member user ID (customers)' },
      adjustment: { type: 'number', description: 'Stock adjustment quantity' },
    },
    required: []
  },
  handler: async (args) => {
    try {
      // Progressive reveal: no resource → show all resources
      if (!args.resource) {
        const lines = Object.entries(COMMERCE_RESOURCES).map(([k, v]) => `${k}: ${v.hint}`);
        return ok(`Commerce resources (${lines.length}):\n\n${lines.join('\n')}\n\nCall with resource to see actions, or resource + action to execute.`);
      }

      const res = COMMERCE_RESOURCES[args.resource];
      if (!res) return fail(`Unknown resource: ${args.resource}. Available: ${Object.keys(COMMERCE_RESOURCES).join(', ')}`);

      // Progressive reveal: resource but no action → show actions
      if (!args.action) {
        return ok(`${res.label} — available actions: ${res.hint}\n\nCall with action to execute. Most actions support: id, data, query, limit, page, status.`);
      }

      const act = args.action;
      const lim = args.limit || 50;

      // Generic CRUD for simple resources
      const simpleCRUD = ['collections', 'coupons', 'discounts', 'reviews', 'promotions', 'returns', 'webhooks', 'referrals', 'affiliates'];
      if (simpleCRUD.includes(args.resource) && ['list', 'get', 'create', 'update', 'delete'].includes(act)) {
        switch (act) {
          case 'list': {
            const q = args.query ? `&q=${encodeURIComponent(args.query)}` : '';
            const d = arr(await api(API_URL, `${res.path}?limit=${lim}${q}${args.status ? `&status=${args.status}` : ''}`));
            return ok(`${res.label} (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.name || x.code || x.title || x.url || j(x).substring(0, 60)}`).join('\n')}`);
          }
          case 'get': {
            if (!args.id) return fail('id required');
            return ok(j(await api(API_URL, `${res.path}/${args.id}`)));
          }
          case 'create':
            return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
          case 'update': {
            if (!args.id) return fail('id required');
            return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) })));
          }
          case 'delete': {
            if (!args.id) return fail('id required');
            await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE' });
            return ok(`Deleted ${args.resource}: ${args.id}`);
          }
        }
      }

      // Resource-specific handlers
      switch (args.resource) {
        // ---- Products ----
        case 'products': {
          switch (act) {
            case 'list': {
              const q = args.query ? `&q=${encodeURIComponent(args.query)}` : '';
              const d = arr(await api(API_URL, `${res.path}?limit=${lim}${q}`), 'products');
              return ok(`Products (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.name} $${((x.price || 0) / 100).toFixed(2)} [${x.sku || ''}]`).join('\n')}`);
            }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'delete': { if (!args.id) return fail('id required'); await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE' }); return ok(`Deleted product: ${args.id}`); }
            case 'search': {
              if (!args.query) return fail('query required');
              return ok(j(await api(API_URL, `/v1/search/product?q=${encodeURIComponent(args.query)}&limit=${lim}`)));
            }
            default: return fail(`Products: ${res.hint}`);
          }
        }

        // ---- Orders ----
        case 'orders': {
          switch (act) {
            case 'list': {
              const q = args.status ? `&status=${args.status}` : '';
              const d = arr(await api(API_URL, `${res.path}?limit=${lim}${q}`), 'orders');
              return ok(`Orders (${d.length}):\n${d.map((x: any) => `${x.id}: $${((x.total || 0) / 100).toFixed(2)} ${x.status || ''}`).join('\n')}`);
            }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || { items: args.items || [] }) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'authorize': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/authorize`, { method: 'POST' }))); }
            case 'capture': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/capture`, { method: 'POST' }))); }
            case 'charge': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/charge`, { method: 'POST' }))); }
            case 'refund': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/refund`, { method: 'POST', body: JSON.stringify(args.amount ? { amount: args.amount } : {}) }))); }
            case 'status': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/status`))); }
            case 'payments': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/payments`))); }
            case 'returns': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/returns`))); }
            case 'confirm': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/confirm`, { method: 'POST' }))); }
            default: return fail(`Orders: ${res.hint}`);
          }
        }

        // ---- Carts ----
        case 'carts': {
          switch (act) {
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || { items: args.items || [] }) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PUT', body: JSON.stringify(args.data || {}) }))); }
            case 'set': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/set`, { method: 'POST', body: JSON.stringify({ items: args.items || [] }) }))); }
            case 'discard': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/discard`, { method: 'POST' }))); }
            default: return fail(`Carts: ${res.hint}`);
          }
        }

        // ---- Checkout ----
        case 'checkout': {
          switch (act) {
            case 'authorize': return ok(j(await api(API_URL, `${res.path}/authorize`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'charge': return ok(j(await api(API_URL, `${res.path}/charge`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'capture': { if (!args.id) return fail('order id required'); return ok(j(await api(API_URL, `${res.path}/capture/${args.id}`, { method: 'POST' }))); }
            case 'confirm': { if (!args.id) return fail('order id required'); return ok(j(await api(API_URL, `${res.path}/confirm/${args.id}`, { method: 'POST' }))); }
            case 'cancel': { if (!args.id) return fail('order id required'); return ok(j(await api(API_URL, `${res.path}/cancel/${args.id}`, { method: 'POST' }))); }
            case 'session': return ok(j(await api(API_URL, `${res.path}/sessions`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            default: return fail(`Checkout: ${res.hint}`);
          }
        }

        // ---- Subscriptions ----
        case 'subscriptions': {
          switch (act) {
            case 'list': {
              const d = arr(await api(API_URL, `${res.path}?limit=${lim}`), 'subscriptions');
              return ok(`Subscriptions (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.planId || x.plan || ''} [${x.status}]`).join('\n')}`);
            }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'cancel': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE', body: JSON.stringify(args.data || {}) }))); }
            case 'apply_promotion': { if (!args.id || !args.code) return fail('id and code required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/promotion`, { method: 'POST', body: JSON.stringify({ code: args.code }) }))); }
            default: return fail(`Subscriptions: ${res.hint}`);
          }
        }

        // ---- Billing (was separate tool, now under commerce) ----
        case 'billing': {
          switch (act) {
            case 'balance': {
              const scope = args.user ? `?userId=${args.user}` : '';
              return ok(j(await api(API_URL, `${res.path}/balance${scope}`)));
            }
            case 'usage': return ok(j(await api(API_URL, `${res.path}/usage?period=${args.period || 'current'}${args.user ? `&userId=${args.user}` : ''}`)));
            case 'invoices': {
              const d = arr(await api(API_URL, `${res.path}/invoices?limit=${lim}`), 'invoices');
              return ok(`Invoices (${d.length}):\n${d.map((i: any) => `${i.id}: $${((i.amount || 0) / 100).toFixed(2)} ${i.status || ''}`).join('\n')}`);
            }
            case 'plans': return ok(j(await api(API_URL, `${res.path}/plans`)));
            case 'tier': return ok(j(await api(API_URL, `${res.path}/tier`)));
            case 'payment_methods': {
              const d = arr(await api(API_URL, `${res.path}/payment-methods`), 'paymentMethods');
              return ok(`Payment Methods (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.type} ${x.card?.last4 ? `****${x.card.last4}` : ''} ${x.status || ''}`).join('\n')}`);
            }
            case 'deposit': {
              if (!args.amount) return fail('amount (cents) required');
              return ok(j(await api(API_URL, `${res.path}/deposit`, { method: 'POST', body: JSON.stringify({ amount: args.amount, currency: args.currency || 'usd' }) })));
            }
            case 'credit': return ok(j(await api(API_URL, `${res.path}/credit`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'refund': {
              if (!args.id) return fail('payment id required');
              return ok(j(await api(API_URL, `${res.path}/refund`, { method: 'POST', body: JSON.stringify({ paymentId: args.id, amount: args.amount, ...(args.data || {}) }) })));
            }
            case 'disputes': {
              if (args.id) return ok(j(await api(API_URL, `${res.path}/disputes/${args.id}`)));
              return ok(j(await api(API_URL, `${res.path}/disputes?limit=${lim}`)));
            }
            case 'payouts': {
              if (args.id) return ok(j(await api(API_URL, `${res.path}/payouts/${args.id}`)));
              return ok(j(await api(API_URL, `${res.path}/payouts?limit=${lim}`)));
            }
            case 'meters': {
              const d = arr(await api(API_URL, `${res.path}/meters`), 'meters');
              return ok(`Meters (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.name} (${x.unitName || 'units'})`).join('\n')}`);
            }
            case 'portal': return ok(j(await api(API_URL, `${res.path}/portal`)));
            case 'events': return ok(j(await api(API_URL, `${res.path}/events?limit=${lim}`)));
            default: return fail(`Billing: ${res.hint}`);
          }
        }

        // ---- Customers (groups) ----
        case 'customers': {
          switch (act) {
            case 'list': { const d = arr(await api(API_URL, `${res.path}?limit=${lim}`)); return ok(`Groups (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.name}`).join('\n')}`); }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'delete': { if (!args.id) return fail('id required'); await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE' }); return ok(`Deleted: ${args.id}`); }
            case 'members': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/members`))); }
            case 'add_member': { if (!args.id || !args.member) return fail('id and member required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/members`, { method: 'POST', body: JSON.stringify({ userId: args.member }) }))); }
            case 'remove_member': { if (!args.id || !args.member) return fail('id and member required'); await api(API_URL, `${res.path}/${args.id}/members/${args.member}`, { method: 'DELETE' }); return ok(`Removed member: ${args.member}`); }
            default: return fail(`Customers: ${res.hint}`);
          }
        }

        // ---- Inventory ----
        case 'inventory': {
          switch (act) {
            case 'list': { const d = arr(await api(API_URL, `${res.path}?limit=${lim}`)); return ok(`Inventory (${d.length}):\n${d.map((x: any) => `${x.id}: qty=${x.quantity || 0} product=${x.productId || ''}`).join('\n')}`); }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'delete': { if (!args.id) return fail('id required'); await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE' }); return ok(`Deleted: ${args.id}`); }
            case 'adjust': { if (!args.id || args.adjustment === undefined) return fail('id and adjustment required'); return ok(j(await api(API_URL, `${res.path}/level/${args.id}/adjust`, { method: 'POST', body: JSON.stringify({ adjustment: args.adjustment }) }))); }
            default: return fail(`Inventory: ${res.hint}`);
          }
        }

        // ---- Stores ----
        case 'stores': {
          switch (act) {
            case 'list': { const d = arr(await api(API_URL, `${res.path}?limit=${lim}`)); return ok(`Stores (${d.length}):\n${d.map((x: any) => `${x.id}: ${x.name || x.slug || ''}`).join('\n')}`); }
            case 'get': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            case 'create': return ok(j(await api(API_URL, res.path, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update': { if (!args.id) return fail('id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'delete': { if (!args.id) return fail('id required'); await api(API_URL, `${res.path}/${args.id}`, { method: 'DELETE' }); return ok(`Deleted store: ${args.id}`); }
            case 'listings': { if (!args.id) return fail('store id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/listing`))); }
            default: return fail(`Stores: ${res.hint}`);
          }
        }

        // ---- Fulfillment ----
        case 'fulfillment': {
          switch (act) {
            case 'ship': { if (!args.id) return fail('fulfillment id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/ship`, { method: 'POST', body: JSON.stringify(args.data || {}) }))); }
            case 'cancel': { if (!args.id) return fail('fulfillment id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/cancel`, { method: 'POST' }))); }
            case 'track': { if (!args.id) return fail('fulfillment id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}`))); }
            default: return fail(`Fulfillment: ${res.hint}`);
          }
        }

        // ---- Analytics ----
        case 'analytics': {
          switch (act) {
            case 'dashboard': return ok(j(await api(API_URL, `${res.path}/dashboard/daily`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'topline': return ok(j(await api(API_URL, `${res.path}/topline`)));
            case 'events': return ok(j(await api(API_URL, '/v1/analytics/events', { method: 'POST', body: JSON.stringify(args.data || {}) })));
            default: return fail(`Analytics: ${res.hint}`);
          }
        }

        // ---- Coupons (special actions) ----
        case 'coupons': {
          if (act === 'generate_codes') {
            if (!args.id) return fail('coupon id required');
            return ok(j(await api(API_URL, `${res.path}/${args.id}/codes`, { method: 'POST', body: JSON.stringify({ count: args.count || 10 }) })));
          }
          return fail(`Coupons: ${res.hint}`);
        }

        // ---- Promotions (special actions) ----
        case 'promotions': {
          if (act === 'evaluate') {
            return ok(j(await api(API_URL, `${res.path}/evaluate`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
          }
          return fail(`Promotions: ${res.hint}`);
        }

        // ---- Pricing ----
        case 'pricing': {
          switch (act) {
            case 'calculate': return ok(j(await api(API_URL, `${res.path}/calculate`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'rules': return ok(j(await api(API_URL, '/v1/pricing-rules')));
            case 'create_rule': return ok(j(await api(API_URL, '/v1/pricing-rules', { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'update_rule': { if (!args.id) return fail('rule id required'); return ok(j(await api(API_URL, `/v1/pricing-rules/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) }))); }
            case 'delete_rule': { if (!args.id) return fail('rule id required'); await api(API_URL, `/v1/pricing-rules/${args.id}`, { method: 'DELETE' }); return ok(`Deleted rule: ${args.id}`); }
            default: return fail(`Pricing: ${res.hint}`);
          }
        }

        // ---- Tax ----
        case 'tax': {
          switch (act) {
            case 'calculate': return ok(j(await api(API_URL, `${res.path}/calculate`, { method: 'POST', body: JSON.stringify(args.data || {}) })));
            case 'rates': return ok(j(await api(API_URL, '/v1/tax-rates')));
            case 'regions': return ok(j(await api(API_URL, '/v1/tax-regions')));
            default: return fail(`Tax: ${res.hint}`);
          }
        }

        // ---- Affiliates (special) ----
        case 'affiliates': {
          if (act === 'connect') { if (!args.id) return fail('affiliate id required'); return ok(j(await api(API_URL, `${res.path}/${args.id}/connect`))); }
          return fail(`Affiliates: ${res.hint}`);
        }

        default: return fail(`Unknown resource: ${args.resource}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// Storage — object storage with upload, download, presign
// =============================================

export const storageTool: Tool = {
  name: 'storage',
  description: 'Object storage: list/create/delete buckets, list/upload/download/delete objects, presign URLs, copy',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'list_buckets', 'create_bucket', 'delete_bucket',
        'list_objects', 'get_object', 'delete_object',
        'presign', 'copy', 'metadata'
      ] },
      bucket: { type: 'string' }, key: { type: 'string', description: 'Object key/path' },
      prefix: { type: 'string', default: '' },
      content: { type: 'string', description: 'Content to upload (text)' },
      contentType: { type: 'string', default: 'application/octet-stream' },
      destination: { type: 'string', description: 'Destination key (copy)' },
      destBucket: { type: 'string', description: 'Destination bucket (copy)' },
      expiry: { type: 'number', description: 'Presign URL expiry in seconds', default: 3600 },
      limit: { type: 'number', default: 100 },
      region: { type: 'string' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'list_buckets': {
          const d = arr(await api(API_URL, '/v1/storage/buckets'), 'buckets');
          return ok(`Buckets (${d.length}):\n${d.map((x: any) => `${x.name || x.id}: ${x.region || ''} ${x.createdAt || ''}`).join('\n')}`);
        }
        case 'create_bucket': {
          if (!args.bucket) return fail('bucket name required');
          return ok(j(await api(API_URL, '/v1/storage/buckets', { method: 'POST', body: JSON.stringify({ name: args.bucket, region: args.region }) })));
        }
        case 'delete_bucket': {
          if (!args.bucket) return fail('bucket required');
          await api(API_URL, `/v1/storage/buckets/${args.bucket}`, { method: 'DELETE' });
          return ok(`Deleted bucket: ${args.bucket}`);
        }
        case 'list_objects': {
          if (!args.bucket) return fail('bucket required');
          const d = arr(await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects?prefix=${encodeURIComponent(args.prefix || '')}&limit=${args.limit || 100}`), 'objects');
          return ok(`Objects (${d.length}):\n${d.map((x: any) => `${x.key || x.name}: ${x.size || 0}b ${x.lastModified || ''}`).join('\n')}`);
        }
        case 'get_object': {
          if (!args.bucket || !args.key) return fail('bucket and key required');
          const d = await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects/${encodeURIComponent(args.key)}`);
          return ok(typeof d === 'string' ? d : j(d));
        }
        case 'delete_object': {
          if (!args.bucket || !args.key) return fail('bucket and key required');
          await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects/${encodeURIComponent(args.key)}`, { method: 'DELETE' });
          return ok(`Deleted: ${args.bucket}/${args.key}`);
        }
        case 'presign': {
          if (!args.bucket || !args.key) return fail('bucket and key required');
          return ok(j(await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects/${encodeURIComponent(args.key)}/presign`, { method: 'POST', body: JSON.stringify({ expiry: args.expiry || 3600 }) })));
        }
        case 'copy': {
          if (!args.bucket || !args.key || !args.destination) return fail('bucket, key, destination required');
          return ok(j(await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects/${encodeURIComponent(args.key)}/copy`, { method: 'POST', body: JSON.stringify({ destination: args.destination, destBucket: args.destBucket || args.bucket }) })));
        }
        case 'metadata': {
          if (!args.bucket || !args.key) return fail('bucket and key required');
          return ok(j(await api(API_URL, `/v1/storage/buckets/${args.bucket}/objects/${encodeURIComponent(args.key)}/metadata`)));
        }
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// Auth — authentication, sessions, MFA
// =============================================

export const authTool: Tool = {
  name: 'auth',
  description: 'Authentication: whoami, token info, account, sessions, login, logout, refresh, permissions, MFA status',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'whoami', 'token', 'account',
        'login', 'logout', 'refresh',
        'sessions', 'permissions', 'mfa'
      ] },
      email: { type: 'string' }, password: { type: 'string' },
      application: { type: 'string', default: 'app-hanzo' },
      organization: { type: 'string', default: 'hanzo' },
      refreshToken: { type: 'string' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'whoami':
        case 'token': return ok(j(await api(IAM_URL, '/api/userinfo')));
        case 'account': return ok(j(await api(IAM_URL, '/api/get-account')));
        case 'login': {
          if (!args.email || !args.password) return fail('email and password required');
          return ok(j(await api(IAM_URL, '/api/login', { method: 'POST', body: JSON.stringify({ type: 'token', username: args.email, password: args.password, application: args.application || 'app-hanzo', organization: args.organization || 'hanzo' }) })));
        }
        case 'logout': return ok(j(await api(IAM_URL, '/api/logout', { method: 'POST' })));
        case 'refresh': {
          if (!args.refreshToken) return fail('refreshToken required');
          return ok(j(await api(IAM_URL, '/api/login', { method: 'POST', body: JSON.stringify({ type: 'refresh_token', refreshToken: args.refreshToken }) })));
        }
        case 'sessions': return ok(j(await api(IAM_URL, '/api/get-sessions')));
        case 'permissions': return ok(j(await api(IAM_URL, '/api/get-permissions')));
        case 'mfa': return ok(j(await api(IAM_URL, '/api/mfa-status')));
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// API/LLM — models, chat, embeddings, images, audio, files
// =============================================

export const apiTool: Tool = {
  name: 'api',
  description: 'Hanzo API & LLM gateway: models, chat, embeddings, images, audio, files, fine-tuning, usage',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'models', 'chat', 'embeddings',
        'images', 'audio', 'files', 'upload_file',
        'fine_tunes', 'create_fine_tune',
        'usage', 'health'
      ] },
      message: { type: 'string' }, model: { type: 'string', default: 'auto' },
      messages: { type: 'array', items: { type: 'object' }, description: 'Full messages array' },
      system: { type: 'string' }, maxTokens: { type: 'number', default: 1000 },
      temperature: { type: 'number' }, topP: { type: 'number' },
      input: { type: 'string', description: 'Text for embeddings' },
      prompt: { type: 'string', description: 'Prompt for images/audio' },
      size: { type: 'string', description: 'Image size (256x256, 512x512, 1024x1024)' },
      fileId: { type: 'string' }, purpose: { type: 'string', default: 'fine-tune' },
      data: { type: 'object', description: 'Additional request data' }
    },
    required: ['action']
  },
  handler: async (args) => {
    try {
      switch (args.action) {
        case 'models': {
          const d = await api(API_URL, '/v1/models');
          const m = d?.data || [];
          const grouped: Record<string, number> = {};
          for (const x of m) { const owner = x.owned_by || 'other'; grouped[owner] = (grouped[owner] || 0) + 1; }
          const summary = Object.entries(grouped).map(([k, v]) => `${k}: ${v}`).join(', ');
          return ok(`Models (${m.length}): ${summary}\n\nTop 30:\n${m.slice(0, 30).map((x: any) => `${x.id}: ${x.owned_by || ''}`).join('\n')}${m.length > 30 ? `\n... +${m.length - 30} more` : ''}`);
        }
        case 'chat': {
          if (!args.message && !args.messages) return fail('message or messages required');
          const msgs = args.messages || [];
          if (!args.messages) {
            if (args.system) msgs.push({ role: 'system', content: args.system });
            msgs.push({ role: 'user', content: args.message });
          }
          const body: any = { model: args.model || 'auto', messages: msgs, max_tokens: args.maxTokens || 1000 };
          if (args.temperature !== undefined) body.temperature = args.temperature;
          if (args.topP !== undefined) body.top_p = args.topP;
          const d = await api(API_URL, '/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
          const txt = d?.choices?.[0]?.message?.content || '(empty)';
          const u = d?.usage;
          return ok(txt + (u ? `\n\n[${d?.model || args.model} | ${u.prompt_tokens}+${u.completion_tokens} tokens]` : ''));
        }
        case 'embeddings': {
          if (!args.input) return fail('input required');
          const d = await api(API_URL, '/v1/embeddings', { method: 'POST', body: JSON.stringify({ model: args.model || 'text-embedding-3-small', input: args.input }) });
          const emb = d?.data?.[0]?.embedding || [];
          return ok(`Embedding (${emb.length} dims): [${emb.slice(0, 5).map((x: number) => x.toFixed(4)).join(', ')}...]`);
        }
        case 'images': {
          if (!args.prompt) return fail('prompt required');
          return ok(j(await api(API_URL, '/v1/images/generations', { method: 'POST', body: JSON.stringify({ model: args.model || 'dall-e-3', prompt: args.prompt, size: args.size || '1024x1024', ...(args.data || {}) }) })));
        }
        case 'audio': {
          if (!args.input) return fail('input required');
          return ok(j(await api(API_URL, '/v1/audio/speech', { method: 'POST', body: JSON.stringify({ model: args.model || 'tts-1', input: args.input, ...(args.data || {}) }) })));
        }
        case 'files': return ok(j(await api(API_URL, '/v1/files')));
        case 'upload_file': {
          if (!args.data) return fail('data required with file content');
          return ok(j(await api(API_URL, '/v1/files', { method: 'POST', body: JSON.stringify({ purpose: args.purpose || 'fine-tune', ...args.data }) })));
        }
        case 'fine_tunes': return ok(j(await api(API_URL, '/v1/fine_tuning/jobs')));
        case 'create_fine_tune': {
          if (!args.fileId) return fail('fileId required');
          return ok(j(await api(API_URL, '/v1/fine_tuning/jobs', { method: 'POST', body: JSON.stringify({ model: args.model || 'gpt-4o-mini-2024-07-18', training_file: args.fileId, ...(args.data || {}) }) })));
        }
        case 'usage': return ok(j(await api(API_URL, '/v1/usage')));
        case 'health': return ok(j(await api(API_URL, '/health')));
        default: return fail(`Unknown action: ${args.action}`);
      }
    } catch (e: any) { return fail(e.message); }
  }
};

// =============================================
// Exports — each service is exactly 1 tool
// =============================================

export const iamTools = [iamTool];
export const kmsTools = [kmsTool];
export const paasTools = [paasTool];
export const commerceTools = [commerceTool];
export const storageTools = [storageTool];
export const authTools = [authTool];
export const apiTools = [apiTool];

// Billing is now under commerce — export alias for backwards compat
export const billingTool = commerceTool;
export const billingTools = [commerceTool];

export const hanzoCloudTools = [
  iamTool, kmsTool, paasTool, commerceTool, storageTool, authTool, apiTool
];
