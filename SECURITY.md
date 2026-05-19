# Security Policy

## Reporting a vulnerability

Email security@hanzo.ai with details. Encrypt with our PGP key (fingerprint TBD).

We respond within 48 hours. Critical issues receive same-day acknowledgment.

## Scope

This policy covers code in this repository. For the broader Hanzo platform threat model, see [hanzoai/HIPs](https://github.com/hanzoai/HIPs).

## Sandbox boundary

`mcp` runs as a privileged-but-local stdio server in the user's environment — every tool call (`fs`, `exec`, `code`, `git`, `fetch`) executes with the user's own permissions on the user's machine. Tools that read secrets honor the `kms` per-secret AI policy (auto-approve, requires-approval, blocked) and emit audit events; the `hanzo` tool path requires a valid Hanzo IAM identity for any remote action.

For runtime sandbox guarantees, see HIP-0105 (in-process extension runtimes).
