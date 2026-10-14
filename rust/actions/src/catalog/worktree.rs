//! A git worktree on a new branch.

use crate::action::*;
use crate::catalog::{fold, outside};
use crate::state::State;
use serde_json::json;

pub struct Worktree;

static SPEC: Spec = Spec {
    id: "worktree",
    version: 1,
    summary: "Create a git worktree on a new branch at a path, optionally branched off a named base branch.",
    triggers: &[r"\bworktrees?\b"],
    inputs: &[
        Input {
            name: "branch",
            ask: "",
            kind: Kind::Literal(
                r#"(?i)\bbranch(?:\s+named|\s+called)?\s+[`"']([\w./-]+)[`"']|\bworktree\s+(?:for|on)\s+[`"']([\w./-]+)[`"']"#,
            ),
            optional: false,
        },
        Input {
            name: "path",
            ask: "",
            kind: Kind::Literal(r#"(?i)\b(?:at|in|under|into)\s+[`"']([\w./-]+)[`"']"#),
            optional: false,
        },
        Input {
            name: "base",
            ask: "Which branch should the new branch start from?",
            kind: Kind::Nth(Source::Branches, 0),
            optional: true,
        },
    ],
    effect: Effect::Write,
    tools: &["git"],
    pure: false,
};

impl Action for Worktree {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn effect(&self, state: &State, args: &Args) -> Effect {
        match text(args, "path") {
            Some(p) if outside(&state.root, p) => Effect::Outside,
            _ => Effect::Write,
        }
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let branch = text(args, "branch").unwrap_or("");
        let path = text(args, "path").unwrap_or("");
        let target = fold(&state.root, path);
        let base_ok = text(args, "base").is_none_or(|b| {
            state
                .git(&["rev-parse", "--verify", "-q", &format!("{b}^{{commit}}")])
                .is_ok()
        });
        vec![
            Check::new("repository", state.is_repo(), ""),
            Check::new(
                "branch name",
                !branch.is_empty() && state.git(&["check-ref-format", "--branch", branch]).is_ok(),
                branch,
            ),
            Check::new(
                "branch is new",
                state
                    .git(&[
                        "rev-parse",
                        "--verify",
                        "-q",
                        &format!("refs/heads/{branch}"),
                    ])
                    .is_err(),
                branch,
            ),
            Check::new(
                "path is free",
                !target.exists(),
                target.display().to_string(),
            ),
            Check::new("base", base_ok, text(args, "base").unwrap_or("HEAD")),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let (branch, path) = (
            text(args, "branch").ok_or("no branch")?,
            text(args, "path").ok_or("no path")?,
        );
        let target = fold(&cx.root, path);
        let target_s = target.to_string_lossy().into_owned();
        let mut argv = vec!["git", "worktree", "add", "-b", branch, &target_s];
        if let Some(base) = text(args, "base") {
            argv.push(base);
        }
        cx.must(&argv)?;
        let head = cx
            .must(&["git", "-C", &target_s, "rev-parse", "HEAD"])?
            .trim()
            .to_string();
        Ok(Output {
            text: format!(
                "worktree {target_s} on {branch} at {}",
                &head[..7.min(head.len())]
            ),
            data: json!({ "path": target_s, "branch": branch, "head": head }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(branch), Some(path)) = (text(args, "branch"), out.data["path"].as_str()) else {
            return Verdict::fail("no worktree");
        };
        let list = match cx.state().git(&["worktree", "list", "--porcelain"]) {
            Ok(l) => l,
            Err(e) => return Verdict::fail(e),
        };
        let listed = list.split("\n\n").any(|block| {
            block.lines().any(|l| l == format!("worktree {path}"))
                && block
                    .lines()
                    .any(|l| l == format!("branch refs/heads/{branch}"))
        });
        let want = text(args, "base").unwrap_or("HEAD");
        let base = cx.state().git(&["rev-parse", want]).unwrap_or_default();
        let head = out.data["head"].as_str().unwrap_or("");
        match (listed, base == head) {
            (true, true) => Verdict::pass(format!("{path} on {branch}")),
            (false, _) => Verdict::fail("git does not list the worktree on that branch"),
            (_, false) => Verdict::fail(format!("worktree starts at {head}, not {base}")),
        }
    }
}
