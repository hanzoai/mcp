//! The safety verdict on a shell command, and the seam a classifier plugs into.
//!
//! `exec` asks a [`Classify`] about each command before it runs. The classifier is the shell
//! parser and classifier module (a separate piece); this file is only the contract between it
//! and `exec`, so the module lands behind it without `exec` changing. With none installed
//! (`ExecTool::new`) `exec` behaves as it always has and its answers carry no `verdict`.
//!
//! Dev links this crate and asks the same classifier through [`ExecTool::verdict`], so the
//! agent's own shell calls and a Claude Code or Codex user's `exec` calls get one answer.
//!
//! [`ExecTool::verdict`]: super::exec_tool::ExecTool::verdict

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use constant_time_eq::constant_time_eq;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_STORED_APPROVALS: usize = 1024;

/// How far a command may go. Ordered: a verdict is the strictest of its parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    /// Reads, or changes only what the caller's task is about.
    Allow,
    /// Reaches past that (a push, a delete, a write outside the workspace): a person decides.
    Ask,
    /// Never runs from here.
    Deny,
}

/// A classifier's answer for one command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub risk: Risk,
    /// Why, one clause each, naming the part of the command that decided it.
    pub reasons: Vec<String>,
}

impl Verdict {
    pub fn allow() -> Verdict {
        Verdict { risk: Risk::Allow, reasons: Vec::new() }
    }

    pub fn new(risk: Risk, reasons: impl IntoIterator<Item = impl Into<String>>) -> Verdict {
        Verdict { risk, reasons: reasons.into_iter().map(Into::into).collect() }
    }

    pub fn json(&self) -> Value {
        json!({ "risk": self.risk, "reasons": self.reasons })
    }
}

/// Classifies a shell command. `cwd` is where it would run.
pub trait Classify: Send + Sync {
    fn classify(&self, command: &str, cwd: Option<&Path>) -> Verdict;

    /// What the environment handed to a command changes about what it runs. The environment is
    /// part of the command: `BASH_ENV` runs a script under any verdict on the command's text.
    /// A classifier that does not read it allows it.
    fn classify_env(&self, _env: &std::collections::HashMap<String, String>) -> Verdict {
        Verdict::allow()
    }
}

impl Verdict {
    /// The stricter of two verdicts, with both sets of reasons.
    pub fn merge(mut self, other: Verdict) -> Verdict {
        self.risk = self.risk.max(other.risk);
        self.reasons.extend(other.reasons);
        self
    }
}

/// Source of an approval decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalSource {
    /// The model supplied `approve: true` in the tool call (deprecated, never satisfies `Ask`).
    ModelFlag,
    /// A single-use out-of-band approval token minted by the host/operator.
    Token,
    /// An operator policy (config / env) that pre-approves specific safe command patterns.
    OperatorPolicy,
    /// MCP elicitation / client-side confirmation.
    McpElicitation,
}

/// A non-secret pending approval request recorded when an `Ask` command is refused.
///
/// The refusal error returns ONLY `request_id` (never an approval token) so a model
/// cannot self-approve by echoing the error message back. An out-of-band host/operator
/// calls [`TokenApprover::approve_request`] after human confirmation to mint a secret
/// single-use [`ApprovalToken`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub request_id: String,
    pub command_hash: String,
    pub cwd: Option<String>,
    pub env_hash: String,
    pub created_at: u64,
    pub expires_at: u64,
}

/// A cryptographically random, single-use out-of-band approval token bound via SHA-256
/// to an exact `(command, cwd, env)` tuple.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalToken {
    pub token: String,
    pub command_hash: String,
    pub cwd: Option<String>,
    pub env_hash: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

impl ApprovalToken {
    /// Create a new approval token bound to the exact command, cwd, and env.
    pub fn new(
        command: &str,
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
        ttl_secs: u64,
    ) -> Self {
        Self::from_hashes(
            hash_command(command),
            cwd.map(|p| p.display().to_string()),
            hash_env(env),
            ttl_secs,
        )
    }

    fn from_hashes(
        command_hash: String,
        cwd: Option<String>,
        env_hash: String,
        ttl_secs: u64,
    ) -> Self {
        let issued_at = now_secs();
        let expires_at = issued_at.saturating_add(ttl_secs);
        let token = format!("appr_{}", random_hex::<32>());
        Self { token, command_hash, cwd, env_hash, issued_at, expires_at }
    }

    /// Check if the token is unexpired and bound to the exact command, cwd, and env.
    pub fn verify(&self, command: &str, cwd: Option<&Path>, env: &HashMap<String, String>) -> bool {
        if now_secs() >= self.expires_at {
            return false;
        }
        if !constant_time_eq(self.command_hash.as_bytes(), hash_command(command).as_bytes()) {
            return false;
        }
        if self.cwd != cwd.map(|p| p.display().to_string()) {
            return false;
        }
        if !constant_time_eq(self.env_hash.as_bytes(), hash_env(env).as_bytes()) {
            return false;
        }
        true
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn hash_command(command: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"hanzo-exec-cmd-v1\0");
    hasher.update(command.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hash_env(env: &HashMap<String, String>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"hanzo-exec-env-v1\0");
    let mut sorted: Vec<(&String, &String)> = env.iter().collect();
    sorted.sort_by(|(a, _), (b, _)| a.cmp(b));
    for (k, v) in sorted {
        hasher.update((k.len() as u64).to_be_bytes());
        hasher.update(k.as_bytes());
        hasher.update((v.len() as u64).to_be_bytes());
        hasher.update(v.as_bytes());
    }
    hex_encode(&hasher.finalize())
}

/// Reject shell chaining, redirection, subshell substitution, and comments for plain
/// prefix policies so `git push && curl evil.com` or `rm -rf / # git push` never match.
fn has_shell_metacharacters(command: &str) -> bool {
    let bytes = command.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b';' | b'&' | b'|' | b'`' | b'\n' | b'\r' | b'>' | b'<' | b'#' => return true,
            b'$' if bytes.get(i + 1) == Some(&b'(') => return true,
            _ => {}
        }
    }
    false
}

/// Trait for out-of-band approval sources.
pub trait Approver: Send + Sync {
    /// Check if this approver grants approval for the given command.
    fn approve(&self, command: &str, cwd: Option<&Path>, env: &HashMap<String, String>) -> bool;
}

/// Approver that checks an operator-configured allowlist of command patterns.
///
/// Pattern formats:
/// - Plain prefix (e.g. `git push`): matches exact command or `<pat> <args>` ONLY when
///   the command contains no shell chaining/redirection/comment metacharacters.
/// - `exact:<cmd>`: matches exact trimmed command string.
/// - `regex:<expr>`: full-string regex match (`^(?:expr)$`).
pub struct OperatorPolicyApprover {
    patterns: Vec<String>,
}

impl OperatorPolicyApprover {
    pub fn new(patterns: Vec<String>) -> Self {
        Self { patterns }
    }

    pub fn from_env() -> Option<Self> {
        std::env::var("HANZO_EXEC_APPROVE_PATTERNS").ok().map(|s| {
            Self::new(
                s.split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect(),
            )
        })
    }
}

impl Approver for OperatorPolicyApprover {
    fn approve(&self, command: &str, _cwd: Option<&Path>, _env: &HashMap<String, String>) -> bool {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return false;
        }
        self.patterns.iter().any(|pat| {
            if let Some(expr) = pat.strip_prefix("regex:") {
                let anchored = format!("^(?:{expr})$");
                regex::Regex::new(&anchored).map(|re| re.is_match(trimmed)).unwrap_or(false)
            } else if let Some(exact) = pat.strip_prefix("exact:") {
                trimmed == exact.trim()
            } else {
                if has_shell_metacharacters(trimmed) {
                    return false;
                }
                let pat = pat.trim();
                if pat.is_empty() {
                    return false;
                }
                if trimmed == pat {
                    return true;
                }
                trimmed
                    .strip_prefix(pat)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
            }
        })
    }
}

/// Out-of-band approval token manager with single-use semantics, SHA-256 command+cwd+env
/// binding, CSPRNG tokens, constant-time lookup, and automatic TTL eviction.
pub struct TokenApprover {
    pending: Arc<Mutex<HashMap<String, ApprovalRequest>>>,
    tokens: Arc<Mutex<HashMap<String, ApprovalToken>>>,
}

impl TokenApprover {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Record a non-secret pending approval request when an `Ask` command is refused.
    /// The caller returns ONLY `request.request_id` to the model.
    pub fn register_pending(
        &self,
        command: &str,
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
        ttl_secs: u64,
    ) -> ApprovalRequest {
        let now = now_secs();
        let req = ApprovalRequest {
            request_id: format!("req_{}", random_hex::<16>()),
            command_hash: hash_command(command),
            cwd: cwd.map(|p| p.display().to_string()),
            env_hash: hash_env(env),
            created_at: now,
            expires_at: now.saturating_add(ttl_secs),
        };
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, v| v.expires_at > now);
        if pending.len() >= MAX_STORED_APPROVALS {
            if let Some(oldest) =
                pending.iter().min_by_key(|(_, v)| v.created_at).map(|(k, _)| k.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(req.request_id.clone(), req.clone());
        req
    }

    /// Out-of-band host/operator approves a pending `request_id` and receives a single-use
    /// CSPRNG [`ApprovalToken`] bound to the exact pending `(command, cwd, env)`.
    pub fn approve_request(&self, request_id: &str, ttl_secs: u64) -> Option<ApprovalToken> {
        let now = now_secs();
        let req = {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, v| v.expires_at > now);
            pending.remove(request_id)?
        };
        if now >= req.expires_at {
            return None;
        }
        let token = ApprovalToken::from_hashes(req.command_hash, req.cwd, req.env_hash, ttl_secs);
        self.store_token(token.clone());
        Some(token)
    }

    /// Directly mint a single-use out-of-band approval token for an exact `(command, cwd, env)`.
    pub fn issue_token(
        &self,
        command: &str,
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
        ttl_secs: u64,
    ) -> ApprovalToken {
        let token = ApprovalToken::new(command, cwd, env, ttl_secs);
        self.store_token(token.clone());
        token
    }

    fn store_token(&self, token: ApprovalToken) {
        let now = now_secs();
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, v| v.expires_at > now);
        if tokens.len() >= MAX_STORED_APPROVALS {
            if let Some(oldest) =
                tokens.iter().min_by_key(|(_, v)| v.issued_at).map(|(k, _)| k.clone())
            {
                tokens.remove(&oldest);
            }
        }
        tokens.insert(token.token.clone(), token);
    }

    /// Consume and validate a single-use approval token using constant-time comparison.
    pub fn consume_token(
        &self,
        token_str: &str,
        command: &str,
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
    ) -> bool {
        let now = now_secs();
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, v| v.expires_at > now);
        let matched_key = tokens
            .keys()
            .find(|k| constant_time_eq(k.as_bytes(), token_str.as_bytes()))
            .cloned();
        match matched_key.and_then(|k| tokens.remove(&k)) {
            Some(token) => token.verify(command, cwd, env),
            None => false,
        }
    }
}

impl Default for TokenApprover {
    fn default() -> Self {
        Self::new()
    }
}

impl Approver for TokenApprover {
    fn approve(&self, _command: &str, _cwd: Option<&Path>, _env: &HashMap<String, String>) -> bool {
        // TokenApprover requires explicit consume_token call for single-use semantics.
        false
    }
}

/// Composite approver that checks multiple out-of-band sources in order.
pub struct CompositeApprover {
    approvers: Vec<Box<dyn Approver>>,
}

impl CompositeApprover {
    pub fn new() -> Self {
        Self { approvers: Vec::new() }
    }

    pub fn add_approver(mut self, approver: Box<dyn Approver>) -> Self {
        self.approvers.push(approver);
        self
    }

    pub fn with_operator_policy(mut self) -> Self {
        if let Some(policy) = OperatorPolicyApprover::from_env() {
            self.approvers.push(Box::new(policy));
        }
        self
    }
}

impl Default for CompositeApprover {
    fn default() -> Self {
        Self::new()
    }
}

impl Approver for CompositeApprover {
    fn approve(&self, command: &str, cwd: Option<&Path>, env: &HashMap<String, String>) -> bool {
        self.approvers.iter().any(|a| a.approve(command, cwd, env))
    }
}

/// What `exec` does with a verdict. One place decides it, so changing the policy changes it
/// for every caller.
///
/// `Deny` is always refused. `Ask` is refused unless out-of-band approval (single-use
/// `approval_token` or `OperatorPolicy`) is satisfied; the model-supplied `approve: true`
/// flag alone never lifts `Ask` or `Deny`.
pub fn refusal(verdict: &Verdict, model_approved: bool) -> Option<String> {
    let why = || verdict.reasons.join("; ");
    match verdict.risk {
        Risk::Allow => None,
        Risk::Deny if verdict.reasons.is_empty() => {
            Some("refused: the command is classified deny".to_string())
        }
        Risk::Deny => Some(format!("refused: {}", why())),
        Risk::Ask if model_approved => Some(format!(
            "approval required: {}. Model self-approval is not sufficient; out-of-band approval (approval_token or operator policy) is required",
            if verdict.reasons.is_empty() {
                "the command is classified ask".to_string()
            } else {
                why()
            }
        )),
        Risk::Ask => Some(format!(
            "approval required: {}. Out-of-band approval (approval_token or operator policy) is required",
            if verdict.reasons.is_empty() {
                "the command is classified ask".to_string()
            } else {
                why()
            }
        )),
    }
}

/// Check if an `Ask` verdict is approved via out-of-band sources.
/// Never approves `Deny` verdicts and never treats `model_approved` alone as approval.
#[allow(clippy::too_many_arguments)]
pub fn is_ask_approved(
    verdict: &Verdict,
    model_approved: bool,
    token: Option<&str>,
    token_approver: Option<&TokenApprover>,
    composite_approver: Option<&CompositeApprover>,
    command: &str,
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
) -> (bool, Option<ApprovalSource>) {
    if verdict.risk != Risk::Ask {
        return (false, None);
    }

    // 1. Out-of-band single-use approval token bound to exact command + cwd + env.
    if let (Some(token_str), Some(approver)) = (token, token_approver) {
        if approver.consume_token(token_str, command, cwd, env) {
            return (true, Some(ApprovalSource::Token));
        }
    }

    // 2. Out-of-band operator policy (env / config allowlist).
    if let Some(approver) = composite_approver {
        if approver.approve(command, cwd, env) {
            return (true, Some(ApprovalSource::OperatorPolicy));
        }
    }

    if model_approved {
        return (false, Some(ApprovalSource::ModelFlag));
    }

    (false, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_orders_allow_below_ask_below_deny() {
        assert!(Risk::Allow < Risk::Ask && Risk::Ask < Risk::Deny);
        assert_eq!([Risk::Ask, Risk::Deny, Risk::Allow].into_iter().max(), Some(Risk::Deny));
    }

    #[test]
    fn a_deny_is_refused_and_model_self_approval_never_satisfies_ask() {
        assert_eq!(refusal(&Verdict::allow(), false), None);
        let ask_self = refusal(&Verdict::new(Risk::Ask, ["pushes to a remote"]), true).unwrap();
        assert!(ask_self.contains("Model self-approval is not sufficient"), "{ask_self}");
        let ask = refusal(&Verdict::new(Risk::Ask, ["pushes to a remote"]), false).unwrap();
        assert!(
            ask.starts_with("approval required: pushes to a remote")
                && ask.contains("Out-of-band approval"),
            "{ask}"
        );
        for approved in [false, true] {
            assert_eq!(
                refusal(&Verdict::new(Risk::Deny, ["rm -rf /", "targets the root"]), approved)
                    .as_deref(),
                Some("refused: rm -rf /; targets the root")
            );
            assert_eq!(
                refusal(&Verdict::new(Risk::Deny, Vec::<String>::new()), approved).as_deref(),
                Some("refused: the command is classified deny")
            );
        }
    }

    #[test]
    fn a_verdict_serializes_as_it_is_reported() {
        assert_eq!(
            Verdict::new(Risk::Ask, ["x"]).json(),
            json!({"risk": "ask", "reasons": ["x"]})
        );
    }

    #[test]
    fn merging_keeps_the_stricter_and_every_reason() {
        let m = Verdict::new(Risk::Ask, ["a"]).merge(Verdict::new(Risk::Deny, ["b"]));
        assert_eq!((m.risk, m.reasons), (Risk::Deny, vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn approval_token_is_random_single_use_and_bound_to_exact_command_cwd_env() {
        let approver = TokenApprover::new();
        let command = "git push origin main";
        let cwd = Some(Path::new("/workspace"));
        let env = HashMap::new();

        let t1 = approver.issue_token(command, cwd, &env, 60);
        let t2 = approver.issue_token(command, cwd, &env, 60);
        assert_ne!(t1.token, t2.token, "tokens must be cryptographically random, never deterministic");
        assert!(t1.token.starts_with("appr_") && t1.token.len() == 5 + 64);

        // Exact match succeeds once, then replay fails.
        assert!(approver.consume_token(&t1.token, command, cwd, &env));
        assert!(!approver.consume_token(&t1.token, command, cwd, &env));

        // Different command fails and consumes the token.
        assert!(!approver.consume_token(&t2.token, "git push origin develop", cwd, &env));
        assert!(!approver.consume_token(&t2.token, command, cwd, &env));

        // Different cwd fails.
        let t3 = approver.issue_token(command, Some(Path::new("/other")), &env, 60);
        assert!(!approver.consume_token(&t3.token, command, cwd, &env));

        // Different env fails (and length-prefixing avoids concatenation collisions).
        let mut env_a = HashMap::new();
        env_a.insert("AB".to_string(), "C".to_string());
        let mut env_b = HashMap::new();
        env_b.insert("A".to_string(), "BC".to_string());
        let t4 = approver.issue_token(command, cwd, &env_a, 60);
        assert!(!approver.consume_token(&t4.token, command, cwd, &env_b));
    }

    #[test]
    fn pending_request_flow_keeps_token_out_of_band() {
        let approver = TokenApprover::new();
        let cmd = "git push origin main";
        let cwd = Some(Path::new("/workspace"));
        let env = HashMap::new();

        let req = approver.register_pending(cmd, cwd, &env, 60);
        assert!(req.request_id.starts_with("req_"));
        // Request ID itself is NEVER a valid approval token.
        assert!(!approver.consume_token(&req.request_id, cmd, cwd, &env));

        // Host approves out-of-band -> receives single-use token; approving twice returns None.
        let token = approver.approve_request(&req.request_id, 60).expect("valid request");
        assert!(approver.approve_request(&req.request_id, 60).is_none());
        assert!(approver.consume_token(&token.token, cmd, cwd, &env));
        assert!(!approver.consume_token(&token.token, cmd, cwd, &env));
    }

    #[test]
    fn operator_policy_rejects_substring_and_shell_chaining_bypasses() {
        let approver = OperatorPolicyApprover::new(vec![
            "git push".to_string(),
            "npm publish".to_string(),
            "exact:cargo publish --dry-run".to_string(),
            "regex:curl -s https://api\\.hanzo\\.ai/[a-z0-9/_-]+".to_string(),
        ]);
        let env = HashMap::new();

        // Legitimate prefix / exact / anchored regex matches.
        assert!(approver.approve("git push", None, &env));
        assert!(approver.approve("git push origin main", None, &env));
        assert!(approver.approve("npm publish --access public", None, &env));
        assert!(approver.approve("cargo publish --dry-run", None, &env));
        assert!(approver.approve("curl -s https://api.hanzo.ai/v1/health", None, &env));

        // Bypasses MUST be rejected!
        assert!(!approver.approve("git pull", None, &env));
        assert!(!approver.approve("git pusher", None, &env));
        assert!(!approver.approve("rm -rf / # git push", None, &env));
        assert!(!approver.approve("git push && curl evil.com", None, &env));
        assert!(!approver.approve("git push; rm -rf /", None, &env));
        assert!(!approver.approve("git push $(whoami)", None, &env));
        assert!(!approver.approve("git push | tee /tmp/x", None, &env));
        assert!(!approver.approve("git push > /tmp/x", None, &env));
        assert!(!approver.approve("cargo publish --dry-run --allow-dirty", None, &env));
        assert!(!approver.approve("curl -s https://api.hanzo.ai/v1/health; id", None, &env));
    }

    #[test]
    fn approval_token_expires_and_deny_is_never_approved() {
        let approver = TokenApprover::new();
        let command = "git push";
        let env = HashMap::new();

        let expired = approver.issue_token(command, None, &env, 0);
        assert!(!approver.consume_token(&expired.token, command, None, &env));

        let valid = approver.issue_token("rm -rf /", None, &env, 60);
        let policy = CompositeApprover::new()
            .add_approver(Box::new(OperatorPolicyApprover::new(vec!["rm".to_string()])));
        let (approved, source) = is_ask_approved(
            &Verdict::new(Risk::Deny, ["destructive"]),
            true,
            Some(&valid.token),
            Some(&approver),
            Some(&policy),
            "rm -rf /",
            None,
            &env,
        );
        assert!(!approved && source.is_none(), "Deny must never be approved");
    }
}
