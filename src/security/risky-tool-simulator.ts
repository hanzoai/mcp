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

import * as fs from 'fs/promises';
import * as path from 'path';

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
          const normTarget = normalizeTargetPath(cleanTarget, context.workspaceRoot);
          const normRoot = context.workspaceRoot
            ? path.posix.normalize(context.workspaceRoot.replace(/\\/g, '/'))
            : '';
          const insideWorkspace = Boolean(normRoot) && (normTarget === normRoot || normTarget.startsWith(`${normRoot}/`));
          const isExternalScratch = !insideWorkspace && isTmpScratchPath(cleanTarget);
          if (isWriteTool && !isExternalScratch && !checks.some((c) => c.category === 'destructive_fs_overwrite')) {
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
