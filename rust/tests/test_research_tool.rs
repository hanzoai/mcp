//! `research` end-to-end against a stand-in `/v1/ask`.
//!
//! The tool is exercised through the registry — the same door MCP `tools/call`
//! uses — against a loopback server that speaks the exact stream cloud
//! `apps/answer` writes. That pins the whole path in one test: the request the
//! tool sends (POST, `/v1/ask`, `Accept: text/event-stream`, bearer, `{q,mode}`)
//! and the answer it folds back out of the frames.

use std::collections::HashMap;

use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// One request as the stand-in server saw it.
struct Seen {
    start: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// Serve `stream` as SSE to exactly one request, then report what that request
/// was. Returns the base URL to point `HANZO_API_BASE` at.
async fn serve(stream: String) -> (String, JoinHandle<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));

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
        let body: Value = serde_json::from_slice(&raw[head..head + len]).expect("json body");

        // `Connection: close` ends the stream at EOF — no chunk framing needed.
        sock.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .expect("write head");
        sock.write_all(stream.as_bytes()).await.expect("write stream");
        sock.shutdown().await.expect("shutdown");

        Seen { start, headers, body }
    });

    (base, task)
}

#[tokio::test]
async fn research_asks_the_one_door_and_folds_the_stream() {
    let src = json!({
        "url": "https://clojure.org/about", "title": "Clojure", "snippet": "simple",
        "engine": "bing", "favicon": "https://f/c"
    });
    let stream = [
        json!({ "type": "status", "stage": "planning", "detail": "3 topics" }),
        json!({ "type": "sources", "sources": [src] }),
        json!({ "type": "status", "stage": "reading", "detail": "clojure.org" }),
        json!({ "type": "text", "delta": "Simple " }),
        json!({ "type": "text", "delta": "is not easy" }),
        json!({ "type": "follow_ups", "questions": ["Why?"] }),
        json!({ "type": "done", "answer": "Simple is not easy", "sources": [src] }),
    ]
    .iter()
    .map(|e| format!("data: {e}\n\n"))
    .collect::<String>()
        + "data: [DONE]\n\n";

    let (base, served) = serve(stream).await;
    std::env::set_var("HANZO_API_BASE", &base);
    std::env::set_var("HANZO_API_KEY", "sk-test");

    let out = ToolRegistry::with_defaults()
        .execute("research", json!({ "query": "is simple easy", "mode": "deep" }))
        .await
        .expect("research executes");

    // What came back: one cited answer plus the sources behind it.
    assert_eq!(out.content["ok"], true, "envelope: {}", out.content);
    let data = &out.content["data"];
    assert_eq!(data["answer"], "Simple is not easy");
    assert_eq!(data["query"], "is simple easy");
    assert_eq!(data["mode"], "research", "deep resolves to the live mode name");
    assert_eq!(data["complete"], true);
    assert_eq!(data["follow_ups"], json!(["Why?"]));
    assert_eq!(
        data["sources"],
        json!([{ "url": "https://clojure.org/about", "title": "Clojure", "favicon": "https://f/c" }])
    );
    assert_eq!(out.content["meta"]["tool"], "research");

    // What went out: ONE request to ONE door, no client-side search pass.
    let seen = served.await.expect("server");
    assert_eq!(seen.start, "POST /v1/ask HTTP/1.1");
    assert_eq!(seen.headers.get("accept").map(String::as_str), Some("text/event-stream"));
    assert_eq!(seen.headers.get("authorization").map(String::as_str), Some("Bearer sk-test"));
    assert_eq!(seen.body, json!({ "q": "is simple easy", "mode": "research" }));
}

#[tokio::test]
async fn research_is_advertised_with_its_schema() {
    let registry = ToolRegistry::with_defaults();
    assert!(registry.list().contains(&"research".to_string()));
    let def = registry
        .get_definitions()
        .into_iter()
        .find(|d| d["name"] == "research")
        .expect("research is advertised to tools/list");
    assert_eq!(def["inputSchema"]["required"], json!(["query"]));
    assert_eq!(def["inputSchema"]["properties"]["query"]["type"], "string");
    assert_eq!(def["inputSchema"]["properties"]["mode"]["default"], "research");
}
