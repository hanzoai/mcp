/// Unified search module for Rust MCP
/// Provides text, AST, symbol, vector, and memory search capabilities

pub mod unified_search;
pub mod ast_search;
pub mod symbol_search;
pub mod vector_store;
pub mod search;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Search result structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub file_path: PathBuf,
    pub line_number: usize,
    pub column: usize,
    pub match_text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    pub match_type: MatchType,
    pub score: f32,
    pub node_type: Option<String>,
    pub semantic_context: Option<String>,
}

/// Match type enum
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchType {
    Text,
    Ast,
    Symbol,
    Vector,
    Memory,
    File,
}

/// Search modality enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchModality {
    Text,
    Ast,
    Symbol,
    Vector,
    Memory,
    File,
}

/// Search configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub query: String,
    pub path: Option<PathBuf>,
    pub modalities: Vec<SearchModality>,
    pub max_results: usize,
    pub context_lines: usize,
    pub file_pattern: Option<String>,
    pub language: Option<String>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            query: String::new(),
            path: Some(PathBuf::from(".")),
            modalities: vec![],
            max_results: 20,
            context_lines: 3,
            file_pattern: None,
            language: None,
        }
    }
}

/// Detect search modalities based on query
pub fn detect_modalities(query: &str) -> Vec<SearchModality> {
    let mut modalities = Vec::new();
    
    // Natural language query - use vector search
    if query.split_whitespace().count() > 3 && !has_code_pattern(query) {
        modalities.push(SearchModality::Vector);
    }
    
    // Code patterns - use AST search
    if has_code_pattern(query) {
        modalities.push(SearchModality::Ast);
    }
    
    // Single identifier - use symbol search
    if is_identifier(query) {
        modalities.push(SearchModality::Symbol);
    }
    
    // Always include text search as fallback
    modalities.push(SearchModality::Text);
    
    // File pattern
    if query.contains('/') || query.contains('.') {
        modalities.push(SearchModality::File);
    }
    
    modalities.dedup();
    modalities
}

/// Check if query contains code patterns
fn has_code_pattern(query: &str) -> bool {
    let patterns = [
        "class ", "function ", "def ", "interface ", "struct ",
        "enum ", "type ", "const ", "let ", "var ", "import ",
        "from ", "fn ", "impl ", "trait ", "pub ",
    ];
    
    patterns.iter().any(|pattern| query.contains(pattern))
}

/// Check if query is a single identifier
fn is_identifier(query: &str) -> bool {
    query.chars().all(|c| c.is_alphanumeric() || c == '_') &&
    query.chars().next().map_or(false, |c| c.is_alphabetic() || c == '_')
}

/// Rank and deduplicate search results
pub fn rank_and_deduplicate(mut results: Vec<SearchResult>, max_results: usize) -> Vec<SearchResult> {
    // Remove duplicates by file path and line number
    results.sort_by(|a, b| {
        a.file_path.cmp(&b.file_path)
            .then_with(|| a.line_number.cmp(&b.line_number))
    });
    results.dedup_by(|a, b| {
        a.file_path == b.file_path && a.line_number == b.line_number
    });
    
    // Sort by score and match type priority
    let priority = |m: &MatchType| match m {
        MatchType::Symbol => 1,
        MatchType::Ast => 2,
        MatchType::Vector => 3,
        MatchType::Text => 4,
        MatchType::Memory => 5,
        MatchType::File => 6,
    };
    
    results.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap()
            .then_with(|| priority(&a.match_type).cmp(&priority(&b.match_type)))
    });
    
    results.truncate(max_results);
    results
}