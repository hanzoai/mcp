//! The commits one branch has that another does not.

use crate::action::*;
use crate::catalog::{REPORT, lines};
use crate::state::State;

pub struct Ahead;

static SPEC: Spec = Spec {
    id: "ahead",
    version: 1,
    summary: "List the commits on one branch that another branch does not have.",
    triggers: &[
        r"not (yet )?(on|in|merged)",
        r"ahead of",
        r"unmerged",
        r"missing from",
        r"does(n't| not) have",
        r"not in\b",
    ],
    inputs: &[
        Input {
            name: "branch",
            ask: "",
            kind: Kind::Nth(Source::Branches, 0),
            optional: false,
        },
        Input {
            name: "base",
            ask: "",
            kind: Kind::Nth(Source::Branches, 1),
            optional: true,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &["git"],
    pure: true,
};

/// The branch a request without a base means: main, master or trunk, whichever exists.
fn trunk(state: &State, not: &str) -> Option<String> {
    let have = state.branches();
    ["main", "master", "trunk"]
        .iter()
        .find(|b| **b != not && have.iter().any(|c| c.value == **b))
        .map(|b| (*b).to_string())
}

fn base(state: &State, args: &Args) -> Option<String> {
    text(args, "base")
        .map(str::to_string)
        .or_else(|| trunk(state, text(args, "branch").unwrap_or("")))
}

impl Action for Ahead {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let b = base(state, args);
        vec![
            Check::new("repository", state.is_repo(), ""),
            Check::new("base", b.is_some(), b.unwrap_or_default()),
            Check::new("distinct", text(args, "branch") != text(args, "base"), ""),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let branch = text(args, "branch").ok_or("no branch")?;
        let base = base(&cx.state(), args).ok_or("no base branch")?;
        let range = format!("{base}..{branch}");
        let body = cx.must(&["git", "log", "--format=%h %s", &range])?;
        let body = body.trim_end().to_string();
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: serde_json::Value::Null,
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(branch), Some(base)) = (text(args, "branch"), base(&cx.state(), args)) else {
            return Verdict::fail("no range");
        };
        let range = format!("{base}..{branch}");
        match cx.state().git(&["rev-list", "--count", &range]) {
            Ok(n) if n.parse::<usize>().ok() == Some(lines(&out.text).len()) => {
                Verdict::pass(format!("{n} commits"))
            }
            Ok(n) => Verdict::fail(format!("{n} commits expected")),
            Err(e) => Verdict::fail(e),
        }
    }
}
