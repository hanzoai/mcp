import { describe, expect, test } from '@jest/globals';
import {
  SemanticChangePlanner,
  SemanticPlannerError,
  createSemanticEditTools,
  evaluateSemanticEditBenchmark,
  validateStructuralSyntax,
} from '../../src/semantic-edit/index.js';

describe('HIP-1347 SemanticChangePlanner (#38)', () => {
  test('rewrites nested AST calls while leaving comments and string literals untouched', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/core/src/http.ts',
        content: [
          '// Comment: legacyGet(url, true) must stay unchanged',
          'const DOC = "Do not touch legacyGet(endpoint, false) in strings";',
          'export function loadProfile(id: string): string {',
          '  return legacyGet(buildEndpoint("/users", id), true);',
          '}',
          'function buildEndpoint(base: string, id: string): string { return base + "/" + id; }',
          'function requestV2(opts: { target: string; auth: boolean }): string { return opts.target; }',
        ].join('\n'),
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/core/test/http.test.ts',
        content: 'import { loadProfile } from "../src/http";\nexport function testHttp() { return loadProfile("1"); }\n',
      },
    ]);

    const plan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      rules: [
        {
          id: 'rewrite-legacy-get',
          pattern: 'legacyGet($URL, $AUTH)',
          replacement: 'requestV2({ target: $URL, auth: $AUTH })',
          languages: ['typescript'],
        },
      ],
    });

    expect(plan.readyToApply).toBe(true);
    expect(plan.edits).toHaveLength(1);
    const after = plan.edits[0].afterContent;
    expect(after).toContain('// Comment: legacyGet(url, true) must stay unchanged');
    expect(after).toContain('const DOC = "Do not touch legacyGet(endpoint, false) in strings";');
    expect(after).toContain('requestV2({ target: buildEndpoint("/users", id), auth: true })');
    expect(plan.semanticDiff.deltas[0].changeKind).toBe('body_implementation_changed');
    expect(plan.testSelection.tier).toBe('minimal_targeted');
    expect(plan.testSelection.selectedTests).toEqual(['packages/core/test/http.test.ts']);
  });

  test('handles variadic $$$ARGS with zero-arg comma elision and multi-arg preservation', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/obs/src/trace.ts',
        content: [
          'export function emitBoot(): void {',
          '  auditLog("boot_ready");',
          '  auditLog("boot_meta", { port: 8080 }, "ok");',
          '}',
        ].join('\n'),
      },
    ]);

    const plan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      rules: [
        {
          id: 'variadic-audit-log',
          pattern: 'auditLog($EVENT, $$$EXTRA)',
          replacement: 'telemetryEmit($EVENT, $$$EXTRA)',
        },
      ],
    });

    expect(plan.readyToApply).toBe(true);
    const out = plan.edits[0].afterContent;
    expect(out).toContain('telemetryEmit("boot_ready");');
    expect(out).toContain('telemetryEmit("boot_meta", { port: 8080 }, "ok");');
  });

  test('enforces repeated metavariable unification ($X === $X)', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/math/src/nan.ts',
        content: [
          'export function check(x: number, y: number): boolean {',
          '  if (x === y) return true;',
          '  return (x + 1) === (x + 1);',
          '}',
        ].join('\n'),
      },
    ]);

    const matches = planner.searchStructural(
      { id: 'self-eq', pattern: '$X === $X' },
      { tenantId: 't-alpha', repoId: 'repo-1' }
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].captures.$X).toBe('(x + 1)');
  });

  test('rejects syntactically malformed candidate edits prior to commit', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/core/src/broken.ts',
        content: 'export function calc(n: number): number {\n  return n * 2;\n}\n',
      },
    ]);

    const plan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      explicitFileContents: {
        'packages/core/src/broken.ts': 'export function calc(n: number): number {\n  return (n * 2;\n}\n',
      },
      commitIfReady: true,
    });

    expect(plan.readyToApply).toBe(false);
    expect(plan.rejectedEdits).toHaveLength(1);
    expect(plan.rejectedEdits[0].syntaxValidation.valid).toBe(false);
    // Original canonical blob remains intact
    expect(
      planner.getAuthorizedBlob('packages/core/src/broken.ts', {
        tenantId: 't-alpha',
        repoId: 'repo-1',
      })?.content
    ).toContain('return n * 2;');
  });

  test('detects incompatible cross-package arity and symbol-removal breakages', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/auth/src/verify.ts',
        content: [
          'export function checkSession(token: string): boolean {',
          '  return token.length > 0;',
          '}',
          'export function legacyHelper(): string {',
          '  return "v1";',
          '}',
        ].join('\n'),
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/api/src/handler.ts',
        content: [
          'import { checkSession, legacyHelper } from "@repo/auth";',
          'export function serve(tok: string): string {',
          '  return checkSession(tok) ? legacyHelper() : "denied";',
          '}',
        ].join('\n'),
      },
    ]);

    const brokenPlan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      explicitFileContents: {
        'packages/auth/src/verify.ts': [
          'export function checkSession(token: string, realm: string): boolean {',
          '  return token.length > 0 && realm.length > 0;',
          '}',
        ].join('\n'),
      },
    });

    expect(brokenPlan.readyToApply).toBe(false);
    expect(brokenPlan.semanticDiff.hasBreakingCrossPackageChanges).toBe(true);
    expect(brokenPlan.semanticDiff.crossPackageBreakages.length).toBeGreaterThanOrEqual(2);
    expect(
      brokenPlan.semanticDiff.crossPackageBreakages.some(
        (b) => b.symbolName === 'checkSession' && b.changeKind === 'breaking_arity_change'
      )
    ).toBe(true);
    expect(
      brokenPlan.semanticDiff.crossPackageBreakages.some(
        (b) => b.symbolName === 'legacyHelper' && b.changeKind === 'symbol_removed_or_unexported'
      )
    ).toBe(true);
  });

  test('escalates incremental test selection to full suite when dynamic reflection lowers confidence', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/plugins/src/loader.py',
        language: 'python',
        content: [
          'def invoke_plugin(mod, name: str, arg: dict):',
          '    fn = getattr(mod, "plugin_" + name)',
          '    return fn(arg)',
        ].join('\n'),
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/plugins/test/loader.test.ts',
        content: 'import { invoke_plugin } from "../src/loader";\nexport function t1() { return invoke_plugin({}, "a", {}); }\n',
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'packages/billing/test/unrelated.test.ts',
        content: 'export function t2() { return true; }\n',
      },
    ]);

    const plan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      explicitFileContents: {
        'packages/plugins/src/loader.py': [
          'def invoke_plugin(mod, name: str, arg: dict):',
          '    fn = getattr(mod, "v2_plugin_" + name)',
          '    return fn(arg)',
        ].join('\n'),
      },
    });

    expect(plan.testSelection.escalated).toBe(true);
    expect(plan.testSelection.tier).toBe('full_suite_escalation');
    expect(plan.testSelection.selectedTests).toEqual([
      'packages/billing/test/unrelated.test.ts',
      'packages/plugins/test/loader.test.ts',
    ]);
    expect(plan.testSelection.validationContract.selectionIsNotSafetyProof).toBe(true);
  });

  test('classifies comment-only changes as formatting_or_comment_only across Python, Rust, and Go', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'crates/engine/src/lib.rs',
        language: 'rust',
        content: 'pub fn step(x: i32) -> i32 {\n    x + 1\n}\n',
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'services/store/src/store.go',
        language: 'go',
        content: 'package store\nfunc ReadKey(k string) string {\n\treturn k\n}\n',
      },
      {
        tenantId: 't-alpha',
        repoId: 'repo-1',
        filePath: 'crates/engine/test/lib.test.ts',
        content: 'export function t() { return 1; }\n',
      },
    ]);

    const plan = planner.planChange({
      access: { tenantId: 't-alpha', repoId: 'repo-1' },
      explicitFileContents: {
        'crates/engine/src/lib.rs': '// Rust safety comment\npub fn step(x: i32) -> i32 {\n    x + 1\n}\n',
        'services/store/src/store.go': 'package store\n/* Go block comment */\nfunc ReadKey(k string) string {\n\treturn k\n}\n',
      },
    });

    expect(plan.semanticDiff.formattingOnlyFiles).toEqual([
      'crates/engine/src/lib.rs',
      'services/store/src/store.go',
    ]);
    expect(plan.testSelection.tier).toBe('none_formatting_only');
    expect(plan.testSelection.selectedTests).toHaveLength(0);
  });

  test('enforces strict multi-tenant & RBAC pre-filtering and deterministic derived rebuild', () => {
    const planner = new SemanticChangePlanner([
      {
        tenantId: 'tenant-a',
        repoId: 'vault',
        filePath: 'packages/sec/src/secret.ts',
        allowedRoles: ['sec-admin'],
        content: 'export function rotateKey(id: string): string { return legacySign(id); }\n',
      },
      {
        tenantId: 'tenant-b',
        repoId: 'vault',
        filePath: 'packages/sec/src/other.ts',
        content: 'export function otherOp(id: string): string { return legacySign(id); }\n',
      },
    ]);

    // Wrong tenant sees zero structural matches
    const crossTenantMatches = planner.searchStructural(
      { id: 'r1', pattern: 'legacySign($ID)' },
      { tenantId: 'tenant-c', repoId: 'vault', callerRoles: ['sec-admin'] }
    );
    expect(crossTenantMatches).toHaveLength(0);

    // Tenant A without 'sec-admin' role sees zero matches
    const missingRoleMatches = planner.searchStructural(
      { id: 'r1', pattern: 'legacySign($ID)' },
      { tenantId: 'tenant-a', repoId: 'vault', callerRoles: ['viewer'] }
    );
    expect(missingRoleMatches).toHaveLength(0);

    // Authorized role sees only Tenant A's match
    const authorizedMatches = planner.searchStructural(
      { id: 'r1', pattern: 'legacySign($ID)' },
      { tenantId: 'tenant-a', repoId: 'vault', callerRoles: ['sec-admin'] }
    );
    expect(authorizedMatches).toHaveLength(1);
    expect(authorizedMatches[0].filePath).toBe('packages/sec/src/secret.ts');

    // Attempting explicit overwrite across tenants throws TENANT_MISMATCH
    expect(() =>
      planner.planChange({
        access: { tenantId: 'tenant-b', repoId: 'vault' },
        explicitFileContents: {
          'packages/sec/src/secret.ts': 'export function hijacked() {}\n',
        },
      })
    ).toThrow(SemanticPlannerError);

    // Rebuilding derived index from canonical blobs yields identical snapshot digest
    const digestBefore = planner.getDerivedDigest();
    const digestAfter = planner.rebuildDerivedRepresentations();
    expect(digestAfter).toBe(digestBefore);
  });

  test('validates syntax edge cases and exposes working opt-in MCP tools', async () => {
    expect(validateStructuralSyntax('{"ok": true}', 'json').valid).toBe(true);
    expect(validateStructuralSyntax('{"bad": true,}', 'json').valid).toBe(false);
    expect(validateStructuralSyntax('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main', 'typescript').valid).toBe(false);

    const tools = createSemanticEditTools({ defaultTenantId: 'mcp-tenant', defaultRepoId: 'mcp-repo' });
    expect(tools.map((t) => t.name)).toEqual(['semantic_ast_search', 'semantic_change_plan']);

    const planRes = await tools[1].handler({
      files: [
        {
          filePath: 'packages/app/src/main.ts',
          content: 'export function run(v: string): string { return oldCall(v); }\n',
        },
      ],
      rules: [{ id: 'm1', pattern: 'oldCall($V)', replacement: 'newCall($V)' }],
      commitIfReady: true,
    });

    expect(planRes.isError).toBeUndefined();
    const parsed = JSON.parse((planRes.content[0] as { text: string }).text);
    expect(parsed.readyToApply).toBe(true);
    expect(parsed.edits[0].afterContent).toContain('newCall(v)');
  });

  test('reproduces benchmark improvements with zero regression escapes and 100% task completion', () => {
    const report = evaluateSemanticEditBenchmark();
    const regexAgg = report.aggregates.find((a) => a.strategy === 'naive_regex_full_suite')!;
    const static1Hop = report.aggregates.find((a) => a.strategy === 'static_1hop_no_escalation')!;
    const plannerAgg = report.aggregates.find((a) => a.strategy === 'constrained_semantic_planner')!;

    expect(plannerAgg.refactoringSuccessRatePct).toBe(100);
    expect(plannerAgg.compileFailureRatePct).toBe(0);
    expect(plannerAgg.regressionEscapeRatePct).toBe(0);
    expect(plannerAgg.meanTestsPerChange).toBeLessThan(regexAgg.meanTestsPerChange);
    expect(static1Hop.regressionEscapeRatePct).toBeGreaterThan(0);
    expect(regexAgg.compileFailureRatePct).toBeGreaterThan(0);
    expect(report.negativeControls.allControlsSucceeded).toBe(true);
    expect(report.negativeControls.formattingOnlyZeroTestsCount).toBe(4);
  });
});
