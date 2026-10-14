//! Where a path is, and what is kept there: the policy every read, write and remove asks.
//! Paths are read lexically (no symlink is followed, no file is touched), so the answer is
//! the same on every machine for the same text.

use crate::context::Context;
use crate::val::{Val, UNK};

/// The directory a command with no directory of its own runs in: a stand-in for the caller's
/// workspace, never shown.
pub(crate) const VIRTUAL: &str = "/\u{1}workspace";
/// The home directory on another machine: a stand-in, never shown.
pub(crate) const REMOTE_HOME: &str = "/\u{1}rhome";
/// Where a command on another machine starts: under no root, so a relative path there is outside.
pub(crate) const REMOTE: &str = "/\u{1}remote";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Place {
    /// Under the workspace.
    Work,
    /// The workspace directory itself.
    Anchor,
    /// Under a scratch directory.
    Temp,
    /// A scratch directory itself, or one of its parents.
    TempRoot,
    /// `/dev/null`, `/dev/stdout`, `/dev/tty` and the like.
    Null,
    /// `/dev/tcp/…`: a network connection spelled as a file.
    Net,
    /// The person's home directory itself.
    Home,
    /// Under home, outside the workspace.
    HomeSub,
    /// Anywhere else.
    Outside,
    /// `/etc`, `/usr`, `/bin` and the rest of what only an administrator writes.
    System,
    /// A disk, or memory, as a device.
    Disk,
    /// `/home`, `/var`, `/opt`: the top of a tree of other people's things.
    Broad,
    /// `/`.
    Root,
    /// The text names no place yet: it holds an unknown where the path is decided.
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct Sense {
    pub place: Place,
    /// What credential the path holds, when it does.
    pub secret: Option<&'static str>,
    /// What a write here quietly changes about the machine (a hook, a shell start-up file).
    pub touchy: Option<&'static str>,
    /// A relative path climbed out of the directory it began in.
    pub climbs: bool,
}

/// Collapses `.`, `..` and repeated slashes in an absolute or relative path. A `..` at the
/// top stays at the top.
pub(crate) fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            p => parts.push(p),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

pub(crate) fn under(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path.len() > root.len() && path.starts_with(root) && path.as_bytes()[root.len()] == b'/'
}

/// Whether the climb of a relative `path` leaves the directory it started in.
fn climbs(path: &str) -> bool {
    let mut depth = 0i32;
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => depth -= 1,
            _ => depth += 1,
        }
        if depth < 0 {
            return true;
        }
    }
    false
}

const SYSTEM: &[&str] = &["etc", "root", "boot", "sys", "proc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32"];
const SYSTEM_MAC: &[&str] = &["system", "library", "private/etc", "applications", "cores"];
const BROAD: &[&str] = &["home", "users", "var", "opt", "srv", "mnt", "media", "run", "volumes", "private", "data", "snap", "nix"];

fn system(lower: &str) -> bool {
    let rest = lower.trim_start_matches('/');
    let first = rest.split('/').next().unwrap_or("");
    SYSTEM.contains(&first) || SYSTEM_MAC.iter().any(|m| rest == *m || rest.starts_with(&format!("{m}/")))
}

/// The places a classification is made against, built once from a [`Context`].
pub(crate) struct Lay {
    roots: Vec<String>,
    temp: Vec<String>,
    home: Option<String>,
}

impl Lay {
    pub fn new(ctx: &Context) -> Lay {
        let mut roots: Vec<String> = ctx.roots.iter().map(|r| normalize(r)).collect();
        let home = ctx.home.as_deref().map(normalize);
        let temp: Vec<String> = ctx.temp.iter().map(|t| normalize(t)).collect();
        if !ctx.remote {
            match ctx.cwd.as_deref() {
                Some(c) => {
                    let c = normalize(c);
                    if !wide(&c, home.as_deref(), &temp) {
                        roots.push(c);
                    }
                }
                None => roots.push(VIRTUAL.to_string()),
            }
        }
        Lay { roots, temp, home }
    }

    /// Resolves `v` against the working directory `cwd` and reads it.
    pub fn sense(&self, v: &Val, cwd: Option<&str>) -> Sense {
        let raw = v.s.as_str();
        if let Some(i) = raw.find(UNK) {
            return self.unknown(raw, i, cwd);
        }
        let relative = !raw.starts_with('/');
        let went_up = relative && climbs(raw);
        let abs = if relative {
            match cwd {
                Some(c) => normalize(&format!("{c}/{raw}")),
                None => return Sense { place: Place::Unknown, secret: secret(raw), touchy: touchy(raw), climbs: went_up },
            }
        } else {
            normalize(raw)
        };
        let lower = abs.to_lowercase();
        let secret = secret(&abs).or_else(|| system_secret(&lower));
        Sense { place: self.place_of(&abs, &lower), secret, touchy: touchy(&abs), climbs: went_up }
    }

    /// A path with an unknown in it. A directory that is known down to the last name is where
    /// it is, whatever the name; a system path stays one whatever follows; the rest is anywhere.
    fn unknown(&self, raw: &str, at: usize, cwd: Option<&str>) -> Sense {
        let prefix = &raw[..at];
        let nowhere = Sense { place: Place::Unknown, secret: secret(prefix), touchy: None, climbs: false };
        if prefix.starts_with('/') {
            let dir = prefix.rfind('/').map_or("/", |j| &prefix[..=j]);
            let s = self.sense(&Val::lit(dir.to_string()), cwd);
            if matches!(s.place, Place::System | Place::Disk) {
                return s;
            }
        }
        if raw[at..].contains('/') {
            return nowhere;
        }
        let dir = match prefix.rfind('/') {
            Some(j) => &prefix[..=j],
            None if prefix.is_empty() => return nowhere,
            None => "./",
        };
        let mut s = self.sense(&Val::lit(dir.to_string()), cwd);
        s.place = match s.place {
            Place::Anchor => Place::Work,
            Place::Home => Place::HomeSub,
            Place::TempRoot => Place::Temp,
            Place::Root | Place::Broad => Place::Unknown,
            p => p,
        };
        s.secret = s.secret.or_else(|| secret(prefix));
        s
    }

    fn place_of(&self, abs: &str, lower: &str) -> Place {
        if abs == "/" {
            return Place::Root;
        }
        if lower == "/dev" || lower.starts_with("/dev/") {
            let rest = lower[4..].trim_start_matches('/');
            if matches!(rest, "null" | "zero" | "full" | "stdin" | "stdout" | "stderr" | "tty" | "urandom" | "random" | "console") || rest.starts_with("fd/") || rest.starts_with("pts/") {
                return Place::Null;
            }
            if rest == "shm" || rest.starts_with("shm/") {
                return Place::Temp;
            }
            if rest.starts_with("tcp/") || rest.starts_with("udp/") {
                return Place::Net;
            }
            const DISKS: &[&str] = &["sd", "hd", "vd", "xvd", "nvme", "mmcblk", "loop", "dm-", "md", "sr", "mapper", "disk", "rdisk", "mem", "kmem", "port", "nbd"];
            if DISKS.iter().any(|d| rest.starts_with(d)) {
                return Place::Disk;
            }
            return Place::Outside;
        }
        for root in &self.roots {
            if abs == root.trim_end_matches('/') {
                return Place::Anchor;
            }
            if under(abs, root) {
                return Place::Work;
            }
        }
        if system(lower) {
            return Place::System;
        }
        for t in &self.temp {
            let t = t.trim_end_matches('/');
            if abs == t {
                return Place::TempRoot;
            }
            if under(abs, t) {
                return Place::Temp;
            }
        }
        if lower == "/var" || lower == "/private" || lower == "/private/var" {
            return Place::Broad;
        }
        if let Some(h) = &self.home {
            if abs == h {
                return Place::Home;
            }
            if under(abs, h) {
                return Place::HomeSub;
            }
        }
        let comps: Vec<&str> = lower.trim_start_matches('/').split('/').collect();
        if (comps.len() == 1 && BROAD.contains(&comps[0])) || (comps.len() == 2 && matches!(comps[0], "home" | "users")) {
            return Place::Broad;
        }
        Place::Outside
    }

}

/// Whether `dir` is the top of a tree (`/`, `/home`, a person's home, a scratch directory)
/// rather than a project.
fn wide(dir: &str, home: Option<&str>, temp: &[String]) -> bool {
    if dir == "/" {
        return true;
    }
    let lower = dir.to_lowercase();
    if system(&lower) {
        return true;
    }
    if home == Some(dir) {
        return true;
    }
    if temp.iter().any(|t| dir == t.trim_end_matches('/')) {
        return true;
    }
    let comps: Vec<&str> = lower.trim_start_matches('/').split('/').collect();
    (comps.len() == 1 && BROAD.contains(&comps[0])) || (comps.len() == 2 && matches!(comps[0], "home" | "users"))
}

const SECRET_DIRS: [(&str, &str); 10] = [
    (".ssh", "an ssh key"),
    (".gnupg", "a gpg key"),
    (".aws", "aws credentials"),
    (".azure", "azure credentials"),
    (".kube", "a kube config"),
    (".docker", "docker credentials"),
    (".vault-token", "a vault token"),
    ("secrets", "a secrets directory"),
    (".password-store", "a password store"),
    (".terraform.d", "terraform credentials"),
];

/// What credential the (already normalized) path names, if any.
pub(crate) fn secret(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase().replace('\\', "/");
    let comps: Vec<&str> = lower.split('/').filter(|c| !c.is_empty()).collect();
    let name = *comps.last()?;
    for (i, c) in comps.iter().enumerate() {
        let last = i + 1 == comps.len();
        for (dir, what) in SECRET_DIRS {
            if *c == dir {
                if dir == "secrets" {
                    // A directory called secrets holds some; one that is a source file's name does not.
                    if !last {
                        return Some(what);
                    }
                    continue;
                }
                if dir == ".ssh" && !last && (name.ends_with(".pub") || name == "known_hosts" || name == "config") {
                    return None;
                }
                if dir == ".docker" && !last && !matches!(name, "config.json" | "key.json") {
                    continue;
                }
                if dir == ".kube" && !last && matches!(name, "cache" | "http-cache") {
                    continue;
                }
                return Some(what);
            }
        }
        if *c == ".config" && comps.get(i + 1).is_some_and(|n| matches!(*n, "gcloud" | "gh" | "hub" | "doctl" | "glab-cli" | "op")) && i + 2 <= comps.len() {
            return Some("a cloud or cli credential");
        }
        if *c == ".hanzo" && comps.get(i + 1).is_some_and(|n| matches!(*n, "config.json" | "credentials" | "credentials.json" | "token" | "auth.json")) {
            return Some("a hanzo api key");
        }
        if matches!(*c, ".claude" | ".codex" | ".gemini" | ".qwen") && comps.get(i + 1).is_some_and(|n| matches!(*n, ".credentials.json" | "auth.json" | "oauth_creds.json")) {
            return Some("an agent login");
        }
        if *c == "rancher" && comps.get(i + 1).is_some() && lower.contains("/etc/rancher") {
            return Some("a cluster credential");
        }
    }
    secret_name(name)
}

/// Whether the file's own name says it holds a credential.
fn secret_name(name: &str) -> Option<&'static str> {
    const TEMPLATE: &[&str] = &["example", "sample", "template", "dist", "defaults", "schema", "tmpl", "tpl", "stub"];
    if name == ".env" || name.starts_with(".env.") || name == ".envrc" {
        let suffix = name.rsplit('.').next().unwrap_or("");
        if name != ".env" && TEMPLATE.contains(&suffix) {
            return None;
        }
        return Some("an env file");
    }
    if name.ends_with(".env") && name.len() > 4 {
        return Some("an env file");
    }
    if name.starts_with("id_") && !name.ends_with(".pub") {
        let algo = &name[3..];
        if ["rsa", "dsa", "ecdsa", "ed25519", "xmss", "ecdsa_sk", "ed25519_sk"].iter().any(|a| algo.starts_with(a)) {
            return Some("an ssh key");
        }
    }
    const EXACT: [(&str, &str); 28] = [
        (".netrc", "a netrc"),
        ("_netrc", "a netrc"),
        (".npmrc", "an npm token file"),
        (".pypirc", "a pypi login"),
        (".git-credentials", "git credentials"),
        (".pgpass", "a postgres password file"),
        (".my.cnf", "a mysql login"),
        (".vault-token", "a vault token"),
        (".htpasswd", "a password file"),
        ("htpasswd", "a password file"),
        ("credentials", "a credentials file"),
        ("credentials.json", "a credentials file"),
        ("credentials.db", "a credentials file"),
        (".credentials.json", "a credentials file"),
        ("application_default_credentials.json", "a gcloud credential"),
        ("master.key", "a rails master key"),
        ("kubeconfig", "a kube config"),
        ("shadow", "a password hash file"),
        ("gshadow", "a password hash file"),
        ("sudoers", "the sudoers file"),
        ("token.json", "a token file"),
        ("auth.json", "a login file"),
        ("oauth_creds.json", "a login file"),
        ("secrets.json", "a secrets file"),
        ("secrets.yaml", "a secrets file"),
        ("secrets.yml", "a secrets file"),
        ("secrets.toml", "a secrets file"),
        ("terraform.tfvars", "terraform variables"),
    ];
    for (n, what) in EXACT {
        if name == n {
            return Some(what);
        }
    }
    if (name.starts_with("service-account") || name.starts_with("service_account") || name.starts_with("serviceaccount")) && name.ends_with(".json") {
        return Some("a service account key");
    }
    if name.starts_with("client_secret") && name.ends_with(".json") {
        return Some("an oauth client secret");
    }
    if name.ends_with(".pem") {
        return Some("a pem file, a certificate or a key");
    }
    for ext in [".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".kubeconfig"] {
        if name.ends_with(ext) {
            return Some("a private key");
        }
    }
    if name.ends_with(".tfstate") || name.ends_with(".tfstate.backup") || name.ends_with(".auto.tfvars") {
        return Some("terraform state");
    }
    None
}

/// System files that hold secrets, by absolute lowercase path.
fn system_secret(lower: &str) -> Option<&'static str> {
    if lower == "/etc/shadow" || lower == "/etc/gshadow" || lower == "/etc/master.passwd" || lower == "/etc/sudoers" || lower.starts_with("/etc/sudoers.d") || lower.starts_with("/etc/security/") {
        return Some("a password or sudo file");
    }
    if lower.starts_with("/etc/ssh/ssh_host_") && !lower.ends_with(".pub") {
        return Some("a host key");
    }
    if lower.starts_with("/etc/ssl/private") || lower.starts_with("/etc/letsencrypt") || lower.starts_with("/etc/kubernetes") || lower.starts_with("/etc/rancher") || lower.starts_with("/var/lib/rancher") {
        return Some("a system credential");
    }
    if lower.starts_with("/var/run/secrets") || lower.starts_with("/run/secrets") {
        return Some("a mounted secret");
    }
    if lower == "/root" || lower.starts_with("/root/") {
        return Some("root's home");
    }
    if lower.starts_with("/proc/") {
        let rest = &lower[6..];
        let mut parts = rest.splitn(2, '/');
        let pid = parts.next().unwrap_or("");
        let file = parts.next().unwrap_or("");
        if (pid == "self" || pid == "thread-self" || pid.chars().all(|c| c.is_ascii_digit()) && !pid.is_empty()) && matches!(file, "environ" | "mem" | "maps" | "cmdline" | "auxv" | "stack") {
            // Another process's command line and environment hold other people's secrets.
            if matches!(file, "environ" | "mem" | "maps") {
                return Some("a process environment");
            }
        }
    }
    None
}

/// What a write to the path quietly changes beyond the file itself.
fn touchy(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase().replace('\\', "/");
    let comps: Vec<&str> = lower.split('/').filter(|c| !c.is_empty()).collect();
    let name = comps.last().copied().unwrap_or("");
    for (i, c) in comps.iter().enumerate() {
        if *c == ".git" && comps.get(i + 1).is_some_and(|n| matches!(*n, "hooks" | "config")) {
            return Some("a git hook or config, which runs on the next git command");
        }
        if matches!(*c, ".husky" | ".githooks") && i + 1 < comps.len() {
            return Some("a git hook");
        }
        if *c == ".claude" && comps.get(i + 1).is_some_and(|n| n.starts_with("settings") || *n == "hooks" || *n == "commands") {
            return Some("the agent's own settings");
        }
        if *c == ".config" && comps.get(i + 1).is_some_and(|n| matches!(*n, "systemd" | "autostart" | "fish")) {
            return Some("a start-up entry");
        }
        if *c == "launchagents" || *c == "launchdaemons" {
            return Some("a start-up entry");
        }
        if *c == "cron.d" || *c == "cron.daily" || *c == "cron.hourly" || *c == "crontabs" {
            return Some("a scheduled job");
        }
    }
    match name {
        ".bashrc" | ".bash_profile" | ".bash_login" | ".bash_logout" | ".profile" | ".zshrc" | ".zshenv" | ".zprofile" | ".zlogin" | ".zlogout" | ".kshrc" | ".cshrc" | ".tcshrc" | ".inputrc" | "config.fish" => Some("a shell start-up file"),
        ".gitconfig" | ".gitattributes" | ".gitmodules" => Some("git's configuration"),
        ".envrc" => Some("a direnv script"),
        ".claude.json" | ".mcp.json" | "mcp.json" => Some("the agent's tool configuration"),
        "authorized_keys" | "authorized_keys2" => Some("the ssh authorized keys"),
        "crontab" => Some("a scheduled job"),
        _ => None,
    }
}

/// A `host:` prefix, so `scp a b:c` names a remote path and `./a:b` a local one.
pub(crate) fn remote_operand(text: &str) -> bool {
    if text.starts_with('/') || text.starts_with('.') || text.starts_with('~') {
        return false;
    }
    match text.find(':') {
        Some(i) if i > 0 => {
            let host = &text[..i];
            // `c:\x`, `a:b` with a slash before the colon, and a lone letter are local.
            !host.contains('/') && host.len() > 1 && !text[i + 1..].starts_with("//") && host.chars().all(|c| c.is_alphanumeric() || "-_.@[]".contains(c))
        }
        _ => false,
    }
}
