//! npx, uvx and jq as python-sdk offers them: a package run is an exec of its
//! argv (in exec's process table), and jq takes its filter as one argv word.

use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};

async fn call(name: &str, args: Value) -> hanzo_mcp::ToolResult {
    ToolRegistry::with_defaults().execute(name, args).await.unwrap()
}

#[tokio::test]
async fn npx_runs_its_argv_through_exec() {
    let registry = ToolRegistry::with_defaults();

    // A package run fetches from the network, so exec's classifier asks before it runs.
    let asked = registry.execute("npx", json!({"package": "--version", "yes": false})).await;
    let err = asked.as_ref().unwrap_err().to_string();
    assert!(err.contains("approval required") && err.contains("approval_request_id: req_"), "{err}");

    // Model self-approval (approve: true) is rejected.
    let self_err = registry
        .execute("npx", json!({"package": "--version", "yes": false, "approve": true}))
        .await
        .unwrap_err()
        .to_string();
    assert!(self_err.contains("Model self-approval is not sufficient"), "{self_err}");

    // Host/operator approves out-of-band via the registry hook.
    let req_id = err.split("approval_request_id: ").nth(1).unwrap().trim();
    let tok = registry.approve_exec_request(req_id).await.expect("valid request");
    let r = registry
        .execute("npx", json!({"package": "--version", "yes": false, "approval_token": tok.token}))
        .await
        .unwrap();
    assert_eq!(r.content["status"], "success", "{:?}", r.content);
    assert!(r.content["stdout"].as_str().unwrap().trim().chars().next().unwrap().is_ascii_digit());

    // Canonical surface absorbs npx/uvx into exec and jq into code.
    let asked_exec = registry
        .execute("exec", json!({"action": "npx", "package": "--version", "yes": false}))
        .await
        .unwrap_err()
        .to_string();
    let req_id2 = asked_exec.split("approval_request_id: ").nth(1).unwrap().trim();
    let tok2 = registry.approve_exec_request(req_id2).await.expect("valid request");
    let via_exec = registry
        .execute("exec", json!({"action": "npx", "package": "--version", "yes": false, "approval_token": tok2.token}))
        .await
        .unwrap();
    assert_eq!(via_exec.content["status"], "success");

    let defs = ToolRegistry::with_defaults().get_definitions();
    for t in ["npx", "uvx", "jq"] {
        assert!(defs.iter().all(|d| d["name"] != t), "{t} must be hidden from tools/list");
    }
    let exec_def = defs.iter().find(|d| d["name"] == "exec").unwrap();
    let exec_actions = exec_def["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
    assert!(exec_actions.contains(&json!("npx")) && exec_actions.contains(&json!("uvx")));

    let code_def = defs.iter().find(|d| d["name"] == "code").unwrap();
    let code_actions = code_def["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
    assert!(code_actions.contains(&json!("jq")));
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
