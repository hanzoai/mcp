//! Fast-forward the current branch from its remote.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;
use serde_json::json;

pub struct Sync;

static SPEC: Spec = Spec {
    id: "sync",
    version: 1,
    summary: "Fast-forward the current branch from its remote and report how many commits came in.",
    triggers: &[
        r"fast-?forward",
        r"\bsync\b",
        r"catch up",
        r"bring .* up to date",
        r"update .* from (origin|upstream|the remote)",
        r"\bpull\b",
    ],
    inputs: &[
        Input {
            name: "remote",
            ask: "",
            kind: Kind::Nth(Source::Remotes, 0),
            optional: true,
        },
        REPORT,
    ],
    effect: Effect::Remote,
    tools: &["git"],
    pure: false,
};

fn remote(state: &State, args: &Args) -> Option<String> {
    text(args, "remote").map(str::to_string).or_else(|| {
        let all = state.remotes();
        all.iter()
            .find(|r| r.value == "origin")
            .or(all.first())
            .map(|r| r.value.clone())
    })
}

impl Action for Sync {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let tracked_dirty = state
            .git(&["status", "--porcelain", "--untracked-files=no"])
            .map(|s| !s.is_empty())
            .unwrap_or(true);
        vec![
            Check::new("repository", state.is_repo(), ""),
            Check::new(
                "on a branch",
                state.branch().is_some(),
                state.branch().unwrap_or_default(),
            ),
            Check::new(
                "remote",
                remote(state, args).is_some(),
                remote(state, args).unwrap_or_default(),
            ),
            Check::new("tracked files clean", !tracked_dirty, ""),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let state = cx.state();
        let remote = remote(&state, args).ok_or("no remote")?;
        let branch = state.branch().ok_or("not on a branch")?;
        let before = cx.must(&["git", "rev-parse", "HEAD"])?.trim().to_string();
        cx.must(&["git", "fetch", "-q", &remote])?;
        cx.must(&[
            "git",
            "merge",
            "-q",
            "--ff-only",
            &format!("{remote}/{branch}"),
        ])?;
        let after = cx.must(&["git", "rev-parse", "HEAD"])?.trim().to_string();
        let count = cx
            .must(&["git", "rev-list", "--count", &format!("{before}..{after}")])?
            .trim()
            .to_string();
        let body = format!("new={count} head={}", &after[..7.min(after.len())]);
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: json!({ "new": count, "head": after, "remote": remote, "branch": branch }),
        })
    }

    fn verify(&self, cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let (Some(head), Some(remote), Some(branch)) = (
            out.data["head"].as_str(),
            out.data["remote"].as_str(),
            out.data["branch"].as_str(),
        ) else {
            return Verdict::fail("no head");
        };
        match cx
            .state()
            .git(&["rev-parse", &format!("{remote}/{branch}")])
        {
            Ok(tip) if tip == head => Verdict::pass(format!("at {remote}/{branch}")),
            Ok(tip) => Verdict::fail(format!("{remote}/{branch} is at {tip}")),
            Err(e) => Verdict::fail(e),
        }
    }
}
