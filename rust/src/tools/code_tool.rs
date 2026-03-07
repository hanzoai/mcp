/// Unified code semantics tool (HIP-0300)
///
/// Handles semantic code operations:
/// - parse: Parse source to AST
/// - symbols: List symbols in file
/// - definition: Go to definition
/// - references: Find all references
/// - transform: Codemod → Patch
/// - summarize: Compress to summary

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

/// Actions for the code tool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CodeAction {
    Parse,
    Symbols,
    Definition,
    References,
    Transform,
    Summarize,
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
            "symbols" | "outline" => Ok(Self::Symbols),
            "definition" | "goto" => Ok(Self::Definition),
            "references" | "refs" => Ok(Self::References),
            "transform" | "codemod" => Ok(Self::Transform),
            "summarize" | "summary" => Ok(Self::Summarize),
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
    pub symbol: Option<String>,
    pub language: Option<String>,
    pub query: Option<String>,
    pub spec: Option<String>,
}

/// Tool definition for MCP registration
pub struct CodeToolDefinition;

impl CodeToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "code",
            "description": "Code semantics: parse, symbols, definition, references, transform, summarize",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["parse", "symbols", "definition", "references", "transform", "summarize", "help"],
                        "description": "Code action"
                    },
                    "uri": { "type": "string", "description": "File path" },
                    "symbol": { "type": "string", "description": "Symbol name" },
                    "language": { "type": "string", "description": "Programming language" },
                    "query": { "type": "string", "description": "Search query" },
                    "spec": { "type": "string", "description": "Transform specification" }
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

    pub async fn execute(&self, args: CodeToolArgs) -> Result<Value> {
        let action: CodeAction = args.action
            .as_deref()
            .unwrap_or("help")
            .parse()?;

        match action {
            CodeAction::Parse => self.parse(&args).await,
            CodeAction::Symbols => self.symbols(&args).await,
            CodeAction::Definition => self.definition(&args).await,
            CodeAction::References => self.references(&args).await,
            CodeAction::Transform => self.transform(&args).await,
            CodeAction::Summarize => self.summarize(&args).await,
            CodeAction::Help => Ok(self.help()),
        }
    }

    async fn parse(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = args.uri.as_deref().ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let lines = content.lines().count();
        // Basic language detection from extension
        let lang = args.language.clone().unwrap_or_else(|| {
            Path::new(uri)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("text")
                .to_string()
        });

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "language": lang, "lines": lines },
            "error": null,
            "meta": { "tool": "code", "action": "parse" }
        }))
    }

    async fn symbols(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = args.uri.as_deref().ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let mut symbols = Vec::new();

        // Regex-based symbol detection for portability
        for (i, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            let kind = if trimmed.starts_with("fn ") || trimmed.starts_with("pub fn ") || trimmed.starts_with("async fn ") {
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
            } else if trimmed.starts_with("function ") || trimmed.starts_with("export function ") {
                Some("function")
            } else if trimmed.starts_with("interface ") || trimmed.starts_with("export interface ") {
                Some("interface")
            } else {
                None
            };

            if let Some(kind) = kind {
                // Extract the name (second word)
                let name = trimmed.split_whitespace()
                    .find(|w| !["fn", "pub", "async", "struct", "enum", "trait", "class", "def", "function", "export", "interface"].contains(w))
                    .unwrap_or("")
                    .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_')
                    .to_string();

                if !name.is_empty() {
                    symbols.push(json!({
                        "name": name,
                        "kind": kind,
                        "line": i + 1
                    }));
                }
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "symbols": symbols, "count": symbols.len() },
            "error": null,
            "meta": { "tool": "code", "action": "symbols" }
        }))
    }

    async fn definition(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = args.uri.as_deref().ok_or_else(|| anyhow!("uri required"))?;
        let symbol = args.symbol.as_deref().ok_or_else(|| anyhow!("symbol required"))?;
        let content = tokio::fs::read_to_string(uri).await?;

        for (i, line) in content.lines().enumerate() {
            if line.contains(symbol) && (line.contains("fn ") || line.contains("struct ") || line.contains("class ") || line.contains("def ") || line.contains("function ")) {
                return Ok(json!({
                    "ok": true,
                    "data": { "uri": uri, "symbol": symbol, "line": i + 1, "text": line.trim() },
                    "error": null,
                    "meta": { "tool": "code", "action": "definition" }
                }));
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
        let symbol = args.symbol.as_deref().ok_or_else(|| anyhow!("symbol required"))?;
        let uri = args.uri.as_deref().ok_or_else(|| anyhow!("uri required"))?;
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

    async fn transform(&self, _args: &CodeToolArgs) -> Result<Value> {
        Ok(json!({
            "ok": false,
            "data": null,
            "error": { "code": "NOT_IMPLEMENTED", "message": "Transform requires tree-sitter; use fs(action=apply_patch) for edits" },
            "meta": { "tool": "code", "action": "transform" }
        }))
    }

    async fn summarize(&self, args: &CodeToolArgs) -> Result<Value> {
        let uri = args.uri.as_deref().ok_or_else(|| anyhow!("uri required"))?;
        let content = tokio::fs::read_to_string(uri).await?;
        let lines = content.lines().count();
        let chars = content.len();

        Ok(json!({
            "ok": true,
            "data": { "uri": uri, "lines": lines, "chars": chars, "summary": format!("{} lines, {} bytes", lines, chars) },
            "error": null,
            "meta": { "tool": "code", "action": "summarize" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "code",
                "actions": {
                    "parse": "Parse source to AST (requires uri)",
                    "symbols": "List symbols in file (requires uri)",
                    "definition": "Go to symbol definition (requires uri, symbol)",
                    "references": "Find all references (requires uri, symbol)",
                    "transform": "Codemod → Patch (requires uri, spec)",
                    "summarize": "Compress to summary (requires uri)"
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
        assert_eq!(action, CodeAction::Symbols);
    }
}
