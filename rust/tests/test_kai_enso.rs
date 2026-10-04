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

/// POST /v1/decisions model kai, org hanzo on the free plan, as it answered live.
fn free_plan_cap() -> Value {
    json!({ "error": {
        "message": "Free plan: today's Kai requests are used. Upgrade for more: https://hanzo.ai/pay",
        "type": "rate_limit_error", "code": "free_plan_cap", "class": "ours", "resets_at": "2026-10-05T00:00:00Z",
        "upgrade_url": "https://hanzo.ai/pay/cart?plan=dev",
        "actions": [
            { "kind": "upgrade", "label": "Upgrade your plan", "url": "https://hanzo.ai/pay/cart?plan=dev", "plan": "dev" },
            { "kind": "topup", "label": "Add prepaid credit", "url": "https://hanzo.ai/pay" }
        ]
    } })
}

#[tokio::test]
async fn kai_decide_plan_refusal_is_an_error_naming_the_code_and_actions() {
    let _env = own_env();
    let (base, served) = serve(429, "Retry-After: 3204\r\n", free_plan_cap()).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("kai_decide", json!({ "state": "s", "questions": { "q": { "type": "noul" } } }))
        .await
        .expect("executes");
    served.await.expect("server");
    assert!(!out.success, "a refusal is an MCP error result");
    let error = json!({
        "status": 429, "code": "free_plan_cap",
        "message": "Free plan: today's Kai requests are used. Upgrade for more: https://hanzo.ai/pay",
        "class": "ours", "resets_at": "2026-10-05T00:00:00Z",
        "actions": [
            { "kind": "upgrade", "label": "Upgrade your plan", "url": "https://hanzo.ai/pay/cart?plan=dev", "plan": "dev" },
            { "kind": "topup", "label": "Add prepaid credit", "url": "https://hanzo.ai/pay" }
        ]
    });
    assert_eq!(out.content["error"], error);
    let text: Value = serde_json::from_str(out.error.as_deref().expect("error text")).expect("json text");
    assert_eq!(text, json!({ "error": error }));
}

#[tokio::test]
async fn a_402_without_a_plan_code_stays_the_servers_sentence() {
    let _env = own_env();
    let (base, served) = serve(429, "", json!({ "error": { "message": "The free pool is busy.", "code": "pool_busy" } })).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("kai_decide", json!({ "state": "s", "questions": { "q": { "type": "noul" } } }))
        .await
        .expect("executes");
    served.await.expect("server");
    assert_eq!(out.content["ok"], false);
    assert_eq!(out.content["error"]["message"], "429: The free pool is busy.");
}

#[tokio::test]
async fn llm_query_carries_enso_bounds_and_returns_the_model_that_served() {
    let _env = own_env();
    let completion = json!({
        "id": "chatcmpl-27d2ce46", "object": "chat.completion", "model": "enso-free",
        "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": "Red" } }],
        "usage": { "prompt_tokens": 110, "completion_tokens": 1, "total_tokens": 111 }
    });
    let (base, served) = serve(200, "X-Routed-Model: enso-free\r\nX-Hanzo-Served: enso-free\r\n", completion).await;
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
    assert_eq!(data["served"], "enso-free");
    assert_eq!(data["paid_by"], Value::Null);
    let seen = served.await.expect("server");
    assert!(!seen.headers.contains_key("x-hanzo-fallback"));
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
        { "id": "kai", "family": "kai", "class": "ours", "outputs": ["decision"], "context_window": null, "supports": [], "input_per_million": 0.021, "output_per_million": 0, "variable": false }
    ] }));
}

#[tokio::test]
async fn llm_query_says_who_served_and_who_paid_and_opts_into_the_fallback() {
    let _env = own_env();
    let completion = json!({ "id": "chatcmpl-9", "model": "enso", "choices": [{ "message": { "content": "ok" } }] });
    let (base, served) = serve(200, "X-Hanzo-Served: enso\r\nX-Hanzo-Paid-By: plan\r\nX-Hanzo-Usage: limited\r\nX-Hanzo-Usage-Class: premium\r\nX-Hanzo-Fallback: enso\r\nX-Hanzo-Usage-Reason: model_cap\r\n", completion).await;
    point(&base);
    let out = ToolRegistry::with_defaults()
        .execute("llm", json!({ "model": "anthropic/claude-opus-4.1", "prompt": "hi", "fallback": true }))
        .await
        .expect("executes");
    let seen = served.await.expect("server");
    assert_eq!(seen.headers.get("x-hanzo-fallback").map(String::as_str), Some("allow"));
    assert_eq!(seen.body["model"], "anthropic/claude-opus-4.1");
    let d = &out.content["data"];
    assert_eq!((d["served"].as_str(), d["paid_by"].as_str()), (Some("enso"), Some("plan")));
    assert_eq!((d["usage_state"].as_str(), d["usage_class"].as_str()), (Some("limited"), Some("premium")));
    assert_eq!((d["fallback"].as_str(), d["fallback_reason"].as_str()), (Some("enso"), Some("model_cap")));
}

#[tokio::test]
async fn llm_query_model_cap_offers_the_switch() {
    let _env = own_env();
    let (base, served) = serve(402, "", json!({ "error": {
        "message": "This model has used its share of your plan for now. Try Enso, continue with credits, or upgrade: https://hanzo.ai/pay",
        "type": "billing_error", "code": "model_cap", "class": "premium", "model": "anthropic/claude-opus-4.1", "fallback": "enso",
        "upgrade_url": "https://hanzo.ai/pay/cart?plan=max-20x",
        "actions": [
            { "kind": "upgrade", "label": "Upgrade your plan", "url": "https://hanzo.ai/pay/cart?plan=max-20x", "plan": "max-20x" },
            { "kind": "switch", "label": "Try Enso", "model": "enso" },
            { "kind": "credits", "label": "Continue with credits", "url": "/v1/ai/limits" }
        ]
    } })).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "model": "anthropic/claude-opus-4.1", "prompt": "hi" })).await.expect("executes");
    served.await.expect("server");
    assert!(!out.success);
    let e = &out.content["error"];
    assert_eq!((e["status"].as_u64(), e["code"].as_str(), e["fallback"].as_str()), (Some(402), Some("model_cap"), Some("enso")));
    assert_eq!(e["actions"][1], json!({ "kind": "switch", "label": "Try Enso", "model": "enso" }));
    assert!(e.get("type").is_none() && e.get("upgrade_url").is_none());
}

fn catalog() -> Value {
    json!({ "object": "list", "data": [
        { "id": "kai", "family": "kai", "class": "ours", "outputs": ["decision"], "pricing": { "input_per_million": 0.021, "output_per_million": 0 } },
        { "id": "zen5", "family": "zen", "class": "free", "outputs": ["text"], "supports_vision": true, "pricing": { "input_per_million": 0, "output_per_million": 0 } },
        { "id": "zen-embedding", "owned_by": "zenlm", "family": "zen", "class": "ours", "outputs": ["embeddings"], "pricing": { "input_per_million": 0.01, "output_per_million": 0.01 } },
        { "id": "anthropic/claude-sonnet-4.5", "owned_by": "anthropic", "name": "Claude Sonnet 4.5", "class": "premium", "inputs": ["text", "image", "file"], "outputs": ["text"], "supports_vision": true, "supports_tools": true, "supports_reasoning": true, "pricing": { "input_per_million": 3.6, "output_per_million": 18 } },
        { "id": "typesafe/jev-router", "name": "Jev Router", "class": "premium", "inputs": ["audio", "file", "image", "text", "video"], "outputs": ["text"], "supports_tools": true, "pricing": { "input_per_million": 180, "output_per_million": 720, "variable": true } }
    ] })
}

async fn models(args: Value) -> Vec<String> {
    let (base, served) = serve(200, "", catalog()).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", args).await.expect("executes");
    served.await.expect("server");
    out.content["data"]["models"].as_array().expect("models").iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn llm_models_searches_by_text_class_and_capability() {
    let _env = own_env();
    assert_eq!(models(json!({ "action": "models", "class": "ours" })).await, ["kai", "zen-embedding"]);
    assert_eq!(models(json!({ "action": "models", "search": "Sonnet" })).await, ["anthropic/claude-sonnet-4.5"]);
    assert_eq!(models(json!({ "action": "models", "search": "zenlm" })).await, ["zen-embedding"]);
    assert_eq!(models(json!({ "action": "models", "capability": "tools" })).await, ["anthropic/claude-sonnet-4.5", "typesafe/jev-router"]);
    assert_eq!(models(json!({ "action": "models", "capability": "embeddings" })).await, ["zen-embedding"]);
    assert_eq!(models(json!({ "action": "models", "class": "free", "family": "zen", "capability": "vision" })).await, ["zen5"]);
    let (base, served) = serve(200, "", catalog()).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "action": "models", "search": "router" })).await.unwrap();
    served.await.expect("server");
    assert_eq!(out.content["data"]["models"][0]["variable"], true);
    assert_eq!(out.content["data"]["models"][0]["supports"], json!(["tools"]));
    let bad = ToolRegistry::with_defaults().execute("llm", json!({ "action": "models", "class": "gold" })).await.unwrap();
    assert!(bad.content["error"]["message"].as_str().unwrap().contains("class must be one of premium, ours, free"));
}

#[tokio::test]
async fn llm_limits_reads_shares_states_resets_and_actions_and_no_figure() {
    let _env = own_env();
    let (base, served) = serve(200, "", json!({
        "plan": "max-5x", "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z", "state": "near",
        "classes": {
            "premium": { "percent": 85, "state": "near", "paying": "plan", "resets_at": "2026-11-01T00:00:00Z", "window": { "percent": 40, "state": "ok", "resets_at": "2026-10-05T03:00:00Z" }, "used_cents": 4250, "cap_cents": 5000 }
        },
        "session": { "percent": 20, "state": "ok", "resets_at": "2026-10-05T03:00:00Z", "used": 9, "limit": 45 },
        "paused": [{ "model": "anthropic/claude-opus-4.1", "fallback": "enso", "resets_at": "2026-11-01T00:00:00Z", "share_cents": 1500 }],
        "actions": [{ "kind": "upgrade", "label": "Upgrade to Max 20x", "url": "https://hanzo.ai/pay/cart?plan=max-20x", "plan": "max-20x", "price_cents": 20000 }],
        "upgrade": "max-20x", "credits_after_allowance": true, "allowance_cents": 5000, "balance_cents": 1234
    })).await;
    point(&base);
    let out = ToolRegistry::with_defaults().execute("llm", json!({ "action": "limits" })).await.expect("executes");
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "GET /v1/ai/limits HTTP/1.1");
    assert_eq!(out.content["data"], json!({
        "plan": "max-5x", "state": "near", "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
        "classes": { "premium": { "percent": 85, "state": "near", "resets_at": "2026-11-01T00:00:00Z", "paying": "plan", "window": { "percent": 40, "state": "ok", "resets_at": "2026-10-05T03:00:00Z" } } },
        "session": { "percent": 20, "state": "ok", "resets_at": "2026-10-05T03:00:00Z" },
        "paused": [{ "model": "anthropic/claude-opus-4.1", "fallback": "enso", "resets_at": "2026-11-01T00:00:00Z" }],
        "actions": [{ "kind": "upgrade", "label": "Upgrade to Max 20x", "url": "https://hanzo.ai/pay/cart?plan=max-20x", "plan": "max-20x" }],
        "upgrade": "max-20x", "credits_after_allowance": true
    }));
    let text = out.content.to_string();
    for figure in ["cents", "\"used\"", "\"limit\"", "balance", "4250", "1234", "5000"] {
        assert!(!text.contains(figure), "{figure} reached the result: {text}");
    }
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
    assert_eq!(llm["inputSchema"]["properties"]["action"]["enum"], json!(["query", "consensus", "list", "models", "limits", "feedback"]));
}
