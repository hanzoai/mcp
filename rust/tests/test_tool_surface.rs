//! The tool surface a client sees: the canonical 19-tool HIP-0300 surface in one
//! deterministic order every start, and as small as asked with `--tools`.

use hanzo_mcp::{ToolRegistry, CANONICAL_TOOLS, LEGACY_ALIASES};
use serde_json::Value;

fn names(registry: &ToolRegistry) -> Vec<String> {
    registry
        .get_definitions()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_list_has_one_canonical_order_however_many_times_it_is_built() {
    let first = names(&ToolRegistry::with_defaults());
    for _ in 0..20 {
        assert_eq!(first, names(&ToolRegistry::with_defaults()));
    }
    let expected: Vec<String> = CANONICAL_TOOLS.iter().map(|s| (*s).to_string()).collect();
    assert_eq!(first, expected);
    assert_eq!(first.len(), 19);
    for legacy in LEGACY_ALIASES {
        assert!(!first.contains(&legacy.to_string()), "legacy tool {legacy} leaked into tools/list");
    }
}

#[test]
fn restricting_lists_and_serves_only_what_was_named() {
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs", "code", "exec"]).unwrap();
    assert_eq!(names(&registry), ["fs", "exec", "code"]);
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
    // A legacy alias is held to the restricted list too.
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
    assert_eq!(registry.list().len(), 19);
}

#[test]
fn the_native_tools_fit_in_four_thousand_tokens() {
    let mut registry = ToolRegistry::with_defaults();
    registry.restrict(["fs", "code", "exec", "kai"]).unwrap();
    let bytes: usize = registry
        .get_definitions()
        .iter()
        .map(|d| serde_json::to_string::<Value>(d).unwrap().len())
        .sum();
    assert!(bytes < 16_000, "{bytes} bytes with kai");
}
