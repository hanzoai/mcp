//! Python code, parsed by a Python 3 grammar and read for what it runs, writes, deletes and
//! sends: `subprocess`, `os.system`, `open(…, 'w')`, `shutil.rmtree`, `Path.unlink` and the rest.

use std::collections::{HashMap, HashSet};

use rustpython_ast::{self as ast, Constant, Expr, ExprContext, Mod, Operator, Ranged, Stmt, Visitor};
use rustpython_parser::Mode;

use crate::val::{Val, UNK};
use crate::verdict::Kind;
use crate::walk::{State, Walker};

/// Modules whose star-import hides what a bare name does.
const STAR: &[&str] = &["os", "subprocess", "shutil", "socket", "ctypes", "pathlib", "pty", "signal"];
/// Functions that run a program or destroy files: passed along as a value, they still do.
const RISKY: &[&str] = &["os.system", "os.popen", "subprocess.Popen", "subprocess.run", "subprocess.call", "subprocess.check_output", "subprocess.check_call", "subprocess.getoutput", "os.execv", "os.execvp", "os.execl", "shutil.rmtree", "os.remove", "os.unlink", "os.rmdir", "asyncio.create_subprocess_shell"];
/// The most readings of one expression that are followed apart.
const ALTS: usize = 8;

type Known = HashMap<String, Vec<Val>>;

#[derive(Default)]
struct Facts {
    /// Local names to the dotted names they stand for.
    alias: HashMap<String, String>,
    /// How many times each name is bound, by anything.
    binds: HashMap<String, usize>,
    /// How many of those are a plain `name = value`.
    plain: HashMap<String, usize>,
    /// Those assignments, in order.
    assigns: Vec<(String, Expr)>,
    /// Names assigned a literal list or tuple, by their elements.
    lists: HashMap<String, Vec<Expr>>,
}

struct Collect<'a> {
    f: &'a mut Facts,
}

impl Visitor for Collect<'_> {
    fn visit_stmt(&mut self, node: Stmt) {
        match &node {
            Stmt::Import(i) => {
                for a in &i.names {
                    let full = a.name.as_str().to_string();
                    match &a.asname {
                        Some(n) => {
                            self.f.alias.insert(n.as_str().to_string(), full);
                        }
                        None => {
                            let top = full.split('.').next().unwrap_or(&full).to_string();
                            self.f.alias.insert(top.clone(), top);
                        }
                    }
                }
            }
            Stmt::ImportFrom(i) => {
                if let Some(m) = &i.module {
                    for a in &i.names {
                        let n = a.name.as_str();
                        if n == "*" {
                            continue;
                        }
                        let local = a.asname.as_ref().map(|x| x.as_str()).unwrap_or(n).to_string();
                        self.f.alias.insert(local, format!("{}.{}", m.as_str(), n));
                    }
                }
            }
            Stmt::For(f) => {
                if let Expr::Name(n) = &*f.target {
                    let items: Option<Vec<Expr>> = match &*f.iter {
                        Expr::List(l) => Some(l.elts.clone()),
                        Expr::Tuple(l) => Some(l.elts.clone()),
                        Expr::Name(i) => self.f.lists.get(i.id.as_str()).cloned(),
                        _ => None,
                    };
                    if let Some(items) = items {
                        let id = n.id.as_str().to_string();
                        *self.f.plain.entry(id.clone()).or_insert(0) += 1;
                        for it in items {
                            self.f.assigns.push((id.clone(), it));
                        }
                    }
                }
            }
            Stmt::Assign(a) => {
                if let [Expr::Name(n)] = a.targets.as_slice() {
                    let id = n.id.as_str().to_string();
                    match &*a.value {
                        Expr::List(l) => {
                            self.f.lists.insert(id.clone(), l.elts.clone());
                        }
                        Expr::Tuple(l) => {
                            self.f.lists.insert(id.clone(), l.elts.clone());
                        }
                        _ => {}
                    }
                    *self.f.plain.entry(id.clone()).or_insert(0) += 1;
                    // `f = os.system`: the name is the function.
                    if matches!(&*a.value, Expr::Attribute(_) | Expr::Name(_)) {
                        if let Some(q) = qualify(&a.value, &self.f.alias) {
                            if q.contains('.') {
                                self.f.alias.insert(id.clone(), q);
                            }
                        }
                    }
                    self.f.assigns.push((id, (*a.value).clone()));
                }
            }
            _ => {}
        }
        self.generic_visit_stmt(node);
    }

    fn visit_expr(&mut self, node: Expr) {
        if let Expr::Name(n) = &node {
            if matches!(n.ctx, ExprContext::Store | ExprContext::Del) {
                *self.f.binds.entry(n.id.as_str().to_string()).or_insert(0) += 1;
            }
        }
        self.generic_visit_expr(node);
    }

    fn visit_arg(&mut self, node: ast::Arg) {
        *self.f.binds.entry(node.arg.as_str().to_string()).or_insert(0) += 2;
        self.generic_visit_arg(node);
    }
}

fn cart(a: Vec<Val>, b: Vec<Val>, f: impl Fn(&Val, &Val) -> Val) -> Vec<Val> {
    if a.len().saturating_mul(b.len()) > ALTS {
        return vec![Val::unknown()];
    }
    let mut out = Vec::new();
    for x in &a {
        for y in &b {
            out.push(f(x, y));
        }
    }
    out
}

fn joined(a: &Val, b: &Val) -> Val {
    let s = if b.s.starts_with('/') {
        b.s.clone()
    } else if a.s.is_empty() || a.s.ends_with('/') {
        format!("{}{}", a.s, b.s)
    } else {
        format!("{}/{}", a.s, b.s)
    };
    Val { s, glob: false, split: false }
}

fn lit(s: String) -> Vec<Val> {
    vec![Val::lit(s)]
}

fn unknown() -> Vec<Val> {
    vec![Val::unknown()]
}

/// The texts an expression may stand for, with what is not known as the unknown marker.
fn texts_of(e: &Expr, alias: &HashMap<String, String>, known: &Known, home: Option<&str>) -> Vec<Val> {
    let t = |x: &Expr| texts_of(x, alias, known, home);
    let fold = |parts: Vec<Vec<Val>>, f: &dyn Fn(&Val, &Val) -> Val| -> Vec<Val> {
        let mut it = parts.into_iter();
        let mut acc = it.next().unwrap_or_else(unknown);
        for p in it {
            acc = cart(acc, p, f);
        }
        acc
    };
    match e {
        Expr::Constant(c) => match &c.value {
            Constant::Str(s) => lit(s.clone()),
            Constant::Bytes(b) => lit(String::from_utf8_lossy(b).to_string()),
            _ => unknown(),
        },
        Expr::JoinedStr(j) => {
            let parts: Vec<Vec<Val>> = j
                .values
                .iter()
                .map(|v| match v {
                    Expr::FormattedValue(f) => t(&f.value),
                    other => t(other),
                })
                .collect();
            if parts.is_empty() {
                return lit(String::new());
            }
            fold(parts, &|a, b| Val { s: format!("{}{}", a.s, b.s), glob: false, split: false })
        }
        Expr::BinOp(b) => match b.op {
            Operator::Add => cart(t(&b.left), t(&b.right), |x, y| Val { s: format!("{}{}", x.s, y.s), glob: false, split: false }),
            Operator::Div => cart(t(&b.left), t(&b.right), joined),
            Operator::Mod => t(&b.left).into_iter().map(|x| Val { s: format!("{}{}", x.s, UNK), glob: false, split: false }).collect(),
            _ => unknown(),
        },
        Expr::Name(n) => known.get(n.id.as_str()).cloned().filter(|v| !v.is_empty()).unwrap_or_else(unknown),
        Expr::Attribute(a) => match a.attr.as_str() {
            "parent" => t(&a.value)
                .into_iter()
                .map(|v| match v.s.rfind('/') {
                    Some(0) => Val::lit("/"),
                    Some(i) => Val { s: v.s[..i].to_string(), glob: false, split: false },
                    None => Val::lit("."),
                })
                .collect(),
            _ => unknown(),
        },
        Expr::Subscript(s) => {
            // os.environ["HOME"]
            if qualify(&s.value, alias).as_deref() == Some("os.environ") {
                if let Expr::Constant(c) = &*s.slice {
                    if matches!(&c.value, Constant::Str(k) if k == "HOME") {
                        if let Some(h) = home {
                            return lit(h.to_string());
                        }
                    }
                }
            }
            unknown()
        }
        Expr::Call(c) => {
            let q = qualify(&c.func, alias);
            let args: Vec<Vec<Val>> = c.args.iter().map(&t).collect();
            match q.as_deref() {
                Some("os.path.join") | Some("posixpath.join") | Some("pathlib.Path") | Some("pathlib.PurePath") | Some("pathlib.PosixPath") | Some("pathlib.PurePosixPath") => {
                    if args.is_empty() {
                        lit(".".into())
                    } else {
                        fold(args, &joined)
                    }
                }
                Some("os.path.expanduser") | Some("os.path.expandvars") => {
                    let a = args.into_iter().next().unwrap_or_else(unknown);
                    a.into_iter()
                        .map(|a| match (a.s.strip_prefix('~'), home) {
                            (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with('/') => Val::lit(format!("{h}{rest}")),
                            (Some(_), None) => Val::unknown(),
                            _ => a,
                        })
                        .collect()
                }
                Some("os.path.abspath") | Some("os.path.realpath") | Some("os.path.normpath") | Some("os.path.relpath") | Some("str") | Some("os.fspath") => args.into_iter().next().unwrap_or_else(unknown),
                Some("os.path.dirname") => args
                    .into_iter()
                    .next()
                    .unwrap_or_else(unknown)
                    .into_iter()
                    .map(|a| match a.s.rfind('/') {
                        Some(0) => Val::lit("/"),
                        Some(i) => Val { s: a.s[..i].to_string(), glob: false, split: false },
                        None => Val::lit("."),
                    })
                    .collect(),
                Some("pathlib.Path.home") => home.map(|h| lit(h.to_string())).unwrap_or_else(unknown),
                Some("os.getcwd") | Some("pathlib.Path.cwd") => lit(".".into()),
                Some("tempfile.gettempdir") => lit("/tmp".into()),
                Some("tempfile.mkdtemp") | Some("tempfile.mkstemp") | Some("tempfile.NamedTemporaryFile") | Some("tempfile.TemporaryDirectory") => lit(format!("/tmp/{UNK}")),
                Some("os.getenv") | Some("os.environ.get") => match (c.args.first(), home) {
                    (Some(Expr::Constant(k)), Some(h)) if matches!(&k.value, Constant::Str(s) if s == "HOME") => lit(h.to_string()),
                    _ => unknown(),
                },
                _ => {
                    // Methods on a path: p.expanduser(), p.resolve(), p.joinpath(a, b).
                    if let Expr::Attribute(a) = &*c.func {
                        match a.attr.as_str() {
                            "expanduser" | "resolve" | "absolute" | "as_posix" | "strip" | "rstrip" | "lstrip" | "lower" | "upper" => {
                                let v = t(&a.value);
                                if a.attr.as_str() == "expanduser" {
                                    return v
                                        .into_iter()
                                        .map(|v| match (v.s.strip_prefix('~'), home) {
                                            (Some(rest), Some(h)) => Val::lit(format!("{h}{rest}")),
                                            _ => v,
                                        })
                                        .collect();
                                }
                                return v;
                            }
                            "joinpath" => {
                                let mut parts = vec![t(&a.value)];
                                parts.extend(args);
                                return fold(parts, &joined);
                            }
                            _ => {}
                        }
                    }
                    unknown()
                }
            }
        }
        _ => unknown(),
    }
}

/// The dotted name an expression refers to, through the module's imports.
fn qualify(e: &Expr, alias: &HashMap<String, String>) -> Option<String> {
    match e {
        Expr::Name(n) => Some(alias.get(n.id.as_str()).cloned().unwrap_or_else(|| n.id.as_str().to_string())),
        Expr::Attribute(a) => qualify(&a.value, alias).map(|q| format!("{q}.{}", a.attr.as_str())),
        Expr::Call(c) => {
            let f = qualify(&c.func, alias)?;
            let first = c.args.first();
            let lit = |x: Option<&Expr>| -> Option<String> {
                match x {
                    Some(Expr::Constant(k)) => match &k.value {
                        Constant::Str(s) => Some(s.clone()),
                        _ => None,
                    },
                    _ => None,
                }
            };
            match f.as_str() {
                "__import__" | "importlib.import_module" => lit(first),
                "getattr" => {
                    let base = qualify(first?, alias)?;
                    Some(format!("{base}.{}", lit(c.args.get(1))?))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// A few words for the expression, for a reason that names what could not be resolved.
fn describe(e: &Expr, alias: &HashMap<String, String>) -> String {
    match e {
        Expr::Name(n) => n.id.as_str().to_string(),
        Expr::Attribute(_) => qualify(e, alias).unwrap_or_else(|| "an attribute".into()),
        Expr::Subscript(s) => format!("{}[…]", describe(&s.value, alias)),
        Expr::Call(c) => format!("{}(…)", qualify(&c.func, alias).unwrap_or_else(|| "a call".into())),
        Expr::JoinedStr(_) => "an f-string".into(),
        Expr::BinOp(_) => "an expression".into(),
        _ => "an expression".into(),
    }
}

fn span(r: rustpython_ast::text_size::TextRange) -> (u32, u32) {
    (u32::from(r.start()), u32::from(r.end()))
}

struct Scan<'a, 'w, 'c> {
    w: &'a mut Walker<'c>,
    st: &'w State,
    alias: HashMap<String, String>,
    known: Known,
    home: Option<String>,
    /// Where each expression that is called stands, so a reference to a function that is
    /// passed along instead is told from one that is called.
    callees: HashSet<(u32, u32)>,
}

fn is_path_call(q: &str) -> bool {
    matches!(q, "pathlib.Path" | "pathlib.PurePath" | "pathlib.PosixPath" | "pathlib.Path.home" | "pathlib.Path.cwd" | "os.path.join")
}

#[derive(Clone, Copy)]
enum Do {
    Read,
    Write,
    Remove,
    RemoveTree,
    Change,
}

impl Scan<'_, '_, '_> {
    fn texts(&self, e: &Expr) -> Vec<Val> {
        texts_of(e, &self.alias, &self.known, self.home.as_deref())
    }

    fn text(&self, e: &Expr) -> Val {
        self.texts(e).into_iter().next().unwrap_or_else(Val::unknown)
    }

    fn kw<'e>(&self, c: &'e ast::ExprCall, name: &str) -> Option<&'e Expr> {
        c.keywords.iter().find(|k| k.arg.as_ref().is_some_and(|a| a.as_str() == name)).map(|k| &k.value)
    }

    fn arg<'e>(&self, c: &'e ast::ExprCall, i: usize, name: &str) -> Option<&'e Expr> {
        c.args.get(i).or_else(|| self.kw(c, name))
    }

    fn pathish(&self, e: &Expr) -> bool {
        match e {
            Expr::Call(c) => qualify(&c.func, &self.alias).is_some_and(|q| is_path_call(&q)) || matches!(&*c.func, Expr::Attribute(a) if matches!(a.attr.as_str(), "resolve" | "expanduser" | "joinpath" | "absolute" | "with_name" | "with_suffix") && self.pathish(&a.value)),
            Expr::BinOp(b) => matches!(b.op, Operator::Div) && self.pathish(&b.left),
            Expr::Attribute(a) => a.attr.as_str() == "parent" && self.pathish(&a.value),
            Expr::Name(n) => self.known.get(n.id.as_str()).is_some_and(|_| false),
            _ => false,
        }
    }

    /// Applies `how` to every path the expression may be.
    fn on(&mut self, e: &Expr, how: Do, what: &str) {
        let vals = self.texts(e);
        for v in vals {
            if v.is_unknown() {
                match how {
                    Do::Remove | Do::Read => {}
                    Do::RemoveTree => self.w.ask(Kind::Destructive, format!("python removes a tree at {}, which it cannot resolve", describe(e, &self.alias))),
                    Do::Write | Do::Change => self.w.ask(Kind::Write, format!("python {what} {}, which it cannot resolve", describe(e, &self.alias))),
                }
                continue;
            }
            match how {
                Do::Read => self.w.read_path(&v, self.st, "python reads"),
                Do::Write | Do::Change => self.w.write_path(&v, self.st, &format!("python {what}")),
                Do::Remove => self.w.remove_path(&v, self.st, false),
                Do::RemoveTree => self.w.remove_path(&v, self.st, true),
            }
        }
    }

    /// Reads `cmd` as a shell command line.
    fn shell(&mut self, e: &Expr, cwd: Option<&Expr>) {
        for cmd in self.texts(e) {
            self.shell_val(&cmd, cwd);
        }
    }

    fn shell_val(&mut self, cmd: &Val, cwd: Option<&Expr>) {
        if cmd.is_unknown() {
            self.w.ask(Kind::Code, "python runs a command built at runtime");
            return;
        }
        let mut s = self.st.clone();
        s.depth += 1;
        if let Some(c) = cwd {
            let v = self.text(c);
            s.cwd = match v.exact() {
                Some(t) if t.starts_with('/') => Some(crate::path::normalize(t)),
                Some(t) => s.cwd.as_ref().map(|c| crate::path::normalize(&format!("{c}/{t}"))),
                None => None,
            };
        }
        self.w.script(&cmd.s, &mut s);
    }

    /// An argument vector as the shell line that would make it, one word each.
    fn argv(&mut self, items: &[Expr], cwd: Option<&Expr>) {
        if items.is_empty() {
            return;
        }
        // Each element may have several readings; follow them together, at most a few.
        let mut lines: Vec<String> = vec![String::new()];
        for e in items {
            let vals = match e {
                Expr::Starred(_) => unknown(),
                other => self.texts(other),
            };
            let mut next = Vec::new();
            for l in &lines {
                for v in &vals {
                    let mut m = l.clone();
                    if !m.is_empty() {
                        m.push(' ');
                    }
                    m.push('\'');
                    m.push_str(&v.s.replace('\'', "'\\''"));
                    m.push('\'');
                    next.push(m);
                }
            }
            if next.len() > ALTS {
                next.truncate(ALTS);
            }
            lines = next;
        }
        for l in lines {
            self.shell_val(&Val { s: l, glob: false, split: false }, cwd);
        }
    }

    fn run_command(&mut self, c: &ast::ExprCall, shell_default: bool, name: &str) {
        let shell = match self.kw(c, "shell") {
            Some(Expr::Constant(k)) => matches!(k.value, Constant::Bool(true)),
            Some(_) => true,
            None => shell_default,
        };
        let cwd = self.kw(c, "cwd");
        let Some(first) = self.arg(c, 0, "args") else {
            self.w.ask(Kind::Code, format!("{name} without a command it can read"));
            return;
        };
        match first {
            Expr::List(l) => {
                if shell {
                    if let Some(f) = l.elts.first() {
                        self.shell(f, cwd);
                    }
                } else {
                    self.argv(&l.elts, cwd);
                }
            }
            Expr::Tuple(l) => {
                if shell {
                    if let Some(f) = l.elts.first() {
                        self.shell(f, cwd);
                    }
                } else {
                    self.argv(&l.elts, cwd);
                }
            }
            other => {
                if shell {
                    self.shell(other, cwd);
                } else {
                    for v in self.texts(other) {
                        if v.is_unknown() {
                            self.w.ask(Kind::Code, format!("{name} runs a command it cannot read ({})", describe(other, &self.alias)));
                        } else {
                            // A bare program name, or a command line given as one string.
                            let line = format!("'{}'", v.s.replace('\'', "'\\''"));
                            self.shell_val(&Val { s: line, glob: false, split: false }, cwd);
                        }
                    }
                }
            }
        }
    }

    fn open_write(&mut self, c: &ast::ExprCall, mode_at: usize) -> Option<bool> {
        match self.arg(c, mode_at, "mode") {
            None => Some(false),
            Some(m) => {
                let vs = self.texts(m);
                let mut any_write = false;
                for v in &vs {
                    match v.exact() {
                        Some(s) => any_write |= s.contains(['w', 'a', 'x', '+']),
                        None => return None,
                    }
                }
                Some(any_write)
            }
        }
    }

    fn file(&mut self, path: &Expr, write: Option<bool>) {
        match write {
            Some(true) => self.on(path, Do::Write, "writes"),
            Some(false) => self.on(path, Do::Read, "reads"),
            None => {
                self.on(path, Do::Read, "reads");
                self.w.ask(Kind::Write, format!("python opens {} in a mode it cannot read", describe(path, &self.alias)));
            }
        }
    }

    fn call(&mut self, c: &ast::ExprCall) {
        let q = qualify(&c.func, &self.alias);
        if let Some(q) = q.as_deref() {
            match q {
                "os.system" | "os.popen" | "subprocess.getoutput" | "subprocess.getstatusoutput" | "commands.getoutput" | "commands.getstatusoutput" | "asyncio.create_subprocess_shell" | "os.popen2" | "os.popen3" | "pty.spawn" => {
                    match c.args.first() {
                        Some(a) if q != "pty.spawn" => self.shell(a, None),
                        _ => self.w.ask(Kind::Code, format!("python {q} starts a program")),
                    }
                    return;
                }
                "subprocess.run" | "subprocess.call" | "subprocess.check_call" | "subprocess.check_output" | "subprocess.Popen" | "asyncio.create_subprocess_exec" => {
                    self.run_command(c, false, q);
                    return;
                }
                "os.execv" | "os.execve" | "os.execvp" | "os.execvpe" | "os.execl" | "os.execle" | "os.execlp" | "os.execlpe" | "os.spawnl" | "os.spawnle" | "os.spawnlp" | "os.spawnlpe" | "os.spawnv" | "os.spawnve" | "os.spawnvp" | "os.spawnvpe" | "os.posix_spawn" | "os.posix_spawnp" | "os.fork" | "os.forkpty" | "os.startfile" => {
                    self.w.ask(Kind::Code, format!("python {q} starts or replaces a process"));
                    return;
                }
                "os.kill" | "os.killpg" => {
                    self.w.ask(Kind::Destructive, "python signals a process");
                    return;
                }
                "os.remove" | "os.unlink" | "os.rmdir" | "os.removedirs" => {
                    if let Some(p) = c.args.first() {
                        self.on(p, Do::Remove, "removes");
                    }
                    return;
                }
                "shutil.rmtree" => {
                    if let Some(p) = c.args.first() {
                        self.on(p, Do::RemoveTree, "removes");
                    }
                    return;
                }
                "os.rename" | "os.renames" | "os.replace" | "shutil.move" => {
                    if let Some(s) = c.args.first() {
                        self.on(s, Do::Remove, "moves");
                    }
                    if let Some(d) = c.args.get(1) {
                        self.on(d, Do::Write, "moves to");
                    }
                    return;
                }
                "shutil.copy" | "shutil.copy2" | "shutil.copyfile" | "shutil.copytree" | "shutil.copymode" | "shutil.copystat" => {
                    if let Some(s) = c.args.first() {
                        self.on(s, Do::Read, "copies");
                    }
                    if let Some(d) = c.args.get(1) {
                        self.on(d, Do::Write, "copies to");
                    }
                    return;
                }
                "os.mkdir" | "os.makedirs" | "os.mkfifo" | "os.mknod" | "os.utime" | "os.truncate" | "os.chmod" | "os.chown" | "os.lchown" | "os.lchmod" | "shutil.chown" | "os.chflags" | "os.setxattr" => {
                    if let Some(p) = c.args.first() {
                        self.on(p, Do::Change, "changes");
                    }
                    if q == "os.chmod" {
                        if let Some(Expr::Constant(m)) = c.args.get(1) {
                            if let Constant::Int(n) = &m.value {
                                let n: i64 = n.to_string().parse().unwrap_or(0);
                                if n & 0o6000 != 0 {
                                    self.w.deny(Kind::Privilege, "python sets a setuid or setgid bit");
                                }
                            }
                        }
                    }
                    return;
                }
                "os.link" | "os.symlink" => {
                    if let Some(d) = c.args.get(1) {
                        self.on(d, Do::Write, "links at");
                    }
                    if let Some(t) = c.args.first() {
                        for v in self.texts(t) {
                            let s = self.w.sense(&v, self.st);
                            if let Some(secret) = s.secret {
                                self.w.ask(Kind::Credential, format!("python links to {secret}: {}", v.show()));
                            }
                        }
                    }
                    return;
                }
                "shutil.make_archive" => {
                    if let Some(p) = c.args.first() {
                        self.on(p, Do::Write, "writes");
                    }
                    return;
                }
                "shutil.unpack_archive" => {
                    if let Some(p) = self.arg(c, 1, "extract_dir") {
                        self.on(p, Do::Write, "extracts into");
                    }
                    return;
                }
                "open" | "io.open" | "codecs.open" | "gzip.open" | "bz2.open" | "lzma.open" | "shelve.open" | "dbm.open" | "tarfile.open" | "zipfile.ZipFile" | "builtins.open" => {
                    let name_kw = if q == "tarfile.open" { "name" } else { "file" };
                    if let Some(p) = self.arg(c, 0, name_kw).or_else(|| self.kw(c, "filename")) {
                        if matches!(p, Expr::Constant(k) if matches!(k.value, Constant::Int(_))) {
                            return;
                        }
                        let write = self.open_write(c, 1);
                        self.file(p, write);
                    }
                    return;
                }
                "os.open" => {
                    if let Some(p) = c.args.first() {
                        let flags = c.args.get(1).map(|f| format!("{f:?}")).unwrap_or_default();
                        let write = flags.contains("O_WRONLY") || flags.contains("O_RDWR") || flags.contains("O_CREAT") || flags.contains("O_APPEND") || flags.contains("O_TRUNC");
                        self.file(p, Some(write));
                    }
                    return;
                }
                "sqlite3.connect" | "duckdb.connect" => {
                    if let Some(p) = c.args.first() {
                        for v in self.texts(p) {
                            if !v.is(":memory:") {
                                self.w.write_path(&v, self.st, "python opens a database at");
                            }
                        }
                    }
                    return;
                }
                "urllib.request.urlretrieve" => {
                    if let Some(p) = self.arg(c, 1, "filename") {
                        self.on(p, Do::Write, "downloads to");
                    }
                    return;
                }
                "urllib.request.urlopen" => {
                    if self.kw(c, "data").is_some() || matches!(c.args.first(), Some(Expr::Call(r)) if qualify(&r.func, &self.alias).as_deref() == Some("urllib.request.Request") && (self.kw(r, "data").is_some() || self.kw(r, "method").is_some() || r.args.len() > 1)) || c.args.len() > 1 {
                        self.w.ask(Kind::Network, "python sends data over the network");
                    }
                    return;
                }
                "urllib.request.Request" | "urllib.request.build_opener" | "urllib.request.install_opener" | "urllib.request.HTTPCookieProcessor" | "urllib.request.HTTPHandler" | "urllib.request.HTTPSHandler" | "urllib.request.ProxyHandler" | "urllib.request.HTTPBasicAuthHandler" | "urllib.request.HTTPPasswordMgrWithDefaultRealm" | "urllib.request.HTTPRedirectHandler" => {
                    // Building a request is not sending it; what is sent is asked about where it is opened.
                    if q == "urllib.request.Request" && (self.kw(c, "data").is_some() || self.kw(c, "method").is_some() || c.args.len() > 1) {
                        self.w.ask(Kind::Network, "python builds a request that sends data");
                    }
                    return;
                }
                "requests.get" | "requests.head" | "requests.options" | "httpx.get" | "httpx.head" | "httpx.options" | "urllib.parse.quote" | "urllib.parse.urlparse" => return,
                "requests.request" | "httpx.request" => {
                    let m = c.args.first().map(|a| self.text(a)).unwrap_or_else(Val::unknown);
                    if !matches!(m.exact().map(|s| s.to_ascii_uppercase()).as_deref(), Some("GET") | Some("HEAD") | Some("OPTIONS")) {
                        self.w.ask(Kind::Network, "python sends data over the network");
                    }
                    return;
                }
                "eval" | "exec" | "compile" | "builtins.eval" | "builtins.exec" | "builtins.compile" | "importlib.import_module" | "importlib.reload" | "importlib.util.spec_from_file_location" | "importlib.util.module_from_spec" | "runpy.run_path" | "runpy.run_module" | "code.interact" | "code.InteractiveInterpreter" | "pickle.load" | "pickle.loads" | "pickle.Unpickler" | "marshal.load" | "marshal.loads" | "yaml.unsafe_load" | "__import__" | "types.FunctionType" | "types.CodeType" | "sys.settrace" | "sys.setprofile" | "webbrowser.open" | "webbrowser.open_new" | "webbrowser.open_new_tab" | "webbrowser.get" | "os.chroot" | "os.setuid" | "os.setgid" | "os.seteuid" | "os.setegid" | "os.setgroups" | "os.setsid" | "mmap.mmap" => {
                    self.w.ask(Kind::Code, format!("python {q} runs code built at runtime or native code"));
                    return;
                }
                "getattr" | "setattr" | "delattr" => {
                    // A name chosen at runtime reaches anything.
                    let lit = matches!(c.args.get(1), Some(Expr::Constant(k)) if matches!(k.value, Constant::Str(_)));
                    if !lit && q == "getattr" {
                        self.w.ask(Kind::Code, "python picks an attribute by a name built at runtime");
                    }
                    return;
                }
                _ => {}
            }
            // Whole modules: a call into any of them talks to the network or loads native code.
            const NET: &[&str] = &[
                "socket.", "ftplib.", "smtplib.", "telnetlib.", "paramiko.", "boto3.", "botocore.", "kubernetes.", "docker.", "redis.", "pymongo.", "psycopg2.", "psycopg.", "pymysql.", "mysql.", "sqlalchemy.", "grpc.", "websocket.", "websockets.", "aiohttp.", "xmlrpc.", "imaplib.", "poplib.", "socketserver.", "http.server.", "http.client.", "asyncio.open_connection", "asyncio.start_server", "requests.", "httpx.", "urllib3.", "urllib.request.", "smtpd.", "scapy.", "pexpect.", "fabric.",
            ];
            if NET.iter().any(|p| q.starts_with(p)) {
                self.w.ask(Kind::Network, format!("python {q} talks to the network"));
                return;
            }
            if q.starts_with("ctypes.") || q.starts_with("cffi.") {
                self.w.ask(Kind::Code, format!("python {q} loads or calls native code"));
                return;
            }
        }
        // Methods on a path: write_text, unlink, mkdir …
        if let Expr::Attribute(a) = &*c.func {
            let m = a.attr.as_str();
            match m {
                "write_text" | "write_bytes" | "touch" | "mkdir" | "symlink_to" | "hardlink_to" | "lchmod" => self.on(&a.value, Do::Write, "writes"),
                "unlink" | "rmdir" => self.on(&a.value, Do::Remove, "removes"),
                "read_text" | "read_bytes" => self.on(&a.value, Do::Read, "reads"),
                "rename" | "replace" if self.pathish(&a.value) && c.args.len() == 1 && c.keywords.is_empty() => {
                    self.on(&a.value, Do::Write, "renames");
                    self.on(&c.args[0], Do::Write, "renames to");
                }
                "chmod" if self.pathish(&a.value) => self.on(&a.value, Do::Change, "changes"),
                "open" if self.pathish(&a.value) => {
                    let write = match self.arg(c, 0, "mode") {
                        None => Some(false),
                        Some(mo) => {
                            let vs = self.texts(mo);
                            let mut w = false;
                            let mut known = true;
                            for v in &vs {
                                match v.exact() {
                                    Some(s) => w |= s.contains(['w', 'a', 'x', '+']),
                                    None => known = false,
                                }
                            }
                            if known {
                                Some(w)
                            } else {
                                None
                            }
                        }
                    };
                    self.file(&a.value, write);
                }
                "extractall" | "extract" => match self.arg(c, if m == "extract" { 1 } else { 0 }, "path") {
                    Some(p) => self.on(p, Do::Write, "extracts into"),
                    None => self.w.write_path(&Val::lit("."), self.st, "python extracts into"),
                },
                "to_csv" | "to_json" | "to_parquet" | "to_excel" | "to_pickle" | "to_feather" | "to_hdf" | "to_html" | "to_latex" | "to_markdown" | "to_xml" | "to_stata" | "savefig" | "save" | "savez" | "savez_compressed" | "savetxt" | "imwrite" | "imsave" | "write_image" | "write_html" | "tofile" | "to_file" => {
                    if let Some(p) = c.args.first() {
                        if matches!(p, Expr::Constant(k) if matches!(k.value, Constant::Str(_))) || matches!(p, Expr::JoinedStr(_)) {
                            self.on(p, Do::Write, "writes");
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

impl Visitor for Scan<'_, '_, '_> {
    fn visit_stmt(&mut self, node: Stmt) {
        if let Stmt::ImportFrom(i) = &node {
            if let Some(m) = &i.module {
                if i.names.iter().any(|a| a.name.as_str() == "*") && STAR.contains(&m.as_str().split('.').next().unwrap_or("")) {
                    self.w.ask(Kind::Code, format!("python star-imports {}, which hides what its names do", m.as_str()));
                }
            }
        }
        self.generic_visit_stmt(node);
    }

    fn visit_expr(&mut self, node: Expr) {
        match &node {
            Expr::Call(c) => {
                self.callees.insert(span(Ranged::range(&*c.func)));
                self.call(c)
            }
            Expr::Name(n) if matches!(n.ctx, ExprContext::Load) && !self.callees.contains(&span(n.range)) => {
                if let Some(q) = qualify(&node, &self.alias) {
                    if RISKY.contains(&q.as_str()) {
                        self.w.ask(Kind::Code, format!("python passes {q} along as a value, so it runs where it is called"));
                    }
                }
            }
            Expr::Attribute(a) => {
                if matches!(a.attr.as_str(), "__subclasses__" | "__globals__" | "__builtins__" | "__code__" | "__closure__" | "__bases__" | "__mro__" | "__loader__" | "__spec__" | "f_globals" | "f_builtins" | "gi_frame" | "tb_frame" | "cr_frame") {
                    self.w.ask(Kind::Code, format!("python reaches interpreter internals ({})", a.attr.as_str()));
                }
                if !self.callees.contains(&span(a.range)) {
                    if let Some(q) = qualify(&node, &self.alias) {
                        if RISKY.contains(&q.as_str()) {
                            self.w.ask(Kind::Code, format!("python passes {q} along as a value, so it runs where it is called"));
                        }
                    }
                }
            }
            _ => {}
        }
        self.generic_visit_expr(node);
    }
}

/// Reads `code` as a Python module and says what it does.
pub(crate) fn analyze(w: &mut Walker, code: &str, st: &State) {
    let parse = |c: &str| rustpython_parser::parse(c, Mode::Module, "<code>");
    let Ok(Mod::Module(first)) = parse(code) else {
        w.ask(Kind::Unparsed, "cannot read python code (a syntax this grammar does not know, or an error)");
        return;
    };
    let home = w.ctx.home.clone();
    let mut facts = Facts::default();
    {
        let mut c = Collect { f: &mut facts };
        for s in first.body {
            c.visit_stmt(s);
        }
    }
    // A name only ever assigned stands for what it was assigned.
    let mut known: Known = HashMap::new();
    let assigns = std::mem::take(&mut facts.assigns);
    for (name, rhs) in &assigns {
        if facts.binds.get(name).copied().unwrap_or(0) != facts.plain.get(name).copied().unwrap_or(0) {
            continue;
        }
        let vals = texts_of(rhs, &facts.alias, &known, home.as_deref());
        let e = known.entry(name.clone()).or_default();
        for v in vals {
            if !e.contains(&v) {
                e.push(v);
            }
        }
        if e.len() > ALTS {
            *e = vec![Val::unknown()];
        }
    }
    let Ok(Mod::Module(second)) = parse(code) else { return };
    let mut s = Scan { w, st, alias: facts.alias, known, home, callees: HashSet::new() };
    for stmt in second.body {
        s.visit_stmt(stmt);
    }
}
