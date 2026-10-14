//! A range of lines of a file.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;

pub struct Slice;

static SPEC: Spec = Spec {
    id: "slice",
    version: 1,
    summary: "Show a range of lines of one file: lines N to M.",
    triggers: &[
        r"\blines?\s+\d+",
        r"\bfirst\s+\d+\s+lines\b",
        r"\bline range\b",
    ],
    inputs: &[
        Input {
            name: "path",
            ask: "Which file does the request refer to?",
            kind: Kind::Pick(Source::Files),
            optional: false,
        },
        Input {
            name: "from",
            ask: "",
            kind: Kind::Literal(r"(?i)\blines?\s+(\d+)"),
            optional: false,
        },
        Input {
            name: "to",
            ask: "",
            kind: Kind::Literal(r"(?i)\blines?\s+\d+\s*(?:-|\u{2013}|to|through|and)\s*(\d+)"),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &[],
    pure: true,
};

fn number(args: &Args, name: &str) -> Option<usize> {
    text(args, name)?.parse().ok().filter(|n| *n >= 1)
}

impl Action for Slice {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let path = text(args, "path").unwrap_or("");
        let (from, to) = (number(args, "from"), number(args, "to"));
        vec![
            Check::new("file", state.root.join(path).is_file(), path),
            Check::new(
                "range",
                matches!((from, to), (Some(a), Some(b)) if a <= b),
                format!("{from:?}..{to:?}"),
            ),
        ]
    }

    fn reads(&self, _state: &State, args: &Args) -> Reads {
        Reads::Files(
            text(args, "path")
                .map(|p| vec![p.to_string()])
                .unwrap_or_default(),
        )
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let path = text(args, "path").ok_or("no path")?;
        let (from, to) = (
            number(args, "from").ok_or("no start")?,
            number(args, "to").ok_or("no end")?,
        );
        let body = std::fs::read_to_string(cx.path(path)).map_err(|e| format!("{path}: {e}"))?;
        let got: Vec<&str> = body.lines().skip(from - 1).take(to - from + 1).collect();
        // Every line ends in a newline, so a range that ends on a blank line keeps it.
        let text_out: String = got.iter().map(|l| format!("{l}\n")).collect();
        report(cx, args, &text_out)?;
        Ok(Output {
            text: text_out,
            data: serde_json::json!({ "lines": got.len() }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(path), Some(from), Some(to)) =
            (text(args, "path"), number(args, "from"), number(args, "to"))
        else {
            return Verdict::fail("no range");
        };
        let total = std::fs::read_to_string(cx.path(path))
            .map(|b| b.lines().count())
            .unwrap_or(0);
        let want = to.min(total).saturating_sub(from - 1);
        let got = out.text.lines().count();
        if want == 0 {
            Verdict::fail(format!("{path} has {total} lines, fewer than {from}"))
        } else if got == want {
            Verdict::pass(format!("{got} lines"))
        } else {
            Verdict::fail(format!("{got} lines, want {want}"))
        }
    }
}
