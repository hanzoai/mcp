//! Where a symbol is defined or used.

use crate::action::*;
use crate::catalog::{REPORT, lines};
use crate::state::State;
use regex::Regex;

pub struct Find;

static SPEC: Spec = Spec {
    id: "find",
    version: 1,
    summary: "Find where a symbol or string is defined or used in the repository and list each place as path:line.",
    triggers: &[
        r"\b(uses?|used|usages? of|callers?|references?|occurrences?|mentions?|defined|definition|declared|where is|where are|who calls|grep|locate)\b",
    ],
    inputs: &[
        Input {
            name: "symbol",
            ask: "",
            kind: Kind::Literal(r#"[`"]([A-Za-z_][\w.:$-]*)[`"]"#),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &[],
    pure: true,
};

fn defining(request: &str) -> bool {
    let r = request.to_lowercase();
    r.contains("defin") || r.contains("declar")
}

fn pattern(symbol: &str, defs: bool) -> Result<Regex, String> {
    let s = regex::escape(symbol);
    let p = if defs {
        format!(
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:async\s+)?(?:default\s+)?(?:def|fn|func|function|class|struct|enum|trait|type|const|let|var|interface|impl|static)\s+(?:\([^)]*\)\s*)?{s}\b"
        )
    } else {
        format!(r"\b{s}\b")
    };
    Regex::new(&p).map_err(|e| e.to_string())
}

fn search(state: &State, symbol: &str) -> Result<Vec<String>, String> {
    let re = pattern(symbol, defining(&state.request))?;
    let mut hits = Vec::new();
    for path in state.files() {
        let Ok(meta) = std::fs::metadata(state.root.join(&path)) else {
            continue;
        };
        if meta.len() > 2_000_000 {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(state.root.join(&path)) else {
            continue;
        };
        for (i, line) in body.lines().enumerate() {
            if re.is_match(line) {
                hits.push(format!("{path}:{}", i + 1));
            }
        }
    }
    Ok(hits)
}

impl Action for Find {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, _state: &State, args: &Args) -> Vec<Check> {
        let symbol = text(args, "symbol").unwrap_or("");
        vec![Check::new(
            "symbol",
            !symbol.is_empty() && pattern(symbol, false).is_ok(),
            symbol,
        )]
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let state = cx.state();
        let symbol = text(args, "symbol").ok_or("no symbol")?;
        let hits = search(&state, symbol)?;
        let body = hits.join("\n");
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: serde_json::json!({ "places": hits.len() }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let Some(symbol) = text(args, "symbol") else {
            return Verdict::fail("no symbol");
        };
        let places = lines(&out.text);
        if places.is_empty() {
            return Verdict::fail(format!("no place holds {symbol}"));
        }
        for place in &places {
            let Some((path, line)) = place.rsplit_once(':') else {
                return Verdict::fail(format!("{place}: not path:line"));
            };
            let n: usize = line.parse().unwrap_or(0);
            let body = std::fs::read_to_string(cx.path(path)).unwrap_or_default();
            if !body
                .lines()
                .nth(n.saturating_sub(1))
                .is_some_and(|l| l.contains(symbol))
            {
                return Verdict::fail(format!("{place} does not hold {symbol}"));
            }
        }
        Verdict::pass(format!("{} places", places.len()))
    }
}
