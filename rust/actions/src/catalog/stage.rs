//! Copy files or a tree to another directory.

use crate::action::*;
use crate::catalog::{fold, outside};
use crate::state::{State, sha256};
use serde_json::json;
use std::path::{Path, PathBuf};

pub struct Stage;

static SPEC: Spec = Spec {
    id: "stage",
    version: 1,
    summary: "Copy files, a glob or a directory tree into another directory, keeping their contents.",
    triggers: &[
        r"\bcopy (the )?(contents|files?|everything|all|tree)\b",
        r"\bduplicate\b",
        r"\bmirror\b",
    ],
    inputs: &[
        Input {
            name: "from",
            ask: "",
            kind: Kind::Literal(r#"(?i)\bcopy\b[^`"'\n]*[`"']([\w./*-]+)[`"']"#),
            optional: false,
        },
        Input {
            name: "to",
            ask: "",
            kind: Kind::Literal(r#"(?i)\b(?:into|to)\s+[`"']([\w./-]+)[`"']"#),
            optional: false,
        },
    ],
    effect: Effect::Write,
    tools: &[],
    pure: false,
};

/// Files a source names: a file, a `dir/*.ext` glob, or every file under a directory, as (path, name under the destination).
fn sources(root: &Path, from: &str) -> Vec<(PathBuf, String)> {
    let base = fold(root, from);
    if let Some((dir, pat)) = from.rsplit_once('/').filter(|(_, p)| p.contains('*')) {
        let (pre, post) = pat.split_once('*').unwrap_or((pat, ""));
        return std::fs::read_dir(fold(root, dir))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_file() && !e.path().is_symlink())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(pre) && n.ends_with(post)
            })
            .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned()))
            .collect();
    }
    if base.is_symlink() {
        return Vec::new();
    }
    if base.is_file() {
        return base
            .file_name()
            .map(|n| vec![(base.clone(), n.to_string_lossy().into_owned())])
            .unwrap_or_default();
    }
    let mut out = Vec::new();
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if e.path().is_symlink() {
                continue;
            }
            if e.path().is_dir() {
                walk(&e.path(), &rel, out);
            } else {
                out.push((e.path(), rel));
            }
        }
    }
    walk(&base, "", &mut out);
    out
}

impl Action for Stage {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn effect(&self, state: &State, args: &Args) -> Effect {
        // Reading from outside the workspace is as consequential as writing outside it.
        let paths = [text(args, "to"), text(args, "from")];
        if paths.into_iter().flatten().any(|p| outside(&state.root, p)) {
            Effect::Outside
        } else {
            Effect::Write
        }
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let (from, to) = (
            text(args, "from").unwrap_or(""),
            text(args, "to").unwrap_or(""),
        );
        let found = sources(&state.root, from);
        let clash: Vec<&str> = found
            .iter()
            .filter(|(_, n)| fold(&state.root, to).join(n).exists())
            .map(|(_, n)| n.as_str())
            .collect();
        vec![
            Check::new(
                "something to copy",
                !found.is_empty(),
                format!("{} files", found.len()),
            ),
            Check::new(
                "nothing is overwritten",
                clash.is_empty(),
                format!("{clash:?}"),
            ),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Tree
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let (from, to) = (
            text(args, "from").ok_or("no source")?,
            text(args, "to").ok_or("no destination")?,
        );
        let dest = fold(&cx.root, to);
        let mut n = 0;
        for (src, name) in sources(&cx.root, from) {
            let target = dest.join(&name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::copy(&src, &target).map_err(|e| format!("{}: {e}", src.display()))?;
            n += 1;
        }
        Ok(Output {
            text: format!("copied {n} files into {to}"),
            data: json!({ "files": n, "dest": dest.to_string_lossy() }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(from), Some(dest)) = (text(args, "from"), out.data["dest"].as_str()) else {
            return Verdict::fail("no copy");
        };
        let found = sources(&cx.root, from);
        for (src, name) in &found {
            let (a, b) = (
                std::fs::read(src),
                std::fs::read(Path::new(dest).join(name)),
            );
            match (a, b) {
                (Ok(a), Ok(b)) if sha256(&a) == sha256(&b) => {}
                _ => return Verdict::fail(format!("{name} is missing or differs")),
            }
        }
        Verdict::pass(format!("{} files equal", found.len()))
    }
}
