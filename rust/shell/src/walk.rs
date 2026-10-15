//! The walk: a command line parsed by a bash grammar, then every command, redirection,
//! substitution and nested script in it read in the order the shell would run them.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;

use brush_parser::ast::{self, AndOr, Command, CommandPrefixOrSuffixItem, CompoundCommand, CompoundList, IoFileRedirectKind, IoFileRedirectTarget, IoRedirect, SeparatorOperator};
use brush_parser::{Parser, ParserOptions};

use crate::context::Context;
use crate::expand::{self, ALTS};
use crate::path::{Lay, REMOTE, VIRTUAL};
use crate::val::{Val, UNK};
use crate::verdict::{clause, Finding, Kind, Risk};

/// The deepest a script nests in another (a `bash -c` in a `$(…)` in a `sh -c`).
pub(crate) const DEPTH: u8 = 8;
/// The most bytes of script read for one command, nested scripts included.
const BYTES: usize = 512 * 1024;
/// The most commands read for one command line.
const COMMANDS: i32 = 6000;
/// The deepest the brackets of a script may nest before it is not parsed.
const NEST: usize = 48;

#[derive(Clone, Debug)]
pub(crate) enum Var {
    Known(Vec<Val>),
    Unknown,
}

#[derive(Clone)]
pub(crate) struct State {
    /// The directory the next command runs in; none when a `cd` put it somewhere unknown.
    pub cwd: Option<String>,
    pub env: HashMap<String, Var>,
    pub depth: u8,
}

impl State {
    pub fn start(ctx: &Context) -> State {
        let cwd = if ctx.remote { REMOTE.to_string() } else { ctx.cwd.clone().map(|c| crate::path::normalize(&c)).unwrap_or_else(|| VIRTUAL.to_string()) };
        State { cwd: Some(cwd), env: HashMap::new(), depth: 0 }
    }

    /// The state after either of two paths that might have been taken.
    pub fn join(&mut self, other: &State) {
        if self.cwd != other.cwd {
            self.cwd = None;
        }
        let keys: HashSet<String> = self.env.keys().chain(other.env.keys()).cloned().collect();
        for k in keys {
            // A name set on one path only is, on the other, unset: the empty string, the case that
            // turns `rm -rf $dir/` into `rm -rf /`.
            let empty = Val::lit("");
            let merged = match (self.env.get(&k), other.env.get(&k)) {
                (Some(Var::Known(a)), Some(Var::Known(b))) => {
                    let mut v = a.clone();
                    v.extend(b.iter().cloned());
                    let v = expand::dedup(v);
                    if v.len() > ALTS {
                        Var::Unknown
                    } else {
                        Var::Known(v)
                    }
                }
                (Some(Var::Known(a)), None) | (None, Some(Var::Known(a))) if k != "!" => {
                    let mut v = a.clone();
                    v.push(empty);
                    Var::Known(expand::dedup(v))
                }
                (Some(Var::Known(a)), None) | (None, Some(Var::Known(a))) => Var::Known(a.clone()),
                _ => Var::Unknown,
            };
            self.env.insert(k, merged);
        }
    }

    pub fn set(&mut self, name: &str, vals: Vec<Val>) {
        let vals = expand::dedup(vals);
        if vals.is_empty() || vals.len() > ALTS {
            self.env.insert(name.to_string(), Var::Unknown);
        } else {
            self.env.insert(name.to_string(), Var::Known(vals));
        }
    }

    pub fn forget(&mut self, name: &str) {
        self.env.insert(name.to_string(), Var::Unknown);
    }
}

/// Where a command's standard input comes from.
#[derive(Clone, Default)]
pub(crate) enum Stdin {
    #[default]
    Inherit,
    /// The previous command of a pipeline: its text when it is known, and whether it came off the network.
    Pipe { literal: Option<String>, net: bool },
    /// A here-document or here-string.
    Text(Val),
    /// `< file`.
    File(Val),
}

#[derive(Clone, Default)]
pub(crate) struct Io {
    pub stdin: Stdin,
    /// Standard output goes to a file, not on.
    pub out_file: bool,
    /// Files standard output is written to.
    pub out_to: Vec<Val>,
}

/// What a command leaves for the next one in a pipeline, when that is known.
#[derive(Default, Clone)]
pub(crate) struct Out {
    pub literal: Option<String>,
    pub net: bool,
}

pub(crate) struct Walker<'c> {
    pub ctx: &'c Context,
    pub lay: Lay,
    pub found: Vec<Finding>,
    pub funcs: HashSet<String>,
    /// Files this command line writes with text it knows, by absolute path.
    pub wrote: HashMap<String, String>,
    /// A script was read from disk: the answer depends on the disk, so it is not cached.
    pub impure: bool,
    /// The secret variable a command's words expanded, for the commands that print.
    pub cmd_secret: Option<String>,
    bytes: usize,
    commands: i32,
    pub over: bool,
}

fn parse(src: &str) -> Result<ast::Program, brush_parser::ParseError> {
    let mut p = Parser::new(Cursor::new(src.as_bytes()), &ParserOptions::default());
    p.parse_program()
}

/// The greatest nesting in `src`, counted without regard to quotes: brackets (`(`, `{`, a
/// backquote) and the keywords that open a compound command (`if`, `for`, `while`, `until`,
/// `case`), less the ones that close it. More than a parse may safely recurse into.
fn nesting(src: &str) -> usize {
    let (mut depth, mut max, mut ticks) = (0usize, 0usize, false);
    let mut word = String::new();
    let flush = |word: &mut String, depth: &mut usize, max: &mut usize| {
        match word.as_str() {
            "if" | "for" | "while" | "until" | "case" | "select" | "then" | "do" | "elif" => {
                *depth += 1;
                *max = (*max).max(*depth);
            }
            "fi" | "done" | "esac" => *depth = depth.saturating_sub(1),
            _ => {}
        }
        word.clear();
    };
    for c in src.chars() {
        if c.is_ascii_alphabetic() {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut depth, &mut max);
        match c {
            '(' | '{' => {
                depth += 1;
                max = max.max(depth);
            }
            ')' | '}' => depth = depth.saturating_sub(1),
            '`' => {
                ticks = !ticks;
                if ticks {
                    depth += 1;
                    max = max.max(depth);
                } else {
                    depth = depth.saturating_sub(1);
                }
            }
            _ => {}
        }
    }
    flush(&mut word, &mut depth, &mut max);
    max
}

/// Whether a function body runs `name` in a pipeline with itself: `f() { f | f & }`.
fn pipes_itself(list: &CompoundList, name: &str) -> bool {
    list.0.iter().any(|item| {
        let l = &item.0;
        let mut pipelines = vec![&l.first];
        for a in &l.additional {
            pipelines.push(match a {
                AndOr::And(p) | AndOr::Or(p) => p,
            });
        }
        pipelines.iter().any(|p| {
            let calls = p.seq.iter().filter(|c| matches!(c, Command::Simple(sc) if sc.word_or_name.as_ref().is_some_and(|w| w.value == name))).count();
            calls >= 2
        })
    })
}

/// The longest run of `c` in `src`.
fn longest_run(src: &str, c: char) -> usize {
    let (mut run, mut best) = (0usize, 0usize);
    for x in src.chars() {
        if x == c {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

impl<'c> Walker<'c> {
    pub fn new(ctx: &'c Context) -> Walker<'c> {
        Walker { ctx, lay: Lay::new(ctx), found: Vec::new(), funcs: HashSet::new(), wrote: HashMap::new(), impure: false, cmd_secret: None, bytes: 0, commands: COMMANDS, over: false }
    }

    pub fn note(&mut self, risk: Risk, kind: Kind, reason: impl Into<String>) {
        self.found.push(Finding { risk, kind, reason: clause(reason) });
    }

    pub fn ask(&mut self, kind: Kind, reason: impl Into<String>) {
        self.note(Risk::Ask, kind, reason);
    }

    pub fn deny(&mut self, kind: Kind, reason: impl Into<String>) {
        self.note(Risk::Deny, kind, reason);
    }

    /// Something that cannot be read, so cannot be told safe.
    pub fn unread(&mut self, what: &str) {
        self.ask(Kind::Unparsed, format!("cannot read {what}"));
    }

    fn tick(&mut self) -> bool {
        self.commands -= 1;
        if self.commands < 0 {
            if !self.over {
                self.over = true;
                self.ask(Kind::Unparsed, "too many commands to read");
            }
            return false;
        }
        true
    }

    /// Reads `src` as a bash script and walks it in `st`.
    pub fn script(&mut self, src: &str, st: &mut State) -> Out {
        if st.depth > DEPTH {
            self.ask(Kind::Unparsed, "scripts nest too deep to read");
            return Out::default();
        }
        self.bytes += src.len();
        if self.bytes > BYTES {
            if !self.over {
                self.over = true;
                self.ask(Kind::Unparsed, "too much script to read");
            }
            return Out::default();
        }
        if nesting(src) > NEST {
            self.ask(Kind::Unparsed, "brackets nest too deep to read");
            return Out::default();
        }
        if longest_run(src, '\\') > 256 {
            // The tokenizer takes quadratic time over a long run of escapes.
            self.ask(Kind::Unparsed, "a run of backslashes too long to read");
            return Out::default();
        }
        let program = match parse(src) {
            Ok(p) => p,
            Err(brush_parser::ParseError::Tokenizing { inner: brush_parser::TokenizerError::UnterminatedHereDocuments(tags, _), .. }) => {
                // The shell runs a here-document to the end of its input, with a warning.
                let mut closed = src.to_string();
                for tag in tags.split(',') {
                    let t = tag.trim().trim_matches(|c| c == '\'' || c == '"' || c == '[' || c == ']');
                    closed.push('\n');
                    closed.push_str(t);
                }
                closed.push('\n');
                match parse(&closed) {
                    Ok(p) => p,
                    Err(_) => return self.salvage(src, st),
                }
            }
            Err(_) => return self.salvage(src, st),
        };
        let single = program.complete_commands.len() == 1 && program.complete_commands[0].0.len() == 1;
        let mut last = Out::default();
        for cc in &program.complete_commands {
            let o = self.list(cc, st);
            if single {
                last = o;
            }
        }
        if single {
            last
        } else {
            Out::default()
        }
    }

    /// A script that does not parse may still have run its first lines: read the longest
    /// prefix that does, then say the rest could not be read.
    fn salvage(&mut self, src: &str, st: &mut State) -> Out {
        let mut cuts: Vec<usize> = src.match_indices('\n').map(|(i, _)| i).collect();
        cuts.reverse();
        for cut in cuts.into_iter().take(40) {
            if cut == 0 {
                continue;
            }
            if let Ok(p) = parse(&src[..cut]) {
                for cc in &p.complete_commands {
                    self.list(cc, st);
                }
                break;
            }
        }
        self.unread("a command line that does not parse as shell");
        Out::default()
    }

    /// A command substitution, a process substitution, a subshell: a script in a copy of the state.
    pub fn sub(&mut self, src: &str, st: &State) -> Out {
        let mut s = st.clone();
        s.depth += 1;
        self.script(src, &mut s)
    }

    fn sublist(&mut self, list: &CompoundList, st: &State) -> Out {
        let mut s = st.clone();
        s.depth += 1;
        if s.depth > DEPTH {
            self.ask(Kind::Unparsed, "scripts nest too deep to read");
            return Out::default();
        }
        self.list(list, &mut s)
    }

    pub fn list(&mut self, list: &CompoundList, st: &mut State) -> Out {
        let mut last = Out::default();
        for item in &list.0 {
            if self.over {
                break;
            }
            let background = matches!(item.1, SeparatorOperator::Async);
            if background {
                let mut s = st.clone();
                last = self.andor(&item.0, &mut s);
                // `$!` is a job this script started: signalling it is not signalling a stranger.
                st.set("!", vec![Val::lit("%bg")]);
            } else {
                last = self.andor(&item.0, st);
            }
        }
        last
    }

    fn andor(&mut self, l: &ast::AndOrList, st: &mut State) -> Out {
        let mut out = self.pipeline(&l.first, st);
        for next in &l.additional {
            let (p, or) = match next {
                AndOr::And(p) => (p, false),
                AndOr::Or(p) => (p, true),
            };
            let before = st.clone();
            let mut after = st.clone();
            out = self.pipeline(p, &mut after);
            // `a || exit` runs the rest only if `a` did not fail: the state is `a`'s.
            if or && diverges(p) {
                continue;
            }
            *st = before;
            st.join(&after);
        }
        out
    }

    fn pipeline(&mut self, p: &ast::Pipeline, st: &mut State) -> Out {
        if p.seq.len() == 1 {
            return self.command(&p.seq[0], st, Stdin::Inherit);
        }
        let mut prev = Out::default();
        for (i, c) in p.seq.iter().enumerate() {
            let mut s = st.clone();
            let stdin = if i == 0 { Stdin::Inherit } else { Stdin::Pipe { literal: prev.literal.clone(), net: prev.net } };
            prev = self.command(c, &mut s, stdin);
        }
        prev
    }

    fn command(&mut self, c: &Command, st: &mut State, stdin: Stdin) -> Out {
        match c {
            Command::Simple(sc) => self.simple(sc, st, stdin),
            Command::Compound(cc, redirs) => {
                if let Some(rl) = redirs {
                    for r in &rl.0 {
                        self.redir(r, st);
                    }
                }
                self.compound(cc, st);
                Out::default()
            }
            Command::Function(def) => {
                for name in self.scalar(&def.fname, st) {
                    if let Some(n) = name.exact() {
                        if let CompoundCommand::BraceGroup(b) = &def.body.0 {
                            if pipes_itself(&b.list, n) {
                                self.deny(Kind::Destructive, format!("a function that pipes itself into itself, a fork bomb: {n}"));
                            }
                        }
                        self.funcs.insert(n.to_string());
                    }
                }
                if let Some(rl) = &def.body.1 {
                    for r in &rl.0 {
                        self.redir(r, st);
                    }
                }
                let mut s = st.clone();
                s.depth += 1;
                self.compound(&def.body.0, &mut s);
                Out::default()
            }
            Command::ExtendedTest(t, redirs) => {
                self.test_expr(&t.expr, st);
                if let Some(rl) = redirs {
                    for r in &rl.0 {
                        self.redir(r, st);
                    }
                }
                Out::default()
            }
        }
    }

    fn test_expr(&mut self, e: &ast::ExtendedTestExpr, st: &State) {
        use ast::ExtendedTestExpr as T;
        match e {
            T::And(a, b) | T::Or(a, b) => {
                self.test_expr(a, st);
                self.test_expr(b, st);
            }
            T::Not(a) | T::Parenthesized(a) => self.test_expr(a, st),
            T::UnaryTest(_, w) => {
                self.fields(w, st);
            }
            T::BinaryTest(_, a, b) => {
                self.fields(a, st);
                self.fields(b, st);
            }
        }
    }

    fn compound(&mut self, cc: &CompoundCommand, st: &mut State) {
        match cc {
            CompoundCommand::Arithmetic(a) => self.arith(&a.expr.value, st),
            CompoundCommand::ArithmeticForClause(f) => {
                for e in [&f.initializer, &f.condition, &f.updater].into_iter().flatten() {
                    self.arith(&e.value, st);
                }
                self.looped(&f.body.list, st, None);
            }
            CompoundCommand::BraceGroup(b) => {
                self.list(&b.list, st);
            }
            CompoundCommand::Subshell(s) => {
                self.sublist(&s.list, st);
            }
            CompoundCommand::ForClause(f) => {
                let mut vals: Vec<Val> = Vec::new();
                let mut open = false;
                match &f.values {
                    None => open = true,
                    Some(ws) => {
                        for w in ws {
                            let lists = self.fields(w, st);
                            for l in lists {
                                for v in l {
                                    if v.has_unknown() && v.is_unknown() {
                                        open = true;
                                    }
                                    vals.push(globbed(&v));
                                }
                            }
                        }
                    }
                }
                let var = if open || vals.len() > ALTS { None } else { Some((f.variable_name.clone(), vals)) };
                self.looped(&f.body.list, st, var);
            }
            CompoundCommand::CaseClause(c) => {
                self.scalar(&c.value, st);
                let before = st.clone();
                let mut ends: Vec<State> = Vec::new();
                for item in &c.cases {
                    for p in &item.patterns {
                        self.fields(p, st);
                    }
                    if let Some(body) = &item.cmd {
                        let mut s = before.clone();
                        self.list(body, &mut s);
                        ends.push(s);
                    }
                }
                *st = before;
                for e in &ends {
                    st.join(e);
                }
            }
            CompoundCommand::IfClause(i) => {
                self.list(&i.condition, st);
                let before = st.clone();
                let mut ends: Vec<State> = Vec::new();
                let mut s = before.clone();
                self.list(&i.then, &mut s);
                ends.push(s);
                let mut chained = before.clone();
                let mut has_else = false;
                if let Some(elses) = &i.elses {
                    for e in elses {
                        if let Some(cond) = &e.condition {
                            self.list(cond, &mut chained);
                        } else {
                            has_else = true;
                        }
                        let mut s = chained.clone();
                        self.list(&e.body, &mut s);
                        ends.push(s);
                    }
                }
                if !has_else {
                    ends.push(chained);
                }
                *st = ends.remove(0);
                for e in &ends {
                    st.join(e);
                }
            }
            CompoundCommand::WhileClause(w) | CompoundCommand::UntilClause(w) => {
                // The condition runs before every pass, so it is read with what the body leaves.
                self.list(&w.0, st);
                let both = ast::CompoundList(w.1.list.0.clone());
                self.looped(&both, st, None);
                self.list(&w.0, st);
            }
            CompoundCommand::Coprocess(c) => {
                let mut s = st.clone();
                self.command(&c.body, &mut s, Stdin::Inherit);
            }
        }
    }

    /// A loop body, read twice: the second time with what the first left.
    fn looped(&mut self, body: &CompoundList, st: &mut State, var: Option<(String, Vec<Val>)>) {
        let entry = st.clone();
        let mut first = entry.clone();
        if let Some((n, vals)) = &var {
            first.set(n, vals.clone());
        }
        self.list(body, &mut first);
        let mut second = entry.clone();
        second.join(&first);
        if let Some((n, vals)) = &var {
            second.set(n, vals.clone());
        }
        self.list(body, &mut second);
        *st = entry;
        st.join(&second);
    }

    /// An arithmetic expression: substitutions in it run, and what it assigns is unknown.
    fn arith(&mut self, expr: &str, st: &mut State) {
        self.scan_subst(expr, st);
        let b: Vec<char> = expr.chars().collect();
        let mut i = 0;
        while i < b.len() {
            if b[i].is_alphabetic() || b[i] == '_' {
                let start = i;
                while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_') {
                    i += 1;
                }
                let name: String = b[start..i].iter().collect();
                let rest: String = b[i..].iter().take(3).collect();
                let rest = rest.trim_start();
                if rest.starts_with('=') && !rest.starts_with("==") || rest.starts_with("+=") || rest.starts_with("-=") || rest.starts_with("++") || rest.starts_with("--") || rest.starts_with("*=") || rest.starts_with("/=") {
                    st.forget(&name);
                }
                // `++x`, `--x`
                if start >= 2 && matches!((b[start - 2], b[start - 1]), ('+', '+') | ('-', '-')) {
                    st.forget(&name);
                }
            } else {
                i += 1;
            }
        }
    }

    fn simple(&mut self, sc: &ast::SimpleCommand, st: &mut State, stdin: Stdin) -> Out {
        if !self.tick() {
            return Out::default();
        }
        self.cmd_secret = None;
        let mut io = Io { stdin, ..Io::default() };
        let mut assigns: Vec<(String, Vec<Val>, bool)> = Vec::new();
        let mut redirs: Vec<&IoRedirect> = Vec::new();
        enum Arg<'a> {
            W(&'a ast::Word),
            P(&'a ast::SubshellCommand),
        }
        let mut args: Vec<Arg> = Vec::new();
        if let Some(prefix) = &sc.prefix {
            for item in &prefix.0 {
                match item {
                    CommandPrefixOrSuffixItem::IoRedirect(r) => redirs.push(r),
                    CommandPrefixOrSuffixItem::AssignmentWord(a, _) => {
                        let vals = self.assignment(a, st);
                        assigns.push((a.name.to_string(), vals, a.append));
                    }
                    CommandPrefixOrSuffixItem::Word(w) => args.push(Arg::W(w)),
                    CommandPrefixOrSuffixItem::ProcessSubstitution(_, sub) => args.push(Arg::P(sub)),
                }
            }
        }
        let head = sc.word_or_name.as_ref();
        if let Some(h) = head {
            args.insert(0, Arg::W(h));
        }
        if let Some(suffix) = &sc.suffix {
            for item in &suffix.0 {
                match item {
                    CommandPrefixOrSuffixItem::IoRedirect(r) => redirs.push(r),
                    CommandPrefixOrSuffixItem::AssignmentWord(_, w) | CommandPrefixOrSuffixItem::Word(w) => args.push(Arg::W(w)),
                    CommandPrefixOrSuffixItem::ProcessSubstitution(_, sub) => args.push(Arg::P(sub)),
                }
            }
        }
        // Arrays and every value assigned are read for the commands inside them.
        for r in redirs {
            let part = self.redir(r, st);
            if let Some(s) = part.stdin {
                io.stdin = s;
            }
            if part.out_file {
                io.out_file = true;
            }
            io.out_to.extend(part.out_to);
        }
        // The words, as the lists of words they may become.
        let mut lists: Vec<Vec<Val>> = vec![Vec::new()];
        for a in &args {
            let opts: Vec<Vec<Val>> = match a {
                Arg::W(w) => self.fields(w, st),
                Arg::P(sub) => {
                    self.sublist(&sub.list, st);
                    vec![vec![Val::lit("/dev/fd/63")]]
                }
            };
            let mut next = Vec::new();
            for base in &lists {
                for o in &opts {
                    let mut l = base.clone();
                    l.extend(o.iter().cloned());
                    next.push(l);
                }
            }
            if next.len() > ALTS {
                next.truncate(ALTS);
            }
            lists = next;
        }
        if head.is_none() {
            // Only assignments: they stand in the shell that ran them.
            for (n, vals, append) in assigns {
                self.assign(st, &n, vals, append);
            }
            return Out::default();
        }
        let mut out = Out::default();
        for (i, words) in lists.into_iter().enumerate() {
            if words.is_empty() {
                continue;
            }
            let o = if i == 0 {
                self.run(words, &assigns, &io, st)
            } else {
                let mut s = st.clone();
                self.run(words, &assigns, &io, &mut s)
            };
            if i == 0 {
                out = o;
            }
        }
        out
    }

    /// The values an assignment gives its name, with the commands in them run.
    fn assignment(&mut self, a: &ast::Assignment, st: &State) -> Vec<Val> {
        if let ast::AssignmentName::ArrayElementName(_, idx) = &a.name {
            self.scan_subst(idx, st);
        }
        match &a.value {
            ast::AssignmentValue::Scalar(w) => self.scalar(w, st),
            ast::AssignmentValue::Array(items) => {
                for (k, v) in items {
                    if let Some(k) = k {
                        self.scalar(k, st);
                    }
                    self.scalar(v, st);
                }
                vec![Val::unknown()]
            }
        }
    }

    /// Records `name=vals` in the shell, and what it changes beyond that.
    pub fn assign(&mut self, st: &mut State, name: &str, vals: Vec<Val>, append: bool) {
        let name = name.split('[').next().unwrap_or(name);
        crate::rules::env_name(self, name, &vals);
        if append {
            let prev = match st.env.get(name) {
                Some(Var::Known(v)) => Some(v.clone()),
                None if name == "HOME" => self.ctx.home.clone().map(|h| vec![Val::lit(h)]),
                None => None,
                _ => None,
            };
            match prev {
                Some(p) => {
                    let mut out = Vec::new();
                    for a in &p {
                        for b in &vals {
                            out.push(Val { s: format!("{}{}", a.s, b.s), glob: false, split: false });
                        }
                    }
                    st.set(name, out);
                }
                None => st.forget(name),
            }
            return;
        }
        st.set(name, vals.into_iter().map(|v| Val { glob: false, ..v }).collect());
    }

    /// Reads one redirection: what it writes and reads, and what it makes standard input.
    pub fn redir(&mut self, r: &IoRedirect, st: &State) -> Redirected {
        let mut out = Redirected::default();
        match r {
            IoRedirect::File(fd, kind, target) => match target {
                IoFileRedirectTarget::Filename(w) => {
                    let vals = self.scalar(w, st);
                    for v in vals {
                        self.file_redirect(*fd, kind, v, st, &mut out);
                    }
                }
                IoFileRedirectTarget::Fd(_) => {}
                IoFileRedirectTarget::ProcessSubstitution(_, sub) => {
                    self.sublist(&sub.list, st);
                }
                IoFileRedirectTarget::Duplicate(w) => {
                    let vals = self.scalar(w, st);
                    for v in vals {
                        let t = v.s.trim();
                        let numeric = t == "-" || (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '-'));
                        if !numeric && matches!(kind, IoFileRedirectKind::DuplicateOutput) {
                            // `>&file` writes the file.
                            self.file_redirect(*fd, &IoFileRedirectKind::Write, v, st, &mut out);
                        }
                    }
                }
            },
            IoRedirect::HereDocument(_, hd) => {
                let text = self.heredoc(hd, st);
                out.stdin = Some(Stdin::Text(text));
            }
            IoRedirect::HereString(_, w) => {
                let vals = self.scalar(w, st);
                let v = vals.into_iter().next().unwrap_or_else(Val::unknown);
                out.stdin = Some(Stdin::Text(Val { s: format!("{}\n", v.s), glob: false, split: false }));
            }
            IoRedirect::OutputAndError(w, _) => {
                let vals = self.scalar(w, st);
                for v in vals {
                    self.file_redirect(None, &IoFileRedirectKind::Write, v, st, &mut out);
                }
            }
        }
        out
    }

    fn file_redirect(&mut self, fd: Option<i32>, kind: &IoFileRedirectKind, v: Val, st: &State, out: &mut Redirected) {
        match kind {
            IoFileRedirectKind::Read => {
                self.read_path(&v, st, "a redirect from");
                out.stdin = Some(Stdin::File(v));
            }
            IoFileRedirectKind::Write | IoFileRedirectKind::Append | IoFileRedirectKind::Clobber | IoFileRedirectKind::ReadAndWrite => {
                self.write_path(&v, st, "redirects output to");
                if matches!(kind, IoFileRedirectKind::ReadAndWrite) {
                    self.read_path(&v, st, "a redirect from");
                    out.stdin = Some(Stdin::File(v.clone()));
                }
                if fd.is_none() || fd == Some(1) {
                    out.out_file = true;
                    out.out_to.push(v);
                }
            }
            IoFileRedirectKind::DuplicateInput | IoFileRedirectKind::DuplicateOutput => {}
        }
    }

    /// The text of a here-document, with the commands in it run when the shell would.
    fn heredoc(&mut self, hd: &ast::IoHereDocument, st: &State) -> Val {
        let raw = hd.doc.value.as_str();
        if !hd.requires_expansion {
            return Val::lit(crate::val::plain(raw));
        }
        match brush_parser::word::parse_heredoc(raw, &expand::options()) {
            Ok(ps) => {
                use brush_parser::word::WordPiece as W;
                let mut s = String::new();
                for p in &ps {
                    match &p.piece {
                        W::Text(t) | W::SingleQuotedText(t) | W::AnsiCQuotedText(t) => s.push_str(&crate::val::plain(t)),
                        W::EscapeSequence(e) => s.push_str(&crate::val::plain(e.strip_prefix('\\').unwrap_or(e))),
                        other => {
                            let alts = self.piece(other, true, st);
                            let v = alts.first().map(expand::scalar_of).unwrap_or_else(Val::unknown);
                            s.push_str(&v.s);
                        }
                    }
                }
                Val { s, glob: false, split: false }
            }
            Err(_) => {
                self.scan_subst(raw, st);
                Val::unknown()
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Redirected {
    pub stdin: Option<Stdin>,
    pub out_file: bool,
    pub out_to: Vec<Val>,
}

/// Whether the commands of `p` end the script or the loop, so what follows a `||` runs only
/// when the left side succeeded.
fn diverges(p: &ast::Pipeline) -> bool {
    fn word_is_exit(c: &Command) -> bool {
        match c {
            Command::Simple(sc) => sc.word_or_name.as_ref().is_some_and(|w| matches!(w.value.as_str(), "exit" | "return" | "continue" | "break" | "false" | "abort")),
            Command::Compound(CompoundCommand::BraceGroup(b), _) => b.list.0.iter().any(|i| i.0.first.seq.iter().any(word_is_exit)),
            _ => false,
        }
    }
    p.seq.iter().any(word_is_exit)
}

/// A word with a glob in it as the names it may match: the component with the glob unknown.
fn globbed(v: &Val) -> Val {
    if !v.glob {
        return v.clone();
    }
    let parts: Vec<String> = v
        .s
        .split('/')
        .map(|c| if c.contains(['*', '?', '[']) { UNK.to_string() } else { c.to_string() })
        .collect();
    Val { s: parts.join("/"), glob: false, split: false }
}
