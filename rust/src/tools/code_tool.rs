/// Unified code semantics tool (HIP-0300)
///
/// Handles semantic code operations:
/// - parse: Parse source to AST
/// - serialize: AST to text (round-trips parse→serialize)
/// - symbols: List symbols in file
/// - outline: Symbols with imports/exports
/// - definition: Go to definition
/// - references: Find all references
/// - search_symbol: Find symbols across project
/// - transform: Codemod → Patch
/// - summarize: Compress to summary
/// - metrics: Count files/lines by extension
/// - exports: Extract public exports
/// - types: Find type definitions
/// - hierarchy: Build class inheritance tree
/// - rename: Rename symbols across files
/// - grep_replace: Pattern replacement across files

use anyhow::{anyhow, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use tree_sitter::{Language, Node, Parser};

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "__pycache__", ".venv", "venv"];

/// Actions for the code tool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CodeAction {
    Parse,
    Serialize,
    Symbols,
    Outline,
    Definition,
    References,
    SearchSymbol,
    Transform,
    Summarize,
    Metrics,
    Exports,
    Types,
    Hierarchy,
    Rename,
    GrepReplace,
    Help,
}

impl Default for CodeAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for CodeAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "parse" | "ast" => Ok(Self::Parse),
            "serialize" => Ok(Self::Serialize),
            "symbols" => Ok(Self::Symbols),
            "outline" => Ok(Self::Outline),
            "definition" | "goto" => Ok(Self::Definition),
            "references" | "refs" => Ok(Self::References),
            "search_symbol" | "search" => Ok(Self::SearchSymbol),
            "transform" | "codemod" => Ok(Self::Transform),
            "summarize" | "summary" => Ok(Self::Summarize),
            "metrics" => Ok(Self::Metrics),
            "exports" => Ok(Self::Exports),
            "types" => Ok(Self::Types),
            "hierarchy" => Ok(Self::Hierarchy),
            "rename" => Ok(Self::Rename),
            "grep_replace" => Ok(Self::GrepReplace),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Arguments for code tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodeToolArgs {
    pub action: Option<String>,
    pub uri: Option<String>,
    pub path: Option<String>,
    pub symbol: Option<String>,
    pub language: Option<String>,
    pub query: Option<String>,
    pub spec: Option<String>,
    pub text: Option<String>,
    pub pattern: Option<String>,
    pub new_name: Option<String>,
    pub replacement: Option<String>,
    pub max_results: Option<usize>,
    pub scope: Option<String>,
    pub ast: Option<Value>,
}

/// Tool definition for MCP registration
pub struct CodeToolDefinition;

impl CodeToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "code",
            "description": "Code semantics: parse, serialize, symbols, outline, definition, references, search_symbol, transform, summarize, metrics, exports, types, hierarchy, rename, grep_replace",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["parse", "serialize", "symbols", "outline", "definition", "references", "search_symbol", "transform", "summarize", "metrics", "exports", "types", "hierarchy", "rename", "grep_replace", "help"],
                        "description": "Code action"
                    },
                    "uri": { "type": "string", "description": "File path" },
                    "path": { "type": "string", "description": "File or directory path (alias for uri)" },
                    "symbol": { "type": "string", "description": "Symbol name" },
                    "language": { "type": "string", "description": "Programming language" },
                    "query": { "type": "string", "description": "Search query or symbol name" },
                    "spec": { "type": "string", "description": "Transform specification" },
                    "text": { "type": "string", "description": "Raw text input" },
                    "pattern": { "type": "string", "description": "File glob pattern" },
                    "new_name": { "type": "string", "description": "New name for rename" },
                    "replacement": { "type": "string", "description": "Replacement for grep_replace" },
                    "max_results": { "type": "number", "default": 20 },
                    "scope": { "type": "string", "description": "Search scope" },
                    "ast": { "type": "object", "description": "Pre-parsed AST node to serialize back to text" }
                },
                "required": ["action"]
            }
        })
    }
}

/// Code tool implementation
pub struct CodeTool;

impl CodeTool {
    pub fn new() -> Self {
        Self
    }

    fn resolve_uri<'a>(&self, args: &'a CodeToolArgs) -> Option<&'a str> {
        args.uri.as_deref().or(args.path.as_deref())
    }

    fn is_code_file(path: &Path) -> bool {
        matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("rs" | "py" | "js" | "ts" | "tsx" | "jsx" | "go" | "java" | "c" | "cpp" | "h" | "hpp" | "rb" | "swift" | "kt" | "cs" | "lua" | "sh")
        )
    }

    fn should_skip(entry: &std::fs::DirEntry) -> bool {
        entry.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n))
    }

    fn walk_files(dir: &Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        fn walk(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        if !CodeTool::should_skip(&entry) {
                            walk(&path, files);
                        }
                    } else if CodeTool::is_code_file(&path) {
                        files.push(path);
                    }
                }
            }
        }
        walk(dir, &mut files);
        files
    }

    fn detect_symbol(line: &str) -> Option<(&'static str, String)> {
        let trimmed = line.trim();
        let kind = if trimmed.starts_with("fn ") || trimmed.starts_with("pub fn ") || trimmed.starts_with("async fn ") || trimmed.starts_with("pub async fn ") {
            Some("function")
        } else if trimmed.starts_with("struct ") || trimmed.starts_with("pub struct ") {
            Some("struct")
        } else if trimmed.starts_with("enum ") || trimmed.starts_with("pub enum ") {
            Some("enum")
        } else if trimmed.starts_with("trait ") || trimmed.starts_with("pub trait ") {
            Some("trait")
        } else if trimmed.starts_with("class ") || trimmed.starts_with("export class ") {
            Some("class")
        } else if trimmed.starts_with("def ") || trimmed.starts_with("async def ") {
            Some("function")
        } else if trimmed.starts_with("function ") || trimmed.starts_with("export function ") || trimmed.starts_with("async function ") {
            Some("function")
        } else if trimmed.starts_with("interface ") || trimmed.starts_with("export interface ") {
            Some("interface")
        } else if trimmed.starts_with("type ") || trimmed.starts_with("export type ") {
            Some("type")
        } else {
            None
        };

        kind.and_then(|k| {
            let skip = ["fn", "pub", "async", "struct", "enum", "trait", "class", "def", "function", "export", "interface", "type"];
            let name = trimmed.split_whitespace()
                .find(|w| !skip.contains(w))
                .unwrap_or("")
                .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_')
                .to_string();
            if name.is_empty() { None } else { Some((k, name)) }
        })
    }

    pub async fn execute(&self, args: CodeToolArgs) -> Result<Value> {
        let action: CodeAction = args.action
            .as_deref()
            .unwrap_or("help")
            .parse()?;

        match action {
            CodeAction::Parse => self.parse(&args).await,
            CodeAction::Serialize => self.serialize(&args).await,
            CodeAction::Symbols => self.symbols(&args).await,
            CodeAction::Outline => self.outline(&args).await,
            CodeAction::Definition => self.definition(&args).await,
            CodeAction::References => self.references(&args).await,
            CodeAction::SearchSymbol => self.search_symbol(&args).await,
            CodeAction::Transform => self.transform(&args).await,
            CodeAction::Summarize => self.summarize(&args).await,
            CodeAction::Metrics => self.metrics(&args).await,
            CodeAction::Exports => self.exports(&args).await,
            CodeAction::Types => self.types(&args).await,
            CodeAction::Hierarchy => self.hierarchy(&args).await,
            CodeAction::Rename => self.rename(&args).await,
            CodeAction::GrepReplace => self.grep_replace(&args).await,
            CodeAction::Help => Ok(self.help()),
        }
    }

    async fn parse(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let lines = content.lines().count();
        let lang = args.language.clone().unwrap_or_else(|| {
            Path::new(uri).extension().and_then(|e| e.to_str()).unwrap_or("text").to_string()
        });

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "language": lang, "lines": lines },
            "error": null,
            "meta": { "tool": "code", "action": "parse" }
        }))
    }

    /// Map a language name to its tree-sitter grammar.
    fn ts_language(name: &str) -> Option<Language> {
        Some(match name {
            "rust" => tree_sitter_rust::language(),
            "javascript" | "jsx" => tree_sitter_javascript::language(),
            "typescript" => tree_sitter_typescript::language_typescript(),
            "tsx" => tree_sitter_typescript::language_tsx(),
            "python" => tree_sitter_python::language(),
            "go" => tree_sitter_go::language(),
            "java" => tree_sitter_java::language(),
            "cpp" => tree_sitter_cpp::language(),
            "c" => tree_sitter_c::language(),
            _ => return None,
        })
    }

    /// Resolve a tree-sitter grammar name from a file extension or explicit hint.
    fn ts_lang_name(ext: &str) -> &'static str {
        match ext {
            "rs" => "rust",
            "js" | "mjs" | "cjs" => "javascript",
            "jsx" => "jsx",
            "ts" => "typescript",
            "tsx" => "tsx",
            "py" => "python",
            "go" => "go",
            "java" => "java",
            "cpp" | "cc" | "cxx" | "hpp" => "cpp",
            "c" | "h" => "c",
            _ => "unknown",
        }
    }

    /// Reconstruct source by walking leaf nodes and refilling the inter-leaf
    /// gaps (whitespace/comments-between) from the original bytes. Concatenating
    /// leaf ranges plus gaps yields the exact input, so parse→serialize round-trips.
    fn walk_leaves(node: Node, source: &str, out: &mut String, last_end: &mut usize) {
        if node.child_count() == 0 {
            let range = node.byte_range();
            if range.start > *last_end {
                out.push_str(&source[*last_end..range.start]);
            }
            out.push_str(&source[range.clone()]);
            *last_end = range.end;
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::walk_leaves(child, source, out, last_end);
        }
    }

    /// Collapse a Python-shaped AST node (`{text}` leaf, else `{children}`) to
    /// text, joining child fragments with a single space. Mirrors the SDK.
    fn ast_node_text(node: &Value) -> String {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            return text.to_string();
        }
        node.get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().map(Self::ast_node_text).collect::<Vec<_>>().join(" "))
            .unwrap_or_default()
    }

    async fn serialize(&self, args: &CodeToolArgs) -> Result<Value> {
        // Path 1 — a pre-parsed AST node was supplied: collapse it to text
        // exactly as the Python SDK does (leaf text joined by spaces).
        if let Some(ast) = &args.ast {
            let root = ast.get("root").unwrap_or(ast);
            let text = Self::ast_node_text(root);
            let lang = args.language.clone()
                .or_else(|| ast.get("lang").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "unknown".to_string());
            return Ok(json!({
                "ok": true,
                "data": { "text": text, "lang": lang, "method": "ast", "supported": true },
                "error": null,
                "meta": { "tool": "code", "action": "serialize" }
            }));
        }

        // Path 2 — round-trip: parse the source with tree-sitter, then
        // reconstruct it from the parsed tree's leaves.
        let source = if let Some(text) = &args.text {
            text.clone()
        } else if let Some(uri) = self.resolve_uri(args) {
            tokio::fs::read_to_string(uri).await?
        } else {
            return Err(anyhow!("ast, text, or uri required"));
        };

        let lang_name = args.language.clone().unwrap_or_else(|| {
            let ext = self.resolve_uri(args)
                .and_then(|u| Path::new(u).extension().and_then(|e| e.to_str()))
                .unwrap_or("");
            Self::ts_lang_name(ext).to_string()
        });

        let language = Self::ts_language(&lang_name)
            .ok_or_else(|| anyhow!("Unsupported language for serialize: {}", lang_name))?;
        let mut parser = Parser::new();
        parser.set_language(language).map_err(|e| anyhow!("set_language failed: {}", e))?;
        let tree = parser.parse(source.as_bytes(), None)
            .ok_or_else(|| anyhow!("Parse failed for language: {}", lang_name))?;

        let mut text = String::with_capacity(source.len());
        let mut last_end = 0usize;
        Self::walk_leaves(tree.root_node(), &source, &mut text, &mut last_end);
        if last_end < source.len() {
            text.push_str(&source[last_end..]);
        }

        Ok(json!({
            "ok": true,
            "data": {
                "text": text,
                "lang": lang_name,
                "method": "round_trip",
                "supported": true,
                "round_trip": text == source
            },
            "error": null,
            "meta": { "tool": "code", "action": "serialize" }
        }))
    }

    async fn symbols(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = args.text.clone().unwrap_or(tokio::fs::read_to_string(uri).await?);
        let mut symbols = Vec::new();

        for (i, line) in content.lines().enumerate() {
            if let Some((kind, name)) = Self::detect_symbol(line) {
                symbols.push(json!({ "name": name, "kind": kind, "line": i + 1 }));
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "symbols": symbols, "count": symbols.len() },
            "error": null,
            "meta": { "tool": "code", "action": "symbols" }
        }))
    }

    async fn outline(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = args.text.clone().unwrap_or(tokio::fs::read_to_string(uri).await?);
        let mut symbols = Vec::new();
        let mut imports = 0;

        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.starts_with("import ") || trimmed.starts_with("from ") || trimmed.starts_with("use ") || trimmed.starts_with("require") {
                imports += 1;
            }
            if let Some((kind, name)) = Self::detect_symbol(line) {
                let exported = trimmed.starts_with("export ") || trimmed.starts_with("pub ");
                symbols.push(json!({ "name": name, "kind": kind, "line": i + 1, "exported": exported }));
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "symbols": symbols, "imports": imports, "lines": content.lines().count() },
            "error": null,
            "meta": { "tool": "code", "action": "outline" }
        }))
    }

    async fn definition(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let symbol = args.symbol.as_deref().or(args.query.as_deref()).ok_or_else(|| anyhow!("symbol or query required"))?;
        let content = tokio::fs::read_to_string(uri).await?;

        for (i, line) in content.lines().enumerate() {
            if line.contains(symbol) {
                if let Some(_) = Self::detect_symbol(line) {
                    return Ok(json!({
                        "ok": true,
                        "data": { "uri": uri, "symbol": symbol, "line": i + 1, "text": line.trim() },
                        "error": null,
                        "meta": { "tool": "code", "action": "definition" }
                    }));
                }
            }
        }

        Ok(json!({
            "ok": false,
            "data": null,
            "error": { "code": "NOT_FOUND", "message": format!("Symbol '{}' not found", symbol) },
            "meta": { "tool": "code", "action": "definition" }
        }))
    }

    async fn references(&self, args: &CodeToolArgs) -> Result<Value> {
        let symbol = args.symbol.as_deref().or(args.query.as_deref()).ok_or_else(|| anyhow!("symbol or query required"))?;
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let mut refs = Vec::new();

        for (i, line) in content.lines().enumerate() {
            if line.contains(symbol) {
                refs.push(json!({ "line": i + 1, "text": line.trim() }));
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "symbol": symbol, "references": refs, "count": refs.len() },
            "error": null,
            "meta": { "tool": "code", "action": "references" }
        }))
    }

    async fn search_symbol(&self, args: &CodeToolArgs) -> Result<Value> {
        let query = args.query.as_deref().ok_or_else(|| anyhow!("query required"))?;
        let dir = self.resolve_uri(args).unwrap_or(".");
        let max = args.max_results.unwrap_or(20);
        let files = Self::walk_files(Path::new(dir));
        let mut results = Vec::new();

        for file in files {
            if results.len() >= max { break; }
            if let Ok(content) = std::fs::read_to_string(&file) {
                for (i, line) in content.lines().enumerate() {
                    if results.len() >= max { break; }
                    if line.contains(query) {
                        if Self::detect_symbol(line).is_some() || line.contains(query) {
                            let is_def = Self::detect_symbol(line).is_some();
                            results.push(json!({
                                "uri": file.display().to_string(),
                                "line": i + 1,
                                "text": line.trim(),
                                "type": if is_def { "definition" } else { "reference" }
                            }));
                        }
                    }
                }
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "query": query, "results": results, "count": results.len() },
            "error": null,
            "meta": { "tool": "code", "action": "search_symbol" }
        }))
    }

    async fn transform(&self, _args: &CodeToolArgs) -> Result<Value> {
        Ok(json!({
            "ok": false,
            "data": null,
            "error": { "code": "NOT_IMPLEMENTED", "message": "Transform requires tree-sitter; use fs(action=apply_patch) for edits" },
            "meta": { "tool": "code", "action": "transform" }
        }))
    }

    async fn summarize(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args);
        let content = if let Some(text) = &args.text {
            text.clone()
        } else if let Some(uri) = uri {
            tokio::fs::read_to_string(uri).await?
        } else {
            return Err(anyhow!("uri or text required"));
        };

        let lines = content.lines().count();
        let chars = content.len();
        let words = content.split_whitespace().count();

        // Detect if it's a diff
        let is_diff = content.contains("---") && content.contains("+++");
        let summary = if is_diff {
            let adds = content.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
            let dels = content.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
            format!("Diff: {} lines, {} additions, {} deletions", lines, adds, dels)
        } else {
            format!("{} lines, {} words, {} bytes", lines, words, chars)
        };

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "lines": lines, "chars": chars, "words": words, "summary": summary },
            "error": null,
            "meta": { "tool": "code", "action": "summarize" }
        }))
    }

    async fn metrics(&self, args: &CodeToolArgs) -> Result<Value> {
        let dir = self.resolve_uri(args).unwrap_or(".");
        let files = Self::walk_files(Path::new(dir));
        let mut by_ext: HashMap<String, (usize, usize)> = HashMap::new(); // (files, lines)
        let mut total_files = 0usize;
        let mut total_lines = 0usize;

        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("other");
                let ext_key = format!(".{}", ext);
                let lines = content.lines().count();
                let entry = by_ext.entry(ext_key).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += lines;
                total_files += 1;
                total_lines += lines;
            }
        }

        let by_extension: HashMap<String, Value> = by_ext.into_iter()
            .map(|(k, (f, l))| (k, json!({ "files": f, "lines": l })))
            .collect();

        Ok(json!({
            "ok": true,
            "data": { "total_files": total_files, "total_lines": total_lines, "by_extension": by_extension },
            "error": null,
            "meta": { "tool": "code", "action": "metrics" }
        }))
    }

    async fn exports(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let mut exports = Vec::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("export ") || trimmed.starts_with("pub ") || trimmed.starts_with("__all__") {
                exports.push(trimmed.to_string());
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "exports": exports, "count": exports.len() },
            "error": null,
            "meta": { "tool": "code", "action": "exports" }
        }))
    }

    async fn types(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = self.resolve_uri(args).ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let mut type_defs = Vec::new();

        let re = Regex::new(r"(?:interface|type|enum|struct)\s+(\w+)").unwrap();
        for (i, line) in content.lines().enumerate() {
            if let Some(m) = re.captures(line) {
                type_defs.push(json!({
                    "name": m.get(1).map(|m| m.as_str()).unwrap_or(""),
                    "line": i + 1,
                    "text": line.trim()
                }));
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "types": type_defs, "count": type_defs.len() },
            "error": null,
            "meta": { "tool": "code", "action": "types" }
        }))
    }

    async fn hierarchy(&self, args: &CodeToolArgs) -> Result<Value> {
        let query = args.query.as_deref().ok_or_else(|| anyhow!("query (class name) required"))?;
        let dir = self.resolve_uri(args).unwrap_or(".");
        let files = Self::walk_files(Path::new(dir));
        let mut classes: HashMap<String, Vec<String>> = HashMap::new();

        let re = Regex::new(r"class\s+(\w+)(?:\s+extends\s+(\w+)|\s*\((\w+)\))?").unwrap();
        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                for cap in re.captures_iter(&content) {
                    let name = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
                    let parent = cap.get(2).or(cap.get(3)).map(|m| m.as_str().to_string());
                    classes.entry(name.clone()).or_default();
                    if let Some(p) = parent {
                        classes.entry(p.clone()).or_default().push(name);
                    }
                }
            }
        }

        fn build_tree(name: &str, classes: &HashMap<String, Vec<String>>, depth: usize) -> String {
            let mut out = "  ".repeat(depth) + name + "\n";
            if let Some(children) = classes.get(name) {
                for child in children {
                    out += &build_tree(child, classes, depth + 1);
                }
            }
            out
        }

        let tree = build_tree(query, &classes, 0);
        let children = classes.get(query).cloned().unwrap_or_default();

        Ok(json!({
            "ok": true,
            "data": { "root": query, "tree": tree, "children": children },
            "error": null,
            "meta": { "tool": "code", "action": "hierarchy" }
        }))
    }

    async fn rename(&self, args: &CodeToolArgs) -> Result<Value> {
        let query = args.query.as_deref().ok_or_else(|| anyhow!("query (old name) required"))?;
        let new_name = args.new_name.as_deref().ok_or_else(|| anyhow!("new_name required"))?;
        let dir = self.resolve_uri(args).unwrap_or(".");
        let files = Self::walk_files(Path::new(dir));
        let re = Regex::new(&format!(r"\b{}\b", regex::escape(query)))?;
        let mut total_changes = 0usize;
        let mut changed = Vec::new();

        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                if re.is_match(&content) {
                    let count = re.find_iter(&content).count();
                    let updated = re.replace_all(&content, new_name).to_string();
                    std::fs::write(&file, &updated)?;
                    total_changes += count;
                    changed.push(format!("{}: {} replacements", file.display(), count));
                }
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "old_name": query, "new_name": new_name, "files_changed": changed.len(), "total_replacements": total_changes, "changed": changed },
            "error": null,
            "meta": { "tool": "code", "action": "rename" }
        }))
    }

    async fn grep_replace(&self, args: &CodeToolArgs) -> Result<Value> {
        let pattern = args.query.as_deref().ok_or_else(|| anyhow!("query (pattern) required"))?;
        let replacement = args.replacement.as_deref().ok_or_else(|| anyhow!("replacement required"))?;
        let dir = self.resolve_uri(args).unwrap_or(".");
        let files = Self::walk_files(Path::new(dir));
        let re = Regex::new(pattern)?;
        let mut total_changes = 0usize;
        let mut changed = Vec::new();

        for file in files {
            if let Ok(content) = std::fs::read_to_string(&file) {
                if re.is_match(&content) {
                    let count = re.find_iter(&content).count();
                    let updated = re.replace_all(&content, replacement).to_string();
                    std::fs::write(&file, &updated)?;
                    total_changes += count;
                    changed.push(format!("{}: {}", file.display(), count));
                }
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "pattern": pattern, "replacement": replacement, "files_changed": changed.len(), "total_replacements": total_changes, "changed": changed },
            "error": null,
            "meta": { "tool": "code", "action": "grep_replace" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "code",
                "actions": {
                    "parse": "Parse source to AST (requires uri)",
                    "serialize": "Convert AST to text (round-trip; requires ast, or text/uri)",
                    "symbols": "List symbols in file (requires uri)",
                    "outline": "Symbols with imports/exports (requires uri)",
                    "definition": "Go to symbol definition (requires uri, symbol/query)",
                    "references": "Find all references (requires uri, symbol/query)",
                    "search_symbol": "Find symbols across project (requires query)",
                    "transform": "Codemod → Patch (requires uri, spec)",
                    "summarize": "Compress to summary (requires uri or text)",
                    "metrics": "Count files/lines by extension (optional uri for dir)",
                    "exports": "Extract public exports (requires uri)",
                    "types": "Find type definitions (requires uri)",
                    "hierarchy": "Build class inheritance tree (requires query)",
                    "rename": "Rename symbols across files (requires query, new_name)",
                    "grep_replace": "Pattern replacement across files (requires query, replacement)"
                }
            },
            "error": null,
            "meta": { "tool": "code", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_code_action_parse() {
        let action: CodeAction = "parse".parse().unwrap();
        assert_eq!(action, CodeAction::Parse);
    }

    #[test]
    fn test_code_action_aliases() {
        let action: CodeAction = "outline".parse().unwrap();
        assert_eq!(action, CodeAction::Outline);
        let action: CodeAction = "search".parse().unwrap();
        assert_eq!(action, CodeAction::SearchSymbol);
    }

    #[test]
    fn test_code_action_new_variants() {
        assert_eq!("metrics".parse::<CodeAction>().unwrap(), CodeAction::Metrics);
        assert_eq!("exports".parse::<CodeAction>().unwrap(), CodeAction::Exports);
        assert_eq!("types".parse::<CodeAction>().unwrap(), CodeAction::Types);
        assert_eq!("hierarchy".parse::<CodeAction>().unwrap(), CodeAction::Hierarchy);
        assert_eq!("rename".parse::<CodeAction>().unwrap(), CodeAction::Rename);
        assert_eq!("grep_replace".parse::<CodeAction>().unwrap(), CodeAction::GrepReplace);
        assert_eq!("serialize".parse::<CodeAction>().unwrap(), CodeAction::Serialize);
    }

    #[tokio::test]
    async fn test_serialize_round_trips_source() {
        let src = "fn main() {\n    let x = 1;\n    println!(\"{}\", x);\n}\n";
        let tool = CodeTool::new();
        let args = CodeToolArgs {
            action: Some("serialize".into()),
            text: Some(src.to_string()),
            language: Some("rust".into()),
            ..Default::default()
        };
        let out = tool.serialize(&args).await.unwrap();
        assert_eq!(out["data"]["text"].as_str().unwrap(), src);
        assert_eq!(out["data"]["round_trip"], json!(true));
        assert_eq!(out["data"]["method"], json!("round_trip"));
    }

    #[tokio::test]
    async fn test_serialize_from_ast_node() {
        let ast = json!({
            "lang": "python",
            "root": { "children": [ { "text": "x" }, { "text": "=" }, { "text": "1" } ] }
        });
        let tool = CodeTool::new();
        let args = CodeToolArgs {
            action: Some("serialize".into()),
            ast: Some(ast),
            ..Default::default()
        };
        let out = tool.serialize(&args).await.unwrap();
        assert_eq!(out["data"]["text"].as_str().unwrap(), "x = 1");
        assert_eq!(out["data"]["lang"], json!("python"));
        assert_eq!(out["data"]["method"], json!("ast"));
    }
}
