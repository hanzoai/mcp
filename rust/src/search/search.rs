/// Search implementation following OpenAI specification
/// Provides unified search and fetch capabilities for ChatGPT connectors

use super::{SearchResult as InternalResult, MatchType, SearchModality};
use super::unified_search::UnifiedSearcher;
use super::ast_search::ASTSearcher;
use super::symbol_search::SymbolSearcher;
use super::vector_store::VectorStore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::fs;
use anyhow::Result;
use glob::glob;
use std::process::Command;

/// Search result structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub url: String,
}

/// Document structure for fetch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub text: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Search response
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Search tool implementation
pub struct Search {
    unified_searcher: UnifiedSearcher,
    ast_searcher: ASTSearcher,
    symbol_searcher: SymbolSearcher,
    vector_store: Option<VectorStore>,
}

impl Search {
    /// Create new search instance
    pub async fn new() -> Result<Self> {
        let vector_store = VectorStore::new("./hanzo_vectors").await.ok();
        
        Ok(Self {
            unified_searcher: UnifiedSearcher::new(),
            ast_searcher: ASTSearcher::new(),
            symbol_searcher: SymbolSearcher::new(),
            vector_store,
        })
    }

    /// Execute search
    pub async fn search(&self, query: &str) -> Result<SearchResponse> {
        // Detect search modalities based on query
        let modalities = detect_search_modalities(query);
        
        // Execute searches in parallel
        let mut all_results = Vec::new();
        
        for modality in modalities {
            let results = match modality {
                SearchModality::Text => self.execute_text_search(query).await?,
                SearchModality::Ast => self.execute_ast_search(query).await?,
                SearchModality::Symbol => self.execute_symbol_search(query).await?,
                SearchModality::Vector => self.execute_vector_search(query).await?,
                SearchModality::File => self.execute_file_search(query).await?,
                _ => vec![],
            };
            all_results.extend(results);
        }
        
        // Rank and deduplicate
        let ranked_results = rank_and_deduplicate(all_results, 20);
        
        // Convert to standard format
        let mcp_results: Vec<SearchResult> = ranked_results
            .into_iter()
            .map(|r| SearchResult {
                id: generate_document_id(&r),
                title: generate_title(&r),
                url: generate_url(&r),
            })
            .collect();
        
        Ok(SearchResponse {
            results: mcp_results,
            error: None,
        })
    }

    /// Execute fetch
    pub async fn fetch(&self, id: &str) -> Result<Document> {
        let doc_info = parse_document_id(id);
        
        match doc_info.doc_type.as_str() {
            "file" => {
                // Read file content
                let content = fs::read_to_string(&doc_info.path)?;
                let title = doc_info.path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Unknown")
                    .to_string();
                
                let mut text = content.clone();
                let mut metadata = serde_json::json!({
                    "type": "file",
                    "language": detect_language(&doc_info.path),
                    "lines": content.lines().count()
                });
                
                // If specific line requested, extract relevant section
                if let Some(line_num) = doc_info.line_number {
                    let lines: Vec<&str> = content.lines().collect();
                    let start = line_num.saturating_sub(50);
                    let end = std::cmp::min(line_num + 50, lines.len());
                    text = lines[start..end].join("\n");
                    metadata["excerpt"] = serde_json::json!(true);
                    metadata["startLine"] = serde_json::json!(start + 1);
                    metadata["endLine"] = serde_json::json!(end);
                }
                
                Ok(Document {
                    id: id.to_string(),
                    title,
                    text,
                    url: format!("file://{}", doc_info.path.display()),
                    metadata: Some(metadata),
                })
            }
            "vector" => {
                // Fetch from vector store
                if let Some(store) = &self.vector_store {
                    let results = store.search_documents(&doc_info.id, 1, 0.0).await?;
                    if let Some(doc) = results.first() {
                        return Ok(Document {
                            id: id.to_string(),
                            title: doc.metadata.get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Vector Document")
                                .to_string(),
                            text: doc.content.clone(),
                            url: doc.metadata.get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&format!("vector://{}", id))
                                .to_string(),
                            metadata: Some(serde_json::to_value(&doc.metadata)?),
                        });
                    }
                }
                Err(anyhow::anyhow!("Vector document not found"))
            }
            "memory" => {
                // Fetch from memory/knowledge base
                if let Some(store) = &self.vector_store {
                    // Implement memory fetch if needed
                    Err(anyhow::anyhow!("Memory fetch not yet implemented"))
                } else {
                    Err(anyhow::anyhow!("Vector store not available"))
                }
            }
            _ => Err(anyhow::anyhow!("Unknown document type")),
        }
    }

    /// Execute text search using ripgrep
    async fn execute_text_search(&self, query: &str) -> Result<Vec<InternalResult>> {
        let output = Command::new("rg")
            .args(&[
                "--json",
                "--max-count", "20",
                "-C", "3",
                query,
                ".",
            ])
            .output()?;
        
        let mut results = Vec::new();
        
        for line in std::str::from_utf8(&output.stdout)?.lines() {
            if line.is_empty() { continue; }
            
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                if json["type"] == "match" {
                    let data = &json["data"];
                    results.push(InternalResult {
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

    /// Execute AST search
    async fn execute_ast_search(&self, query: &str) -> Result<Vec<InternalResult>> {
        self.ast_searcher.search(query, Path::new("."), 20).await
    }

    /// Execute symbol search
    async fn execute_symbol_search(&self, query: &str) -> Result<Vec<InternalResult>> {
        self.symbol_searcher.search(query, Path::new("."), 20).await
    }

    /// Execute vector search
    async fn execute_vector_search(&self, query: &str) -> Result<Vec<InternalResult>> {
        if let Some(store) = &self.vector_store {
            let docs = store.search_documents(query, 10, 0.7).await?;
            Ok(docs.into_iter().enumerate().map(|(idx, doc)| {
                InternalResult {
                    file_path: PathBuf::from(doc.metadata.get("file_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")),
                    line_number: doc.metadata.get("line_number")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    column: 0,
                    match_text: doc.content[..200.min(doc.content.len())].to_string(),
                    context_before: vec![],
                    context_after: vec![],
                    match_type: MatchType::Vector,
                    score: doc.score,
                    node_type: None,
                    semantic_context: Some(doc.content),
                }
            }).collect())
        } else {
            Ok(vec![])
        }
    }

    /// Execute file search
    async fn execute_file_search(&self, query: &str) -> Result<Vec<InternalResult>> {
        let pattern = format!("**/*{}*", query);
        let mut results = Vec::new();
        
        for entry in glob(&pattern)?.filter_map(Result::ok).take(10) {
            results.push(InternalResult {
                file_path: entry.clone(),
                line_number: 0,
                column: 0,
                match_text: entry.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
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

/// Detect appropriate search modalities based on query
fn detect_search_modalities(query: &str) -> Vec<SearchModality> {
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
    if is_single_identifier(query) {
        modalities.push(SearchModality::Symbol);
    }
    
    // Always include text search
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
        "class ", "function ", "def ", "interface ",
        "struct ", "enum ", "type ", "const ",
        "let ", "var ", "import ", "from ",
        "fn ", "impl ", "trait ", "pub ",
    ];
    
    patterns.iter().any(|p| query.contains(p))
}

/// Check if query is a single identifier
fn is_single_identifier(query: &str) -> bool {
    query.chars().all(|c| c.is_alphanumeric() || c == '_') &&
    query.chars().next().map_or(false, |c| c.is_alphabetic() || c == '_')
}

/// Rank and deduplicate results
fn rank_and_deduplicate(mut results: Vec<InternalResult>, max_results: usize) -> Vec<InternalResult> {
    // Remove duplicates
    let mut seen = std::collections::HashSet::new();
    results.retain(|r| {
        let key = format!("{}:{}", r.file_path.display(), r.line_number);
        seen.insert(key)
    });
    
    // Sort by score and type priority
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

/// Generate document ID from search result
fn generate_document_id(result: &InternalResult) -> String {
    match result.match_type {
        MatchType::Vector | MatchType::Memory => {
            format!("{}:{}", result.match_type, result.file_path.display())
        }
        _ => {
            let mut id = result.file_path.display().to_string();
            if result.line_number > 0 {
                id.push_str(&format!(":{}", result.line_number));
            }
            if let Some(ref node_type) = result.node_type {
                id.push_str(&format!(":{}", node_type));
            }
            id
        }
    }
}

/// Generate title from search result
fn generate_title(result: &InternalResult) -> String {
    let file_name = result.file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown");
    
    if result.line_number > 0 {
        format!("{}:{}", file_name, result.line_number)
    } else {
        file_name.to_string()
    }
}

/// Generate URL from search result
fn generate_url(result: &InternalResult) -> String {
    let absolute_path = result.file_path
        .canonicalize()
        .unwrap_or_else(|_| result.file_path.clone());
    format!("file://{}", absolute_path.display())
}

/// Document info parsed from ID
struct DocumentInfo {
    doc_type: String,
    path: PathBuf,
    id: String,
    line_number: Option<usize>,
    node_type: Option<String>,
}

/// Parse document ID to get location info
fn parse_document_id(id: &str) -> DocumentInfo {
    if id.starts_with("vector:") {
        DocumentInfo {
            doc_type: "vector".to_string(),
            id: id[7..].to_string(),
            path: PathBuf::new(),
            line_number: None,
            node_type: None,
        }
    } else if id.starts_with("memory:") {
        DocumentInfo {
            doc_type: "memory".to_string(),
            id: id[7..].to_string(),
            path: PathBuf::new(),
            line_number: None,
            node_type: None,
        }
    } else {
        // Parse file-based IDs
        let parts: Vec<&str> = id.split(':').collect();
        let mut info = DocumentInfo {
            doc_type: "file".to_string(),
            path: PathBuf::from(parts[0]),
            id: id.to_string(),
            line_number: None,
            node_type: None,
        };
        
        if parts.len() > 1 {
            if let Ok(line_num) = parts[1].parse::<usize>() {
                info.line_number = Some(line_num);
            }
        }
        
        if parts.len() > 2 {
            info.node_type = Some(parts[2].to_string());
        }
        
        info
    }
}

/// Detect language from file extension
fn detect_language(path: &Path) -> String {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => "rust",
        Some("ts") | Some("tsx") => "typescript",
        Some("js") | Some("jsx") => "javascript",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("cpp") | Some("cc") => "cpp",
        Some("c") => "c",
        _ => "text",
    }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_search() {
        let searcher = Search::new().await.unwrap();
        let response = searcher.search("test").await.unwrap();
        
        assert!(response.error.is_none());
        assert!(!response.results.is_empty());
        
        for result in response.results {
            assert!(!result.id.is_empty());
            assert!(!result.title.is_empty());
            assert!(!result.url.is_empty());
        }
    }

    #[tokio::test]
    async fn test_fetch() {
        let searcher = Search::new().await.unwrap();
        
        // Create a test file
        let test_file = "test_file.txt";
        fs::write(test_file, "Test content\nLine 2\nLine 3").unwrap();
        
        let doc = searcher.fetch(test_file).await.unwrap();
        
        assert_eq!(doc.id, test_file);
        assert!(doc.text.contains("Test content"));
        assert!(doc.url.starts_with("file://"));
        assert!(doc.metadata.is_some());
        
        // Clean up
        fs::remove_file(test_file).ok();
    }
}