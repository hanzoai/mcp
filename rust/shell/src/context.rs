//! Where a command would run, as far as the classifier may know it.

use std::sync::Arc;

/// Reads the files a command names, so a script the command runs can be read as well. Absent
/// (the wasm build, a caller with no disk), a script is judged by where it lives alone.
pub trait Files: Send + Sync {
    /// The text of the regular file at the absolute `path`, when it exists, is UTF-8 and holds
    /// at most `max` bytes.
    fn read(&self, path: &str, max: usize) -> Option<String>;
}

/// The directories that are scratch space by default.
pub const TEMP: &[&str] = &["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/var/folders", "/dev/shm"];

#[derive(Clone)]
pub struct Context {
    /// The absolute directory the command runs in. With none, a relative path is taken to be
    /// in the workspace, which is what a caller with no directory means by one.
    pub cwd: Option<String>,
    /// The person's home directory, for `~` and `$HOME`.
    pub home: Option<String>,
    /// Directories beside `cwd` that count as the workspace.
    pub roots: Vec<String>,
    /// Scratch directories: written freely, and recursively removed under.
    pub temp: Vec<String>,
    /// How to read a script the command runs.
    pub files: Option<Arc<dyn Files>>,
    /// The command runs on another machine (`ssh host …`): nothing there is the workspace.
    pub remote: bool,
}

impl Default for Context {
    fn default() -> Self {
        Context { cwd: None, home: None, roots: Vec::new(), temp: TEMP.iter().map(|s| s.to_string()).collect(), files: None, remote: false }
    }
}

impl Context {
    pub fn new(cwd: Option<&str>, home: Option<&str>) -> Context {
        Context { cwd: cwd.map(str::to_string), home: home.map(str::to_string), ..Context::default() }
    }

    pub fn root(mut self, root: impl Into<String>) -> Context {
        self.roots.push(root.into());
        self
    }

    /// What the answer depends on besides the command text: the cache key's second half. A
    /// script read through `files` is not in it, so a command that read one is not cached.
    pub(crate) fn key(&self) -> String {
        let mut key = String::new();
        for part in [self.cwd.as_deref().unwrap_or("\u{1}"), self.home.as_deref().unwrap_or("\u{1}")] {
            key.push_str(part);
            key.push('\0');
        }
        key.push(if self.remote { 'r' } else { 'l' });
        for r in self.roots.iter().chain(&self.temp) {
            key.push('\0');
            key.push_str(r);
        }
        key
    }
}
