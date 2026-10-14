//! Run a test suite and report how many tests passed and failed.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::{Cand, State};
use regex::Regex;
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;

pub struct Suite;

static SPEC: Spec = Spec {
    id: "suite",
    version: 1,
    summary: "Run the project's test suite and report how many tests passed and failed.",
    triggers: &[
        r"\b(run|execute|rerun|re-run)\b.{0,100}\b(tests?|suite|specs?)\b",
        r"\bhow many\b.{0,60}\b(tests?|specs?)\b.{0,40}\b(pass|fail)",
    ],
    inputs: &[
        Input {
            name: "suite",
            ask: "Which test suite does the request mean?",
            kind: Kind::Pick(Source::Suites),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Write,
    tools: &["python3", "node", "go"],
    pure: true,
};

#[derive(Debug, Default, PartialEq, Clone, Copy)]
pub struct Counts {
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
}

/// Test suites in the workspace, one per directory that holds tests.
pub fn detect(state: &State) -> Vec<Cand> {
    let files = state.files();
    let mut dirs: BTreeMap<(&str, String), Vec<String>> = BTreeMap::new();
    let py = Regex::new(r"(^|/)(test_[^/]*|[^/]*_test)\.py$");
    let js = Regex::new(r"\.(test|spec)\.(js|mjs|cjs)$");
    for f in &files {
        let dir = f.rsplit_once('/').map_or(".", |(d, _)| d).to_string();
        let name = f.rsplit('/').next().unwrap_or(f).to_string();
        if py.as_ref().is_ok_and(|r| r.is_match(f)) {
            dirs.entry(("python", dir)).or_default().push(name);
        } else if js.as_ref().is_ok_and(|r| r.is_match(f)) {
            dirs.entry(("node", dir)).or_default().push(name);
        }
    }
    let mut out: Vec<Cand> = dirs
        .into_iter()
        .map(|((kind, dir), names)| {
            Cand::new(
                &format!("{kind}:{dir}"),
                &format!("{dir} ({kind} tests: {})", names.join(", ")),
            )
        })
        .collect();
    if state.root.join("go.mod").is_file() {
        out.push(Cand::new("go:.", "all Go packages (go test)"));
    }
    out
}

fn first(re: &str, text: &str) -> u32 {
    Regex::new(re)
        .ok()
        .and_then(|r| r.captures(text))
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(0)
}

/// Counts from pytest's last line: `2 failed, 3 passed, 1 skipped in 0.1s`.
pub fn pytest(text: &str) -> Option<Counts> {
    let line = text
        .lines()
        .rev()
        .find(|l| l.contains(" passed") || l.contains(" failed") || l.contains("no tests ran"))?;
    Some(Counts {
        passed: first(r"(\d+) passed", line),
        failed: first(r"(\d+) failed", line) + first(r"(\d+) error", line),
        skipped: first(r"(\d+) skipped", line),
    })
}

/// Counts from unittest's summary: `Ran 5 tests` and `FAILED (failures=1, errors=1, skipped=1)`.
pub fn unittest(text: &str) -> Option<Counts> {
    let ran = first(r"Ran (\d+) tests?", text);
    if ran == 0 {
        return None;
    }
    let failed = first(r"failures=(\d+)", text) + first(r"errors=(\d+)", text);
    let skipped = first(r"skipped=(\d+)", text);
    Some(Counts {
        passed: ran.saturating_sub(failed + skipped),
        failed,
        skipped,
    })
}

/// Counts from node's TAP summary.
pub fn tap(text: &str) -> Option<Counts> {
    if !text.contains("# pass") {
        return None;
    }
    Some(Counts {
        passed: first(r"# pass (\d+)", text),
        failed: first(r"# fail (\d+)", text),
        skipped: first(r"# skipped (\d+)", text),
    })
}

/// Counts from `go test -json`: one event a finished test.
pub fn gotest(text: &str) -> Option<Counts> {
    let mut c = Counts::default();
    let mut seen = false;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["Test"].as_str().is_none() {
            continue;
        }
        match v["Action"].as_str() {
            Some("pass") => c.passed += 1,
            Some("fail") => c.failed += 1,
            Some("skip") => c.skipped += 1,
            _ => continue,
        }
        seen = true;
    }
    seen.then_some(c)
}

fn has_pytest(cx: &mut Cx) -> bool {
    cx.exec(&["python3", "-c", "import pytest"], Duration::from_secs(20))
        .is_ok_and(|o| o.ok())
}

fn execute(cx: &mut Cx, suite: &str) -> Result<(Counts, Option<i32>), String> {
    let (kind, dir) = suite.split_once(':').ok_or("a suite is kind:dir")?;
    let limit = Duration::from_secs(600);
    match kind {
        "python" => {
            let out = if has_pytest(cx) {
                cx.exec(
                    &[
                        "env",
                        "PYTHONPATH=.",
                        "python3",
                        "-m",
                        "pytest",
                        "-q",
                        "-p",
                        "no:cacheprovider",
                        dir,
                    ],
                    limit,
                )?
            } else {
                cx.exec(
                    &[
                        "env",
                        "PYTHONPATH=.",
                        "python3",
                        "-m",
                        "unittest",
                        "discover",
                        "-s",
                        dir,
                        "-t",
                        ".",
                    ],
                    limit,
                )?
            };
            let counts = pytest(&out.text())
                .filter(|_| out.stdout.contains("passed") || out.stdout.contains("failed"))
                .or_else(|| unittest(&out.text()));
            Ok((
                counts.ok_or_else(|| {
                    format!(
                        "no counts in: {}",
                        crate::redact::cut(out.text().trim(), 200)
                    )
                })?,
                out.step.code,
            ))
        }
        "node" => {
            let files: Vec<String> = cx
                .state()
                .files()
                .into_iter()
                .filter(|f| {
                    f.rsplit_once('/').map_or(".", |(d, _)| d) == dir
                        && (f.contains(".test.") || f.contains(".spec."))
                })
                .collect();
            let mut argv = vec!["node", "--test", "--test-reporter=tap"];
            argv.extend(files.iter().map(String::as_str));
            let out = cx.exec(&argv, limit)?;
            Ok((tap(&out.stdout).ok_or("no TAP summary")?, out.step.code))
        }
        "go" => {
            let out = cx.exec(&["go", "test", "-json", "./..."], limit)?;
            Ok((
                gotest(&out.stdout).ok_or("no go test events")?,
                out.step.code,
            ))
        }
        other => Err(format!("no runner for {other}")),
    }
}

impl Action for Suite {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let suite = text(args, "suite").unwrap_or("");
        vec![Check::new(
            "suite exists",
            state.suites().iter().any(|s| s.value == suite),
            suite,
        )]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Tree
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let suite = text(args, "suite").ok_or("no suite")?;
        let (c, code) = execute(cx, suite)?;
        let body = format!("passed={} failed={}", c.passed, c.failed);
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: json!({ "passed": c.passed, "failed": c.failed, "skipped": c.skipped, "code": code }),
        })
    }

    fn verify(&self, _cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let (passed, failed) = (
            out.data["passed"].as_u64().unwrap_or(0),
            out.data["failed"].as_u64().unwrap_or(0),
        );
        let code = out.data["code"].as_i64();
        if passed + failed == 0 {
            Verdict::fail("no test ran")
        } else if (failed > 0) == (code != Some(0)) {
            Verdict::pass(format!("{passed} passed, {failed} failed"))
        } else {
            Verdict::fail(format!(
                "exit {code:?} does not agree with {failed} failures"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pytest_lines_are_read() {
        assert_eq!(
            pytest("..F\n1 failed, 2 passed, 1 skipped in 0.02s"),
            Some(Counts {
                passed: 2,
                failed: 1,
                skipped: 1
            })
        );
        assert_eq!(
            pytest("3 passed in 0.01s"),
            Some(Counts {
                passed: 3,
                failed: 0,
                skipped: 0
            })
        );
        assert_eq!(pytest("nothing"), None);
    }

    #[test]
    fn unittest_summaries_are_read() {
        assert_eq!(
            unittest("Ran 5 tests in 0.001s\n\nFAILED (failures=1, errors=1)"),
            Some(Counts {
                passed: 3,
                failed: 2,
                skipped: 0
            })
        );
        assert_eq!(
            unittest("Ran 2 tests in 0.0s\n\nOK"),
            Some(Counts {
                passed: 2,
                failed: 0,
                skipped: 0
            })
        );
    }

    #[test]
    fn tap_and_go_are_read() {
        assert_eq!(
            tap("1..3\n# tests 3\n# pass 2\n# fail 1\n# skipped 0"),
            Some(Counts {
                passed: 2,
                failed: 1,
                skipped: 0
            })
        );
        let go = "{\"Action\":\"run\",\"Test\":\"A\"}\n{\"Action\":\"pass\",\"Test\":\"A\"}\n{\"Action\":\"fail\",\"Test\":\"B\"}\n{\"Action\":\"pass\"}";
        assert_eq!(
            gotest(go),
            Some(Counts {
                passed: 1,
                failed: 1,
                skipped: 0
            })
        );
    }
}
