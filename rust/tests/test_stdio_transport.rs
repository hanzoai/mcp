//! The stdio transport, driven as a client drives it: the real binary, one JSON-RPC message per
//! line. Requests run concurrently, a cancel kills what `exec` started and is not answered,
//! progress arrives while `exec` runs, and end of input still answers what is in flight.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<(Instant, Value)>,
}

/// What the reader records for a line that is not one JSON message: two writes interleaved.
const TORN: &str = "__torn_line";

impl Server {
    fn start() -> Self {
        Self::start_with(&[])
    }

    fn start_with(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hanzo-mcp"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("hanzo-mcp starts");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let message = serde_json::from_str(&line).unwrap_or_else(|_| json!({ TORN: line }));
                let _ = tx.send((Instant::now(), message));
            }
        });
        let stdin = child.stdin.take();
        let mut server = Self { child, stdin, lines };
        // Timings below start from a server that is up, as a client's do.
        server.send(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }));
        assert_eq!(server.until(0, Duration::from_secs(30)).last().map(|(_, m)| m["id"].clone()), Some(json!(0)));
        server
    }

    fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    }

    fn exec(&mut self, id: u64, command: &str, meta: Option<Value>) {
        let mut params = json!({ "name": "exec", "arguments": { "action": "exec", "command": command } });
        if let Some(meta) = meta {
            params["_meta"] = meta;
        }
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params }));
    }

    fn cancel(&mut self, id: u64) {
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id } }));
    }

    /// Everything the server writes within `wait`.
    fn collect(&self, wait: Duration) -> Vec<(Instant, Value)> {
        let end = Instant::now() + wait;
        let mut out = Vec::new();
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(line) => out.push(line),
                Err(_) => break,
            }
        }
        out
    }

    /// Lines until the answer to `id` arrives, that answer included.
    fn until(&self, id: u64, wait: Duration) -> Vec<(Instant, Value)> {
        let end = Instant::now() + wait;
        let mut out = Vec::new();
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            let Ok(line) = self.lines.recv_timeout(left) else { break };
            let done = line.1["id"] == id;
            out.push(line);
            if done {
                break;
            }
        }
        out
    }
}

fn ping(id: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

fn answered(lines: &[(Instant, Value)], id: &Value) -> bool {
    lines.iter().any(|(_, m)| &m["id"] == id && m.get("method").is_none())
}

#[cfg(unix)]
fn running(marker: &str) -> bool {
    !Command::new("pgrep").args(["-f", marker]).output().unwrap().stdout.is_empty()
}

#[cfg(unix)]
fn reap(marker: &str) {
    let _ = Command::new("pkill").args(["-9", "-f", marker]).status();
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn a_slow_call_does_not_hold_up_a_fast_one() {
    let mut s = Server::start();
    s.exec(1, "sleep 2; echo slow", None);
    s.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }));
    let got = s.until(1, Duration::from_secs(10));
    let ids: Vec<&Value> = got.iter().map(|(_, m)| &m["id"]).collect();
    assert_eq!(ids, [&json!(2), &json!(1)], "the ping answers first");
    assert!(got[1].0 - got[0].0 > Duration::from_secs(1), "the ping waited for the exec");
    assert!(got[1].1.to_string().contains("slow"));
}

#[cfg(unix)]
#[test]
fn a_cancelled_exec_is_killed_with_its_children_and_not_answered() {
    let mut s = Server::start();
    let marker = format!("hanzo-cancel-test-{}", std::process::id());
    s.exec(7, &format!("sh -c 'sleep 30; echo {marker}' & wait"), None);
    std::thread::sleep(Duration::from_millis(800));
    let running = |m: &str| {
        let out = Command::new("pgrep").args(["-f", &format!("echo {m}")]).output().unwrap();
        !out.stdout.is_empty()
    };
    assert!(running(&marker), "the command never started");

    s.cancel(7);
    let after = s.collect(Duration::from_secs(3));
    assert!(after.iter().all(|(_, m)| m["id"] != 7), "a cancelled request was answered: {after:?}");
    assert!(!running(&marker), "the shell's child outlived the cancel");

    s.send(json!({ "jsonrpc": "2.0", "id": 8, "method": "ping" }));
    assert_eq!(s.until(8, Duration::from_secs(3)).last().unwrap().1["result"], "pong");
}

#[test]
fn exec_reports_progress_when_asked() {
    let mut s = Server::start();
    s.exec(3, "for i in 1 2 3; do echo line$i; sleep 1; done", Some(json!({ "progressToken": "tok" })));
    let got = s.until(3, Duration::from_secs(10));
    let notes: Vec<&Value> = got
        .iter()
        .filter(|(_, m)| m["method"] == "notifications/progress")
        .map(|(_, m)| &m["params"])
        .collect();
    assert!(notes.len() >= 2, "{notes:?}");
    assert!(notes.iter().all(|n| n["progressToken"] == "tok"));
    let values: Vec<f64> = notes.iter().map(|n| n["progress"].as_f64().unwrap()).collect();
    assert!(values.windows(2).all(|w| w[0] < w[1]), "progress must increase: {values:?}");
    assert!(notes.iter().any(|n| n["message"].as_str().is_some_and(|m| m.starts_with("line"))));
    assert_eq!(got.last().unwrap().1["id"], 3, "the answer comes after the progress");

    s.exec(4, "sleep 1.5", None);
    let quiet = s.until(4, Duration::from_secs(5));
    assert!(quiet.iter().all(|(_, m)| m["method"] != "notifications/progress"), "progress without a token");
}

#[test]
fn end_of_input_still_answers_what_is_in_flight() {
    let mut s = Server::start();
    s.exec(1, "sleep 1; echo late", None);
    s.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }));
    drop(s.stdin.take());
    let ids: Vec<Value> = s.collect(Duration::from_secs(5)).into_iter().map(|(_, m)| m["id"].clone()).collect();
    assert!(ids.contains(&json!(1)) && ids.contains(&json!(2)), "{ids:?}");
    let status = s.child.wait().unwrap();
    assert!(status.success(), "exited with {status}");
}

#[test]
fn initialize_tells_the_model_how_to_use_the_server() {
    let mut s = Server::start();
    // Answered again by a server already initialized: the same result.
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }));
    let answer = s.until(1, Duration::from_secs(5));
    let r = &answer.last().unwrap().1["result"];
    assert_eq!(r["capabilities"], json!({ "tools": {} }));
    assert!(r["instructions"].as_str().is_some_and(|i| i.contains("approve: true")));
}

// ---- Cancellation edge cases ----------------------------------------------------------------

#[test]
fn a_cancel_for_an_unknown_or_finished_request_is_ignored() {
    let mut s = Server::start();
    s.cancel(999);
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled" }));
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": {} }));
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": null } }));
    s.send(ping(json!(1)));
    let got = s.until(1, Duration::from_secs(5));
    assert!(answered(&got, &json!(1)), "the server stopped serving after a stray cancel");
    s.cancel(1);
    s.send(ping(json!(2)));
    let got = s.until(2, Duration::from_secs(5));
    assert!(answered(&got, &json!(2)), "a cancel for an answered request broke the server");
    assert!(got.iter().all(|(_, m)| m.get(TORN).is_none() && m["error"].is_null()), "{got:?}");
}

#[test]
fn ids_are_matched_exactly_string_and_number_alike() {
    let mut s = Server::start();
    s.send(json!({ "jsonrpc": "2.0", "id": "job-a", "method": "tools/call", "params": { "name": "exec", "arguments": { "action": "exec", "command": "sleep 2; echo a" } } }));
    s.exec(5, "sleep 2; echo five", None);
    std::thread::sleep(Duration::from_millis(300));
    // "5" is not 5: only the string id is cancelled.
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": "5" } }));
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": "job-a" } }));
    let got = s.collect(Duration::from_secs(4));
    assert!(!answered(&got, &json!("job-a")), "the cancelled string id was answered");
    assert!(answered(&got, &json!(5)), "numeric 5 was cancelled by the string \"5\"");
}

#[cfg(unix)]
#[test]
fn a_cancel_while_queued_behind_the_limit_never_runs() {
    let mut s = Server::start();
    for id in 100..116 {
        s.exec(id, "sleep 2", None);
    }
    // Requests sent in the same instant take slots in no promised order, so the 17th is sent
    // once the 16 hold every slot.
    std::thread::sleep(Duration::from_millis(500));
    let flag = std::env::temp_dir().join(format!("hanzo-queued-{}", std::process::id()));
    let _ = std::fs::remove_file(&flag);
    s.exec(200, &format!("touch {}", flag.display()), None);
    std::thread::sleep(Duration::from_millis(300));
    s.cancel(200);
    let got = s.collect(Duration::from_secs(4));
    assert!(!flag.exists(), "a request cancelled while waiting for a slot ran anyway");
    assert!(!answered(&got, &json!(200)));
    assert_eq!((100..116).filter(|id| answered(&got, &json!(id))).count(), 16);
}

#[test]
fn sixteen_run_at_once_and_the_rest_wait_their_turn() {
    let mut s = Server::start();
    let start = Instant::now();
    for id in 0..20 {
        s.exec(300 + id, "sleep 1", None);
    }
    let got = s.collect(Duration::from_secs(6));
    let mut done: Vec<Duration> = got.iter().filter(|(_, m)| m["id"].is_u64()).map(|(t, _)| *t - start).collect();
    done.sort();
    assert_eq!(done.len(), 20, "every call answers");
    assert!(done[15] < Duration::from_millis(1800), "the first 16 did not run together: {:?}", done[15]);
    assert!(done[16] >= Duration::from_millis(1800), "more than 16 ran at once: {:?}", done[16]);
}

#[cfg(unix)]
#[test]
fn cancelling_a_wait_leaves_the_backgrounded_process_alone() {
    let mut s = Server::start();
    let marker = format!("hanzo-wait-cancel-{}", std::process::id());
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "exec",
        "arguments": { "action": "exec", "command": format!("sleep 20; echo {marker}"), "timeout": 1 } } }));
    let first = s.until(1, Duration::from_secs(5));
    let text = first.last().unwrap().1["result"]["content"][0]["text"].as_str().unwrap().to_string();
    let proc_id = serde_json::from_str::<Value>(&text).unwrap()["proc_id"].as_str().unwrap().to_string();
    s.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "exec",
        "arguments": { "action": "wait", "proc_id": proc_id } } }));
    std::thread::sleep(Duration::from_millis(500));
    s.cancel(2);
    let got = s.collect(Duration::from_secs(2));
    assert!(!answered(&got, &json!(2)), "the cancelled wait answered");
    assert!(running(&marker), "cancelling a wait killed the process it waited on");
    reap(&marker);
}

#[test]
fn rapid_cancels_leave_the_server_healthy() {
    let mut s = Server::start();
    for i in 0..50u64 {
        s.exec(1000 + i, if i % 2 == 0 { "true" } else { "sleep 5" }, None);
        s.cancel(1000 + i);
        s.send(ping(json!(5000 + i)));
    }
    let got = s.collect(Duration::from_secs(4));
    assert_eq!((0..50u64).filter(|i| answered(&got, &json!(5000 + i))).count(), 50, "a ping went unanswered");
    for i in (1..50u64).step_by(2) {
        assert!(!answered(&got, &json!(1000 + i)), "cancelled sleep {} answered", 1000 + i);
    }
    assert!(got.iter().all(|(_, m)| m.get(TORN).is_none()));
}

// ---- Progress edge cases ----------------------------------------------------------------------

#[test]
fn a_progress_token_on_a_tool_that_does_not_report_is_harmless() {
    let mut s = Server::start();
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "exec",
        "arguments": { "action": "help" }, "_meta": { "progressToken": 9 } } }));
    let got = s.until(1, Duration::from_secs(5));
    assert!(answered(&got, &json!(1)));
    assert!(got.iter().all(|(_, m)| m["method"] != "notifications/progress"));
}

#[test]
fn progress_and_large_answers_never_tear_a_line() {
    let mut s = Server::start();
    // About 1 MB in one answer while another call streams progress beside it.
    s.exec(1, "head -c 1000000 /dev/zero | tr '\\0' 'a'; sleep 1", Some(json!({ "progressToken": "big" })));
    s.exec(2, "for i in 1 2 3; do echo tick$i; sleep 0.5; done", Some(json!({ "progressToken": "small" })));
    let got = s.collect(Duration::from_secs(5));
    assert!(got.iter().all(|(_, m)| m.get(TORN).is_none()), "a line was torn");
    assert!(answered(&got, &json!(1)) && answered(&got, &json!(2)));
    let big = got.iter().find(|(_, m)| m["id"] == 1).unwrap();
    assert!(big.1.to_string().len() > 1_000_000);
    for token in ["big", "small"] {
        assert!(got.iter().any(|(_, m)| m["params"]["progressToken"] == token), "no progress for {token}");
    }
}

// ---- Messages that are not requests -----------------------------------------------------------

#[test]
fn notifications_and_client_replies_get_no_answer() {
    let mut s = Server::start();
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    s.send(json!({ "jsonrpc": "2.0", "id": 77, "result": {} }));
    s.send(json!({ "jsonrpc": "2.0", "id": 78, "error": { "code": -1, "message": "no" } }));
    s.send(ping(json!(1)));
    let got = s.collect(Duration::from_secs(2));
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(answered(&got, &json!(1)));
}

#[test]
fn a_malformed_line_is_a_parse_error_and_the_server_carries_on() {
    let mut s = Server::start();
    writeln!(s.stdin.as_mut().unwrap(), "{{not json").unwrap();
    s.send(ping(json!(1)));
    let got = s.collect(Duration::from_secs(2));
    assert!(got.iter().any(|(_, m)| m["error"]["code"] == -32700), "{got:?}");
    assert!(answered(&got, &json!(1)));
}

#[test]
fn a_batch_is_answered_as_a_batch() {
    let mut s = Server::start();
    s.send(json!([ping(json!(1)), ping(json!(2))]));
    let got = s.collect(Duration::from_secs(2));
    let batch = got.iter().find(|(_, m)| m.is_array()).expect("an array answer");
    assert_eq!(batch.1.as_array().unwrap().len(), 2);
}

#[test]
fn a_reused_id_still_answers_both() {
    let mut s = Server::start();
    s.exec(9, "sleep 0.5; echo first", None);
    s.exec(9, "sleep 0.5; echo second", None);
    let got = s.collect(Duration::from_secs(3));
    assert_eq!(got.iter().filter(|(_, m)| m["id"] == 9).count(), 2);
}

// ---- Shutdown ---------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn end_of_input_does_not_wait_for_a_backgrounded_process() {
    let mut s = Server::start();
    let marker = format!("hanzo-bg-eof-{}", std::process::id());
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "exec",
        "arguments": { "action": "exec", "command": format!("sleep 20; echo {marker}"), "timeout": 1 } } }));
    assert!(answered(&s.until(1, Duration::from_secs(5)), &json!(1)));
    let start = Instant::now();
    drop(s.stdin.take());
    while s.child.try_wait().unwrap().is_none() {
        assert!(start.elapsed() < Duration::from_secs(5), "the server waited for a backgrounded command");
        std::thread::sleep(Duration::from_millis(50));
    }
    reap(&marker);
}

#[test]
fn a_client_that_stops_reading_does_not_hang_the_server() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hanzo-mcp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let mut stdin = child.stdin.take().unwrap();
    for id in 0..5 {
        let _ = writeln!(stdin, "{}", ping(json!(id)));
    }
    drop(stdin);
    let start = Instant::now();
    while child.try_wait().unwrap().is_none() {
        assert!(start.elapsed() < Duration::from_secs(10), "the server hung on a closed stdout");
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---- What the model is told -------------------------------------------------------------------

#[test]
fn errors_name_the_tool_and_what_to_do() {
    let mut s = Server::start();
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "nope", "arguments": {} } }));
    s.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "fs", "arguments": { "action": 5 } } }));
    s.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "exec", "arguments": { "action": "exec", "command": "sudo true" } } }));
    s.send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "exec", "arguments": { "action": "exec", "command": "git push origin main" } } }));
    let got = s.collect(Duration::from_secs(4));
    let text = |id: u64| {
        let r = &got.iter().find(|(_, m)| m["id"] == id).unwrap_or_else(|| panic!("no answer to {id}")).1["result"];
        assert_eq!(r["isError"], true, "{id}: {r}");
        r["content"][0]["text"].as_str().unwrap().to_string()
    };
    let unknown = text(1);
    assert!(unknown.starts_with("Unknown tool: nope. This server serves: ") && unknown.contains("exec"), "{unknown}");
    let schema = text(2);
    assert!(schema.starts_with("Error: fs: ") && schema.contains("inputSchema"), "{schema}");
    let deny = text(3);
    assert!(deny.starts_with("Error: exec: refused") && !deny.contains("inputSchema"), "{deny}");
    let ask = text(4);
    assert!(ask.starts_with("Error: exec: approval required") && ask.contains("approve: true"), "{ask}");
}

#[test]
fn a_restricted_server_lists_and_serves_only_its_tools() {
    let mut s = Server::start_with(&["--tools", "fs,think"]);
    s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    s.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "exec", "arguments": { "action": "help" } } }));
    let got = s.collect(Duration::from_secs(3));
    let tools = &got.iter().find(|(_, m)| m["id"] == 1).unwrap().1["result"]["tools"];
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["fs", "think"]);
    assert!(tools.as_array().unwrap().iter().all(|t| t["annotations"]["title"].is_string()));
    let refused = got.iter().find(|(_, m)| m["id"] == 2).unwrap().1["result"]["content"][0]["text"].as_str().unwrap().to_string();
    assert_eq!(refused, "Unknown tool: exec. This server serves: fs, think.");
}

#[test]
fn every_revision_hears_the_same_initialize() {
    for version in ["2025-06-18", "2025-03-26", "2024-11-05"] {
        let mut s = Server::start();
        s.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": version } }));
        let answer = s.until(1, Duration::from_secs(5));
        let r = &answer.last().unwrap().1["result"];
        assert_eq!(r["protocolVersion"], version);
        assert_eq!(r["capabilities"], json!({ "tools": {} }), "{version}");
        assert!(r["instructions"].is_string(), "{version}");
    }
}
