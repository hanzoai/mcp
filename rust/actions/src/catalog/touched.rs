//! The last commit that changed a file.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;

pub struct Touched;

static SPEC: Spec = Spec {
    id: "touched",
    version: 1,
    summary: "Report the last commit that changed one file: its short hash and subject.",
    triggers: &[
        r"last (commit|change|time)",
        r"who (last )?(changed|modified|touched)",
        r"last (touched|modified|changed)",
        r"most recent commit",
    ],
    inputs: &[
        Input {
            name: "path",
            ask: "Which file does the request refer to?",
            kind: Kind::Pick(Source::Files),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &["git"],
    pure: true,
};

impl Action for Touched {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let path = text(args, "path").unwrap_or("");
        vec![
            Check::new("repository", state.is_repo(), ""),
            Check::new("file", state.root.join(path).is_file(), path),
        ]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Git
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let path = text(args, "path").ok_or("no path")?;
        let line = cx.must(&["git", "log", "-1", "--format=%h %s", "--", path])?;
        let line = line.trim().to_string();
        report(cx, args, &line)?;
        Ok(Output {
            text: line,
            data: serde_json::Value::Null,
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(path), Some(sha)) = (text(args, "path"), out.text.split_whitespace().next())
        else {
            return Verdict::fail("no commit");
        };
        match cx.state().git(&["show", "--name-only", "--format=", sha]) {
            Ok(files) if files.lines().any(|f| f == path) => {
                Verdict::pass(format!("{sha} changes {path}"))
            }
            Ok(_) => Verdict::fail(format!("{sha} does not change {path}")),
            Err(e) => Verdict::fail(e),
        }
    }
}
