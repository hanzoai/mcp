//! The shell command classifier, installed behind `exec`: `hanzo-shell` reads the command as a
//! shell does, and this file lends it the machine it runs on: the home directory, the roots
//! the server may work under, and the disk, so a script a command runs is read before it runs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use hanzo_shell::{Classifier, Context, Files, Risk as Found};

use super::verdict::{Classify, Risk, Verdict};

/// Reads scripts from the disk, regular files only, up to a limit.
struct Disk;

impl Files for Disk {
    fn read(&self, path: &str, max: usize) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || meta.len() as usize > max {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }
}

/// The classifier `exec` asks. It remembers what it has read, per command and directory.
pub struct Shell {
    inner: Classifier,
    roots: RwLock<Vec<String>>,
    home: Option<String>,
    files: Arc<Disk>,
}

impl Shell {
    /// Roots come from `HANZO_MCP_ROOTS` (colon-separated) and from `add_root`, beside the
    /// directory a command runs in.
    pub fn new() -> Shell {
        let roots = std::env::var("HANZO_MCP_ROOTS").map(|v| v.split(':').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default();
        Shell { inner: Classifier::new(), roots: RwLock::new(roots), home: dirs::home_dir().map(|h| h.to_string_lossy().to_string()), files: Arc::new(Disk) }
    }

    /// Counts `root` as part of the workspace (`--project-dir`).
    pub fn add_root(&self, root: impl AsRef<Path>) {
        let root = root.as_ref();
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if let Ok(mut r) = self.roots.write() {
            r.push(root.to_string_lossy().to_string());
        }
    }

    fn context(&self, cwd: Option<&Path>) -> Context {
        let here = cwd.map(PathBuf::from).or_else(|| std::env::current_dir().ok());
        let here = here.map(|p| if p.is_absolute() { p } else { std::env::current_dir().map(|c| c.join(&p)).unwrap_or(p) });
        // The workspace is the real directory, so a link to somewhere else is not mistaken for inside.
        let here = here.map(|p| std::fs::canonicalize(&p).unwrap_or(p));
        let mut ctx = Context::new(here.as_deref().and_then(|p| p.to_str()), self.home.as_deref());
        if let Ok(r) = self.roots.read() {
            ctx.roots = r.clone();
        }
        ctx.files = Some(self.files.clone());
        ctx
    }
}

impl Default for Shell {
    fn default() -> Self {
        Shell::new()
    }
}

fn verdict(r: hanzo_shell::Report) -> Verdict {
    let risk = match r.risk {
        Found::Allow => Risk::Allow,
        Found::Ask => Risk::Ask,
        Found::Deny => Risk::Deny,
    };
    Verdict::new(risk, r.reasons())
}

impl Classify for Shell {
    fn classify(&self, command: &str, cwd: Option<&Path>) -> Verdict {
        verdict(self.inner.classify(command, &self.context(cwd)))
    }

    fn classify_env(&self, env: &HashMap<String, String>) -> Verdict {
        verdict(hanzo_shell::environment(env.iter().map(|(k, v)| (k.as_str(), v.as_str())), &self.context(None)))
    }
}
