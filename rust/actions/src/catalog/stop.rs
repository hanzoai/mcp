//! Stop the process whose id is in a file.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;
use serde_json::json;
use std::time::{Duration, Instant};

pub struct Stop;

static SPEC: Spec = Spec {
    id: "stop",
    version: 1,
    summary: "Stop the process whose id is written in a pid file.",
    triggers: &[
        r"\b(stop|kill|terminate|shut ?down)\b.*\b(pid|process|server|daemon)\b",
        r"pid file",
    ],
    inputs: &[
        Input {
            name: "pidfile",
            ask: "",
            kind: Kind::Literal(r#"[`"']?([\w./-]+\.pid)\b"#),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Destroy,
    tools: &["kill"],
    pure: false,
};

fn pid_of(state: &State, file: &str) -> Option<u32> {
    std::fs::read_to_string(state.root.join(file))
        .ok()?
        .trim()
        .parse()
        .ok()
        .filter(|p| *p > 1)
}

fn alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| {
        // The state letter follows the command, which is in parentheses and may hold spaces.
        s.rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().next().map(|c| c != "Z" && c != "X"))
            .unwrap_or(false)
    })
}

/// Whether the process works inside the workspace: its current directory is under the root.
fn ours(state: &State, pid: u32) -> bool {
    let (Ok(cwd), Ok(root)) = (
        std::fs::read_link(format!("/proc/{pid}/cwd")),
        std::fs::canonicalize(&state.root),
    ) else {
        return false;
    };
    cwd.starts_with(root)
}

impl Action for Stop {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let file = text(args, "pidfile").unwrap_or("");
        let pid = pid_of(state, file);
        vec![
            Check::new("pid file", pid.is_some(), file),
            Check::new(
                "process is alive",
                pid.is_some_and(alive),
                format!("{pid:?}"),
            ),
            Check::new(
                "process works in this workspace",
                pid.is_some_and(|p| ours(state, p)),
                format!("{pid:?}"),
            ),
            Check::new("not this process", pid != Some(std::process::id()), ""),
        ]
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let file = text(args, "pidfile").ok_or("no pid file")?;
        let pid = pid_of(&cx.state(), file).ok_or("no pid")?;
        let p = pid.to_string();
        cx.must(&["kill", "-TERM", &p])?;
        let started = Instant::now();
        while alive(pid) && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if alive(pid) {
            cx.must(&["kill", "-KILL", &p])?;
            while alive(pid) && started.elapsed() < Duration::from_secs(8) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let body = format!("stopped pid={pid}");
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: json!({ "pid": pid }),
        })
    }

    fn verify(&self, _cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        match out.data["pid"].as_u64() {
            Some(p) if !alive(p as u32) => Verdict::pass(format!("pid {p} is gone")),
            Some(p) => Verdict::fail(format!("pid {p} is still running")),
            None => Verdict::fail("no pid"),
        }
    }
}
