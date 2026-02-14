//! Search Tools Tests - 1:1 parity with Python/TypeScript search tests
//!
//! Tests for search module covering:
//! - Text search (ripgrep-based)
//! - AST search (tree-sitter)
//! - Symbol search (ctags + regex)
//! - File search (glob patterns)
//! - Unified search (multi-modal)
//! - Search result ranking and deduplication

use hanzo_mcp::search::{
    SearchConfig, SearchModality, SearchResult, MatchType,
    detect_modalities, rank_and_deduplicate,
};
use hanzo_mcp::search::ast_search::AstSearcher;
use hanzo_mcp::search::search::Search;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

/// Test modality detection for natural language queries
#[test]
fn test_detect_modalities_natural_language() {
    // Multi-word queries without code patterns should trigger vector search
    let modalities = detect_modalities("how to implement authentication");
    assert!(modalities.contains(&SearchModality::Vector));
    assert!(modalities.contains(&SearchModality::Text)); // Always includes text
}

/// Test modality detection for code patterns
#[test]
fn test_detect_modalities_code_patterns() {
    // Code patterns should trigger AST search
    let modalities = detect_modalities("class UserService");
    assert!(modalities.contains(&SearchModality::Ast));

    let modalities = detect_modalities("function handleClick");
    assert!(modalities.contains(&SearchModality::Ast));

    let modalities = detect_modalities("def process_data");
    assert!(modalities.contains(&SearchModality::Ast));

    let modalities = detect_modalities("fn main");
    assert!(modalities.contains(&SearchModality::Ast));
}

/// Test modality detection for single identifiers
#[test]
fn test_detect_modalities_identifiers() {
    // Single identifiers should trigger symbol search
    let modalities = detect_modalities("UserService");
    assert!(modalities.contains(&SearchModality::Symbol));

    let modalities = detect_modalities("process_data");
    assert!(modalities.contains(&SearchModality::Symbol));
}

/// Test modality detection for file patterns
#[test]
fn test_detect_modalities_file_patterns() {
    // Paths should trigger file search
    let modalities = detect_modalities("src/lib.rs");
    assert!(modalities.contains(&SearchModality::File));

    let modalities = detect_modalities("config.json");
    assert!(modalities.contains(&SearchModality::File));
}

/// Test modality detection always includes text
#[test]
fn test_detect_modalities_always_text() {
    // Text search should always be included
    let modalities = detect_modalities("anything");
    assert!(modalities.contains(&SearchModality::Text));

    let modalities = detect_modalities("class Foo");
    assert!(modalities.contains(&SearchModality::Text));
}

/// Test search result structure
#[test]
fn test_search_result_structure() {
    let result = SearchResult {
        file_path: PathBuf::from("src/main.rs"),
        line_number: 10,
        column: 5,
        match_text: "fn main()".to_string(),
        context_before: vec!["// Comment".to_string()],
        context_after: vec!["    println!".to_string()],
        match_type: MatchType::Text,
        score: 0.95,
        node_type: None,
        semantic_context: None,
    };

    assert_eq!(result.file_path, PathBuf::from("src/main.rs"));
    assert_eq!(result.line_number, 10);
    assert_eq!(result.match_text, "fn main()");
    assert_eq!(result.score, 0.95);
}

/// Test AST search result structure
#[test]
fn test_ast_search_result_structure() {
    let result = SearchResult {
        file_path: PathBuf::from("src/lib.rs"),
        line_number: 20,
        column: 0,
        match_text: "pub fn process()".to_string(),
        context_before: vec![],
        context_after: vec![],
        match_type: MatchType::Ast,
        score: 0.95,
        node_type: Some("function_item".to_string()),
        semantic_context: Some("function_item at 20:0".to_string()),
    };

    assert!(result.node_type.is_some());
    assert_eq!(result.node_type.unwrap(), "function_item");
    assert!(result.semantic_context.is_some());
}

/// Test result ranking and deduplication
#[test]
fn test_rank_and_deduplicate() {
    let results = vec![
        SearchResult {
            file_path: PathBuf::from("a.rs"),
            line_number: 10,
            column: 0,
            match_text: "match".to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Text,
            score: 0.8,
            node_type: None,
            semantic_context: None,
        },
        // Duplicate of first
        SearchResult {
            file_path: PathBuf::from("a.rs"),
            line_number: 10,
            column: 0,
            match_text: "match".to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Symbol,
            score: 0.9,
            node_type: None,
            semantic_context: None,
        },
        SearchResult {
            file_path: PathBuf::from("b.rs"),
            line_number: 20,
            column: 0,
            match_text: "other".to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Ast,
            score: 0.95,
            node_type: None,
            semantic_context: None,
        },
    ];

    let ranked = rank_and_deduplicate(results, 10);

    // Should deduplicate by file:line
    assert_eq!(ranked.len(), 2);

    // Should be sorted by score (highest first)
    assert!(ranked[0].score >= ranked[1].score);
}

/// Test result limiting
#[test]
fn test_rank_and_deduplicate_limit() {
    let results: Vec<SearchResult> = (0..20)
        .map(|i| SearchResult {
            file_path: PathBuf::from(format!("{}.rs", i)),
            line_number: i,
            column: 0,
            match_text: format!("match {}", i),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Text,
            score: 1.0 - (i as f32 * 0.01),
            node_type: None,
            semantic_context: None,
        })
        .collect();

    let ranked = rank_and_deduplicate(results, 5);
    assert_eq!(ranked.len(), 5);
}

/// Test match type priority in ranking
#[test]
fn test_match_type_priority() {
    let results = vec![
        SearchResult {
            file_path: PathBuf::from("text.rs"),
            line_number: 1,
            column: 0,
            match_text: "text".to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Text,
            score: 0.9,
            node_type: None,
            semantic_context: None,
        },
        SearchResult {
            file_path: PathBuf::from("symbol.rs"),
            line_number: 2,
            column: 0,
            match_text: "symbol".to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::Symbol,
            score: 0.9,
            node_type: None,
            semantic_context: None,
        },
    ];

    let ranked = rank_and_deduplicate(results, 10);

    // Symbol should come before text with same score
    assert!(matches!(ranked[0].match_type, MatchType::Symbol));
}

/// Test MatchType Display trait
#[test]
fn test_match_type_display() {
    assert_eq!(format!("{}", MatchType::Text), "text");
    assert_eq!(format!("{}", MatchType::Ast), "ast");
    assert_eq!(format!("{}", MatchType::Symbol), "symbol");
    assert_eq!(format!("{}", MatchType::Vector), "vector");
    assert_eq!(format!("{}", MatchType::Memory), "memory");
    assert_eq!(format!("{}", MatchType::File), "file");
}

/// Test SearchConfig defaults
#[test]
fn test_search_config_defaults() {
    let config = SearchConfig::default();

    assert!(config.query.is_empty());
    assert_eq!(config.max_results, 20);
    assert_eq!(config.context_lines, 3);
    assert!(config.modalities.is_empty());
}

/// Test AST searcher creation
#[test]
fn test_ast_searcher_new() {
    let _searcher = AstSearcher::new();
    // Should create successfully
    assert!(true);
}

/// Test AST searcher with Rust code
#[tokio::test]
async fn test_ast_search_rust() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.rs");
    fs::write(
        &file_path,
        r#"
fn hello() {
    println!("Hello");
}

fn world() {
    println!("World");
}
"#,
    )
    .unwrap();

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("hello", temp_dir.path(), Some("rust"), 10)
        .await;

    assert!(results.is_ok());
}

/// Test AST searcher with Python code
#[tokio::test]
async fn test_ast_search_python() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.py");
    fs::write(
        &file_path,
        r#"
def hello():
    print("Hello")

def world():
    print("World")
"#,
    )
    .unwrap();

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("hello", temp_dir.path(), Some("python"), 10)
        .await;

    assert!(results.is_ok());
}

/// Test AST searcher with JavaScript code
#[tokio::test]
async fn test_ast_search_javascript() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.js");
    fs::write(
        &file_path,
        r#"
function hello() {
    console.log("Hello");
}

function world() {
    console.log("World");
}
"#,
    )
    .unwrap();

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("hello", temp_dir.path(), Some("javascript"), 10)
        .await;

    assert!(results.is_ok());
}

/// Test AST searcher with TypeScript code
#[tokio::test]
async fn test_ast_search_typescript() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.ts");
    fs::write(
        &file_path,
        r#"
function hello(): void {
    console.log("Hello");
}

interface User {
    name: string;
}
"#,
    )
    .unwrap();

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("User", temp_dir.path(), Some("typescript"), 10)
        .await;

    assert!(results.is_ok());
}

/// Test AST searcher with Go code
#[tokio::test]
async fn test_ast_search_go() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.go");
    fs::write(
        &file_path,
        r#"
package main

func hello() {
    fmt.Println("Hello")
}

func main() {
    hello()
}
"#,
    )
    .unwrap();

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("hello", temp_dir.path(), Some("go"), 10)
        .await;

    assert!(results.is_ok());
}

/// Test AST searcher auto language detection
#[tokio::test]
async fn test_ast_search_auto_detect() {
    let temp_dir = TempDir::new().unwrap();

    // Create files with different extensions
    fs::write(temp_dir.path().join("main.rs"), "fn main() {}").unwrap();
    fs::write(temp_dir.path().join("main.py"), "def main(): pass").unwrap();
    fs::write(temp_dir.path().join("main.js"), "function main() {}").unwrap();

    let searcher = AstSearcher::new();
    // Without specifying language, should auto-detect
    let results: Result<Vec<SearchResult>, _> = searcher.search("main", temp_dir.path(), None, 10).await;

    assert!(results.is_ok());
}

/// Test AST searcher max results
#[tokio::test]
async fn test_ast_search_max_results() {
    let temp_dir = TempDir::new().unwrap();

    // Create many files
    for i in 0..20 {
        let file_path = temp_dir.path().join(format!("test{}.rs", i));
        fs::write(&file_path, format!("fn test_{}() {{}}", i)).unwrap();
    }

    let searcher = AstSearcher::new();
    let results: Result<Vec<SearchResult>, _> = searcher
        .search("test", temp_dir.path(), Some("rust"), 5)
        .await;

    assert!(results.is_ok());
    assert!(results.unwrap().len() <= 5);
}

/// Test unified Search creation
#[tokio::test]
async fn test_unified_search_new() {
    let search = Search::new().await;
    assert!(search.is_ok());
}

/// Test unified search basic query
#[tokio::test]
async fn test_unified_search_query() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(temp_dir.path().join("test.rs"), "fn main() {}").unwrap();

    // Change to temp dir for search
    let original_dir = std::env::current_dir().unwrap();
    std::env::set_current_dir(temp_dir.path()).unwrap();

    let search = Search::new().await.unwrap();
    let response = search.search("main").await;

    // Restore original directory
    std::env::set_current_dir(original_dir).unwrap();

    assert!(response.is_ok());
}

/// Test search fetch operation
#[tokio::test]
async fn test_search_fetch() {
    let temp_dir = TempDir::new().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    fs::write(&file_path, "Line 1\nLine 2\nLine 3\n").unwrap();

    let search = Search::new().await.unwrap();
    let doc = search
        .fetch(&file_path.to_string_lossy())
        .await;

    assert!(doc.is_ok());
    let doc = doc.unwrap();
    assert!(doc.text.contains("Line 1"));
}

/// Test search modality enum serialization
#[test]
fn test_search_modality_serialization() {
    let modalities = vec![
        SearchModality::Text,
        SearchModality::Ast,
        SearchModality::Symbol,
        SearchModality::Vector,
        SearchModality::Memory,
        SearchModality::File,
    ];

    for modality in modalities {
        let json = serde_json::to_string(&modality).unwrap();
        let deserialized: SearchModality = serde_json::from_str(&json).unwrap();
        assert_eq!(modality, deserialized);
    }
}

/// Test match type serialization
#[test]
fn test_match_type_serialization() {
    let types = vec![
        MatchType::Text,
        MatchType::Ast,
        MatchType::Symbol,
        MatchType::Vector,
        MatchType::Memory,
        MatchType::File,
    ];

    for match_type in types {
        let json = serde_json::to_string(&match_type).unwrap();
        // Should serialize as lowercase
        assert!(json.chars().all(|c| c.is_lowercase() || c == '"'));
    }
}

/// Test empty query handling
#[test]
fn test_detect_modalities_empty() {
    let modalities = detect_modalities("");
    // Should at least include text search
    assert!(modalities.contains(&SearchModality::Text));
}

/// Test code pattern keywords
#[test]
fn test_code_pattern_keywords() {
    let patterns = [
        "class MyClass",
        "function myFunc",
        "def my_func",
        "interface MyInterface",
        "struct MyStruct",
        "enum MyEnum",
        "type MyType",
        "const MY_CONST",
        "let myVar",
        "var myVar",
        "import module",
        "from module",
        "fn my_fn",
        "impl MyTrait",
        "trait MyTrait",
        "pub fn public",
    ];

    for pattern in patterns {
        let modalities = detect_modalities(pattern);
        assert!(
            modalities.contains(&SearchModality::Ast),
            "Pattern '{}' should trigger AST search",
            pattern
        );
    }
}

/// Test identifier detection
#[test]
fn test_identifier_detection() {
    // Valid identifiers
    let valid = ["foo", "FooBar", "foo_bar", "_private", "camelCase"];
    for id in valid {
        let modalities = detect_modalities(id);
        assert!(
            modalities.contains(&SearchModality::Symbol),
            "'{}' should be detected as identifier",
            id
        );
    }

    // Not identifiers (contain non-identifier chars)
    let _invalid = ["foo bar", "foo-bar", "123foo", "foo.bar"];
    // These might still work as text search but shouldn't be pure identifiers
    // Note: Some like "foo.bar" trigger file search
}
