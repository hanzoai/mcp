//! What an action reads of the workspace: the request, and the repository around it.
//!
//! Everything here is read-only. The revision it reports (HEAD, and the uncommitted changes)
//! is what an action's preconditions are checked against, and checked again just before it runs.

use crate::exec::{git, run, Out};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A value an input may take, and the sentence Kai reads to tell it from the others.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cand {
    pub value: String,
    pub label: String,
    /// Other spellings a request may use for it (a file's name without its directory, a commit's short hash).
    pub aliases: Vec<String>,
}

impl Cand {
    pub fn new(value: &str, label: &str) -> Cand {
        Cand {
            value: value.to_string(),
            label: label.to_string(),
            aliases: Vec::new(),
        }
    }
}

pub struct State {
    /// The directory the request is made in.
    pub root: PathBuf,
    pub request: String,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "__pycache__",
    ".venv",
    ".pytest_cache",
];

impl State {
    pub fn new(root: &Path, request: &str) -> State {
        State {
            root: root.to_path_buf(),
            request: request.to_string(),
        }
    }

    pub fn git(&self, args: &[&str]) -> Result<String, String> {
        git(&self.root, args)
    }

    pub fn is_repo(&self) -> bool {
        self.git(&["rev-parse", "--git-dir"]).is_ok()
    }

    pub fn head(&self) -> Option<String> {
        self.git(&["rev-parse", "HEAD"]).ok()
    }

    pub fn branch(&self) -> Option<String> {
        self.git(&["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .filter(|b| !b.is_empty())
    }

    /// The commit and the uncommitted work, as one string: it changes when either does.
    pub fn revision(&self) -> String {
        let Some(head) = self.head() else {
            return format!("tree:{}", &self.tree_digest()[..12]);
        };
        let dirty = self.dirty();
        if dirty.is_empty() {
            return format!("git:{}", &head[..12.min(head.len())]);
        }
        let mut h = Sha256::new();
        for path in &dirty {
            h.update(path.as_bytes());
            h.update(std::fs::read(self.root.join(path)).unwrap_or_default());
        }
        format!(
            "git:{}+{}",
            &head[..12.min(head.len())],
            &hex(&h.finalize())[..8]
        )
    }

    fn tree_digest(&self) -> String {
        let mut h = Sha256::new();
        for path in self.files() {
            h.update(path.as_bytes());
            h.update(std::fs::read(self.root.join(&path)).unwrap_or_default());
        }
        hex(&h.finalize())
    }

    /// Modified, staged and untracked paths (not ignored), relative to the root.
    pub fn dirty(&self) -> Vec<String> {
        let Ok(out) = run(
            &self.root,
            &[
                "git",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                ".",
            ],
            Duration::from_secs(30),
        ) else {
            return Vec::new();
        };
        if !out.ok() {
            return Vec::new();
        }
        let mut paths = Vec::new();
        let mut parts = out.stdout.split('\0').filter(|p| p.len() > 3);
        while let Some(entry) = parts.next() {
            let (code, path) = entry.split_at(3);
            if code.starts_with('R') {
                parts.next();
            }
            paths.push(path.to_string());
        }
        paths.sort();
        paths
    }

    /// Tracked files and untracked files that are not ignored, relative to the root.
    pub fn files(&self) -> Vec<String> {
        let listed = run(
            &self.root,
            &["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            Duration::from_secs(30),
        )
        .ok()
        .filter(Out::ok);
        if let Some(out) = listed {
            let mut v: Vec<String> = out
                .stdout
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect();
            v.retain(|p| self.root.join(p).is_file());
            v.sort();
            return v;
        }
        let mut v = Vec::new();
        walk(&self.root, &self.root, &mut v);
        v.sort();
        v
    }

    pub fn branches(&self) -> Vec<Cand> {
        let Ok(out) = self.git(&[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)",
            "refs/heads",
        ]) else {
            return Vec::new();
        };
        out.lines()
            .filter_map(|l| {
                let mut f = l.splitn(3, '\t');
                let (name, sha, subject) = (f.next()?, f.next()?, f.next().unwrap_or(""));
                Some(Cand::new(
                    name,
                    &format!("branch {name}, at {sha}: {subject}"),
                ))
            })
            .collect()
    }

    pub fn remotes(&self) -> Vec<Cand> {
        let Ok(out) = self.git(&["remote"]) else {
            return Vec::new();
        };
        out.lines()
            .filter(|l| !l.is_empty())
            .map(|r| Cand::new(r, &format!("remote {r}")))
            .collect()
    }

    /// The last `n` commits on HEAD, newest first.
    pub fn commits(&self, n: usize) -> Vec<Cand> {
        let limit = format!("-{n}");
        let Ok(out) = self.git(&["log", &limit, "--format=%H\t%h\t%s"]) else {
            return Vec::new();
        };
        out.lines()
            .filter_map(|l| {
                let mut f = l.splitn(3, '\t');
                let (full, short, subject) = (f.next()?, f.next()?, f.next().unwrap_or(""));
                let mut c = Cand::new(full, &format!("{short} {subject}"));
                c.aliases.push(short.to_string());
                Some(c)
            })
            .collect()
    }

    /// Files with a name ending in one of `exts`.
    pub fn with_ext(&self, exts: &[&str]) -> Vec<String> {
        self.files()
            .into_iter()
            .filter(|f| exts.iter().any(|e| f.ends_with(e)))
            .collect()
    }

    /// Test suites the repository declares: a runner and the directory it runs.
    pub fn suites(&self) -> Vec<Cand> {
        crate::catalog::suite::detect(self)
    }
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(root, &path, out);
            }
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of `bytes`, lowercase hex.
pub fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
