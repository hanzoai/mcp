//! The files a commit changed.

use crate::action::*;
use crate::catalog::{REPORT, lines};
use crate::state::State;

pub struct Changed;

static SPEC: Spec = Spec {
    id: "changed",
    version: 1,
    summary: "List the files a given commit changed.",
    triggers: &[
        r"files? (changed|touched|modified|edited) (in|by)",
        r"what (files )?(did|does) .*commit",
        r"changed in (the )?commit",
        r"touched by",
    ],
    inputs: &[
        Input {
            name: "commit",
            ask: "Which commit does the request refer to?",
            kind: Kind::Pick(Source::Commits),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &["git"],
    pure: true,
};

impl Action for Changed {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let c = text(args, "commit").unwrap_or("");
        vec![Check::new(
            "commit",
            state
                .git(&["cat-file", "-e", &format!("{c}^{{commit}}")])
                .is_ok(),
            c,
        )]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let commit = text(args, "commit").ok_or("no commit")?;
        let body = cx.must(&["git", "show", "--name-only", "--format=", commit])?;
        let mut files = lines(&body);
        files.retain(|f| !f.is_empty());
        files.sort();
        let body = files.join("\n");
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: serde_json::Value::Null,
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let Some(commit) = text(args, "commit") else {
            return Verdict::fail("no commit");
        };
        match cx.state().git(&[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "--root",
            commit,
        ]) {
            Ok(list) if list.lines().count() == lines(&out.text).len() && !out.text.is_empty() => {
                Verdict::pass(format!("{} files", list.lines().count()))
            }
            Ok(list) => Verdict::fail(format!("{} files expected", list.lines().count())),
            Err(e) => Verdict::fail(e),
        }
    }
}
