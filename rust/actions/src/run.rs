//! Running a plan: preconditions read again just before each step, authorization, the proof gate,
//! the cache, the run, the verifier, and a record of each.

use crate::action::{Action, Args, Check, Cx, Output, Verdict};
use crate::ask::Chooser;
use crate::bind::{Config, Decline, Plan, PlanPart, Trace, plan};
use crate::cache::{Store, memo_key, proof_key};
use crate::exec::Step;
use crate::ledger::{Ask, Authorization, Cache, Origin, Outcome, Record, Timing};
use crate::redact::{cut, redact};
use crate::state::{State, sha256};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Instant;

/// What a consequential action asks of the user.
#[derive(Debug, Clone)]
pub struct Approval {
    pub action: String,
    pub reason: String,
    pub detail: String,
}

/// The user's side of authorization. The native client asks; a test or a sandbox answers.
pub trait Approver: Sync {
    fn approve(&self, approval: &Approval) -> bool;
}

/// Grants every request. For a sandbox that counts them from the ledger.
pub struct Grant;

impl Approver for Grant {
    fn approve(&self, _approval: &Approval) -> bool {
        true
    }
}

/// Refuses every request.
pub struct Refuse;

impl Approver for Refuse {
    fn approve(&self, _approval: &Approval) -> bool {
        false
    }
}

pub struct Engine<'a> {
    pub chooser: Option<&'a dyn Chooser>,
    pub cache: Option<&'a Store>,
    pub approver: &'a dyn Approver,
    pub cfg: Config,
    /// Record a proof for each action whose verifier passes, and do not require one.
    pub prove: bool,
}

/// Everything a request produced.
#[derive(Debug, Serialize)]
pub struct Report {
    pub outcome: Outcome,
    pub target: Option<String>,
    pub records: Vec<Record>,
    pub asks: Vec<Ask>,
    pub kai_calls: u32,
    pub kai_ms: f64,
    pub bind_ms: f64,
    pub total_ms: f64,
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn scrub(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(redact(s)),
        Value::Array(a) => Value::Array(a.iter().map(scrub).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), scrub(v))).collect()),
        other => other.clone(),
    }
}

fn declined(report: &mut Report, why: String) {
    report.outcome = Outcome::Declined(why);
}

/// What a request would run, without running it: the plan's steps, who chose them, and what asking Kai cost.
pub fn plan_report(engine: &Engine, root: &Path, request: &str) -> Value {
    let started = Instant::now();
    let state = State::new(root, request);
    let mut trace = Trace::default();
    let triggered: Vec<&str> = crate::bind::triggered(request).iter().map(crate::bind::Target::id).collect();
    let planned = plan(&state, engine.chooser, &engine.cfg, &mut trace);
    let steps = |p: &Plan| -> Vec<Value> {
        p.parts
            .iter()
            .map(|part| serde_json::json!({ "action": part.action.spec().id, "version": part.action.spec().version, "args": scrub(&serde_json::to_value(&part.args).unwrap_or_default()), "inherit": part.inherit, "effect": part.action.effect(&state, &part.args) }))
            .collect()
    };
    let (outcome, target, source, steps) = match &planned {
        Ok(p) => ("planned".to_string(), Some(p.target), Some(p.origin), steps(p)),
        Err(d) => (format!("declined: {d}"), None, None, Vec::new()),
    };
    serde_json::json!({ "outcome": outcome, "target": target, "source": source, "steps": steps, "triggered": triggered, "asks": trace.asks, "kai_calls": trace.kai_calls, "kai_ms": trace.kai_ms, "total_ms": ms(started) })
}

/// Runs the request in `root`: plans it, then runs each step.
pub fn perform(engine: &Engine, root: &Path, request: &str) -> Report {
    let started = Instant::now();
    let state = State::new(root, request);
    let revision = state.revision();
    let mut trace = Trace::default();
    let bind_started = Instant::now();
    let planned = plan(&state, engine.chooser, &engine.cfg, &mut trace);
    let bind_ms = (ms(bind_started) - trace.kai_ms).max(0.0);
    let mut report = Report {
        outcome: Outcome::Done,
        target: None,
        records: Vec::new(),
        asks: trace.asks.clone(),
        kai_calls: trace.kai_calls,
        kai_ms: trace.kai_ms,
        bind_ms,
        total_ms: 0.0,
    };
    match planned {
        Err(d) => declined(&mut report, d.to_string()),
        Ok(p) => {
            report.target = Some(p.target.to_string());
            steps(engine, root, request, &revision, &p, &trace, &mut report);
        }
    }
    report.total_ms = ms(started);
    report
}

fn steps(
    engine: &Engine,
    root: &Path,
    request: &str,
    revision: &str,
    plan: &Plan,
    trace: &Trace,
    report: &mut Report,
) {
    let mut outputs: Vec<Option<Output>> = Vec::new();
    for (i, part) in plan.parts.iter().enumerate() {
        if let Some(g) = part.when {
            let held = outputs
                .get(g.step)
                .and_then(Option::as_ref)
                .and_then(|o| o.data[g.field].as_i64())
                == Some(g.equals);
            if !held {
                outputs.push(None);
                report.records.push(skipped(
                    part,
                    plan,
                    revision,
                    format!("{} of step {} is not {}", g.field, g.step + 1, g.equals),
                ));
                continue;
            }
        }
        let mut args = part.args.clone();
        for (input, from) in &part.inherit {
            let value = from
                .strip_prefix('$')
                .and_then(|r| r.split_once('.'))
                .and_then(|(n, f)| {
                    n.parse::<usize>()
                        .ok()
                        .and_then(|n| outputs.get(n - 1))
                        .and_then(Option::as_ref)
                        .map(|o| o.data[f].clone())
                });
            match value {
                Some(v) if !v.is_null() => {
                    args.insert(input.clone(), v);
                }
                _ => {
                    declined(
                        report,
                        format!("step {} cannot take {from} from an earlier step", i + 1),
                    );
                    return;
                }
            }
        }
        match step(engine, root, request, revision, plan, i, part, &args, trace) {
            Ok((record, out)) => {
                report.records.push(record);
                outputs.push(Some(out));
            }
            Err(record) => {
                report.outcome = record.outcome.clone();
                report.records.push(*record);
                return;
            }
        }
    }
}

fn skipped(part: &PlanPart, plan: &Plan, revision: &str, why: String) -> Record {
    let s = part.action.spec();
    Record {
        id: sha256(format!("{}|{}|skipped|{why}", s.id, s.version).as_bytes())[..16].to_string(),
        action: s.id.into(),
        version: s.version,
        source: plan.origin,
        revision: revision.into(),
        revision_at_run: revision.into(),
        args: scrub(&serde_json::to_value(&part.args).unwrap_or_default()),
        preconditions: Vec::new(),
        authorization: Authorization {
            required: false,
            reason: None,
            granted: true,
            by: "policy".into(),
        },
        cache: Cache {
            proved: false,
            memo: "off".into(),
            fingerprint: String::new(),
        },
        asks: Vec::new(),
        steps: Vec::new(),
        timing: Timing::default(),
        verdict: None,
        outcome: Outcome::Skipped(why),
        output: String::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn step(
    engine: &Engine,
    root: &Path,
    request: &str,
    revision: &str,
    plan: &Plan,
    index: usize,
    part: &PlanPart,
    args: &Args,
    trace: &Trace,
) -> Result<(Record, Output), Box<Record>> {
    let action: &dyn Action = part.action;
    let spec = action.spec();
    let t0 = Instant::now();
    let work = args
        .get("root")
        .and_then(Value::as_str)
        .map_or_else(|| root.to_path_buf(), std::path::PathBuf::from);
    let state = State::new(&work, request);
    let mut timing = Timing::default();
    let mut rec = Record {
        id: String::new(),
        action: spec.id.into(),
        version: spec.version,
        source: if index == 0 {
            plan.origin
        } else {
            Origin::Rule
        },
        revision: revision.into(),
        revision_at_run: String::new(),
        args: scrub(&serde_json::to_value(args).unwrap_or_default()),
        preconditions: Vec::new(),
        authorization: Authorization {
            required: false,
            reason: None,
            granted: true,
            by: "policy".into(),
        },
        cache: Cache {
            proved: false,
            memo: "off".into(),
            fingerprint: String::new(),
        },
        asks: if index == 0 {
            trace.asks.clone()
        } else {
            Vec::new()
        },
        steps: Vec::new(),
        timing: Timing::default(),
        verdict: None,
        outcome: Outcome::Done,
        output: String::new(),
    };
    let stop = |mut r: Record, outcome: Outcome, timing: Timing, t0: Instant| -> Box<Record> {
        r.outcome = outcome;
        r.timing = Timing {
            total_ms: ms(t0),
            ..timing
        };
        r.id = id_of(&r);
        Box::new(r)
    };
    // Preconditions, read now.
    let t = Instant::now();
    let checks: Vec<Check> = action.check(&state, args);
    timing.check_ms = ms(t);
    rec.revision_at_run = state.revision();
    rec.preconditions = checks.clone();
    if let Some(bad) = checks.iter().find(|c| !c.ok) {
        let why = Decline::Precondition(format!("{}: {} ({})", spec.id, bad.name, bad.detail))
            .to_string();
        return Err(stop(rec, Outcome::Declined(why), timing, t0));
    }
    if index == 0 && work == root && rec.revision_at_run != revision {
        let why =
            Decline::Stale(format!("bound at {revision}, now {}", rec.revision_at_run)).to_string();
        return Err(stop(rec, Outcome::Declined(why), timing, t0));
    }
    // Authorization: a match is not permission.
    let effect = action.effect(&state, args);
    if let Some(reason) = effect.reason() {
        let granted = engine.approver.approve(&Approval {
            action: spec.id.into(),
            reason: reason.into(),
            detail: rec.args.to_string(),
        });
        rec.authorization = Authorization {
            required: true,
            reason: Some(reason.into()),
            granted,
            by: "approver".into(),
        };
        if !granted {
            let why = Decline::Denied(format!("{}: {reason}", spec.id)).to_string();
            return Err(stop(rec, Outcome::Declined(why), timing, t0));
        }
    }
    // The proof gate.
    let pkey = proof_key(action);
    let proved = engine.cache.is_some_and(|c| c.proved(&pkey));
    rec.cache.proved = proved;
    if engine.cfg.require_proof && !engine.prove && !proved {
        let why = Decline::Unproven(format!("{} v{}", spec.id, spec.version)).to_string();
        return Err(stop(rec, Outcome::Declined(why), timing, t0));
    }
    // The cache: a pure action's result is reused while everything it reads is as it was.
    let mut cx = Cx::new(work, root.to_path_buf(), request);
    let memo = engine
        .cache
        .filter(|_| spec.pure)
        .map(|c| (c, memo_key(action, &state, args)));
    if let Some((_, key)) = &memo {
        rec.cache.fingerprint.clone_from(key);
        rec.cache.memo = "miss".into();
    }
    let t = Instant::now();
    let hit = memo
        .as_ref()
        .and_then(|(c, key)| c.memo(key))
        .map(|m| Output {
            text: m.text,
            data: m.data,
        });
    let out = match hit {
        Some(out) => {
            rec.cache.memo = "hit".into();
            if let Err(e) = crate::action::report(&cx, args, &out.text) {
                rec.output = cut(&redact(&e), 500);
                return Err(stop(rec, Outcome::Failed(e), timing, t0));
            }
            out
        }
        None => match action.run(&mut cx, args) {
            Ok(out) => out,
            Err(e) => {
                timing.run_ms = ms(t);
                rec.steps = cx.steps;
                rec.output = cut(&redact(&e), 500);
                let why = redact(&e);
                return Err(stop(rec, Outcome::Failed(why), timing, t0));
            }
        },
    };
    timing.run_ms = ms(t);
    rec.steps = std::mem::take(&mut cx.steps);
    // The verifier says whether the effect happened.
    let t = Instant::now();
    let verdict: Verdict = action.verify(&cx, args, &out);
    timing.verify_ms = ms(t);
    rec.output = cut(&redact(&out.text), 2000);
    rec.verdict = Some(verdict.clone());
    if !verdict.ok {
        let why = format!("verify: {}", redact(&verdict.detail));
        return Err(stop(rec, Outcome::Failed(why), timing, t0));
    }
    if let Some(c) = engine.cache {
        if engine.prove {
            let _ = c.prove(action, &pkey);
        }
        if let Some((_, key)) = &memo {
            if rec.cache.memo == "miss" {
                let _ = c.remember(action, key, &out.text, &out.data);
            }
        }
    }
    rec.timing = Timing {
        total_ms: ms(t0),
        ..timing
    };
    rec.id = id_of(&rec);
    Ok((rec, out))
}

/// A record's id: what ran, with what, against what. The same run of the same workspace has the same id.
fn id_of(r: &Record) -> String {
    sha256(
        format!(
            "{}|{}|{}|{}|{}",
            r.action, r.version, r.args, r.revision_at_run, r.cache.fingerprint
        )
        .as_bytes(),
    )[..16]
        .to_string()
}

/// A [`Step`] list as a flat summary, for logs.
pub fn summary(steps: &[Step]) -> String {
    steps
        .iter()
        .map(|s| s.argv.join(" "))
        .collect::<Vec<_>>()
        .join(" ; ")
}
