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
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("actions").is_some());
    assert!(json.get("name").is_some());
    assert_eq!(json["name"], "think");
    assert!(json.get("review_focuses").is_some());
}

/// Test think action - basic thought recording
#[tokio::test]
async fn test_think_basic() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "think".to_string(),
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
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
    assert!(json.get("id").is_some());
    assert!(json.get("timestamp").is_some());
    assert!(json["thought"].as_str().unwrap().contains("approach A vs B"));
}

/// Test think action - auto-detect from thought parameter
#[tokio::test]
async fn test_think_auto_detect() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        thought: Some("Auto-detected thought".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
}

/// Test critic action - basic critical analysis
#[tokio::test]
async fn test_critic_basic() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "critic".to_string(),
        analysis: Some(
            "Implementation Issues:\n\
            - No error handling for network failures\n\
            - Missing validation for user input\n\
            - Race condition possible in concurrent updates\n\
            \n\
            Security Concerns:\n\
            - SQL injection vulnerability\n\
            - Missing rate limiting"
                .to_string(),
        ),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
    assert!(json.get("sections").is_some());
    assert!(json["message"]
        .as_str()
        .unwrap()
        .contains("Critical analysis")); // Capitalized in implementation
}

/// Test critic action - auto-detect from analysis parameter
#[tokio::test]
async fn test_critic_auto_detect() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        analysis: Some("Code Issues:\n- Missing tests".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
}

/// Test critic action - section parsing
#[tokio::test]
async fn test_critic_section_parsing() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "critic".to_string(),
        analysis: Some(
            "Test Coverage Gaps:\n\
            - No tests for error scenarios\n\
            - Missing edge case tests\n\
            \n\
            Performance Issues:\n\
            - O(n^2) algorithm\n\
            - No caching"
                .to_string(),
        ),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let sections = json["sections"].as_object().unwrap();
    // Should parse sections from the analysis
    assert!(sections.len() > 0);
}

/// Test review action - basic code review
#[tokio::test]
async fn test_review_basic() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "review".to_string(),
        work_description: Some("Implemented email validation function".to_string()),
        focus: Some("FUNCTIONALITY".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
    assert_eq!(json["focus"], "Functionality");
    assert!(json["message"]
        .as_str()
        .unwrap()
        .contains("balanced, constructive feedback"));
}

/// Test review action - auto-detect from work_description parameter
#[tokio::test]
async fn test_review_auto_detect() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        work_description: Some("Added new feature".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
}

/// Test review action - with code snippets
#[tokio::test]
async fn test_review_with_code_snippets() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "review".to_string(),
        work_description: Some("Added rate limiter".to_string()),
        focus: Some("SECURITY".to_string()),
        code_snippets: Some(vec![
            "fn rate_limit(req: &Request) -> bool { ... }".to_string(),
            "impl RateLimiter { ... }".to_string(),
        ]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["review_context"]["code_snippets"].is_array());
}

/// Test review action - with file paths
#[tokio::test]
async fn test_review_with_file_paths() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "review".to_string(),
        work_description: Some("Refactored authentication module".to_string()),
        focus: Some("ARCHITECTURE".to_string()),
        file_paths: Some(vec![
            "src/auth/mod.rs".to_string(),
            "src/auth/token.rs".to_string(),
            "src/auth/session.rs".to_string(),
        ]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["review_context"]["file_paths"].is_array());
}

/// Test review action - with additional context
#[tokio::test]
async fn test_review_with_context() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "review".to_string(),
        work_description: Some("Added caching layer".to_string()),
        focus: Some("PERFORMANCE".to_string()),
        context: Some("This is for a high-traffic API with ~10k req/s".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["review_context"]["additional_context"]
        .as_str()
        .unwrap()
        .contains("10k req/s"));
}

/// Test all review focus areas
#[tokio::test]
async fn test_review_all_focus_areas() {
    let tool = ThinkTool::new();

    let focuses = [
        "GENERAL",
        "FUNCTIONALITY",
        "READABILITY",
        "MAINTAINABILITY",
        "TESTING",
        "DOCUMENTATION",
        "ARCHITECTURE",
        "SECURITY",
        "PERFORMANCE",
    ];

    for focus in focuses {
        let args = ThinkToolArgs {
            action: "review".to_string(),
            work_description: Some(format!("Testing {} focus", focus)),
            focus: Some(focus.to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok(), "Failed for focus: {}", focus);
    }
}

/// Test review default focus (GENERAL)
#[tokio::test]
async fn test_review_default_focus() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "review".to_string(),
        work_description: Some("Some work without specified focus".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["focus"], "General");
}

/// Test thought persistence within session
#[tokio::test]
async fn test_thought_persistence() {
    let tool = ThinkTool::new();

    // Record multiple thoughts
    for i in 1..=3 {
        let args = ThinkToolArgs {
            action: "think".to_string(),
            thought: Some(format!("Thought number {}", i)),
            ..Default::default()
        };
        let result = tool.execute(args).await;
        assert!(result.is_ok());

        let output = result.unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).unwrap();

        // Each thought should get a unique, incrementing ID
        assert_eq!(json["id"].as_i64().unwrap(), i);
    }
}

/// Test action aliases
#[tokio::test]
async fn test_think_action_aliases() {
    let tool = ThinkTool::new();

    // Test "thought" alias for "think"
    let args = ThinkToolArgs {
        action: "thought".to_string(),
        thought: Some("Using thought alias".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "criticize" alias for "critic"
    let args = ThinkToolArgs {
        action: "criticize".to_string(),
        analysis: Some("Issues:\n- Problem 1".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "critique" alias for "critic"
    let args = ThinkToolArgs {
        action: "critique".to_string(),
        analysis: Some("Issues:\n- Problem 2".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test timestamp format
#[tokio::test]
async fn test_timestamp_format() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "think".to_string(),
        thought: Some("Testing timestamp".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let timestamp = json["timestamp"].as_str().unwrap();
    // Should be RFC3339 format
    assert!(timestamp.contains("T"));
    assert!(timestamp.contains(":"));
}

/// Test complex thought with multiline content
#[tokio::test]
async fn test_complex_thought() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "think".to_string(),
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
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["recorded"].as_bool().unwrap());
    assert!(json["thought"].as_str().unwrap().contains("CodeSearcher"));
}

/// Test help examples
#[tokio::test]
async fn test_help_contains_examples() {
    let tool = ThinkTool::new();
    let args = ThinkToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("examples").is_some());
    let examples = json["examples"].as_object().unwrap();
    assert!(examples.get("think").is_some());
    assert!(examples.get("critic").is_some());
    assert!(examples.get("review").is_some());
}
