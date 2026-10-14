//! What the classifier answers: a risk and the clauses that decided it.

use serde::Serialize;

/// How far a command may go. Ordered: a verdict is the strictest of its parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    /// Reads, or changes only what the caller's task is about.
    Allow,
    /// Reaches past that, or cannot be read: a person decides.
    Ask,
    /// Never runs from here.
    Deny,
}

/// What kind of reach a finding is. `category` is the word the gateway's screen uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Destructive,
    Privilege,
    Credential,
    Publishing,
    Exfil,
    Network,
    Write,
    Code,
    Unparsed,
    Unknown,
    Traversal,
}

impl Kind {
    /// The gateway screen's category (`SafetyCheckResult.category`) for this kind.
    pub fn category(self) -> &'static str {
        match self {
            Kind::Destructive => "destructive",
            Kind::Privilege => "privilege",
            Kind::Credential | Kind::Exfil => "credential",
            Kind::Publishing => "publishing",
            Kind::Traversal => "path_traversal",
            Kind::Unparsed | Kind::Code | Kind::Unknown => "unparsed",
            Kind::Network => "network",
            Kind::Write => "write",
        }
    }
}

/// One part of a command that was not plainly allowed, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub risk: Risk,
    pub kind: Kind,
    /// One clause naming the part of the command that decided it. Never holds a value the
    /// command carried (an assignment, a token, a header): only names, flags and paths.
    pub reason: String,
}

/// The classifier's whole answer for one command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub risk: Risk,
    pub findings: Vec<Finding>,
}

/// The most findings a report keeps; the strictest come first.
const KEEP: usize = 12;
/// The longest a reason is, in characters.
const CLAUSE: usize = 140;

impl Report {
    pub fn allow() -> Report {
        Report { risk: Risk::Allow, findings: Vec::new() }
    }

    /// The reasons as `kind: clause`, strictest first.
    pub fn reasons(&self) -> Vec<String> {
        self.findings.iter().map(|f| format!("{}: {}", f.kind.category(), f.reason)).collect()
    }

    /// Folds loose findings into a report: the maximum risk, the strictest findings first,
    /// duplicates once, at most [`KEEP`].
    pub(crate) fn of(mut found: Vec<Finding>) -> Report {
        let risk = found.iter().map(|f| f.risk).max().unwrap_or(Risk::Allow);
        found.retain(|f| f.risk > Risk::Allow);
        found.sort_by(|a, b| b.risk.cmp(&a.risk));
        let mut seen = std::collections::HashSet::new();
        found.retain(|f| seen.insert((f.risk, f.reason.clone())));
        found.truncate(KEEP);
        Report { risk, findings: found }
    }
}

pub(crate) fn clause(text: impl Into<String>) -> String {
    let text: String = text.into();
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.chars().count() <= CLAUSE {
        return flat;
    }
    let mut cut: String = flat.chars().take(CLAUSE - 1).collect();
    cut.push('…');
    cut
}
