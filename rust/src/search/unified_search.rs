/// Unified search implementation combining multiple search strategies

use super::{SearchConfig, SearchModality, SearchResult, MatchType, detect_modalities, rank_and_deduplicate};
use crate::search::{ast_search, symbol_search};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use anyhow::Result;

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
    pub async fn execute(&self) -> Result<Vec<SearchResult>> {
        // Auto-detect modalities if not specified
        let modalities = if self.config.modalities.is_empty() {
            detect_modalities(&self.config.query)
        } else {
            self.config.modalities.clone()
        };

        // Execute searches sequentially (avoids Send bound issues)
        let mut all_results = Vec::new();

        for modality in modalities {
            let results = match modality {
                SearchModality::Text => self.execute_text_search().await?,
                SearchModality::Ast => self.execute_ast_search().await?,
                SearchModality::Symbol => self.execute_symbol_search().await?,
                SearchModality::Vector => self.execute_vector_search().await?,
                SearchModality::Memory => self.execute_memory_search().await?,
                SearchModality::File => self.execute_file_search().await?,
            };
            all_results.extend(results);
        }

        // Rank and deduplicate
        Ok(rank_and_deduplicate(all_results, self.config.max_results))
    }

    /// Execute text search using ripgrep
    async fn execute_text_search(&self) -> Result<Vec<SearchResult>> {
        let path = self.config.path.clone().unwrap_or_else(|| PathBuf::from("."));

        let mut cmd = Command::new("rg");
        cmd.arg("--json")
            .arg("--max-count").arg(self.config.max_results.to_string())
            .arg("-C").arg(self.config.context_lines.to_string())
            .arg(&self.config.query)
            .arg(&path);

        if let Some(pattern) = &self.config.file_pattern {
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
    async fn execute_ast_search(&self) -> Result<Vec<SearchResult>> {
        let searcher = ast_search::AstSearcher::new();
        let path = self.config.path.clone().unwrap_or_else(|| PathBuf::from("."));

        let results = searcher.search(
            &self.config.query,
            &path,
            self.config.language.as_deref(),
            self.config.max_results,
        ).await.unwrap_or_default();

        Ok(results)
    }

    /// Execute symbol search
    async fn execute_symbol_search(&self) -> Result<Vec<SearchResult>> {
        let searcher = symbol_search::SymbolSearcher::new();
        let path = self.config.path.clone().unwrap_or_else(|| PathBuf::from("."));

        let results = searcher.search(
            &self.config.query,
            &path,
            self.config.max_results,
        ).await.unwrap_or_default();

        Ok(results)
    }

    /// Execute vector search using embeddings (stub - disabled)
    async fn execute_vector_search(&self) -> Result<Vec<SearchResult>> {
        // Vector search disabled - would use embeddings
        Ok(vec![])
    }

    /// Execute memory search (stub - disabled)
    async fn execute_memory_search(&self) -> Result<Vec<SearchResult>> {
        // Memory search disabled - would use embeddings
        Ok(vec![])
    }

    /// Execute file search using glob patterns
    async fn execute_file_search(&self) -> Result<Vec<SearchResult>> {
        let pattern = format!("**/*{}*", self.config.query);

        let entries = glob::glob_with(
            &pattern,
            glob::MatchOptions {
                case_sensitive: false,
                ..Default::default()
            }
        )?;

        let mut results = Vec::new();
        for entry in entries.flatten().take(self.config.max_results) {
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
