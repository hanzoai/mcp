//! Wait for a deployment, pipeline or rollout to reach a final state.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub struct Wait;

static SPEC: Spec = Spec {
    id: "wait",
    version: 1,
    summary: "Wait for a deployment, pipeline or rollout at a URL to reach a final state and report that state.",
    triggers: &[
        r"\bwait\b",
        r"\buntil\b",
        r"\bpoll\b",
        r"\bwatch\b",
        r"\bblock until\b",
        r"\bfinish(es|ed)?\b.*\b(deploy|rollout|pipeline|build|release)",
    ],
    inputs: &[
        Input {
            name: "url",
            ask: "",
            kind: Kind::Literal(r#"(https?://[^\s`"')>]+)"#),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &[],
    pure: false,
};

const SUCCESS: &[&str] = &[
    "ready",
    "success",
    "succeeded",
    "successful",
    "complete",
    "completed",
    "healthy",
    "available",
    "passed",
    "done",
    "deployed",
    "running-ready",
];
const FAILURE: &[&str] = &[
    "failed",
    "failure",
    "error",
    "errored",
    "cancelled",
    "canceled",
    "timeout",
    "rolledback",
    "aborted",
];
const LIMIT: Duration = Duration::from_secs(240);
const EVERY: Duration = Duration::from_millis(500);

/// Whether the URL, parsed as a client would, points at this machine. A URL with credentials in it is
/// not trusted to: `http://127.0.0.1@example.com/` goes to example.com.
fn loopback(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.username().is_empty()
            && u.password().is_none()
            && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    })
}

/// The state a status document reports: `Some((word, final))`.
pub fn status(body: &str) -> Option<(String, bool)> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            let word = body.trim().to_lowercase();
            return Some((
                word.clone(),
                SUCCESS.contains(&word.as_str()) || FAILURE.contains(&word.as_str()),
            ));
        }
    };
    for key in ["status", "state", "phase", "conclusion", "result"] {
        if let Some(word) = v[key].as_str() {
            let w = word.to_lowercase();
            let done = SUCCESS.contains(&w.as_str()) || FAILURE.contains(&w.as_str());
            if !done {
                if let Some((have, want)) = replicas(&v) {
                    return Some((format!("{w} {have}/{want}"), have == want && want > 0));
                }
            }
            return Some((w, done));
        }
    }
    replicas(&v).map(|(have, want)| (format!("{have}/{want}"), have == want && want > 0))
}

fn replicas(v: &Value) -> Option<(u64, u64)> {
    let have = ["updated", "ready", "available"]
        .iter()
        .find_map(|k| v[*k].as_u64())?;
    let want = ["desired", "replicas", "total"]
        .iter()
        .find_map(|k| v[*k].as_u64())?;
    Some((have, want))
}

impl Action for Wait {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn effect(&self, _state: &State, args: &Args) -> Effect {
        if text(args, "url").is_some_and(loopback) {
            Effect::Read
        } else {
            Effect::Remote
        }
    }

    fn check(&self, _state: &State, args: &Args) -> Vec<Check> {
        let url = text(args, "url").unwrap_or("");
        vec![Check::new("url", url.starts_with("http://"), url)]
    }

    fn reads(&self, _state: &State, _args: &Args) -> Reads {
        Reads::Files(Vec::new())
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let url = text(args, "url").ok_or("no url")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        let mut polls = 0u32;
        let mut last = String::from("unreachable");
        while started.elapsed() < LIMIT {
            polls += 1;
            let polled = client.get(url).send().ok().and_then(|resp| resp.text().ok()).and_then(|body| status(&body));
            if let Some((word, done)) = polled {
                last = word;
                if done {
                    break;
                }
            }
            std::thread::sleep(EVERY);
        }
        let waited = started.elapsed().as_secs_f64();
        let body = format!("final={last} waited={waited:.1}s polls={polls}");
        cx.steps.push(crate::exec::Step {
            argv: vec!["GET".into(), crate::redact::redact(url)],
            code: Some(0),
            ms: waited * 1000.0,
        });
        report(cx, args, &format!("final={last}"))?;
        Ok(Output {
            text: body,
            data: json!({ "final": last, "polls": polls, "waited": waited }),
        })
    }

    fn verify(&self, _cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let word = out.data["final"].as_str().unwrap_or("");
        let word = word.split_whitespace().next().unwrap_or("");
        if SUCCESS.contains(&word)
            || FAILURE.contains(&word)
            || out.data["final"].as_str().is_some_and(|f| f.contains('/'))
        {
            Verdict::pass(format!("final state {word}"))
        } else {
            Verdict::fail(format!("no final state: {word}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_in_three_shapes() {
        assert_eq!(
            status(r#"{"status":"pending"}"#),
            Some(("pending".into(), false))
        );
        assert_eq!(
            status(r#"{"status":"ready"}"#),
            Some(("ready".into(), true))
        );
        assert_eq!(
            status(r#"{"state":"Failed"}"#),
            Some(("failed".into(), true))
        );
        assert_eq!(
            status(r#"{"phase":"RollingOut","updated":2,"desired":4}"#),
            Some(("rollingout 2/4".into(), false))
        );
        assert_eq!(
            status(r#"{"updated":4,"desired":4}"#),
            Some(("4/4".into(), true))
        );
    }

    #[test]
    fn only_loopback_is_not_remote() {
        assert!(loopback("http://127.0.0.1:8080/x"));
        assert!(!loopback("http://example.com/x"));
        assert!(!loopback("http://127.0.0.1@example.com/x"));
        assert!(!loopback("http://127.0.0.1.example.com/x"));
        assert!(loopback("http://localhost:8080/"));
    }
}
