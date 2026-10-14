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
}

/// What `exec` does with a verdict. One place decides it, so changing the policy changes it
/// for every caller.
///
/// An MCP server has no way to ask the person: the client's own permission prompt already
/// stood between the model and this call. So `Ask` runs and is reported in the answer, for the
/// client and the model to see; `Deny` is the only verdict the server enforces.
pub fn refusal(verdict: &Verdict) -> Option<String> {
    (verdict.risk == Risk::Deny).then(|| {
        if verdict.reasons.is_empty() {
            "refused: the command is classified deny".to_string()
        } else {
            format!("refused: {}", verdict.reasons.join("; "))
        }
    })
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
    fn only_deny_refuses_and_it_says_why() {
        assert_eq!(refusal(&Verdict::allow()), None);
        assert_eq!(refusal(&Verdict::new(Risk::Ask, ["pushes to a remote"])), None);
        assert_eq!(
            refusal(&Verdict::new(Risk::Deny, ["rm -rf /", "targets the root"])).as_deref(),
            Some("refused: rm -rf /; targets the root")
        );
        assert_eq!(refusal(&Verdict::new(Risk::Deny, Vec::<String>::new())).as_deref(), Some("refused: the command is classified deny"));
    }

    #[test]
    fn a_verdict_serializes_as_it_is_reported() {
        assert_eq!(Verdict::new(Risk::Ask, ["x"]).json(), json!({"risk": "ask", "reasons": ["x"]}));
    }
}
