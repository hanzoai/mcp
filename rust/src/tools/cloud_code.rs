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
use ignore::WalkBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", ".next",
];
const DEFAULT_MAX_FILES: usize = 1000;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024; // 20 MiB
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Secret file patterns that should never be indexed.
const SECRET_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "*.pub",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "credentials.json",
    "*.tfvars",
    "*.tfstate",
    "secrets.*",
];

/// Directory patterns that should never be indexed.
const SECRET_DIRS: &[&str] = &[
    ".aws",
    ".ssh",
    ".gnupg",
];

/// Check if a file path matches any secret pattern.
fn is_secret_file(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let path_str = path.to_string_lossy();

    // Check secret directories
    for secret_dir in SECRET_DIRS {
        if path_str.contains(&format!("/{}/", secret_dir)) || path_str.ends_with(&format!("/{}", secret_dir)) {
            return true;
        }
    }

    // Allow .env.example, .env.sample, .env.template FIRST (before pattern matching)
    if file_name == ".env.example" || file_name == ".env.sample" || file_name == ".env.template" {
        return false;
    }

    // Check for .env files (excluding the allowed ones)
    if file_name == ".env" || file_name.starts_with(".env.") {
        return true;
    }

    // Check secret file patterns
    for pattern in SECRET_PATTERNS {
        if matches_pattern(file_name, pattern) || matches_pattern(&path_str, pattern) {
            return true;
        }
    }

    false
}

/// Simple glob pattern matching for secret patterns.
fn matches_pattern(text: &str, pattern: &str) -> bool {
    if pattern == text {
        return true;
    }
    if pattern.starts_with("*.") {
        let ext = &pattern[1..]; // includes the dot
        return text.ends_with(ext);
    }
    if pattern.ends_with(".*") {
        let prefix = &pattern[..pattern.len()-1]; // includes the dot
        return text.starts_with(prefix);
    }
    if pattern.starts_with("*") && pattern.ends_with("*") {
        let inner = &pattern[1..pattern.len()-1];
        return text.contains(inner);
    }
    false
}

/// Check if content contains private key blocks or high-confidence token patterns.
fn is_secret_content(content: &str) -> bool {
    // Private key blocks
    if content.contains("-----BEGIN") && content.contains("PRIVATE KEY-----") {
        return true;
    }
    // High-confidence token patterns (common prefixes)
    let token_patterns = [
        "sk-",       // OpenAI, Anthropic, etc.
        "ghp_",      // GitHub personal access token
        "ghs_",      // GitHub secret
        "gho_",      // GitHub OAuth
        "xoxb-",     // Slack bot token
        "xoxp-",     // Slack user token
        "xapp-",     // Slack app token
        "glpat-",    // GitLab personal access token
        "gcp-",      // Google Cloud
        "aws_access_key_id",
        "aws_secret_access_key",
    ];
    for pattern in token_patterns {
        if content.contains(pattern) {
            return true;
        }
    }
    false
}

/// Walk a directory into indexable `{path, content}` files (bounded, text only).
fn collect_files(
    dir: &Path,
    max_files: usize,
    max_total_bytes: u64,
) -> (Vec<Value>, CollectStats) {
    let mut files = Vec::new();
    let mut stats = CollectStats::default();
    let mut total_bytes = 0u64;

    let walker = WalkBuilder::new(dir)
        .follow_links(false)
        .hidden(false) // all entries pass to filter_entry; we handle hidden there
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            // Skip SKIP_DIRS entirely (don't descend into them)
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                if SKIP_DIRS.contains(&name) {
                    return false;
                }
            }
            // Skip hidden entries except allowed .env templates
            if name.starts_with('.') {
                if name == ".env" {
                    return false; // secret
                }
                if name == ".env.example"
                    || name == ".env.sample"
                    || name == ".env.template"
                {
                    // keep
                } else {
                    return false; // all other hidden files skipped
                }
            }
            true
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };

        if !entry.file_type().map_or(false, |ft| ft.is_file()) {
            continue;
        }

        let path = entry.path();
        let rel_path = path.strip_prefix(dir).unwrap_or(path);

        // Skip secret files
        if is_secret_file(rel_path) {
            stats.secret_files += 1;
            continue;
        }

        // Check file size
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };

        if metadata.len() > MAX_FILE_BYTES {
            stats.too_large += 1;
            continue;
        }

        // Check total bytes budget
        if total_bytes + metadata.len() > max_total_bytes {
            stats.cap_reached = true;
            break;
        }

        // Read file content
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => {
                stats.binary += 1;
                continue;
            }
        };

        // Check content for secrets
        if is_secret_content(&content) {
            stats.secret_content += 1;
            continue;
        }

        total_bytes += metadata.len();
        stats.collected += 1;

        files.push(json!({
            "path": rel_path.to_string_lossy().to_string(),
            "content": content
        }));

        if files.len() >= max_files {
            stats.cap_reached = true;
            break;
        }
    }

    (files, stats)
}

#[derive(Default)]
struct CollectStats {
    collected: usize,
    ignored_dirs: usize,
    secret_files: usize,
    secret_content: usize,
    too_large: usize,
    binary: usize,
    errors: usize,
    cap_reached: bool,
}

/// Input arguments for code_index tool.
#[derive(Debug, Default, Deserialize)]
struct IndexArgs {
    repo: Option<String>,
    /// Local directory to walk into `files` when `files` is omitted.
    path: Option<String>,
    files: Option<Vec<IndexFile>>,
    /// Maximum number of files to index (default: 1000, max: 5000).
    max_files: Option<usize>,
    /// Maximum total bytes to upload (default: 20 MiB, max: 100 MiB).
    max_total_bytes: Option<u64>,
    /// Dry run: return the list of files that would be indexed without uploading.
    /// Defaults to true when `path` is used without `confirm: true`.
    dry_run: Option<bool>,
    /// Confirm upload (required when `path` is used and `dry_run` is not explicitly false).
    confirm: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct IndexFile {
    path: String,
    content: String,
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
            "description": "Index a repo into api.hanzo.ai. Pass explicit `files`, or a local `path` to walk (text files, bounded). Supports dry-run to list files before uploading.",
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
                    },
                    "maxFiles": {
                        "type": "integer",
                        "description": "Maximum number of files to index (default: 1000, max: 5000)",
                        "default": 1000,
                        "minimum": 1,
                        "maximum": 5000
                    },
                    "maxTotalBytes": {
                        "type": "integer",
                        "description": "Maximum total bytes to upload (default: 20971520 = 20 MiB, max: 104857600 = 100 MiB)",
                        "default": 20971520,
                        "minimum": 1024,
                        "maximum": 104857600
                    },
                    "dryRun": {
                        "type": "boolean",
                        "description": "Return list of files that would be indexed without uploading (default: true when path is provided without confirm)"
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Confirm upload when using path (required when dryRun is false or not set)"
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
        let (files, repo, walked_stats) = if let Some(list) = args.files {
            // Validate explicit files for secret patterns
            let mut validated_files = Vec::new();
            for f in list {
                let path = Path::new(&f.path);
                if is_secret_file(path) {
                    return Ok(ToolResult::ok(envelope_err(
                        "code_index",
                        "index",
                        "SECRET_FILE",
                        format!("Explicit file matches secret pattern: {}", f.path),
                    )));
                }
                validated_files.push(json!({ "path": f.path, "content": f.content }));
            }
            (validated_files, args.repo.clone(), CollectStats::default())
        } else if let Some(path) = args.path.as_deref().filter(|p| !p.is_empty()) {
            let dir = Path::new(path);
            if !dir.is_dir() {
                return Ok(ToolResult::ok(envelope_err(
                    "code_index",
                    "index",
                    "INVALID_ARGS",
                    format!("not a directory: {}", path),
                )));
            }

            let repo = args.repo.clone().or_else(|| {
                dir.canonicalize()
                    .ok()
                    .and_then(|c| c.file_name().map(|n| n.to_string_lossy().to_string()))
            });

            let max_files = args.max_files.unwrap_or(DEFAULT_MAX_FILES).min(5000);
            let max_total_bytes = args.max_total_bytes.unwrap_or(DEFAULT_MAX_TOTAL_BYTES).min(100 * 1024 * 1024);

            // Determine if this is a dry run
            let dry_run = args.dry_run.unwrap_or(args.confirm.is_none() || !args.confirm.unwrap_or(false));

            let (files, stats) = collect_files(dir, max_files, max_total_bytes);

            if dry_run {
                // Return dry run results
                let mut result = json!({
                    "dryRun": true,
                    "repo": repo,
                    "files": files.iter().map(|f| f["path"].as_str().unwrap_or("")).collect::<Vec<_>>(),
                    "counts": {
                        "wouldUpload": stats.collected,
                        "ignoredDirs": stats.ignored_dirs,
                        "secretFiles": stats.secret_files,
                        "secretContent": stats.secret_content,
                        "tooLarge": stats.too_large,
                        "binary": stats.binary,
                        "errors": stats.errors,
                    },
                    "capReached": stats.cap_reached,
                });
                if let Some(r) = repo {
                    result["repo"] = json!(r);
                }
                return Ok(ToolResult::ok(envelope_ok("code_index", "index", result)));
            }

            (files, repo, stats)
        } else {
            return Ok(ToolResult::ok(envelope_err(
                "code_index",
                "index",
                "INVALID_ARGS",
                "provide `files` or a local `path`",
            )));
        };

        if files.is_empty() {
            return Ok(ToolResult::ok(envelope_err(
                "code_index",
                "index",
                "EMPTY",
                "no indexable files found",
            )));
        }

        let repo = match repo.filter(|r| !r.is_empty()) {
            Some(r) => r,
            None => {
                return Ok(ToolResult::ok(envelope_err(
                    "code_index",
                    "index",
                    "INVALID_ARGS",
                    "repo required",
                )));
            }
        };

        let sent = files.len();
        let body = json!({ "repo": repo, "files": files });
        match self.api.post("/v1/code/index", body).await {
            Ok(mut result) => {
                if let Some(obj) = result.as_object_mut() {
                    obj.insert("sent".into(), json!(sent));
                    obj.insert("ignoredDirs".into(), json!(walked_stats.ignored_dirs));
                    obj.insert("secretFiles".into(), json!(walked_stats.secret_files));
                    obj.insert("secretContent".into(), json!(walked_stats.secret_content));
                    obj.insert("tooLarge".into(), json!(walked_stats.too_large));
                    obj.insert("binary".into(), json!(walked_stats.binary));
                    obj.insert("errors".into(), json!(walked_stats.errors));
                    if walked_stats.cap_reached {
                        obj.insert("capReached".into(), json!(true));
                    }
                }
                Ok(ToolResult::ok(envelope_ok("code_index", "index", result)))
            }
            Err(e) => Ok(ToolResult::ok(envelope_err("code_index", "index", "UPSTREAM", e.to_string()))),
        }
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
            None => {
                return Ok(ToolResult::ok(envelope_err(
                    "code_search",
                    "search",
                    "INVALID_ARGS",
                    "query required",
                )));
            }
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
            None => {
                return Ok(ToolResult::ok(envelope_err(
                    "code_context",
                    "context",
                    "INVALID_ARGS",
                    "query required",
                )));
            }
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
            None => {
                return Ok(ToolResult::ok(envelope_err(
                    "code_ask",
                    "ask",
                    "INVALID_ARGS",
                    "query required",
                )));
            }
        };
        let mut q: Vec<(&str, String)> = vec![("q", query)];
        if let Some(repo) = args.repo.filter(|r| !r.is_empty()) {
            q.push(("repo", repo));
        }
        respond("code_ask", "ask", self.api.get("/v1/code/ask", &q).await)
    }
}

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
            crate::hanzo_api::NO_KEY,
        ))))
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

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 1, "node_modules must be pruned");
        assert_eq!(files[0]["path"], "a.rs");
    }

    #[test]
    fn collect_files_skips_env_and_keys() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        std::fs::File::create(root.join(".env")).unwrap();
        std::fs::File::create(root.join("id_rsa")).unwrap();
        std::fs::File::create(root.join("id_rsa.pub")).unwrap();

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "a.rs");
        // id_rsa + id_rsa.pub (secret pattern); .env filtered as hidden
        assert_eq!(stats.secret_files, 2);
    }

    #[test]
    fn collect_files_allows_env_example() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        let mut f = std::fs::File::create(root.join(".env.example")).unwrap();
        writeln!(f, "FOO=bar").unwrap();
        let mut f = std::fs::File::create(root.join(".env.sample")).unwrap();
        writeln!(f, "FOO=bar").unwrap();
        let mut f = std::fs::File::create(root.join(".env.template")).unwrap();
        writeln!(f, "FOO=bar").unwrap();

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 4); // a.rs + 3 allowed .env templates
        assert_eq!(stats.secret_files, 0);
    }

    #[test]
    fn collect_files_skips_secret_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        let mut f = std::fs::File::create(root.join("config.json")).unwrap();
        writeln!(f, r#"{{ "api_key": "sk-1234567890" }}"#).unwrap();

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "a.rs");
        // key.pem excluded by *.pem name pattern (secret_files)
        assert_eq!(stats.secret_files, 1);
    }

    #[test]
    fn collect_files_skips_private_key_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        let mut f = std::fs::File::create(root.join("key.pem")).unwrap();
        writeln!(f, "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----").unwrap();

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "a.rs");
        // key.pem excluded by *.pem name pattern (secret_files)
        assert_eq!(stats.secret_files, 1);
    }

    #[test]
    fn collect_files_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut f = std::fs::File::create(root.join("a.rs")).unwrap();
        writeln!(f, "fn main() {{}}").unwrap();
        let mut f = std::fs::File::create(root.join(".gitignore")).unwrap();
        writeln!(f, "ignored.rs").unwrap();
        std::fs::File::create(root.join("ignored.rs")).unwrap();

        let (files, stats) = collect_files(root, DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "a.rs");
    }

    #[test]
    fn collect_files_enforces_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..10 {
            let mut f = std::fs::File::create(root.join(format!("file{}.rs", i))).unwrap();
            writeln!(f, "fn main() {{}}").unwrap();
        }

        let (files, stats) = collect_files(root, 5, DEFAULT_MAX_TOTAL_BYTES);
        assert_eq!(files.len(), 5);
        assert!(stats.cap_reached);
    }

    #[test]
    fn index_args_schema_has_new_fields() {
        let s = CodeIndexTool::schema();
        let props = &s["inputSchema"]["properties"];
        assert!(props.get("maxFiles").is_some());
        assert!(props.get("maxTotalBytes").is_some());
        assert!(props.get("dryRun").is_some());
        assert!(props.get("confirm").is_some());
    }

    /// Live end-to-end via the registry: index a repo, then find a symbol in it.
    /// Requires a live api.hanzo.ai + `sk-` key. Run: `cargo test -- --ignored`.
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
