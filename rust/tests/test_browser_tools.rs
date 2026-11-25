//! The browser and cdp tools over a real ZAP router.
//!
//! This test process embeds the router exactly as hanzo-mcp does, on a private
//! `XDG_RUNTIME_DIR` / `XDG_STATE_HOME` / `HOME`, so it never touches the router
//! (or the browser) of the user running it. A fake extension joins that router
//! over its unix socket as `browser/chrome-test`, answers every ROUTE with the
//! method and params it decoded, and plays the page engine for `snapshot`.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use hanzo_mcp::tools::{BrowserTool, BrowserToolArgs, CdpTool};
use hanzo_mcp::zap;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use zapd::frame::{self, Frame};

mod common;

/// The private home, with the fake browser joined.
fn home() {
    static BROWSER: OnceLock<()> = OnceLock::new();
    BROWSER.get_or_init(|| {
        common::home();
        std::thread::spawn(|| {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(fake_browser())
        });
    });
}

/// A browser node: HELLO as `browser/chrome-test`, then answer every ROUTE.
async fn fake_browser() {
    let sock = zapd::socket_path();
    let s = loop {
        match UnixStream::connect(&sock).await {
            Ok(s) => break s,
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    };
    let (mut rd, mut wr) = s.into_split();
    let desc = frame::Descriptor { role: frame::ROLE_PROVIDER, brand: "hanzo".into(), caps: vec!["browser.tabs".into()], attrs: vec![] };
    wr.write_all(&Frame::new(frame::HELLO, "browser/chrome-test", "", frame::encode_hello(&desc)).encode()).await.unwrap();
    while let Ok(Some(f)) = Frame::read(&mut rd).await {
        if f.typ != frame::ROUTE {
            continue;
        }
        let (method, params) = decode_cmd(&f.payload);
        let reply = match method.as_str() {
            "hanzo.snapshot" => json!({"title": "Example", "url": "https://example.com/", "refs": 1, "tree": "- button \"Go\" [ref=e1]"}).to_string(),
            "hanzo.act" if params.get("selector").map(String::as_str) == Some("@e9") => "ERR:@e9 is stale: snapshot again".into(),
            _ => json!({"method": method, "params": params}).to_string(),
        };
        wr.write_all(&Frame::new(frame::RESPONSE, "", &f.from, reply.into_bytes()).encode()).await.unwrap();
    }
}

/// The extension's `decodeCmd`, for the fake.
fn decode_cmd(p: &[u8]) -> (String, BTreeMap<String, String>) {
    let mut c = frame::Cursor::new(p);
    let method = c.str().unwrap();
    let n = c.u16().unwrap();
    let mut params = BTreeMap::new();
    for _ in 0..n {
        let k = c.str().unwrap();
        let len = c.u32().unwrap() as usize;
        params.insert(k, String::from_utf8(c.take(len).unwrap().to_vec()).unwrap());
    }
    (method, params)
}

async fn browser(args: Value) -> String {
    home();
    let args: BrowserToolArgs = serde_json::from_value(args).unwrap();
    BrowserTool::new().execute(args).await.unwrap()
}

fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| panic!("not JSON: {s}"))
}

/// The fake browser has joined when the router lists it.
async fn joined() {
    home();
    for _ in 0..200 {
        if zap::resolve(None, None).await.ok().flatten().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the fake browser never joined the router");
}

#[tokio::test]
async fn browsers_lists_the_node_on_the_router() {
    joined().await;
    let v = parse(&browser(json!({"action": "browsers"})).await);
    assert_eq!(v["count"], 1);
    let id = v["browsers"][0]["id"].as_str().unwrap();
    assert!(id.starts_with("browser/") && id.ends_with("/chrome-test"), "{id}");
    assert_eq!(v["browsers"][0]["role"], "provider");
    assert_eq!(zap::resolve(Some("chrome"), None).await.unwrap().as_deref(), Some(id));
    assert_eq!(zap::resolve(Some("firefox"), None).await.unwrap(), None);
}

#[tokio::test]
async fn an_action_routes_as_its_extension_method() {
    joined().await;
    let v = parse(&browser(json!({"action": "click", "selector": "@e1", "tab_id": "tab-7"})).await);
    assert_eq!(v["success"], true);
    assert_eq!(v["method"], "hanzo.act");
    assert_eq!(v["params"], json!({"op": "click", "selector": "@e1", "tabId": "7"}));

    let v = parse(&browser(json!({"action": "select", "selector": "#plan", "args": {"value": "Weekly"}})).await);
    assert_eq!(v["params"], json!({"op": "select", "selector": "#plan", "value": "Weekly"}));

    let v = parse(&browser(json!({"action": "evaluate", "code": "document.title"})).await);
    let result = parse(v["result"].as_str().unwrap());
    assert_eq!(result["method"], "Runtime.evaluate");
    assert_eq!(result["params"]["expression"], "document.title");
}

#[tokio::test]
async fn snapshot_answers_text_and_a_refusal_is_an_error() {
    joined().await;
    let text = browser(json!({"action": "snapshot", "interactive": true})).await;
    assert_eq!(text, "Example — https://example.com/ (1 refs)\n- button \"Go\" [ref=e1]");

    let v = parse(&browser(json!({"action": "click", "selector": "@e9"})).await);
    assert_eq!(v["error"], "@e9 is stale: snapshot again");
}

#[tokio::test]
async fn unpaired_target_returns_zap_error_without_playwright() {
    joined().await;
    let v = parse(&browser(json!({"action": "click", "selector": "@e1", "target_browser": "firefox"})).await);
    assert!(v["error"].as_str().unwrap().starts_with("no browser on the ZAP router"), "{v}");

    let status = parse(&browser(json!({"action": "status", "target_browser": "firefox"})).await);
    assert_eq!(status["connected"], false);
    assert_eq!(status["source"], "extension");
    assert_eq!(status["transport"], "native-zap");

    let def = hanzo_mcp::tools::BrowserToolDefinition::new();
    assert!(!def.description.to_lowercase().contains("playwright"), "{}", def.description);
}

#[tokio::test]
async fn cdp_sends_the_method_verbatim() {
    joined().await;
    let cdp = CdpTool::new();
    let v = cdp.run(&json!({"action": "send", "method": "Page.navigate", "params": {"url": "https://example.com", "n": 2}, "tab_id": 7})).await;
    assert_eq!(v["transport"], "native-zap");
    let result = parse(v["result"].as_str().unwrap());
    assert_eq!(result, json!({"method": "Page.navigate", "params": {"url": "https://example.com", "n": "2", "tabId": "7"}}));

    let v = cdp.run(&json!({"action": "tabs"})).await;
    assert_eq!(parse(v["result"].as_str().unwrap())["method"], "Target.getTargets");
    assert_eq!(cdp.run(&json!({"action": "send"})).await["error"], "method required for action=send (e.g. 'Page.navigate')");
}

#[tokio::test]
async fn help_and_unknown_are_local() {
    let text = browser(json!({"action": "help", "topic": "tabs"})).await;
    assert!(text.starts_with("tabs\n  new_tab"), "{text}");
    let v = parse(&browser(json!({"action": "nope"})).await);
    assert!(v["error"].as_str().unwrap().starts_with("Unknown action \"nope\". Core: navigate, snapshot"));
    let v = parse(&browser(json!({"action": "click", "args": {"bogus": 1}})).await);
    assert!(v["error"].as_str().unwrap().starts_with("Unknown args"));
}

#[tokio::test]
async fn browser_read_allows_discovery_blocks_mutations_and_sets_readonly_hint() {
    joined().await;
    let reader = hanzo_mcp::tools::BrowserReadTool::new();

    // Default action is `tabs` — succeeds without write approval
    let tabs = parse(&reader.execute(BrowserToolArgs::default()).await.unwrap());
    assert_eq!(tabs["success"], true);
    assert_eq!(parse(tabs["result"].as_str().unwrap())["method"], "Target.getTargets");

    // Snapshot also works read-only
    let snap = reader
        .execute(serde_json::from_value(json!({"action": "snapshot", "interactive": true})).unwrap())
        .await
        .unwrap();
    assert_eq!(snap, "Example — https://example.com/ (1 refs)\n- button \"Go\" [ref=e1]");

    // Mutating actions are blocked and classified as permission failures
    for bad in ["click", "navigate", "fill", "evaluate", "close_tab", "lastpass_fill"] {
        let v = parse(
            &reader
                .execute(serde_json::from_value(json!({"action": bad})).unwrap())
                .await
                .unwrap(),
        );
        assert_eq!(v["read_only"], true, "{bad}: {v}");
        assert_eq!(v["diagnostic"]["category"], "permission", "{bad}: {v}");
    }

    // ToolRegistry executes `browser_read` silently on default surface (preserving 19 canonical tools),
    // and exposes `browser_read` with readOnlyHint=true when explicitly requested via `--tools`.
    let reg = hanzo_mcp::ToolRegistry::with_defaults();
    let call_res = reg.execute("browser_read", json!({"action": "tabs"})).await.unwrap();
    assert!(call_res.success);
    let defs = reg.get_definitions();
    let write_def = defs.iter().find(|d| d["name"] == "browser").expect("browser listed");
    assert_eq!(write_def["annotations"]["readOnlyHint"], false);
    assert_eq!(write_def["annotations"]["destructiveHint"], true);

    let mut read_only_reg = hanzo_mcp::ToolRegistry::with_defaults();
    read_only_reg.restrict(["browser_read"]).unwrap();
    let ro_defs = read_only_reg.get_definitions();
    let read_def = ro_defs.iter().find(|d| d["name"] == "browser_read").expect("browser_read listed");
    assert_eq!(read_def["annotations"]["readOnlyHint"], true);
    assert_eq!(read_def["annotations"]["title"], "Browser (read-only)");
}

#[test]
fn diagnostics_distinguish_permission_from_transport_and_native_host() {
    use hanzo_mcp::tools::browser_tool::diagnose_error;
    assert_eq!(diagnose_error("Cannot access a chrome:// URL").category, "permission");
    assert_eq!(diagnose_error("User declined host permission").category, "permission");
    assert_eq!(diagnose_error("Specified native messaging host ai.hanzo.zap not found").category, "native_host");
    assert_eq!(diagnose_error("no browser on the ZAP router: open Chrome").category, "extension_unpaired");
    assert_eq!(diagnose_error("connection refused on zapd socket").category, "transport");
    assert_eq!(diagnose_error("request timed out after 30s").category, "transport");
    assert_eq!(diagnose_error("@e9 is stale: snapshot again").category, "page");
}
