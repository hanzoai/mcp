//! `kai_decide` and `llm` against a stand-in api.hanzo.ai.
//!
//! Each tool is driven through the registry — the door MCP `tools/call` uses —
//! against a loopback server that answers one request the way the gateway does,
//! so a test pins both what went out (method, path, bearer, Enso's headers, the
//! body) and what the tool made of the answer, refusals included.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// `HANZO_API_BASE` is process-wide and a tool reads it when it is constructed,
/// so a test that points it somewhere owns it until it is done.
static ENV: Mutex<()> = Mutex::new(());

fn own_env() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Seen {
    start: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// Answer exactly one request with `status`, `extra` headers and `reply`, then
/// report what that request was.
async fn serve(status: u16, extra: &'static str, reply: Value) -> (String, JoinHandle<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let task = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut raw = Vec::new();
        let mut buf = [0u8; 8192];
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
        let body = if len == 0 { Value::Null } else { serde_json::from_slice(&raw[head..head + len]).expect("json body") };
        let out = reply.to_string();
        let resp = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{out}",
            out.len()
        );
        sock.write_all(resp.as_bytes()).await.expect("write");
        sock.shutdown().await.expect("shutdown");
        Seen { start, headers, body }
    });
    (base, task)
}

fn point(base: &str) {
    std::env::set_var("HANZO_API_BASE", base);
    std::env::set_var("HANZO_API_KEY", "sk-test");
}

#[tokio::test]
async fn kai_decide_posts_the_decision_and_returns_it() {
    let _env = own_env();
    let questions = json!({
        "team": { "type": "choice", "instructions": "Which team should handle it?", "criteria": { "account": "logins", "payments": "charges and refunds" } }
    });
    let decision = json!({
        "id": "dec_ff9388f6b8b85328960ba301635ac108", "model": "kai", "provider": "Hanzo",
        "answers": { "team": { "type": "choice", "choice": "payments", "confidence": 0.9983, "probabilities": { "account": 0.0006, "payments": 0.9989 }, "answer_confidence": 0.9989 } },
        "usage": { "input_tokens": 30, "output_tokens": 0 }
    });
    let (base, served) = serve(200, "", decision.clone()).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("kai_decide", json!({ "state": { "message": "charged twice" }, "questions": questions }))
        .await
        .expect("executes");
    assert_eq!(out.content["ok"], true, "{}", out.content);
    assert_eq!(out.content["data"], decision);
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "POST /v1/decisions HTTP/1.1");
    assert_eq!(seen.headers.get("authorization").map(String::as_str), Some("Bearer sk-test"));
    assert_eq!(seen.body, json!({ "model": "kai", "state": { "message": "charged twice" }, "questions": questions }));
}

#[tokio::test]
async fn kai_decide_carries_the_servers_refusal() {
    let _env = own_env();
    let (base, served) = serve(429, "", json!({ "error": { "message": "Free plan: today's Kai requests are used.", "code": "free_plan_cap" } })).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("kai_decide", json!({ "state": "s", "questions": { "q": { "type": "noul" } } }))
        .await
        .expect("executes");
    served.await.expect("server");
    assert_eq!(out.content["ok"], false);
    assert_eq!(out.content["error"]["message"], "429: Free plan: today's Kai requests are used.");
}

#[tokio::test]
async fn llm_query_carries_enso_bounds_and_returns_the_model_that_served() {
    let _env = own_env();
    let completion = json!({
        "id": "chatcmpl-27d2ce46", "object": "chat.completion", "model": "enso-free",
        "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": "Red" } }],
        "usage": { "prompt_tokens": 110, "completion_tokens": 1, "total_tokens": 111 }
    });
    let (base, served) = serve(200, "X-Routed-Model: enso-free\r\n", completion).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("llm", json!({ "action": "query", "model": "auto", "prompt": "One color.", "max_tokens": 20, "max_cost": 0.01, "max_latency_ms": 800 }))
        .await
        .expect("executes");
    assert_eq!(out.content["ok"], true, "{}", out.content);
    let data = &out.content["data"];
    assert_eq!(data["id"], "chatcmpl-27d2ce46");
    assert_eq!(data["model"], "enso-free");
    assert_eq!(data["content"], "Red");
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "POST /v1/chat/completions HTTP/1.1");
    assert_eq!(seen.headers.get("x-max-cost").map(String::as_str), Some("0.01"));
    assert_eq!(seen.headers.get("x-max-latency-ms").map(String::as_str), Some("800"));
    assert_eq!(seen.body["model"], "auto");
    assert_eq!(seen.body["max_tokens"], 20);
    assert_eq!(seen.body["messages"], json!([{ "role": "user", "content": "One color." }]));
}

#[tokio::test]
async fn llm_query_defaults_to_enso_auto_and_sends_no_unasked_bound() {
    let _env = own_env();
    let (base, served) = serve(200, "", json!({ "id": "chatcmpl-1", "model": "enso-auto", "choices": [{ "message": { "content": "ok" } }] })).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "prompt": "hi" })).await.expect("executes");
    assert_eq!(out.content["data"]["model"], "enso-auto", "{}", out.content);
    let seen = served.await.expect("server");
    assert_eq!(seen.body["model"], "enso-auto");
    assert!(!seen.headers.contains_key("x-max-cost"));
    assert!(!seen.headers.contains_key("x-max-latency-ms"));
}

#[tokio::test]
async fn llm_query_refusal_is_an_error_not_an_empty_answer() {
    let _env = own_env();
    let (base, served) = serve(402, "", json!({ "error": { "message": "Pick a plan", "type": "billing_error" } })).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "prompt": "hi" })).await.expect("executes");
    served.await.expect("server");
    assert_eq!(out.content["ok"], false);
    assert_eq!(out.content["error"]["message"], "402: Pick a plan");
}

#[tokio::test]
async fn llm_models_lists_the_catalogs_own_prices_by_family() {
    let _env = own_env();
    let (base, served) = serve(200, "", json!({ "object": "list", "data": [
        { "id": "kai", "family": "kai", "class": "ours", "outputs": ["decision"], "pricing": { "input_per_million": 0.021, "output_per_million": 0 } },
        { "id": "enso-auto", "family": "enso", "class": "free", "outputs": ["text"], "context_window": 1000000, "pricing": { "input_per_million": 0, "output_per_million": 0 } },
        { "id": "zen5", "family": "zen", "class": "ours", "pricing": { "input_per_million": 0.3, "output_per_million": 1.2 } }
    ] })).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "action": "models", "family": "kai" })).await.expect("executes");
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "GET /v1/models HTTP/1.1");
    assert_eq!(out.content["data"], json!({ "count": 1, "models": [
        { "id": "kai", "family": "kai", "class": "ours", "outputs": ["decision"], "context_window": null, "input_per_million": 0.021, "output_per_million": 0 }
    ] }));
}

#[tokio::test]
async fn llm_feedback_posts_the_signal_and_returns_what_was_recorded() {
    let _env = own_env();
    let (base, served) = serve(200, "", json!({ "status": "ok", "msg": "", "data": { "request_id": "27d2ce46", "reward": 1, "recorded": true } })).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("llm", json!({ "action": "feedback", "request_id": "chatcmpl-27d2ce46", "signal": "rating", "rating": 3 }))
        .await
        .expect("executes");
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "POST /v1/ai/feedback HTTP/1.1");
    assert_eq!(seen.body, json!({ "request_id": "chatcmpl-27d2ce46", "signal": "rating", "rating": 3 }));
    assert_eq!(out.content["data"], json!({ "request_id": "27d2ce46", "reward": 1, "recorded": true }));
}

#[tokio::test]
async fn llm_feedback_refuses_a_shape_the_server_would_before_sending() {
    let _env = own_env();
    point("http://127.0.0.1:9");
    let r = ToolRegistry::with_defaults();
    let bad = r.execute("llm", json!({ "action": "feedback", "request_id": "chatcmpl-1", "signal": "bogus" })).await.unwrap();
    assert!(bad.content["error"]["message"].as_str().unwrap().contains("signal must be one of"));
    let bad = r.execute("llm", json!({ "action": "feedback", "request_id": "chatcmpl-1", "signal": "rating", "rating": 4 })).await.unwrap();
    assert!(bad.content["error"]["message"].as_str().unwrap().contains("rating must be 1, 2 or 3"));
    let bad = r.execute("llm", json!({ "prompt": "hi", "max_cost": -1 })).await.unwrap();
    assert!(bad.content["error"]["message"].as_str().unwrap().contains("max_cost must be a positive number"));
}

#[tokio::test]
async fn both_tools_are_advertised() {
    let defs = ToolRegistry::with_defaults().get_definitions();
    let kai = defs.iter().find(|d| d["name"] == "kai_decide").expect("kai_decide in tools/list");
    assert_eq!(kai["inputSchema"]["required"], json!(["state", "questions"]));
    let llm = defs.iter().find(|d| d["name"] == "llm").expect("llm in tools/list");
    assert_eq!(llm["inputSchema"]["properties"]["action"]["enum"], json!(["query", "consensus", "list", "models", "feedback"]));
}
