//! Code handed to an interpreter on the command line or in a file, in languages this crate
//! has no grammar for (JavaScript, Perl, Ruby, PHP, Lua): read for the words that reach out of
//! the process, with the strings and comments set aside. It says "fine" only when none of
//! them appears; everything else is a question for a person.

use std::collections::HashSet;

/// What a scan found, as the clause a finding carries.
pub(crate) struct Risk {
    pub reason: String,
    /// Reading a credential, which no question is asked about.
    pub credential: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lang {
    Js,
    Perl,
    Ruby,
    Php,
    Lua,
}

/// Node modules that reach the network, run programs or load code.
const JS_MODULES: &[&str] = &["child_process", "net", "http", "https", "http2", "dgram", "dns", "tls", "cluster", "worker_threads", "vm", "module", "inspector", "repl", "wasi", "trace_events", "async_hooks_", "v8", "diagnostics_channel"];
const JS_FS_WRITES: &[&str] = &[
    "writeFile", "writeFileSync", "appendFile", "appendFileSync", "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "mkdir", "mkdirSync", "chmod", "chmodSync", "chown", "chownSync", "symlink", "symlinkSync", "link", "linkSync", "truncate", "truncateSync", "createWriteStream",
    "open", "openSync", "write", "writeSync", "utimes", "utimesSync", "mkdtemp", "mkdtempSync", "ftruncate", "ftruncateSync", "fchmod", "lchmod", "lchown", "fchown", "writev", "writevSync", "opendir_", "watch_",
];
const JS_PROCESS_BAD: &[&str] = &["kill", "binding", "dlopen", "mainModule", "chdir", "setuid", "setgid", "seteuid", "setegid", "setgroups", "abort", "reallyExit", "_kill", "_rawDebug", "umask", "emitWarning_", "_linkedBinding", "openStdin_"];
const JS_BAD: &[&str] = &["eval", "Function", "AsyncFunction", "GeneratorFunction", "constructor", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "Deno", "Bun", "execSync", "spawnSync", "execFileSync", "WebAssembly", "importScripts", "SharedArrayBuffer_"];

const PERL_BAD: &[&str] = &[
    "system", "exec", "qx", "open", "unlink", "rmdir", "rename", "mkdir", "chmod", "chown", "kill", "fork", "socket", "syscall", "eval", "require", "do", "glob", "opendir", "symlink", "link", "truncate", "sysopen", "pipe", "exit_", "rmtree", "remove_tree", "mkpath", "make_path", "move", "copy", "LWP", "HTTP", "Socket", "IO", "Net", "File::Path", "File::Copy", "ENV_", "sleep_", "bless_",
];
const RUBY_BAD: &[&str] = &[
    "system", "exec", "spawn", "popen", "popen3", "Open3", "eval", "instance_eval", "class_eval", "send", "public_send", "__send__", "require", "load", "File", "FileUtils", "Dir", "IO", "Kernel", "Process", "fork", "exit!", "abort_", "Net", "Socket", "TCPSocket", "UDPSocket", "URI", "open", "binding", "ObjectSpace", "Shellwords_", "ENV_", "trap", "syscall",
];
const PHP_BAD: &[&str] = &[
    "system", "exec", "shell_exec", "passthru", "popen", "proc_open", "pcntl_exec", "eval", "assert", "unlink", "rmdir", "rename", "mkdir", "chmod", "chown", "file_put_contents", "fopen", "fwrite", "copy", "symlink", "link", "curl_init", "curl_exec", "mail", "fsockopen", "stream_socket_client", "include", "include_once", "require", "require_once", "putenv", "dl", "ini_set", "move_uploaded_file", "touch", "tempnam_", "file_get_contents_",
];
const LUA_BAD: &[&str] = &["execute", "popen", "remove", "rename", "tmpname", "open", "loadstring", "load", "dofile", "loadfile", "require", "setmetatable_", "debug", "package", "getenv_", "exit_", "socket", "io"];

/// The strings of `code`: whatever stands between a pair of quotes.
fn strings(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let c: Vec<char> = code.chars().collect();
    let mut i = 0;
    while i < c.len() {
        if matches!(c[i], '"' | '\'' | '`') {
            let q = c[i];
            let mut s = String::new();
            i += 1;
            while i < c.len() && c[i] != q {
                if c[i] == '\\' && i + 1 < c.len() {
                    i += 1;
                }
                s.push(c[i]);
                i += 1;
            }
            out.push(s);
        }
        i += 1;
    }
    out
}

fn words(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in code.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// What is risky in `code`, if anything.
pub(crate) fn scan(lang: Lang, code: &str) -> Option<Risk> {
    // A credential named in a string is read, whatever the language.
    for s in strings(code) {
        if s.len() > 3 && s.len() < 300 && !s.contains(' ') {
            if let Some(what) = crate::path::secret(&s.replace("~/", "/home/x/")) {
                return Some(Risk { reason: format!("names {what}: {}", s.chars().take(60).collect::<String>()), credential: true });
            }
        }
    }
    match lang {
        Lang::Js => scan_js(code),
        Lang::Perl => bad_words(code, PERL_BAD, "perl"),
        Lang::Ruby => bad_words(code, RUBY_BAD, "ruby"),
        Lang::Php => bad_words(code, PHP_BAD, "php"),
        Lang::Lua => bad_words(code, LUA_BAD, "lua"),
    }
}

fn bad_words(code: &str, bad: &[&str], lang: &str) -> Option<Risk> {
    if code.contains('`') {
        return Some(Risk { reason: format!("{lang} runs a command in backquotes"), credential: false });
    }
    if code.contains("%x") && lang == "ruby" {
        return Some(Risk { reason: "ruby runs a command with %x".into(), credential: false });
    }
    // A pipe in an `open` is a command; the word list has `open` already.
    let w = words(code);
    for b in bad {
        if b.contains("::") {
            if code.contains(b) {
                return Some(Risk { reason: format!("{lang} uses {b}"), credential: false });
            }
        } else if w.iter().any(|x| x == b) {
            return Some(Risk { reason: format!("{lang} uses {b}, which runs programs or touches files and the network"), credential: false });
        }
    }
    None
}

fn scan_js(code: &str) -> Option<Risk> {
    let bad = |why: String| Some(Risk { reason: why, credential: false });
    let c: Vec<char> = code.chars().collect();
    let n = c.len();
    let mut i = 0;
    let mut prev_operand = false;
    let mut idents: Vec<String> = Vec::new();
    let mut modules: Vec<String> = Vec::new();
    let mut last_ident = String::new();
    let mut after_dot = false;
    let mut env_bare = false;
    while i < n {
        let ch = c[i];
        match ch {
            '/' if c.get(i + 1) == Some(&'/') => {
                while i < n && c[i] != '\n' {
                    i += 1;
                }
            }
            '/' if c.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < n && !(c[i] == '*' && c[i + 1] == '/') {
                    i += 1;
                }
                if i + 1 >= n {
                    return bad("javascript has a comment that never ends".into());
                }
                i += 2;
            }
            '"' | '\'' => {
                let q = ch;
                let mut s = String::new();
                i += 1;
                while i < n && c[i] != q {
                    if c[i] == '\\' {
                        i += 1;
                    }
                    if i < n {
                        s.push(c[i]);
                    }
                    i += 1;
                }
                if i >= n {
                    return bad("javascript has a string that never ends".into());
                }
                i += 1;
                if last_ident == "require" || last_ident == "from" || last_ident == "import" {
                    modules.push(s);
                }
                prev_operand = true;
                after_dot = false;
            }
            '`' => {
                // A template: its text is data, its `${…}` are code.
                i += 1;
                let mut depth = 0usize;
                let mut expr = String::new();
                while i < n {
                    if c[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if depth == 0 && c[i] == '`' {
                        break;
                    }
                    if depth == 0 && c[i] == '$' && c.get(i + 1) == Some(&'{') {
                        depth = 1;
                        i += 2;
                        expr.push(' ');
                        continue;
                    }
                    if depth > 0 {
                        match c[i] {
                            '{' => depth += 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 {
                                    expr.push(';');
                                    i += 1;
                                    continue;
                                }
                            }
                            _ => {}
                        }
                        expr.push(c[i]);
                    }
                    i += 1;
                }
                if i >= n {
                    return bad("javascript has a template that never ends".into());
                }
                i += 1;
                if let Some(r) = scan_js(&expr) {
                    return Some(r);
                }
                prev_operand = true;
                after_dot = false;
            }
            '/' if !prev_operand => {
                i += 1;
                while i < n && c[i] != '/' && c[i] != '\n' {
                    if c[i] == '\\' {
                        i += 1;
                    }
                    if i < n && c[i] == '[' {
                        while i < n && c[i] != ']' && c[i] != '\n' {
                            i += 1;
                        }
                    }
                    i += 1;
                }
                i += 1;
                prev_operand = true;
            }
            c0 if c0.is_alphabetic() || c0 == '_' || c0 == '$' => {
                let start = i;
                while i < n && (c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$') {
                    i += 1;
                }
                let w: String = c[start..i].iter().collect();
                if after_dot {
                    if last_ident == "process" && JS_PROCESS_BAD.contains(&w.as_str()) {
                        return bad(format!("javascript calls process.{w}"));
                    }
                    if last_ident == "env" && false {
                        // process.env.X is read.
                    }
                } else if JS_BAD.contains(&w.as_str()) {
                    return bad(format!("javascript uses {w}, which runs code built at runtime or reaches out"));
                } else if w == "import" {
                    // `import(...)` is dynamic; `import x from 'm'` names a module.
                    let mut j = i;
                    while j < n && c[j] == ' ' {
                        j += 1;
                    }
                    if c.get(j) == Some(&'(') {
                        return bad("javascript imports a module chosen at runtime".into());
                    }
                } else if w == "require" {
                    let mut j = i;
                    while j < n && c[j] == ' ' {
                        j += 1;
                    }
                    if c.get(j) == Some(&'(') {
                        let mut k = j + 1;
                        while k < n && c[k] == ' ' {
                            k += 1;
                        }
                        if !matches!(c.get(k), Some('"') | Some('\'')) {
                            return bad("javascript requires a module chosen at runtime".into());
                        }
                    }
                } else if w == "fetch" {
                    // fetch(url) is a read; with options it can send.
                    let mut depth = 0;
                    let mut j = i;
                    let mut commas = 0;
                    while j < n {
                        match c[j] {
                            '(' => depth += 1,
                            ')' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            ',' if depth == 1 => commas += 1,
                            _ => {}
                        }
                        j += 1;
                    }
                    if commas > 0 {
                        return bad("javascript sends a request with options".into());
                    }
                }
                if w == "env" && last_ident == "process" && after_dot {
                    let mut j = i;
                    while j < n && c[j] == ' ' {
                        j += 1;
                    }
                    if !matches!(c.get(j), Some('.') | Some('[')) {
                        env_bare = true;
                    }
                }
                idents.push(w.clone());
                last_ident = w;
                after_dot = false;
                prev_operand = true;
            }
            '.' => {
                if c.get(i + 1).is_some_and(|x| x.is_ascii_digit()) {
                    i += 1;
                    prev_operand = true;
                    continue;
                }
                after_dot = true;
                i += 1;
                if c.get(i) == Some(&'.') {
                    // spread
                    after_dot = false;
                }
                prev_operand = false;
            }
            c0 if c0.is_ascii_digit() => {
                while i < n && (c[i].is_alphanumeric() || c[i] == '.' || c[i] == '_') {
                    i += 1;
                }
                prev_operand = true;
            }
            ')' | ']' => {
                i += 1;
                prev_operand = true;
                after_dot = false;
            }
            c0 if c0.is_whitespace() => i += 1,
            _ => {
                i += 1;
                prev_operand = false;
                if !after_dot {
                    // keep `after_dot` across nothing else
                }
                after_dot = false;
            }
        }
    }
    let used: HashSet<&str> = idents.iter().map(String::as_str).collect();
    for m in &modules {
        let m = m.strip_prefix("node:").unwrap_or(m);
        let root = m.split('/').next().unwrap_or(m);
        if JS_MODULES.contains(&root) {
            return bad(format!("javascript loads {m}, which runs programs or reaches the network"));
        }
        if (root == "fs") && JS_FS_WRITES.iter().any(|w| used.contains(w)) {
            return bad("javascript writes or removes files".into());
        }
    }
    if env_bare {
        return Some(Risk { reason: "javascript prints the whole environment, which may hold secrets".into(), credential: false });
    }
    None
}
