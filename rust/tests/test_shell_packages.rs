//! npx, uvx and jq as python-sdk offers them: a package run is an exec of its
//! argv (in exec's process table), and jq takes its filter as one argv word.

use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};

async fn call(name: &str, args: Value) -> hanzo_mcp::ToolResult {
    ToolRegistry::with_defaults().execute(name, args).await.unwrap()
}

#[tokio::test]
async fn npx_runs_its_argv_through_exec() {
    let r = call("npx", json!({"package": "--version", "yes": false})).await;
    assert_eq!(r.content["status"], "success", "{:?}", r.content);
    assert!(r.content["stdout"].as_str().unwrap().trim().chars().next().unwrap().is_ascii_digit());
    let defs = ToolRegistry::with_defaults().get_definitions();
    for t in ["npx", "uvx", "jq"] {
        assert!(defs.iter().any(|d| d["name"] == t), "{t} is offered");
    }
}

#[tokio::test]
async fn jq_filters_without_a_shell() {
    let r = call("jq", json!({"filter": ".items[] | select(.on != false) | .name", "input": r#"{"items":[{"name":"a","on":true},{"name":"b","on":false}]}"#, "raw": true})).await;
    assert!(r.success, "{:?}", r.error);
    assert_eq!(r.content, json!("a"));

    let bad = call("jq", json!({"filter": ".", "input": "{nope"})).await;
    assert!(bad.error.unwrap().starts_with("Error: Invalid JSON input"));
    let none = call("jq", json!({"filter": "."})).await;
    assert_eq!(none.error.unwrap(), "Error: Either 'input' or 'file' is required");
}
