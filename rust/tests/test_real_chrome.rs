//! Real Chrome tab discovery integration test.
//!
//! Opt-in via `HANZO_TEST_REAL_CHROME=1` so headless CI passes while local
//! developer / release runs verify end-to-end discovery against a real Chrome
//! instance running the Hanzo Browser Extension over native ZAP:
//!
//! ```sh
//! HANZO_TEST_REAL_CHROME=1 cargo test --test test_real_chrome -- --nocapture
//! ```

use hanzo_mcp::doctor;
use hanzo_mcp::tools::{BrowserReadTool, BrowserToolArgs};
use serde_json::{json, Value};

fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| panic!("not JSON: {s}"))
}

#[tokio::test]
async fn real_chrome_tab_discovery_and_doctor() {
    if std::env::var("HANZO_TEST_REAL_CHROME").as_deref() != Ok("1") {
        return;
    }

    // 1. Read-only browser_read discovers connected Chrome and enumerates real tabs
    let reader = BrowserReadTool::new();
    let browsers = parse(
        &reader
            .execute(serde_json::from_value(json!({"action": "browsers"})).unwrap())
            .await
            .unwrap(),
    );
    assert!(
        browsers["count"].as_u64().unwrap_or(0) >= 1,
        "Expected at least 1 connected Chrome extension on ZAP router: {browsers}"
    );

    let tabs_resp = parse(&reader.execute(BrowserToolArgs::default()).await.unwrap());
    assert_eq!(tabs_resp["success"], true, "tabs call failed: {tabs_resp}");
    assert_eq!(tabs_resp["transport"], "native-zap");
    let inner = parse(tabs_resp["result"].as_str().unwrap());
    let targets = inner["targetInfos"]
        .as_array()
        .or_else(|| inner.as_array())
        .expect("expected targetInfos array from Chrome");
    assert!(!targets.is_empty(), "Expected at least 1 open Chrome tab, got: {inner}");

    // 2. Doctor confirms ZAP router, native messaging, and live Chrome extension connectivity
    let report = doctor::run_doctor(false).await.unwrap();
    assert!(report.zap.reachable, "ZAP router not reachable: {report:?}");
    assert!(report.extension.connected, "Extension not connected: {report:?}");
    assert!(
        report.extension.tab_count.unwrap_or(0) >= 1,
        "Doctor did not see open tabs: {report:?}"
    );
    println!(
        "Real Chrome discovery verified: {} open tabs via {} ({})",
        targets.len(),
        tabs_resp["provider"],
        report.extension.product.as_deref().unwrap_or("Chrome")
    );
}
