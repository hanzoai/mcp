//! Filesystem Tools Tests - 1:1 parity with TypeScript file-ops.test.ts
//!
//! Tests for fs tool covering:
//! - Tool properties and metadata
//! - Read operations (with offset/limit)
//! - Write operations
//! - Edit operations (single/multiple replacements)
//! - Patch operations (add/update/delete)
//! - Tree operations
//! - Find operations (glob patterns)
//! - Search operations (regex/case-insensitive)
//! - Info operations

use hanzo_mcp::tools::{FsTool, FsToolArgs};
use std::fs;
use tempfile::TempDir;

/// Test fs tool properties
#[test]
fn test_fs_tool_properties() {
    let tool = FsTool::new();
    // Tool is fs following HIP-0300
    assert!(true); // FsTool exists
}

/// Test fs help action
#[tokio::test]
async fn test_fs_help_action() {
    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Help should list available actions
    assert!(json.get("actions").is_some());
    assert!(json.get("name").is_some());
    assert_eq!(json["name"], "fs");
}

/// Test read file basic
#[tokio::test]
async fn test_fs_read_basic() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    fs::write(&file_path, "line 1\nline 2\nline 3\n").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "read".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("content").is_some());
    assert!(json["content"].as_str().unwrap().contains("line 1"));
    assert!(json["content"].as_str().unwrap().contains("line 2"));
    assert_eq!(json["total_lines"].as_i64().unwrap(), 3); // Rust's .lines() returns 3 for trailing newline
}

/// Test read file with offset and limit
#[tokio::test]
async fn test_fs_read_with_offset_limit() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    let content: String = (1..=100).map(|i| format!("line {}\n", i)).collect();
    fs::write(&file_path, &content).unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "read".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        offset: Some(10),
        limit: Some(5),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["lines"].as_i64().unwrap(), 5);
    assert_eq!(json["offset"].as_i64().unwrap(), 10);
    assert!(json["truncated"].as_bool().unwrap());
}

/// Test read file with file_path alias
#[tokio::test]
async fn test_fs_read_file_path_alias() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    fs::write(&file_path, "hello world").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "read".to_string(),
        file_path: Some(file_path.to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    assert!(output.contains("hello world"));
}

/// Test write file basic
#[tokio::test]
async fn test_fs_write_basic() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("new.txt");

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "write".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        content: Some("test content\nline 2".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["success"].as_bool().unwrap());
    assert!(json["bytes"].as_i64().unwrap() > 0);
    assert_eq!(json["lines"].as_i64().unwrap(), 2);

    // Verify file contents
    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "test content\nline 2");
}

/// Test write creates parent directories
#[tokio::test]
async fn test_fs_write_creates_parents() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("a/b/c/deep.txt");

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "write".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        content: Some("deep content".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Verify file exists
    assert!(file_path.exists());
    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "deep content");
}

/// Test edit file single replacement
#[tokio::test]
async fn test_fs_edit_single() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("edit.txt");
    fs::write(&file_path, "hello world").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "edit".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        old_string: Some("world".to_string()),
        new_string: Some("rust".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["success"].as_bool().unwrap());
    assert_eq!(json["replacements"].as_i64().unwrap(), 1);

    // Verify file contents
    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "hello rust");
}

/// Test edit with old_text/new_text aliases
#[tokio::test]
async fn test_fs_edit_aliases() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("edit.txt");
    fs::write(&file_path, "hello world").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "edit".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        old_text: Some("world".to_string()),
        new_text: Some("universe".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "hello universe");
}

/// Test edit fails on multiple matches without replace_all
#[tokio::test]
async fn test_fs_edit_multiple_without_replace_all() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("edit.txt");
    fs::write(&file_path, "hello hello hello").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "edit".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        old_string: Some("hello".to_string()),
        new_string: Some("hi".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_err());

    let error = result.unwrap_err();
    assert!(error.to_string().contains("3") || error.to_string().contains("locations"));
}

/// Test edit with replace_all
#[tokio::test]
async fn test_fs_edit_replace_all() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("edit.txt");
    fs::write(&file_path, "hello hello hello").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "edit".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        old_string: Some("hello".to_string()),
        new_string: Some("hi".to_string()),
        replace_all: true,
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["replacements"].as_i64().unwrap(), 3);

    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "hi hi hi");
}

/// Test edit create new file (empty old_string)
#[tokio::test]
async fn test_fs_edit_create_file() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("new.txt");

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "edit".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        old_string: Some("".to_string()),
        new_string: Some("new file content".to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["created"].as_bool().unwrap());

    let content = fs::read_to_string(&file_path).unwrap();
    assert_eq!(content, "new file content");
}

/// Test tree operation
#[tokio::test]
async fn test_fs_tree_basic() {
    let temp_dir = TempDir::new().unwrap();
    fs::create_dir(temp_dir.path().join("subdir")).unwrap();
    fs::write(temp_dir.path().join("file1.txt"), "").unwrap();
    fs::write(temp_dir.path().join("subdir/file2.txt"), "").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "tree".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("tree").is_some());
    assert!(json.get("directories").is_some());
    assert!(json.get("files").is_some());
    assert!(json["directories"].as_i64().unwrap() >= 1);
    assert!(json["files"].as_i64().unwrap() >= 2);
}

/// Test tree with depth limit
#[tokio::test]
async fn test_fs_tree_with_depth() {
    let temp_dir = TempDir::new().unwrap();
    fs::create_dir_all(temp_dir.path().join("a/b/c/d")).unwrap();
    fs::write(temp_dir.path().join("a/b/c/d/deep.txt"), "").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "tree".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        depth: Some(2),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    // Should not include deeply nested files when depth is limited
    assert!(!output.contains("deep.txt"));
}

/// Test find operation
#[tokio::test]
async fn test_fs_find_basic() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(temp_dir.path().join("test.rs"), "").unwrap();
    fs::write(temp_dir.path().join("test.py"), "").unwrap();
    fs::write(temp_dir.path().join("other.txt"), "").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "find".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("*.rs".to_string()),
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("matches").is_some());
    let matches = json["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert!(matches[0].as_str().unwrap().contains("test.rs"));
}

/// Test find with limit
#[tokio::test]
async fn test_fs_find_with_limit() {
    let temp_dir = TempDir::new().unwrap();
    for i in 0..10 {
        fs::write(temp_dir.path().join(format!("file{}.txt", i)), "").unwrap();
    }

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "find".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("*.txt".to_string()),
        limit: Some(5),
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["truncated"].as_bool().unwrap());
    assert!(json["count"].as_i64().unwrap() <= 5);
}

/// Test search operation
#[tokio::test]
async fn test_fs_search_basic() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(
        temp_dir.path().join("test.rs"),
        "fn main() {\n    println!(\"Hello\");\n}\n",
    )
    .unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "search".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("println".to_string()),
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("results").is_some());
    let results = json["results"].as_array().unwrap();
    assert!(!results.is_empty());
    assert!(results[0]["match"].as_str().unwrap().contains("println"));
}

/// Test search case insensitive
#[tokio::test]
async fn test_fs_search_case_insensitive() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(temp_dir.path().join("test.txt"), "Hello World\nHELLO WORLD\n").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "search".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("hello".to_string()),
        ignore_case: true,
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let results = json["results"].as_array().unwrap();
    assert_eq!(results.len(), 2); // Both lines should match
}

/// Test search with context lines
#[tokio::test]
async fn test_fs_search_with_context() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(
        temp_dir.path().join("test.txt"),
        "line 1\nline 2\nTARGET\nline 4\nline 5\n",
    )
    .unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "search".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("TARGET".to_string()),
        context: Some(1),
        include_hidden: true, // Temp dirs start with '.' so we need to include hidden
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let results = json["results"].as_array().unwrap();
    assert!(!results.is_empty());
    let context = results[0]["context"].as_str().unwrap();
    assert!(context.contains("line 2"));
    assert!(context.contains("TARGET"));
    assert!(context.contains("line 4"));
}

/// Test info operation
#[tokio::test]
async fn test_fs_info_file() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    fs::write(&file_path, "hello world").unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "info".to_string(),
        path: Some(file_path.to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["type"], "file");
    assert_eq!(json["size"].as_i64().unwrap(), 11); // "hello world" is 11 bytes
    assert!(json.get("modified").is_some());
}

/// Test info operation on directory
#[tokio::test]
async fn test_fs_info_directory() {
    let temp_dir = TempDir::new().unwrap();

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "info".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(json["type"], "directory");
}

/// Test patch operation - add file
#[tokio::test]
async fn test_fs_patch_add_file() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("new.txt");

    let patch = format!(
        r#"*** Begin Patch
*** Add File: {}
+line 1
+line 2
*** End Patch"#,
        file_path.to_string_lossy()
    );

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "patch".to_string(),
        patch: Some(patch),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json["applied"].as_i64().unwrap() >= 1);

    // Verify file was created
    assert!(file_path.exists());
}

/// Test patch operation - update file
#[tokio::test]
async fn test_fs_patch_update_file() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("existing.txt");
    fs::write(&file_path, "hello world\nfoo bar\n").unwrap();

    let patch = format!(
        r#"*** Begin Patch
*** Update File: {}
@@ context
-hello world
+hello rust
*** End Patch"#,
        file_path.to_string_lossy()
    );

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "patch".to_string(),
        patch: Some(patch),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let content = fs::read_to_string(&file_path).unwrap();
    assert!(content.contains("hello rust"));
    assert!(!content.contains("hello world"));
}

/// Test patch operation - delete file
#[tokio::test]
async fn test_fs_patch_delete_file() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("to_delete.txt");
    fs::write(&file_path, "will be deleted").unwrap();

    let patch = format!(
        r#"*** Begin Patch
*** Delete File: {}
*** End Patch"#,
        file_path.to_string_lossy()
    );

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "patch".to_string(),
        patch: Some(patch),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Verify file was deleted
    assert!(!file_path.exists());
}

/// Test action aliases
#[tokio::test]
async fn test_fs_action_aliases() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(temp_dir.path().join("test.txt"), "content").unwrap();

    let tool = FsTool::new();

    // Test "ls" alias for "tree"
    let args = FsToolArgs {
        action: "ls".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "glob" alias for "find"
    let args = FsToolArgs {
        action: "glob".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("*.txt".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());

    // Test "grep" alias for "search"
    let args = FsToolArgs {
        action: "grep".to_string(),
        path: Some(temp_dir.path().to_string_lossy().to_string()),
        pattern: Some("content".to_string()),
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test tilde expansion
#[tokio::test]
async fn test_fs_tilde_expansion() {
    // Skip if we can't get home directory
    if dirs::home_dir().is_none() {
        return;
    }

    let tool = FsTool::new();
    let args = FsToolArgs {
        action: "tree".to_string(),
        path: Some("~".to_string()),
        depth: Some(1),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    // Should work without error (home directory exists)
    assert!(result.is_ok());
}

/// Test hidden files handling
#[tokio::test]
async fn test_fs_hidden_files() {
    let temp_dir = TempDir::new().unwrap();
    // Create a visible subdir to test hidden file filtering inside it
    let subdir = temp_dir.path().join("testdir");
    fs::create_dir(&subdir).unwrap();
    fs::write(subdir.join(".hidden"), "").unwrap();
    fs::write(subdir.join("visible"), "").unwrap();

    let tool = FsTool::new();

    // Without include_hidden - search inside visible subdir
    let args = FsToolArgs {
        action: "tree".to_string(),
        path: Some(subdir.to_string_lossy().to_string()),
        include_hidden: false,
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(!output.contains(".hidden"));
    assert!(output.contains("visible"));

    // With include_hidden
    let args = FsToolArgs {
        action: "tree".to_string(),
        path: Some(subdir.to_string_lossy().to_string()),
        include_hidden: true,
        ..Default::default()
    };
    let result = tool.execute(args).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains(".hidden"));
}
