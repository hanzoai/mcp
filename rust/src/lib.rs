#![recursion_limit = "256"]
//! Hanzo MCP Server - Rust implementation (HIP-0300)
//!
//! Canonical 19-tool orthogonal HIP-0300 surface ("one and one way to do everything"),
//! mirrored 1-to-1 across Rust (`hanzo-mcp`), TypeScript (`@hanzo/mcp`), and Python (`hanzo-mcp`).

pub mod catalog;
pub mod brain;
pub mod config;
pub mod context;
pub mod ffi;
pub mod hanzo_api;
pub mod server;
pub mod protocol;
pub mod tools;
pub mod search;
pub mod native;
pub mod zap;

/// The in-process search engine behind `fs search_text` and `code search_symbol`, which Dev
/// links directly: a call, not an MCP hop.
pub use hanzo_trigram as trigram;
/// Kai Actions: typed, verified operations run without a model call (the `kai` tool's executor).
pub use hanzo_actions as actions;
pub use config::Config;
pub use context::Ctx;
pub use server::MCPServer;
pub use tools::{
    ExecTool, FsTool, PlanTool, ThinkTool, MemoryTool,
    ComputerTool, BrowserTool, ModeTool,
    CodeTool, GitTool, FetchTool, WorkspaceTool, TasksTool, HanzoTool,
    list_tools, parity_status,
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

/// MCP Tool trait that all tools must implement
#[async_trait::async_trait]
pub trait MCPTool: Send + Sync {
    /// Get the tool's name
    fn name(&self) -> &str;

    /// Get the tool's description
    fn description(&self) -> &str;

    /// Get the tool's parameters schema
    fn parameters(&self) -> serde_json::Value;

    /// Execute the tool with given parameters
    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult>;

    /// Execute with the request's [`Ctx`]. A tool that can report progress, or that leaves work
    /// running a dropped future would not stop, overrides this; the rest need not.
    async fn execute_with(&self, params: serde_json::Value, _ctx: &Ctx) -> Result<ToolResult> {
        self.execute(params).await
    }
}

/// Result from tool execution
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub content: serde_json::Value,
    pub error: Option<String>,
}

impl ToolResult {
    pub fn ok(content: Value) -> Self {
        Self {
            success: true,
            content,
            error: None,
        }
    }

    pub fn err(message: &str) -> Self {
        Self {
            success: false,
            content: json!(null),
            error: Some(message.to_string()),
        }
    }
}

/// Tool wrapper for unified execution
pub struct ToolWrapper<T> {
    pub tool: Arc<RwLock<T>>,
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// The 19 orthogonal canonical HIP-0300 tools advertised by `tools/list`, in fixed order.
/// One and only one tool per domain across Rust, TypeScript, and Python.
pub const CANONICAL_TOOLS: &[&str] = &[
    "fs",
    "exec",
    "code",
    "git",
    "fetch",
    "workspace",
    "browser",
    "computer",
    "ui",
    "kai",
    "think",
    "plan",
    "memory",
    "tasks",
    "tracker",
    "coding",
    "research",
    "skills",
    "hanzo",
];

/// Silent `tools/call` legacy aliases kept for backward compatibility (NEVER advertised in default `tools/list`).
pub const LEGACY_ALIASES: &[&str] = &[
    "npx",
    "uvx",
    "mode",
    "code_search",
    "code_context",
    "code_ask",
    "code_index",
    "web_search",
    "web_read",
    "vision",
    "tracker_boards",
    "tracker_issues",
    "tracker_create",
    "tracker_update",
    "config",
    "llm",
    "agent",
    "lsp",
    "refactor",
    "system",
    "cdp",
    "jq",
    "gimp",
    "vault",
    "connectors",
    "kai_decide",
    "kai_choice",
    "kai_score",
    "kai_noul",
    "kai_compact",
    "kai_tool_select",
    "kai_next_action",
    "kai_command_guard",
    "kai_injection_screen",
    "kai_extract",
    "kai_log_triage",
    "kai_recover",
    "kai_agent_step",
];

/// The tools that read or hand work to Hanzo's models and indexes and change nothing on this
/// machine, listed with `readOnlyHint`.
pub const READ_ONLY: &[&str] = &["think"];

const LEGACY_READ_ONLY: &[&str] = &[
    "kai_decide",
    "kai_choice",
    "kai_score",
    "kai_noul",
    "kai_compact",
    "kai_tool_select",
    "kai_next_action",
    "kai_command_guard",
    "kai_injection_screen",
    "kai_extract",
    "kai_log_triage",
    "kai_recover",
    "kai_agent_step",
    "llm",
    "web_search",
    "web_read",
    "code_search",
    "code_context",
    "code_ask",
    "vision",
];

/// Tool registry for managing all available tools
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn MCPTool>>,
    /// When set, the only tools listed and callable (`--tools`).
    allow: Option<BTreeSet<String>>,
    exec: Arc<RwLock<ExecTool>>,
    fs: Arc<RwLock<FsTool>>,
    code: Arc<RwLock<CodeTool>>,
    git: Arc<RwLock<GitTool>>,
    fetch: Arc<RwLock<FetchTool>>,
    workspace: Arc<RwLock<WorkspaceTool>>,
    plan: Arc<RwLock<PlanTool>>,
    think: Arc<RwLock<ThinkTool>>,
    memory: Arc<RwLock<MemoryTool>>,
    computer: Arc<RwLock<ComputerTool>>,
    browser: Arc<RwLock<BrowserTool>>,
    mode: Arc<RwLock<ModeTool>>,
    tasks: Arc<RwLock<TasksTool>>,
    hanzo: Arc<RwLock<HanzoTool>>,
}

fn discover_projects(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let check = |p: &Path, list: &mut Vec<Value>| {
        if p.join(".git").exists()
            || p.join("Cargo.toml").exists()
            || p.join("package.json").exists()
            || p.join("go.mod").exists()
            || p.join("pyproject.toml").exists()
        {
            list.push(json!({
                "path": p.display().to_string(),
                "git": p.join(".git").exists(),
            }));
        }
    };
    check(root, &mut out);
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') && name != "node_modules" && name != "target" {
                        check(&p, &mut out);
                    }
                }
            }
        }
    }
    out
}

/// The hints of the built-in tools that may change something. A hint is the tool's, not an
/// action's, so the most dangerous action decides: a tool any of whose actions writes or deletes
/// is `destructiveHint`. `openWorldHint` is whether it reaches past this machine.
fn built_in_hints(name: &str) -> Option<Value> {
    let (read_only, destructive, open_world) = match name {
        "exec" | "npx" | "uvx" => (false, true, true),
        "fs" | "code" => (false, true, false),
        "git" | "fetch" | "computer" | "browser" | "hanzo" => (false, true, true),
        "memory" => (false, true, false),
        // Only the server's own session state: a plan, a todo list, a mode.
        "plan" | "tasks" | "mode" => (false, false, false),
        "workspace" => (true, false, false),
        _ => return None,
    };
    let mut hints = json!({ "readOnlyHint": read_only, "openWorldHint": open_world });
    if !read_only {
        hints["destructiveHint"] = json!(destructive);
        hints["idempotentHint"] = json!(false);
    }
    Some(hints)
}

/// The name a client shows a person for a built-in tool.
fn built_in_title(name: &str) -> Option<&'static str> {
    Some(match name {
        "exec" => "Run command",
        "fs" => "Files",
        "code" => "Code intelligence",
        "git" => "Git",
        "fetch" => "Fetch URL",
        "workspace" => "Workspace info",
        "plan" => "Plan",
        "think" => "Think",
        "memory" => "Memory",
        "computer" => "Computer control",
        "browser" => "Browser",
        "mode" => "Mode",
        "tasks" => "Todo list",
        "hanzo" => "Hanzo Cloud",
        "npx" => "Run npx package",
        "uvx" => "Run uvx package",
        _ => return None,
    })
}

impl ToolRegistry {
    pub fn new() -> Self {
        let mut reg = Self {
            tools: HashMap::new(),
            allow: None,
            exec: Arc::new(RwLock::new(ExecTool::new())),
            fs: Arc::new(RwLock::new(FsTool::new())),
            code: Arc::new(RwLock::new(CodeTool::new())),
            git: Arc::new(RwLock::new(GitTool::new())),
            fetch: Arc::new(RwLock::new(FetchTool::new())),
            workspace: Arc::new(RwLock::new(WorkspaceTool::new())),
            plan: Arc::new(RwLock::new(PlanTool::new())),
            think: Arc::new(RwLock::new(ThinkTool::new())),
            memory: Arc::new(RwLock::new(MemoryTool::new())),
            computer: Arc::new(RwLock::new(ComputerTool::new())),
            browser: Arc::new(RwLock::new(BrowserTool::new())),
            mode: Arc::new(RwLock::new(ModeTool::new())),
            tasks: Arc::new(RwLock::new(TasksTool::new())),
            hanzo: Arc::new(RwLock::new(HanzoTool::new())),
        };
        reg.register_all_impls();
        reg
    }

    fn register_all_impls(&mut self) {
        // Canonical dyn-trait tools
        self.register(Box::new(tools::UiTool::new()));
        self.register(Box::new(tools::ActionsTool::new()));
        self.register(Box::new(tools::TrackerTool::new()));
        self.register(Box::new(tools::CodingTool::new()));
        self.register(Box::new(tools::ResearchTool::new()));
        self.register(Box::new(tools::SkillsTool::new()));

        // Absorbed sub-tools & silent legacy `tools/call` aliases
        self.register(Box::new(tools::CodeSearchTool::new()));
        self.register(Box::new(tools::CodeContextTool::new()));
        self.register(Box::new(tools::CodeAskTool::new()));
        self.register(Box::new(tools::CodeIndexTool::new()));
        self.register(Box::new(tools::WebSearchTool::new()));
        self.register(Box::new(tools::WebReadTool::new()));
        self.register(Box::new(tools::VisionTool::new()));
        self.register(Box::new(tools::TrackerBoardsTool::new()));
        self.register(Box::new(tools::TrackerIssuesTool::new()));
        self.register(Box::new(tools::TrackerCreateTool::new()));
        self.register(Box::new(tools::TrackerUpdateTool::new()));
        self.register(Box::new(tools::ConfigTool::new()));
        self.register(Box::new(tools::LlmTool::new()));
        self.register(Box::new(tools::KaiDecideTool::new()));
        self.register(Box::new(tools::AgentTool::new()));
        self.register(Box::new(tools::LspTool::new()));
        self.register(Box::new(tools::RefactorTool::new()));
        self.register(Box::new(tools::SystemTool::new()));
        self.register(Box::new(tools::CdpTool::new()));
        self.register(Box::new(tools::JqTool::new()));
        self.register(Box::new(tools::GimpTool::new()));
        self.register(Box::new(tools::VaultTool::new()));
        self.register(Box::new(tools::ConnectorsTool::new()));
    }

    /// The registry with `classifier` asked about every `exec` command before it runs.
    pub fn with_classifier(mut self, classifier: Arc<dyn tools::Classify>) -> Self {
        self.exec = Arc::new(RwLock::new(ExecTool::with_classifier(classifier)));
        self
    }

    pub fn register(&mut self, tool: Box<dyn MCPTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Box<dyn MCPTool>> {
        self.tools.get(name)
    }

    /// Listed tool names (sorted). Default is the 19 canonical HIP-0300 tools, plus any custom
    /// tool registered outside `CANONICAL_TOOLS` and `LEGACY_ALIASES`.
    pub fn list(&self) -> Vec<String> {
        if let Some(allow) = &self.allow {
            return allow.iter().cloned().collect();
        }
        let mut names: Vec<String> = CANONICAL_TOOLS.iter().map(|s| (*s).to_string()).collect();
        for k in self.tools.keys() {
            if !CANONICAL_TOOLS.contains(&k.as_str()) && !LEGACY_ALIASES.contains(&k.as_str()) {
                names.push(k.clone());
            }
        }
        names.sort();
        names.dedup();
        names
    }

    fn allowed(&self, name: &str) -> bool {
        self.allow.as_ref().map_or(true, |allow| allow.contains(name))
    }

    fn known_name(&self, name: &str) -> bool {
        CANONICAL_TOOLS.contains(&name)
            || LEGACY_ALIASES.contains(&name)
            || self.tools.contains_key(name)
    }

    /// Serves only `names`: `tools/list` shows them and nothing else answers.
    pub fn restrict<I, S>(&mut self, names: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut allow = BTreeSet::new();
        for name in names {
            let name = name.as_ref().trim();
            if name.is_empty() {
                continue;
            }
            if !self.known_name(name) {
                return Err(anyhow::anyhow!(
                    "unknown tool {name:?}; this server carries: {}",
                    CANONICAL_TOOLS.join(", ")
                ));
            }
            allow.insert(name.to_string());
        }
        if allow.is_empty() {
            return Err(anyhow::anyhow!("--tools names no tool"));
        }
        self.allow = Some(allow);
        Ok(())
    }

    fn canonical_definition(&self, name: &str) -> Option<Value> {
        match name {
            "fs" => Some(json!({
                "name": "fs",
                "description": tools::FsToolDefinition::new().description,
                "inputSchema": tools::FsToolDefinition::new().input_schema
            })),
            "exec" => Some(json!({
                "name": "exec",
                "description": tools::ExecToolDefinition::new().description,
                "inputSchema": tools::ExecToolDefinition::new().input_schema
            })),
            "code" => Some(tools::CodeToolDefinition::schema()),
            "git" => Some(tools::GitToolDefinition::schema()),
            "fetch" => Some(tools::FetchToolDefinition::schema()),
            "workspace" => Some(tools::WorkspaceToolDefinition::schema()),
            "browser" => Some(json!({
                "name": "browser",
                "description": tools::BrowserToolDefinition::new().description,
                "inputSchema": tools::BrowserToolDefinition::new().input_schema
            })),
            "computer" => Some(json!({
                "name": "computer",
                "description": tools::ComputerToolDefinition::new().description,
                "inputSchema": tools::ComputerToolDefinition::new().input_schema
            })),
            "think" => Some(json!({
                "name": "think",
                "description": tools::ThinkToolDefinition::new().description,
                "inputSchema": tools::ThinkToolDefinition::new().input_schema
            })),
            "plan" => Some(json!({
                "name": "plan",
                "description": tools::PlanToolDefinition::new().description,
                "inputSchema": tools::PlanToolDefinition::new().input_schema
            })),
            "memory" => Some(json!({
                "name": "memory",
                "description": tools::MemoryToolDefinition::new().description,
                "inputSchema": tools::MemoryToolDefinition::new().input_schema
            })),
            "tasks" => Some(tools::TasksToolDefinition::schema()),
            "hanzo" => Some(tools::HanzoToolDefinition::schema()),
            "npx" => Some(tools::runner::definition("npx")),
            "uvx" => Some(tools::runner::definition("uvx")),
            "mode" => Some(json!({
                "name": "mode",
                "description": tools::ModeToolDefinition::new().description,
                "inputSchema": tools::ModeToolDefinition::new().input_schema
            })),
            other => self.tools.get(other).map(|t| {
                json!({
                    "name": t.name(),
                    "description": t.description(),
                    "inputSchema": t.parameters()
                })
            }),
        }
    }

    /// Get tool definitions for MCP `tools/list`.
    /// By default (`--tools` unset), advertises ONLY the 19 canonical HIP-0300 tools in fixed order!
    pub fn get_definitions(&self) -> Vec<Value> {
        let mut definitions = Vec::new();

        if let Some(allow) = &self.allow {
            // Preserve canonical order first, then any explicitly requested legacy/custom names sorted.
            for &name in CANONICAL_TOOLS {
                if allow.contains(name) {
                    if let Some(def) = self.canonical_definition(name) {
                        definitions.push(def);
                    }
                }
            }
            for name in allow {
                if !CANONICAL_TOOLS.contains(&name.as_str()) {
                    if let Some(def) = self.canonical_definition(name) {
                        definitions.push(def);
                    }
                }
            }
        } else {
            for &name in CANONICAL_TOOLS {
                if let Some(def) = self.canonical_definition(name) {
                    definitions.push(def);
                }
            }
            // Include any user-registered custom tools that are not legacy aliases.
            let mut extra: Vec<&Box<dyn MCPTool>> = self
                .tools
                .values()
                .filter(|t| !CANONICAL_TOOLS.contains(&t.name()) && !LEGACY_ALIASES.contains(&t.name()))
                .collect();
            extra.sort_by(|a, b| a.name().cmp(b.name()));
            for tool in extra {
                definitions.push(json!({
                    "name": tool.name(),
                    "description": tool.description(),
                    "inputSchema": tool.parameters()
                }));
            }
        }

        for d in &mut definitions {
            let name = d["name"].as_str().unwrap_or_default().to_string();
            if READ_ONLY.contains(&name.as_str()) || LEGACY_READ_ONLY.contains(&name.as_str()) {
                d["annotations"] = json!({ "readOnlyHint": true, "openWorldHint": true });
            } else if let Some(hints) = built_in_hints(&name) {
                d["annotations"] = hints;
            }
            // `get_mut`, not `d["annotations"]`: indexing would write `"annotations": null` into
            // every tool without hints, and clients reject the whole list over it.
            if let (Some(title), Some(a)) = (
                built_in_title(&name),
                d.get_mut("annotations").and_then(Value::as_object_mut),
            ) {
                a.insert("title".into(), json!(title));
            }
        }
        definitions
    }

    /// Out-of-band host/operator hook: approve a pending `exec` Ask request by its
    /// `approval_request_id` and mint a single-use approval token bound to that exact call.
    pub async fn approve_exec_request(&self, request_id: &str) -> Option<tools::ApprovalToken> {
        self.exec.read().await.token_approver().approve_request(request_id, 300)
    }

    /// Out-of-band token approver handle for the registry's `exec` tool.
    pub async fn exec_token_approver(&self) -> Arc<tools::TokenApprover> {
        self.exec.read().await.token_approver()
    }

    /// Execute a tool by canonical name (including absorbed sub-actions) or silent legacy `tools/call` alias.
    pub async fn execute(&self, name: &str, params: Value) -> Result<ToolResult> {
        self.execute_with(name, params, &Ctx::default()).await
    }

    /// Execute a tool by name with the request's [`Ctx`]: its cancellation and its progress.
    pub async fn execute_with(&self, name: &str, params: Value, ctx: &Ctx) -> Result<ToolResult> {
        if !self.allowed(name) {
            return Ok(ToolResult::err(&format!("Unknown tool: {}", name)));
        }
        let act = params.get("action").and_then(Value::as_str).unwrap_or("");

        match name {
            "exec" => {
                if act == "npx" || act == "uvx" {
                    let args = tools::ExecToolArgs {
                        action: "exec".into(),
                        command: Some(json!(tools::runner::argv(act, &params)?)),
                        cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
                        timeout: Some(tools::runner::BACKGROUND),
                        approve: params.get("approve").and_then(Value::as_bool),
                        approval_token: params.get("approval_token").and_then(Value::as_str).map(String::from),
                        ..Default::default()
                    };
                    let result = self.exec.read().await.execute_with(args, ctx).await?;
                    return Ok(ToolResult::ok(serde_json::from_str(&result)?));
                }
                let args: tools::ExecToolArgs = serde_json::from_value(params)?;
                let result = self.exec.read().await.execute_with(args, ctx).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "fs" => {
                let args: tools::FsToolArgs = serde_json::from_value(params)?;
                let result = self.fs.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "npx" | "uvx" => {
                let args = tools::ExecToolArgs {
                    action: "exec".into(),
                    command: Some(json!(tools::runner::argv(name, &params)?)),
                    cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
                    timeout: Some(tools::runner::BACKGROUND),
                    approve: params.get("approve").and_then(Value::as_bool),
                    approval_token: params.get("approval_token").and_then(Value::as_str).map(String::from),
                    ..Default::default()
                };
                let result = self.exec.read().await.execute_with(args, ctx).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "plan" => {
                let args: tools::PlanToolArgs = serde_json::from_value(params)?;
                let result = self.plan.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "think" => {
                if matches!(act, "llm" | "query" | "models" | "limits" | "feedback") {
                    let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                    let sub = if act == "llm" {
                        p.get("llm_action")
                            .or_else(|| p.get("sub_action"))
                            .and_then(Value::as_str)
                            .unwrap_or("query")
                            .to_string()
                    } else {
                        act.to_string()
                    };
                    p.insert("action".into(), json!(sub));
                    if let Some(t) = self.tools.get("llm") {
                        return t.execute(Value::Object(p)).await;
                    }
                }
                if matches!(act, "dispatch" | "dag" | "swarm")
                    || (act == "agent"
                        && (params.get("cli").is_some()
                            || params.get("agent").is_some()
                            || params.get("agent_action").is_some()
                            || params.get("sub_action").is_some()))
                {
                    if let Some(t) = self.tools.get("agent") {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        if act == "agent" {
                            let sub = p
                                .get("agent_action")
                                .or_else(|| p.get("sub_action"))
                                .and_then(Value::as_str)
                                .unwrap_or("run")
                                .to_string();
                            p.insert("action".into(), json!(sub));
                            if let Some(cli) = p.get("cli").cloned() {
                                p.entry("name").or_insert(cli);
                            }
                        }
                        return t.execute(Value::Object(p)).await;
                    }
                }
                let args: tools::ThinkToolArgs = serde_json::from_value(params)?;
                let result = self.think.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "memory" => {
                let args: tools::MemoryToolArgs = serde_json::from_value(params)?;
                let result = self.memory.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "computer" => {
                if act == "gimp" {
                    if let Some(t) = self.tools.get("gimp") {
                        return t.execute(params).await;
                    }
                }
                let args: tools::ComputerToolArgs = serde_json::from_value(params)?;
                let mut computer = self.computer.write().await;
                let result = computer.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "browser" => {
                if act == "cdp" {
                    if let Some(t) = self.tools.get("cdp") {
                        return t.execute(params).await;
                    }
                }
                let args: tools::BrowserToolArgs = serde_json::from_value(params)?;
                let result = self.browser.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result).unwrap_or(Value::String(result))))
            }
            "mode" => {
                let args: tools::ModeToolArgs = serde_json::from_value(params)?;
                let result = self.mode.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "code" => {
                match act {
                    "diagnostics" => {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        p.insert("action".into(), json!("diagnostics"));
                        if !p.contains_key("file") {
                            if let Some(f) = p.get("uri").or_else(|| p.get("path")).cloned() {
                                p.insert("file".into(), f);
                            }
                        }
                        if let Some(t) = self.tools.get("lsp") {
                            return t.execute(Value::Object(p)).await;
                        }
                    }
                    "lsp" => {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        let sub = p
                            .get("lsp_action")
                            .or_else(|| p.get("sub_action"))
                            .or_else(|| p.get("op"))
                            .and_then(Value::as_str)
                            .unwrap_or("symbols")
                            .to_string();
                        p.insert("action".into(), json!(sub));
                        if !p.contains_key("file") {
                            if let Some(f) = p.get("uri").or_else(|| p.get("path")).cloned() {
                                p.insert("file".into(), f);
                            }
                        }
                        if let Some(t) = self.tools.get("lsp") {
                            return t.execute(Value::Object(p)).await;
                        }
                    }
                    "refactor" => {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        let sub = p
                            .get("refactor_action")
                            .or_else(|| p.get("sub_action"))
                            .or_else(|| p.get("op"))
                            .and_then(Value::as_str)
                            .unwrap_or("references")
                            .to_string();
                        p.insert("action".into(), json!(sub));
                        if let Some(t) = self.tools.get("refactor") {
                            return t.execute(Value::Object(p)).await;
                        }
                    }
                    "jq" => {
                        if let Some(t) = self.tools.get("jq") {
                            return t.execute(params).await;
                        }
                    }
                    "rag_search" => {
                        if let Some(t) = self.tools.get("code_search") {
                            return t.execute(params).await;
                        }
                    }
                    "search" if params.get("repo").is_some() || params.get("repos").is_some() || params.get("cloud").and_then(Value::as_bool) == Some(true) => {
                        if let Some(t) = self.tools.get("code_search") {
                            return t.execute(params).await;
                        }
                    }
                    "context" | "rag_context" => {
                        if let Some(t) = self.tools.get("code_context") {
                            return t.execute(params).await;
                        }
                    }
                    "ask" | "rag_ask" => {
                        if let Some(t) = self.tools.get("code_ask") {
                            return t.execute(params).await;
                        }
                    }
                    "index" | "rag_index" => {
                        if let Some(t) = self.tools.get("code_index") {
                            return t.execute(params).await;
                        }
                    }
                    _ => {}
                }
                let args: tools::CodeToolArgs = serde_json::from_value(params)?;
                let result = self.code.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "git" => {
                let args: tools::GitToolArgs = serde_json::from_value(params)?;
                let result = self.git.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "fetch" => {
                match act {
                    "read" | "web_read" => {
                        if let Some(t) = self.tools.get("web_read") {
                            return t.execute(params).await;
                        }
                    }
                    "vision" => {
                        if let Some(t) = self.tools.get("vision") {
                            return t.execute(params).await;
                        }
                    }
                    "search" if hanzo_api::HanzoApi::from_env().has_key() && params.get("local").and_then(Value::as_bool) != Some(true) => {
                        if let Some(t) = self.tools.get("web_search") {
                            return t.execute(params).await;
                        }
                    }
                    _ => {}
                }
                let args: tools::FetchToolArgs = serde_json::from_value(params)?;
                let result = self.fetch.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "workspace" => {
                match act {
                    "projects" | "repo" => {
                        let root = params.get("path").and_then(Value::as_str).unwrap_or(".");
                        let projects = discover_projects(Path::new(root));
                        return Ok(ToolResult::ok(json!({
                            "ok": true,
                            "data": { "root": root, "count": projects.len(), "projects": projects },
                            "error": null,
                            "meta": { "tool": "workspace", "action": "projects" }
                        })));
                    }
                    "config" => {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        let sub = p
                            .get("config_action")
                            .or_else(|| p.get("sub_action"))
                            .and_then(Value::as_str)
                            .unwrap_or("show")
                            .to_string();
                        p.insert("action".into(), json!(sub));
                        if let Some(t) = self.tools.get("config") {
                            return t.execute(Value::Object(p)).await;
                        }
                    }
                    "system" | "version" | "stats" => {
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        let sub = if act == "system" {
                            p.get("sub_action").and_then(Value::as_str).unwrap_or("info").to_string()
                        } else {
                            act.to_string()
                        };
                        p.insert("action".into(), json!(sub));
                        if let Some(t) = self.tools.get("system") {
                            return t.execute(Value::Object(p)).await;
                        }
                    }
                    "mode" => {
                        let sub = params
                            .get("mode_action")
                            .or_else(|| params.get("sub_action"))
                            .and_then(Value::as_str)
                            .unwrap_or("list");
                        let mut p = params.as_object().cloned().unwrap_or_else(Map::new);
                        p.insert("action".into(), json!(sub));
                        let args: tools::ModeToolArgs = serde_json::from_value(Value::Object(p))?;
                        let result = self.mode.read().await.execute(args).await?;
                        return Ok(ToolResult::ok(serde_json::from_str(&result)?));
                    }
                    _ => {}
                }
                let args: tools::WorkspaceToolArgs = serde_json::from_value(params)?;
                let result = self.workspace.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "tasks" => {
                let args: tools::TasksToolArgs = serde_json::from_value(params)?;
                let result = self.tasks.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "hanzo" => {
                let args: tools::HanzoToolArgs = serde_json::from_value(params)?;
                let result = self.hanzo.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            _ => {
                if let Some(tool) = self.tools.get(name) {
                    return tool.execute_with(params, ctx).await;
                }
                if let Some(short) = name.strip_prefix("kai_") {
                    let api = hanzo_api::HanzoApi::from_env();
                    return tools::kai_suite_tool::dispatch(&api, name, short, &params).await;
                }
                Ok(ToolResult::err(&format!("Unknown tool: {}", name)))
            }
        }
    }

    /// Initialize with all default tools, and the shell classifier behind `exec`.
    pub fn with_defaults() -> Self {
        Self::with_shell(Arc::new(tools::Shell::new()))
    }

    /// The default tools with `shell` as the classifier behind `exec` and `git`.
    pub fn with_shell(shell: Arc<tools::Shell>) -> Self {
        let mut registry = Self::new();
        registry.git = Arc::new(RwLock::new(GitTool::new().classified(shell.clone())));
        registry.with_classifier(shell)
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

/// Get version information
pub fn version() -> Value {
    json!({
        "name": "hanzo-mcp",
        "version": env!("CARGO_PKG_VERSION"),
        "rust_version": "1.75+",
        "tools": CANONICAL_TOOLS.len(),
        "parity": parity_status()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_nineteen_tools_are_advertised_with_zero_legacy_leakage() {
        let registry = ToolRegistry::with_defaults();
        let defs = registry.get_definitions();
        let names: Vec<&str> = defs.iter().filter_map(|d| d["name"].as_str()).collect();
        assert_eq!(names.as_slice(), CANONICAL_TOOLS);
        assert_eq!(defs.len(), 19);

        // Zero fragmented tools in tools/list
        for legacy in LEGACY_ALIASES {
            assert!(!names.contains(legacy), "legacy alias {legacy} must not appear in tools/list");
        }
    }

    #[tokio::test]
    async fn think_delegates_agent_sub_actions_to_agent_tool() {
        let registry = ToolRegistry::with_defaults();
        let res = registry
            .execute("think", json!({ "action": "agent", "sub_action": "list" }))
            .await
            .unwrap();
        assert_eq!(res.content["ok"], true, "{}", res.content);
        assert_eq!(res.content["meta"]["tool"], "agent");
        assert!(res.content["data"]["native"].as_array().unwrap().iter().any(|a| a["name"] == "muse"));

        let missing = registry
            .execute("think", json!({ "action": "agent", "agent": "muse" }))
            .await
            .unwrap();
        assert_eq!(missing.content["meta"]["tool"], "agent");
        assert_eq!(missing.content["meta"]["action"], "run");
        assert_eq!(missing.content["error"]["code"], "INVALID_ARGS");
    }

    #[test]
    fn read_only_tools_say_so_and_the_rest_do_not() {
        let defs = ToolRegistry::with_defaults().get_definitions();
        for t in READ_ONLY {
            let d = defs.iter().find(|d| d["name"] == *t).unwrap_or_else(|| panic!("{t} is not listed"));
            assert_eq!(d["annotations"]["readOnlyHint"], true, "{t}");
        }
        for t in ["exec", "fs", "git", "kai", "skills", "tracker", "coding", "hanzo", "memory"] {
            let d = defs.iter().find(|d| d["name"] == t).unwrap_or_else(|| panic!("{t} is not listed"));
            assert_ne!(d["annotations"]["readOnlyHint"], true, "{t} must not claim to be read-only");
        }
        // A tool with no hints carries no annotations key at all.
        let kai = defs.iter().find(|d| d["name"] == "kai").unwrap();
        assert!(kai.get("annotations").is_none(), "kai: {:?}", kai.get("annotations"));
        let mut legacy = ToolRegistry::with_defaults();
        legacy.restrict(["code_index"]).unwrap();
        let ci = legacy.get_definitions().into_iter().find(|d| d["name"] == "code_index").unwrap();
        assert!(ci.get("annotations").is_none(), "code_index: {:?}", ci.get("annotations"));
    }

    #[test]
    fn annotations_are_an_object_or_absent_never_null() {
        // The MCP SDK rejects the whole tools/list over one `"annotations": null`.
        for d in ToolRegistry::with_defaults().get_definitions() {
            if let Some(a) = d.get("annotations") {
                assert!(a.is_object(), "{}: annotations is {a}", d["name"]);
            }
        }
    }

    #[test]
    fn every_built_in_tool_is_titled_and_hinted() {
        let defs = ToolRegistry::with_defaults().get_definitions();
        let builtins = ["exec", "fs", "code", "git", "fetch", "workspace", "plan", "think", "memory",
            "computer", "browser", "tasks", "hanzo"];
        for t in builtins {
            let d = defs.iter().find(|d| d["name"] == t).unwrap_or_else(|| panic!("{t} is not listed"));
            let a = &d["annotations"];
            assert!(a["title"].is_string(), "{t} has no title");
            assert!(a["readOnlyHint"].is_boolean(), "{t} has no readOnlyHint");
            if a["readOnlyHint"] == false {
                assert!(a["destructiveHint"].is_boolean(), "{t} has no destructiveHint");
            }
        }
        // Anything that can write or delete files, or run commands, must say it is destructive.
        for t in ["exec", "fs", "code", "git", "memory"] {
            let d = defs.iter().find(|d| d["name"] == t).unwrap();
            assert_eq!(d["annotations"]["destructiveHint"], true, "{t}");
        }
        // Legacy runner aliases also carry destructive hints when explicitly restricted in.
        let mut runners = ToolRegistry::with_defaults();
        runners.restrict(["npx", "uvx"]).unwrap();
        for t in ["npx", "uvx"] {
            let d = runners.get_definitions().into_iter().find(|d| d["name"] == t).unwrap();
            assert_eq!(d["annotations"]["destructiveHint"], true, "{t}");
            assert!(d["annotations"]["title"].is_string(), "{t} has no title");
        }
    }

    #[tokio::test]
    async fn legacy_aliases_execute_silently_on_tools_call() {
        let registry = ToolRegistry::with_defaults();
        let guard = registry
            .execute("kai_command_guard", json!({ "command": "cargo test" }))
            .await
            .unwrap();
        assert_eq!(guard.content["ok"], true);
        assert_eq!(guard.content["data"]["verdict"], "allow");

        let unified_guard = registry
            .execute("kai", json!({ "action": "command_guard", "command": "cargo test" }))
            .await
            .unwrap();
        assert_eq!(unified_guard.content["data"]["verdict"], "allow");
    }

    #[tokio::test]
    async fn test_proc_execute() {
        let registry = ToolRegistry::new();
        let result = registry.execute("exec", json!({ "action": "help" })).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_fs_execute() {
        let registry = ToolRegistry::new();
        let result = registry.execute("fs", json!({ "action": "help" })).await;
        assert!(result.is_ok());
    }

    #[test]
    fn test_version() {
        let v = version();
        assert_eq!(v["tools"], 19);
    }
}
