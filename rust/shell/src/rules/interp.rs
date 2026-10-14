//! Commands that run code: shells, Python and the interpreters of other languages, from a
//! string (`-c`), a script on standard input (a pipe, a here-document) or a file.

use super::{getopt, Opts};
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Stdin, Walker};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lang {
    Sh,
    Py,
}

const SHELLS: &[&str] = &["sh", "bash", "dash", "zsh", "ksh", "ash", "fish", "csh", "tcsh", "busybox"];
/// Languages whose code is not read here: a one-liner is asked about, a file is judged by where it is.
const OTHERS: &[&str] = &["node", "nodejs", "deno", "bun", "ruby", "perl", "php", "lua", "luajit", "osascript", "pwsh", "powershell", "tclsh", "rscript", "julia", "swift", "groovy"];

fn python_name(name: &str) -> bool {
    name == "python" || name == "python2" || name == "pypy" || name == "pypy3" || name == "ipython" || (name.starts_with("python") && name[6..].chars().all(|c| c.is_ascii_digit() || c == '.')) || name == "python3-config"
}

impl Walker<'_> {
    pub(crate) fn interp(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if SHELLS.contains(&name) {
            self.shell(name, args, io, st);
            return Some(Out::default());
        }
        if python_name(name) {
            self.python_cmd(name, args, io, st);
            return Some(Out::default());
        }
        if OTHERS.contains(&name) {
            self.other_lang(name, args, io, st);
            return Some(Out::default());
        }
        None
    }

    /// `bash -c '…'`, `sh script.sh`, `bash` fed a script.
    fn shell(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        if name == "busybox" {
            // `busybox sh -c …`: the applet is the first word.
            if let Some((first, rest)) = args.split_first() {
                if let Some(applet) = first.exact() {
                    let applet = applet.to_string();
                    self.dispatch(&applet, rest, io, st);
                    return;
                }
            }
            self.ask(Kind::Unknown, "busybox with an applet it cannot read");
            return;
        }
        let mut i = 0;
        let (mut cflag, mut nflag) = (false, false);
        let mut rc = false;
        while i < args.len() {
            let a = &args[i];
            let Some(t) = a.exact() else {
                self.ask(Kind::Code, format!("{name} given an argument it cannot read"));
                return;
            };
            if t == "--" {
                i += 1;
                break;
            }
            if let Some(long) = t.strip_prefix("--") {
                if matches!(long, "rcfile" | "init-file") {
                    rc = true;
                    i += 1;
                } else if long == "version" || long == "help" {
                    return;
                }
                i += 1;
                continue;
            }
            if (t.starts_with('-') || t.starts_with('+')) && t.len() > 1 {
                let mut skip = 0;
                for ch in t[1..].chars() {
                    match ch {
                        'c' => cflag = true,
                        'n' => nflag = true,
                        'o' | 'O' => skip += 1,
                        _ => {}
                    }
                }
                i += 1 + skip;
                continue;
            }
            break;
        }
        if rc {
            self.ask(Kind::Code, format!("{name} with a start-up file of its own"));
        }
        if nflag {
            return;
        }
        if cflag {
            let Some(cmd) = args.get(i) else { return };
            if cmd.is_unknown() {
                self.ask(Kind::Code, format!("{name} -c runs a string it cannot read"));
                return;
            }
            if matches!(name, "fish" | "csh" | "tcsh") {
                self.ask(Kind::Unparsed, format!("{name} syntax is not read as bash"));
                return;
            }
            let mut s = st.clone();
            s.depth += 1;
            self.script(&cmd.s, &mut s);
            return;
        }
        match args.get(i) {
            Some(file) => self.run_file(file, st, "runs", Some(Lang::Sh)),
            None => self.stdin_script(io, Lang::Sh, st, name),
        }
    }

    /// A script given on standard input.
    pub(crate) fn stdin_script(&mut self, io: &Io, lang: Lang, st: &mut State, how: &str) {
        match &io.stdin {
            Stdin::Text(v) => self.code(&v.s, lang, st),
            Stdin::Pipe { literal: Some(t), .. } => self.code(t, lang, st),
            Stdin::Pipe { literal: None, net } => {
                if *net {
                    self.ask(Kind::Code, format!("{how} runs code downloaded and piped in, which is not read first"));
                } else {
                    self.ask(Kind::Code, format!("{how} runs what a pipe feeds it, which cannot be read"));
                }
            }
            Stdin::File(f) => {
                let f = f.clone();
                self.run_file(&f, st, "runs", Some(lang))
            }
            Stdin::Inherit => {}
        }
    }

    /// Reads `text` as code of `lang`.
    pub(crate) fn code(&mut self, text: &str, lang: Lang, st: &State) {
        match lang {
            Lang::Sh => {
                let mut s = st.clone();
                s.depth += 1;
                self.script(text, &mut s);
            }
            Lang::Py => crate::python::analyze(self, text, st),
        }
    }

    /// `python -c`, `python -m`, `python script.py`, `python -`.
    fn python_cmd(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        let mut i = 0;
        let mut code: Option<&Val> = None;
        let mut module: Option<&Val> = None;
        while i < args.len() {
            let a = &args[i];
            let Some(t) = a.exact() else {
                self.ask(Kind::Code, format!("{name} given an argument it cannot read"));
                return;
            };
            if t == "-" {
                i += 1;
                break;
            }
            if t == "--" {
                i += 1;
                break;
            }
            if t.starts_with("--") {
                if matches!(t, "--version" | "--help") {
                    return;
                }
                i += 1;
                continue;
            }
            if t.starts_with('-') && t.len() > 1 {
                let cs: Vec<char> = t[1..].chars().collect();
                let mut k = 0;
                let mut took_next = false;
                while k < cs.len() {
                    match cs[k] {
                        'c' | 'm' => {
                            let rest: String = cs[k + 1..].iter().collect();
                            let v = if !rest.is_empty() { None } else { args.get(i + 1) };
                            if cs[k] == 'c' {
                                code = v.or(code);
                            } else {
                                module = v.or(module);
                            }
                            if v.is_some() {
                                took_next = true;
                            }
                            break;
                        }
                        'W' | 'X' => {
                            if cs[k + 1..].is_empty() {
                                took_next = true;
                            }
                            break;
                        }
                        'V' => return,
                        _ => {}
                    }
                    k += 1;
                }
                i += 1 + usize::from(took_next);
                if code.is_some() || module.is_some() {
                    break;
                }
                continue;
            }
            break;
        }
        if let Some(c) = code {
            if c.is_unknown() {
                self.ask(Kind::Code, format!("{name} -c runs code it cannot read"));
            } else {
                self.code(&c.s, Lang::Py, st);
            }
            return;
        }
        if let Some(m) = module {
            self.python_module(m, &args[i + usize::from(false)..], st);
            return;
        }
        match args.get(i) {
            Some(file) => self.run_file(file, st, "runs", Some(Lang::Py)),
            None => self.stdin_script(io, Lang::Py, st, name),
        }
    }

    fn python_module(&mut self, m: &Val, rest: &[Val], st: &mut State) {
        let Some(module) = m.exact() else {
            self.ask(Kind::Code, "python -m with a module it cannot read");
            return;
        };
        let module = module.to_string();
        match module.as_str() {
            "pip" | "pip3" => {
                // The arguments after the module name.
                let after: Vec<Val> = rest.iter().skip_while(|v| v.exact() != Some(module.as_str())).skip(1).cloned().collect();
                let after = if after.is_empty() { rest.to_vec() } else { after };
                self.dev_pip(&after, st);
            }
            "http.server" | "SimpleHTTPServer" | "smtpd" | "ensurepip" | "pydoc" | "idlelib" | "turtledemo" | "webbrowser" | "antigravity" | "this" if module != "this" => {
                self.ask(Kind::Network, format!("python -m {module} starts a server or installs"));
            }
            "venv" | "virtualenv" => {}
            _ => {}
        }
    }

    /// `node -e`, `ruby script.rb`, `perl -pi -e …`.
    fn other_lang(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        // Each language spells its options its own way: `-pe` in node is `-p -e`, in perl a loop
        // and an expression; `-i` in perl is an in-place edit with an optional suffix.
        let normal: Vec<Val> = args.iter().map(|a| if name.starts_with("node") && a.is("-pe") { Val::lit("-p") } else { a.clone() }).collect();
        let with_val = match name {
            "node" | "nodejs" => "epr",
            "perl" => "eI",
            "ruby" => "eIrF",
            "php" => "rfdc",
            "lua" | "luajit" => "el",
            "pwsh" | "powershell" => "cf",
            _ => "e",
        };
        let o: Opts = getopt(&normal, with_val, &["eval", "print", "require", "command", "import", "loader", "input-type", "experimental-loader"]);
        let inline = o.has('e') || o.has('E') || (name.starts_with("node") && o.has('p')) || o.long("eval") || o.long("print") || (o.has('r') && name == "php") || (o.has('c') && matches!(name, "pwsh" | "powershell")) || o.long("command");
        if inline {
            let lang = match name {
                "node" | "nodejs" | "deno" | "bun" => Some(crate::inline::Lang::Js),
                "perl" => Some(crate::inline::Lang::Perl),
                "ruby" => Some(crate::inline::Lang::Ruby),
                "php" => Some(crate::inline::Lang::Php),
                "lua" | "luajit" => Some(crate::inline::Lang::Lua),
                _ => None,
            };
            let codes: Vec<&Val> = o.vals.iter().filter(|(n, _)| matches!(n.as_str(), "e" | "E" | "p" | "r" | "eval" | "print" | "command")).map(|(_, v)| v).collect();
            let readable = !codes.is_empty() && codes.iter().all(|v| !v.has_unknown());
            match (lang, readable) {
                (Some(l), true) => {
                    let mut risk = None;
                    for c in &codes {
                        if let Some(r) = crate::inline::scan(l, &c.s) {
                            risk = Some(r);
                            break;
                        }
                    }
                    match risk {
                        Some(r) if r.credential => self.deny(Kind::Credential, format!("inline {name} code {}", r.reason)),
                        Some(r) => self.ask(Kind::Code, format!("inline {name} code: {}", r.reason)),
                        None => {
                            // `perl -pi -e …` edits the files in place; without -i it only reads them.
                            for f in o.ops.iter() {
                                if o.has('i') {
                                    let f = f.clone();
                                    self.write_path(&f, st, "edits in place");
                                } else {
                                    let f = f.clone();
                                    self.read_path(&f, st, "reads");
                                }
                            }
                        }
                    }
                }
                _ => self.ask(Kind::Code, format!("runs inline {name} code, which is not read")),
            }
            return;
        }
        if o.long("version") || o.has('v') && o.ops.is_empty() || o.long("help") {
            return;
        }
        // `deno run`, `deno test`, `bun run x`, `bun test`: a task of the project.
        let mut ops: Vec<Val> = o.ops.clone();
        if matches!(name, "deno" | "bun") {
            if let Some(sub) = ops.first().and_then(|v| v.exact()).map(str::to_string) {
                match sub.as_str() {
                    "run" | "x" | "exec" => {
                        if sub == "x" {
                            self.ask(Kind::Network, "bun x runs a package fetched from the network");
                            return;
                        }
                        ops.remove(0);
                    }
                    "install" | "add" | "remove" | "update" | "test" | "fmt" | "lint" | "check" | "build" | "task" | "init" | "info" | "doc" | "bench" | "compile" | "outdated" | "pm" | "create" | "link" | "i" | "a" | "rm" | "upgrade" | "repl" | "types" | "cache" => {
                        if sub == "upgrade" || sub == "create" || (sub == "link") {
                            self.ask(Kind::Write, format!("{name} {sub} changes the installation"));
                        }
                        return;
                    }
                    "eval" => {
                        self.ask(Kind::Code, format!("runs inline {name} code, which is not read"));
                        return;
                    }
                    _ => {}
                }
            }
        }
        match ops.first() {
            Some(file) => {
                if file.starts("http://") || file.starts("https://") {
                    self.ask(Kind::Network, format!("{name} runs code fetched from {}", file.show()));
                } else {
                    let f = file.clone();
                    self.run_file(&f, st, "runs", None);
                }
            }
            None => match &io.stdin {
                Stdin::Inherit => {}
                _ => self.ask(Kind::Code, format!("{name} runs what is fed to it, which is not read")),
            },
        }
    }

    /// A program or script named by a path: the file is read if it can be, and judged by
    /// where it is if it cannot.
    pub(crate) fn run_file(&mut self, path: &Val, st: &mut State, verb: &str, lang: Option<Lang>) {
        let shown = path.show();
        let s = self.sense(path, st);
        if let Some(secret) = s.secret {
            self.ask(Kind::Credential, format!("{verb} {secret}: {shown}"));
            return;
        }
        let content = self.resolve(path, st).and_then(|abs| {
            if let Some(t) = self.wrote.get(&abs) {
                return Some(t.clone());
            }
            let files = self.ctx.files.clone()?;
            self.impure = true;
            files.read(&abs, 256 * 1024)
        });
        if let Some(text) = content {
            let lang = lang.or_else(|| detect(&text, &path.s));
            match lang {
                Some(l) => self.code(&text, l, st),
                None => {}
            }
            // A script that was read is judged by what it does, wherever it is: unless it sits
            // somewhere nobody should run a program from.
            if matches!(s.place, crate::path::Place::System | crate::path::Place::Disk) {
                return;
            }
            return;
        }
        use crate::path::Place;
        match s.place {
            Place::Work | Place::Anchor | Place::Temp => {}
            Place::Unknown => self.ask(Kind::Code, format!("{verb} a file it cannot locate: {shown}")),
            Place::Null => self.ask(Kind::Code, format!("{verb} the output of a command: {shown}")),
            Place::System => {}
            _ => self.ask(Kind::Code, format!("{verb} a file outside the workspace: {shown}")),
        }
    }
}

/// The language of a script by its first line, else by its name.
fn detect(text: &str, name: &str) -> Option<Lang> {
    if let Some(first) = text.lines().next() {
        if let Some(rest) = first.strip_prefix("#!") {
            let rest = rest.to_lowercase();
            if rest.contains("python") {
                return Some(Lang::Py);
            }
            if rest.contains("node") || rest.contains("deno") || rest.contains("bun") || rest.contains("ruby") || rest.contains("perl") || rest.contains("php") || rest.contains("lua") {
                return None;
            }
            return Some(Lang::Sh);
        }
    }
    let lower = name.to_lowercase();
    if lower.ends_with(".py") {
        return Some(Lang::Py);
    }
    if lower.ends_with(".sh") || lower.ends_with(".bash") || lower.ends_with(".zsh") || !lower.rsplit('/').next().unwrap_or("").contains('.') {
        return Some(Lang::Sh);
    }
    None
}
