/// Symbol search implementation for finding code definitions

use super::{SearchResult, MatchType};
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;
use regex::Regex;
use std::fs;

/// Symbol types
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolType {
    Function,
    Class,
    Variable,
    Method,
    Interface,
    Type,
    Struct,
    Enum,
    Trait,
    Any,
}

/// Symbol searcher
pub struct SymbolSearcher {
    patterns: std::collections::HashMap<String, Vec<Regex>>,
}

impl SymbolSearcher {
    /// Create new symbol searcher
    pub fn new() -> Self {
        let mut searcher = Self {
            patterns: std::collections::HashMap::new(),
        };
        
        // Initialize language-specific patterns
        searcher.init_patterns();
        searcher
    }

    /// Initialize regex patterns for different languages
    fn init_patterns(&mut self) {
        // Rust patterns
        self.patterns.insert("rust".to_string(), vec![
            Regex::new(r"^\s*(?:pub\s+)?fn\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?struct\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?enum\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?trait\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?type\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?const\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:pub\s+)?static\s+(\w+)").unwrap(),
            Regex::new(r"^\s*impl(?:<[^>]+>)?\s+(?:\w+\s+for\s+)?(\w+)").unwrap(),
        ]);
        
        // TypeScript/JavaScript patterns
        self.patterns.insert("typescript".to_string(), vec![
            Regex::new(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:export\s+)?class\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:export\s+)?interface\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:export\s+)?type\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:export\s+)?enum\s+(\w+)").unwrap(),
        ]);
        self.patterns.insert("javascript".to_string(), self.patterns["typescript"].clone());
        
        // Python patterns
        self.patterns.insert("python".to_string(), vec![
            Regex::new(r"^\s*def\s+(\w+)").unwrap(),
            Regex::new(r"^\s*class\s+(\w+)").unwrap(),
            Regex::new(r"^\s*async\s+def\s+(\w+)").unwrap(),
        ]);
        
        // Go patterns
        self.patterns.insert("go".to_string(), vec![
            Regex::new(r"^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)").unwrap(),
            Regex::new(r"^\s*type\s+(\w+)\s+struct").unwrap(),
            Regex::new(r"^\s*type\s+(\w+)\s+interface").unwrap(),
            Regex::new(r"^\s*type\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:const|var)\s+(\w+)").unwrap(),
        ]);
        
        // Java patterns
        self.patterns.insert("java".to_string(), vec![
            Regex::new(r"^\s*(?:public|private|protected)?\s*(?:static)?\s*(?:final)?\s*(?:void|\w+)\s+(\w+)\s*\(").unwrap(),
            Regex::new(r"^\s*(?:public|private|protected)?\s*(?:abstract)?\s*class\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:public|private|protected)?\s*interface\s+(\w+)").unwrap(),
            Regex::new(r"^\s*(?:public|private|protected)?\s*enum\s+(\w+)").unwrap(),
        ]);
        
        // C/C++ patterns
        self.patterns.insert("cpp".to_string(), vec![
            Regex::new(r"^\s*(?:inline\s+)?(?:static\s+)?(?:\w+\s+)*?(\w+)\s*\([^)]*\)\s*(?:const)?\s*\{").unwrap(),
            Regex::new(r"^\s*class\s+(\w+)").unwrap(),
            Regex::new(r"^\s*struct\s+(\w+)").unwrap(),
            Regex::new(r"^\s*enum\s+(?:class\s+)?(\w+)").unwrap(),
            Regex::new(r"^\s*typedef\s+(?:struct|enum)?\s*\w+\s+(\w+)").unwrap(),
            Regex::new(r"^\s*#define\s+(\w+)").unwrap(),
        ]);
        self.patterns.insert("c".to_string(), self.patterns["cpp"].clone());
    }

    /// Search for symbols
    pub async fn search(
        &self,
        symbol_name: &str,
        path: &Path,
        max_results: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        let mut results = Vec::new();
        
        // First try using ctags if available
        if let Ok(ctags_results) = self.search_with_ctags(symbol_name, path, max_results).await {
            results.extend(ctags_results);
        }
        
        // Fallback to regex-based search
        if results.is_empty() {
            results = self.search_with_regex(symbol_name, path, max_results).await?;
        }
        
        Ok(results)
    }

    /// Search using ctags
    async fn search_with_ctags(
        &self,
        symbol_name: &str,
        path: &Path,
        max_results: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        // Check if ctags is available
        if Command::new("ctags").arg("--version").output().is_err() {
            return Err("ctags not available".into());
        }
        
        // Generate tags file
        let tags_file = path.join(".tags");
        Command::new("ctags")
            .args(&["-R", "-f", tags_file.to_str().unwrap(), path.to_str().unwrap()])
            .output()?;
        
        // Parse tags file
        let tags_content = fs::read_to_string(&tags_file)?;
        let mut results = Vec::new();
        
        for line in tags_content.lines() {
            if line.starts_with('!') || line.is_empty() {
                continue;
            }
            
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let name = parts[0];
                let file = parts[1];
                let pattern = parts[2];
                
                if name == symbol_name || name.contains(symbol_name) {
                    // Extract line number from pattern
                    let line_number = if let Some(num) = pattern.trim_start_matches("/^").trim_end_matches("$/").lines().next() {
                        tags_content.lines().position(|l| l.contains(num)).unwrap_or(0) + 1
                    } else {
                        0
                    };
                    
                    results.push(SearchResult {
                        file_path: PathBuf::from(file),
                        line_number,
                        column: 0,
                        match_text: pattern.to_string(),
                        context_before: vec![],
                        context_after: vec![],
                        match_type: MatchType::Symbol,
                        score: if name == symbol_name { 1.0 } else { 0.8 },
                        node_type: Some("symbol".to_string()),
                        semantic_context: None,
                    });
                    
                    if results.len() >= max_results {
                        break;
                    }
                }
            }
        }
        
        // Clean up tags file
        fs::remove_file(tags_file).ok();
        
        Ok(results)
    }

    /// Search using regex patterns
    async fn search_with_regex(
        &self,
        symbol_name: &str,
        path: &Path,
        max_results: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        let mut results = Vec::new();
        
        // Walk through files
        for entry in WalkDir::new(path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let file_path = entry.path();
            let language = detect_language(file_path);
            
            if let Ok(content) = fs::read_to_string(file_path) {
                let file_results = self.search_file_content(
                    &content,
                    symbol_name,
                    file_path,
                    language,
                );
                
                results.extend(file_results);
                
                if results.len() >= max_results {
                    break;
                }
            }
        }
        
        results.truncate(max_results);
        Ok(results)
    }

    /// Search within file content
    fn search_file_content(
        &self,
        content: &str,
        symbol_name: &str,
        file_path: &Path,
        language: &str,
    ) -> Vec<SearchResult> {
        let mut results = Vec::new();
        
        if let Some(patterns) = self.patterns.get(language) {
            for (line_num, line) in content.lines().enumerate() {
                for pattern in patterns {
                    if let Some(captures) = pattern.captures(line) {
                        if let Some(name) = captures.get(1) {
                            let captured_name = name.as_str();
                            
                            if captured_name == symbol_name || 
                               captured_name.contains(symbol_name) ||
                               symbol_name.contains(captured_name) {
                                // Get context lines
                                let lines: Vec<&str> = content.lines().collect();
                                let context_start = line_num.saturating_sub(3);
                                let context_end = std::cmp::min(line_num + 4, lines.len());
                                
                                let context_before = lines[context_start..line_num]
                                    .iter()
                                    .map(|s| s.to_string())
                                    .collect();
                                
                                let context_after = lines[(line_num + 1)..context_end]
                                    .iter()
                                    .map(|s| s.to_string())
                                    .collect();
                                
                                results.push(SearchResult {
                                    file_path: file_path.to_path_buf(),
                                    line_number: line_num + 1,
                                    column: name.start(),
                                    match_text: line.to_string(),
                                    context_before,
                                    context_after,
                                    match_type: MatchType::Symbol,
                                    score: if captured_name == symbol_name { 0.95 } else { 0.85 },
                                    node_type: Some(self.infer_symbol_type(line, language)),
                                    semantic_context: None,
                                });
                            }
                        }
                    }
                }
            }
        }
        
        results
    }

    /// Infer symbol type from line content
    fn infer_symbol_type(&self, line: &str, language: &str) -> String {
        let line_lower = line.to_lowercase();
        
        match language {
            "rust" => {
                if line_lower.contains("fn ") { "function" }
                else if line_lower.contains("struct ") { "struct" }
                else if line_lower.contains("enum ") { "enum" }
                else if line_lower.contains("trait ") { "trait" }
                else if line_lower.contains("type ") { "type" }
                else if line_lower.contains("const ") { "constant" }
                else if line_lower.contains("static ") { "static" }
                else if line_lower.contains("impl ") { "implementation" }
                else { "symbol" }
            }
            "typescript" | "javascript" => {
                if line_lower.contains("function ") { "function" }
                else if line_lower.contains("class ") { "class" }
                else if line_lower.contains("interface ") { "interface" }
                else if line_lower.contains("type ") { "type" }
                else if line_lower.contains("enum ") { "enum" }
                else if line_lower.contains("const ") || 
                        line_lower.contains("let ") || 
                        line_lower.contains("var ") { "variable" }
                else { "symbol" }
            }
            "python" => {
                if line_lower.contains("def ") { "function" }
                else if line_lower.contains("class ") { "class" }
                else { "symbol" }
            }
            _ => "symbol"
        }.to_string()
    }
}

/// Detect language from file extension
fn detect_language(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => "rust",
        Some("ts") | Some("tsx") => "typescript",
        Some("js") | Some("jsx") | Some("mjs") => "javascript",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("cpp") | Some("cc") | Some("cxx") => "cpp",
        Some("c") | Some("h") => "c",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_symbol_search() {
        let searcher = SymbolSearcher::new();
        let results = searcher.search(
            "test",
            Path::new("."),
            10,
        ).await;
        
        assert!(results.is_ok());
    }

    #[test]
    fn test_symbol_type_inference() {
        let searcher = SymbolSearcher::new();
        
        assert_eq!(
            searcher.infer_symbol_type("pub fn test_function() {", "rust"),
            "function"
        );
        
        assert_eq!(
            searcher.infer_symbol_type("class TestClass {", "typescript"),
            "class"
        );
        
        assert_eq!(
            searcher.infer_symbol_type("def test_function():", "python"),
            "function"
        );
    }
}