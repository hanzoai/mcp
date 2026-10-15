//! What each command does. A rule reads a command's arguments and says what it reads,
//! writes, removes, runs and sends; the policy in `paths` and the findings decide the rest.

mod builtin;
pub(crate) use builtin::secretive;
mod dev;
mod files;
mod git;
mod interp;
mod net;
mod ops;
pub(crate) mod paths;
mod text;
mod wrap;

use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Walker};

/// Shell options: short flags (clustered), long options, values, operands.
#[derive(Default, Debug)]
pub(crate) struct Opts {
    pub flags: Vec<char>,
    pub longs: Vec<String>,
    pub vals: Vec<(String, Val)>,
    pub ops: Vec<Val>,
    /// An argument that is unknown or may split could be an option as well.
    pub opaque: bool,
    /// Everything after `--`.
    pub after: Vec<Val>,
}

impl Opts {
    pub fn has(&self, c: char) -> bool {
        self.flags.contains(&c)
    }
    pub fn long(&self, name: &str) -> bool {
        self.longs.iter().any(|l| l == name)
    }
    pub fn val(&self, name: &str) -> Option<&Val> {
        self.vals.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }
    pub fn all_ops(&self) -> impl Iterator<Item = &Val> {
        self.ops.iter().chain(self.after.iter())
    }
}

/// A GNU-style option parser. `with_val` lists the short options that take a value and
/// `long_val` the long ones; any other option is a flag. Options may follow operands.
pub(crate) fn getopt(args: &[Val], with_val: &str, long_val: &[&str]) -> Opts {
    let mut o = Opts::default();
    let mut i = 0;
    let mut dashdash = false;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if dashdash {
            o.after.push(a.clone());
            continue;
        }
        if a.split || a.is_unknown() {
            o.opaque = true;
            o.ops.push(a.clone());
            continue;
        }
        let t = a.s.as_str();
        if t == "--" {
            dashdash = true;
        } else if let Some(rest) = t.strip_prefix("--") {
            let (name, inline) = match rest.find('=') {
                Some(k) => (&rest[..k], Some(&rest[k + 1..])),
                None => (rest, None),
            };
            o.longs.push(name.to_string());
            if let Some(v) = inline {
                o.vals.push((name.to_string(), Val::lit(v)));
            } else if long_val.contains(&name) && i < args.len() {
                o.vals.push((name.to_string(), args[i].clone()));
                i += 1;
            }
        } else if t.len() > 1 && t.starts_with('-') && !t.starts_with("-\u{E000}") {
            let cs: Vec<char> = t[1..].chars().collect();
            let mut k = 0;
            while k < cs.len() {
                let c = cs[k];
                o.flags.push(c);
                if with_val.contains(c) && c != crate::val::UNK {
                    let rest: String = cs[k + 1..].iter().collect();
                    if !rest.is_empty() {
                        o.vals.push((c.to_string(), Val::lit(rest)));
                    } else if i < args.len() {
                        o.vals.push((c.to_string(), args[i].clone()));
                        i += 1;
                    }
                    break;
                }
                k += 1;
            }
        } else if t.starts_with('-') && t.len() > 1 {
            o.opaque = true;
            o.ops.push(a.clone());
        } else {
            o.ops.push(a.clone());
        }
    }
    o
}

/// Where the programs of the system and of a person's tools live: a command run by one of
/// these paths is the command of that name.
fn tool_dir(dir: &str, home: Option<&str>) -> bool {
    const DIRS: &[&str] = &["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/snap/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/games", "/opt/local/bin"];
    if DIRS.contains(&dir) {
        return true;
    }
    if let Some(h) = home {
        for sub in [".cargo/bin", ".local/bin", ".bun/bin", "go/bin", ".npm-global/bin", ".deno/bin", ".pyenv/shims", ".rbenv/shims", ".asdf/shims", ".volta/bin", ".nix-profile/bin", ".rustup/toolchains"] {
            if dir == format!("{h}/{sub}") {
                return true;
            }
        }
        if dir.starts_with(&format!("{h}/.nvm/versions/node/")) && dir.ends_with("/bin") {
            return true;
        }
        if dir.starts_with(&format!("{h}/.rustup/toolchains/")) && dir.ends_with("/bin") {
            return true;
        }
    }
    dir.starts_with("/nix/store/") && dir.ends_with("/bin")
}

/// A list of directories (`PATH`, `LD_LIBRARY_PATH`) is plain when each is an absolute
/// directory that is not scratch space, or is an expansion of something else.
fn plain_dirs(vals: &[Val], temp: &[String]) -> bool {
    vals.iter().all(|v| {
        v.s.split(':').all(|e| {
            let e = e.trim_end_matches('/');
            if e.contains(crate::val::UNK) {
                return true;
            }
            if e.is_empty() || e == "." || !e.starts_with('/') {
                return false;
            }
            !temp.iter().any(|t| e == t.trim_end_matches('/') || e.starts_with(&format!("{}/", t.trim_end_matches('/'))))
        })
    })
}

fn quiet_pager(v: &str) -> bool {
    matches!(v.trim(), "" | "true" | "false" | ":" | "cat" | "less" | "more" | "bat" | "echo" | "head" | "tail" | "less -FRX" | "less -R" | "less -r" | "/bin/true" | "/usr/bin/true" | "/bin/cat" | "/usr/bin/cat" | "/usr/bin/less" | "delta")
}

fn quiet_node(v: &str) -> bool {
    v.split_whitespace().all(|t| {
        let t = t.trim_start_matches('-').replace('_', "-");
        t.starts_with("max-old-space-size=") || t.starts_with("max-semi-space-size=") || t.starts_with("stack-size=") || t.starts_with("max-http-header-size=") || t.starts_with("disable-warning=") || t.starts_with("unhandled-rejections=")
            || matches!(t.as_str(), "no-warnings" | "trace-warnings" | "enable-source-maps" | "experimental-vm-modules" | "expose-gc" | "openssl-legacy-provider" | "no-deprecation" | "trace-uncaught" | "trace-deprecation" | "throw-deprecation" | "pending-deprecation" | "preserve-symlinks" | "experimental-strip-types" | "no-experimental-fetch" | "use-openssl-ca" | "tls-min-v1.0" | "dns-result-order=ipv4first")
    })
}

fn quiet_java(v: &str) -> bool {
    v.split_whitespace().all(|t| {
        (t.starts_with("-Xmx") || t.starts_with("-Xms") || t.starts_with("-Xss") || t.starts_with("-Dfile.encoding") || t.starts_with("-Duser.") || t.starts_with("-Djava.awt") || t.starts_with("-Dorg.gradle") || t.starts_with("-XX:+") || t.starts_with("-XX:MaxMetaspace") || t.starts_with("-XX:MaxPermSize"))
            && !t.contains("OnError") && !t.contains("OnOutOfMemory") && !t.contains("agent")
    })
}

fn quiet_goflags(v: &str) -> bool {
    v.split_whitespace().all(|t| {
        let t = t.trim_start_matches('-');
        let t = t.strip_prefix('-').unwrap_or(t);
        !(t.starts_with("toolexec") || t.starts_with("exec") || t.starts_with("overlay") || t.starts_with("modfile") || t.starts_with("pkgdir"))
    })
}

/// The variable names that change what a command is or what it loads, when set for it.
pub(crate) fn env_name(w: &mut Walker, name: &str, vals: &[Val]) {
    let upper = name.to_ascii_uppercase();
    let empty = vals.iter().all(|v| v.s.is_empty());
    let all = |f: &dyn Fn(&str) -> bool| vals.iter().all(|v| f(&v.s));
    let hard = match upper.as_str() {
        "LD_PRELOAD" | "LD_AUDIT" | "DYLD_INSERT_LIBRARIES" | "BASH_ENV" | "ENV" | "PROMPT_COMMAND" | "PS4" | "PS0" | "SHELLOPTS" | "BASHOPTS" | "ZDOTDIR" | "PYTHONSTARTUP" | "RUBYOPT" | "PERL5OPT" | "GIT_EXTERNAL_DIFF" | "FPATH" | "LESSOPEN" | "LESSCLOSE" | "GIT_SSH_PARAMS_" | "CARGO_HOME_" => !empty,
        "NODE_OPTIONS" => !all(&quiet_node),
        "JAVA_TOOL_OPTIONS" | "_JAVA_OPTIONS" | "JDK_JAVA_OPTIONS" => !all(&quiet_java),
        "GOFLAGS" => !all(&quiet_goflags),
        "GOPROXY" => !all(&|v| matches!(v, "direct" | "off" | "" | "https://proxy.golang.org" | "https://proxy.golang.org,direct")),
        "RUSTC_WRAPPER" | "RUSTC_WORKSPACE_WRAPPER" | "CARGO_BUILD_RUSTC_WRAPPER" | "GIT_ASKPASS" | "SSH_ASKPASS" | "GIT_SSH" | "SUDO_EDITOR" => !empty,
        "EDITOR" | "VISUAL" | "PAGER" | "GIT_PAGER" | "GIT_EDITOR" | "GIT_SEQUENCE_EDITOR" | "BROWSER" | "MANPAGER" => !all(&quiet_pager),
        "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" => !all(&|v| v == "/dev/null"),
        "DOCKER_HOST" => !all(&|v| v.starts_with("unix://") || v.is_empty()),
        "GIT_SSH_COMMAND" => {
            // A command line: read it as one.
            for v in vals {
                let mut s = State::start(w.ctx);
                s.depth += 1;
                w.script(&v.s, &mut s);
            }
            false
        }
        "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH" | "DYLD_FALLBACK_LIBRARY_PATH" | "PATH" => !plain_dirs(vals, &w.ctx.temp.clone()),
        _ => upper.starts_with("BASH_FUNC_") || upper.starts_with("GIT_CONFIG_KEY_") || upper.starts_with("GIT_CONFIG_VALUE_") || upper == "GIT_CONFIG_COUNT",
    };
    if hard {
        let why = if upper == "PATH" { "sets PATH to a directory a command could be planted in".to_string() } else { format!("sets {name}, which changes what runs or what loads") };
        w.ask(Kind::Code, why);
    }
}

impl Walker<'_> {
    /// Reads one simple command, its words already expanded, and says what it does.
    pub(crate) fn run(&mut self, words: Vec<Val>, assigns: &[(String, Vec<Val>, bool)], io: &Io, st: &mut State) -> Out {
        for (n, vals, _) in assigns {
            env_name(self, n, vals);
        }
        let head = &words[0];
        let args = &words[1..];
        if head.has_unknown() || head.glob {
            self.ask(Kind::Unparsed, format!("the command is named by an expansion: {}", head.show()));
            return Out::default();
        }
        let text = head.s.as_str();
        let name: String = if let Some(i) = text.rfind('/') {
            let dir = text[..i].trim_end_matches('/');
            let dir = if dir.is_empty() { "/" } else { dir };
            let base = &text[i + 1..];
            if tool_dir(dir, self.ctx.home.as_deref()) && !base.is_empty() {
                base.to_string()
            } else {
                self.program(head, args, io, st);
                return Out::default();
            }
        } else {
            text.to_string()
        };
        let name = name.trim_end_matches(".exe").to_ascii_lowercase();
        if self.funcs.contains(&name) {
            return Out::default();
        }
        self.dispatch(&name, args, io, st)
    }

    pub(crate) fn dispatch(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Out {
        if let Some(o) = self.builtin(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.wrapper(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.interp(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.file_command(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.text_command(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.git_command(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.net_command(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.dev_command(name, args, io, st) {
            return o;
        }
        if let Some(o) = self.ops_command(name, args, io, st) {
            return o;
        }
        self.ask(Kind::Unknown, format!("unknown command: {name}"));
        Out::default()
    }

    /// A program run by a path that is not a standard tool directory.
    pub(crate) fn program(&mut self, path: &Val, args: &[Val], io: &Io, st: &mut State) {
        let _ = (args, io);
        self.run_file(path, st, "runs", None);
    }
}
