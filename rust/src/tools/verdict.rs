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
/// `Ask` is refused until the call carries `approve: true`, which the client's own permission
/// prompt shows beside the command when it asks the person. That flag is a request the model
/// makes, not a credential: it moves the decision to the client's prompt and nowhere else, and
/// it never lifts a `Deny`.
pub fn refusal(verdict: &Verdict, approved: bool) -> Option<String> {
    let why = || verdict.reasons.join("; ");
    match verdict.risk {
        Risk::Allow => None,
        Risk::Deny if verdict.reasons.is_empty() => Some("refused: the command is classified deny".to_string()),
        Risk::Deny => Some(format!("refused: {}", why())),
        Risk::Ask if approved => None,
        Risk::Ask => Some(format!(
            "approval required: {}. This server cannot ask the person; if they approve, run the call again with approve: true",
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
    fn a_deny_is_refused_whatever_is_approved_and_an_ask_until_it_is() {
        assert_eq!(refusal(&Verdict::allow(), false), None);
        assert_eq!(refusal(&Verdict::new(Risk::Ask, ["pushes to a remote"]), true), None);
        let ask = refusal(&Verdict::new(Risk::Ask, ["pushes to a remote"]), false).unwrap();
        assert!(ask.starts_with("approval required: pushes to a remote") && ask.contains("approve: true"), "{ask}");
        for approved in [false, true] {
            assert_eq!(refusal(&Verdict::new(Risk::Deny, ["rm -rf /", "targets the root"]), approved).as_deref(), Some("refused: rm -rf /; targets the root"));
            assert_eq!(refusal(&Verdict::new(Risk::Deny, Vec::<String>::new()), approved).as_deref(), Some("refused: the command is classified deny"));
        }
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
