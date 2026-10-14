//! An action: one saved, typed, verified operation.
//!
//! An action names its inputs and what each may be, the preconditions that must hold before it
//! runs, what it does to the world (which decides whether the user must approve it), what its
//! result depends on, and the check that its effect happened. Kai selects an action and binds its
//! inputs from values read out of the repository; the action never receives a shell string.

use crate::exec::{Out, Step, run};
use crate::state::State;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// Bound inputs, by name. A single value is a string; a set is an array of strings.
pub type Args = BTreeMap<String, Value>;

/// What an action does to the world.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    /// Reads the workspace only.
    Read,
    /// Writes inside the workspace.
    Write,
    /// Writes outside the workspace.
    Outside,
    /// Reaches a remote: a push, a fetch, a request to another host.
    Remote,
    /// Stops a process or deletes data.
    Destroy,
}

impl Effect {
    /// Why the user must approve an action with this effect; `None` when no approval is needed.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Effect::Read | Effect::Write => None,
            Effect::Outside => Some("writes outside the workspace"),
            Effect::Remote => Some("reaches a remote"),
            Effect::Destroy => Some("stops a process or deletes data"),
        }
    }
}

/// Where the values an input may take are read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Branches,
    Remotes,
    Commits,
    Files,
    Dirty,
    Suites,
    Docs,
    /// The headings of the file bound to `path`.
    Headings,
    /// Result files: JSON lines or CSV with one row an attempt.
    Datasets,
}

/// How an input is bound.
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    /// The first capture of a pattern over the request.
    Literal(&'static str),
    /// One of the source's values: the one the request names, the only one there is, or Kai's pick.
    Pick(Source),
    /// The nth distinct value of the source the request names, in the order it names them.
    Nth(Source, usize),
    /// Every value of the source the request names.
    Named(Source),
}

#[derive(Debug, Clone, Copy)]
pub struct Input {
    pub name: &'static str,
    /// The question Kai is asked when this input is a choice.
    pub ask: &'static str,
    pub kind: Kind,
    /// May be left unbound: the action has a default.
    pub optional: bool,
}

#[derive(Debug)]
pub struct Spec {
    pub id: &'static str,
    pub version: u32,
    /// The sentence Kai reads to tell this action from the others.
    pub summary: &'static str,
    /// Patterns over the lowercased request; an action is a candidate when one matches.
    pub triggers: &'static [&'static str],
    pub inputs: &'static [Input],
    pub effect: Effect,
    /// Programs whose versions the action depends on.
    pub tools: &'static [&'static str],
    /// The result is a function of what it reads: it may be reused while that is unchanged.
    pub pure: bool,
}

/// What a result depends on in the workspace.
#[derive(Debug, Clone)]
pub enum Reads {
    /// These files, as they are now (uncommitted changes included).
    Files(Vec<String>),
    /// Every file.
    Tree,
    /// The commit and the refs.
    Git,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    pub fn new(name: &str, ok: bool, detail: impl Into<String>) -> Check {
        Check {
            name: name.to_string(),
            ok,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Verdict {
    pub ok: bool,
    pub detail: String,
}

impl Verdict {
    pub fn pass(detail: impl Into<String>) -> Verdict {
        Verdict {
            ok: true,
            detail: detail.into(),
        }
    }

    pub fn fail(detail: impl Into<String>) -> Verdict {
        Verdict {
            ok: false,
            detail: detail.into(),
        }
    }
}

/// What an action produced: the text it reports, and fields later steps of a workflow read.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Output {
    pub text: String,
    pub data: Value,
}

/// Where an action runs, and the commands it ran.
pub struct Cx {
    /// Where the action works (a workflow may move a later step into a new worktree).
    pub root: PathBuf,
    /// Where the request was made: reports are written relative to it.
    pub home: PathBuf,
    pub request: String,
    pub steps: Vec<Step>,
}

impl Cx {
    pub fn new(root: PathBuf, home: PathBuf, request: &str) -> Cx {
        Cx {
            root,
            home,
            request: request.to_string(),
            steps: Vec::new(),
        }
    }

    pub fn state(&self) -> State {
        State::new(&self.root, &self.request)
    }

    /// Runs a command here, keeping a record of it.
    pub fn exec(&mut self, argv: &[&str], limit: Duration) -> Result<Out, String> {
        let out = run(&self.root, argv, limit)?;
        self.steps.push(out.step.clone());
        Ok(out)
    }

    /// Runs a command that must succeed; its stdout.
    pub fn must(&mut self, argv: &[&str]) -> Result<String, String> {
        let out = self.exec(argv, Duration::from_secs(600))?;
        if out.ok() {
            Ok(out.stdout)
        } else {
            Err(format!("{}: {}", argv.join(" "), out.stderr.trim()))
        }
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        let p = std::path::Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        }
    }
}

pub trait Action: Sync {
    fn spec(&self) -> &'static Spec;

    /// What it does with these arguments (a path outside the workspace makes a write `Outside`).
    fn effect(&self, _state: &State, _args: &Args) -> Effect {
        self.spec().effect
    }

    /// Whether `cand` is a value `input` may take given the inputs bound so far: a dependent constraint
    /// (a results file must hold both arms the request names) that narrows the choice before anyone is asked.
    fn admits(
        &self,
        _state: &State,
        _args: &Args,
        _input: &str,
        _cand: &crate::state::Cand,
    ) -> bool {
        true
    }

    /// The preconditions, read now. Every one must hold for the action to run.
    fn check(&self, state: &State, args: &Args) -> Vec<Check>;

    /// What its result depends on.
    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Tree
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String>;

    /// Whether the effect the action promises happened.
    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict;
}

/// A string argument.
pub fn text<'a>(args: &'a Args, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str)
}

/// A set argument.
pub fn list(args: &Args, name: &str) -> Vec<String> {
    args.get(name)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Writes a requested report next to the work; the text is redacted first.
pub fn report(cx: &Cx, args: &Args, body: &str) -> Result<(), String> {
    if let Some(path) = text(args, "report") {
        let p = std::path::Path::new(path);
        let target = if p.is_absolute() {
            p.to_path_buf()
        } else {
            cx.home.join(p)
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut body = crate::redact::redact(body);
        if !body.ends_with('\n') {
            body.push('\n');
        }
        std::fs::write(&target, body).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}
