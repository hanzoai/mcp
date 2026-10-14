//! The process listening on a TCP port.

use crate::action::*;
use crate::catalog::REPORT;
use crate::state::State;
use serde_json::json;

pub struct Listen;

static SPEC: Spec = Spec {
    id: "listen",
    version: 1,
    summary: "Report the process id of the process listening on a TCP port.",
    triggers: &[
        r"listening on",
        r"listens on",
        r"which process .*port",
        r"pid .*port",
        r"what .* port\b",
        r"\bport \d+",
    ],
    inputs: &[
        Input {
            name: "port",
            ask: "",
            kind: Kind::Literal(r"(?i)\bport\s+(\d{2,5})\b"),
            optional: false,
        },
        REPORT,
    ],
    effect: Effect::Read,
    tools: &[],
    pure: false,
};

/// Process ids with a listening socket on `port`.
pub fn listeners(port: u16) -> Vec<u32> {
    let want = format!(":{port:04X}");
    let mut inodes = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        for line in std::fs::read_to_string(table)
            .unwrap_or_default()
            .lines()
            .skip(1)
        {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() > 9 && f[3] == "0A" && f[1].ends_with(&want) {
                inodes.push(f[9].to_string());
            }
        }
    }
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        for fd in std::fs::read_dir(entry.path().join("fd"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let target = std::fs::read_link(fd.path())
                .map(|t| t.to_string_lossy().into_owned())
                .unwrap_or_default();
            if inodes.iter().any(|i| target == format!("socket:[{i}]")) {
                pids.push(pid);
                break;
            }
        }
    }
    pids.sort_unstable();
    pids
}

impl Action for Listen {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, _state: &State, args: &Args) -> Vec<Check> {
        let ok = text(args, "port")
            .and_then(|p| p.parse::<u16>().ok())
            .is_some_and(|p| p > 0);
        vec![Check::new("port", ok, text(args, "port").unwrap_or(""))]
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let port: u16 = text(args, "port")
            .and_then(|p| p.parse().ok())
            .ok_or("no port")?;
        let pids = listeners(port);
        let body = pids
            .iter()
            .map(|p| format!("pid={p}"))
            .collect::<Vec<_>>()
            .join("\n");
        report(cx, args, &body)?;
        Ok(Output {
            text: body,
            data: json!({ "pids": pids }),
        })
    }

    fn verify(&self, _cx: &Cx, _args: &Args, out: &Output) -> Verdict {
        let pids: Vec<u64> = out.data["pids"]
            .as_array()
            .map(|a| a.iter().filter_map(serde_json::Value::as_u64).collect())
            .unwrap_or_default();
        if pids.is_empty() {
            Verdict::fail("nothing listens there")
        } else if pids
            .iter()
            .all(|p| std::path::Path::new(&format!("/proc/{p}")).exists())
        {
            Verdict::pass(format!("{} process(es)", pids.len()))
        } else {
            Verdict::fail("a reported process is gone")
        }
    }
}
