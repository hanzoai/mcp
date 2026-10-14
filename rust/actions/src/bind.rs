//! From a request to a plan: which action (or workflow), with which inputs.
//!
//! An action is a candidate when one of its trigger patterns matches the request. Its inputs are
//! bound from the request and from values read out of the repository: a literal is captured by
//! its pattern; a choice takes the one value the request names, or the only value there is; only
//! when several values (or several actions) remain does Kai choose, and Kai may abstain. A pick
//! of Kai's must be grounded in the request, or it is refused. Anything unbound, ambiguous or
//! ungrounded is declined, and the request goes to the normal agent.

use crate::action::{Action, Args, Check, Input, Kind, Source};
use crate::ask::{Answer, Chooser, Question};
use crate::catalog;
use crate::ledger::{Ask, Origin};
use crate::state::{Cand, State};
use crate::text::{grounded, mention, overlap};
use crate::workflow::{self, Guard, Workflow};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt;

/// How sure Kai must be, and how much of the repository it is shown.
#[derive(Debug, Clone)]
pub struct Config {
    /// The most probability Kai may give to abstaining.
    pub max_abstain: f64,
    /// The least probability of the option Kai picks, among the real options.
    pub min_p: f64,
    /// The least lead of the pick over the next real option.
    pub min_margin: f64,
    /// The most options put to Kai in one question.
    pub options: usize,
    /// Run an action only when a proof of it is recorded.
    pub require_proof: bool,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            max_abstain: 0.6,
            min_p: 0.0,
            min_margin: 0.1,
            options: 24,
            require_proof: true,
        }
    }
}

/// Why a request was not run as an action.
#[derive(Debug, Clone, PartialEq)]
pub enum Decline {
    /// No action's trigger fits the request, or none that can be bound.
    NoAction(String),
    /// Several fit and Kai did not pick one with enough lead (or abstained).
    Ambiguous(String),
    /// An input has no value.
    Missing(String),
    /// Kai picked a value the request does not ground.
    Ungrounded(String),
    /// A precondition does not hold.
    Precondition(String),
    /// The action has no proof in this environment.
    Unproven(String),
    /// The workspace changed between binding and running.
    Stale(String),
    /// The user did not approve a consequential action.
    Denied(String),
    /// Kai could not be asked, and the request needed it.
    Kai(String),
}

impl fmt::Display for Decline {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, why) = match self {
            Decline::NoAction(w) => ("no action", w),
            Decline::Ambiguous(w) => ("ambiguous", w),
            Decline::Missing(w) => ("missing input", w),
            Decline::Ungrounded(w) => ("ungrounded", w),
            Decline::Precondition(w) => ("precondition", w),
            Decline::Unproven(w) => ("unproven", w),
            Decline::Stale(w) => ("stale", w),
            Decline::Denied(w) => ("not approved", w),
            Decline::Kai(w) => ("kai", w),
        };
        write!(f, "{kind}: {why}")
    }
}

/// What a request may run.
#[derive(Clone, Copy)]
pub enum Target {
    Action(&'static dyn Action),
    Workflow(&'static Workflow),
}

impl Target {
    pub fn id(&self) -> &'static str {
        match self {
            Target::Action(a) => a.spec().id,
            Target::Workflow(w) => w.id,
        }
    }

    pub fn summary(&self) -> &'static str {
        match self {
            Target::Action(a) => a.spec().summary,
            Target::Workflow(w) => w.summary,
        }
    }

    fn triggers(&self) -> &'static [&'static str] {
        match self {
            Target::Action(a) => a.spec().triggers,
            Target::Workflow(w) => w.triggers,
        }
    }
}

/// Whether the request asks for something to be written (a review, a fix, a test, a section): no action does that,
/// whatever words it shares with one. Quoted text is a value, not the request's own verb.
pub fn authoring(request: &str) -> bool {
    let mut bare = request.to_string();
    for q in crate::text::quoted(request) {
        bare = bare.replace(&q, " ");
    }
    let bare = bare
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    Regex::new(r"\b(review|fix|refactor|implement|rewrite|debug|investigate|explain|summari[sz]e|documents?|(add|write) (a|an|one|the) (failing )?(test|section|paragraph|function|class))\b").is_ok_and(|r| r.is_match(&bare))
}

/// The actions and workflows whose triggers match the request.
pub fn triggered(request: &str) -> Vec<Target> {
    let lower = request.to_lowercase();
    let all = catalog::all()
        .iter()
        .map(|a| Target::Action(*a))
        .chain(workflow::all().iter().map(|w| Target::Workflow(w)));
    all.filter(|t| {
        t.triggers()
            .iter()
            .any(|p| Regex::new(p).is_ok_and(|r| r.is_match(&lower)))
    })
    .collect()
}

/// One step of a plan: an action, its inputs, what it takes from earlier steps, and when it runs.
pub struct PlanPart {
    pub action: &'static dyn Action,
    pub args: Args,
    pub inherit: Vec<(String, String)>,
    pub when: Option<Guard>,
}

pub struct Plan {
    pub target: &'static str,
    pub origin: Origin,
    pub parts: Vec<PlanPart>,
}

/// What asking Kai cost while a plan was made, kept whether or not the plan came out.
#[derive(Debug, Default, Clone)]
pub struct Trace {
    pub asks: Vec<Ask>,
    pub kai_ms: f64,
    pub kai_calls: u32,
}

/// Values of `source`, each with the sentence Kai reads.
pub fn list(source: Source, state: &State, args: &Args) -> Vec<Cand> {
    match source {
        Source::Branches => state.branches(),
        Source::Remotes => state.remotes(),
        Source::Commits => state.commits(40),
        Source::Suites => state.suites(),
        Source::Files => with_names(
            state
                .files()
                .into_iter()
                .take(500)
                .map(|f| Cand::new(&f, &f))
                .collect(),
        ),
        Source::Dirty => with_names(
            state
                .dirty()
                .into_iter()
                .map(|f| Cand::new(&f, &f))
                .collect(),
        ),
        Source::Docs => with_names(
            state
                .with_ext(&[".md"])
                .into_iter()
                .map(|f| {
                    let first = std::fs::read_to_string(state.root.join(&f))
                        .unwrap_or_default()
                        .lines()
                        .find(|l| l.starts_with('#'))
                        .unwrap_or("")
                        .trim_start_matches('#')
                        .trim()
                        .to_string();
                    Cand::new(&f, &format!("{f}: {first}"))
                })
                .collect(),
        ),
        Source::Headings => {
            let Some(path) = args.get("path").and_then(Value::as_str) else {
                return Vec::new();
            };
            std::fs::read_to_string(state.root.join(path))
                .unwrap_or_default()
                .lines()
                .filter_map(crate::catalog::note::heading)
                .map(|(_, t)| Cand::new(&t, &format!("section titled {t}")))
                .collect()
        }
        Source::Datasets => state
            .with_ext(&[".jsonl", ".csv"])
            .into_iter()
            .filter(|f| !crate::catalog::pairs::rows(&state.root.join(f)).is_empty())
            .map(|f| {
                Cand::new(
                    &f,
                    &format!(
                        "{f}: {}",
                        crate::catalog::pairs::describe(&state.root.join(&f))
                    ),
                )
            })
            .collect(),
    }
}

/// The values of `source` the request may mean: not the report it writes to.
fn candidates(
    act: &dyn Action,
    input: &Input,
    source: Source,
    state: &State,
    bound: &Args,
) -> Vec<Cand> {
    let report = bound.get("report").and_then(Value::as_str);
    let mut cands = list(source, state, bound);
    cands.retain(|c| Some(c.value.as_str()) != report && act.admits(state, bound, input.name, c));
    cands
}

/// A file's name alone is another way to say it, when no other file has that name.
fn with_names(mut cands: Vec<Cand>) -> Vec<Cand> {
    let names: Vec<String> = cands
        .iter()
        .map(|c| c.value.rsplit('/').next().unwrap_or(&c.value).to_string())
        .collect();
    for (i, c) in cands.iter_mut().enumerate() {
        if names[i] != c.value && names.iter().filter(|n| **n == names[i]).count() == 1 {
            c.aliases.push(names[i].clone());
        }
    }
    cands
}

/// Where the request names the value, if it does.
fn position(request: &str, cand: &Cand) -> Option<usize> {
    let named = std::iter::once(&cand.value)
        .chain(cand.aliases.iter())
        .filter_map(|n| mention(request, n))
        .min();
    named.or_else(|| {
        // A commit may be named by any prefix of its hash of seven or more digits.
        let hex = Regex::new(r"\b[0-9a-f]{7,40}\b").ok()?;
        let found = hex
            .find_iter(request)
            .find(|m| cand.value.starts_with(m.as_str()))
            .map(|m| m.start());
        found
    })
}

fn mentioned(request: &str, cands: &[Cand]) -> Vec<(usize, Cand)> {
    let mut found: Vec<(usize, Cand)> = cands
        .iter()
        .filter_map(|c| position(request, c).map(|p| (p, c.clone())))
        .collect();
    found.sort_by_key(|(p, _)| *p);
    found
}

fn literal(request: &str, pattern: &str) -> Option<String> {
    let re = Regex::new(pattern).ok()?;
    let caps = re.captures(request)?;
    (1..caps.len())
        .find_map(|i| caps.get(i))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// What binding one target needs next.
pub enum Bound {
    Done(Args),
    Need(Vec<Question>),
    Decline(Decline),
}

fn accept(ans: &Answer, cfg: &Config) -> Option<(String, f64, f64)> {
    let (key, p, margin) = ans.best();
    (!key.is_empty()
        && ans.abstain() <= cfg.max_abstain
        && p >= cfg.min_p
        && margin >= cfg.min_margin)
        .then_some((key, p, margin))
}

fn record(ans: &Answer, accepted: bool, options: usize, ms: f64) -> Ask {
    let (key, p, margin) = ans.best();
    Ask {
        question: ans.id.clone(),
        options,
        pick: key,
        p,
        margin,
        abstain: ans.abstain(),
        accepted,
        ms,
        top: ans.ranked().into_iter().take(3).collect(),
    }
}

/// Binds one action's inputs against the request and the answers Kai has given so far.
pub fn bind_action(
    action: &dyn Action,
    state: &State,
    answers: &HashMap<String, (Answer, f64)>,
    cfg: &Config,
    skip: &[&str],
) -> Bound {
    let spec = action.spec();
    let mut args = Args::new();
    let mut need = Vec::new();
    // The report is bound first: the file a request writes to is not one of the files it talks about.
    // Literals come next: a dependent constraint (a file that holds the arms the request names) reads them.
    let mut inputs: Vec<&Input> = spec.inputs.iter().collect();
    inputs.sort_by_key(|i| {
        if i.name == "report" {
            0
        } else if matches!(i.kind, Kind::Literal(_)) {
            1
        } else {
            2
        }
    });
    for input in inputs {
        if skip.contains(&input.name) {
            continue;
        }
        match bind_input(action, input, state, &args, answers, cfg) {
            Ok(Some(v)) => {
                args.insert(input.name.to_string(), v);
            }
            Ok(None) => {}
            Err(Pending::Question(q)) => {
                need.push(q);
                break;
            }
            Err(Pending::Decline(d)) => return Bound::Decline(d),
        }
    }
    if !need.is_empty() {
        return Bound::Need(need);
    }
    // A value that starts with a dash would be read as an option by the program it is handed to.
    for (name, value) in &args {
        let dashed = |s: &str| s.starts_with('-');
        let bad = match value {
            Value::String(s) => dashed(s),
            Value::Array(a) => a.iter().filter_map(Value::as_str).any(dashed),
            _ => false,
        };
        if bad && !matches!(name.as_str(), "message" | "text") {
            return Bound::Decline(Decline::Ungrounded(format!(
                "{}.{name}: looks like an option",
                spec.id
            )));
        }
    }
    Bound::Done(args)
}

enum Pending {
    Question(Question),
    Decline(Decline),
}

type Bind = Result<Option<Value>, Pending>;

fn missing(action: &str, input: &Input) -> Pending {
    Pending::Decline(Decline::Missing(format!("{action}.{}", input.name)))
}

fn bind_input(
    act: &dyn Action,
    input: &Input,
    state: &State,
    bound: &Args,
    answers: &HashMap<String, (Answer, f64)>,
    cfg: &Config,
) -> Bind {
    let req = &state.request;
    let action = act.spec().id;
    match input.kind {
        Kind::Literal(pattern) => match literal(req, pattern) {
            Some(v) => Ok(Some(json!(v))),
            None if input.optional => Ok(None),
            None => Err(missing(action, input)),
        },
        Kind::Nth(source, n) => {
            let cands = candidates(act, input, source, state, bound);
            let named = mentioned(req, &cands);
            let mut distinct: Vec<&Cand> = Vec::new();
            for (_, c) in &named {
                if !distinct.iter().any(|d| d.value == c.value) {
                    distinct.push(c);
                }
            }
            match distinct.get(n) {
                Some(c) => Ok(Some(json!(c.value))),
                None if input.optional => Ok(None),
                None => Err(missing(action, input)),
            }
        }
        Kind::Named(source) => {
            let cands = candidates(act, input, source, state, bound);
            let mut values: Vec<String> = Vec::new();
            for (_, c) in mentioned(req, &cands) {
                if !values.contains(&c.value) {
                    values.push(c.value);
                }
            }
            if values.is_empty() && !input.optional {
                Err(missing(action, input))
            } else if values.is_empty() {
                Ok(None)
            } else {
                Ok(Some(json!(values)))
            }
        }
        Kind::Pick(source) => {
            let cands = candidates(act, input, source, state, bound);
            if cands.is_empty() {
                return if input.optional {
                    Ok(None)
                } else {
                    Err(missing(action, input))
                };
            }
            let named = mentioned(req, &cands);
            if named.len() == 1 {
                return Ok(Some(json!(named[0].1.value)));
            }
            if named.is_empty() && cands.len() == 1 {
                return Ok(Some(json!(cands[0].value)));
            }
            if named.is_empty() && input.optional {
                return Ok(None);
            }
            // None is named: the values the request describes are the plausible ones.
            let described: Vec<Cand> = if named.is_empty() {
                cands
                    .iter()
                    .filter(|c| grounded(req, &c.label))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            if named.is_empty() && described.len() == 1 {
                return Ok(Some(json!(described[0].value)));
            }
            if named.is_empty() && described.is_empty() {
                return Err(Pending::Decline(Decline::Missing(format!(
                    "{action}.{}: no value is named or described",
                    input.name
                ))));
            }
            let qid = format!("{action}.{}", input.name);
            let pool: Vec<Cand> = if named.len() > 1 {
                named.into_iter().map(|(_, c)| c).collect()
            } else {
                shortlist(req, described, cfg.options)
            };
            match answers.get(&qid) {
                None => Err(Pending::Question(Question {
                    id: qid,
                    ask: input.ask.to_string(),
                    options: pool
                        .iter()
                        .map(|c| (c.value.clone(), crate::redact::cut(&c.label, 200)))
                        .collect(),
                })),
                Some((ans, _)) => match accept(ans, cfg) {
                    Some((key, _, _)) => {
                        let Some(c) = pool.iter().find(|c| c.value == key) else {
                            return Err(Pending::Decline(Decline::Ambiguous(format!(
                                "{qid}: kai picked {key}, which was not offered"
                            ))));
                        };
                        if position(req, c).is_none() && !grounded(req, &c.label) {
                            return Err(Pending::Decline(Decline::Ungrounded(format!(
                                "{qid}: {key}"
                            ))));
                        }
                        Ok(Some(json!(c.value)))
                    }
                    None => Err(Pending::Decline(Decline::Ambiguous(format!(
                        "{qid}: {}",
                        describe(ans)
                    )))),
                },
            }
        }
    }
}

fn describe(ans: &Answer) -> String {
    let (key, p, margin) = ans.best();
    format!(
        "kai leans to {key} at {p:.2}, lead {margin:.2}, abstains at {:.2}",
        ans.abstain()
    )
}

/// At most `n` candidates, the ones whose sentences share the most words with the request first.
fn shortlist(request: &str, mut cands: Vec<Cand>, n: usize) -> Vec<Cand> {
    if cands.len() > n {
        cands.sort_by_key(|c| std::cmp::Reverse(overlap(request, &c.label)));
        cands.truncate(n);
    }
    cands
}

/// Binds a target: an action alone, or every step of a workflow.
pub fn bind_target(
    target: Target,
    state: &State,
    answers: &HashMap<String, (Answer, f64)>,
    cfg: &Config,
) -> Result<Vec<PlanPart>, Bound> {
    let mut parts = Vec::new();
    let mut need = Vec::new();
    match target {
        Target::Action(a) => match bind_action(a, state, answers, cfg, &[]) {
            Bound::Done(args) => parts.push(PlanPart {
                action: a,
                args,
                inherit: Vec::new(),
                when: None,
            }),
            other => return Err(other),
        },
        Target::Workflow(w) => {
            for part in w.parts {
                let Some(a) = catalog::get(part.action) else {
                    return Err(Bound::Decline(Decline::NoAction(format!(
                        "{}: no action {}",
                        w.id, part.action
                    ))));
                };
                let skip: Vec<&str> = part.inherit.iter().map(|(i, _)| *i).collect();
                match bind_action(a, state, answers, cfg, &skip) {
                    Bound::Done(args) => parts.push(PlanPart {
                        action: a,
                        args,
                        inherit: part
                            .inherit
                            .iter()
                            .map(|(i, f)| ((*i).to_string(), (*f).to_string()))
                            .collect(),
                        when: part.when,
                    }),
                    Bound::Need(q) => need.extend(q),
                    d @ Bound::Decline(_) => return Err(d),
                }
            }
            if !need.is_empty() {
                return Err(Bound::Need(need));
            }
        }
    }
    Ok(parts)
}

/// Whether every precondition of every step that can be read now holds.
fn feasible(parts: &[PlanPart], state: &State) -> Result<(), Decline> {
    for p in parts.iter().filter(|p| p.inherit.is_empty()) {
        let bad: Vec<Check> = p
            .action
            .check(state, &p.args)
            .into_iter()
            .filter(|c| !c.ok)
            .collect();
        if let Some(c) = bad.first() {
            return Err(Decline::Precondition(format!(
                "{}: {} ({})",
                p.action.spec().id,
                c.name,
                c.detail
            )));
        }
    }
    Ok(())
}

/// A target that can still run: its bound steps, or the questions it waits on.
type Viable = (Target, Result<Vec<PlanPart>, Vec<Question>>);

/// The plan for a request, asking Kai only when the request leaves a real choice.
pub fn plan(
    state: &State,
    chooser: Option<&dyn Chooser>,
    cfg: &Config,
    trace: &mut Trace,
) -> Result<Plan, Decline> {
    if authoring(&state.request) {
        return Err(Decline::NoAction(
            "the request asks for something to be written".into(),
        ));
    }
    let targets = triggered(&state.request);
    if targets.is_empty() {
        return Err(Decline::NoAction("no trigger matches the request".into()));
    }
    let mut answers: HashMap<String, (Answer, f64)> = HashMap::new();
    for _round in 0..4 {
        let mut viable: Vec<Viable> = Vec::new();
        let mut why: Vec<String> = Vec::new();
        for t in &targets {
            match bind_target(*t, state, &answers, cfg) {
                Ok(parts) => match feasible(&parts, state) {
                    Ok(()) => viable.push((*t, Ok(parts))),
                    Err(d) => why.push(format!("{}: {d}", t.id())),
                },
                Err(Bound::Need(q)) => viable.push((*t, Err(q))),
                Err(Bound::Decline(d)) => why.push(format!("{}: {d}", t.id())),
                Err(Bound::Done(_)) => {}
            }
        }
        if viable.is_empty() {
            return Err(Decline::NoAction(why.join("; ")));
        }
        // A workflow whose steps all bind subsumes those steps alone.
        let covered: Vec<&str> = viable
            .iter()
            .filter_map(|(t, _)| {
                if let Target::Workflow(w) = t {
                    Some(w.parts.iter().map(|p| p.action))
                } else {
                    None
                }
            })
            .flatten()
            .collect();
        viable.retain(|(t, _)| !matches!(t, Target::Action(a) if covered.contains(&a.spec().id)));
        // A part of the request that no viable action serves is not ours to drop.
        let unserved: Vec<&String> = why
            .iter()
            .filter(|w| !covered.iter().any(|c| w.starts_with(&format!("{c}:"))))
            .collect();
        if !unserved.is_empty() {
            return Err(Decline::Ambiguous(format!(
                "the request also fits what cannot run: {}",
                unserved
                    .iter()
                    .map(|w| w.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        let mut chosen = None;
        if viable.len() == 1 {
            chosen = Some(0);
        } else if let Some((ans, _)) = answers.get("action") {
            let Some((key, _, _)) = accept(ans, cfg) else {
                return Err(Decline::Ambiguous(format!("action: {}", describe(ans))));
            };
            chosen = viable.iter().position(|(t, _)| t.id() == key);
            if chosen.is_none() {
                return Err(Decline::Ambiguous(format!(
                    "action: kai picked {key}, which was not offered"
                )));
            }
        }
        let mut questions: Vec<Question> = Vec::new();
        if viable.len() > 1 && chosen.is_none() {
            questions.push(Question {
                id: "action".into(),
                ask: "Which action does the request ask for?".into(),
                options: viable
                    .iter()
                    .map(|(t, _)| (t.id().to_string(), t.summary().to_string()))
                    .collect(),
            });
        }
        match chosen {
            Some(i) => {
                if let Err(q) = &viable[i].1 {
                    questions.extend(q.iter().cloned());
                }
            }
            None => {
                for (_, r) in &viable {
                    if let Err(q) = r {
                        questions.extend(q.iter().cloned());
                    }
                }
            }
        }
        if questions.is_empty() {
            let Some(i) = chosen else {
                return Err(Decline::Ambiguous("several actions fit".into()));
            };
            let (target, parts) = viable.swap_remove(i);
            let Ok(parts) = parts else {
                return Err(Decline::Missing("unbound input".into()));
            };
            let origin = if trace.asks.iter().any(|a| a.accepted) {
                Origin::Kai
            } else {
                Origin::Rule
            };
            return Ok(Plan {
                target: target.id(),
                origin,
                parts,
            });
        }
        let Some(chooser) = chooser else {
            return Err(Decline::Kai(
                "a choice is open and no chooser is configured".into(),
            ));
        };
        let asked = chooser
            .decide(&state.request, &questions)
            .map_err(Decline::Kai)?;
        trace.kai_ms += asked.ms;
        trace.kai_calls += 1;
        for a in asked.answers {
            let q = questions.iter().find(|q| q.id == a.id);
            let accepted = accept(&a, cfg).is_some();
            trace.asks.push(record(
                &a,
                accepted,
                q.map_or(0, |q| q.options.len()),
                asked.ms,
            ));
            answers.insert(a.id.clone(), (a, asked.ms));
        }
    }
    Err(Decline::Ambiguous(
        "inputs stayed open after four rounds".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_matches_the_triggers_of_its_action_and_of_others_that_could_fit() {
        let ids = |r: &str| triggered(r).iter().map(Target::id).collect::<Vec<_>>();
        assert!(
            ids("Find all uses of `parse_header` and write them to answer.txt").contains(&"find")
        );
        assert!(
            ids("Run the tests, and if they pass commit `a.py` with message \"x\" and push")
                .contains(&"ship")
        );
        assert!(ids("Create a worktree for branch `x` at `../wt`").contains(&"worktree"));
        assert!(!ids("Create a worktree for branch `x` at `../wt`").contains(&"suite"));
    }

    #[test]
    fn writing_is_not_an_action_but_a_quoted_word_is_only_a_value() {
        assert!(authoring(
            "The tests in `tests/` are failing. Fix the source so they pass."
        ));
        assert!(authoring(
            "Review the diff of `feat`. Add one test file with a test that fails."
        ));
        assert!(authoring(
            "Add a \"## Usage\" section to `README.md` that documents the `--limit` flag."
        ));
        assert!(!authoring(
            "Commit `a.py` with the message \"Fix off-by-one in paging\" and push to origin `main`."
        ));
        assert!(!authoring(
            "Run the tests and write `passed=<n> failed=<m>` to `answer.txt`."
        ));
        assert!(!authoring(
            "Add the line \"Retries are capped at 3.\" at the end of the \"Notes\" section of `docs/NOTES.md`."
        ));
    }

    #[test]
    fn literals_come_from_the_request() {
        let p = r#"(?i)\bbranch(?:\s+named|\s+called)?\s+[`"']([\w./-]+)[`"']|\bworktree\s+(?:for|on)\s+[`"']([\w./-]+)[`"']"#;
        assert_eq!(
            literal("worktree for `exp-1` at `../wt`", p),
            Some("exp-1".into())
        );
        assert_eq!(
            literal("new branch `exp-2` off main", p),
            Some("exp-2".into())
        );
        assert_eq!(literal("nothing here", p), None);
    }
}
