//! Two arms of a results file, compared task by task.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct Pairs;

static SPEC: Spec = Spec {
    id: "pairs",
    version: 1,
    summary: "Compare two arms of a results file task by task: wins, losses, the median speedup and an exact paired test on solves.",
    triggers: &[
        r"compare .*\barms?\b",
        r"\barms?\b.*\b(against|over|vs\.?|versus)\b",
        r"speed-?ups?",
        r"paired",
        r"\bwins?\b.*\blosses\b",
    ],
    inputs: &[
        Input {
            name: "file",
            ask: "Which results file does the request mean?",
            kind: Kind::Pick(Source::Datasets),
            optional: false,
        },
        Input {
            name: "x",
            ask: "",
            kind: Kind::Literal(
                r#"(?i)\barm\s+[`"']?([\w-]+)[`"']?\s+(?:over|against|vs\.?|versus)\b"#,
            ),
            optional: false,
        },
        Input {
            name: "y",
            ask: "",
            kind: Kind::Literal(
                r#"(?i)\b(?:over|against|vs\.?|versus)\s+(?:the\s+)?(?:arm\s+)?[`"']?([\w-]+)[`"']?"#,
            ),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &[],
    pure: true,
};

#[derive(Debug, Clone)]
pub struct Row {
    pub task: String,
    pub arm: String,
    pub seconds: f64,
    pub solve: bool,
}

/// The rows of a JSON-lines or CSV results file (columns task, arm, seconds, solve).
pub fn rows(path: &std::path::Path) -> Vec<Row> {
    let body = std::fs::read_to_string(path).unwrap_or_default();
    let csv = path.extension().is_some_and(|e| e == "csv");
    let mut head: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (i, line) in body.lines().enumerate() {
        let v: Option<Value> = if csv {
            let cells: Vec<&str> = line.split(',').map(str::trim).collect();
            if i == 0 {
                head = cells.iter().map(|c| (*c).to_string()).collect();
                continue;
            }
            Some(Value::Object(
                head.iter()
                    .cloned()
                    .zip(cells.iter().map(|c| {
                        c.parse::<f64>()
                            .map(Value::from)
                            .unwrap_or_else(|_| match *c {
                                "true" | "True" => Value::Bool(true),
                                "false" | "False" => Value::Bool(false),
                                other => Value::String(other.to_string()),
                            })
                    }))
                    .collect(),
            ))
        } else {
            serde_json::from_str(line).ok()
        };
        let Some(v) = v else { continue };
        if let (Some(task), Some(arm), Some(seconds), Some(solve)) = (
            v["task"].as_str(),
            v["arm"].as_str(),
            v["seconds"].as_f64(),
            v["solve"].as_bool(),
        ) {
            out.push(Row {
                task: task.to_string(),
                arm: arm.to_string(),
                seconds,
                solve,
            });
        }
    }
    out
}

/// Exact two-sided McNemar p from the discordant counts.
pub fn mcnemar(b: u32, c: u32) -> f64 {
    let n = b + c;
    if n == 0 {
        return 1.0;
    }
    let k = b.min(c);
    let mut pmf = 0.5f64.powi(n as i32);
    let mut cdf = pmf;
    for i in 0..k {
        pmf *= f64::from(n - i) / f64::from(i + 1);
        cdf += pmf;
    }
    (2.0 * cdf).min(1.0)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    match v.len() {
        0 => 0.0,
        n if n % 2 == 1 => v[n / 2],
        n => (v[n / 2 - 1] + v[n / 2]) / 2.0,
    }
}

fn compare(rows: &[Row], x: &str, y: &str) -> Option<(String, Value)> {
    let take = |arm: &str| -> BTreeMap<&str, (f64, bool)> {
        let mut m = BTreeMap::new();
        for r in rows.iter().filter(|r| r.arm == arm) {
            m.entry(r.task.as_str()).or_insert((r.seconds, r.solve));
        }
        m
    };
    let (a, b) = (take(x), take(y));
    let mut faster = 0;
    let mut slower = 0;
    let mut ties = 0;
    let (mut ratios, mut only_x, mut only_y, mut sx, mut sy) = (Vec::new(), 0u32, 0u32, 0, 0);
    let mut n = 0;
    for (task, (tx, solx)) in &a {
        let Some((ty, soly)) = b.get(task) else {
            continue;
        };
        n += 1;
        match tx.partial_cmp(ty) {
            Some(std::cmp::Ordering::Less) => faster += 1,
            Some(std::cmp::Ordering::Greater) => slower += 1,
            _ => ties += 1,
        }
        if *tx > 0.0 {
            ratios.push(ty / tx);
        }
        sx += u32::from(*solx);
        sy += u32::from(*soly);
        only_x += u32::from(*solx && !*soly);
        only_y += u32::from(!*solx && *soly);
    }
    if n == 0 {
        return None;
    }
    let p = mcnemar(only_x, only_y);
    let med = median(ratios);
    let text = format!(
        "n={n} faster={faster} slower={slower} ties={ties} median_speedup={med:.3} solved_x={sx} solved_y={sy} mcnemar_p={p:.4}"
    );
    Some((
        text,
        json!({ "n": n, "faster": faster, "slower": slower, "ties": ties, "median_speedup": med, "solved_x": sx, "solved_y": sy, "mcnemar_p": p }),
    ))
}

/// A one-line description of a results file for Kai: its size and its arms.
pub fn describe(path: &std::path::Path) -> String {
    let r = rows(path);
    let mut arms: Vec<&str> = r.iter().map(|x| x.arm.as_str()).collect();
    arms.sort_unstable();
    arms.dedup();
    format!("{} rows, arms: {}", r.len(), arms.join(", "))
}

impl Action for Pairs {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn admits(&self, state: &State, args: &Args, input: &str, cand: &crate::state::Cand) -> bool {
        if input != "file" {
            return true;
        }
        let r = rows(&state.root.join(&cand.value));
        [text(args, "x"), text(args, "y")]
            .iter()
            .flatten()
            .all(|arm| r.iter().any(|x| x.arm == *arm))
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let file = text(args, "file").unwrap_or("");
        let r = rows(&state.root.join(file));
        let has = |a: &str| r.iter().any(|x| x.arm == a);
        let (x, y) = (text(args, "x").unwrap_or(""), text(args, "y").unwrap_or(""));
        vec![
            Check::new("rows", !r.is_empty(), file),
            Check::new("arm x", has(x), x),
            Check::new("arm y", has(y), y),
            Check::new("two arms", x != y, ""),
        ]
    }

    fn reads(&self, _state: &State, args: &Args) -> Reads {
        Reads::Files(
            text(args, "file")
                .map(|f| vec![f.to_string()])
                .unwrap_or_default(),
        )
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let (file, x, y) = (
            text(args, "file").ok_or("no file")?,
            text(args, "x").ok_or("no arm")?,
            text(args, "y").ok_or("no arm")?,
        );
        let (body, data) = compare(&rows(&cx.path(file)), x, y).ok_or("the arms share no task")?;
        report(cx, args, &body)?;
        Ok(Output { text: body, data })
    }

    fn verify(&self, _cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let n = out.data["n"].as_u64().unwrap_or(0);
        let p = out.data["mcnemar_p"].as_f64().unwrap_or(f64::NAN);
        let (f, s, t) = (
            out.data["faster"].as_u64().unwrap_or(0),
            out.data["slower"].as_u64().unwrap_or(0),
            out.data["ties"].as_u64().unwrap_or(0),
        );
        if n > 0 && f + s + t == n && (0.0..=1.0).contains(&p) {
            Verdict::pass(format!("{n} pairs"))
        } else {
            Verdict::fail("counts do not add up")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcnemar_is_exact() {
        assert!((mcnemar(0, 0) - 1.0).abs() < 1e-12);
        assert!((mcnemar(5, 0) - 0.0625).abs() < 1e-12);
        assert!((mcnemar(3, 3) - 1.0).abs() < 1e-12);
        assert!((mcnemar(1, 4) - 0.375).abs() < 1e-12);
    }

    #[test]
    fn arms_pair_by_task() {
        let r = |t: &str, a: &str, s: f64, ok: bool| Row {
            task: t.into(),
            arm: a.into(),
            seconds: s,
            solve: ok,
        };
        let rows = vec![
            r("a", "x", 1.0, true),
            r("a", "y", 3.0, true),
            r("b", "x", 2.0, true),
            r("b", "y", 4.0, false),
            r("c", "x", 5.0, true),
        ];
        let (text, data) = compare(&rows, "x", "y").unwrap_or_default();
        assert_eq!(data["n"], 2, "{text}");
        assert!(text.contains("median_speedup=2.500"), "{text}");
        assert!(text.contains("mcnemar_p=1.0000"), "{text}");
    }
}
