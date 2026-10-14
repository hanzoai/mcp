//! The tool surface a client sees: the same order every start, and as small as asked.

use hanzo_mcp::ToolRegistry;
use serde_json::Value;

fn names(registry: &ToolRegistry) -> Vec<String> {
    registry
        .get_definitions()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_list_has_one_order_however_many_times_it_is_built() {
    let first = names(&ToolRegistry::with_defaults());
    for _ in 0..20 {
        assert_eq!(first, names(&ToolRegistry::with_defaults()));
    }
    // The built-ins keep their fixed order; the registered tools follow, by name.
    let custom = &first[16..];
    let mut sorted = custom.to_vec();
    sorted.sort();
    assert_eq!(custom, sorted.as_slice());
    assert_eq!(&first[..4], ["exec", "fs", "plan", "think"]);
}

#[test]
fn restricting_lists_and_serves_only_what_was_named() {
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs", "code", "exec"]).unwrap();
    assert_eq!(names(&registry), ["exec", "fs", "code"]);
    assert_eq!(registry.list(), ["code", "exec", "fs"]);
}

#[tokio::test]
async fn a_tool_outside_the_list_is_unknown_not_hidden() {
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs"]).unwrap();
    let denied = registry.execute("exec", serde_json::json!({"action": "help"})).await.unwrap();
    assert!(!denied.success);
    assert_eq!(denied.error.as_deref(), Some("Unknown tool: exec"));
    assert!(registry.execute("fs", serde_json::json!({"action": "help"})).await.unwrap().success);
    // A registered tool is held to the list too.
    let denied = registry.execute("code_search", serde_json::json!({"query": "x"})).await.unwrap();
    assert_eq!(denied.error.as_deref(), Some("Unknown tool: code_search"));
}

#[test]
fn an_unknown_or_empty_list_is_an_error() {
    let mut registry = ToolRegistry::with_defaults();
    let err = registry.restrict(["fs", "serach"]).unwrap_err().to_string();
    assert!(err.starts_with("unknown tool \"serach\""), "{err}");
    assert!(ToolRegistry::with_defaults().restrict(["", " "]).is_err());
    assert!(ToolRegistry::with_defaults().restrict(Vec::<String>::new()).is_err());
    // A failed restrict leaves the registry whole.
    assert!(registry.list().len() > 20);
}

/// What a client is charged each turn: the schemas of the tools it is shown. The search,
/// exec and code tools together stay under 4K tokens (16 KB at four bytes a token).
#[test]
fn the_native_tools_fit_in_four_thousand_tokens() {
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs", "code", "exec", "kai_decide"]).unwrap();
    let bytes: usize = registry.get_definitions().iter().map(|d| serde_json::to_string::<Value>(d).unwrap().len()).sum();
    assert!(bytes < 16_000, "{bytes} bytes");

    // With Kai Actions beside them.
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs", "code", "exec", "kai"]).unwrap();
    let bytes: usize = registry.get_definitions().iter().map(|d| serde_json::to_string::<Value>(d).unwrap().len()).sum();
    assert!(bytes < 16_000, "{bytes} bytes with kai");
}
