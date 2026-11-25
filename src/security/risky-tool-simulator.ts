/**
 * Risky-Tool Simulator (HIP-1347 / Bounty #33).
 *
 * Clean-room TypeScript pre-execution dry-run risk classifier & impact preview
 * modeled after ToolEmu (ICLR '24). Evaluates MCP tool invocations prior to
 * live execution across:
 *   - Destructive filesystem deletes and overwrites
 *   - Credential path and secret exposure
 *   - Force git pushes and history-rewriting VCS operations
 *   - Outbound data exfiltration, SSRF, and remote code execution
 *   - Privilege escalation and system modification
 *
 * Emits allow / confirm / block verdicts, human-readable impact previews, and
 * Kai `action.risk@1`-compatible structured risk records without mutating state.
 */

import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../types/index.js';

export type SimulationVerdict = 'allow' | 'confirm' | 'block';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type BlastRadius = 'none' | 'single_file' | 'workspace' | 'system' | 'external';

export type RiskCategory =
  | 'destructive_fs_delete'
  | 'destructive_fs_overwrite'
  | 'credential_access'
  | 'force_git_push'
  | 'destructive_git'
  | 'outbound_exfiltration'
  | 'remote_code_exec'
  | 'privilege_escalation'
  | 'ssrf_metadata'
  | 'system_modification'
  | 'remote_mutation'
  | 'benign';

export interface ToolCallInput {
  tool: string;
  action?: string;
  args?: Record<string, unknown>;
}

export interface SimulationContext {
  workspaceRoot?: string;
  protectedBranches?: string[];
  allowedHosts?: string[];
  /** Enable read-only filesystem probes in `simulateToolExecutionWithProbe` (default: true). */
  inspectFilesystem?: boolean;
  tenantId?: string;
  sessionId?: string;
}

export interface SimulationCheck {
  category: RiskCategory;
  verdict: SimulationVerdict;
  severity: RiskLevel;
  target?: string;
  rationale: string;
  reversible: boolean;
  blastRadius: BlastRadius;
}

export interface ActionRiskRecord {
  schema: 'action.risk@1';
  tool: string;
  action?: string;
  verdict: SimulationVerdict;
  risk_level: RiskLevel;
  risk_score: number;
  categories: RiskCategory[];
  reversible: boolean;
  blast_radius: BlastRadius;
  affected_targets: string[];
  rationale: string[];
  impact_preview: string;
  tenant_id?: string;
  session_id?: string;
}

export interface RiskSimulationResult {
  verdict: SimulationVerdict;
  riskLevel: RiskLevel;
  riskScore: number;
  categories: RiskCategory[];
  reversible: boolean;
  blastRadius: BlastRadius;
  affectedTargets: string[];
  rationale: string[];
  impactPreview: string;
  checks: SimulationCheck[];
  actionRiskRecord: ActionRiskRecord;
}

export interface ToolEmuCase {
  id: string;
  category: string;
  expectedUnsafe: boolean;
  minimumVerdict?: SimulationVerdict;
  call: ToolCallInput;
  context?: SimulationContext;
}

export interface ToolEmuSuiteReport {
  total: number;
  unsafe: {
    total: number;
    detected: number;
    blocked: number;
    confirmed: number;
    missed: number;
    recall: number;
  };
  benign: {
    total: number;
    allowed: number;
    falseConfirms: number;
    falseBlocks: number;
    falseBlockRate: number;
    falsePositiveRate: number;
  };
  results: Array<{
    id: string;
    category: string;
    expectedUnsafe: boolean;
    verdict: SimulationVerdict;
    detected: boolean;
    simulation: RiskSimulationResult;
  }>;
}

const VERDICT_RANK: Record<SimulationVerdict, number> = { allow: 0, confirm: 1, block: 2 };
const LEVEL_RANK: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const RADIUS_RANK: Record<BlastRadius, number> = {
  none: 0,
  single_file: 1,
  workspace: 2,
  system: 3,
  external: 4,
};

const LEVEL_SCORE: Record<RiskLevel, number> = {
  none: 0,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  critical: 0.98,
};

const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'prod', 'production', 'release'];

const BENIGN_ENV_TEMPLATES = /(?:^|\/)\.env\.(?:example|sample|template|dist|schema)$/i;

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.pub)?$/i,
  /(?:^|\/)(?:privkey|private[_-]?key|server[_-]?key)\.(?:pem|key)$/i,
  /\.(?:p12|pfx|jks|kdbx)$/i,
  /(?:^|\/)\.aws\/(?:credentials|config)$/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)\.git-credentials$/i,
  /(?:^|\/)\.kube\/config$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.gnupg(?:\/|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.pypirc$/i,
  /(?:^|\/)credentials\.json$/i,
  /^\/etc\/(?:shadow|gshadow|sudoers(?:\.d\/.*)?)$/i,
  /(?:^|\/)\.env(?:\.(?:local|prod|production|staging|dev|development))?$/i,
];

const SYSTEM_PROTECTED_PATHS: RegExp[] = [
  /^\/$/,
  /^\/(?:etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|root|System|Library)(?:\/|$)/,
  /^(?:~|\$HOME|\$\{HOME\}|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/?$/,
  /^(?:~|\$HOME|\$\{HOME\}|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile|ssh)(?:\/|$)/,
];

const SECRET_VALUE_PATTERNS: Array<[string, RegExp]> = [
  ['OpenAI/Hanzo API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/],
  ['GitHub PAT', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack Token', /\bxox[baprs]-[0-9A-Za-z-]{12,}\b/],
  ['PEM Private Key', /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/],
  ['JWT / Bearer Token', /\bBearer\s+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/i],
];

const METADATA_SSRF_RE =
  /169\.254\.169\.254|metadata\.google\.internal|\/latest\/meta-data\/|\bfd00:ec2::254\b|100\.100\.100\.200/i;

function normalizeTargetPath(raw: string, workspaceRoot?: string): string {
  let p = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^file:\/\//i, '').replace(/\\/g, '/');
  if (!p) return '';
  if (p.startsWith('~') || p.startsWith('$HOME') || p.startsWith('${HOME}')) {
    return path.posix.normalize(p);
  }
  if (p.startsWith('/')) {
    return path.posix.normalize(p);
  }
  if (workspaceRoot) {
    const rootNorm = path.posix.normalize(workspaceRoot.replace(/\\/g, '/'));
    return path.posix.resolve(rootNorm, p);
  }
  return path.posix.normalize(p);
}

function isCredentialPath(rawPath: string, workspaceRoot?: string): boolean {
  const norm = normalizeTargetPath(rawPath, workspaceRoot);
  if (!norm || BENIGN_ENV_TEMPLATES.test(norm)) return false;
  return CREDENTIAL_PATTERNS.some((rx) => rx.test(norm) || rx.test(rawPath));
}

function isSystemOrRootPath(rawPath: string, workspaceRoot?: string): boolean {
  const norm = normalizeTargetPath(rawPath, workspaceRoot);
  if (!norm) return false;
  if (SYSTEM_PROTECTED_PATHS.some((rx) => rx.test(norm) || rx.test(rawPath.trim()))) return true;
  if (workspaceRoot) {
    const rootNorm = path.posix.normalize(workspaceRoot.replace(/\\/g, '/'));
    // Allow /tmp/... scratch files, block parent traversal outside workspaceRoot
    if (norm.startsWith('/tmp/') || norm.startsWith('/var/folders/')) return false;
    if (norm.startsWith('/') && norm !== rootNorm && !norm.startsWith(`${rootNorm}/`)) {
      return true;
    }
  } else if (/(?:^|\/)\.\.(?:\/|$)/.test(rawPath)) {
    return true;
  }
  return false;
}

function isTmpScratchPath(rawPath: string): boolean {
  const p = normalizeTargetPath(rawPath);
  return /^\/tmp\/.+/.test(p) || /^\/var\/folders\/.+/.test(p);
}

function containsSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const [label, rx] of SECRET_VALUE_PATTERNS) {
    if (rx.test(text)) hits.push(label);
  }
  return hits;
}

function extractHost(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalOrAllowlistedHost(host: string, allowedHosts: string[] = []): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
}

function splitShellSegments(cmd: string): string[] {
  return cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, ' ')
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenizeWords(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

function inspectShellCommand(cmd: string, context: SimulationContext): SimulationCheck[] {
  const checks: SimulationCheck[] = [];
  const protectedBranches = (context.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES).map((b) =>
    b.toLowerCase()
  );

  // Check whole-command pipe hazards first
  if (
    /\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^|\n]*\|\s*(?:sudo\s+)?(?:\w*sh|python3?|perl|ruby|node)\b/i.test(
      cmd
    ) ||
    /\b(?:base64\s+(?:-d|-D|--decode))\b[^|\n]*\|\s*(?:sudo\s+)?\w*sh\b/i.test(cmd) ||
    /\b(?:\w*sh|source|\.)\s+<\(\s*(?:curl|wget)\b/i.test(cmd) ||
    /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i.test(cmd)
  ) {
    checks.push({
      category: 'remote_code_exec',
      verdict: 'block',
      severity: 'critical',
      target: cmd.slice(0, 120),
      rationale: 'Pipes remote network output directly into an interpreter/shell',
      reversible: false,
      blastRadius: 'system',
    });
  }

  if (METADATA_SSRF_RE.test(cmd)) {
    checks.push({
      category: 'ssrf_metadata',
      verdict: 'block',
      severity: 'critical',
      target: 'instance-metadata',
      rationale: 'Targets cloud instance metadata endpoint (SSRF credential leak risk)',
      reversible: false,
      blastRadius: 'external',
    });
  }

  // Whole-command credential read + outbound network exfiltration pipe/chain
  const credMention = cmd.match(
    /(~\/\.ssh\/\S*|\/etc\/shadow\b|\.aws\/credentials\b|\.netrc\b|\.git-credentials\b|\.kube\/config\b|\.gnupg\S*|\bid_rsa\b|\bid_ed25519\b|\b\.env\b(?!\.(?:example|sample|template)\b))/i
  );
  const netCommand = /\b(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|rsync|ssh|telnet)\b/i.test(cmd);
  if (credMention && netCommand) {
    checks.push({
      category: 'outbound_exfiltration',
      verdict: 'block',
      severity: 'critical',
      target: credMention[0],
      rationale: `Combines credential path '${credMention[0]}' with outbound network command`,
      reversible: false,
      blastRadius: 'external',
    });
  }

  // Disk / database wipes / fork bombs
  if (
    /\bmkfs(?:\.\w+)?\b|\bdd\b[^\n]*\bof=\/dev\/|\bwipefs\b|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i.test(
      cmd
    ) ||
    /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|dropdb|flushall)\b/i.test(cmd)
  ) {
    checks.push({
      category: 'destructive_fs_delete',
      verdict: 'block',
      severity: 'critical',
      target: cmd.slice(0, 80),
      rationale: 'Irreversible disk, block-device, or database wipe command',
      reversible: false,
      blastRadius: 'system',
    });
  }

  // Inspect individual segments (and pipelines)
  for (const seg of splitShellSegments(cmd)) {
    // Strip leading env assignments
    const cleanedSeg = seg.replace(/^(?:\w+=\S*\s+)+/, '').trim();
    const pipeParts = cleanedSeg.split('|').map((p) => p.trim()).filter(Boolean);

    for (const part of pipeParts) {
      const words = tokenizeWords(part);
      if (words.length === 0) continue;
      let idx = 0;

      // Privilege escalation prefix
      if (/^(?:sudo|su|doas)$/.test(words[0])) {
        checks.push({
          category: 'privilege_escalation',
          verdict: 'confirm',
          severity: 'high',
          target: part.slice(0, 100),
          rationale: `Requests elevated privileges via '${words[0]}'`,
          reversible: false,
          blastRadius: 'system',
        });
        idx = 1;
        if (idx >= words.length) continue;
      }

      const bin = path.posix.basename(words[idx]);
      const rest = words.slice(idx + 1);

      // 1. Destructive filesystem delete commands
      if (/^(?:rm|rmdir|shred|unlink|rimraf)$/.test(bin)) {
        const flags = rest.filter((w) => w.startsWith('-')).join(' ');
        const isRecursive = /-[a-zA-Z]*[rR]|--recursive/.test(flags) || bin === 'rimraf';
        const targets = rest.filter((w) => !w.startsWith('-'));
        for (const t of targets) {
          const norm = normalizeTargetPath(t, context.workspaceRoot);
          const isDotGit = /(?:^|\/)\.git(?:\/|$)/.test(norm);
          const isWildcardRoot = t === '*' || t === '/*' || t === '.' || t === './' || t === '..';
          if (isSystemOrRootPath(t, context.workspaceRoot) || isCredentialPath(t, context.workspaceRoot) || isDotGit || isWildcardRoot) {
            checks.push({
              category: 'destructive_fs_delete',
              verdict: 'block',
              severity: 'critical',
              target: t,
              rationale: `Blocks destructive ${isRecursive ? 'recursive ' : ''}deletion targeting protected path '${t}'`,
              reversible: false,
              blastRadius: isDotGit ? 'workspace' : 'system',
            });
          } else if (!isTmpScratchPath(t)) {
            checks.push({
              category: 'destructive_fs_delete',
              verdict: 'confirm',
              severity: isRecursive ? 'high' : 'medium',
              target: t,
              rationale: `Permanent filesystem delete (${bin}${isRecursive ? ' recursive' : ''}) on '${t}'`,
              reversible: false,
              blastRadius: isRecursive ? 'workspace' : 'single_file',
            });
          }
        }
      }

      if (bin === 'find' && /\s-(?:delete|exec\s+rm)\b/.test(part)) {
        const rootTarget = rest.find((w) => !w.startsWith('-')) ?? '.';
        const severe = isSystemOrRootPath(rootTarget, context.workspaceRoot);
        checks.push({
          category: 'destructive_fs_delete',
          verdict: severe ? 'block' : 'confirm',
          severity: severe ? 'critical' : 'high',
          target: rootTarget,
          rationale: `'find -delete' performs bulk permanent deletion under '${rootTarget}'`,
          reversible: false,
          blastRadius: severe ? 'system' : 'workspace',
        });
      }

      if (/python\d*/.test(bin) && /shutil\.rmtree|os\.remove|pathlib\.Path.*\.unlink/.test(part)) {
        const touchesProtected = /(?:expanduser|~|\/etc|\/home|\/Users|["']\/["'])/.test(part);
        checks.push({
          category: 'destructive_fs_delete',
          verdict: touchesProtected ? 'block' : 'confirm',
          severity: touchesProtected ? 'critical' : 'high',
          target: part.slice(0, 100),
          rationale: 'Inline Python filesystem deletion call',
          reversible: false,
          blastRadius: touchesProtected ? 'system' : 'workspace',
        });
      }

      // 2. Truncate / mv / cp overwrite & shell redirects
      if (bin === 'truncate') {
        const targets = rest.filter((w) => !w.startsWith('-') && !/^\d+[KMG]?$/i.test(w));
        for (const t of targets) {
          if (!isTmpScratchPath(t)) {
            const sysOrCred =
              isSystemOrRootPath(t, context.workspaceRoot) || isCredentialPath(t, context.workspaceRoot);
            checks.push({
              category: 'destructive_fs_overwrite',
              verdict: sysOrCred ? 'block' : 'confirm',
              severity: sysOrCred ? 'critical' : 'high',
              target: t,
              rationale: `Truncates file '${t}' in place, destroying existing content`,
              reversible: false,
              blastRadius: sysOrCred ? 'system' : 'single_file',
            });
          }
        }
      }

      if (bin === 'chmod' || bin === 'chown' || bin === 'chgrp') {
        const dangerousMode = rest.some((w) => w === '777' || w === '-R' || w === '--recursive');
        const targets = rest.filter((w) => !w.startsWith('-') && !/^[0-7]{3,4}$/.test(w));
        if (dangerousMode && targets.some((t) => isSystemOrRootPath(t, context.workspaceRoot))) {
          checks.push({
            category: 'system_modification',
            verdict: 'block',
            severity: 'critical',
            target: targets.join(', '),
            rationale: `Dangerous recursive/world-writable permission change via '${bin}'`,
            reversible: false,
            blastRadius: 'system',
          });
        }
      }

      // Shell output redirection check (ignoring fd redirects like 2>&1 or /dev/null)
      const redirMatches = part.matchAll(/(?:^|\s)(?:1?>|>>)\s*([^\s;&|]+)/g);
      for (const m of redirMatches) {
        const target = m[1];
        if (target === '/dev/null' || target.startsWith('&') || isTmpScratchPath(target)) continue;
        if (isSystemOrRootPath(target, context.workspaceRoot) || isCredentialPath(target, context.workspaceRoot)) {
          checks.push({
            category: 'destructive_fs_overwrite',
            verdict: 'block',
            severity: 'critical',
            target,
            rationale: `Redirects output onto protected system or credential path '${target}'`,
            reversible: false,
            blastRadius: 'system',
          });
        } else if (m[0].includes('>') && !m[0].includes('>>')) {
          checks.push({
            category: 'destructive_fs_overwrite',
            verdict: 'confirm',
            severity: 'medium',
            target,
            rationale: `Output redirection '>' overwrites '${target}' if it already exists`,
            reversible: false,
            blastRadius: 'single_file',
          });
        }
      }

      // 3. Credential reads via inspection utilities
      if (/^(?:cat|less|more|head|tail|xxd|strings|base64|cp|mv|tar|zip|openssl|grep|rg|awk|sed)$/.test(bin)) {
        for (const arg of rest) {
          if (arg.startsWith('-')) continue;
          if (isCredentialPath(arg, context.workspaceRoot)) {
            checks.push({
              category: 'credential_access',
              verdict: 'block',
              severity: 'critical',
              target: arg,
              rationale: `Accesses sensitive credential/key path '${arg}'`,
              reversible: true,
              blastRadius: 'system',
            });
          }
        }
      }
      if (bin === 'env' || bin === 'printenv') {
        checks.push({
          category: 'credential_access',
          verdict: 'confirm',
          severity: 'medium',
          target: 'process.env',
          rationale: `Dumps environment variables via '${bin}', which may expose API secrets`,
          reversible: true,
          blastRadius: 'workspace',
        });
      }

      // 4. Git checks (supports `git -C dir ...` flags before subcommand)
      if (bin === 'git') {
        let subIdx = 0;
        while (subIdx < rest.length) {
          const w = rest[subIdx];
          if (w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '-c') {
            subIdx += 2;
          } else if (w.startsWith('-')) {
            subIdx += 1;
          } else {
            break;
          }
        }
        const sub = rest[subIdx] ?? '';
        const gitArgs = rest.slice(subIdx + 1);

        if (sub === 'push') {
          const hasForceFlag = gitArgs.some(
            (a) => a === '-f' || a === '--force' || a === '--force-with-lease' || a.startsWith('--force-if-includes')
          );
          const refspecs = gitArgs.filter((a) => !a.startsWith('-'));
          const hasPlusRefspec = refspecs.some((r) => r.startsWith('+') || r.includes(':+'));
          const isForce = hasForceFlag || hasPlusRefspec;
          const targetBranch = (refspecs[1] ?? refspecs[0] ?? '').replace(/^\+/, '').split(':').pop()?.toLowerCase() ?? '';
          const hitsProtected =
            !targetBranch ||
            protectedBranches.some((pb) => targetBranch === pb || targetBranch.startsWith(`${pb}/`));

          if (isForce) {
            checks.push({
              category: 'force_git_push',
              verdict: hitsProtected ? 'block' : 'confirm',
              severity: hitsProtected ? 'critical' : 'high',
              target: targetBranch || 'remote',
              rationale: hitsProtected
                ? `Force push targeting protected/default branch '${targetBranch || 'HEAD'}' rewrites shared history`
                : `Force push targeting branch '${targetBranch}' overwrites remote commit history`,
              reversible: false,
              blastRadius: 'external',
            });
          } else {
            checks.push({
              category: 'remote_mutation',
              verdict: 'confirm',
              severity: 'medium',
              target: refspecs.join(' ') || 'origin',
              rationale: 'Pushes local commits to a remote git repository',
              reversible: false,
              blastRadius: 'external',
            });
          }
        } else if (
          (sub === 'reset' && gitArgs.includes('--hard')) ||
          (sub === 'clean' && gitArgs.some((a) => /^-[a-zA-Z]*f/.test(a))) ||
          sub === 'filter-branch' ||
          sub === 'filter-repo' ||
          (sub === 'branch' && gitArgs.includes('-D')) ||
          (sub === 'stash' && (gitArgs.includes('drop') || gitArgs.includes('clear'))) ||
          (sub === 'update-ref' && gitArgs.includes('-d'))
        ) {
          const isCleanAll = sub === 'clean' && gitArgs.some((a) => /^-[a-zA-Z]*x/.test(a));
          checks.push({
            category: 'destructive_git',
            verdict: isCleanAll || sub === 'filter-branch' ? 'block' : 'confirm',
            severity: 'high',
            target: `git ${sub} ${gitArgs.join(' ')}`.trim(),
            rationale: `Destructive git operation ('git ${sub}') discards uncommitted work or rewrites history`,
            reversible: false,
            blastRadius: 'workspace',
          });
        }
      }

      // 5. Network exfiltration / outbound mutation via curl / wget / scp / rsync
      if (bin === 'curl' || bin === 'wget' || bin === 'http') {
        const isOutboundWrite =
          /\s(-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-binary|-raw|-urlencode)?|\s-d\s|\s-F\s|-T\s|--upload-file|--post-data|--post-file)/i.test(
            part
          );
        const secretHits = containsSecrets(part);
        const fileUploadMatch = part.match(/(?:@|-T\s+|--post-file[=\s]+)([^\s'"]+)/);
        const urlMatch = part.match(/https?:\/\/[^\s'"]+/i);
        const host = urlMatch ? extractHost(urlMatch[0]) : null;
        const allowlisted = host ? isLocalOrAllowlistedHost(host, context.allowedHosts) : false;

        if (secretHits.length > 0 || (fileUploadMatch && isCredentialPath(fileUploadMatch[1], context.workspaceRoot))) {
          checks.push({
            category: 'outbound_exfiltration',
            verdict: 'block',
            severity: 'critical',
            target: urlMatch?.[0] ?? fileUploadMatch?.[1] ?? bin,
            rationale: `Outbound ${bin} call transmits sensitive credentials (${secretHits.join(', ') || fileUploadMatch?.[1]})`,
            reversible: false,
            blastRadius: 'external',
          });
        } else if (isOutboundWrite && !allowlisted) {
          checks.push({
            category: 'outbound_exfiltration',
            verdict: 'confirm',
            severity: 'high',
            target: urlMatch?.[0] ?? bin,
            rationale: `Outbound HTTP write/upload to external host '${host ?? 'unknown'}'`,
            reversible: false,
            blastRadius: 'external',
          });
        }
      }

      if ((bin === 'scp' || bin === 'rsync' || bin === 'nc' || bin === 'ncat') && rest.length > 0) {
        const hasRemote = rest.some((w) => w.includes(':') || /\.\d+\.\d+/.test(w)) || bin.startsWith('nc');
        const hasDelete = bin === 'rsync' && rest.includes('--delete');
        if (hasRemote || hasDelete) {
          checks.push({
            category: hasDelete ? 'destructive_fs_delete' : 'outbound_exfiltration',
            verdict: 'confirm',
            severity: 'high',
            target: rest.join(' '),
            rationale: hasDelete
              ? `'rsync --delete' removes destination files missing from source`
              : `Network file/stream transfer via '${bin}'`,
            reversible: false,
            blastRadius: 'external',
          });
        }
      }
    }
  }

  return checks;
}

function inspectStructuredTool(call: ToolCallInput, context: SimulationContext): SimulationCheck[] {
  const checks: SimulationCheck[] = [];
  const tool = call.tool.toLowerCase();
  const action = (call.action ?? '').toLowerCase();
  const args = call.args ?? {};
  const protectedBranches = (context.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES).map((b) =>
    b.toLowerCase()
  );

  // Check all string arguments for embedded secrets when calling outbound/network tools
  const rawUri = (typeof args.uri === 'string' ? args.uri : typeof args.path === 'string' ? args.path : '') || '';
  const targetPath = rawUri || (typeof args.file === 'string' ? args.file : '');

  // A. Filesystem tools (`fs`, `write`, `edit`, `rm`, `read`, `write_file`, `delete_file`)
  if (
    tool === 'fs' ||
    tool === 'read' ||
    tool === 'read_file' ||
    tool === 'write' ||
    tool === 'write_file' ||
    tool === 'edit' ||
    tool === 'patch' ||
    tool === 'rm' ||
    tool === 'delete_file'
  ) {
    const resolvedAction =
      action ||
      (tool === 'rm' || tool === 'delete_file'
        ? 'rm'
        : tool === 'write' || tool === 'write_file'
          ? 'write'
          : tool === 'edit' || tool === 'patch'
            ? 'apply_patch'
            : 'read');

    if (targetPath && isCredentialPath(targetPath, context.workspaceRoot)) {
      checks.push({
        category: 'credential_access',
        verdict: 'block',
        severity: 'critical',
        target: targetPath,
        rationale: `Targets restricted credential/key path '${targetPath}'`,
        reversible: resolvedAction === 'read',
        blastRadius: 'system',
      });
    }

    if (resolvedAction === 'rm' && targetPath) {
      const norm = normalizeTargetPath(targetPath, context.workspaceRoot);
      const isDotGit = /(?:^|\/)\.git(?:\/|$)/.test(norm);
      const protectedOrExternal =
        isSystemOrRootPath(targetPath, context.workspaceRoot) || isDotGit;

      if (protectedOrExternal) {
        checks.push({
          category: 'destructive_fs_delete',
          verdict: 'block',
          severity: 'critical',
          target: targetPath,
          rationale: `Blocks permanent deletion of protected/external path '${targetPath}'`,
          reversible: false,
          blastRadius: isDotGit ? 'workspace' : 'system',
        });
      } else if (!isTmpScratchPath(targetPath)) {
        checks.push({
          category: 'destructive_fs_delete',
          verdict: 'confirm',
          severity: 'high',
          target: targetPath,
          rationale: `Permanent deletion of '${targetPath}' requires explicit confirmation`,
          reversible: false,
          blastRadius: 'workspace',
        });
      }
    }

    if (['write', 'mv', 'apply_patch', 'patch'].includes(resolvedAction) && targetPath) {
      if (
        isSystemOrRootPath(targetPath, context.workspaceRoot) ||
        /(?:^|\/)\.git\/(?:hooks|config)\b/.test(normalizeTargetPath(targetPath, context.workspaceRoot))
      ) {
        checks.push({
          category: 'destructive_fs_overwrite',
          verdict: 'block',
          severity: 'critical',
          target: targetPath,
          rationale: `Blocks write/overwrite to system, git hook, or external path '${targetPath}'`,
          reversible: false,
          blastRadius: 'system',
        });
      } else if (resolvedAction === 'write' && args.overwrite === true && !isTmpScratchPath(targetPath)) {
        checks.push({
          category: 'destructive_fs_overwrite',
          verdict: 'confirm',
          severity: 'medium',
          target: targetPath,
          rationale: `Unconditional overwrite=true on '${targetPath}' discards previous file contents`,
          reversible: false,
          blastRadius: 'single_file',
        });
      } else if (resolvedAction === 'mv' && typeof args.destination === 'string') {
        const dest = args.destination;
        if (
          isSystemOrRootPath(dest, context.workspaceRoot) ||
          isCredentialPath(dest, context.workspaceRoot)
        ) {
          checks.push({
            category: 'destructive_fs_overwrite',
            verdict: 'block',
            severity: 'critical',
            target: dest,
            rationale: `Blocks moving/overwriting onto protected path '${dest}'`,
            reversible: false,
            blastRadius: 'system',
          });
        } else if (!isTmpScratchPath(dest)) {
          checks.push({
            category: 'destructive_fs_overwrite',
            verdict: 'confirm',
            severity: 'medium',
            target: `${targetPath} -> ${dest}`,
            rationale: `Moving '${targetPath}' to '${dest}' may overwrite an existing file at destination`,
            reversible: false,
            blastRadius: 'single_file',
          });
        }
      }
    }
  }

  // B. Shell execution tools (`exec`, `bash`, `bg`)
  if (tool === 'exec' || tool === 'bash' || tool === 'bg' || tool === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command) {
      checks.push(...inspectShellCommand(command, context));
    }
  }

  // C. Git MCP tool (`git`)
  if (tool === 'git') {
    if (action === 'push') {
      const targetBranch = String(args.target ?? args.name ?? args.ref ?? '').toLowerCase();
      const isForce = Boolean(args.force) || targetBranch.startsWith('+');
      const cleanBranch = targetBranch.replace(/^\+/, '');
      const hitsProtected =
        !cleanBranch ||
        protectedBranches.some((pb) => cleanBranch === pb || cleanBranch.startsWith(`${pb}/`));

      if (isForce) {
        checks.push({
          category: 'force_git_push',
          verdict: hitsProtected ? 'block' : 'confirm',
          severity: hitsProtected ? 'critical' : 'high',
          target: cleanBranch || 'remote',
          rationale: hitsProtected
            ? `Force push to protected branch '${cleanBranch || 'default'}' rewrites shared repository history`
            : `Force push to '${cleanBranch}' overwrites remote branch history`,
          reversible: false,
          blastRadius: 'external',
        });
      } else {
        checks.push({
          category: 'remote_mutation',
          verdict: 'confirm',
          severity: 'medium',
          target: cleanBranch || 'origin',
          rationale: 'Git push mutates remote repository state',
          reversible: false,
          blastRadius: 'external',
        });
      }
    } else if (
      (action === 'reset' && args.mode === 'hard') ||
      action === 'clean' ||
      action === 'filter-branch' ||
      (action === 'branch' && args.sub_action === 'delete' && args.force === true) ||
      (action === 'stash' && (args.sub_action === 'drop' || args.sub_action === 'clear'))
    ) {
      checks.push({
        category: 'destructive_git',
        verdict: 'confirm',
        severity: 'high',
        target: `git:${action}`,
        rationale: `Destructive git action '${action}' permanently discards local changes or branch pointers`,
        reversible: false,
        blastRadius: 'workspace',
      });
    }
  }

  // D. Network & connectors (`fetch`, `http_request`, `http_post`, `browser`, `connectors`, `send_email`)
  if (
    tool === 'fetch' ||
    tool === 'http_request' ||
    tool === 'http_post' ||
    tool === 'browser' ||
    tool === 'connectors' ||
    tool.includes('email')
  ) {
    const url = typeof args.url === 'string' ? args.url : '';
    const method = (typeof args.method === 'string' ? args.method : tool === 'http_post' ? 'POST' : 'GET').toUpperCase();
    const payloadBlob = JSON.stringify({
      url,
      headers: args.headers ?? null,
      body: args.body ?? args.data ?? args.text ?? args.content ?? null,
    });

    if (url && METADATA_SSRF_RE.test(url)) {
      checks.push({
        category: 'ssrf_metadata',
        verdict: 'block',
        severity: 'critical',
        target: url,
        rationale: `Blocks SSRF request to cloud metadata endpoint '${url}'`,
        reversible: false,
        blastRadius: 'external',
      });
    }

    if (url && /^file:\/\//i.test(url)) {
      checks.push({
        category: 'credential_access',
        verdict: 'block',
        severity: 'critical',
        target: url,
        rationale: `Blocks local file:// scheme fetch '${url}'`,
        reversible: false,
        blastRadius: 'system',
      });
    }

    const secretHits = containsSecrets(payloadBlob);
    if (secretHits.length > 0) {
      checks.push({
        category: 'outbound_exfiltration',
        verdict: 'block',
        severity: 'critical',
        target: url || tool,
        rationale: `Outbound payload embeds sensitive credential pattern(s): ${secretHits.join(', ')}`,
        reversible: false,
        blastRadius: 'external',
      });
    } else if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      tool.includes('email') ||
      (tool === 'connectors' && !['list', 'read', 'status', 'get'].includes(action))
    ) {
      const host = url ? extractHost(url) : null;
      const allowlisted = host ? isLocalOrAllowlistedHost(host, context.allowedHosts) : false;
      if (!allowlisted) {
        checks.push({
          category: 'outbound_exfiltration',
          verdict: 'confirm',
          severity: 'high',
          target: url || (typeof args.to === 'string' ? args.to : tool),
          rationale: `Outbound ${method} / external message dispatch to '${host ?? (args.to || tool)}'`,
          reversible: false,
          blastRadius: 'external',
        });
      }
    }
  }

  return checks;
}

function finalizeSimulation(
  call: ToolCallInput,
  checks: SimulationCheck[],
  context: SimulationContext,
  extraPreviewNotes: string[] = []
): RiskSimulationResult {
  if (checks.length === 0) {
    const impactPreview =
      extraPreviewNotes[0] ||
      `Dry-run: '${call.tool}${call.action ? `.${call.action}` : ''}' is a read-only or scoped workspace operation with no detected risk.`;
    const actionRiskRecord: ActionRiskRecord = {
      schema: 'action.risk@1',
      tool: call.tool,
      ...(call.action ? { action: call.action } : {}),
      verdict: 'allow',
      risk_level: 'none',
      risk_score: 0,
      categories: ['benign'],
      reversible: true,
      blast_radius: 'none',
      affected_targets: [],
      rationale: ['No destructive, credential, force-push, or exfiltration signals detected'],
      impact_preview: impactPreview,
      ...(context.tenantId ? { tenant_id: context.tenantId } : {}),
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
    };

    return {
      verdict: 'allow',
      riskLevel: 'none',
      riskScore: 0,
      categories: ['benign'],
      reversible: true,
      blastRadius: 'none',
      affectedTargets: [],
      rationale: actionRiskRecord.rationale,
      impactPreview,
      checks: [],
      actionRiskRecord,
    };
  }

  let verdict: SimulationVerdict = 'allow';
  let riskLevel: RiskLevel = 'none';
  let blastRadius: BlastRadius = 'none';
  let reversible = true;
  const categoriesSet = new Set<RiskCategory>();
  const targetsSet = new Set<string>();
  const rationale: string[] = [];

  for (const c of checks) {
    if (VERDICT_RANK[c.verdict] > VERDICT_RANK[verdict]) verdict = c.verdict;
    if (LEVEL_RANK[c.severity] > LEVEL_RANK[riskLevel]) riskLevel = c.severity;
    if (RADIUS_RANK[c.blastRadius] > RADIUS_RANK[blastRadius]) blastRadius = c.blastRadius;
    if (!c.reversible) reversible = false;
    categoriesSet.add(c.category);
    if (c.target) targetsSet.add(c.target);
    rationale.push(c.rationale);
  }

  const categories = Array.from(categoriesSet);
  const affectedTargets = Array.from(targetsSet);
  const riskScore = LEVEL_SCORE[riskLevel];

  const previewParts = [
    `[${verdict.toUpperCase()} | ${riskLevel} risk | ${reversible ? 'reversible' : 'irreversible'} | blast=${blastRadius}]`,
    `Tool '${call.tool}${call.action ? `.${call.action}` : ''}' would affect: ${affectedTargets.join(', ') || 'environment'}.`,
    ...rationale,
    ...extraPreviewNotes,
  ];
  const impactPreview = previewParts.join(' ');

  const actionRiskRecord: ActionRiskRecord = {
    schema: 'action.risk@1',
    tool: call.tool,
    ...(call.action ? { action: call.action } : {}),
    verdict,
    risk_level: riskLevel,
    risk_score: riskScore,
    categories,
    reversible,
    blast_radius: blastRadius,
    affected_targets: affectedTargets,
    rationale,
    impact_preview: impactPreview,
    ...(context.tenantId ? { tenant_id: context.tenantId } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };

  return {
    verdict,
    riskLevel,
    riskScore,
    categories,
    reversible,
    blastRadius,
    affectedTargets,
    rationale,
    impactPreview,
    checks,
    actionRiskRecord,
  };
}

/**
 * Synchronous pre-execution risk simulation & impact preview for an MCP tool call.
 */
export function simulateToolExecution(
  call: ToolCallInput,
  context: SimulationContext = {}
): RiskSimulationResult {
  const checks = inspectStructuredTool(call, context);
  return finalizeSimulation(call, checks, context);
}

/**
 * Async pre-execution risk simulation that additionally performs read-only filesystem
 * probes (stat / entry count) to detect silent file overwrites and quantify blast radius.
 */
export async function simulateToolExecutionWithProbe(
  call: ToolCallInput,
  context: SimulationContext = {}
): Promise<RiskSimulationResult> {
  const checks = inspectStructuredTool(call, context);
  const notes: string[] = [];

  if (context.inspectFilesystem !== false) {
    const args = call.args ?? {};
    const tool = call.tool.toLowerCase();
    const action = (call.action ?? '').toLowerCase();
    const rawTarget =
      (typeof args.uri === 'string' ? args.uri : typeof args.path === 'string' ? args.path : '') || '';
    const cleanTarget = rawTarget.replace(/^file:\/\//i, '');

    if (cleanTarget && (tool === 'fs' || tool === 'write' || tool === 'write_file' || tool === 'rm')) {
      try {
        const st = await fs.lstat(cleanTarget);
        if (st.isDirectory() && (action === 'rm' || tool === 'rm')) {
          const entries = await fs.readdir(cleanTarget).catch(() => [] as string[]);
          notes.push(`Probe: target directory contains ${entries.length} direct entr${entries.length === 1 ? 'y' : 'ies'}.`);
        } else if (st.isFile()) {
          notes.push(`Probe: existing file is ${st.size} bytes.`);
          const isWriteTool = action === 'write' || tool === 'write' || tool === 'write_file';
          const insideWorkspace = Boolean(
            context.workspaceRoot &&
              isWithinCanonicalRoot(
                resolveCanonicalPath(cleanTarget, context.workspaceRoot).resolvedPath,
                resolveCanonicalRoot(context.workspaceRoot)
              )
          );
          if (
            isWriteTool &&
            (!isTmpScratchPath(cleanTarget) || insideWorkspace) &&
            !checks.some((c) => c.category === 'destructive_fs_overwrite')
          ) {
            checks.push({
              category: 'destructive_fs_overwrite',
              verdict: 'confirm',
              severity: 'medium',
              target: cleanTarget,
              rationale: `Would overwrite existing non-empty file '${cleanTarget}' (${st.size} bytes)`,
              reversible: false,
              blastRadius: 'single_file',
            });
          }
        }
      } catch {
        // File does not currently exist; creating a new file is safe
      }
    }

    if (action === 'mv' && typeof args.destination === 'string') {
      const destClean = args.destination.replace(/^file:\/\//i, '');
      try {
        const st = await fs.lstat(destClean);
        notes.push(`Probe: destination '${destClean}' already exists (${st.size} bytes) and would be replaced.`);
      } catch {
        // Destination does not exist
      }
    }
  }

  return finalizeSimulation(call, checks, context, notes);
}

/**
 * Evaluate a ToolEmu-style suite of unsafe and benign tool calls, returning
 * unsafe-action detection recall and false-block / false-positive rates.
 */
export function evaluateToolEmuSuite(
  cases: ToolEmuCase[],
  defaultContext: SimulationContext = {}
): ToolEmuSuiteReport {
  let unsafeTotal = 0;
  let detected = 0;
  let blocked = 0;
  let confirmed = 0;

  let benignTotal = 0;
  let allowed = 0;
  let falseConfirms = 0;
  let falseBlocks = 0;

  const results: ToolEmuSuiteReport['results'] = [];

  for (const c of cases) {
    const simulation = simulateToolExecution(c.call, c.context ?? defaultContext);
    const v = simulation.verdict;
    const isFlagged = v !== 'allow';

    if (c.expectedUnsafe) {
      unsafeTotal++;
      const minRank = c.minimumVerdict ? VERDICT_RANK[c.minimumVerdict] : 1;
      if (VERDICT_RANK[v] >= minRank) detected++;
      if (v === 'block') blocked++;
      else if (v === 'confirm') confirmed++;
    } else {
      benignTotal++;
      if (v === 'allow') allowed++;
      else if (v === 'confirm') falseConfirms++;
      else if (v === 'block') falseBlocks++;
    }

    results.push({
      id: c.id,
      category: c.category,
      expectedUnsafe: c.expectedUnsafe,
      verdict: v,
      detected: c.expectedUnsafe ? isFlagged : !isFlagged,
      simulation,
    });
  }

  return {
    total: cases.length,
    unsafe: {
      total: unsafeTotal,
      detected,
      blocked,
      confirmed,
      missed: unsafeTotal - detected,
      recall: unsafeTotal > 0 ? Number((detected / unsafeTotal).toFixed(4)) : 1,
    },
    benign: {
      total: benignTotal,
      allowed,
      falseConfirms,
      falseBlocks,
      falseBlockRate: benignTotal > 0 ? Number((falseBlocks / benignTotal).toFixed(4)) : 0,
      falsePositiveRate: benignTotal > 0 ? Number(((falseBlocks + falseConfirms) / benignTotal).toFixed(4)) : 0,
    },
    results,
  };
}

// =============================================================================
// HIP-1348 / HIP-1347 Shadow-State Copy-on-Write Risky-Tool Effect Simulator
// =============================================================================

export type RiskSimulatorPolicyMode =
  | 'no_simulation_baseline'
  | 'static_denylist_only'
  | 'heuristic_param_inspector'
  | 'shadow_state_simulator'
  | 'overly_strict_negative';

export type ActionRiskDecisionVerdict = 'allow' | 'require_confirmation' | 'deny';
export type ActionRiskSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type PredictedEffectKind =
  | 'files_deleted'
  | 'files_overwritten'
  | 'sensitive_paths_accessed'
  | 'external_egress_detected'
  | 'destructive_shell_pattern'
  | 'irreversible_git_mutation'
  | 'mass_blast_radius'
  | 'privilege_escalation';

export interface PredictedEffect {
  kind: PredictedEffectKind;
  target: string;
  severity: ActionRiskSeverity;
  reversible: boolean;
  detail: string;
}

export interface ShadowBlastRadius {
  filesAffected: number;
  bytesAffected: number;
  reversible: boolean;
  workspaceEscaped: boolean;
}

export interface ShadowDiffSummary {
  mode: RiskSimulatorPolicyMode;
  snapshotUsed: boolean;
  workspaceRoot: string;
  beforeFileCount: number;
  afterFileCount: number;
  createdPaths: string[];
  modifiedPaths: string[];
  deletedPaths: string[];
  escapedPaths: string[];
  summary: string;
}

/**
 * Structured non-generative Kai `action.risk@1` decision envelope emitted
 * prior to live MCP tool execution.
 */
export interface ActionRiskDecision {
  schemaVersion: 'action.risk@1';
  tool: string;
  action: string;
  riskScore: number;
  severity: ActionRiskSeverity;
  decision: ActionRiskDecisionVerdict;
  predictedEffects: PredictedEffect[];
  blastRadius: ShadowBlastRadius;
  shadowDiff: ShadowDiffSummary;
  rationale: string[];
  tenantId?: string;
  sessionId?: string;
}

export interface ToolEffectSimulatorOptions {
  policyMode?: RiskSimulatorPolicyMode;
  workspaceRoot?: string;
  allowedHosts?: string[];
  protectedBranches?: string[];
  maxSafeBatchFiles?: number;
  maxSafeBatchBytes?: number;
  blockThreshold?: number;
  confirmThreshold?: number;
  confirmPolicy?: 'block_unconfirmed' | 'allow_confirmed';
  maxSnapshotEntries?: number;
  tenantId?: string;
  sessionId?: string;
  onDecision?: (decision: ActionRiskDecision, call: ToolCallInput) => void;
}

export interface WrapToolsRiskOptions {
  /** Allow callers to bypass `require_confirmation` when `args.risk_confirmed === true` (never bypasses `deny`). */
  allowConfirmedArg?: boolean;
  /** Optional per-call context resolver for multi-tenant / per-session isolation. */
  resolveContext?: (toolName: string, args: Record<string, unknown>) => Partial<ToolEffectSimulatorOptions> | undefined;
}

interface ShadowEntry {
  relPath: string;
  absPath: string;
  realPath: string;
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  escaped: boolean;
}

interface WorkspaceSnapshot {
  realRoot: string;
  files: Map<string, ShadowEntry>;
  dirs: Set<string>;
  fileCount: number;
}

interface CanonicalResolution {
  lexicalPath: string;
  resolvedPath: string;
  exists: boolean;
  isSymlink: boolean;
  workspaceEscaped: boolean;
  symlinkEscaped: boolean;
}

const SEVERITY_RANK: Record<ActionRiskSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const SEVERITY_BASE_SCORE: Record<ActionRiskSeverity, number> = {
  none: 0,
  low: 20,
  medium: 48,
  high: 72,
  critical: 95,
};

const DECISION_RANK: Record<ActionRiskDecisionVerdict, number> = {
  allow: 0,
  require_confirmation: 1,
  deny: 2,
};

const CRITICAL_WORKSPACE_FILE_RE =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|tsconfig\.json|Dockerfile|docker-compose\.ya?ml|\.git(?:ignore|modules|attributes)?|config\/[^/]+\.(?:json|ya?ml|toml)|production\.(?:json|ya?ml|env))$/i;

const STATIC_DENYLIST_PATTERNS: Array<{ label: string; kind: PredictedEffectKind; re: RegExp }> = [
  { label: 'rm -rf command pattern', kind: 'files_deleted', re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/i },
  { label: 'git push --force pattern', kind: 'irreversible_git_mutation', re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force\b|\s-f\b)/i },
  { label: 'git reset --hard pattern', kind: 'irreversible_git_mutation', re: /\bgit\b[^\n]*\breset\s+--hard\b/i },
  { label: 'curl/wget pipe-to-shell pattern', kind: 'destructive_shell_pattern', re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?\w*sh\b/i },
  { label: 'chmod 777 pattern', kind: 'privilege_escalation', re: /\bchmod\b[^\n]*\b777\b/i },
  { label: 'sudo elevation pattern', kind: 'privilege_escalation', re: /\bsudo\s+/i },
  { label: 'block device / SQL wipe pattern', kind: 'destructive_shell_pattern', re: /\b(?:mkfs(?:\.\w+)?|dd\b[^\n]*\bof=\/dev\/|DROP\s+(?:TABLE|DATABASE))\b/i },
];

/**
 * Canonicalizes a workspace root with `fs.realpathSync` so symlinked TMPDIR paths
 * (such as macOS `/var/folders` -> `/private/var/folders`) match Linux identically.
 */
export function resolveCanonicalRoot(workspaceRoot?: string): string {
  const raw = path.resolve(workspaceRoot ?? process.cwd());
  try {
    return fsSync.realpathSync(raw);
  } catch {
    return raw;
  }
}

function isWithinCanonicalRoot(candidatePath: string, realRoot: string): boolean {
  const normCandidate = path.resolve(candidatePath);
  const normRoot = path.resolve(realRoot);
  return normCandidate === normRoot || normCandidate.startsWith(normRoot + path.sep);
}

/**
 * Resolves a target path against a canonical workspace root using `fs.realpathSync`,
 * walking existing parent ancestors for non-existent leaf targets and detecting both
 * lexical `../` traversal and on-disk symlink escapes outside the workspace root.
 */
export function resolveCanonicalPath(rawTarget: string, workspaceRoot?: string): CanonicalResolution {
  const realRoot = resolveCanonicalRoot(workspaceRoot);
  const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, '').replace(/^file:\/\//i, '');

  if (!cleaned) {
    return {
      lexicalPath: realRoot,
      resolvedPath: realRoot,
      exists: true,
      isSymlink: false,
      workspaceEscaped: false,
      symlinkEscaped: false,
    };
  }

  // Explicit home-directory tilde/env expansion always leaves workspace root
  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('$HOME') || cleaned.startsWith('${HOME}')) {
    return {
      lexicalPath: cleaned,
      resolvedPath: cleaned,
      exists: false,
      isSymlink: false,
      workspaceEscaped: true,
      symlinkEscaped: false,
    };
  }

  const lexicalPath = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(realRoot, cleaned);
  let exists = false;
  let isSymlink = false;
  let resolvedPath = lexicalPath;

  try {
    const lst = fsSync.lstatSync(lexicalPath);
    exists = true;
    isSymlink = lst.isSymbolicLink();
    try {
      resolvedPath = fsSync.realpathSync(lexicalPath);
    } catch {
      if (isSymlink) {
        const linkTarget = fsSync.readlinkSync(lexicalPath);
        resolvedPath = path.resolve(path.dirname(lexicalPath), linkTarget);
      }
    }
  } catch {
    // Target does not exist yet: walk upward until an existing ancestor is found,
    // then canonicalize that ancestor via realpathSync so symlinked parent dirs and
    // macOS /var -> /private/var TMPDIR aliases are handled accurately.
    const trailing: string[] = [];
    let cursor = lexicalPath;
    while (true) {
      try {
        const ancestorReal = fsSync.realpathSync(cursor);
        resolvedPath = trailing.length > 0 ? path.join(ancestorReal, ...trailing.reverse()) : ancestorReal;
        break;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          resolvedPath = lexicalPath;
          break;
        }
        trailing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }

  // Re-normalize lexicalPath relative to realRoot when the lexical path only differed via TMPDIR alias
  const lexicalInside = isWithinCanonicalRoot(lexicalPath, realRoot) || (
    workspaceRoot ? isWithinCanonicalRoot(lexicalPath, path.resolve(workspaceRoot)) : false
  );
  const resolvedInside = isWithinCanonicalRoot(resolvedPath, realRoot);

  return {
    lexicalPath,
    resolvedPath,
    exists,
    isSymlink,
    workspaceEscaped: !resolvedInside,
    symlinkEscaped: lexicalInside && !resolvedInside,
  };
}

function isScopedScratchTarget(rawTarget: string, resolution: CanonicalResolution, realRoot: string): boolean {
  const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, '').replace(/^file:\/\//i, '');
  if (!cleaned || cleaned.includes('*') || cleaned.includes('?') || cleaned.includes('..')) return false;
  if (resolution.symlinkEscaped) return false;
  if (isCredentialPath(cleaned, realRoot)) return false;

  // Inside workspace `.tmp/<file>` or `tmp/<file>`
  if (!resolution.workspaceEscaped) {
    const rel = path.relative(realRoot, resolution.resolvedPath).replace(/\\/g, '/');
    if (/^(?:\.tmp|tmp)\/[^/]+$/.test(rel)) return true;
    return false;
  }

  // Explicit single scratch file in /tmp/<filename> (not directory /tmp itself)
  const posixNorm = path.posix.normalize(cleaned.replace(/\\/g, '/'));
  return /^\/tmp\/[^/]+$/.test(posixNorm);
}

function collectWorkspaceSnapshot(realRoot: string, maxEntries = 4000): WorkspaceSnapshot {
  const files = new Map<string, ShadowEntry>();
  const dirs = new Set<string>();
  let visited = 0;

  if (!fsSync.existsSync(realRoot)) {
    return { realRoot, files, dirs, fileCount: 0 };
  }

  const walk = (dirAbs: string, relPrefix: string) => {
    if (visited >= maxEntries) return;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      const name = entry.name;
      if (name === 'node_modules' || (relPrefix === '.git' && name === 'objects')) continue;
      visited++;
      const absPath = path.join(dirAbs, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;

      let lst: fsSync.Stats;
      try {
        lst = fsSync.lstatSync(absPath);
      } catch {
        continue;
      }

      const isSymlink = lst.isSymbolicLink();
      let realPath = absPath;
      let size = lst.size;
      let isDirectory = lst.isDirectory();

      if (isSymlink) {
        try {
          realPath = fsSync.realpathSync(absPath);
          const targetStat = fsSync.statSync(realPath);
          size = targetStat.size;
          isDirectory = targetStat.isDirectory();
        } catch {
          try {
            realPath = path.resolve(path.dirname(absPath), fsSync.readlinkSync(absPath));
          } catch {
            realPath = absPath;
          }
        }
      }

      const escaped = !isWithinCanonicalRoot(realPath, realRoot);

      if (isDirectory && !isSymlink) {
        dirs.add(relPath);
        walk(absPath, relPath);
      } else {
        files.set(relPath, {
          relPath,
          absPath,
          realPath,
          size,
          isDirectory,
          isSymlink,
          escaped,
        });
      }
    }
  };

  walk(realRoot, '');
  return { realRoot, files, dirs, fileCount: files.size };
}

function globToRegExp(globPattern: string): RegExp {
  const escaped = globPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchSnapshotPaths(
  snapshot: WorkspaceSnapshot,
  rawTarget: string,
  realRoot: string
): ShadowEntry[] {
  const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, '').replace(/^file:\/\//i, '');
  if (!cleaned) return [];

  // Wildcard / glob matching against snapshot
  if (cleaned.includes('*') || cleaned.includes('?')) {
    const relPattern = path.isAbsolute(cleaned)
      ? path.relative(realRoot, path.resolve(cleaned)).replace(/\\/g, '/')
      : cleaned.replace(/^\.\//, '').replace(/\\/g, '/');
    const re = globToRegExp(relPattern);
    const matches: ShadowEntry[] = [];
    for (const entry of snapshot.files.values()) {
      if (re.test(entry.relPath)) matches.push(entry);
    }
    return matches;
  }

  const res = resolveCanonicalPath(cleaned, realRoot);
  if (res.workspaceEscaped) return [];
  const rel = path.relative(realRoot, res.resolvedPath).replace(/\\/g, '/');
  if (!rel || rel === '.') {
    return Array.from(snapshot.files.values());
  }

  const direct = snapshot.files.get(rel);
  if (direct) return [direct];

  // Directory prefix match
  const prefix = `${rel}/`;
  const matches: ShadowEntry[] = [];
  for (const entry of snapshot.files.values()) {
    if (entry.relPath.startsWith(prefix)) matches.push(entry);
  }
  return matches;
}

function extractToolTargetPath(args: Record<string, unknown>): string {
  for (const key of ['uri', 'path', 'file', 'target_path', 'filepath']) {
    const val = args[key];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  }
  return '';
}

function isWriteLikeAction(tool: string, action: string): boolean {
  const t = tool.toLowerCase();
  const a = action.toLowerCase();
  if (t === 'exec' || t === 'bash' || t === 'bg' || t === 'run_command') return true;
  if (t === 'write' || t === 'write_file' || t === 'edit' || t === 'patch' || t === 'rm' || t === 'delete_file') return true;
  if (t === 'fs' && ['write', 'apply_patch', 'patch', 'rm', 'mv', 'mkdir'].includes(a)) return true;
  if (t === 'git' && !['status', 'diff', 'log', 'show'].includes(a)) return true;
  if (t === 'fetch' || t === 'http_request' || t === 'http_post' || t === 'browser' || t === 'connectors' || t.includes('email')) {
    return true;
  }
  return false;
}

function computeDecisionFromEffects(
  effects: PredictedEffect[],
  blastRadius: ShadowBlastRadius,
  confirmThreshold: number,
  blockThreshold: number
): { riskScore: number; severity: ActionRiskSeverity; decision: ActionRiskDecisionVerdict } {
  if (effects.length === 0) {
    return { riskScore: 0, severity: 'none', decision: 'allow' };
  }

  let maxSeverity: ActionRiskSeverity = 'none';
  for (const e of effects) {
    if (SEVERITY_RANK[e.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = e.severity;
    }
  }

  let score = SEVERITY_BASE_SCORE[maxSeverity];
  // Additional corroborating effects raise score deterministically without exceeding 100
  score += Math.min(15, (effects.length - 1) * 5);
  if (blastRadius.workspaceEscaped) score = Math.max(score, 95);
  if (!blastRadius.reversible && score >= 45) score += 5;
  if (blastRadius.filesAffected >= 6) score = Math.max(score, 78);
  score = Math.min(100, Math.max(0, Math.round(score)));

  let decision: ActionRiskDecisionVerdict = 'allow';
  if (score >= blockThreshold || maxSeverity === 'critical' || blastRadius.workspaceEscaped) {
    decision = 'deny';
  } else if (score >= confirmThreshold || maxSeverity === 'medium' || maxSeverity === 'high') {
    decision = 'require_confirmation';
  }

  return { riskScore: score, severity: maxSeverity, decision };
}

/**
 * Runtime schema validator for Kai `action.risk@1` decision envelopes.
 */
export function isValidActionRiskDecision(value: unknown): value is ActionRiskDecision {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 'action.risk@1') return false;
  if (typeof v.tool !== 'string' || !v.tool) return false;
  if (typeof v.action !== 'string') return false;
  if (typeof v.riskScore !== 'number' || v.riskScore < 0 || v.riskScore > 100) return false;
  if (!['none', 'low', 'medium', 'high', 'critical'].includes(String(v.severity))) return false;
  if (!['allow', 'require_confirmation', 'deny'].includes(String(v.decision))) return false;
  if (!Array.isArray(v.predictedEffects) || !Array.isArray(v.rationale)) return false;
  if (!v.blastRadius || typeof v.blastRadius !== 'object') return false;
  const br = v.blastRadius as Record<string, unknown>;
  if (
    typeof br.filesAffected !== 'number' ||
    typeof br.bytesAffected !== 'number' ||
    typeof br.reversible !== 'boolean' ||
    typeof br.workspaceEscaped !== 'boolean'
  ) {
    return false;
  }
  if (!v.shadowDiff || typeof v.shadowDiff !== 'object') return false;
  const sd = v.shadowDiff as Record<string, unknown>;
  return (
    typeof sd.mode === 'string' &&
    typeof sd.snapshotUsed === 'boolean' &&
    typeof sd.workspaceRoot === 'string' &&
    typeof sd.beforeFileCount === 'number' &&
    typeof sd.afterFileCount === 'number' &&
    Array.isArray(sd.createdPaths) &&
    Array.isArray(sd.modifiedPaths) &&
    Array.isArray(sd.deletedPaths) &&
    Array.isArray(sd.escapedPaths) &&
    typeof sd.summary === 'string'
  );
}

function splitShellSegmentsQuoteAware(cmd: string): string[] {
  const cleaned = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, ' ');
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      cur += ch;
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === ';' || ch === '\n') {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      if ((ch === '&' && cleaned[i + 1] === '&') || (ch === '|' && cleaned[i + 1] === '|')) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        i++;
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function splitShellPipesQuoteAware(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      cur += ch;
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '|') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Pre-execution Risky-Tool Effect Simulator (`ToolEffectSimulator`).
 *
 * Emulates potentially destructive or privacy-sensitive MCP tool calls prior to
 * live execution against an isolated copy-on-write shadow snapshot of the workspace
 * (never mutating real on-disk state) and returns a deterministic, non-generative
 * Kai `action.risk@1` decision envelope.
 */
export class ToolEffectSimulator {
  private readonly options: Required<
    Pick<
      ToolEffectSimulatorOptions,
      | 'policyMode'
      | 'allowedHosts'
      | 'protectedBranches'
      | 'maxSafeBatchFiles'
      | 'maxSafeBatchBytes'
      | 'blockThreshold'
      | 'confirmThreshold'
      | 'confirmPolicy'
      | 'maxSnapshotEntries'
    >
  > &
    Pick<ToolEffectSimulatorOptions, 'workspaceRoot' | 'tenantId' | 'sessionId' | 'onDecision'>;

  constructor(options: ToolEffectSimulatorOptions = {}) {
    this.options = {
      policyMode: options.policyMode ?? 'shadow_state_simulator',
      workspaceRoot: options.workspaceRoot,
      allowedHosts: options.allowedHosts ? [...options.allowedHosts] : [],
      protectedBranches: options.protectedBranches
        ? [...options.protectedBranches]
        : [...DEFAULT_PROTECTED_BRANCHES],
      maxSafeBatchFiles: options.maxSafeBatchFiles ?? 4,
      maxSafeBatchBytes: options.maxSafeBatchBytes ?? 64 * 1024,
      blockThreshold: options.blockThreshold ?? 75,
      confirmThreshold: options.confirmThreshold ?? 35,
      confirmPolicy: options.confirmPolicy ?? 'block_unconfirmed',
      maxSnapshotEntries: options.maxSnapshotEntries ?? 4000,
      tenantId: options.tenantId,
      sessionId: options.sessionId,
      onDecision: options.onDecision,
    };
  }

  getPolicyMode(): RiskSimulatorPolicyMode {
    return this.options.policyMode;
  }

  getWorkspaceRoot(): string {
    return resolveCanonicalRoot(this.options.workspaceRoot);
  }

  hasExplicitWorkspaceRoot(): boolean {
    return typeof this.options.workspaceRoot === 'string' && this.options.workspaceRoot.length > 0;
  }

  isBlocked(decision: ActionRiskDecision, confirmed = false): boolean {
    if (decision.decision === 'deny') return true;
    if (decision.decision === 'require_confirmation') {
      if (this.options.confirmPolicy === 'allow_confirmed' && confirmed) return false;
      return !confirmed;
    }
    return false;
  }

  /**
   * Simulates an MCP tool invocation without mutating the real workspace.
   * Safe for concurrent multi-tenant / multi-session calls (no shared mutable state).
   */
  async simulate(
    call: ToolCallInput,
    overrideContext: Partial<ToolEffectSimulatorOptions> = {}
  ): Promise<ActionRiskDecision> {
    const policyMode = overrideContext.policyMode ?? this.options.policyMode;
    const realRoot = resolveCanonicalRoot(overrideContext.workspaceRoot ?? this.options.workspaceRoot);
    const allowedHosts = overrideContext.allowedHosts ?? this.options.allowedHosts;
    const protectedBranches = (overrideContext.protectedBranches ?? this.options.protectedBranches).map((b) =>
      b.toLowerCase()
    );
    const maxSafeBatchFiles = overrideContext.maxSafeBatchFiles ?? this.options.maxSafeBatchFiles;
    const maxSafeBatchBytes = overrideContext.maxSafeBatchBytes ?? this.options.maxSafeBatchBytes;
    const blockThreshold = overrideContext.blockThreshold ?? this.options.blockThreshold;
    const confirmThreshold = overrideContext.confirmThreshold ?? this.options.confirmThreshold;
    const maxSnapshotEntries = overrideContext.maxSnapshotEntries ?? this.options.maxSnapshotEntries;
    const tenantId = overrideContext.tenantId ?? this.options.tenantId;
    const sessionId = overrideContext.sessionId ?? this.options.sessionId;
    const onDecision = overrideContext.onDecision ?? this.options.onDecision;

    const tool = call.tool.toLowerCase();
    const args = call.args ?? {};
    const action = (
      call.action ??
      (typeof args.action === 'string' ? args.action : '')
    ).toLowerCase();

    let result: ActionRiskDecision;

    if (policyMode === 'no_simulation_baseline') {
      result = {
        schemaVersion: 'action.risk@1',
        tool: call.tool,
        action,
        riskScore: 0,
        severity: 'none',
        decision: 'allow',
        predictedEffects: [],
        blastRadius: { filesAffected: 0, bytesAffected: 0, reversible: true, workspaceEscaped: false },
        shadowDiff: {
          mode: policyMode,
          snapshotUsed: false,
          workspaceRoot: realRoot,
          beforeFileCount: 0,
          afterFileCount: 0,
          createdPaths: [],
          modifiedPaths: [],
          deletedPaths: [],
          escapedPaths: [],
          summary: 'Baseline mode: pre-execution simulation disabled.',
        },
        rationale: ['No pre-execution simulation configured (baseline control)'],
        ...(tenantId ? { tenantId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    } else if (policyMode === 'overly_strict_negative') {
      result = this.simulateOverlyStrict(call, tool, action, args, realRoot, tenantId, sessionId);
    } else if (policyMode === 'static_denylist_only') {
      result = this.simulateStaticDenylist(call, tool, action, args, realRoot, tenantId, sessionId);
    } else if (policyMode === 'heuristic_param_inspector') {
      result = this.simulateHeuristicOnly(
        call,
        tool,
        action,
        args,
        realRoot,
        allowedHosts,
        protectedBranches,
        confirmThreshold,
        blockThreshold,
        tenantId,
        sessionId
      );
    } else {
      result = this.simulateShadowState(
        call,
        tool,
        action,
        args,
        realRoot,
        allowedHosts,
        protectedBranches,
        maxSafeBatchFiles,
        maxSafeBatchBytes,
        confirmThreshold,
        blockThreshold,
        maxSnapshotEntries,
        tenantId,
        sessionId
      );
    }

    if (onDecision) onDecision(result, call);
    return result;
  }

  private simulateOverlyStrict(
    call: ToolCallInput,
    tool: string,
    action: string,
    args: Record<string, unknown>,
    realRoot: string,
    tenantId?: string,
    sessionId?: string
  ): ActionRiskDecision {
    const target = extractToolTargetPath(args) || (typeof args.command === 'string' ? args.command : call.tool);
    const effects: PredictedEffect[] = [];

    if (isWriteLikeAction(tool, action)) {
      effects.push({
        kind: tool === 'exec' || tool === 'bash' ? 'destructive_shell_pattern' : 'files_overwritten',
        target: target.slice(0, 120),
        severity: 'high',
        reversible: false,
        detail: `Overly strict policy blocks all mutating/execution calls ('${tool}${action ? `.${action}` : ''}') regardless of scope`,
      });
    } else if (target && isCredentialPath(target, realRoot)) {
      effects.push({
        kind: 'sensitive_paths_accessed',
        target,
        severity: 'critical',
        reversible: true,
        detail: `Blocks sensitive credential path '${target}'`,
      });
    } else if (target) {
      const res = resolveCanonicalPath(target, realRoot);
      if (res.workspaceEscaped) {
        effects.push({
          kind: 'sensitive_paths_accessed',
          target,
          severity: 'critical',
          reversible: true,
          detail: `Blocks path escaping workspace root '${target}'`,
        });
      }
    }

    const blocked = effects.length > 0;
    return {
      schemaVersion: 'action.risk@1',
      tool: call.tool,
      action,
      riskScore: blocked ? 85 : 0,
      severity: blocked ? 'high' : 'none',
      decision: blocked ? 'deny' : 'allow',
      predictedEffects: effects,
      blastRadius: {
        filesAffected: blocked ? 1 : 0,
        bytesAffected: 0,
        reversible: !blocked,
        workspaceEscaped: false,
      },
      shadowDiff: {
        mode: 'overly_strict_negative',
        snapshotUsed: false,
        workspaceRoot: realRoot,
        beforeFileCount: 0,
        afterFileCount: 0,
        createdPaths: [],
        modifiedPaths: [],
        deletedPaths: [],
        escapedPaths: [],
        summary: blocked
          ? `Overly strict negative control denied '${tool}${action ? `.${action}` : ''}' unconditionally.`
          : `Read-only tool '${tool}${action ? `.${action}` : ''}' allowed.`,
      },
      rationale: blocked ? effects.map((e) => e.detail) : ['Read-only operation allowed'],
      ...(tenantId ? { tenantId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private simulateStaticDenylist(
    call: ToolCallInput,
    tool: string,
    action: string,
    args: Record<string, unknown>,
    realRoot: string,
    tenantId?: string,
    sessionId?: string
  ): ActionRiskDecision {
    // Naive regex scan across serialized tool arguments (matches naive string blocklists)
    const rawPayload = JSON.stringify(args);
    const effects: PredictedEffect[] = [];

    for (const rule of STATIC_DENYLIST_PATTERNS) {
      if (rule.re.test(rawPayload)) {
        effects.push({
          kind: rule.kind,
          target: call.tool,
          severity: 'high',
          reversible: false,
          detail: `Static denylist matched ${rule.label}`,
        });
      }
    }

    const blocked = effects.length > 0;
    return {
      schemaVersion: 'action.risk@1',
      tool: call.tool,
      action,
      riskScore: blocked ? 80 : 0,
      severity: blocked ? 'high' : 'none',
      decision: blocked ? 'deny' : 'allow',
      predictedEffects: effects,
      blastRadius: {
        filesAffected: 0,
        bytesAffected: 0,
        reversible: !blocked,
        workspaceEscaped: false,
      },
      shadowDiff: {
        mode: 'static_denylist_only',
        snapshotUsed: false,
        workspaceRoot: realRoot,
        beforeFileCount: 0,
        afterFileCount: 0,
        createdPaths: [],
        modifiedPaths: [],
        deletedPaths: [],
        escapedPaths: [],
        summary: blocked
          ? `Static denylist matched ${effects.length} raw keyword pattern(s).`
          : 'No static denylist keyword matched.',
      },
      rationale: blocked ? effects.map((e) => e.detail) : ['No static denylist pattern matched'],
      ...(tenantId ? { tenantId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private simulateHeuristicOnly(
    call: ToolCallInput,
    tool: string,
    action: string,
    args: Record<string, unknown>,
    realRoot: string,
    allowedHosts: string[],
    protectedBranches: string[],
    confirmThreshold: number,
    blockThreshold: number,
    tenantId?: string,
    sessionId?: string
  ): ActionRiskDecision {
    const effects: PredictedEffect[] = [];
    let workspaceEscaped = false;

    this.analyzeToolLexically(
      tool,
      action,
      args,
      realRoot,
      allowedHosts,
      protectedBranches,
      effects,
      () => {
        workspaceEscaped = true;
      }
    );

    const blastRadius: ShadowBlastRadius = {
      filesAffected: effects.some((e) => e.kind === 'files_deleted' || e.kind === 'files_overwritten') ? 1 : 0,
      bytesAffected: 0,
      reversible: effects.every((e) => e.reversible),
      workspaceEscaped,
    };

    const { riskScore, severity, decision } = computeDecisionFromEffects(
      effects,
      blastRadius,
      confirmThreshold,
      blockThreshold
    );

    return {
      schemaVersion: 'action.risk@1',
      tool: call.tool,
      action,
      riskScore,
      severity,
      decision,
      predictedEffects: effects,
      blastRadius,
      shadowDiff: {
        mode: 'heuristic_param_inspector',
        snapshotUsed: false,
        workspaceRoot: realRoot,
        beforeFileCount: 0,
        afterFileCount: 0,
        createdPaths: [],
        modifiedPaths: [],
        deletedPaths: [],
        escapedPaths: workspaceEscaped ? [extractToolTargetPath(args) || 'external'] : [],
        summary:
          effects.length > 0
            ? `Heuristic argument check flagged ${effects.length} risk signal(s) without workspace state simulation.`
            : 'No lexical/parameter risk signals detected (workspace state not inspected).',
      },
      rationale:
        effects.length > 0
          ? effects.map((e) => e.detail)
          : ['No lexical risk signals detected in tool arguments'],
      ...(tenantId ? { tenantId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private simulateShadowState(
    call: ToolCallInput,
    tool: string,
    action: string,
    args: Record<string, unknown>,
    realRoot: string,
    allowedHosts: string[],
    protectedBranches: string[],
    maxSafeBatchFiles: number,
    maxSafeBatchBytes: number,
    confirmThreshold: number,
    blockThreshold: number,
    maxSnapshotEntries: number,
    tenantId?: string,
    sessionId?: string
  ): ActionRiskDecision {
    const snapshot = collectWorkspaceSnapshot(realRoot, maxSnapshotEntries);
    const effects: PredictedEffect[] = [];
    const createdPaths: string[] = [];
    const modifiedPaths: string[] = [];
    const deletedPaths: string[] = [];
    const escapedPaths: string[] = [];
    let bytesAffected = 0;
    let workspaceEscaped = false;

    const markEscape = (target: string, detail: string, kind: PredictedEffectKind = 'sensitive_paths_accessed') => {
      workspaceEscaped = true;
      if (!escapedPaths.includes(target)) escapedPaths.push(target);
      effects.push({
        kind,
        target,
        severity: 'critical',
        reversible: false,
        detail,
      });
    };

    const addDeletedEntries = (entries: ShadowEntry[], rawTarget: string, reasonPrefix: string) => {
      for (const e of entries) {
        if (!deletedPaths.includes(e.relPath)) {
          deletedPaths.push(e.relPath);
          bytesAffected += e.size;
        }
      }
      const count = entries.length;
      if (count >= maxSafeBatchFiles || bytesAffected >= maxSafeBatchBytes) {
        effects.push({
          kind: 'mass_blast_radius',
          target: rawTarget,
          severity: 'critical',
          reversible: false,
          detail: `${reasonPrefix}: shadow simulation projects ${count} file(s) (${bytesAffected} bytes) deleted, exceeding safe threshold (${maxSafeBatchFiles} files)`,
        });
      }
    };

    // 1. Filesystem & code tools — canonical symlink + copy-on-write shadow simulation
    if (
      tool === 'fs' ||
      tool === 'read' ||
      tool === 'read_file' ||
      tool === 'write' ||
      tool === 'write_file' ||
      tool === 'edit' ||
      tool === 'patch' ||
      tool === 'rm' ||
      tool === 'delete_file' ||
      tool === 'code'
    ) {
      const resolvedAction =
        action ||
        (tool === 'rm' || tool === 'delete_file'
          ? 'rm'
          : tool === 'write' || tool === 'write_file'
            ? 'write'
            : tool === 'edit' || tool === 'patch'
              ? 'apply_patch'
              : 'read');
      const rawTarget = extractToolTargetPath(args);

      if (rawTarget) {
        const res = resolveCanonicalPath(rawTarget, realRoot);

        // Symlink or lexical escape outside workspace root (except benign /tmp single-file scratch cleanup)
        const scopedScratch = isScopedScratchTarget(rawTarget, res, realRoot);
        if (res.workspaceEscaped && !(resolvedAction === 'rm' && scopedScratch)) {
          const escapeKind: PredictedEffectKind =
            resolvedAction === 'rm'
              ? 'files_deleted'
              : ['write', 'apply_patch', 'patch', 'mv'].includes(resolvedAction)
                ? 'files_overwritten'
                : 'sensitive_paths_accessed';
          markEscape(
            rawTarget,
            res.symlinkEscaped
              ? `On-disk symlink '${rawTarget}' resolves to '${res.resolvedPath}' outside workspace root`
              : `Path '${rawTarget}' resolves outside workspace root ('${res.resolvedPath}')`,
            escapeKind
          );
        }

        // Sensitive / credential path access check (checks both raw and canonical realpath)
        if (isCredentialPath(rawTarget, realRoot) || isCredentialPath(res.resolvedPath, realRoot)) {
          effects.push({
            kind: 'sensitive_paths_accessed',
            target: rawTarget,
            severity: 'critical',
            reversible: resolvedAction === 'read' || resolvedAction === 'stat',
            detail: `Accesses sensitive credential/secret path '${rawTarget}'`,
          });
        }

        if (!res.workspaceEscaped) {
          const rel = path.relative(realRoot, res.resolvedPath).replace(/\\/g, '/');

          if (resolvedAction === 'rm') {
            if (/(?:^|\/)\.git(?:\/|$)/.test(rel) || rel === '' || rel === '.') {
              effects.push({
                kind: 'files_deleted',
                target: rawTarget,
                severity: 'critical',
                reversible: false,
                detail: `Blocks permanent deletion of repository root or .git metadata ('${rawTarget}')`,
              });
            } else if (!scopedScratch) {
              const matched = matchSnapshotPaths(snapshot, rawTarget, realRoot);
              if (matched.length > 0) {
                addDeletedEntries(matched, rawTarget, `fs.rm '${rel}'`);
                effects.push({
                  kind: 'files_deleted',
                  target: rawTarget,
                  severity: matched.length >= maxSafeBatchFiles ? 'critical' : 'high',
                  reversible: false,
                  detail: `Shadow simulation: fs.rm on '${rel}' permanently deletes ${matched.length} file(s) (${bytesAffected} bytes)`,
                });
              } else {
                effects.push({
                  kind: 'files_deleted',
                  target: rawTarget,
                  severity: 'high',
                  reversible: false,
                  detail: `Permanent deletion requested for workspace path '${rel}'`,
                });
              }
            } else {
              deletedPaths.push(rel);
            }
          } else if (resolvedAction === 'write') {
            if (/(?:^|\/)\.git\/(?:hooks|config)\b/.test(rel)) {
              effects.push({
                kind: 'files_overwritten',
                target: rawTarget,
                severity: 'critical',
                reversible: false,
                detail: `Blocks write to git hook/config '${rel}'`,
              });
            } else {
              const existing = snapshot.files.get(rel);
              if (existing && !scopedScratch) {
                modifiedPaths.push(rel);
                bytesAffected += existing.size;
                const isCriticalFile = CRITICAL_WORKSPACE_FILE_RE.test(rel);
                effects.push({
                  kind: 'files_overwritten',
                  target: rawTarget,
                  severity: isCriticalFile ? 'high' : 'medium',
                  reversible: false,
                  detail: `Shadow simulation: overwrites existing file '${rel}' (${existing.size} bytes)`,
                });
              } else {
                createdPaths.push(rel);
              }
            }
          } else if (resolvedAction === 'apply_patch' || resolvedAction === 'patch') {
            if (/(?:^|\/)\.git\/(?:hooks|config)\b/.test(rel)) {
              effects.push({
                kind: 'files_overwritten',
                target: rawTarget,
                severity: 'critical',
                reversible: false,
                detail: `Blocks patch to git hook/config '${rel}'`,
              });
            } else {
              const existing = snapshot.files.get(rel);
              modifiedPaths.push(rel);
              bytesAffected += existing?.size ?? 0;
            }
          } else if (resolvedAction === 'mv' && typeof args.destination === 'string') {
            const destRes = resolveCanonicalPath(args.destination, realRoot);
            if (destRes.workspaceEscaped) {
              markEscape(
                args.destination,
                `Move destination '${args.destination}' escapes workspace root`,
                'files_overwritten'
              );
            } else {
              const destRel = path.relative(realRoot, destRes.resolvedPath).replace(/\\/g, '/');
              const existingDest = snapshot.files.get(destRel);
              if (existingDest) {
                modifiedPaths.push(destRel);
                bytesAffected += existingDest.size;
                effects.push({
                  kind: 'files_overwritten',
                  target: args.destination,
                  severity: 'medium',
                  reversible: false,
                  detail: `Move would overwrite existing file '${destRel}' (${existingDest.size} bytes)`,
                });
              }
            }
          }
        }
      }
    }

    // 2. Shell execution tools (`exec`, `bash`, `bg`, `run_command`) with shadow blast-radius simulation
    if (tool === 'exec' || tool === 'bash' || tool === 'bg' || tool === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command) {
        this.analyzeShellWithShadow(
          command,
          snapshot,
          realRoot,
          allowedHosts,
          protectedBranches,
          maxSafeBatchFiles,
          maxSafeBatchBytes,
          effects,
          modifiedPaths,
          deletedPaths,
          (deltaBytes) => {
            bytesAffected += deltaBytes;
          },
          markEscape
        );
      }
    }

    // 3. Structured `git` tool
    if (tool === 'git') {
      this.analyzeGitTool(action, args, protectedBranches, effects);
    }

    // 4. Network / connector / email tools
    if (
      tool === 'fetch' ||
      tool === 'http_request' ||
      tool === 'http_post' ||
      tool === 'browser' ||
      tool === 'connectors' ||
      tool.includes('email')
    ) {
      this.analyzeNetworkTool(tool, action, args, allowedHosts, effects);
    }

    const filesAffected = new Set([...createdPaths, ...modifiedPaths, ...deletedPaths, ...escapedPaths]).size;
    const afterFileCount = Math.max(0, snapshot.fileCount + createdPaths.length - deletedPaths.length);
    const blastRadius: ShadowBlastRadius = {
      filesAffected,
      bytesAffected,
      reversible: effects.every((e) => e.reversible),
      workspaceEscaped,
    };

    const { riskScore, severity, decision } = computeDecisionFromEffects(
      effects,
      blastRadius,
      confirmThreshold,
      blockThreshold
    );

    const summaryParts: string[] = [];
    if (deletedPaths.length > 0) summaryParts.push(`-${deletedPaths.length} deleted`);
    if (modifiedPaths.length > 0) summaryParts.push(`~${modifiedPaths.length} modified`);
    if (createdPaths.length > 0) summaryParts.push(`+${createdPaths.length} created`);
    if (escapedPaths.length > 0) summaryParts.push(`!${escapedPaths.length} workspace-escape`);
    const diffSummary =
      summaryParts.length > 0
        ? `Shadow dry-run (${snapshot.fileCount} -> ${afterFileCount} files): ${summaryParts.join(', ')} (${bytesAffected} bytes).`
        : effects.length > 0
          ? `Shadow dry-run (${snapshot.fileCount} files unchanged on disk): ${effects.length} risk effect(s) predicted.`
          : `Shadow dry-run (${snapshot.fileCount} files): read-only or scoped safe operation with no risk signals.`;

    return {
      schemaVersion: 'action.risk@1',
      tool: call.tool,
      action,
      riskScore,
      severity,
      decision,
      predictedEffects: effects,
      blastRadius,
      shadowDiff: {
        mode: 'shadow_state_simulator',
        snapshotUsed: true,
        workspaceRoot: realRoot,
        beforeFileCount: snapshot.fileCount,
        afterFileCount,
        createdPaths,
        modifiedPaths,
        deletedPaths,
        escapedPaths,
        summary: diffSummary,
      },
      rationale:
        effects.length > 0
          ? effects.map((e) => e.detail)
          : ['Shadow state dry-run detected no destructive, privacy, escape, or high-blast-radius effects'],
      ...(tenantId ? { tenantId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private analyzeToolLexically(
    tool: string,
    action: string,
    args: Record<string, unknown>,
    realRoot: string,
    allowedHosts: string[],
    protectedBranches: string[],
    effects: PredictedEffect[],
    onEscape: () => void
  ): void {
    const rawTarget = extractToolTargetPath(args);

    if (
      tool === 'fs' ||
      tool === 'read' ||
      tool === 'read_file' ||
      tool === 'write' ||
      tool === 'write_file' ||
      tool === 'edit' ||
      tool === 'patch' ||
      tool === 'rm' ||
      tool === 'delete_file'
    ) {
      const resolvedAction =
        action ||
        (tool === 'rm' || tool === 'delete_file'
          ? 'rm'
          : tool === 'write' || tool === 'write_file'
            ? 'write'
            : tool === 'edit' || tool === 'patch'
              ? 'apply_patch'
              : 'read');

      if (rawTarget) {
        if (isCredentialPath(rawTarget, realRoot)) {
          effects.push({
            kind: 'sensitive_paths_accessed',
            target: rawTarget,
            severity: 'critical',
            reversible: resolvedAction === 'read',
            detail: `Lexical check: sensitive credential path '${rawTarget}'`,
          });
        }

        // Pure lexical traversal check (does NOT inspect on-disk symlinks!)
        const cleaned = rawTarget.replace(/^file:\/\//i, '');
        const lexicalAbs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(realRoot, cleaned);
        const insideLexicalRoot = isWithinCanonicalRoot(lexicalAbs, realRoot);
        const isDirectTmpFile = /^\/tmp\/[^/]+$/.test(path.posix.normalize(cleaned.replace(/\\/g, '/')));
        const isWorkspaceTmpFile =
          insideLexicalRoot && /^(?:\.tmp|tmp)\/[^/]+$/.test(path.relative(realRoot, lexicalAbs).replace(/\\/g, '/'));
        const lexicallyEscaped =
          /(?:^|\/)\.\.(?:\/|$)/.test(cleaned) || (!insideLexicalRoot && !isDirectTmpFile);
        if (lexicallyEscaped) {
          onEscape();
          effects.push({
            kind: resolvedAction === 'rm' ? 'files_deleted' : 'sensitive_paths_accessed',
            target: rawTarget,
            severity: 'critical',
            reversible: false,
            detail: `Lexical traversal outside workspace root: '${rawTarget}'`,
          });
        }

        if (resolvedAction === 'rm' && !isWorkspaceTmpFile && !isDirectTmpFile) {
          effects.push({
            kind: 'files_deleted',
            target: rawTarget,
            severity: 'high',
            reversible: false,
            detail: `Lexical check: permanent deletion requested on '${rawTarget}'`,
          });
        }
      }
    }

    if (tool === 'exec' || tool === 'bash' || tool === 'bg' || tool === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command) {
        this.analyzeShellLexicallyOnly(command, realRoot, allowedHosts, protectedBranches, effects, onEscape);
      }
    }

    if (tool === 'git') {
      this.analyzeGitTool(action, args, protectedBranches, effects);
    }

    if (
      tool === 'fetch' ||
      tool === 'http_request' ||
      tool === 'http_post' ||
      tool === 'browser' ||
      tool === 'connectors' ||
      tool.includes('email')
    ) {
      this.analyzeNetworkTool(tool, action, args, allowedHosts, effects);
    }
  }

  private analyzeShellLexicallyOnly(
    cmd: string,
    realRoot: string,
    allowedHosts: string[],
    protectedBranches: string[],
    effects: PredictedEffect[],
    onEscape: () => void
  ): void {
    // Pipe-to-shell RCE / obfuscated base64-to-shell
    if (
      /\b(curl|wget|fetch)\b[^|\n]*\|\s*(?:sudo\s+)?(?:\w*sh|python3?|perl|ruby|node)\b/i.test(cmd) ||
      /\bbase64\s+(?:-d|-D|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?\w*sh\b/i.test(cmd) ||
      /\b(?:\w*sh|source|\.)\s+<\(\s*(?:curl|wget)\b/i.test(cmd) ||
      /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i.test(cmd)
    ) {
      effects.push({
        kind: 'destructive_shell_pattern',
        target: cmd.slice(0, 120),
        severity: 'critical',
        reversible: false,
        detail: 'Pipes remote or obfuscated payload directly into shell interpreter',
      });
    }

    if (METADATA_SSRF_RE.test(cmd)) {
      effects.push({
        kind: 'external_egress_detected',
        target: 'instance-metadata',
        severity: 'critical',
        reversible: false,
        detail: 'Targets cloud metadata endpoint (SSRF)',
      });
    }

    const credMention = cmd.match(
      /(~\/\.ssh\/\S*|\/etc\/shadow\b|\.aws\/credentials\b|\.netrc\b|\.git-credentials\b|\.kube\/config\b|\.gnupg\S*|\bid_rsa\b|\bid_ed25519\b|\.env(?:\.(?:local|prod|production|staging|dev|development))?(?=\s|$|['"`;&|]))/i
    );
    const hasNetCmd = /\b(curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync)\b/i.test(cmd);
    if (credMention && hasNetCmd && !BENIGN_ENV_TEMPLATES.test(credMention[0])) {
      effects.push({
        kind: 'external_egress_detected',
        target: credMention[0],
        severity: 'critical',
        reversible: false,
        detail: `Combines sensitive path '${credMention[0]}' with outbound network command`,
      });
    }

    for (const seg of splitShellSegmentsQuoteAware(cmd)) {
      const cleanedSeg = seg.replace(/^(?:\w+=\S*\s+)+/, '').trim();
      const pipeParts = splitShellPipesQuoteAware(cleanedSeg);

      for (const part of pipeParts) {
        const words = tokenizeWords(part);
        if (words.length === 0) continue;
        let idx = 0;

        if (/^(?:sudo|su|doas)$/.test(words[0])) {
          effects.push({
            kind: 'privilege_escalation',
            target: part.slice(0, 100),
            severity: 'high',
            reversible: false,
            detail: `Requests elevated privileges via '${words[0]}'`,
          });
          idx = 1;
          if (idx >= words.length) continue;
        }

        const bin = path.posix.basename(words[idx]);
        const rest = words.slice(idx + 1);

        if (/^(?:rm|rmdir|shred|unlink|rimraf)$/.test(bin)) {
          const targets = rest.filter((w) => !w.startsWith('-'));
          for (const t of targets) {
            if (/^(?:\.tmp|tmp)\/[^/]+$/.test(t) || /^\/tmp\/[^/]+$/.test(t)) continue;
            if (isSystemOrRootPath(t, realRoot)) onEscape();
            effects.push({
              kind: 'files_deleted',
              target: t,
              severity: t.includes('*') || isSystemOrRootPath(t, realRoot) ? 'critical' : 'high',
              reversible: false,
              detail: `Shell deletion command '${bin}' targeting '${t}'`,
            });
          }
        } else if (bin === 'truncate') {
          const targets = rest.filter((w) => !w.startsWith('-') && !/^\d+[KMG]?$/i.test(w));
          for (const t of targets) {
            effects.push({
              kind: 'files_overwritten',
              target: t,
              severity: 'high',
              reversible: false,
              detail: `Truncates '${t}' in place`,
            });
          }
        } else if (bin === 'chmod' && rest.some((w) => w === '777' || w === '0777')) {
          effects.push({
            kind: 'privilege_escalation',
            target: part.slice(0, 100),
            severity: 'critical',
            reversible: false,
            detail: 'Sets world-writable 777 permissions',
          });
        } else if (/^python\d*$/.test(bin) && /shutil\.rmtree|os\.remove|pathlib\.Path.*\.unlink/.test(part)) {
          effects.push({
            kind: 'destructive_shell_pattern',
            target: part.slice(0, 100),
            severity: 'high',
            reversible: false,
            detail: 'Inline Python filesystem deletion',
          });
        } else if (bin === 'node' && /rmSync|unlinkSync|fs\.promises\.rm/.test(part)) {
          effects.push({
            kind: 'destructive_shell_pattern',
            target: part.slice(0, 100),
            severity: 'high',
            reversible: false,
            detail: 'Inline Node.js filesystem deletion',
          });
        } else if (bin === 'find' && /\s-(?:delete|exec\s+rm)\b/.test(part)) {
          effects.push({
            kind: 'files_deleted',
            target: rest.find((w) => !w.startsWith('-')) ?? '.',
            severity: 'high',
            reversible: false,
            detail: 'Bulk find -delete command',
          });
        } else if (bin === 'git') {
          this.analyzeShellGitSegment(rest, protectedBranches, effects);
        } else if (bin === 'curl' || bin === 'wget') {
          const isOutboundWrite =
            /\s(-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-binary|-raw|-urlencode)?|\s-d\s|\s-F\s|-T\s|--upload-file|--post-data|--post-file)/i.test(
              part
            );
          const urlMatch = part.match(/https?:\/\/[^\s'"]+/i);
          const host = urlMatch ? extractHost(urlMatch[0]) : null;
          const allowlisted = host ? isLocalOrAllowlistedHost(host, allowedHosts) : false;
          if (isOutboundWrite && !allowlisted) {
            effects.push({
              kind: 'external_egress_detected',
              target: urlMatch?.[0] ?? bin,
              severity: 'high',
              reversible: false,
              detail: `Outbound HTTP upload to external host '${host ?? 'unknown'}'`,
            });
          }
        }
      }
    }
  }

  private analyzeShellWithShadow(
    cmd: string,
    snapshot: WorkspaceSnapshot,
    realRoot: string,
    allowedHosts: string[],
    protectedBranches: string[],
    maxSafeBatchFiles: number,
    maxSafeBatchBytes: number,
    effects: PredictedEffect[],
    modifiedPaths: string[],
    deletedPaths: string[],
    addBytes: (n: number) => void,
    markEscape: (target: string, detail: string, kind?: PredictedEffectKind) => void
  ): void {
    // 1. Whole-command pipe-to-interpreter & obfuscated shell patterns
    if (
      /\b(curl|wget|fetch)\b[^|\n]*\|\s*(?:sudo\s+)?(?:\w*sh|python3?|perl|ruby|node)\b/i.test(cmd) ||
      /\bbase64\s+(?:-d|-D|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?\w*sh\b/i.test(cmd) ||
      /\b(?:\w*sh|source|\.)\s+<\(\s*(?:curl|wget)\b/i.test(cmd) ||
      /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i.test(cmd)
    ) {
      effects.push({
        kind: 'destructive_shell_pattern',
        target: cmd.slice(0, 120),
        severity: 'critical',
        reversible: false,
        detail: 'Pipes remote or base64-obfuscated payload directly into shell interpreter',
      });
    }

    if (METADATA_SSRF_RE.test(cmd)) {
      effects.push({
        kind: 'external_egress_detected',
        target: 'instance-metadata',
        severity: 'critical',
        reversible: false,
        detail: 'Targets cloud instance metadata endpoint (SSRF)',
      });
    }

    // Whole-command staged credential archival + external exfiltration detection
    const credMention = cmd.match(
      /(~\/\.ssh\/\S*|\/etc\/shadow\b|\.aws\/credentials\b|\.netrc\b|\.git-credentials\b|\.kube\/config\b|\.gnupg\S*|\bid_rsa\b|\bid_ed25519\b|\.env(?:\.(?:local|prod|production|staging|dev|development))?(?=\s|$|['"`;&|]))/i
    );
    const hasNetCmd = /\b(curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync)\b/i.test(cmd);
    if (credMention && hasNetCmd && !BENIGN_ENV_TEMPLATES.test(credMention[0])) {
      effects.push({
        kind: 'sensitive_paths_accessed',
        target: credMention[0],
        severity: 'critical',
        reversible: false,
        detail: `Staged access to sensitive path '${credMention[0]}' in command chain with network egress`,
      });
      effects.push({
        kind: 'external_egress_detected',
        target: credMention[0],
        severity: 'critical',
        reversible: false,
        detail: `External network exfiltration paired with credential reference '${credMention[0]}'`,
      });
    }

    for (const seg of splitShellSegmentsQuoteAware(cmd)) {
      const cleanedSeg = seg.replace(/^(?:\w+=\S*\s+)+/, '').trim();
      const pipeParts = splitShellPipesQuoteAware(cleanedSeg);

      for (const part of pipeParts) {
        const words = tokenizeWords(part);
        if (words.length === 0) continue;
        let idx = 0;

        if (/^(?:sudo|su|doas)$/.test(words[0])) {
          effects.push({
            kind: 'privilege_escalation',
            target: part.slice(0, 100),
            severity: 'high',
            reversible: false,
            detail: `Requests elevated privileges via '${words[0]}'`,
          });
          idx = 1;
          if (idx >= words.length) continue;
        }

        const bin = path.posix.basename(words[idx]);
        const rest = words.slice(idx + 1);

        // Safe echo without redirection or shell pipe
        if (bin === 'echo' && !/(?:^|\s)1?>\s*[^\s&]/.test(part)) {
          continue;
        }

        // `rm` / `rimraf` / `unlink` with shadow workspace expansion
        if (/^(?:rm|rmdir|shred|unlink|rimraf)$/.test(bin)) {
          const targets = rest.filter((w) => !w.startsWith('-'));
          for (const t of targets) {
            const hasGlob = t.includes('*') || t.includes('?');
            if (!hasGlob) {
              const res = resolveCanonicalPath(t, realRoot);
              if (isScopedScratchTarget(t, res, realRoot)) {
                const rel = res.workspaceEscaped
                  ? t
                  : path.relative(realRoot, res.resolvedPath).replace(/\\/g, '/');
                deletedPaths.push(rel);
                continue;
              }
              if (res.workspaceEscaped) {
                markEscape(t, `Deletion target '${t}' resolves outside workspace root ('${res.resolvedPath}')`, 'files_deleted');
                continue;
              }
            }

            const matched = matchSnapshotPaths(snapshot, t, realRoot);
            let localBytes = 0;
            for (const m of matched) {
              if (!deletedPaths.includes(m.relPath)) {
                deletedPaths.push(m.relPath);
                localBytes += m.size;
              }
            }
            addBytes(localBytes);

            effects.push({
              kind: 'files_deleted',
              target: t,
              severity: hasGlob || matched.length >= maxSafeBatchFiles ? 'critical' : 'high',
              reversible: false,
              detail: `Shadow simulation: '${bin} ${t}' deletes ${matched.length} workspace file(s) (${localBytes} bytes)`,
            });

            if (matched.length >= maxSafeBatchFiles || localBytes >= maxSafeBatchBytes) {
              effects.push({
                kind: 'mass_blast_radius',
                target: t,
                severity: 'critical',
                reversible: false,
                detail: `Mass deletion blast radius: ${matched.length} files (${localBytes} bytes) exceed safe threshold`,
              });
            }
          }
        } else if (bin === 'truncate') {
          const targets = rest.filter((w) => !w.startsWith('-') && !/^\d+[KMG]?$/i.test(w));
          for (const t of targets) {
            const res = resolveCanonicalPath(t, realRoot);
            if (res.workspaceEscaped) {
              markEscape(t, `Truncate target '${t}' resolves outside workspace root`, 'files_overwritten');
              continue;
            }
            const rel = path.relative(realRoot, res.resolvedPath).replace(/\\/g, '/');
            const existing = snapshot.files.get(rel);
            modifiedPaths.push(rel);
            addBytes(existing?.size ?? 0);
            effects.push({
              kind: 'files_overwritten',
              target: t,
              severity: existing && CRITICAL_WORKSPACE_FILE_RE.test(rel) ? 'critical' : 'high',
              reversible: false,
              detail: `Shadow simulation: truncates '${rel}' (${existing?.size ?? 0} bytes) to 0 bytes`,
            });
          }
        } else if (bin === 'find') {
          const isBulkDelete = /\s-(?:delete|exec\s+rm)\b/.test(part);
          const isBulkInPlaceEdit = /\s-exec\s+(?:sed\s+-i|perl\s+-pi|ruby\s+-pi)\b/.test(part);
          if (isBulkDelete || isBulkInPlaceEdit) {
            const searchRoot = rest.find((w) => !w.startsWith('-')) ?? '.';
            const nameFlagIdx = rest.indexOf('-name');
            const nameGlob = nameFlagIdx >= 0 && rest[nameFlagIdx + 1] ? rest[nameFlagIdx + 1] : '*';
            const globQuery =
              searchRoot === '.' ? `**/${nameGlob}` : `${searchRoot.replace(/\/+$/, '')}/**/${nameGlob}`;
            // Match both direct children and nested children under searchRoot
            const rootPrefix = searchRoot === '.' ? '' : `${searchRoot.replace(/^\.\//, '').replace(/\/+$/, '')}/`;
            const nameRe = globToRegExp(nameGlob);
            const matched: ShadowEntry[] = [];
            for (const entry of snapshot.files.values()) {
              if (rootPrefix && !entry.relPath.startsWith(rootPrefix)) continue;
              if (nameRe.test(path.posix.basename(entry.relPath))) matched.push(entry);
            }

            let localBytes = 0;
            for (const m of matched) {
              if (isBulkDelete) {
                if (!deletedPaths.includes(m.relPath)) {
                  deletedPaths.push(m.relPath);
                  localBytes += m.size;
                }
              } else {
                if (!modifiedPaths.includes(m.relPath)) {
                  modifiedPaths.push(m.relPath);
                  localBytes += m.size;
                }
              }
            }
            addBytes(localBytes);

            effects.push({
              kind: isBulkDelete ? 'files_deleted' : 'files_overwritten',
              target: globQuery,
              severity: matched.length >= maxSafeBatchFiles ? 'critical' : 'high',
              reversible: false,
              detail: `Shadow simulation: bulk find ${isBulkDelete ? 'delete' : 'in-place edit'} matches ${matched.length} file(s) (${localBytes} bytes) under '${searchRoot}'`,
            });

            if (matched.length >= maxSafeBatchFiles || localBytes >= maxSafeBatchBytes) {
              effects.push({
                kind: 'mass_blast_radius',
                target: globQuery,
                severity: 'critical',
                reversible: false,
                detail: `Mass batch mutation affects ${matched.length} file(s) (${localBytes} bytes), exceeding safe limit (${maxSafeBatchFiles})`,
              });
            }
          }
        } else if (bin === 'chmod' && rest.some((w) => w === '777' || w === '0777')) {
          effects.push({
            kind: 'privilege_escalation',
            target: part.slice(0, 100),
            severity: 'critical',
            reversible: false,
            detail: 'Recursive/world-writable chmod 777 weakens filesystem security boundary',
          });
        } else if (/^python\d*$/.test(bin) && /shutil\.rmtree|os\.remove|pathlib\.Path.*\.unlink/.test(part)) {
          const pathArgMatch = part.match(/(?:rmtree|remove|unlink)\(\s*['"]([^'"]+)['"]\s*\)/);
          const targetArg = pathArgMatch?.[1] ?? 'workspace';
          const matched = pathArgMatch ? matchSnapshotPaths(snapshot, targetArg, realRoot) : [];
          let localBytes = 0;
          for (const m of matched) {
            if (!deletedPaths.includes(m.relPath)) {
              deletedPaths.push(m.relPath);
              localBytes += m.size;
            }
          }
          addBytes(localBytes);
          effects.push({
            kind: 'destructive_shell_pattern',
            target: targetArg,
            severity: matched.length >= maxSafeBatchFiles ? 'critical' : 'high',
            reversible: false,
            detail: `Inline Python deletion targets '${targetArg}' (${matched.length} file(s), ${localBytes} bytes in shadow snapshot)`,
          });
          if (matched.length >= maxSafeBatchFiles) {
            effects.push({
              kind: 'mass_blast_radius',
              target: targetArg,
              severity: 'critical',
              reversible: false,
              detail: `Inline Python rmtree exceeds safe blast radius (${matched.length} files)`,
            });
          }
        } else if (bin === 'git') {
          this.analyzeShellGitSegment(rest, protectedBranches, effects);
        } else if (bin === 'curl' || bin === 'wget') {
          const isOutboundWrite =
            /\s(-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-binary|-raw|-urlencode)?|\s-d\s|\s-F\s|-T\s|--upload-file|--post-data|--post-file)/i.test(
              part
            );
          const urlMatch = part.match(/https?:\/\/[^\s'"]+/i);
          const host = urlMatch ? extractHost(urlMatch[0]) : null;
          const allowlisted = host ? isLocalOrAllowlistedHost(host, allowedHosts) : false;
          if (isOutboundWrite && !allowlisted) {
            effects.push({
              kind: 'external_egress_detected',
              target: urlMatch?.[0] ?? bin,
              severity: 'high',
              reversible: false,
              detail: `Outbound HTTP upload to external host '${host ?? 'unknown'}'`,
            });
          }
        } else if (/^(?:cat|head|tail|less|more|base64|tar|zip|cp)$/.test(bin)) {
          for (const arg of rest) {
            if (arg.startsWith('-')) continue;
            const res = resolveCanonicalPath(arg, realRoot);
            if (res.symlinkEscaped) {
              markEscape(arg, `Command '${bin}' reads symlink '${arg}' escaping to '${res.resolvedPath}'`);
            } else if (isCredentialPath(arg, realRoot) || isCredentialPath(res.resolvedPath, realRoot)) {
              effects.push({
                kind: 'sensitive_paths_accessed',
                target: arg,
                severity: 'critical',
                reversible: true,
                detail: `Command '${bin}' accesses sensitive credential file '${arg}'`,
              });
            }
          }
        }

        // Output redirection check (excluding /dev/null and fd redirects)
        const redirMatches = part.matchAll(/(?:^|\s)(?:1?>|>>)\s*([^\s;&|]+)/g);
        for (const m of redirMatches) {
          const target = m[1];
          if (target === '/dev/null' || target.startsWith('&')) continue;
          const res = resolveCanonicalPath(target, realRoot);
          if (isScopedScratchTarget(target, res, realRoot)) continue;
          if (res.workspaceEscaped) {
            markEscape(target, `Shell redirect writes outside workspace root to '${target}'`, 'files_overwritten');
          } else {
            const rel = path.relative(realRoot, res.resolvedPath).replace(/\\/g, '/');
            const existing = snapshot.files.get(rel);
            if (existing && !m[0].includes('>>')) {
              modifiedPaths.push(rel);
              addBytes(existing.size);
              effects.push({
                kind: 'files_overwritten',
                target,
                severity: CRITICAL_WORKSPACE_FILE_RE.test(rel) ? 'high' : 'medium',
                reversible: false,
                detail: `Shell redirect '>' overwrites existing file '${rel}' (${existing.size} bytes)`,
              });
            }
          }
        }
      }
    }
  }

  private analyzeShellGitSegment(
    rest: string[],
    protectedBranches: string[],
    effects: PredictedEffect[]
  ): void {
    let subIdx = 0;
    while (subIdx < rest.length) {
      const w = rest[subIdx];
      if (w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '-c') {
        subIdx += 2;
      } else if (w.startsWith('-')) {
        subIdx += 1;
      } else {
        break;
      }
    }
    const sub = rest[subIdx] ?? '';
    const gitArgs = rest.slice(subIdx + 1);

    // Safe dry-run flags for git push / git clean
    const isDryRun =
      gitArgs.includes('--dry-run') ||
      (sub === 'clean' && gitArgs.some((a) => /^-[a-zA-Z]*n/.test(a)));
    if (isDryRun) return;

    if (sub === 'push') {
      const hasForceFlag = gitArgs.some(
        (a) => a === '-f' || a === '--force' || a === '--force-with-lease' || a.startsWith('--force-if-includes')
      );
      const refspecs = gitArgs.filter((a) => !a.startsWith('-'));
      const hasPlusRefspec = refspecs.some((r) => r.startsWith('+') || r.includes(':+'));
      const isForce = hasForceFlag || hasPlusRefspec;
      const targetBranch =
        (refspecs[1] ?? refspecs[0] ?? '').replace(/^\+/, '').split(':').pop()?.toLowerCase() ?? '';
      const hitsProtected =
        !targetBranch ||
        protectedBranches.some((pb) => targetBranch === pb || targetBranch.startsWith(`${pb}/`));

      if (isForce) {
        effects.push({
          kind: 'irreversible_git_mutation',
          target: targetBranch || 'remote',
          severity: hitsProtected ? 'critical' : 'high',
          reversible: false,
          detail: hitsProtected
            ? `Force git push to protected branch '${targetBranch || 'HEAD'}' rewrites shared history`
            : `Force git push to '${targetBranch}' overwrites remote history`,
        });
      }
    } else if (
      (sub === 'reset' && gitArgs.includes('--hard')) ||
      (sub === 'clean' && gitArgs.some((a) => /^-[a-zA-Z]*f/.test(a))) ||
      sub === 'filter-branch' ||
      sub === 'filter-repo' ||
      (sub === 'branch' && gitArgs.includes('-D')) ||
      (sub === 'stash' && (gitArgs.includes('drop') || gitArgs.includes('clear')))
    ) {
      const severe = sub === 'filter-branch' || (sub === 'clean' && gitArgs.some((a) => /^-[a-zA-Z]*x/.test(a)));
      effects.push({
        kind: 'irreversible_git_mutation',
        target: `git ${sub} ${gitArgs.join(' ')}`.trim(),
        severity: severe ? 'critical' : 'high',
        reversible: false,
        detail: `Irreversible git operation 'git ${sub}' permanently discards local changes or history`,
      });
    }
  }

  private analyzeGitTool(
    action: string,
    args: Record<string, unknown>,
    protectedBranches: string[],
    effects: PredictedEffect[]
  ): void {
    if (args.dry_run === true || args.dryRun === true) return;
    if (action === 'push') {
      const targetBranch = String(args.target ?? args.branch ?? args.name ?? args.ref ?? '').toLowerCase();
      const isForce = Boolean(args.force) || targetBranch.startsWith('+');
      const cleanBranch = targetBranch.replace(/^\+/, '');
      const hitsProtected =
        !cleanBranch ||
        protectedBranches.some((pb) => cleanBranch === pb || cleanBranch.startsWith(`${pb}/`));

      if (isForce) {
        effects.push({
          kind: 'irreversible_git_mutation',
          target: cleanBranch || 'remote',
          severity: hitsProtected ? 'critical' : 'high',
          reversible: false,
          detail: `Force git push targeting '${cleanBranch || 'default'}' rewrites remote commit history`,
        });
      }
    } else if (
      (action === 'reset' && args.mode === 'hard') ||
      action === 'clean' ||
      action === 'filter-branch' ||
      (action === 'branch' && args.sub_action === 'delete' && args.force === true) ||
      (action === 'stash' && (args.sub_action === 'drop' || args.sub_action === 'clear'))
    ) {
      effects.push({
        kind: 'irreversible_git_mutation',
        target: `git:${action}`,
        severity: 'high',
        reversible: false,
        detail: `Destructive git tool action '${action}' discards local history or uncommitted changes`,
      });
    }
  }

  private analyzeNetworkTool(
    tool: string,
    action: string,
    args: Record<string, unknown>,
    allowedHosts: string[],
    effects: PredictedEffect[]
  ): void {
    const url = typeof args.url === 'string' ? args.url : '';
    const method = (
      typeof args.method === 'string' ? args.method : tool === 'http_post' ? 'POST' : 'GET'
    ).toUpperCase();
    const payloadBlob = JSON.stringify({
      url,
      headers: args.headers ?? null,
      body: args.body ?? args.data ?? args.text ?? args.content ?? null,
    });

    if (url && METADATA_SSRF_RE.test(url)) {
      effects.push({
        kind: 'external_egress_detected',
        target: url,
        severity: 'critical',
        reversible: false,
        detail: `Blocks SSRF request to cloud metadata endpoint '${url}'`,
      });
    }

    if (url && /^file:\/\//i.test(url)) {
      effects.push({
        kind: 'sensitive_paths_accessed',
        target: url,
        severity: 'critical',
        reversible: false,
        detail: `Blocks local file:// scheme fetch '${url}'`,
      });
    }

    const secretHits = containsSecrets(payloadBlob);
    if (secretHits.length > 0) {
      effects.push({
        kind: 'external_egress_detected',
        target: url || tool,
        severity: 'critical',
        reversible: false,
        detail: `Outbound payload embeds sensitive credential pattern(s): ${secretHits.join(', ')}`,
      });
    } else if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      tool.includes('email') ||
      (tool === 'connectors' && !['list', 'read', 'status', 'get'].includes(action))
    ) {
      const host = url ? extractHost(url) : null;
      const allowlisted = host ? isLocalOrAllowlistedHost(host, allowedHosts) : false;
      if (!allowlisted) {
        effects.push({
          kind: 'external_egress_detected',
          target: url || (typeof args.to === 'string' ? args.to : tool),
          severity: 'high',
          reversible: false,
          detail: `Outbound ${method} / external egress to non-allowlisted host '${host ?? tool}'`,
        });
      }
    }
  }
}

/**
 * Formats a structured MCP error `ToolResult` carrying the Kai `action.risk@1` decision
 * when a risky tool call is blocked or requires explicit confirmation.
 */
export function buildRiskBlockedToolResult(decision: ActionRiskDecision): ToolResult {
  const code =
    decision.decision === 'deny' ? 'RISK_SIMULATION_DENIED' : 'RISK_CONFIRMATION_REQUIRED';
  const payload = {
    ok: false,
    blocked: true,
    error: {
      code,
      message: `${decision.decision === 'deny' ? 'Denied' : 'Confirmation required'} by ToolEffectSimulator (${decision.tool}${decision.action ? `.${decision.action}` : ''}, riskScore=${decision.riskScore}/100, severity=${decision.severity}): ${decision.rationale.join('; ')}`,
    },
    actionRisk: decision,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
    _meta: { actionRisk: decision },
  };
}

/**
 * Opt-in middleware helper that wraps an array of MCP `Tool` definitions with
 * pre-execution `ToolEffectSimulator` gating. Blocked calls never invoke the
 * underlying tool handler.
 */
export function wrapMcpToolsWithRiskSimulator(
  tools: Tool[],
  simulator: ToolEffectSimulator,
  options: WrapToolsRiskOptions = {}
): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    handler: async (args: any): Promise<ToolResult> => {
      const safeArgs: Record<string, unknown> = args && typeof args === 'object' ? args : {};
      const action = typeof safeArgs.action === 'string' ? safeArgs.action : undefined;
      const overrideCtx = options.resolveContext ? options.resolveContext(tool.name, safeArgs) : undefined;
      const decision = await simulator.simulate(
        { tool: tool.name, action, args: safeArgs },
        overrideCtx
      );
      const confirmed = Boolean(options.allowConfirmedArg && safeArgs.risk_confirmed === true);
      if (simulator.isBlocked(decision, confirmed)) {
        return buildRiskBlockedToolResult(decision);
      }
      const result = await tool.handler(safeArgs);
      return {
        ...result,
        _meta: {
          ...(result._meta ?? {}),
          actionRisk: decision,
        },
      };
    },
  }));
}

