//! Commands that run another command (`env`, `timeout`, `nice`, `xargs`, `watch`): the
//! inner command is read as though it stood alone, and the wrapper is read for what it adds.

use super::getopt;
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Walker};

/// Programs that become another user or leave the process's world: never run from here.
const PRIVILEGE: &[&str] = &["sudo", "sudoedit", "doas", "pkexec", "su", "run0", "gosu", "su-exec", "runuser", "runas", "setpriv", "chroot", "unshare", "nsenter", "newgrp", "sg", "capsh"];

/// Splits `text` into words as a shell does: blanks separate, quotes and backslashes group.
pub(crate) fn split_words(text: &str) -> Vec<Val> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut have = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                have = true;
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                    cur.push(q);
                }
            }
            '"' => {
                have = true;
                while let Some(q) = chars.next() {
                    if q == '"' {
                        break;
                    }
                    if q == '\\' {
                        if let Some(n) = chars.peek() {
                            if matches!(n, '"' | '\\' | '$' | '`') {
                                cur.push(*n);
                                chars.next();
                                continue;
                            }
                        }
                    }
                    cur.push(q);
                }
            }
            '\\' => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    have = true;
                }
            }
            ' ' | '\t' | '\n' => {
                if have {
                    out.push(Val::lit(std::mem::take(&mut cur)));
                    have = false;
                }
            }
            c => {
                cur.push(c);
                have = true;
            }
        }
    }
    if have {
        out.push(Val::lit(cur));
    }
    out
}

/// The index of the first word that is not an option of a wrapper, whose value-taking short
/// options are `with_val` and long ones `long_val`.
pub(crate) fn skip_opts(args: &[Val], with_val: &str, long_val: &[&str]) -> usize {
    let mut i = 0;
    while i < args.len() {
        let Some(t) = args[i].exact() else { return i };
        if t == "--" {
            return i + 1;
        }
        if let Some(long) = t.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or(long);
            i += if !long.contains('=') && long_val.contains(&name) { 2 } else { 1 };
        } else if t.len() > 1 && t.starts_with('-') {
            let cs: Vec<char> = t[1..].chars().collect();
            let mut takes = false;
            for (k, c) in cs.iter().enumerate() {
                if with_val.contains(*c) {
                    takes = k + 1 == cs.len();
                    break;
                }
            }
            i += 1 + usize::from(takes);
        } else {
            return i;
        }
    }
    args.len()
}

impl Walker<'_> {
    pub(crate) fn wrapper(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if PRIVILEGE.contains(&name) {
            self.deny(Kind::Privilege, format!("privilege escalation: {name}"));
            return Some(Out::default());
        }
        let inner: Option<usize> = match name {
            "env" => {
                self.env_cmd(args, io, st);
                return Some(Out::default());
            }
            "timeout" => {
                let i = skip_opts(args, "sk", &["signal", "kill-after"]);
                Some(i + 1)
            }
            "nice" => Some(skip_opts(args, "n", &["adjustment"])),
            "ionice" => {
                let o = getopt(args, "cnpPu", &["class", "classdata", "pid", "pgid", "uid"]);
                if o.has('p') || o.has('P') || o.has('u') {
                    return Some(Out::default());
                }
                Some(skip_opts(args, "cnpPu", &["class", "classdata"]))
            }
            "nohup" | "unbuffer" | "setsid" | "eatmydata" | "fakeroot" | "rlwrap" | "winpty" | "ts" => Some(skip_opts(args, "", &[])),
            "stdbuf" => Some(skip_opts(args, "ioe", &["input", "output", "error"])),
            "command" => {
                let o = getopt(args, "", &[]);
                if o.has('v') || o.has('V') {
                    return Some(Out::default());
                }
                Some(skip_opts(args, "", &[]))
            }
            "builtin" => Some(0),
            "caffeinate" => Some(skip_opts(args, "tw", &[])),
            "taskset" => {
                let o = getopt(args, "c", &["cpu-list"]);
                if o.has('p') || o.long("pid") {
                    return Some(Out::default());
                }
                let i = skip_opts(args, "c", &["cpu-list"]);
                Some(if o.has('c') || o.long("cpu-list") { i } else { i + 1 })
            }
            "numactl" => Some(skip_opts(args, "CmNiplP", &["cpunodebind", "membind", "physcpubind", "interleave", "preferred", "cpubind"])),
            "chrt" => {
                let o = getopt(args, "", &[]);
                if o.has('p') {
                    return Some(Out::default());
                }
                Some(skip_opts(args, "", &[]) + 1)
            }
            "cpulimit" => Some(skip_opts(args, "lpePi", &["limit", "pid", "exe"])),
            "time" => {
                let i = skip_opts(args, "fo", &["format", "output"]);
                if let Some(o) = args.windows(2).find(|w| w[0].is("-o") || w[0].is("--output")) {
                    let f = o[1].clone();
                    self.write_path(&f, st, "writes timing to");
                }
                Some(i)
            }
            "flock" => {
                let i = skip_opts(args, "wE", &["timeout", "conflict-exit-code"]);
                if let Some(lock) = args.get(i) {
                    let lock = lock.clone();
                    if !lock.s.chars().all(|c| c.is_ascii_digit()) {
                        self.write_path(&lock, st, "locks");
                    }
                    let rest = &args[(i + 1).min(args.len())..];
                    if rest.first().is_some_and(|a| a.is("-c") || a.is("--command")) {
                        if let Some(cmd) = rest.get(1) {
                            self.nested_string(cmd, st, "flock -c");
                        }
                        return Some(Out::default());
                    }
                    let inner = rest.to_vec();
                    if !inner.is_empty() {
                        return Some(self.run(inner, &[], io, st));
                    }
                }
                return Some(Out::default());
            }
            "watch" => {
                let i = skip_opts(args, "ndw", &["interval", "differences"]);
                let rest = &args[i.min(args.len())..];
                if rest.is_empty() {
                    return Some(Out::default());
                }
                let exec_form = getopt(args, "ndw", &["interval"]).has('x');
                if exec_form {
                    return Some(self.run(rest.to_vec(), &[], io, st));
                }
                let text = rest.iter().map(|a| a.s.as_str()).collect::<Vec<_>>().join(" ");
                let mut s = st.clone();
                s.depth += 1;
                self.script(&text, &mut s);
                return Some(Out::default());
            }
            "xargs" => {
                self.xargs(args, io, st);
                return Some(Out::default());
            }
            "parallel" => {
                self.parallel(args, io, st);
                return Some(Out::default());
            }
            "strace" | "ltrace" | "gdb" | "lldb" | "rr" | "perf" | "valgrind" | "ptrace" | "dtruss" | "truss" => {
                let o = getopt(args, "", &[]);
                if o.has('p') || o.long("pid") || o.long("attach") || name == "gdb" || name == "lldb" {
                    self.ask(Kind::Privilege, format!("{name} attaches to or debugs another process"));
                    return Some(Out::default());
                }
                let skip = if name == "perf" || name == "rr" { 1 } else { 0 };
                let i = skip_opts(args.get(skip..).unwrap_or(&[]), "oeEpPsuSAIOb", &["output", "log-file"]) + skip;
                Some(i)
            }
            "script" => {
                let o = getopt(args, "cTtIOBm", &["command", "log-out", "log-in", "log-io", "timing"]);
                if let Some(c) = o.val("c").or_else(|| o.val("command")) {
                    let c = c.clone();
                    self.nested_string(&c, st, "script -c");
                }
                for f in o.all_ops() {
                    let f = f.clone();
                    self.write_path(&f, st, "records a session to");
                }
                return Some(Out::default());
            }
            _ => None,
        };
        let i = inner?;
        let rest = args.get(i..).unwrap_or(&[]);
        if rest.is_empty() {
            return Some(Out::default());
        }
        Some(self.run(rest.to_vec(), &[], io, st))
    }

    /// A string another program runs as a shell command.
    pub(crate) fn nested_string(&mut self, v: &Val, st: &State, how: &str) {
        if v.is_unknown() {
            self.ask(Kind::Code, format!("{how} runs a string it cannot read"));
            return;
        }
        let mut s = st.clone();
        s.depth += 1;
        self.script(&v.s, &mut s);
    }

    fn env_cmd(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let mut i = 0;
        let mut split: Option<Val> = None;
        let mut chdir: Option<Val> = None;
        let mut sets = false;
        while i < args.len() {
            let a = &args[i];
            let t = a.s.as_str();
            if let Some(eq) = t.find('=') {
                let n = &t[..eq];
                if !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    super::env_name(self, n, &[Val::lit(&t[eq + 1..])]);
                    sets = true;
                    i += 1;
                    continue;
                }
            }
            if a.has_unknown() {
                break;
            }
            if t == "--" {
                i += 1;
                break;
            }
            if let Some(long) = t.strip_prefix("--") {
                let (n, inline) = match long.find('=') {
                    Some(k) => (&long[..k], Some(&long[k + 1..])),
                    None => (long, None),
                };
                match n {
                    "split-string" => {
                        split = inline.map(Val::lit).or_else(|| args.get(i + 1).cloned());
                        i += if inline.is_some() { 1 } else { 2 };
                    }
                    "chdir" => {
                        chdir = inline.map(Val::lit).or_else(|| args.get(i + 1).cloned());
                        i += if inline.is_some() { 1 } else { 2 };
                    }
                    "unset" => i += if inline.is_some() { 1 } else { 2 },
                    _ => i += 1,
                }
                continue;
            }
            if t.len() > 1 && t.starts_with('-') {
                let cs: Vec<char> = t[1..].chars().collect();
                let mut k = 0;
                let mut extra = 0;
                while k < cs.len() {
                    match cs[k] {
                        'S' | 'C' | 'u' | 'P' => {
                            let rest: String = cs[k + 1..].iter().collect();
                            let v = if rest.is_empty() {
                                extra = 1;
                                args.get(i + 1).cloned()
                            } else {
                                Some(Val::lit(rest))
                            };
                            match cs[k] {
                                'S' => split = v,
                                'C' => chdir = v,
                                _ => {}
                            }
                            break;
                        }
                        _ => k += 1,
                    }
                }
                i += 1 + extra;
                continue;
            }
            break;
        }
        let mut inner: Vec<Val> = Vec::new();
        if let Some(s) = split {
            inner.extend(split_words(&s.s));
        }
        inner.extend(args[i.min(args.len())..].iter().cloned());
        // `env A=b cmd`: assignments among the first words of the split string, too.
        let mut skip = 0;
        for w in &inner {
            let t = w.s.as_str();
            match t.find('=').map(|e| (t, e)) {
                Some((t, e)) if !t[..e].is_empty() && t[..e].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                    super::env_name(self, &t[..e], &[Val::lit(&t[e + 1..])]);
                    skip += 1;
                }
                _ => break,
            }
        }
        let inner: Vec<Val> = inner.into_iter().skip(skip).collect();
        if inner.is_empty() {
            let _ = sets;
            self.ask(Kind::Credential, "env with no command prints the environment, which may hold secrets");
            return;
        }
        match chdir {
            Some(d) => {
                let mut s = st.clone();
                match d.exact() {
                    Some(t) => {
                        s.cwd = match (&s.cwd, t.starts_with('/')) {
                            (_, true) => Some(crate::path::normalize(t)),
                            (Some(c), false) => Some(crate::path::normalize(&format!("{c}/{t}"))),
                            _ => None,
                        }
                    }
                    None => s.cwd = None,
                }
                self.run(inner, &[], io, &mut s);
            }
            None => {
                self.run(inner, &[], io, st);
            }
        }
    }

    fn xargs(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let i = skip_opts(args, "aEIdLnPsl", &["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars"]);
        let o = getopt(&args[..i.min(args.len())], "aEIdLnPsl", &["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars"]);
        if let Some(f) = o.val("a").or_else(|| o.val("arg-file")) {
            let f = f.clone();
            self.read_path(&f, st, "reads");
        }
        let mut inner: Vec<Val> = args.get(i..).unwrap_or(&[]).to_vec();
        if inner.is_empty() {
            inner.push(Val::lit("echo"));
        }
        // What the command is given on standard input is unknown.
        inner.push(Val::unknown());
        self.run(inner, &[], io, st);
    }

    fn parallel(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let i = skip_opts(args, "jnNaSJlLdmMsTt", &["jobs", "max-args", "arg-file", "sshlogin", "colsep", "delimiter"]);
        let rest = args.get(i..).unwrap_or(&[]);
        let end = rest.iter().position(|a| a.starts(":::")).unwrap_or(rest.len());
        let mut inner: Vec<Val> = rest[..end].to_vec();
        if inner.is_empty() {
            self.ask(Kind::Code, "parallel reads the commands to run from its input");
            return;
        }
        inner.push(Val::unknown());
        self.run(inner, &[], io, st);
    }
}

