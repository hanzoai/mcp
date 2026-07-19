//! Cloud-backed code knowledge tools (HIP-0300).
//!
//! Cross-repo search, context bundling, cited RAG answers, and indexing over
//! the live api.hanzo.ai code plane. These complement the local tree-sitter AST
//! engine (`code` tool / `search/ast_search.rs`), which stays for instant
//! single-file symbol/AST ops. Hybrid: local for one file, cloud for the corpus.
//!
//! - `code_search`  → GET  /v1/code/search  (symbol|text|semantic|hybrid)
//! - `code_context` → POST /v1/code/context (token-budgeted span bundle)
//! - `code_ask`     → GET  /v1/code/ask     (cited answer)
//! - `code_index`   → POST /v1/code/index   (index a repo's files)

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use walkdir::WalkDir;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", ".next",
];
const MAX_INDEX_FILES: usize = 5000;
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Wrap a raw API result (or transport error) in the standard envelope.
fn respond(tool: &'static str, action: &'static str, result: Result<Value>) -> Result<ToolResult> {
    Ok(match result {
        Ok(body) => ToolResult::ok(envelope_ok(tool, action, body)),
        Err(e) => ToolResult::ok(envelope_err(tool, action, "UPSTREAM", e.to_string())),
    })
}

fn require_key(api: &HanzoApi, tool: &'static str, action: &'static str) -> Option<Result<ToolResult>> {
    if api.has_key() {
        None
    } else {
        Some(Ok(ToolResult::ok(envelope_err(
            tool,
            action,
            "NO_API_KEY",
            "no hk- key: set HANZO_API_KEY or ~/.hanzo/config.json .apiKey",
        ))))
    }
}

// ---------------------------------------------------------------------------
// code_search → GET /v1/code/search
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct SearchArgs {
    #[serde(alias = "q")]
    query: Option<String>,
    /// symbol | text | semantic | hybrid (default hybrid)
    #[serde(alias = "type")]
    kind: Option<String>,
    repo: Option<String>,
    limit: Option<u32>,
}

pub struct CodeSearchTool {
    api: HanzoApi,
}

impl CodeSearchTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "code_search",
            "description": "Hybrid cross-repo code search on api.hanzo.ai (symbol|text|semantic|hybrid). Cloud counterpart to the local `code` AST tool.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "type": { "type": "string", "enum": ["symbol", "text", "semantic", "hybrid"], "default": "hybrid" },
                    "repo": { "type": "string", "description": "Restrict to a repo" },
                    "limit": { "type": "number", "default": 20 }
                },
                "required": ["query"]
            }
        })
    }
}

impl Default for CodeSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CodeSearchTool {
    fn name(&self) -> &str {
        "code_search"
    }
    fn description(&self) -> &str {
        "Hybrid cross-repo code search on api.hanzo.ai (symbol|text|semantic|hybrid)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "code_search", "search") {
            return r;
        }
        let args: SearchArgs = serde_json::from_value(params).unwrap_or_default();
        let query = match args.query.filter(|q| !q.trim().is_empty()) {
            Some(q) => q,
            None => return Ok(ToolResult::ok(envelope_err("code_search", "search", "INVALID_ARGS", "query required"))),
        };

        let mut q: Vec<(&str, String)> = vec![
            ("q", query),
            ("type", args.kind.unwrap_or_else(|| "hybrid".to_string())),
            ("limit", args.limit.unwrap_or(20).to_string()),
        ];
        if let Some(repo) = args.repo.filter(|r| !r.is_empty()) {
            q.push(("repo", repo));
        }
        respond("code_search", "search", self.api.get("/v1/code/search", &q).await)
    }
}

// ---------------------------------------------------------------------------
// code_context → POST /v1/code/context
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct ContextArgs {
    #[serde(alias = "q")]
    query: Option<String>,
    #[serde(alias = "budget_tokens", alias = "budget")]
    budget_tokens: Option<u32>,
    repo: Option<String>,
}

pub struct CodeContextTool {
    api: HanzoApi,
}

impl CodeContextTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "code_context",
            "description": "Token-budgeted code context bundle for a query from api.hanzo.ai.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to gather context for" },
                    "budgetTokens": { "type": "number", "default": 2000 },
                    "repo": { "type": "string" }
                },
                "required": ["query"]
            }
        })
    }
}

impl Default for CodeContextTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CodeContextTool {
    fn name(&self) -> &str {
        "code_context"
    }
    fn description(&self) -> &str {
        "Token-budgeted code context bundle for a query from api.hanzo.ai"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "code_context", "context") {
            return r;
        }
        let args: ContextArgs = serde_json::from_value(params).unwrap_or_default();
        let query = match args.query.filter(|q| !q.trim().is_empty()) {
            Some(q) => q,
            None => return Ok(ToolResult::ok(envelope_err("code_context", "context", "INVALID_ARGS", "query required"))),
        };
        let mut body = json!({
            "query": query,
            "budgetTokens": args.budget_tokens.unwrap_or(2000),
        });
        if let Some(repo) = args.repo.filter(|r| !r.is_empty()) {
            body["repo"] = json!(repo);
        }
        respond("code_context", "context", self.api.post("/v1/code/context", body).await)
    }
}

// ---------------------------------------------------------------------------
// code_ask → GET /v1/code/ask
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct AskArgs {
    #[serde(alias = "q", alias = "question")]
    query: Option<String>,
    repo: Option<String>,
}

pub struct CodeAskTool {
    api: HanzoApi,
}

impl CodeAskTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "code_ask",
            "description": "Ask a question about indexed code; returns a cited RAG answer from api.hanzo.ai.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Question about the code" },
                    "repo": { "type": "string" }
                },
                "required": ["query"]
            }
        })
    }
}

impl Default for CodeAskTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CodeAskTool {
    fn name(&self) -> &str {
        "code_ask"
    }
    fn description(&self) -> &str {
        "Ask a question about indexed code; returns a cited RAG answer from api.hanzo.ai"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "code_ask", "ask") {
            return r;
        }
        let args: AskArgs = serde_json::from_value(params).unwrap_or_default();
        let query = match args.query.filter(|q| !q.trim().is_empty()) {
            Some(q) => q,
            None => return Ok(ToolResult::ok(envelope_err("code_ask", "ask", "INVALID_ARGS", "query required"))),
        };
        let mut q: Vec<(&str, String)> = vec![("q", query)];
        if let Some(repo) = args.repo.filter(|r| !r.is_empty()) {
            q.push(("repo", repo));
        }
        respond("code_ask", "ask", self.api.get("/v1/code/ask", &q).await)
    }
}

// ---------------------------------------------------------------------------
// code_index → POST /v1/code/index
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct IndexFile {
    path: String,
    content: String,
}

#[derive(Debug, Default, Deserialize)]
struct IndexArgs {
    repo: Option<String>,
    /// Local directory to walk into `files` when `files` is omitted.
    path: Option<String>,
    files: Option<Vec<IndexFile>>,
}

pub struct CodeIndexTool {
    api: HanzoApi,
}

impl CodeIndexTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "code_index",
            "description": "Index a repo into api.hanzo.ai. Pass explicit `files`, or a local `path` to walk (text files, bounded).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "Repo name (defaults to the directory basename)" },
                    "path": { "type": "string", "description": "Local directory to walk and index" },
                    "files": {
                        "type": "array",
                        "description": "Explicit files to index",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "content": { "type": "string" }
                            },
                            "required": ["path", "content"]
                        }
                    }
                },
                "required": []
            }
        })
    }
}

impl Default for CodeIndexTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Walk a directory into indexable `{path, content}` files (bounded, text only).
fn collect_files(dir: &Path) -> (Vec<Value>, usize) {
    let mut files = Vec::new();
    let mut skipped = 0usize;
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir()
                && e.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n)))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if files.len() >= MAX_INDEX_FILES {
            break;
        }
        let path = entry.path();
        match entry.metadata() {
            Ok(m) if m.len() > MAX_FILE_BYTES => {
                skipped += 1;
                continue;
            }
            Ok(_) => {}
            Err(_) => {
                skipped += 1;
                continue;
            }
        }
        match std::fs::read_to_string(path) {
            Ok(content) => {
                let rel = path.strip_prefix(dir).unwrap_or(path).to_string_lossy().to_string();
                files.push(json!({ "path": rel, "content": content }));
            }
            Err(_) => skipped += 1, // binary / non-utf8
        }
    }
    (files, skipped)
}

#[async_trait]
impl MCPTool for CodeIndexTool {
    fn name(&self) -> &str {
        "code_index"
    }
    fn description(&self) -> &str {
        "Index a repo into api.hanzo.ai (explicit files or a local path to walk)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "code_index", "index") {
            return r;
        }
        let args: IndexArgs = serde_json::from_value(params).unwrap_or_default();

        // Resolve files: explicit list wins; else walk the local path.
        let (files, repo, walked_skipped) = if let Some(list) = args.files {
            let files: Vec<Value> = list
                .into_iter()
                .map(|f| json!({ "path": f.path, "content": f.content }))
                .collect();
            (files, args.repo.clone(), 0usize)
        } else if let Some(path) = args.path.as_deref().filter(|p| !p.is_empty()) {
            let dir = Path::new(path);
            if !dir.is_dir() {
                return Ok(ToolResult::ok(envelope_err("code_index", "index", "INVALID_ARGS", format!("not a directory: {}", path))));
            }
            let repo = args.repo.clone().or_else(|| {
                dir.canonicalize()
                    .ok()
                    .and_then(|c| c.file_name().map(|n| n.to_string_lossy().to_string()))
            });
            let (files, skipped) = collect_files(dir);
            (files, repo, skipped)
        } else {
            return Ok(ToolResult::ok(envelope_err("code_index", "index", "INVALID_ARGS", "provide `files` or a local `path`")));
        };

        if files.is_empty() {
            return Ok(ToolResult::ok(envelope_err("code_index", "index", "EMPTY", "no indexable files found")));
        }
        let repo = match repo.filter(|r| !r.is_empty()) {
            Some(r) => r,
            None => return Ok(ToolResult::ok(envelope_err("code_index", "index", "INVALID_ARGS", "repo required"))),
        };

        let sent = files.len();
        let body = json!({ "repo": repo, "files": files });
        match self.api.post("/v1/code/index", body).await {
            Ok(mut result) => {
                if let Some(obj) = result.as_object_mut() {
                    obj.insert("sent".into(), json!(sent));
                    if walked_skipped > 0 {
                        obj.insert("walkedSkipped".into(), json!(walked_skipped));
                    }
                }
                Ok(ToolResult::ok(envelope_ok("code_index", "index", result)))
            }
            Err(e) => Ok(ToolResult::ok(envelope_err("code_index", "index", "UPSTREAM", e.to_string()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn search_schema_shape() {
        let s = CodeSearchTool::schema();
        assert_eq!(s["name"], "code_search");
        assert_eq!(s["inputSchema"]["required"][0], "query");
        let props = &s["inputSchema"]["properties"];
        assert!(props.get("type").is_some());
        assert!(props.get("repo").is_some());
    }

    #[test]
    fn tool_names_are_stable() {
        assert_eq!(CodeSearchTool::new().name(), "code_search");
        assert_eq!(CodeContextTool::new().name(), "code_context");
        assert_eq!(CodeAskTool::new().name(), "code_ask");
        assert_eq!(CodeIndexTool::new().name(), "code_index");
    }

    #[test]
    fn search_args_accept_q_and_type_aliases() {
        let a: SearchArgs = serde_json::from_value(json!({ "q": "foo", "type": "symbol", "limit": 5 })).unwrap();
        assert_eq!(a.query.as_deref(), Some("foo"));
        assert_eq!(a.kind.as_deref(), Some("symbol"));
        assert_eq!(a.limit, Some(5));
    }

    #[test]
    fn collect_files_walks_and_skips_noise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::File::create(root.join("node_modules").join("junk.js")).unwrap();

        let (files, _skipped) = collect_files(root);
        assert_eq!(files.len(), 1, "node_modules must be pruned");
        assert_eq!(files[0]["path"], "a.rs");
    }

    /// Live end-to-end via the registry: index a repo, then find a symbol in it.
    /// Requires a live api.hanzo.ai + hk- key. Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_index_then_search_via_registry() {
        let registry = crate::ToolRegistry::with_defaults();
        let repo = format!("mcp-rust-live-{}", std::process::id());

        let indexed = registry
            .execute("code_index", json!({
                "repo": repo,
                "files": [{ "path": "greet.rs", "content": "pub fn hanzo_greet() -> &'static str { \"hi\" }" }]
            }))
            .await
            .unwrap();
        assert_eq!(indexed.content["ok"], true, "index envelope: {}", indexed.content);
        assert!(indexed.content["data"]["indexed"].as_u64().unwrap_or(0) >= 1);

        let found = registry
            .execute("code_search", json!({ "q": "hanzo_greet", "type": "hybrid", "repo": repo }))
            .await
            .unwrap();
        assert_eq!(found.content["ok"], true, "search envelope: {}", found.content);
        println!("code_search data: {}", found.content["data"]);
    }
}
