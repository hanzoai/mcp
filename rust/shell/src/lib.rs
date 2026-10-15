//! Reads a shell command as a shell does and says whether it may run: `allow`, `ask` or `deny`.
//!
//! The command is parsed by a bash grammar (brush-parser), then every simple command,
//! redirection, substitution and nested script in it is read in the order the shell would run
//! them. Code handed to an interpreter (`bash -c`, `python -c`, a here-document, a script
//! the command itself wrote) is read in turn. What each command does is a rule; the policy
//! over paths, in `path`, decides what that costs. Nothing is executed and no file is
//! touched, unless the caller lends a [`Files`] reader for scripts.

mod context;
mod expand;
mod inline;
mod path;
mod python;
mod rules;
mod sql;
mod val;
mod verdict;
mod walk;

#[cfg(feature = "wasm")]
mod wasm;

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

pub use context::{Context, Files, TEMP};
pub use verdict::{Finding, Kind, Report, Risk};

/// The most commands cached, and the most bytes of them.
const SLOTS: usize = 4096;
const BYTES: usize = 8 * 1024 * 1024;
/// A command longer than this is read but not remembered.
const REMEMBER: usize = 16 * 1024;

/// Reads `command` as it would run in `ctx`.
pub fn classify(command: &str, ctx: &Context) -> Report {
    read(command, ctx).0
}

/// The report, and whether it depends on the disk (a script was read from it).
fn read(command: &str, ctx: &Context) -> (Report, bool) {
    let command = val::plain(command);
    let mut w = walk::Walker::new(ctx);
    if command.contains('\0') {
        w.ask(Kind::Unparsed, "the command holds a NUL byte");
    }
    let mut st = walk::State::start(ctx);
    w.script(&command, &mut st);
    let impure = w.impure;
    (Report::of(w.found), impure)
}

/// A glob qualifier that zsh evaluates (`*(e:'cmd':)`, `*(+fn)`), which the bash grammar reads as
/// a pattern. Checked on unquoted words, where a shell reads a glob.
pub(crate) fn zsh_glob(word: &str) -> Option<&'static str> {
    let b = word.as_bytes();
    let glob_before = |i: usize| i > 0 && matches!(b[i - 1], b'*' | b'?' | b']' | b')' | b'.');
    for (i, _) in word.match_indices("(e") {
        if glob_before(i) && matches!(b.get(i + 2), Some(b':') | Some(b'\'') | Some(b'"')) {
            return Some("a glob qualifier that evaluates code (zsh)");
        }
    }
    for (i, _) in word.match_indices("(+") {
        if glob_before(i) && b.get(i + 2).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
            return Some("a glob qualifier that calls a function (zsh)");
        }
    }
    None
}

/// A classifier that remembers what it has read: the same command in the same place is read once.
pub struct Classifier {
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    map: HashMap<String, Report>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Default for Classifier {
    fn default() -> Self {
        Classifier::new()
    }
}

impl Classifier {
    pub fn new() -> Classifier {
        Classifier { cache: Mutex::new(Cache::default()) }
    }

    /// The report for `command` in `ctx`. The key is the whole text of both, so two commands
    /// can never be taken for one.
    pub fn classify(&self, command: &str, ctx: &Context) -> Report {
        let key = if command.len() <= REMEMBER { Some(format!("{command}\u{0}{}", ctx.key())) } else { None };
        if let Some(k) = &key {
            if let Ok(c) = self.cache.lock() {
                if let Some(r) = c.map.get(k) {
                    return r.clone();
                }
            }
        }
        let (report, impure) = read(command, ctx);
        if let (Some(k), false) = (key, impure) {
            if let Ok(mut c) = self.cache.lock() {
                while c.order.len() >= SLOTS || c.bytes + k.len() > BYTES {
                    match c.order.pop_front() {
                        Some(old) => {
                            c.bytes = c.bytes.saturating_sub(old.len());
                            c.map.remove(&old);
                        }
                        None => break,
                    }
                }
                c.bytes += k.len();
                c.order.push_back(k.clone());
                c.map.insert(k, report.clone());
            }
        }
        report
    }
}

/// What the environment given to a command changes about what it runs: a report on the
/// variables alone (`BASH_ENV`, `LD_PRELOAD`, `ZDOTDIR`, a `PATH` with a scratch directory).
pub fn environment<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>, ctx: &Context) -> Report {
    let mut w = walk::Walker::new(ctx);
    for (name, value) in pairs {
        rules::env_name(&mut w, name, &[val::Val::lit(val::plain(value))]);
    }
    Report::of(w.found)
}
