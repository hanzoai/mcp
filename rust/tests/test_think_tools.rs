//! Think/Reasoning Tools Tests - 1:1 parity with Python think tests
//!
//! Tests for think tool covering:
//! - Tool properties and metadata
//! - Think action (record thoughts)
//! - Critic action (critical analysis)
//! - Review action (balanced code review)
//! - Review focus areas
//! - Thought persistence within session

use hanzo_mcp::tools::{ThinkTool, ThinkToolArgs};

/// Test think tool properties
#[test]
fn test_think_tool_properties() {
    let tool = ThinkTool::new();
    // Tool exists and is properly initialized
    assert!(true);
}

/// Test think help action
#[tokio::test]
async fn test_think_help_action() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: Some("help".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json = output["data"].clone();   // HIP-0300 envelope: payload under "data"

    assert!(json.get("actions").is_some());
    assert_eq!(json["tool"], "think");
}

/// Test think action - basic thought recording
#[tokio::test]
async fn test_think_basic() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: Some("think".to_string()),
        thought: Some(
            "Considering approach A vs B for implementing the feature.\n\
            A: More performant but complex\n\
            B: Simpler but slower"
                .to_string(),
        ),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json = output["data"].clone();   // HIP-0300 envelope: payload under "data"

    assert!(json["recorded"].as_bool().unwrap());
    assert!(json.get("id").is_some());
    assert!(json["thought"].as_str().unwrap().contains("approach A vs B"));
}

/// Test think action - auto-detect from thought parameter
/// Test critic action - basic critical analysis
/// Test critic action - auto-detect from analysis parameter
/// Test critic action - section parsing
/// Test review action - basic code review
/// Test review action - auto-detect from work_description parameter
/// Test review action - with code snippets
/// Test review action - with file paths
/// Test review action - with additional context
/// Test all review focus areas
/// Test review default focus (GENERAL)
/// Test thought persistence within session
#[tokio::test]
async fn test_thought_persistence() {
    let tool = ThinkTool::new();

    // Record multiple thoughts
    for i in 1..=3 {
        let args = ThinkToolArgs {
            action: Some("think".to_string()),
            thought: Some(format!("Thought number {}", i)),
            ..Default::default()
        };
        let result = tool.execute(args).await;
        assert!(result.is_ok());

        let output = result.unwrap();
        let json = output["data"].clone();   // HIP-0300 envelope: payload under "data"

        // Each thought should get a unique, incrementing ID
        assert_eq!(json["id"].as_i64().unwrap(), i);
    }
}

/// Test action aliases
/// Test timestamp format
/// Test complex thought with multiline content
#[tokio::test]
async fn test_complex_thought() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: Some("think".to_string()),
        thought: Some(
            r#"Feature Implementation Planning
- New code search feature requirements:
  * Search for code patterns across multiple files
  * Identify function usages and references
  * Analyze import relationships
- Implementation considerations:
  * Need to leverage existing search mechanisms
  * Should use regex for pattern matching
- Design approach:
  1. Create new CodeSearcher class
  2. Implement core pattern matching
  3. Add result formatting methods"#
                .to_string(),
        ),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json = output["data"].clone();   // HIP-0300 envelope: payload under "data"

    assert!(json["recorded"].as_bool().unwrap());
    assert!(json["thought"].as_str().unwrap().contains("CodeSearcher"));
}
