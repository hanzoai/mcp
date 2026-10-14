//! Rebuild a pinned copy of the project from a commit.

use crate::action::*;
use crate::catalog::{REPORT, fold, outside};
use crate::state::State;
use serde_json::json;

pub struct Rebuild;

static SPEC: Spec = Spec {
    id: "rebuild",
    version: 1,
    summary: "Rebuild a pinned copy of the project from one commit into a directory, with the project's own build script.",
    triggers: &[
        r"rebuild",
        r"pinned (copy|build)",
        r"build (it |the \w+ )?(from|at) (the )?commit",
        r"\barchive\b",
    ],
    inputs: &[
        Input {
            name: "commit",
            ask: "Which commit should the copy be built from?",
            kind: Kind::Pick(Source::Commits),
            optional: false,
        },
        Input {
            name: "dest",
            ask: "",
            kind: Kind::Literal(r#"(?i)\b(?:into|in|at|to)\s+[`"']([\w./-]+)[`"']"#),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Write,
    tools: &["git", "tar", "sh"],
    pure: false,
};

fn builder(state: &State, commit: &str) -> Option<&'static [&'static str]> {
    let listing = state.git(&["ls-tree", "--name-only", commit]).ok()?;
    let has = |n: &str| listing.lines().any(|l| l == n);
    if has("build.sh") {
        Some(&["sh", "build.sh"])
    } else if has("Makefile") {
        Some(&["make"])
    } else {
        None
    }
}

impl Action for Rebuild {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn effect(&self, state: &State, args: &Args) -> Effect {
        match text(args, "dest") {
            Some(d) if outside(&state.root, d) => Effect::Outside,
            _ => Effect::Write,
        }
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let commit = text(args, "commit").unwrap_or("");
        let dest = fold(&state.root, text(args, "dest").unwrap_or(""));
        let empty =
            !dest.exists() || std::fs::read_dir(&dest).is_ok_and(|mut d| d.next().is_none());
        vec![
            Check::new(
                "commit",
                state
                    .git(&["cat-file", "-e", &format!("{commit}^{{commit}}")])
                    .is_ok(),
                commit,
            ),
            Check::new("destination is free", empty, dest.display().to_string()),
            Check::new(
                "a build script",
                builder(state, commit).is_some(),
                "build.sh or Makefile at the commit",
            ),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let state = cx.state();
        let commit = text(args, "commit").ok_or("no commit")?;
        let dest = fold(&cx.root, text(args, "dest").ok_or("no destination")?);
        let dest_s = dest.to_string_lossy().into_owned();
        let build = builder(&state, commit).ok_or("no build script")?;
        std::fs::create_dir_all(&dest).map_err(|e| format!("{dest_s}: {e}"))?;
        let tar = format!("{dest_s}.tar");
        cx.must(&["git", "archive", "--format=tar", "-o", &tar, commit])?;
        let unpacked = cx.must(&["tar", "-x", "-f", &tar, "-C", &dest_s]);
        let _ = std::fs::remove_file(&tar);
        unpacked?;
        let sha = state.git(&["rev-parse", commit])?;
        let mut cx_dest = Cx::new(dest.clone(), cx.home.clone(), &cx.request);
        cx_dest.must(build)?;
        cx.steps.append(&mut cx_dest.steps);
        std::fs::write(dest.join(".commit"), format!("{sha}\n")).map_err(|e| e.to_string())?;
        let body = format!(
            "built {} from {} into {dest_s}",
            dest.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            &sha[..7.min(sha.len())]
        );
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: json!({ "path": dest_s, "commit": sha }),
        })
    }

    fn verify(&self, cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let (Some(path), Some(sha)) = (out.data["path"].as_str(), out.data["commit"].as_str())
        else {
            return Verdict::fail("no copy");
        };
        let dest = std::path::Path::new(path);
        if std::fs::read_to_string(dest.join(".commit"))
            .unwrap_or_default()
            .trim()
            != sha
        {
            return Verdict::fail(".commit does not name the commit");
        }
        let built = std::fs::read_dir(dest.join("dist")).is_ok_and(|mut d| d.next().is_some());
        if !built {
            return Verdict::fail("dist/ is missing or empty");
        }
        match cx.state().git(&["show", &format!("{sha}:VERSION")]) {
            Ok(v) => {
                let carries = std::fs::read_dir(dest.join("dist"))
                    .map(|d| {
                        d.flatten().any(|e| {
                            std::fs::read_to_string(e.path()).is_ok_and(|b| b.contains(v.trim()))
                        })
                    })
                    .unwrap_or(false);
                if carries {
                    Verdict::pass(format!("dist carries {}", v.trim()))
                } else {
                    Verdict::fail(format!("no file of dist/ carries version {}", v.trim()))
                }
            }
            Err(_) => Verdict::pass("dist built"),
        }
    }
}
