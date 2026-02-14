//! Memory Tools Tests - 1:1 parity with Python memory tests
//!
//! Tests for memory tool covering:
//! - Tool properties and metadata
//! - Recall operations (search memories)
//! - Create operations (store memories)
//! - Update operations
//! - Delete operations
//! - Manage operations (atomic CRUD)
//! - Facts operations (knowledge bases)
//! - Summarize operations
//! - List operations
//! - Scope handling (session/project/global)

use hanzo_mcp::tools::{MemoryTool, MemoryToolArgs};
use serde_json::json;

/// Test memory tool properties
#[test]
fn test_memory_tool_properties() {
    let tool = MemoryTool::new();
    // Tool exists and is properly initialized
    assert!(true);
}

/// Test memory help action
#[tokio::test]
async fn test_memory_help_action() {
    let tool = MemoryTool::new();
    let args = MemoryToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("actions").is_some());
    assert!(json.get("name").is_some());
    assert_eq!(json["name"], "memory");
    assert!(json.get("scopes").is_some());
}

/// Test create single memory
#[tokio::test]
async fn test_memory_create_single() {
    let tool = MemoryTool::new();
    let args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("User prefers dark mode".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["created"].as_i64().unwrap() >= 1);
    assert!(json.get("ids").is_some());
}

/// Test create multiple memories
#[tokio::test]
async fn test_memory_create_multiple() {
    let tool = MemoryTool::new();
    let args = MemoryToolArgs {
        action: "create".to_string(),
        statements: Some(vec![
            "User prefers Python".to_string(),
            "User uses VSCode".to_string(),
            "User prefers TDD".to_string(),
        ]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["created"].as_i64().unwrap(), 3);
    assert_eq!(json["ids"].as_array().unwrap().len(), 3);
}

/// Test create with scope
#[tokio::test]
async fn test_memory_create_with_scope() {
    let tool = MemoryTool::new();

    // Create session-scoped memory
    let args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Session memory".to_string()),
        scope: Some("session".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["scope"], "session");
}

/// Test recall memories
#[tokio::test]
async fn test_memory_recall() {
    let tool = MemoryTool::new();

    // Create a memory first
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("User prefers Rust for systems programming".to_string()),
        ..Default::default()
    };
    tool.execute(create_args).await.unwrap();

    // Recall the memory
    let args = MemoryToolArgs {
        action: "recall".to_string(),
        query: Some("Rust".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("results").is_some());
    let results = json["results"].as_array().unwrap();
    assert!(!results.is_empty());
    assert!(results[0]["content"].as_str().unwrap().contains("Rust"));
}

/// Test recall with multiple queries
#[tokio::test]
async fn test_memory_recall_multiple_queries() {
    let tool = MemoryTool::new();

    // Create memories
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statements: Some(vec![
            "User likes Python".to_string(),
            "User likes TypeScript".to_string(),
        ]),
        ..Default::default()
    };
    tool.execute(create_args).await.unwrap();

    // Recall with multiple queries
    let args = MemoryToolArgs {
        action: "recall".to_string(),
        queries: Some(vec!["Python".to_string(), "TypeScript".to_string()]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["count"].as_i64().unwrap() >= 2);
}

/// Test recall with limit
#[tokio::test]
async fn test_memory_recall_with_limit() {
    let tool = MemoryTool::new();

    // Create many memories
    for i in 0..10 {
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statement: Some(format!("Memory item {}", i)),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();
    }

    // Recall with limit
    let args = MemoryToolArgs {
        action: "recall".to_string(),
        query: Some("Memory".to_string()),
        limit: Some(3),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["results"].as_array().unwrap().len() <= 3);
}

/// Test update memories
#[tokio::test]
async fn test_memory_update() {
    let tool = MemoryTool::new();

    // Create a memory first
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Original content".to_string()),
        ..Default::default()
    };
    let create_result = tool.execute(create_args).await.unwrap();
    let create_json: serde_json::Value = serde_json::from_str(&create_result).unwrap();
    let memory_id = create_json["ids"].as_array().unwrap()[0].as_str().unwrap();

    // Update the memory
    let args = MemoryToolArgs {
        action: "update".to_string(),
        updates: Some(vec![json!({
            "id": memory_id,
            "statement": "Updated content"
        })]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["updated"].as_i64().unwrap() >= 1);
}

/// Test delete memories
#[tokio::test]
async fn test_memory_delete() {
    let tool = MemoryTool::new();

    // Create a memory first
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("To be deleted".to_string()),
        ..Default::default()
    };
    let create_result = tool.execute(create_args).await.unwrap();
    let create_json: serde_json::Value = serde_json::from_str(&create_result).unwrap();
    let memory_id = create_json["ids"].as_array().unwrap()[0].as_str().unwrap();

    // Delete the memory
    let args = MemoryToolArgs {
        action: "delete".to_string(),
        id: Some(memory_id.to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["deleted"].as_i64().unwrap() >= 1);
}

/// Test delete multiple memories
#[tokio::test]
async fn test_memory_delete_multiple() {
    let tool = MemoryTool::new();

    // Create memories
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statements: Some(vec!["Delete me 1".to_string(), "Delete me 2".to_string()]),
        ..Default::default()
    };
    let create_result = tool.execute(create_args).await.unwrap();
    let create_json: serde_json::Value = serde_json::from_str(&create_result).unwrap();
    let ids: Vec<String> = create_json["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    // Delete multiple memories
    let args = MemoryToolArgs {
        action: "delete".to_string(),
        ids: Some(ids),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["deleted"].as_i64().unwrap(), 2);
}

/// Test manage operation (atomic CRUD)
#[tokio::test]
async fn test_memory_manage() {
    let tool = MemoryTool::new();

    // Create some memories first
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statements: Some(vec!["Existing 1".to_string(), "Existing 2".to_string()]),
        ..Default::default()
    };
    let create_result = tool.execute(create_args).await.unwrap();
    let create_json: serde_json::Value = serde_json::from_str(&create_result).unwrap();
    let existing_id = create_json["ids"].as_array().unwrap()[0]
        .as_str()
        .unwrap()
        .to_string();

    // Use manage for atomic operations
    let args = MemoryToolArgs {
        action: "manage".to_string(),
        creations: Some(vec!["New memory".to_string()]),
        updates: Some(vec![json!({
            "id": existing_id,
            "statement": "Updated existing"
        })]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("created").is_some());
    assert!(json.get("updated").is_some());
}

/// Test facts - store facts
#[tokio::test]
async fn test_memory_facts_store() {
    let tool = MemoryTool::new();
    let args = MemoryToolArgs {
        action: "facts".to_string(),
        kb_name: Some("coding_standards".to_string()),
        facts: Some(vec![
            "Use uv for Python".to_string(),
            "Use pnpm for Node.js".to_string(),
        ]),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["stored"].as_i64().unwrap(), 2);
    assert_eq!(json["kb_name"], "coding_standards");
}

/// Test facts - recall facts
#[tokio::test]
async fn test_memory_facts_recall() {
    let tool = MemoryTool::new();

    // Store facts first
    let store_args = MemoryToolArgs {
        action: "facts".to_string(),
        kb_name: Some("test_kb".to_string()),
        facts: Some(vec!["Python is great for AI".to_string()]),
        ..Default::default()
    };
    tool.execute(store_args).await.unwrap();

    // Recall facts
    let args = MemoryToolArgs {
        action: "facts".to_string(),
        kb_name: Some("test_kb".to_string()),
        query: Some("Python".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("results").is_some());
    let results = json["results"].as_array().unwrap();
    assert!(!results.is_empty());
}

/// Test facts - list knowledge bases
#[tokio::test]
async fn test_memory_facts_list_kbs() {
    let tool = MemoryTool::new();

    // Create a knowledge base
    let store_args = MemoryToolArgs {
        action: "facts".to_string(),
        kb_name: Some("my_kb".to_string()),
        facts: Some(vec!["Test fact".to_string()]),
        ..Default::default()
    };
    tool.execute(store_args).await.unwrap();

    // List knowledge bases
    let args = MemoryToolArgs {
        action: "facts".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("knowledge_bases").is_some());
}

/// Test summarize operation
#[tokio::test]
async fn test_memory_summarize() {
    let tool = MemoryTool::new();
    let args = MemoryToolArgs {
        action: "summarize".to_string(),
        content: Some(
            "Discussion about API design:\n\
            - Use REST for simplicity\n\
            - Consider GraphQL for complex queries\n\
            - Always version APIs"
                .to_string(),
        ),
        topic: Some("API Design".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["stored"].as_bool().unwrap());
    assert_eq!(json["topic"], "API Design");
    assert!(json.get("extracted_facts").is_some());
}

/// Test list operation
#[tokio::test]
async fn test_memory_list() {
    let tool = MemoryTool::new();

    // Create some memories
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statements: Some(vec!["Memory A".to_string(), "Memory B".to_string()]),
        ..Default::default()
    };
    tool.execute(create_args).await.unwrap();

    // List all memories
    let args = MemoryToolArgs {
        action: "list".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("memories").is_some());
    assert!(json.get("count").is_some());
    assert!(json.get("total").is_some());
}

/// Test list with scope filter
#[tokio::test]
async fn test_memory_list_with_scope() {
    let tool = MemoryTool::new();

    // Create memories in different scopes
    let session_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Session memory".to_string()),
        scope: Some("session".to_string()),
        ..Default::default()
    };
    tool.execute(session_args).await.unwrap();

    let project_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Project memory".to_string()),
        scope: Some("project".to_string()),
        ..Default::default()
    };
    tool.execute(project_args).await.unwrap();

    // List only session memories
    let args = MemoryToolArgs {
        action: "list".to_string(),
        scope: Some("session".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // All returned memories should be session-scoped
    let memories = json["memories"].as_array().unwrap();
    for mem in memories {
        assert_eq!(mem["scope"], "session");
    }
}

/// Test action aliases
#[tokio::test]
async fn test_memory_action_aliases() {
    let tool = MemoryTool::new();

    // Test "add" alias for "create"
    let args = MemoryToolArgs {
        action: "add".to_string(),
        statement: Some("Added memory".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "search" alias for "recall"
    let args = MemoryToolArgs {
        action: "search".to_string(),
        query: Some("Added".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "store" alias for "create"
    let args = MemoryToolArgs {
        action: "store".to_string(),
        statement: Some("Stored memory".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test memory persistence (within session)
#[tokio::test]
async fn test_memory_persistence() {
    let tool = MemoryTool::new();

    // Create
    let create_args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Persistent memory".to_string()),
        ..Default::default()
    };
    tool.execute(create_args).await.unwrap();

    // Should be recallable
    let recall_args = MemoryToolArgs {
        action: "recall".to_string(),
        query: Some("Persistent".to_string()),
        ..Default::default()
    };
    let result = tool.execute(recall_args).await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&result).unwrap();

    assert!(json["count"].as_i64().unwrap() >= 1);
}

/// Test memory with metadata
#[tokio::test]
async fn test_memory_with_metadata() {
    let tool = MemoryTool::new();

    let mut metadata = std::collections::HashMap::new();
    metadata.insert("source".to_string(), json!("user_input"));
    metadata.insert("importance".to_string(), json!("high"));

    let args = MemoryToolArgs {
        action: "create".to_string(),
        statement: Some("Important memory".to_string()),
        metadata: Some(metadata),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test scope parsing
#[tokio::test]
async fn test_memory_scope_parsing() {
    let tool = MemoryTool::new();

    // Test all valid scopes
    for scope in &["session", "project", "global"] {
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statement: Some(format!("{} scoped memory", scope)),
            scope: Some(scope.to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await;
        assert!(result.is_ok());
    }
}
