//! `coding` against a stand-in api.hanzo.ai.
//!
//! The tool is driven through the registry — the door MCP `tools/call` uses — so
//! the test pins what goes on the wire for each action: the method, the path, the
//! body, the bearer, and the answer coming back. A refusal must read as an error.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// `HANZO_API_BASE` is process-wide and a tool reads it once, when it is
/// constructed — so a test that points it somewhere owns it until it is done.
static ENV: Mutex<()> = Mutex::new(());

fn own_env() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Seen {
    start: String,
    headers: HashMap<String, String>,
    body: Option<Value>,
}

/// Answer exactly one request with `status` and `reply`, then report what it was.
async fn serve(status: &str, reply: Value) -> (String, JoinHandle<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let status = status.to_string();

    let task = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        let head = loop {
            let n = sock.read(&mut buf).await.expect("read");
            assert!(n > 0, "client closed mid-request");
            raw.extend_from_slice(&buf[..n]);
            if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let text = String::from_utf8_lossy(&raw[..head]).to_string();
        let mut lines = text.lines();
        let start = lines.next().unwrap_or_default().to_string();
        let headers: HashMap<String, String> = lines
            .filter_map(|l| l.split_once(": "))
            .map(|(k, v)| (k.to_lowercase(), v.to_string()))
            .collect();
        let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while raw.len() < head + len {
            let n = sock.read(&mut buf).await.expect("read body");
            assert!(n > 0, "client closed mid-body");
            raw.extend_from_slice(&buf[..n]);
        }
        let body = (len > 0).then(|| serde_json::from_slice(&raw[head..head + len]).expect("json body"));

        let payload = reply.to_string();
        sock.write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            )
            .as_bytes(),
        )
        .await
        .expect("write reply");
        sock.shutdown().await.expect("shutdown");
        Seen { start, headers, body }
    });
    (base, task)
}

async fn call_with(status: &str, reply: Value, params: Value) -> (Value, Seen) {
    let (base, served) = serve(status, reply).await;
    std::env::set_var("HANZO_API_BASE", &base);
    std::env::set_var("HANZO_API_KEY", "sk-test");
    let out = ToolRegistry::with_defaults().execute("coding", params).await.expect("coding executes");
    (out.content, served.await.expect("server"))
}

async fn call(reply: Value, params: Value) -> (Value, Seen) {
    call_with("200 OK", reply, params).await
}

#[tokio::test]
async fn the_tool_is_listed_with_a_description_a_bot_can_act_on() {
    let defs = ToolRegistry::with_defaults().get_definitions();
    let coding = defs.iter().find(|d| d["name"] == "coding").expect("coding is registered");
    let text = coding["description"].as_str().unwrap();
    for word in ["start", "progress", "changes", "merge", "session", "branch", "after"] {
        assert!(text.contains(word), "the description never says {word:?}: {text}");
    }
    let actions = coding["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
    for a in ["start", "progress", "changes", "artifacts", "steer", "merge", "stop"] {
        assert!(actions.contains(&json!(a)), "{a} is not an action");
    }
    assert_eq!(coding["inputSchema"]["required"], json!(["action"]));
}

/// The acts run in order in one test: env is process-wide.
#[tokio::test]
async fn each_action_is_one_request_at_its_own_path() {
    let _env = own_env();

    // start → the session comes back under the name every later action takes.
    let (out, seen) = call(
        json!({ "sessionId": "ses-7", "branch": "agent/ses-7", "repo": "hanzoai/social" }),
        json!({ "action": "start", "repo": "hanzoai/social", "prompt": "fix the footer", "after": "ses-6", "timeoutSeconds": 3600 }),
    )
    .await;
    assert_eq!(seen.start, "POST /v1/agent/coding HTTP/1.1");
    assert_eq!(seen.headers.get("authorization").map(String::as_str), Some("Bearer sk-test"));
    assert_eq!(
        seen.body.unwrap(),
        json!({ "prompt": "fix the footer", "repo": "hanzoai/social", "after": "ses-6", "timeoutSeconds": 3600 })
    );
    assert_eq!(out["ok"], true);
    assert_eq!(out["data"]["session"], "ses-7");
    assert_eq!(out["data"]["sessionId"], "ses-7");
    assert_eq!(out["data"]["branch"], "agent/ses-7");

    // progress → the status route, no body.
    let (out, seen) = call(json!({ "phase": "running", "pct": 40 }), json!({ "action": "progress", "session": "ses-7" })).await;
    assert_eq!(seen.start, "GET /v1/agent/sessions/ses-7/progress HTTP/1.1");
    assert!(seen.body.is_none());
    assert_eq!(out["data"]["phase"], "running");

    // changes → the coding route; the pull request rides in the answer verbatim.
    let pull = json!({ "commits": [], "files": [], "pull": { "number": 14, "url": "https://x/pull/14", "state": "open" } });
    let (out, seen) = call(pull.clone(), json!({ "action": "changes", "session": "ses-7" })).await;
    assert_eq!(seen.start, "GET /v1/agent/coding/ses-7/changes HTTP/1.1");
    assert_eq!(out["data"], pull);

    // steer → the new words as `text`.
    let (_, seen) = call(json!({ "ok": true }), json!({ "action": "steer", "session": "ses-7", "text": "also add tests" })).await;
    assert_eq!(seen.start, "POST /v1/agent/coding/ses-7/steer HTTP/1.1");
    assert_eq!(seen.body.unwrap(), json!({ "text": "also add tests" }));

    // merge → bodyless.
    let (_, seen) = call(json!({ "number": 14, "state": "merged" }), json!({ "action": "merge", "session": "ses-7" })).await;
    assert_eq!(seen.start, "POST /v1/agent/coding/ses-7/merge HTTP/1.1");
    assert!(seen.body.is_none());

    // stop → the session route, with the reason as `message`.
    let (_, seen) = call(json!({ "ok": true }), json!({ "action": "stop", "session": "ses-7", "text": "wrong repo" })).await;
    assert_eq!(seen.start, "POST /v1/agent/sessions/ses-7/stop HTTP/1.1");
    assert_eq!(seen.body.unwrap(), json!({ "message": "wrong repo" }));

    // blob → the path is a query value, encoded.
    let (_, seen) = call(json!({ "content": "x" }), json!({ "action": "blob", "session": "ses-7", "path": "src/a b.rs" })).await;
    assert_eq!(seen.start, "GET /v1/agent/coding/ses-7/blob?path=src/a%20b.rs HTTP/1.1");
}

#[tokio::test]
async fn a_refusal_is_an_error_not_an_empty_success() {
    let _env = own_env();
    let (out, seen) = call_with(
        "404 Not Found",
        json!({ "error": { "message": "no such session" } }),
        json!({ "action": "progress", "session": "ses-nope" }),
    )
    .await;
    assert_eq!(seen.start, "GET /v1/agent/sessions/ses-nope/progress HTTP/1.1");
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"]["code"], "UPSTREAM");
    assert!(out["error"]["message"].as_str().unwrap().contains("no such session"), "{out}");
}

#[tokio::test]
async fn nothing_leaves_the_process_for_a_call_that_cannot_succeed() {
    let _env = own_env();
    // No server is listening on this base: any request would fail as UPSTREAM,
    // so INVALID_ARGS proves the call was refused before it was sent.
    std::env::set_var("HANZO_API_BASE", "http://127.0.0.1:9");
    std::env::set_var("HANZO_API_KEY", "sk-test");
    let registry = ToolRegistry::with_defaults();
    for (params, word) in [
        (json!({ "action": "start", "repo": "a/b" }), "prompt required"),
        (json!({ "action": "progress" }), "session required"),
        (json!({ "action": "changes", "session": "../admin" }), "not a session id"),
        (json!({ "action": "nope" }), "unknown action"),
        (json!({}), "action required"),
    ] {
        let out = registry.execute("coding", params.clone()).await.unwrap().content;
        assert_eq!(out["error"]["code"], "INVALID_ARGS", "{params}: {out}");
        assert!(out["error"]["message"].as_str().unwrap().contains(word), "{params}: {out}");
    }
}
