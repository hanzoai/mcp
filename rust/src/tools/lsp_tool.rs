//! Language Server Protocol tool for code intelligence (HIP-0300).
//!
//! One tool, two planes, chosen by the data the caller already supplies:
//!
//! - no `repo` — a language server per `language:root`, spoken to over stdio
//!   JSON-RPC (Content-Length framing). On-demand install + a global registry
//!   keyed by `<language>:<root>` keep one server alive per project. Answers
//!   what a working tree knows, including the edits it can apply back to disk.
//! - with `repo` — the indexed corpus behind `/v1/code/lsp` on api.hanzo.ai,
//!   which answers across a repo's dependencies without checking anything out.
//!
//! `file` names the file either way; `repo` says which world that file lives
//! in. Languages (local plane): Go, Python, TypeScript/JavaScript, Rust, Java,
//! C/C++, Ruby, Lua.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

// ---------------------------------------------------------------------------
// Server configuration table (one entry per language).
// ---------------------------------------------------------------------------

struct ServerConfig {
    name: &'static str,
    install_cmd: &'static [&'static str],
    check_cmd: &'static [&'static str],
    start_cmd: &'static [&'static str],
    root_markers: &'static [&'static str],
    file_extensions: &'static [&'static str],
    capabilities: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
}

static SERVERS: Lazy<Vec<(&'static str, ServerConfig)>> = Lazy::new(|| {
    vec![
        ("go", ServerConfig {
            name: "gopls",
            install_cmd: &["go", "install", "golang.org/x/tools/gopls@latest"],
            check_cmd: &["gopls", "version"],
            start_cmd: &["gopls", "serve", "-mode=stdio"],
            root_markers: &["go.work", "go.mod", "go.sum"],
            file_extensions: &[".go"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion"],
            env: &[("GOWORK", "auto")],
        }),
        ("python", ServerConfig {
            name: "pyright",
            install_cmd: &["npm", "install", "-g", "pyright"],
            check_cmd: &["pyright-langserver", "--version"],
            start_cmd: &["pyright-langserver", "--stdio"],
            root_markers: &["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"],
            file_extensions: &[".py", ".pyi"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion", "typeDefinition"],
            env: &[],
        }),
        ("typescript", ServerConfig {
            name: "typescript-language-server",
            install_cmd: &["npm", "install", "-g", "typescript", "typescript-language-server"],
            check_cmd: &["typescript-language-server", "--version"],
            start_cmd: &["typescript-language-server", "--stdio"],
            root_markers: &["tsconfig.json", "package.json"],
            file_extensions: &[".ts", ".tsx", ".js", ".jsx"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion"],
            env: &[],
        }),
        ("rust", ServerConfig {
            name: "rust-analyzer",
            install_cmd: &["rustup", "component", "add", "rust-analyzer"],
            check_cmd: &["rust-analyzer", "--version"],
            start_cmd: &["rust-analyzer"],
            root_markers: &["Cargo.toml"],
            file_extensions: &[".rs"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion", "inlay_hints"],
            env: &[],
        }),
        ("java", ServerConfig {
            name: "jdtls",
            install_cmd: &["brew", "install", "jdtls"],
            check_cmd: &["jdtls", "--version"],
            start_cmd: &["jdtls"],
            root_markers: &["pom.xml", "build.gradle", "build.gradle.kts"],
            file_extensions: &[".java"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion"],
            env: &[],
        }),
        ("cpp", ServerConfig {
            name: "clangd",
            install_cmd: &["brew", "install", "llvm"],
            check_cmd: &["clangd", "--version"],
            start_cmd: &["clangd"],
            root_markers: &["compile_commands.json", "CMakeLists.txt"],
            file_extensions: &[".cpp", ".cc", ".cxx", ".c", ".h", ".hpp"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion"],
            env: &[],
        }),
        ("ruby", ServerConfig {
            name: "solargraph",
            install_cmd: &["gem", "install", "solargraph"],
            check_cmd: &["solargraph", "--version"],
            start_cmd: &["solargraph", "stdio"],
            root_markers: &["Gemfile", ".solargraph.yml"],
            file_extensions: &[".rb"],
            capabilities: &["definition", "references", "diagnostics", "hover", "completion"],
            env: &[],
        }),
        ("lua", ServerConfig {
            name: "lua-language-server",
            install_cmd: &["brew", "install", "lua-language-server"],
            check_cmd: &["lua-language-server", "--version"],
            start_cmd: &["lua-language-server"],
            root_markers: &[".luarc.json"],
            file_extensions: &[".lua"],
            capabilities: &["definition", "references", "rename", "diagnostics", "hover", "completion"],
            env: &[],
        }),
    ]
});

fn server_config(language: &str) -> Option<&'static ServerConfig> {
    SERVERS.iter().find(|(l, _)| *l == language).map(|(_, c)| c)
}

fn language_keys() -> Vec<&'static str> {
    SERVERS.iter().map(|(l, _)| *l).collect()
}

// ---------------------------------------------------------------------------
// Running server + global registry.
// ---------------------------------------------------------------------------

struct ChildIo {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct LspServer {
    language: String,
    root: String,
    io: Mutex<ChildIo>,
    next_id: AtomicI64,
}

impl LspServer {
    fn next_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

static REGISTRY: Lazy<Mutex<HashMap<String, Arc<LspServer>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct LspArgs {
    action: Option<String>,
    file: Option<String>,
    repo: Option<String>,
    rev: Option<String>,
    line: Option<i64>,
    character: Option<i64>,
    new_name: Option<String>,
    #[serde(default)]
    apply_edits: bool,
    only: Option<Vec<String>>,
    range: Option<Value>,
}

pub struct LspTool {
    api: HanzoApi,
}

impl LspTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }

    pub fn schema() -> Value {
        json!({
            "name": "lsp",
            "description": Self::describe(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "definition", "references", "type", "implementation",
                                 "symbols", "rename", "hover", "completion", "code_action",
                                 "organize_imports", "diagnostics"],
                        "description": "LSP operation to perform"
                    },
                    "file": { "type": "string", "description": "The source file: a local path, or the path within `repo`" },
                    "repo": { "type": "string", "description": "git.hanzo.ai repo slug — answer from the cloud index (spans the repo's dependencies) instead of a local server" },
                    "rev": { "type": "string", "description": "Branch, tag or sha to read `repo` at (default: its head)" },
                    "line": { "type": "integer", "description": "1-based line of the symbol/position" },
                    "character": { "type": "integer", "description": "0-based UTF-16 character on the line" },
                    "new_name": { "type": "string", "description": "New identifier for rename" },
                    "apply_edits": { "type": "boolean", "description": "Apply rename/code_action edits to disk", "default": false },
                    "only": { "type": "array", "items": { "type": "string" }, "description": "Restrict code_action to these kinds" },
                    "range": { "type": "object", "description": "LSP range {start:{line,character},end:{...}} for code_action" }
                },
                "required": ["action", "file"]
            }
        })
    }

    fn describe() -> &'static str {
        "Language Server Protocol code intelligence. Local (a language server on \
         your tree, auto-installed): status, definition, references, rename, \
         hover, completion, code_action, organize_imports, diagnostics — Go, \
         Python, TypeScript/JavaScript, Rust, Java, C/C++, Ruby, Lua. Pass `repo` \
         (a git.hanzo.ai slug, optionally `rev`) to answer from the cloud index \
         instead, which reaches across the repo's dependencies: definition, \
         references, type, implementation, symbols, hover, completion, \
         diagnostics."
    }
}

impl Default for LspTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Actions a local language server answers.
const LOCAL_ACTIONS: &[&str] = &[
    "definition", "references", "rename", "diagnostics", "hover",
    "completion", "code_action", "organize_imports", "status",
];

/// The `/v1/code/lsp` op each action asks for, and the `relation` a `locate`
/// op carries. "Where is X" is one question with four answers, so it is one op.
const CLOUD_OPS: &[(&str, &str, Option<&str>)] = &[
    ("hover", "hover", None),
    ("definition", "locate", Some("definition")),
    ("references", "locate", Some("reference")),
    ("type", "locate", Some("type")),
    ("implementation", "locate", Some("implementation")),
    ("symbols", "symbols", None),
    ("diagnostics", "diagnostics", None),
    ("completion", "complete", None),
];

/// Actions the cloud index answers.
fn cloud_actions() -> Vec<&'static str> {
    CLOUD_OPS.iter().map(|(action, _, _)| *action).collect()
}

#[async_trait]
impl MCPTool for LspTool {
    fn name(&self) -> &str {
        "lsp"
    }
    fn description(&self) -> &str {
        Self::describe()
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: LspArgs = serde_json::from_value(params).unwrap_or_default();
        Ok(ToolResult::ok(run(&self.api, args).await))
    }
}

async fn run(api: &HanzoApi, args: LspArgs) -> Value {
    let action = args.action.clone().unwrap_or_default();
    let file = match args.file.clone() {
        Some(f) if !f.trim().is_empty() => f,
        _ => return json!({ "error": "file is required: a local path, or the path within `repo`" }),
    };

    if !LOCAL_ACTIONS.contains(&action.as_str()) && cloud_op(&action).is_none() {
        let cloud_only: Vec<&str> = cloud_actions()
            .into_iter()
            .filter(|a| !LOCAL_ACTIONS.contains(a))
            .collect();
        let known = [LOCAL_ACTIONS, &cloud_only].concat();
        return json!({
            "error": format!("Invalid action. Must be one of: {}", known.join(", "))
        });
    }

    if let Some(repo) = args.repo.clone().filter(|r| !r.trim().is_empty()) {
        return cloud(api, &repo, &action, &file, &args).await;
    }

    if !LOCAL_ACTIONS.contains(&action.as_str()) {
        return json!({
            "error": format!("Action '{}' is answered by the cloud index; pass `repo`", action),
            "local_actions": LOCAL_ACTIONS,
        });
    }

    let language = match language_from_file(&file) {
        Some(l) => l,
        None => {
            return json!({
                "error": format!("Unsupported file type: {}", file),
                "supported_languages": language_keys(),
            })
        }
    };

    let config = server_config(language).expect("language config");
    let capabilities: Vec<&str> = config.capabilities.to_vec();

    if !capabilities.contains(&action.as_str())
        && !["status", "organize_imports", "code_action"].contains(&action.as_str())
    {
        return json!({
            "error": format!("Action '{}' not supported for {}", action, language),
            "supported_actions": capabilities,
        });
    }

    if action == "status" {
        let installed = check_installed(config).await;
        return json!({
            "language": language,
            "lsp_server": config.name,
            "installed": installed,
            "capabilities": capabilities,
        });
    }

    let root = find_project_root(&file, language);
    let server = match ensure_running(language, &root, config).await {
        Some(s) => s,
        None => {
            return json!({
                "error": format!("Failed to start LSP server for {}", language),
                "install_command": config.install_cmd.join(" "),
            })
        }
    };

    execute_action(&server, language, &action, &file, &args).await
}

// ---------------------------------------------------------------------------
// Cloud plane: /v1/code/lsp — the indexed corpus, dependencies included.
// ---------------------------------------------------------------------------

/// The op and `relation` for an action, or `None` when only a working tree can
/// answer it.
fn cloud_op(action: &str) -> Option<(&'static str, Option<&'static str>)> {
    CLOUD_OPS
        .iter()
        .find(|(a, _, _)| *a == action)
        .map(|(_, op, relation)| (*op, *relation))
}

/// Ask the cloud index. The answer is whatever `/v1/code/lsp` returns, verbatim.
async fn cloud(api: &HanzoApi, repo: &str, action: &str, file: &str, args: &LspArgs) -> Value {
    let (op, relation) = match cloud_op(action) {
        Some(pair) => pair,
        None => {
            return json!({
                "action": action,
                "repo": repo,
                "error": format!("Action '{}' needs a working tree; call it without `repo`", action),
                "cloud_actions": cloud_actions(),
            })
        }
    };
    if !api.has_key() {
        return json!({
            "action": action,
            "repo": repo,
            "error": "no hk- key: set HANZO_API_KEY or ~/.hanzo/config.json .apiKey",
        });
    }

    // The wire speaks LSP's own frame: 0-based line, 0-based UTF-16 character.
    // The tool's `line` is 1-based, so it is shifted here exactly as the local
    // plane shifts it before a JSON-RPC request.
    let mut body = json!({
        "repo": repo,
        "path": file,
        "line": args.line.map(|l| l - 1).unwrap_or(0),
        "character": args.character.unwrap_or(0),
    });
    if let Some(rev) = args.rev.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        body["rev"] = json!(rev);
    }
    if let Some(relation) = relation {
        body["relation"] = json!(relation);
    }

    match api.post(&format!("/v1/code/lsp/{}", op), body).await {
        Ok(result) => result,
        Err(e) => json!({ "action": action, "repo": repo, "error": e.to_string() }),
    }
}

// ---------------------------------------------------------------------------
// Language + project-root detection.
// ---------------------------------------------------------------------------

fn language_from_file(file: &str) -> Option<&'static str> {
    let ext = Path::new(file)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))?;
    SERVERS
        .iter()
        .find(|(_, c)| c.file_extensions.contains(&ext.as_str()))
        .map(|(l, _)| *l)
}

fn find_project_root(file: &str, language: &str) -> String {
    let path = std::fs::canonicalize(file).unwrap_or_else(|_| PathBuf::from(file));
    if language == "go" {
        if let Some(root) = find_go_workspace_root(&path) {
            return root.to_string_lossy().to_string();
        }
        return parent_dir(&path);
    }
    let markers = server_config(language).map(|c| c.root_markers).unwrap_or(&[]);
    for parent in path.ancestors().skip(1) {
        for marker in markers {
            if parent.join(marker).is_file() {
                return parent.to_string_lossy().to_string();
            }
        }
    }
    parent_dir(&path)
}

fn parent_dir(path: &Path) -> String {
    path.parent()
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn find_go_workspace_root(start: &Path) -> Option<PathBuf> {
    let base = if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    };
    for dir in base.ancestors() {
        if dir.join("go.work").is_file() {
            return Some(dir.to_path_buf());
        }
    }
    for dir in base.ancestors() {
        if dir.join("go.mod").is_file() {
            return Some(dir.to_path_buf());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Install / start / lifecycle.
// ---------------------------------------------------------------------------

async fn check_installed(config: &ServerConfig) -> bool {
    let mut cmd = Command::new(config.check_cmd[0]);
    cmd.args(&config.check_cmd[1..]);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.status().await {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

async fn install(config: &ServerConfig) -> bool {
    if which(config.install_cmd[0]).is_none() {
        return false;
    }
    let mut cmd = Command::new(config.install_cmd[0]);
    cmd.args(&config.install_cmd[1..]);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    matches!(cmd.status().await, Ok(status) if status.success())
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn ensure_running(
    language: &str,
    root: &str,
    config: &'static ServerConfig,
) -> Option<Arc<LspServer>> {
    let key = format!("{}:{}", language, root);

    {
        let registry = REGISTRY.lock().await;
        if let Some(server) = registry.get(&key) {
            if is_alive(server).await {
                return Some(server.clone());
            }
        }
    }

    let mut registry = REGISTRY.lock().await;
    if let Some(server) = registry.get(&key) {
        if is_alive(server).await {
            return Some(server.clone());
        }
        registry.remove(&key);
    }

    if !check_installed(config).await && !install(config).await {
        return None;
    }

    let server = start_server(language, root, config).await?;
    if !initialize(&server, root).await {
        return None;
    }
    let server = Arc::new(server);
    registry.insert(key, server.clone());
    Some(server)
}

async fn is_alive(server: &LspServer) -> bool {
    let mut io = server.io.lock().await;
    matches!(io.child.try_wait(), Ok(None))
}

async fn start_server(language: &str, root: &str, config: &ServerConfig) -> Option<LspServer> {
    let mut cmd = Command::new(config.start_cmd[0]);
    cmd.args(&config.start_cmd[1..]);
    cmd.current_dir(root);
    for (k, v) in config.env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().ok()?;
    let stdin = child.stdin.take()?;
    let stdout = BufReader::new(child.stdout.take()?);
    Some(LspServer {
        language: language.to_string(),
        root: root.to_string(),
        io: Mutex::new(ChildIo { child, stdin, stdout }),
        next_id: AtomicI64::new(0),
    })
}

async fn initialize(server: &LspServer, root: &str) -> bool {
    let root_uri = path_to_uri(root);
    let root_name = Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let params = json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "rootPath": root,
        "capabilities": {
            "workspace": { "workspaceFolders": true, "applyEdit": true },
            "textDocument": {
                "synchronization": { "dynamicRegistration": true, "didSave": true },
                "completion": { "completionItem": { "snippetSupport": true } },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "definition": { "dynamicRegistration": true, "linkSupport": true },
                "references": { "dynamicRegistration": true },
                "rename": { "dynamicRegistration": true, "prepareSupport": true }
            }
        },
        "workspaceFolders": [{ "uri": root_uri, "name": root_name }]
    });
    let request = json!({
        "jsonrpc": "2.0",
        "id": server.next_id(),
        "method": "initialize",
        "params": params,
    });
    let response = send_request(server, request, Duration::from_secs(60)).await;
    let ok = response
        .as_ref()
        .map(|r| r.get("error").is_none())
        .unwrap_or(false);
    if !ok {
        return false;
    }
    send_notification(server, "initialized", json!({})).await;
    true
}

// ---------------------------------------------------------------------------
// JSON-RPC transport (Content-Length framing over stdio).
// ---------------------------------------------------------------------------

async fn send_request(server: &LspServer, request: Value, timeout_dur: Duration) -> Option<Value> {
    let request_id = request.get("id").cloned();
    let mut io = server.io.lock().await;
    if write_message(&mut io.stdin, &request).await.is_err() {
        return None;
    }
    let deadline = Instant::now() + timeout_dur;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match read_message(&mut io.stdout, remaining).await {
            Some(message) => {
                if message.get("id") == request_id.as_ref() {
                    return Some(message);
                }
                // Notification/log or a response to another request — keep reading.
            }
            None => {
                if !matches!(io.child.try_wait(), Ok(None)) {
                    return None;
                }
            }
        }
    }
}

async fn send_notification(server: &LspServer, method: &str, params: Value) -> bool {
    let notification = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let mut io = server.io.lock().await;
    write_message(&mut io.stdin, &notification).await.is_ok()
}

async fn write_message(stdin: &mut ChildStdin, message: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).await?;
    stdin.write_all(&body).await?;
    stdin.flush().await
}

async fn read_message(stdout: &mut BufReader<ChildStdout>, timeout_dur: Duration) -> Option<Value> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let read = match timeout(timeout_dur, stdout.read_line(&mut line)).await {
            Ok(Ok(n)) => n,
            _ => return None,
        };
        if read == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length == 0 {
        return None;
    }
    let mut buf = vec![0u8; content_length];
    match timeout(timeout_dur, stdout.read_exact(&mut buf)).await {
        Ok(Ok(_)) => serde_json::from_slice(&buf).ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// URI <-> path.
// ---------------------------------------------------------------------------

fn path_to_uri(path: &str) -> String {
    let abs = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string();
    let mut encoded = String::from("file://");
    for ch in abs.chars() {
        match ch {
            '/' | 'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | ':' => {
                encoded.push(ch)
            }
            _ => {
                let mut bytes = [0u8; 4];
                for b in ch.encode_utf8(&mut bytes).as_bytes() {
                    encoded.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    encoded
}

fn uri_to_path(uri: &str) -> String {
    let stripped = uri.strip_prefix("file://").unwrap_or(uri);
    let decoded = percent_decode(stripped);
    // Windows drive path guard (/C:/...) — harmless on unix.
    let bytes = decoded.as_bytes();
    if decoded.starts_with('/') && bytes.len() >= 3 && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
        return decoded[1..].to_string();
    }
    decoded
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// ---------------------------------------------------------------------------
// Document sync + result parsing.
// ---------------------------------------------------------------------------

async fn open_document(server: &LspServer, file: &str) -> bool {
    let abs = std::fs::canonicalize(file)
        .unwrap_or_else(|_| PathBuf::from(file))
        .to_string_lossy()
        .to_string();
    let content = match std::fs::read_to_string(&abs) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let language_id = language_id(&server.language, file);
    let params = json!({
        "textDocument": {
            "uri": path_to_uri(&abs),
            "languageId": language_id,
            "version": 1,
            "text": content,
        }
    });
    send_notification(server, "textDocument/didOpen", params).await
}

fn language_id(language: &str, file: &str) -> String {
    if language == "typescript" {
        let ext = Path::new(file)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        return match ext.as_str() {
            ".tsx" => "typescriptreact".to_string(),
            ".jsx" => "javascriptreact".to_string(),
            ".js" | ".mjs" | ".cjs" => "javascript".to_string(),
            _ => "typescript".to_string(),
        };
    }
    language.to_string()
}

fn parse_location(location: &Value) -> Value {
    let uri = location.get("uri").and_then(|v| v.as_str()).unwrap_or("");
    let file = uri_to_path(uri);
    let range = location.get("range").cloned().unwrap_or(json!({}));
    let start_line = range["start"]["line"].as_i64().unwrap_or(0) + 1;
    let start_char = range["start"]["character"].as_i64().unwrap_or(0);
    let end_line = range["end"]["line"].as_i64().unwrap_or(0) + 1;
    let end_char = range["end"]["character"].as_i64().unwrap_or(0);
    json!({
        "file": file,
        "start": { "line": start_line, "character": start_char },
        "end": { "line": end_line, "character": end_char },
    })
}

// ---------------------------------------------------------------------------
// UTF-16 aware offset math + text-edit rendering.
// ---------------------------------------------------------------------------

fn split_keepends(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for ch in content.chars() {
        current.push(ch);
        if ch == '\n' {
            lines.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn utf16_len(text: &str) -> i64 {
    text.chars().map(|c| if c as u32 > 0xFFFF { 2 } else { 1 }).sum()
}

fn utf16_index_to_char_index(text: &str, utf16_index: i64) -> usize {
    if utf16_index <= 0 {
        return 0;
    }
    let mut units: i64 = 0;
    for (idx, ch) in text.chars().enumerate() {
        units += if ch as u32 > 0xFFFF { 2 } else { 1 };
        if units >= utf16_index {
            return idx + 1;
        }
    }
    text.chars().count()
}

fn position_to_offset(lines: &[String], line: i64, character: i64) -> usize {
    if line < 0 {
        return 0;
    }
    let line = line as usize;
    if line >= lines.len() {
        return lines.iter().map(|l| l.chars().count()).sum();
    }
    let prefix: usize = lines[..line].iter().map(|l| l.chars().count()).sum();
    prefix + utf16_index_to_char_index(&lines[line], character)
}

fn render_text_edits(content: &str, edits: &[Value]) -> String {
    let lines = split_keepends(content);
    let mut normalized: Vec<(i64, i64, usize, usize, String)> = Vec::new();
    for edit in edits {
        let start_line = edit["range"]["start"]["line"].as_i64().unwrap_or(0);
        let start_char = edit["range"]["start"]["character"].as_i64().unwrap_or(0);
        let end_line = edit["range"]["end"]["line"].as_i64().unwrap_or(0);
        let end_char = edit["range"]["end"]["character"].as_i64().unwrap_or(0);
        let start_offset = position_to_offset(&lines, start_line, start_char);
        let end_offset = position_to_offset(&lines, end_line, end_char);
        let new_text = edit["newText"].as_str().unwrap_or("").to_string();
        normalized.push((start_line, start_char, start_offset, end_offset, new_text));
    }
    // Apply last-to-first so earlier offsets stay valid.
    normalized.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut chars: Vec<char> = content.chars().collect();
    for (_, _, start_offset, end_offset, new_text) in normalized {
        let start = start_offset.min(chars.len());
        let end = end_offset.min(chars.len()).max(start);
        let replacement: Vec<char> = new_text.chars().collect();
        chars.splice(start..end, replacement);
    }
    chars.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Workspace edit collection + application.
// ---------------------------------------------------------------------------

fn workspace_edit_files(edit: &Value) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    if let Some(changes) = edit.get("documentChanges").and_then(|v| v.as_array()) {
        for change in changes {
            if let Some(kind) = change.get("kind").and_then(|v| v.as_str()) {
                match kind {
                    "rename" => {
                        files.push(uri_to_path(change["oldUri"].as_str().unwrap_or("")));
                        files.push(uri_to_path(change["newUri"].as_str().unwrap_or("")));
                    }
                    "create" | "delete" => {
                        files.push(uri_to_path(change["uri"].as_str().unwrap_or("")));
                    }
                    _ => {}
                }
            } else if let Some(uri) = change["textDocument"]["uri"].as_str() {
                files.push(uri_to_path(uri));
            }
        }
    } else if let Some(changes) = edit.get("changes").and_then(|v| v.as_object()) {
        for uri in changes.keys() {
            files.push(uri_to_path(uri));
        }
    }
    let mut set: Vec<String> = files.into_iter().filter(|f| !f.is_empty()).collect();
    set.sort();
    set.dedup();
    set
}

fn is_within_root(path: &str, root: &str) -> bool {
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let r = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    p.starts_with(&r)
}

/// Normalize a workspace edit into an ordered list of `documentChanges`.
fn edit_changes(edit: &Value) -> Vec<Value> {
    if let Some(changes) = edit.get("documentChanges").and_then(|v| v.as_array()) {
        return changes.clone();
    }
    if let Some(changes) = edit.get("changes").and_then(|v| v.as_object()) {
        return changes
            .iter()
            .map(|(uri, edits)| json!({ "textDocument": { "uri": uri }, "edits": edits }))
            .collect();
    }
    Vec::new()
}

/// Apply a workspace edit to disk with backup + rollback on any failure.
/// Returns `(applied_files, errors)`.
fn apply_workspace_edit(edit: &Value, root: &str) -> (Vec<String>, Vec<String>) {
    let changes = edit_changes(edit);
    if changes.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let backup_dir = match tempfile::Builder::new().prefix("hanzo-lsp-").tempdir_in(root) {
        Ok(d) => d,
        Err(e) => return (Vec::new(), vec![e.to_string()]),
    };

    let mut backups: HashMap<String, PathBuf> = HashMap::new();
    let mut created: Vec<String> = Vec::new();
    let mut applied: Vec<String> = Vec::new();

    let mut backup = |path: &str| -> Result<(), String> {
        if backups.contains_key(path) || !Path::new(path).exists() {
            return Ok(());
        }
        let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
        let rel = Path::new(path)
            .strip_prefix(&canon_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| {
                Path::new(path)
                    .file_name()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("backup"))
            });
        let dst = backup_dir.path().join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(path, &dst).map_err(|e| e.to_string())?;
        backups.insert(path.to_string(), dst);
        Ok(())
    };

    let result = (|| -> Result<(), String> {
        // Preflight: back up every file the edit touches.
        for change in &changes {
            if let Some(kind) = change.get("kind").and_then(|v| v.as_str()) {
                match kind {
                    "rename" => {
                        let old = uri_to_path(change["oldUri"].as_str().unwrap_or(""));
                        let new = uri_to_path(change["newUri"].as_str().unwrap_or(""));
                        if !is_within_root(&old, root) || !is_within_root(&new, root) {
                            return Err(format!("rename outside workspace root: {} -> {}", old, new));
                        }
                        backup(&old)?;
                        backup(&new)?;
                    }
                    "create" | "delete" => {
                        let path = uri_to_path(change["uri"].as_str().unwrap_or(""));
                        if !is_within_root(&path, root) {
                            return Err(format!("{} outside workspace root: {}", kind, path));
                        }
                        backup(&path)?;
                    }
                    _ => {}
                }
            } else if let Some(uri) = change["textDocument"]["uri"].as_str() {
                let path = uri_to_path(uri);
                if !is_within_root(&path, root) {
                    return Err(format!("edit outside workspace root: {}", path));
                }
                backup(&path)?;
            }
        }

        // Apply in order.
        for change in &changes {
            if let Some(kind) = change.get("kind").and_then(|v| v.as_str()) {
                match kind {
                    "rename" => {
                        let old = uri_to_path(change["oldUri"].as_str().unwrap_or(""));
                        let new = uri_to_path(change["newUri"].as_str().unwrap_or(""));
                        let options = &change["options"];
                        if Path::new(&new).exists() {
                            if options["ignoreIfExists"].as_bool().unwrap_or(false) {
                                continue;
                            }
                            if !options["overwrite"].as_bool().unwrap_or(false) {
                                return Err(format!("rename target exists: {}", new));
                            }
                        }
                        if let Some(parent) = Path::new(&new).parent() {
                            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                        }
                        std::fs::rename(&old, &new).map_err(|e| e.to_string())?;
                        applied.push(new);
                    }
                    "create" => {
                        let path = uri_to_path(change["uri"].as_str().unwrap_or(""));
                        let options = &change["options"];
                        if Path::new(&path).exists() {
                            if options["ignoreIfExists"].as_bool().unwrap_or(false) {
                                continue;
                            }
                            if !options["overwrite"].as_bool().unwrap_or(false) {
                                return Err(format!("create target exists: {}", path));
                            }
                        }
                        if let Some(parent) = Path::new(&path).parent() {
                            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                        }
                        std::fs::write(&path, change["content"].as_str().unwrap_or(""))
                            .map_err(|e| e.to_string())?;
                        created.push(path.clone());
                        applied.push(path);
                    }
                    "delete" => {
                        let path = uri_to_path(change["uri"].as_str().unwrap_or(""));
                        let options = &change["options"];
                        if !Path::new(&path).exists() {
                            if options["ignoreIfNotExists"].as_bool().unwrap_or(false) {
                                continue;
                            }
                            return Err(format!("delete target missing: {}", path));
                        }
                        if Path::new(&path).is_dir() {
                            if !options["recursive"].as_bool().unwrap_or(false) {
                                return Err(format!("delete target is directory: {}", path));
                            }
                            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                        } else {
                            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                        }
                        applied.push(path);
                    }
                    other => return Err(format!("unsupported documentChange: {}", other)),
                }
            } else if let (Some(uri), Some(edits)) = (
                change["textDocument"]["uri"].as_str(),
                change["edits"].as_array(),
            ) {
                let path = uri_to_path(uri);
                let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let updated = render_text_edits(&content, edits);
                let tmp = format!("{}.hanzo_tmp_{}", path, unique_suffix());
                std::fs::write(&tmp, updated).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
                applied.push(path);
            } else {
                return Err("unsupported documentChange".to_string());
            }
        }
        Ok(())
    })();
    drop(backup);

    match result {
        Ok(()) => (applied, Vec::new()),
        Err(err) => {
            // Rollback: restore backups, remove created files not backed up.
            for (path, backup_path) in &backups {
                if let Some(parent) = Path::new(path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::copy(backup_path, path);
            }
            for path in &created {
                if !backups.contains_key(path) {
                    if Path::new(path).is_dir() {
                        let _ = std::fs::remove_dir_all(path);
                    } else {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            (Vec::new(), vec![err])
        }
    }
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

fn file_range_for_code_action(file: &str) -> Value {
    let content = std::fs::read_to_string(file).unwrap_or_default();
    if content.is_empty() {
        return json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } });
    }
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } });
    }
    let last = lines.len() - 1;
    let end_char = utf16_len(lines[last]);
    json!({
        "start": { "line": 0, "character": 0 },
        "end": { "line": last, "character": end_char },
    })
}

// ---------------------------------------------------------------------------
// Action execution.
// ---------------------------------------------------------------------------

async fn execute_action(
    server: &LspServer,
    _language: &str,
    action: &str,
    file: &str,
    args: &LspArgs,
) -> Value {
    let abs = std::fs::canonicalize(file)
        .unwrap_or_else(|_| PathBuf::from(file))
        .to_string_lossy()
        .to_string();
    let uri = path_to_uri(&abs);
    open_document(server, file).await;

    let position = json!({
        "line": args.line.map(|l| l - 1).unwrap_or(0),
        "character": args.character.unwrap_or(0),
    });

    match action {
        "definition" => {
            let request = rpc(server, "textDocument/definition", json!({
                "textDocument": { "uri": uri }, "position": position,
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    let result = &resp["result"];
                    if result.is_null() {
                        json!({ "action": "definition", "file": file, "result": null, "message": "No definition found" })
                    } else if let Some(list) = result.as_array() {
                        json!({ "action": "definition", "file": file,
                            "definitions": list.iter().map(parse_location).collect::<Vec<_>>() })
                    } else {
                        json!({ "action": "definition", "file": file, "definition": parse_location(result) })
                    }
                }
                other => err_result("definition", file, other.as_ref()),
            }
        }

        "references" => {
            let request = rpc(server, "textDocument/references", json!({
                "textDocument": { "uri": uri },
                "position": position,
                "context": { "includeDeclaration": true },
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    let refs: Vec<Value> = resp["result"]
                        .as_array()
                        .map(|l| l.iter().map(parse_location).collect())
                        .unwrap_or_default();
                    let count = refs.len();
                    json!({ "action": "references", "file": file, "references": refs, "count": count })
                }
                other => err_result("references", file, other.as_ref()),
            }
        }

        "rename" => {
            let new_name = match args.new_name.as_ref().filter(|n| !n.is_empty()) {
                Some(n) => n,
                None => return json!({ "action": "rename", "error": "new_name is required for rename action" }),
            };
            let request = rpc(server, "textDocument/rename", json!({
                "textDocument": { "uri": uri },
                "position": position,
                "newName": new_name,
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    let result = &resp["result"];
                    if result.is_null() {
                        return json!({ "action": "rename", "file": file, "error": "Rename not possible at this location" });
                    }
                    let mut changes = serde_json::Map::new();
                    if let Some(map) = result.get("changes").and_then(|v| v.as_object()) {
                        for (uri, edits) in map {
                            let path = uri_to_path(uri);
                            let rendered: Vec<Value> = edits
                                .as_array()
                                .map(|es| es.iter().map(|e| json!({
                                    "range": parse_location(&json!({ "uri": uri, "range": e["range"] })),
                                    "newText": e["newText"],
                                })).collect())
                                .unwrap_or_default();
                            changes.insert(path, json!(rendered));
                        }
                    }
                    let touched = workspace_edit_files(result);
                    let files_affected = changes.len();
                    let mut payload = json!({
                        "action": "rename",
                        "file": file,
                        "new_name": new_name,
                        "changes": changes,
                        "files_affected": files_affected,
                        "touched_files": touched,
                    });
                    if args.apply_edits {
                        let (applied, errors) = apply_workspace_edit(result, &server.root);
                        payload["applied_files"] = json!(applied);
                        if !errors.is_empty() {
                            payload["apply_errors"] = json!(errors);
                        }
                    }
                    payload
                }
                other => err_result("rename", file, other.as_ref()),
            }
        }

        "hover" => {
            let request = rpc(server, "textDocument/hover", json!({
                "textDocument": { "uri": uri }, "position": position,
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    let result = &resp["result"];
                    if result.is_null() {
                        return json!({ "action": "hover", "file": file, "result": null, "message": "No hover info" });
                    }
                    let hover_text = hover_contents(&result["contents"]);
                    json!({
                        "action": "hover",
                        "file": file,
                        "position": { "line": args.line, "character": args.character },
                        "contents": hover_text,
                    })
                }
                other => err_result("hover", file, other.as_ref()),
            }
        }

        "completion" => {
            let request = rpc(server, "textDocument/completion", json!({
                "textDocument": { "uri": uri }, "position": position,
            }));
            match send_request(server, request, Duration::from_secs(10)).await {
                Some(resp) if resp.get("result").is_some() => {
                    let result = &resp["result"];
                    if result.is_null() {
                        return json!({ "action": "completion", "file": file, "completions": [], "count": 0 });
                    }
                    let items = result
                        .as_array()
                        .cloned()
                        .or_else(|| result.get("items").and_then(|v| v.as_array()).cloned())
                        .unwrap_or_default();
                    let completions: Vec<Value> = items
                        .iter()
                        .take(50)
                        .map(|item| json!({
                            "label": item.get("label").cloned().unwrap_or(json!("")),
                            "kind": item.get("kind").cloned().unwrap_or(json!(0)),
                            "detail": item.get("detail").cloned().unwrap_or(json!("")),
                        }))
                        .collect();
                    let count = completions.len();
                    json!({
                        "action": "completion",
                        "file": file,
                        "position": { "line": args.line, "character": args.character },
                        "completions": completions,
                        "count": count,
                    })
                }
                other => err_result("completion", file, other.as_ref()),
            }
        }

        "code_action" => {
            let action_range = args.range.clone().unwrap_or_else(|| file_range_for_code_action(&abs));
            let mut context = serde_json::Map::new();
            if let Some(only) = &args.only {
                context.insert("only".to_string(), json!(only));
            }
            let request = rpc(server, "textDocument/codeAction", json!({
                "textDocument": { "uri": uri },
                "range": action_range,
                "context": context,
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    collect_code_actions(resp["result"].as_array(), "code_action", file, args.apply_edits, &server.root, None)
                }
                other => err_result("code_action", file, other.as_ref()),
            }
        }

        "organize_imports" => {
            let file_range = file_range_for_code_action(&abs);
            let request = rpc(server, "textDocument/codeAction", json!({
                "textDocument": { "uri": uri },
                "range": file_range,
                "context": { "only": ["source.organizeImports"] },
            }));
            match send_request(server, request, Duration::from_secs(30)).await {
                Some(resp) if resp.get("result").is_some() => {
                    collect_code_actions(resp["result"].as_array(), "organize_imports", file, args.apply_edits, &server.root, Some("source.organizeImports"))
                }
                other => err_result("organize_imports", file, other.as_ref()),
            }
        }

        "diagnostics" => json!({
            "action": "diagnostics",
            "file": file,
            "note": "Diagnostics are push-based; use language-specific tools (go vet, pylint, etc.) for on-demand checking",
        }),

        other => json!({ "error": format!("Unknown action: {}", other) }),
    }
}

fn rpc(server: &LspServer, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": server.next_id(), "method": method, "params": params })
}

fn err_result(action: &str, file: &str, response: Option<&Value>) -> Value {
    let error = response
        .and_then(|r| r.get("error").cloned())
        .unwrap_or(json!("No response"));
    json!({ "action": action, "file": file, "error": error })
}

fn hover_contents(contents: &Value) -> String {
    if let Some(map) = contents.as_object() {
        map.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| contents.to_string())
    } else if let Some(list) = contents.as_array() {
        list.iter()
            .map(|c| {
                c.get("value")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| c.as_str().map(|s| s.to_string()).unwrap_or_else(|| c.to_string()))
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        contents.as_str().map(|s| s.to_string()).unwrap_or_else(|| contents.to_string())
    }
}

fn collect_code_actions(
    actions: Option<&Vec<Value>>,
    action: &str,
    file: &str,
    apply_edits: bool,
    root: &str,
    kind_filter: Option<&str>,
) -> Value {
    let actions = actions.cloned().unwrap_or_default();
    let mut edits_applied: Vec<String> = Vec::new();
    let mut apply_errors: Vec<String> = Vec::new();
    let mut touched: Vec<String> = Vec::new();
    let mut commands: Vec<Value> = Vec::new();
    let mut edits_seen = 0;

    for item in &actions {
        if let Some(want) = kind_filter {
            if let Some(kind) = item.get("kind").and_then(|v| v.as_str()) {
                if kind != want {
                    continue;
                }
            }
        }
        if let Some(edit) = item.get("edit") {
            edits_seen += 1;
            touched.extend(workspace_edit_files(edit));
            if apply_edits {
                let (applied, errors) = apply_workspace_edit(edit, root);
                edits_applied.extend(applied);
                apply_errors.extend(errors);
            }
        }
        if kind_filter.is_none() {
            if let Some(command) = item.get("command") {
                commands.push(command.clone());
            }
        }
    }

    touched.sort();
    touched.dedup();

    let mut payload = json!({
        "action": action,
        "file": file,
        "edits_found": edits_seen,
        "touched_files": touched,
    });
    if kind_filter.is_none() {
        payload["commands"] = json!(commands);
    }
    if apply_edits {
        payload["applied_files"] = json!(edits_applied);
        if !apply_errors.is_empty() {
            payload["apply_errors"] = json!(apply_errors);
        }
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_shape() {
        let s = LspTool::schema();
        assert_eq!(s["name"], "lsp");
        assert_eq!(s["inputSchema"]["required"][0], "action");
        assert_eq!(s["inputSchema"]["required"][1], "file");
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(LspTool::new().name(), "lsp");
    }

    #[test]
    fn detects_language_by_extension() {
        assert_eq!(language_from_file("main.go"), Some("go"));
        assert_eq!(language_from_file("app.py"), Some("python"));
        assert_eq!(language_from_file("lib.rs"), Some("rust"));
        assert_eq!(language_from_file("index.tsx"), Some("typescript"));
        assert_eq!(language_from_file("notes.txt"), None);
    }

    #[test]
    fn language_id_maps_typescript_variants() {
        assert_eq!(language_id("typescript", "a.tsx"), "typescriptreact");
        assert_eq!(language_id("typescript", "a.jsx"), "javascriptreact");
        assert_eq!(language_id("typescript", "a.js"), "javascript");
        assert_eq!(language_id("typescript", "a.ts"), "typescript");
        assert_eq!(language_id("rust", "a.rs"), "rust");
    }

    #[test]
    fn uri_path_round_trip() {
        let uri = path_to_uri("/tmp/some dir/file.rs");
        assert!(uri.starts_with("file://"));
        assert!(uri.contains("%20"));
        assert_eq!(uri_to_path(&uri), "/tmp/some dir/file.rs");
    }

    #[test]
    fn parse_location_is_one_based_lines() {
        let loc = json!({
            "uri": "file:///tmp/x.rs",
            "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 2, "character": 1 } }
        });
        let parsed = parse_location(&loc);
        assert_eq!(parsed["file"], "/tmp/x.rs");
        assert_eq!(parsed["start"]["line"], 1);
        assert_eq!(parsed["start"]["character"], 4);
        assert_eq!(parsed["end"]["line"], 3);
    }

    #[test]
    fn renders_text_edits_last_to_first() {
        let content = "let a = 1;\nlet b = 2;\n";
        let edits = vec![
            json!({ "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 0, "character": 5 } }, "newText": "x" }),
            json!({ "range": { "start": { "line": 1, "character": 4 }, "end": { "line": 1, "character": 5 } }, "newText": "y" }),
        ];
        let out = render_text_edits(content, &edits);
        assert_eq!(out, "let x = 1;\nlet y = 2;\n");
    }

    #[test]
    fn hover_contents_extracts_markup() {
        assert_eq!(hover_contents(&json!({ "kind": "markdown", "value": "docs" })), "docs");
        assert_eq!(hover_contents(&json!(["a", "b"])), "a\nb");
        assert_eq!(hover_contents(&json!("plain")), "plain");
    }

    #[tokio::test]
    async fn unsupported_file_reports_supported_languages() {
        let out = run(&HanzoApi::from_env(), LspArgs {
            action: Some("definition".into()),
            file: Some("notes.txt".into()),
            ..Default::default()
        })
        .await;
        assert!(out["error"].as_str().unwrap().contains("Unsupported file type"));
        assert!(out["supported_languages"].as_array().unwrap().contains(&json!("go")));
    }

    #[tokio::test]
    async fn invalid_action_is_rejected() {
        let out = run(&HanzoApi::from_env(), LspArgs {
            action: Some("frobnicate".into()),
            file: Some("main.go".into()),
            ..Default::default()
        })
        .await;
        assert!(out["error"].as_str().unwrap().contains("Invalid action"));
    }

    #[tokio::test]
    async fn neither_file_nor_repo_is_rejected() {
        let out = run(&HanzoApi::from_env(), LspArgs {
            action: Some("definition".into()),
            ..Default::default()
        })
        .await;
        assert!(out["error"].as_str().unwrap().starts_with("file is required"));
    }

    #[test]
    fn cloud_ops_map_every_cloud_action() {
        assert_eq!(cloud_op("hover"), Some(("hover", None)));
        assert_eq!(cloud_op("definition"), Some(("locate", Some("definition"))));
        assert_eq!(cloud_op("references"), Some(("locate", Some("reference"))));
        assert_eq!(cloud_op("type"), Some(("locate", Some("type"))));
        assert_eq!(cloud_op("implementation"), Some(("locate", Some("implementation"))));
        assert_eq!(cloud_op("symbols"), Some(("symbols", None)));
        assert_eq!(cloud_op("diagnostics"), Some(("diagnostics", None)));
        assert_eq!(cloud_op("completion"), Some(("complete", None)));
        for action in ["rename", "code_action", "organize_imports", "status"] {
            assert!(cloud_op(action).is_none(), "{action} needs a working tree");
        }
    }

    /// Every action the schema advertises is served by one plane or the other.
    #[test]
    fn advertised_actions_are_served() {
        let schema = LspTool::schema();
        let advertised = schema["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum")
            .iter()
            .map(|a| a.as_str().expect("string").to_string())
            .collect::<Vec<_>>();
        for action in &advertised {
            assert!(
                LOCAL_ACTIONS.contains(&action.as_str()) || cloud_op(action).is_some(),
                "{action} is advertised but no plane answers it"
            );
        }
        for action in LOCAL_ACTIONS.iter().copied().chain(cloud_actions()) {
            assert!(advertised.iter().any(|a| a == action), "{action} is served but not advertised");
        }
    }

    #[tokio::test]
    async fn a_local_only_action_with_repo_says_so_without_calling_out() {
        let out = run(&HanzoApi::from_env(), LspArgs {
            action: Some("rename".into()),
            file: Some("main.go".into()),
            repo: Some("hanzoai/mcp".into()),
            new_name: Some("x".into()),
            ..Default::default()
        })
        .await;
        assert!(out["error"].as_str().unwrap().contains("needs a working tree"));
        assert_eq!(out["repo"], "hanzoai/mcp");
    }

    #[tokio::test]
    async fn a_cloud_only_action_without_repo_says_so() {
        let out = run(&HanzoApi::from_env(), LspArgs {
            action: Some("symbols".into()),
            file: Some("main.go".into()),
            ..Default::default()
        })
        .await;
        assert!(out["error"].as_str().unwrap().contains("pass `repo`"));
    }
}
