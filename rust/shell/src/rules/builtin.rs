//! The shell's own commands: the ones that move the working directory, set variables, read
//! files into the shell and run a string as a script.

use super::{getopt, Opts};
use crate::expand::ansi_c;
use crate::path::normalize;
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Walker};

/// Commands that read, write and run nothing a path can name.
const INERT: &[&str] = &[
    "true", "false", ":", "exit", "return", "break", "continue", "shift", "wait", "jobs", "fg", "bg", "disown", "umask", "ulimit", "type", "hash", "help", "times", "logout", "suspend", "let", "history", "bind", "complete", "compgen", "compopt", "caller", "dirs", "shopt", "sleep", "unalias",
    "which", "whereis", "whence", "where",
];

fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_alphabetic() || c == '_') && cs.all(|c| c.is_alphanumeric() || c == '_')
}

/// The variable names that hold a secret, by the words in them.
pub(crate) fn secretive(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.split('_').any(|w| matches!(w, "KEY" | "TOKEN" | "SECRET" | "PASSWORD" | "PASSWD" | "CREDENTIAL" | "CREDENTIALS" | "CREDS" | "APIKEY" | "BEARER" | "COOKIE" | "PASSPHRASE" | "PRIVKEY"))
        && !matches!(upper.as_str(), "SSH_AUTH_SOCK" | "KEYMAP" | "GPG_TTY" | "XDG_SESSION_TOKEN")
}

impl Walker<'_> {
    pub(crate) fn builtin(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if INERT.contains(&name) {
            return Some(Out::default());
        }
        match name {
            "echo" => Some(self.echo(args, io, st)),
            "printf" => Some(self.printf(args, io, st)),
            "pwd" => {
                let lit = st.cwd.clone().filter(|c| !c.starts_with("/\u{1}"));
                Some(Out { literal: lit.map(|c| format!("{c}\n")), net: false })
            }
            "cd" | "pushd" | "chdir" => {
                self.cd(args, st);
                Some(Out::default())
            }
            "popd" => {
                st.cwd = None;
                Some(Out::default())
            }
            "test" | "[" => Some(Out::default()),
            "export" | "declare" | "typeset" | "readonly" | "local" => {
                self.declare(name, args, st);
                Some(Out::default())
            }
            "unset" => {
                let o = getopt(args, "", &[]);
                if !o.has('f') {
                    for v in o.all_ops() {
                        if let Some(n) = v.exact() {
                            st.forget(n);
                        }
                    }
                }
                Some(Out::default())
            }
            "set" => {
                if args.is_empty() {
                    self.ask(Kind::Credential, "set with no arguments prints every variable, which may hold secrets");
                }
                Some(Out::default())
            }
            "read" => {
                let o = getopt(args, "pnNtudaI", &[]);
                let mut any = false;
                for v in o.all_ops() {
                    if let Some(n) = v.exact() {
                        st.forget(n);
                        any = true;
                    }
                }
                if let Some(a) = o.val("a") {
                    if let Some(n) = a.exact() {
                        st.forget(n);
                    }
                }
                if !any {
                    st.forget("REPLY");
                }
                Some(Out::default())
            }
            "getopts" => {
                if let Some(n) = args.get(1).and_then(|v| v.exact()) {
                    st.forget(n);
                }
                st.forget("OPTARG");
                st.forget("OPTIND");
                Some(Out::default())
            }
            "mapfile" | "readarray" => {
                let o = getopt(args, "dnOsuCc", &[]);
                if o.has('C') {
                    self.ask(Kind::Code, "mapfile runs a callback");
                }
                for v in o.all_ops() {
                    if let Some(n) = v.exact() {
                        st.forget(n);
                    }
                }
                Some(Out::default())
            }
            "trap" => {
                let ops: Vec<&Val> = args.iter().filter(|a| !a.starts("-")).collect();
                if let Some(action) = ops.first() {
                    if ops.len() > 1 && !action.s.is_empty() && action.s != "-" {
                        if action.is_unknown() {
                            self.ask(Kind::Code, "trap runs a string it cannot read");
                        } else {
                            let mut s = st.clone();
                            s.depth += 1;
                            self.script(&action.s.clone(), &mut s);
                        }
                    }
                }
                Some(Out::default())
            }
            "alias" => {
                if args.iter().any(|a| a.s.contains('=')) {
                    self.ask(Kind::Code, "defines an alias, which changes what later commands mean");
                }
                Some(Out::default())
            }
            "eval" => {
                let joined: Vec<&str> = args.iter().map(|a| a.s.as_str()).collect();
                if joined.is_empty() {
                    return Some(Out::default());
                }
                let text = joined.join(" ");
                if args.iter().all(|a| a.is_unknown()) {
                    self.ask(Kind::Code, "eval runs a string it cannot read");
                } else {
                    st.depth += 1;
                    self.script(&text, st);
                    st.depth -= 1;
                }
                Some(Out::default())
            }
            "source" | "." => {
                self.source(args, st);
                Some(Out::default())
            }
            "exec" => {
                let o = getopt(args, "a", &[]);
                let _ = o;
                let inner: Vec<Val> = args.iter().skip_while(|a| a.starts("-") && a.exact().is_some()).cloned().collect();
                if inner.is_empty() {
                    return Some(Out::default());
                }
                Some(self.run(inner, &[], io, st))
            }
            "kill" => {
                self.kill(args);
                Some(Out::default())
            }
            "enable" => {
                if args.iter().any(|a| a.is("-f")) {
                    self.deny(Kind::Code, "enable -f loads a shared object as a shell builtin");
                }
                Some(Out::default())
            }
            "fc" => {
                if args.iter().any(|a| a.starts("-s")) || args.iter().any(|a| a.starts("-e")) {
                    self.ask(Kind::Code, "fc re-runs earlier commands");
                }
                Some(Out::default())
            }
            _ => None,
        }
    }

    fn echo(&mut self, args: &[Val], io: &Io, st: &State) -> Out {
        if let Some(n) = self.cmd_secret.take() {
            self.ask(Kind::Credential, format!("prints the secret variable {n}"));
        }
        let mut newline = true;
        let mut escapes = false;
        let mut i = 0;
        while i < args.len() {
            match args[i].exact() {
                Some(t) if t.len() > 1 && t.starts_with('-') && t[1..].chars().all(|c| matches!(c, 'n' | 'e' | 'E')) => {
                    for c in t[1..].chars() {
                        match c {
                            'n' => newline = false,
                            'e' => escapes = true,
                            _ => escapes = false,
                        }
                    }
                    i += 1;
                }
                _ => break,
            }
        }
        let rest = &args[i..];
        if rest.iter().any(|a| a.exact().is_none()) {
            return Out::default();
        }
        let mut text = rest.iter().map(|a| a.s.as_str()).collect::<Vec<_>>().join(" ");
        if escapes {
            text = ansi_c(&text);
        }
        if newline {
            text.push('\n');
        }
        self.record_in(io, &text, st);
        Out { literal: (!io.out_file).then_some(text), net: false }
    }

    fn printf(&mut self, args: &[Val], io: &Io, st: &mut State) -> Out {
        if let Some(n) = self.cmd_secret.take() {
            self.ask(Kind::Credential, format!("prints the secret variable {n}"));
        }
        let mut rest = args;
        if rest.first().is_some_and(|a| a.is("-v")) {
            if let Some(n) = rest.get(1).and_then(|v| v.exact()) {
                st.forget(n);
            }
            return Out::default();
        }
        if rest.first().is_some_and(|a| a.is("--")) {
            rest = &rest[1..];
        }
        let Some(fmt) = rest.first().and_then(|f| f.exact()) else { return Out::default() };
        if rest[1..].iter().any(|a| a.exact().is_none()) {
            return Out::default();
        }
        let vals: Vec<&str> = rest[1..].iter().map(|a| a.s.as_str()).collect();
        let text = format_printf(fmt, &vals);
        if let Some(text) = text {
            self.record_in(io, &text, st);
            return Out { literal: (!io.out_file).then_some(text), net: false };
        }
        Out::default()
    }

    /// Like `record`, resolving a relative file against the working directory.
    pub(crate) fn record_in(&mut self, io: &Io, text: &str, st: &State) {
        for v in &io.out_to {
            if let Some(abs) = self.resolve(v, st) {
                self.wrote.entry(abs).and_modify(|e| e.push_str(text)).or_insert_with(|| text.to_string());
            }
        }
    }

    fn cd(&mut self, args: &[Val], st: &mut State) {
        let ops: Vec<&Val> = args.iter().filter(|a| !(a.exact().is_some() && matches!(a.s.as_str(), "-L" | "-P" | "-e" | "-@" | "--"))).collect();
        let target = match ops.first() {
            None => match &self.ctx.home {
                Some(h) => Val::lit(h.clone()),
                None => {
                    st.cwd = None;
                    return;
                }
            },
            Some(v) => (*v).clone(),
        };
        if target.is("-") {
            st.cwd = None;
            return;
        }
        if target.exact().is_none() {
            st.cwd = None;
            return;
        }
        let t = &target.s;
        st.cwd = match (&st.cwd, t.starts_with('/')) {
            (_, true) => Some(normalize(t)),
            (Some(c), false) => Some(normalize(&format!("{c}/{t}"))),
            (None, false) => None,
        };
    }

    fn declare(&mut self, name: &str, args: &[Val], st: &mut State) {
        let o: Opts = getopt(args, "", &[]);
        let mut named = false;
        for v in o.all_ops() {
            let Some(t) = v.known() else {
                // `export "$x"`: a name or an assignment built at runtime.
                if let Some(k) = v.s.find('=') {
                    let n = &v.s[..k];
                    if is_ident(n) {
                        named = true;
                        self.assign(st, n, vec![Val::lit(&v.s[k + 1..])], false);
                        continue;
                    }
                }
                named = true;
                continue;
            };
            named = true;
            if let Some(k) = t.find('=') {
                let n = &t[..k];
                if is_ident(n.trim_end_matches('+')) {
                    let append = n.ends_with('+');
                    let n = n.trim_end_matches('+');
                    let value = Val::lit(&t[k + 1..]);
                    self.assign(st, n, vec![value], append);
                }
            }
        }
        // Without a name these list the shell's variables, including secrets in the environment.
        if !named && !(name == "declare" || name == "typeset") || (!named && (o.has('p') || o.has('x') || o.flags.is_empty())) {
            if !(o.has('f') || o.has('F')) {
                self.ask(Kind::Credential, format!("{name} with no name prints variables, which may hold secrets"));
            }
        }
    }

    fn source(&mut self, args: &[Val], st: &mut State) {
        let Some(file) = args.first() else { return };
        let shown = file.show();
        let s = self.sense(file, st);
        if s.secret.is_some_and(|k| k == "an env file") {
            // `set -a; . .env`: loading it exports secrets to every later command.
            self.ask(Kind::Credential, format!("sources {}: {shown}", s.secret.unwrap_or("an env file")));
            return;
        }
        if let Some(secret) = s.secret {
            self.deny(Kind::Credential, format!("sources {secret}: {shown}"));
            return;
        }
        if let Some(abs) = self.resolve(file, st) {
            let text = self.wrote.get(&abs).cloned().or_else(|| {
                let files = self.ctx.files.clone()?;
                self.impure = true;
                files.read(&abs, 256 * 1024)
            });
            if let Some(text) = text {
                st.depth += 1;
                self.script(&text, st);
                st.depth -= 1;
                return;
            }
        }
        use crate::path::Place;
        match s.place {
            Place::Work | Place::Anchor | Place::Temp => {}
            Place::HomeSub if shown.ends_with("/.cargo/env") || shown.ends_with("/nvm.sh") || shown.ends_with("/activate") || shown.ends_with("/.bun/_bun") || shown.ends_with("/.deno/env") => {}
            Place::Null => self.ask(Kind::Code, format!("sources the output of a command: {shown}")),
            Place::Unknown => self.ask(Kind::Code, format!("sources a file it cannot locate: {shown}")),
            _ => self.ask(Kind::Code, format!("sources a file outside the workspace: {shown}")),
        }
    }

    fn kill(&mut self, args: &[Val]) {
        let mut iter = args.iter().peekable();
        let mut pids: Vec<&Val> = Vec::new();
        while let Some(a) = iter.next() {
            match a.exact() {
                Some("-l") | Some("-L") => return,
                Some("-s") | Some("-n") => {
                    iter.next();
                }
                Some(t) if t.starts_with('-') && t.len() > 1 && !t[1..].chars().all(|c| c.is_ascii_digit()) => {}
                Some(t) if t.starts_with('-') && t.len() > 1 => {
                    // `-9` is a signal, `-1` after a signal is every process.
                    if t == "-1" && args.iter().filter(|x| x.starts("-")).count() >= 2 || t == "-1" && args.len() >= 2 && args.iter().any(|x| matches!(x.exact(), Some("-9") | Some("-KILL") | Some("-SIGKILL"))) {
                        self.deny(Kind::Destructive, "kill -1 signals every process");
                        return;
                    }
                    if t == "-1" && args.len() == 1 {
                        // `kill -1` alone is SIGHUP to nobody.
                    }
                    if t.len() > 1 && t[1..].chars().all(|c| c.is_ascii_digit()) && args.len() > 1 {
                        // A signal number.
                    } else if args.len() == 1 {
                        pids.push(a);
                    }
                }
                _ => pids.push(a),
            }
        }
        for p in pids {
            match p.exact() {
                Some(t) if t.starts_with('%') => {}
                Some("0") => {}
                Some("1") | Some("-1") => self.deny(Kind::Destructive, "kill signals init or every process"),
                Some(t) if t.parse::<u32>().is_ok() => self.ask(Kind::Destructive, format!("signals process {t}")),
                _ => self.ask(Kind::Destructive, "signals a process it cannot identify"),
            }
        }
    }
}

/// `printf`'s output for a format and its arguments, when both are plain text.
fn format_printf(fmt: &str, args: &[&str]) -> Option<String> {
    let fmt = ansi_c(fmt);
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut next = 0usize;
    loop {
        let before = next;
        let mut i = 0;
        let mut consumed_spec = false;
        while i < chars.len() {
            if chars[i] != '%' {
                out.push(chars[i]);
                i += 1;
                continue;
            }
            i += 1;
            if i >= chars.len() {
                out.push('%');
                break;
            }
            if chars[i] == '%' {
                out.push('%');
                i += 1;
                continue;
            }
            while i < chars.len() && "-+ #0123456789.*".contains(chars[i]) {
                i += 1;
            }
            let Some(&conv) = chars.get(i) else { break };
            i += 1;
            consumed_spec = true;
            let arg = args.get(next).copied().unwrap_or("");
            next += 1;
            match conv {
                's' | 'd' | 'i' | 'u' | 'f' | 'e' | 'g' | 'x' | 'X' | 'o' | 'c' => out.push_str(arg),
                'b' => out.push_str(&ansi_c(arg)),
                'q' => {
                    out.push('\'');
                    out.push_str(&arg.replace('\'', "'\\''"));
                    out.push('\'');
                }
                _ => return None,
            }
        }
        if !consumed_spec || next >= args.len() || next == before {
            break;
        }
    }
    Some(out)
}
