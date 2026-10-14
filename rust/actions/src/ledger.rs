//! The record every action run leaves, for Dev's loop and for replay.

use crate::exec::Step;
use serde::Serialize;
use serde_json::Value;

/// Who chose the action and bound its inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Exactly one action matched and every input was named or had one value: no model was asked.
    Rule,
    /// Kai chose among several actions or values.
    Kai,
}

/// A precondition, as it read just before the action ran.
pub use crate::action::Check;

#[derive(Debug, Clone, Serialize)]
pub struct Authorization {
    pub required: bool,
    pub reason: Option<String>,
    pub granted: bool,
    /// `policy` when none was needed, `approver` when one was asked.
    pub by: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cache {
    /// The action had a recorded success in this environment.
    pub proved: bool,
    /// `hit` when the result was reused, `miss` when it was computed, `off` when the action is not pure or no cache is open.
    pub memo: String,
    pub fingerprint: String,
}

/// One Kai request that bore on this action.
#[derive(Debug, Clone, Serialize)]
pub struct Ask {
    pub question: String,
    pub options: usize,
    /// The likeliest real option.
    pub pick: String,
    /// Its probability among the real options, and its lead over the next.
    pub p: f64,
    pub margin: f64,
    /// What Kai gave to abstaining.
    pub abstain: f64,
    pub accepted: bool,
    pub ms: f64,
    /// The three likeliest real options with their renormalized probabilities.
    pub top: Vec<(String, f64)>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Timing {
    pub bind_ms: f64,
    pub kai_ms: f64,
    pub check_ms: f64,
    pub run_ms: f64,
    pub verify_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "why", rename_all = "lowercase")]
pub enum Outcome {
    /// The effect happened and the verifier says so.
    Done,
    /// It ran and the verifier (or the command) says it did not work.
    Failed(String),
    /// It did not run: no action fits, an input is unbound, a precondition fails, approval is refused.
    Declined(String),
    /// A workflow step whose guard did not hold.
    Skipped(String),
}

/// One run of one action. `id` is derived from what ran and what it depended on, so a replay of the
/// same action on the same inputs and workspace has the same id.
#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub id: String,
    pub action: String,
    pub version: u32,
    pub source: Origin,
    /// The workspace revision the action was bound against, and the one just before it ran.
    pub revision: String,
    pub revision_at_run: String,
    pub args: Value,
    pub preconditions: Vec<Check>,
    pub authorization: Authorization,
    pub cache: Cache,
    pub asks: Vec<Ask>,
    pub steps: Vec<Step>,
    pub timing: Timing,
    pub verdict: Option<crate::action::Verdict>,
    pub outcome: Outcome,
    /// What the action reported, credentials redacted and cut.
    pub output: String,
}
