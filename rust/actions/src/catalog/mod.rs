//! The actions Dev ships.

use crate::action::{Action, Input, Kind};
use std::path::{Component, Path, PathBuf};

pub mod ahead;
pub mod changed;
pub mod find;
pub mod listen;
pub mod note;
pub mod pairs;
pub mod publish;
pub mod rebuild;
pub mod slice;
pub mod stage;
pub mod stop;
pub mod suite;
pub mod sync;
pub mod touched;
pub mod wait;
pub mod worktree;

/// Every action, in the order Kai is shown them.
pub fn all() -> &'static [&'static dyn Action] {
    &[
        &find::Find,
        &slice::Slice,
        &touched::Touched,
        &ahead::Ahead,
        &changed::Changed,
        &worktree::Worktree,
        &publish::Publish,
        &sync::Sync,
        &suite::Suite,
        &rebuild::Rebuild,
        &wait::Wait,
        &listen::Listen,
        &stop::Stop,
        &pairs::Pairs,
        &note::Note,
        &stage::Stage,
    ]
}

pub fn get(id: &str) -> Option<&'static dyn Action> {
    all().iter().copied().find(|a| a.spec().id == id)
}

/// The report every answering action takes: a file the request names.
pub const REPORT: Input = Input {
    name: "report",
    ask: "",
    kind: Kind::Literal(r#"(?i)\b(?:to|into|in)\s+[`"']?([\w./-]+\.txt)"#),
    optional: true,
};

/// `path` resolved against `root`, `..` and `.` folded away without touching the disk.
pub fn fold(root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `path` lies outside `root`.
pub fn outside(root: &Path, path: &str) -> bool {
    !fold(root, path).starts_with(fold(root, "."))
}

pub fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotdot_leaves_the_root() {
        let root = Path::new("/w/ws");
        assert!(outside(root, "../wt"));
        assert!(!outside(root, "sub/../x"));
        assert!(outside(root, "/tmp/x"));
        assert!(!outside(root, "build/pinned"));
    }

    #[test]
    fn every_action_has_a_unique_id_and_a_version() {
        let mut ids: Vec<&str> = all().iter().map(|a| a.spec().id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        assert!(
            all()
                .iter()
                .all(|a| a.spec().version >= 1 && !a.spec().summary.is_empty())
        );
    }
}
