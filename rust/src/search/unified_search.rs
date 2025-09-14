/// Unified search implementation combining multiple search strategies

use super::{SearchConfig, SearchModality, SearchResult, MatchType, detect_modalities, rank_and_deduplicate};
use crate::search::{ast_search, symbol_search, vector_store};
use async_trait::async_trait;
use rayon::prelude::*;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::task;

/// Unified search executor
pub struct UnifiedSearch {
    config: SearchConfig,
}

impl UnifiedSearch {
    /// Create new unified search instance
    pub fn new(config: SearchConfig) -> Self {
        Self { config }
    }

    /// Execute unified search across all modalities
    pub async fn execute(&self) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        // Auto-detect modalities if not specified
        let modalities = if self.config.modalities.is_empty() {
            detect_modalities(&self.config.query)
        } else {
            self.config.modalities.clone()
        };

        // Execute searches in parallel
        let mut search_tasks = Vec::new();
        
        for modality in modalities {
            let config = self.config.clone();
            let task = task::spawn(async move {
                match modality {
                    SearchModality::Text => execute_text_search(config).await,
                    SearchModality::Ast => execute_ast_search(config).await,
                    SearchModality::Symbol => execute_symbol_search(config).await,
                    SearchModality::Vector => execute_vector_search(config).await,
                    SearchModality::Memory => execute_memory_search(config).await,
                    SearchModality::File => execute_file_search(config).await,
                }
            });
            search_tasks.push(task);
        }

        // Collect all results
        let mut all_results = Vec::new();
        for task in search_tasks {
            if let Ok(Ok(results)) = task.await {
                all_results.extend(results);
            }
        }

        // Rank and deduplicate
        Ok(rank_and_deduplicate(all_results, self.config.max_results))
    }
}

/// Execute text search using ripgrep
async fn execute_text_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    let path = config.path.unwrap_or_else(|| PathBuf::from("."));
    
    let mut cmd = Command::new("rg");
    cmd.arg("--json")
        .arg("--max-count").arg(config.max_results.to_string())
        .arg("-C").arg(config.context_lines.to_string())
        .arg(&config.query)
        .arg(path);

    if let Some(pattern) = &config.file_pattern {
        cmd.arg("--glob").arg(pattern);
    }

    let output = cmd.output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    let mut results = Vec::new();
    for line in stdout.lines() {
        if let Ok(json) = serde_json::from_str::<Value>(line) {
            if json["type"] == "match" {
                let data = &json["data"];
                results.push(SearchResult {
                    file_path: PathBuf::from(data["path"]["text"].as_str().unwrap_or("")),
                    line_number: data["line_number"].as_u64().unwrap_or(0) as usize,
                    column: data["submatches"][0]["start"].as_u64().unwrap_or(0) as usize,
                    match_text: data["lines"]["text"].as_str().unwrap_or("").to_string(),
                    context_before: vec![],
                    context_after: vec![],
                    match_type: MatchType::Text,
                    score: 1.0,
                    node_type: None,
                    semantic_context: None,
                });
            }
        }
    }
    
    Ok(results)
}

/// Execute AST search using tree-sitter
async fn execute_ast_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    // Use the ast_search module
    let searcher = ast_search::AstSearcher::new();
    let path = config.path.unwrap_or_else(|| PathBuf::from("."));
    
    searcher.search(
        &config.query,
        &path,
        config.language.as_deref(),
        config.max_results,
    ).await
}

/// Execute symbol search
async fn execute_symbol_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    // Use the symbol_search module
    let searcher = symbol_search::SymbolSearcher::new();
    let path = config.path.unwrap_or_else(|| PathBuf::from("."));
    
    searcher.search(
        &config.query,
        &path,
        config.max_results,
    ).await
}

/// Execute vector search using embeddings
async fn execute_vector_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    // Use the vector_store module
    let store = vector_store::VectorStore::new(None).await?;
    let results = store.search(&config.query, "documents", config.max_results, 0.7).await?;
    
    Ok(results.into_iter().map(|doc| SearchResult {
        file_path: PathBuf::from(doc.metadata.get("file_path").and_then(|v| v.as_str()).unwrap_or("")),
        line_number: doc.metadata.get("line_number").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        column: 0,
        match_text: doc.content.clone(),
        context_before: vec![],
        context_after: vec![],
        match_type: MatchType::Vector,
        score: doc.score,
        node_type: None,
        semantic_context: Some(doc.content),
    }).collect())
}

/// Execute memory search
async fn execute_memory_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    // Search in conversation history and knowledge base
    let store = vector_store::VectorStore::new(None).await?;
    let results = store.search(&config.query, "memories", config.max_results, 0.7).await?;
    
    Ok(results.into_iter().map(|mem| SearchResult {
        file_path: PathBuf::from("memory"),
        line_number: 0,
        column: 0,
        match_text: mem.content.clone(),
        context_before: vec![],
        context_after: vec![],
        match_type: MatchType::Memory,
        score: mem.score,
        node_type: None,
        semantic_context: Some(mem.content),
    }).collect())
}

/// Execute file search using glob patterns
async fn execute_file_search(config: SearchConfig) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    let path = config.path.unwrap_or_else(|| PathBuf::from("."));
    let pattern = format!("**/*{}*", config.query);
    
    let entries = glob::glob_with(
        &pattern,
        glob::MatchOptions {
            case_sensitive: false,
            ..Default::default()
        }
    )?;
    
    let mut results = Vec::new();
    for entry in entries.flatten().take(config.max_results) {
        results.push(SearchResult {
            file_path: entry.clone(),
            line_number: 0,
            column: 0,
            match_text: entry.file_name().unwrap_or_default().to_string_lossy().to_string(),
            context_before: vec![],
            context_after: vec![],
            match_type: MatchType::File,
            score: 0.8,
            node_type: None,
            semantic_context: None,
        });
    }
    
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_unified_search() {
        let config = SearchConfig {
            query: "test function".to_string(),
            path: Some(PathBuf::from(".")),
            modalities: vec![],
            max_results: 10,
            context_lines: 3,
            file_pattern: Some("*.rs".to_string()),
            language: Some("rust".to_string()),
        };

        let search = UnifiedSearch::new(config);
        let results = search.execute().await;
        
        assert!(results.is_ok());
    }

    #[test]
    fn test_detect_modalities() {
        // Natural language query
        let modalities = detect_modalities("find all error handling code");
        assert!(modalities.contains(&SearchModality::Vector));
        assert!(modalities.contains(&SearchModality::Text));

        // Code pattern
        let modalities = detect_modalities("function handleError");
        assert!(modalities.contains(&SearchModality::Ast));
        assert!(modalities.contains(&SearchModality::Text));

        // Single identifier
        let modalities = detect_modalities("handleError");
        assert!(modalities.contains(&SearchModality::Symbol));
        assert!(modalities.contains(&SearchModality::Text));

        // File pattern
        let modalities = detect_modalities("src/main.rs");
        assert!(modalities.contains(&SearchModality::File));
        assert!(modalities.contains(&SearchModality::Text));
    }
}