/// AST search using tree-sitter for semantic code understanding

use super::{SearchResult, MatchType};
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Parser, Query, QueryCursor, Node};
use walkdir::WalkDir;
use std::fs;

/// TreeSitter language bindings
extern "C" {
    fn tree_sitter_rust() -> Language;
    fn tree_sitter_javascript() -> Language;
    fn tree_sitter_typescript() -> Language;
    fn tree_sitter_python() -> Language;
    fn tree_sitter_go() -> Language;
    fn tree_sitter_java() -> Language;
    fn tree_sitter_cpp() -> Language;
    fn tree_sitter_c() -> Language;
}

/// AST searcher using tree-sitter
pub struct AstSearcher {
    parsers: std::collections::HashMap<String, Parser>,
}

impl AstSearcher {
    /// Create new AST searcher
    pub fn new() -> Self {
        let mut searcher = Self {
            parsers: std::collections::HashMap::new(),
        };
        
        // Initialize parsers for different languages
        searcher.init_parser("rust", unsafe { tree_sitter_rust() });
        searcher.init_parser("javascript", unsafe { tree_sitter_javascript() });
        searcher.init_parser("typescript", unsafe { tree_sitter_typescript() });
        searcher.init_parser("python", unsafe { tree_sitter_python() });
        searcher.init_parser("go", unsafe { tree_sitter_go() });
        searcher.init_parser("java", unsafe { tree_sitter_java() });
        searcher.init_parser("cpp", unsafe { tree_sitter_cpp() });
        searcher.init_parser("c", unsafe { tree_sitter_c() });
        
        searcher
    }

    /// Initialize parser for a language
    fn init_parser(&mut self, lang: &str, language: Language) {
        let mut parser = Parser::new();
        parser.set_language(language).ok();
        self.parsers.insert(lang.to_string(), parser);
    }

    /// Search for AST patterns
    pub async fn search(
        &self,
        pattern: &str,
        path: &Path,
        language: Option<&str>,
        max_results: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        let mut results = Vec::new();
        
        // Walk directory tree
        for entry in WalkDir::new(path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let file_path = entry.path();
            
            // Detect language from file extension
            let lang = language.unwrap_or_else(|| detect_language(file_path));
            
            // Get parser for language
            if let Some(parser) = self.parsers.get(lang) {
                if let Ok(source) = fs::read_to_string(file_path) {
                    // Parse the file
                    if let Some(tree) = parser.clone().parse(&source, None) {
                        // Search AST nodes
                        let file_results = self.search_tree(
                            &tree,
                            &source,
                            pattern,
                            file_path,
                            lang,
                        );
                        
                        results.extend(file_results);
                        
                        if results.len() >= max_results {
                            break;
                        }
                    }
                }
            }
        }
        
        results.truncate(max_results);
        Ok(results)
    }

    /// Search within a parsed tree
    fn search_tree(
        &self,
        tree: &tree_sitter::Tree,
        source: &str,
        pattern: &str,
        file_path: &Path,
        language: &str,
    ) -> Vec<SearchResult> {
        let mut results = Vec::new();
        let root_node = tree.root_node();
        
        // Build query based on pattern
        let query_str = build_query_string(pattern, language);
        
        if let Ok(query) = Query::new(
            self.parsers.get(language).unwrap().language().unwrap(),
            &query_str,
        ) {
            let mut cursor = QueryCursor::new();
            let matches = cursor.matches(&query, root_node, source.as_bytes());
            
            for match_ in matches {
                for capture in match_.captures {
                    let node = capture.node;
                    let start = node.start_position();
                    let end = node.end_position();
                    
                    // Extract match text
                    let match_text = source[node.byte_range()].to_string();
                    
                    // Get context
                    let (context_before, context_after) = get_context(source, node, 3);
                    
                    results.push(SearchResult {
                        file_path: file_path.to_path_buf(),
                        line_number: start.row + 1,
                        column: start.column,
                        match_text,
                        context_before,
                        context_after,
                        match_type: MatchType::Ast,
                        score: 0.95,
                        node_type: Some(node.kind().to_string()),
                        semantic_context: Some(get_semantic_context(node, source)),
                    });
                }
            }
        } else {
            // Fallback to pattern matching on node text
            results.extend(search_nodes_by_text(
                root_node,
                source,
                pattern,
                file_path,
            ));
        }
        
        results
    }
}

/// Detect language from file extension
fn detect_language(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => "rust",
        Some("js") | Some("mjs") => "javascript",
        Some("ts") | Some("tsx") => "typescript",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("cpp") | Some("cc") | Some("cxx") => "cpp",
        Some("c") | Some("h") => "c",
        _ => "text",
    }
}

/// Build tree-sitter query string from pattern
fn build_query_string(pattern: &str, language: &str) -> String {
    // Check for common patterns and convert to tree-sitter queries
    if pattern.starts_with("function ") {
        let name = pattern.trim_start_matches("function ").trim();
        match language {
            "rust" => format!("(function_item name: (identifier) @fn (#eq? @fn \"{}\"))", name),
            "javascript" | "typescript" => {
                format!("(function_declaration name: (identifier) @fn (#eq? @fn \"{}\"))", name)
            }
            "python" => format!("(function_definition name: (identifier) @fn (#eq? @fn \"{}\"))", name),
            _ => format!("(identifier) @id (#eq? @id \"{}\")", name),
        }
    } else if pattern.starts_with("class ") {
        let name = pattern.trim_start_matches("class ").trim();
        match language {
            "rust" => format!("(struct_item name: (type_identifier) @struct (#eq? @struct \"{}\"))", name),
            "javascript" | "typescript" => {
                format!("(class_declaration name: (identifier) @class (#eq? @class \"{}\"))", name)
            }
            "python" => format!("(class_definition name: (identifier) @class (#eq? @class \"{}\"))", name),
            _ => format!("(identifier) @id (#eq? @id \"{}\")", name),
        }
    } else {
        // Generic identifier search
        format!("(identifier) @id (#match? @id \"{}\")", pattern)
    }
}

/// Search nodes by text content
fn search_nodes_by_text(
    node: Node,
    source: &str,
    pattern: &str,
    file_path: &Path,
) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut cursor = node.walk();
    
    // Visit all nodes
    loop {
        let node = cursor.node();
        let node_text = source[node.byte_range()].to_string();
        
        // Check if node text contains pattern
        if node_text.contains(pattern) {
            let start = node.start_position();
            
            results.push(SearchResult {
                file_path: file_path.to_path_buf(),
                line_number: start.row + 1,
                column: start.column,
                match_text: node_text.clone(),
                context_before: vec![],
                context_after: vec![],
                match_type: MatchType::Ast,
                score: 0.9,
                node_type: Some(node.kind().to_string()),
                semantic_context: Some(get_semantic_context(node, source)),
            });
        }
        
        // Traverse tree
        if cursor.goto_first_child() {
            continue;
        }
        if cursor.goto_next_sibling() {
            continue;
        }
        
        loop {
            if !cursor.goto_parent() {
                return results;
            }
            if cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

/// Get context lines around a node
fn get_context(source: &str, node: Node, context_lines: usize) -> (Vec<String>, Vec<String>) {
    let lines: Vec<&str> = source.lines().collect();
    let start_line = node.start_position().row;
    let end_line = node.end_position().row;
    
    let before_start = start_line.saturating_sub(context_lines);
    let after_end = std::cmp::min(end_line + context_lines + 1, lines.len());
    
    let context_before = lines[before_start..start_line]
        .iter()
        .map(|s| s.to_string())
        .collect();
    
    let context_after = lines[(end_line + 1)..after_end]
        .iter()
        .map(|s| s.to_string())
        .collect();
    
    (context_before, context_after)
}

/// Get semantic context for a node
fn get_semantic_context(node: Node, source: &str) -> String {
    let mut context = format!("{} at {}:{}", 
        node.kind(),
        node.start_position().row + 1,
        node.start_position().column
    );
    
    // Find parent function or class
    if let Some(parent) = find_parent_context(node) {
        let parent_text = source[parent.byte_range()].lines().next().unwrap_or("");
        context.push_str(&format!(" in {}", parent_text));
    }
    
    context
}

/// Find parent function or class context
fn find_parent_context(mut node: Node) -> Option<Node> {
    while let Some(parent) = node.parent() {
        match parent.kind() {
            "function_item" | "function_declaration" | "function_definition" |
            "method_definition" | "struct_item" | "class_declaration" | 
            "class_definition" | "impl_item" => {
                return Some(parent);
            }
            _ => node = parent,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_ast_search() {
        let searcher = AstSearcher::new();
        let results = searcher.search(
            "function test",
            Path::new("."),
            Some("rust"),
            10,
        ).await;
        
        assert!(results.is_ok());
    }

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language(Path::new("test.rs")), "rust");
        assert_eq!(detect_language(Path::new("test.js")), "javascript");
        assert_eq!(detect_language(Path::new("test.ts")), "typescript");
        assert_eq!(detect_language(Path::new("test.py")), "python");
        assert_eq!(detect_language(Path::new("test.go")), "go");
    }
}