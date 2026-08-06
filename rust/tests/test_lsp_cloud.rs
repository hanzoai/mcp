//! `lsp` against a stand-in `/v1/code/lsp`.
//!
//! One tool, two planes. The tool is driven through the registry — the same
//! door MCP `tools/call` uses — so the test pins what actually goes on the
//! wire when a caller names a `repo`: the op the action maps to, the body it
//! carries (0-based line, UTF-16 character), the bearer, and the answer coming
//! back verbatim. With no `repo`, nothing leaves the process.

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

/// One request as the stand-in server saw it.
struct Seen {
    start: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// Answer exactly one request with `reply`, then report what that request was.
/// Returns the base URL to point `HANZO_API_BASE` at.
async fn serve(reply: Value) -> (String, JoinHandle<Seen>) {
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

        let payload = reply.to_string();
        sock.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
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

/// Run one `lsp` call against a stand-in server: returns what came back and
/// what went out. The registry is rebuilt per call because a tool resolves its
/// base URL once, when it is constructed.
async fn call(reply: Value, params: Value) -> (Value, Seen) {
    let (base, served) = serve(reply).await;
    std::env::set_var("HANZO_API_BASE", &base);
    std::env::set_var("HANZO_API_KEY", "hk-test");

    let out = ToolRegistry::with_defaults()
        .execute("lsp", params)
        .await
        .expect("lsp executes");

    (out.content, served.await.expect("server"))
}

/// The whole surface in one test: env is process-wide, so the acts run in
/// order rather than racing each other over `HANZO_API_BASE`.
#[tokio::test]
async fn repo_asks_the_cloud_and_file_stays_local() {
    let _env = own_env();

    // definition → locate(relation=definition), position on the wire in LSP's
    // own frame: the tool's 1-based line 42 leaves as 41.
    let hit = json!({
        "locations": [{ "repo": "hanzoai/mcp", "path": "rust/src/hanzo_api.rs", "line": 18, "character": 11 }]
    });
    let (out, seen) = call(
        hit.clone(),
        json!({
            "action": "definition",
            "repo": "hanzoai/mcp",
            "rev": "main",
            "file": "rust/src/tools/lsp_tool.rs",
            "line": 42,
            "character": 7
        }),
    )
    .await;

    assert_eq!(out, hit, "the cloud's answer comes back verbatim");
    assert_eq!(seen.start, "POST /v1/code/lsp/locate HTTP/1.1");
    assert_eq!(seen.headers.get("authorization").map(String::as_str), Some("Bearer hk-test"));
    assert_eq!(
        seen.body,
        json!({
            "repo": "hanzoai/mcp",
            "rev": "main",
            "path": "rust/src/tools/lsp_tool.rs",
            "line": 41,
            "character": 7,
            "relation": "definition"
        })
    );

    // references → the same op, a different relation (singular, per the route).
    let (_, seen) = call(
        json!({ "locations": [] }),
        json!({ "action": "references", "repo": "hanzoai/mcp", "file": "a.rs", "line": 1, "character": 0 }),
    )
    .await;
    assert_eq!(seen.start, "POST /v1/code/lsp/locate HTTP/1.1");
    assert_eq!(seen.body["relation"], "reference");
    assert_eq!(seen.body["line"], 0);
    assert!(seen.body.get("rev").is_none(), "an unnamed rev is absent, not empty");

    // type / implementation → the same op again.
    for (action, relation) in [("type", "type"), ("implementation", "implementation")] {
        let (_, seen) = call(
            json!({ "locations": [] }),
            json!({ "action": action, "repo": "hanzoai/mcp", "file": "a.rs", "line": 3, "character": 2 }),
        )
        .await;
        assert_eq!(seen.start, "POST /v1/code/lsp/locate HTTP/1.1");
        assert_eq!(seen.body["relation"], relation);
    }

    // The ops that stand on their own: no relation, one URL each.
    for (action, op) in [
        ("hover", "hover"),
        ("symbols", "symbols"),
        ("diagnostics", "diagnostics"),
        ("completion", "complete"),
    ] {
        let (_, seen) = call(
            json!({ "ok": true }),
            json!({ "action": action, "repo": "hanzoai/mcp", "file": "a.rs", "line": 9, "character": 4 }),
        )
        .await;
        assert_eq!(seen.start, format!("POST /v1/code/lsp/{op} HTTP/1.1"));
        assert!(seen.body.get("relation").is_none(), "{action} carries no relation");
        assert_eq!(seen.body["path"], "a.rs");
        assert_eq!(seen.body["line"], 8);
    }
}

/// No `repo` means no cloud: the local plane answers, and nothing is sent.
/// `HANZO_API_BASE` points at a closed port, so a request would surface as a
/// connection error instead of the local answer asserted here.
#[tokio::test]
async fn file_alone_stays_on_the_local_plane() {
    let _env = own_env();
    std::env::set_var("HANZO_API_BASE", "http://127.0.0.1:1");
    std::env::set_var("HANZO_API_KEY", "hk-test");
    let registry = ToolRegistry::with_defaults();

    let out = registry
        .execute("lsp", json!({ "action": "definition", "file": "notes.txt" }))
        .await
        .expect("lsp executes")
        .content;
    assert!(out["error"].as_str().unwrap().contains("Unsupported file type"));
    assert!(out["supported_languages"].as_array().unwrap().contains(&json!("go")));

    // Neither plane named: one clear error, no work attempted.
    let out = registry
        .execute("lsp", json!({ "action": "definition" }))
        .await
        .expect("lsp executes")
        .content;
    assert!(out["error"].as_str().unwrap().starts_with("file is required"));
}

/// One tool, one schema — the cloud plane is two more properties, not a
/// second tool.
#[tokio::test]
async fn lsp_is_one_tool_advertising_both_planes() {
    let registry = ToolRegistry::with_defaults();
    let names = registry.list();
    assert_eq!(
        names.iter().filter(|n| n.starts_with("lsp")).collect::<Vec<_>>(),
        vec![&"lsp".to_string()],
        "`lsp` is the only lsp tool"
    );

    let def = registry
        .get_definitions()
        .into_iter()
        .find(|d| d["name"] == "lsp")
        .expect("lsp is advertised to tools/list");
    let props = &def["inputSchema"]["properties"];
    assert_eq!(props["repo"]["type"], "string");
    assert_eq!(props["rev"]["type"], "string");
    assert_eq!(def["inputSchema"]["required"], json!(["action", "file"]));
    let actions = props["action"]["enum"].as_array().expect("action enum");
    for action in ["definition", "references", "type", "implementation", "symbols", "hover", "completion", "diagnostics"] {
        assert!(actions.contains(&json!(action)), "{action} is advertised");
    }
}
