//! Commit named files and push the branch.

use crate::action::*;
use crate::state::State;
use serde_json::json;

pub struct Publish;

static SPEC: Spec = Spec {
    id: "publish",
    version: 1,
    summary: "Commit the named files with a message and push the branch to a remote.",
    triggers: &[
        r"\bcommit\b.{0,200}\b(with|message|and push|then push)\b",
        r"\bpush\b.{0,200}\b(to|origin|branch|remote)\b",
    ],
    inputs: &[
        Input {
            name: "paths",
            ask: "",
            kind: Kind::Named(Source::Dirty),
            optional: false,
        },
        Input {
            name: "message",
            ask: "",
            kind: Kind::Literal(
                r#"(?i)\b(?:message|msg|saying|titled)\s+[`"\u{201c}]([^`"\u{201d}]+)[`"\u{201d}]"#,
            ),
            optional: false,
        },
        Input {
            name: "remote",
            ask: "",
            kind: Kind::Nth(Source::Remotes, 0),
            optional: true,
        },
        Input {
            name: "branch",
            ask: "",
            kind: Kind::Nth(Source::Branches, 0),
            optional: true,
        },
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

fn branch(state: &State, args: &Args) -> Option<String> {
    text(args, "branch")
        .map(str::to_string)
        .or_else(|| state.branch())
}

impl Action for Publish {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let paths = list(args, "paths");
        let dirty = state.dirty();
        let missing: Vec<&String> = paths.iter().filter(|p| !dirty.contains(p)).collect();
        let (r, b) = (remote(state, args), branch(state, args));
        vec![
            Check::new("repository", state.is_repo(), ""),
            Check::new("paths named", !paths.is_empty(), paths.join(",")),
            Check::new("paths changed", missing.is_empty(), format!("{missing:?}")),
            Check::new(
                "message",
                text(args, "message").is_some_and(|m| !m.trim().is_empty()),
                "",
            ),
            Check::new("remote", r.is_some(), r.unwrap_or_default()),
            Check::new(
                "branch is checked out",
                b.is_some() && b == state.branch(),
                b.unwrap_or_default(),
            ),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let state = cx.state();
        let paths = list(args, "paths");
        let message = text(args, "message").ok_or("no message")?;
        let remote = remote(&state, args).ok_or("no remote")?;
        let branch = branch(&state, args).ok_or("no branch")?;
        let mut add = vec!["git", "add", "--"];
        add.extend(paths.iter().map(String::as_str));
        cx.must(&add)?;
        let mut commit = vec!["git", "commit", "-q", "-m", message, "--"];
        commit.extend(paths.iter().map(String::as_str));
        cx.must(&commit)?;
        cx.must(&[
            "git",
            "push",
            "-q",
            &remote,
            &format!("{branch}:refs/heads/{branch}"),
        ])?;
        let head = cx.must(&["git", "rev-parse", "HEAD"])?.trim().to_string();
        Ok(Output {
            text: format!("pushed {} to {remote}/{branch}", &head[..7.min(head.len())]),
            data: json!({ "commit": head, "remote": remote, "branch": branch }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let state = cx.state();
        let (Some(commit), Some(remote), Some(branch)) = (
            out.data["commit"].as_str(),
            out.data["remote"].as_str(),
            out.data["branch"].as_str(),
        ) else {
            return Verdict::fail("no commit");
        };
        let tip = state
            .git(&["ls-remote", remote, &format!("refs/heads/{branch}")])
            .unwrap_or_default();
        if tip.split_whitespace().next() != Some(commit) {
            return Verdict::fail(format!("{remote}/{branch} is not at {commit}"));
        }
        let mut changed: Vec<String> = state
            .git(&["show", "--name-only", "--format=", commit])
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        changed.sort();
        let mut want = list(args, "paths");
        want.sort();
        if changed != want {
            return Verdict::fail(format!("commit changes {changed:?}, not {want:?}"));
        }
        let subject = state
            .git(&["show", "-s", "--format=%s", commit])
            .unwrap_or_default();
        if Some(subject.as_str()) != text(args, "message") {
            return Verdict::fail(format!("subject is {subject:?}"));
        }
        Verdict::pass(format!(
            "{remote}/{branch} at {}",
            &commit[..7.min(commit.len())]
        ))
    }
}
