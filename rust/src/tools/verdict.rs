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

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

/// Where an approval comes from. The model's own `approve: true` flag is NOT a valid
/// source for `Ask` commands; only out-of-band human or operator approval counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalSource {
    /// A one-time token issued by the server on an Ask refusal, confirmed by a human
    /// through an operator-configured channel (e.g., MCP elicitation, CLI, web UI).
    Token,
    /// A pre-approved command pattern set by the operator in config/env before launch.
    OperatorPolicy,
    /// An explicit MCP elicitation response from the client (human clicked approve).
    McpElicitation,
}

/// Trait for checking whether an approval is valid for a given command.
/// Implementations consult out-of-band state (tokens, policies, elicitation results).
pub trait Approver: Send + Sync {
    /// Returns true if `command` (with its cwd and env hash) has a valid approval.
    /// The `approval_id` is the token returned on a previous Ask refusal.
    fn is_approved(&self, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, approval_id: Option<&str>) -> bool;
}

/// A no-op approver that never approves anything. Used when no out-of-band approval
/// mechanism is configured.
pub struct NoApprover;

impl Approver for NoApprover {
    fn is_approved(&self, _command: &str, _cwd: Option<&Path>, _env_hash: Option<&str>, _approval_id: Option<&str>) -> bool {
        false
    }
}

/// An approver that checks a pre-configured allowlist of command patterns.
/// Patterns are exact command strings (with cwd and env hash) set by the operator.
pub struct OperatorPolicyApprover {
    allowed: std::sync::Arc<std::collections::HashSet<String>>,
}

impl OperatorPolicyApprover {
    pub fn new(patterns: Vec<String>) -> Self {
        let mut set = std::collections::HashSet::new();
        for p in patterns {
            set.insert(p);
        }
        Self { allowed: std::sync::Arc::new(set) }
    }

    /// Build the key used for matching: command + "|" + cwd + "|" + env_hash
    fn key(command: &str, cwd: Option<&Path>, env_hash: Option<&str>) -> String {
        let cwd_str = cwd.map(|p| p.display().to_string()).unwrap_or_default();
        let env_str = env_hash.unwrap_or_default();
        format!("{}|{}|{}", command, cwd_str, env_str)
    }
}

impl Approver for OperatorPolicyApprover {
    fn is_approved(&self, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, _approval_id: Option<&str>) -> bool {
        let key = Self::key(command, cwd, env_hash);
        self.allowed.contains(&key)
    }
}

/// An approver that validates one-time approval tokens.
/// Tokens are issued by the server on Ask refusal and must be confirmed out-of-band.
pub struct TokenApprover {
    /// Map from token -> (command_key, expiry_timestamp)
    tokens: std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, (String, u64)>>>,
}

impl TokenApprover {
    pub fn new() -> Self {
        Self {
            tokens: std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
        }
    }

    /// Issue a new approval token for the given command. Returns the token string.
    /// The token is bound to the exact command, cwd, and env_hash, and expires after `ttl_secs`.
    pub async fn issue(&self, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, ttl_secs: u64) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let key = OperatorPolicyApprover::key(command, cwd, env_hash);
        let expiry = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + ttl_secs;
        self.tokens.write().await.insert(token.clone(), (key, expiry));
        token
    }

    /// Consume and validate a token. Returns true if valid and not expired.
    /// The token is single-use: it is removed on successful validation.
    pub async fn consume(&self, token: &str, command: &str, cwd: Option<&Path>, env_hash: Option<&str>) -> bool {
        let key = OperatorPolicyApprover::key(command, cwd, env_hash);
        let mut tokens = self.tokens.write().await;
        if let Some((stored_key, expiry)) = tokens.remove(token) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            if now <= expiry && stored_key == key {
                return true;
            }
        }
        false
    }
}

impl Default for TokenApprover {
    fn default() -> Self {
        Self::new()
    }
}

impl Approver for TokenApprover {
    fn is_approved(&self, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, approval_id: Option<&str>) -> bool {
        // For synchronous check, we can't consume. This is a peek-only check.
        // The actual consume happens in the exec path.
        let Some(token) = approval_id else { return false; };
        let key = OperatorPolicyApprover::key(command, cwd, env_hash);
        let tokens = self.tokens.blocking_read();
        if let Some((stored_key, expiry)) = tokens.get(token) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            return now <= *expiry && stored_key == key;
        }
        false
    }
}

/// Composite approver that checks multiple sources in order.
pub struct CompositeApprover {
    approvers: Vec<Box<dyn Approver>>,
}

impl CompositeApprover {
    pub fn new() -> Self {
        Self { approvers: Vec::new() }
    }

    pub fn add(mut self, approver: Box<dyn Approver>) -> Self {
        self.approvers.push(approver);
        self
    }
}

impl Default for CompositeApprover {
    fn default() -> Self {
        Self::new()
    }
}

impl Approver for CompositeApprover {
    fn is_approved(&self, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, approval_id: Option<&str>) -> bool {
        for approver in &self.approvers {
            if approver.is_approved(command, cwd, env_hash, approval_id) {
                return true;
            }
        }
        false
    }
}

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

/// What `exec` does with a verdict. One place decides it, so changing the policy changes it
/// for every caller.
///
/// An MCP server cannot ask the person; the client can. So `Deny` is always refused, and an
/// `Ask` is refused until the call carries a valid out-of-band approval (token, operator policy,
/// or MCP elicitation). The model-supplied `approve: true` flag alone never passes an Ask.
pub fn refusal(verdict: &Verdict, approver: Option<&dyn Approver>, command: &str, cwd: Option<&Path>, env_hash: Option<&str>, approval_id: Option<&str>) -> Option<String> {
    let why = || verdict.reasons.join("; ");
    match verdict.risk {
        Risk::Allow => None,
        Risk::Deny if verdict.reasons.is_empty() => Some("refused: the command is classified deny".to_string()),
        Risk::Deny => Some(format!("refused: {}", why())),
        Risk::Ask => {
            let approved = approver.map_or(false, |a| a.is_approved(command, cwd, env_hash, approval_id));
            if approved {
                None
            } else {
                Some(format!(
                    "approval required: {}. Run the call again with a valid approval_id from an out-of-band confirmation (operator policy, MCP elicitation, or approval token). The approve flag alone does not satisfy Ask.",
                    if verdict.reasons.is_empty() { "the command is classified ask".to_string() } else { why() }
                ))
            }
        }
    }
}

/// Legacy refusal function for backward compatibility.
/// Treats `approved` as deprecated and only allows it for Allow/Deny (never Ask).
pub fn refusal_legacy(verdict: &Verdict, approved: bool) -> Option<String> {
    let why = || verdict.reasons.join("; ");
    match verdict.risk {
        Risk::Allow => None,
        Risk::Deny if verdict.reasons.is_empty() => Some("refused: the command is classified deny".to_string()),
        Risk::Deny => Some(format!("refused: {}", why())),
        Risk::Ask if approved => Some("refused: model-supplied approve: true is not a valid approval for Ask commands. Use an out-of-band approval (token, operator policy, or MCP elicitation).".to_string()),
        Risk::Ask => Some(format!(
            "approval required: {}. This server cannot ask the person; if they approve, run the call again with a valid approval_id from an out-of-band confirmation.",
            if verdict.reasons.is_empty() { "the command is classified ask".to_string() } else { why() }
        )),
    }
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
    fn a_deny_is_always_refused_and_ask_requires_out_of_band_approval() {
        let no_approver = NoApprover;
        
        // Allow is never refused
        assert_eq!(refusal(&Verdict::allow(), Some(&no_approver), "echo hi", None, None, None), None);
        
        // Deny is always refused regardless of approval
        for approved in [false, true] {
            assert_eq!(refusal(&Verdict::new(Risk::Deny, ["rm -rf /", "targets the root"]), Some(&no_approver), "rm -rf /", None, None, None).as_deref(), Some("refused: rm -rf /; targets the root"));
            assert_eq!(refusal(&Verdict::new(Risk::Deny, Vec::<String>::new()), Some(&no_approver), "deny-cmd", None, None, None).as_deref(), Some("refused: the command is classified deny"));
        }
        
        // Ask is refused without valid approval
        let ask_verdict = Verdict::new(Risk::Ask, ["pushes to a remote"]);
        let ask_refusal = refusal(&ask_verdict, Some(&no_approver), "git push", None, None, None).unwrap();
        assert!(ask_refusal.starts_with("approval required: pushes to a remote"));
        assert!(ask_refusal.contains("approval_id"));
        assert!(ask_refusal.contains("approve flag alone does not satisfy Ask"));
        
        // Ask is still refused even with approve=true (legacy behavior)
        let legacy_refusal = refusal_legacy(&ask_verdict, true);
        assert!(legacy_refusal.unwrap().contains("model-supplied approve: true is not a valid approval"));
    }

    #[test]
    fn operator_policy_approver_allows_preapproved_commands() {
        let approver = OperatorPolicyApprover::new(vec!["echo hello|/tmp|".to_string()]);
        assert!(approver.is_approved("echo hello", Some(std::path::Path::new("/tmp")), Some(""), None));
        assert!(!approver.is_approved("echo hello", Some(std::path::Path::new("/tmp")), Some("different"), None));
        assert!(!approver.is_approved("echo goodbye", Some(std::path::Path::new("/tmp")), Some(""), None));
        assert!(!approver.is_approved("echo hello", Some(std::path::Path::new("/other")), Some(""), None));
    }

    #[test]
    fn token_approver_issues_and_consumes_tokens() {
        let approver = TokenApprover::new();
        let command = "git push origin main";
        let cwd = Some(std::path::Path::new("/repo"));
        let env_hash = Some("abc123");
        
        // Issue a token
        let token = futures::executor::block_on(approver.issue(command, cwd, env_hash, 60));
        assert!(!token.is_empty());
        
        // Token should be valid for the exact command
        assert!(futures::executor::block_on(approver.consume(&token, command, cwd, env_hash)));
        
        // Token is single-use: second consume fails
        assert!(!futures::executor::block_on(approver.consume(&token, command, cwd, env_hash)));
        
        // Wrong command fails
        let token2 = futures::executor::block_on(approver.issue("git push", cwd, env_hash, 60));
        assert!(!futures::executor::block_on(approver.consume(&token2, "git push origin main", cwd, env_hash)));
        
        // Wrong cwd fails
        let token3 = futures::executor::block_on(approver.issue(command, Some(std::path::Path::new("/other")), env_hash, 60));
        assert!(!futures::executor::block_on(approver.consume(&token3, command, cwd, env_hash)));
        
        // Wrong env_hash fails
        let token4 = futures::executor::block_on(approver.issue(command, cwd, Some("different"), 60));
        assert!(!futures::executor::block_on(approver.consume(&token4, command, cwd, env_hash)));
    }

    #[test]
    fn token_approver_expiry() {
        let approver = TokenApprover::new();
        let command = "git push";
        let cwd = None;
        let env_hash = None;
        
        // Issue a token with 0 TTL (already expired)
        let token = futures::executor::block_on(approver.issue(command, cwd, env_hash, 0));
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(!futures::executor::block_on(approver.consume(&token, command, cwd, env_hash)));
    }

    #[test]
    fn composite_approver_checks_all_sources() {
        let token_approver = TokenApprover::new();
        let policy_approver = OperatorPolicyApprover::new(vec!["allowed-cmd||".to_string()]);
        let composite = CompositeApprover::new()
            .add(Box::new(NoApprover))
            .add(Box::new(policy_approver))
            .add(Box::new(token_approver));
        
        // Policy allows this
        assert!(composite.is_approved("allowed-cmd", None, None, None));
        
        // Policy doesn't allow this, no token -> denied
        assert!(!composite.is_approved("other-cmd", None, None, None));
    }

    #[test]
    fn a_verdict_serializes_as_it_is_reported() {
        assert_eq!(Verdict::new(Risk::Ask, ["x"]).json(), json!({"risk": "ask", "reasons": ["x"]}));
    }

    #[test]
    fn merging_keeps_the_stricter_and_every_reason() {
        let m = Verdict::new(Risk::Ask, ["a"]).merge(Verdict::new(Risk::Deny, ["b"]));
        assert_eq!((m.risk, m.reasons), (Risk::Deny, vec!["a".to_string(), "b".to_string()]));
    }
}
