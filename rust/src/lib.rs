#![recursion_limit = "256"]
//! Hanzo MCP Server - Rust implementation (HIP-0300)
//!
/// Provides full tool parity with Python hanzo-mcp:
/// - exec: Process execution
/// - fs: File system operations
/// - plan: Plan tracking
/// - think: Reasoning tools (think, critic, review)
/// - memory: Memory and knowledge management
/// - computer: Native OS control
/// - browser: Playwright-based browser automation
/// - mode: Development modes
/// - search: Unified code search

pub mod catalog;
pub mod brain;
pub mod config;
pub mod ffi;
pub mod hanzo_api;
pub mod server;
pub mod protocol;
pub mod tools;
pub mod search;
pub mod native;
pub mod zap;

/// The in-process search engine behind `fs search_text` and `code search_symbol`, which Dev
/// links directly: a call, not an MCP hop. It is its own light crate so a caller need not
/// take this crate's browser, desktop and parser dependencies to search.
pub use hanzo_trigram as trigram;
/// Kai Actions: typed, verified operations run without a model call (the `kai` tool's executor).
/// Its own light crate, for the same reason as `trigram`.
pub use hanzo_actions as actions;
pub use config::Config;
pub use server::MCPServer;
pub use tools::{
    ExecTool, FsTool, PlanTool, ThinkTool, MemoryTool,
    ComputerTool, BrowserTool, ModeTool,
    CodeTool, GitTool, FetchTool, WorkspaceTool, TasksTool, HanzoTool,
    list_tools, parity_status,
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
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


/// The tools that read or hand work to Hanzo's models and indexes and change nothing on this
/// machine, listed with `readOnlyHint`. A client that asks before a tool that may write calls these
/// without asking: Codex, Hanzo Dev and Open Interpreter refuse every unannotated call in a run
/// that never asks. `llm`'s one write is the rating `feedback` gives an answer it returned. `kai`
/// runs actions and `code_index` writes the index, so neither is here.
pub const READ_ONLY: &[&str] =
    &["kai_decide", "llm", "research", "web_search", "web_read", "code_search", "code_context", "code_ask", "vision", "think"];

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
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
        }
    }

    /// The registry with `classifier` asked about every `exec` command before it runs. This is
    /// where the shell classifier plugs in for the MCP server; Dev builds its own `ExecTool`
    /// with the same classifier.
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

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        // Add built-in tools (all 13 HIP-0300 canonical + browser)
        names.extend(vec![
            "exec".into(), "fs".into(), "code".into(), "git".into(),
            "fetch".into(), "workspace".into(), "computer".into(),
            "think".into(), "memory".into(), "hanzo".into(),
            "plan".into(), "tasks".into(), "mode".into(),
            "browser".into(), "npx".into(), "uvx".into(),
        ]);
        names.sort();
        names.dedup();
        names.retain(|n| self.allowed(n));
        names
    }

    fn allowed(&self, name: &str) -> bool {
        self.allow.as_ref().map_or(true, |allow| allow.contains(name))
    }

    /// Serves only `names`: `tools/list` shows them and nothing else answers. A client pays
    /// for every schema it is shown on every turn, so a caller that wants three tools should
    /// be shown three. A name this registry does not carry is an error, not an empty list.
    pub fn restrict<I, S>(&mut self, names: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let known = self.list();
        let mut allow = BTreeSet::new();
        for name in names {
            let name = name.as_ref().trim();
            if name.is_empty() {
                continue;
            }
            if !known.iter().any(|k| k == name) {
                return Err(anyhow::anyhow!("unknown tool {name:?}; this server carries: {}", known.join(", ")));
            }
            allow.insert(name.to_string());
        }
        if allow.is_empty() {
            return Err(anyhow::anyhow!("--tools names no tool"));
        }
        self.allow = Some(allow);
        Ok(())
    }

    /// Execute a tool by name
    pub async fn execute(&self, name: &str, params: Value) -> Result<ToolResult> {
        if !self.allowed(name) {
            return Ok(ToolResult::err(&format!("Unknown tool: {}", name)));
        }
        match name {
            "exec" => {
                let args: tools::ExecToolArgs = serde_json::from_value(params)?;
                let result = self.exec.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "fs" => {
                let args: tools::FsToolArgs = serde_json::from_value(params)?;
                let result = self.fs.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            // A package run is an exec of its argv, in exec's process table.
            "npx" | "uvx" => {
                let args = tools::ExecToolArgs {
                    action: "exec".into(),
                    command: Some(json!(tools::runner::argv(name, &params)?)),
                    cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
                    timeout: Some(tools::runner::BACKGROUND),
                    // exec's classifier asks before a package is fetched; the same approval exec takes.
                    approve: params.get("approve").and_then(Value::as_bool),
                    ..Default::default()
                };
                let result = self.exec.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "plan" => {
                let args: tools::PlanToolArgs = serde_json::from_value(params)?;
                let result = self.plan.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "think" => {
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
                let args: tools::ComputerToolArgs = serde_json::from_value(params)?;
                let mut computer = self.computer.write().await;
                let result = computer.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "browser" => {
                let args: tools::BrowserToolArgs = serde_json::from_value(params)?;
                let result = self.browser.read().await.execute(args).await?;
                // A tree, a page or help is text; everything else JSON.
                Ok(ToolResult::ok(serde_json::from_str(&result).unwrap_or(Value::String(result))))
            }
            "mode" => {
                let args: tools::ModeToolArgs = serde_json::from_value(params)?;
                let result = self.mode.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "code" => {
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
                let args: tools::FetchToolArgs = serde_json::from_value(params)?;
                let result = self.fetch.read().await.execute(args).await?;
                Ok(ToolResult::ok(result))
            }
            "workspace" => {
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
                    tool.execute(params).await
                } else {
                    Ok(ToolResult::err(&format!("Unknown tool: {}", name)))
                }
            }
        }
    }

    /// Get tool definitions for MCP protocol, each read-only tool annotated as one.
    pub fn get_definitions(&self) -> Vec<Value> {
        let mut definitions = vec![
            json!({
                "name": "exec",
                "description": tools::ExecToolDefinition::new().description,
                "inputSchema": tools::ExecToolDefinition::new().input_schema
            }),
            json!({
                "name": "fs",
                "description": tools::FsToolDefinition::new().description,
                "inputSchema": tools::FsToolDefinition::new().input_schema
            }),
            json!({
                "name": "plan",
                "description": tools::PlanToolDefinition::new().description,
                "inputSchema": tools::PlanToolDefinition::new().input_schema
            }),
            json!({
                "name": "think",
                "description": tools::ThinkToolDefinition::new().description,
                "inputSchema": tools::ThinkToolDefinition::new().input_schema
            }),
            json!({
                "name": "memory",
                "description": tools::MemoryToolDefinition::new().description,
                "inputSchema": tools::MemoryToolDefinition::new().input_schema
            }),
            json!({
                "name": "computer",
                "description": tools::ComputerToolDefinition::new().description,
                "inputSchema": tools::ComputerToolDefinition::new().input_schema
            }),
            json!({
                "name": "browser",
                "description": tools::BrowserToolDefinition::new().description,
                "inputSchema": tools::BrowserToolDefinition::new().input_schema
            }),
            json!({
                "name": "mode",
                "description": tools::ModeToolDefinition::new().description,
                "inputSchema": tools::ModeToolDefinition::new().input_schema
            }),
            tools::CodeToolDefinition::schema(),
            tools::GitToolDefinition::schema(),
            tools::FetchToolDefinition::schema(),
            tools::WorkspaceToolDefinition::schema(),
            tools::TasksToolDefinition::schema(),
            tools::HanzoToolDefinition::schema(),
            tools::runner::definition("npx"),
            tools::runner::definition("uvx"),
        ];

        // The registered tools come after the built-ins, by name: a hash map's order changes
        // with every process, and a client's prompt cache holds only while the list does not.
        let mut custom: Vec<&Box<dyn MCPTool>> = self.tools.values().collect();
        custom.sort_by(|a, b| a.name().cmp(b.name()));
        for tool in custom {
            definitions.push(json!({
                "name": tool.name(),
                "description": tool.description(),
                "inputSchema": tool.parameters()
            }));
        }

        definitions.retain(|d| d["name"].as_str().is_some_and(|n| self.allowed(n)));
        for d in &mut definitions {
            if d["name"].as_str().is_some_and(|n| READ_ONLY.contains(&n)) {
                d["annotations"] = json!({ "readOnlyHint": true, "openWorldHint": true });
            }
        }
        definitions
    }

    /// Initialize with all default tools, and the shell classifier behind `exec`.
    pub fn with_defaults() -> Self {
        Self::with_shell(Arc::new(tools::Shell::new()))
    }

    /// The default tools with `shell` as the classifier behind `exec` and `git`; the server keeps
    /// a handle to add the roots it was given.
    pub fn with_shell(shell: Arc<tools::Shell>) -> Self {
        let mut registry = Self::new();

        // Cloud-backed tools (api.hanzo.ai) via the generic MCPTool seam.
        // These complement the local tools: code_* is cross-repo RAG next to the
        // local tree-sitter `code` tool; web_* and vision reach the platform.
        registry.register(Box::new(tools::CodeSearchTool::new()));
        registry.register(Box::new(tools::CodeContextTool::new()));
        registry.register(Box::new(tools::CodeAskTool::new()));
        registry.register(Box::new(tools::CodeIndexTool::new()));
        registry.register(Box::new(tools::WebSearchTool::new()));
        registry.register(Box::new(tools::WebReadTool::new()));
        registry.register(Box::new(tools::ResearchTool::new()));
        registry.register(Box::new(tools::VisionTool::new()));

        // Ported tool surface (HIP-0300 parity with python-sdk): config, llm, ui,
        // agent, lsp, refactor, system — all dyn-trait tools via the MCPTool seam.
        registry.register(Box::new(tools::ConfigTool::new()));
        registry.register(Box::new(tools::LlmTool::new()));
        // Kai, the decision model: typed questions at /v1/decisions, the same
        // kai_decide the TypeScript runtime offers.
        registry.register(Box::new(tools::KaiDecideTool::new()));
        registry.register(Box::new(tools::ActionsTool::new()));
        registry.register(Box::new(tools::UiTool::new()));
        registry.register(Box::new(tools::AgentTool::new()));
        registry.register(Box::new(tools::LspTool::new()));
        registry.register(Box::new(tools::RefactorTool::new()));
        registry.register(Box::new(tools::SystemTool::new()));
        registry.register(Box::new(tools::CdpTool::new()));
        registry.register(Box::new(tools::JqTool::new()));

        #[cfg(feature = "computer-control")]
        {
            // Additional computer control features
        }

        #[cfg(feature = "vector-store")]
        {
            // Vector store integration
        }

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
        "tools": list_tools().len(),
        "parity": parity_status()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_registry() {
        let registry = ToolRegistry::new();
        let tools = registry.list();
        assert!(tools.contains(&"exec".to_string()));
        assert!(tools.contains(&"fs".to_string()));
        assert!(!tools.contains(&"search".to_string()), "fs action=search_text is the one search");
        assert!(tools.contains(&"plan".to_string()));
        assert!(tools.contains(&"think".to_string()));
        assert!(tools.contains(&"memory".to_string()));
        assert!(tools.contains(&"computer".to_string()));
        assert!(tools.contains(&"browser".to_string()));
        assert!(tools.contains(&"mode".to_string()));
    }

    #[test]
    fn test_tool_definitions() {
        let registry = ToolRegistry::new();
        let definitions = registry.get_definitions();
        assert!(definitions.len() >= 9);
    }

    #[test]
    fn test_cloud_tools_registered_and_discoverable() {
        let registry = ToolRegistry::with_defaults();
        let names = registry.list();
        for t in ["code_search", "code_context", "code_ask", "code_index", "web_search", "web_read", "research", "vision"] {
            assert!(names.contains(&t.to_string()), "{t} missing from registry.list()");
        }
        // Each cloud tool must also expose a definition (name + inputSchema) for MCP tools/list.
        let defs = registry.get_definitions();
        for t in ["code_search", "code_context", "code_ask", "code_index", "web_search", "web_read", "research", "vision"] {
            assert!(
                defs.iter().any(|d| d["name"] == t && d["inputSchema"].is_object()),
                "{t} missing a definition"
            );
        }
    }

    #[test]
    fn read_only_tools_say_so_and_the_rest_do_not() {
        let defs = ToolRegistry::with_defaults().get_definitions();
        for t in READ_ONLY {
            let d = defs.iter().find(|d| d["name"] == *t).unwrap_or_else(|| panic!("{t} is not listed"));
            assert_eq!(d["annotations"]["readOnlyHint"], true, "{t}");
        }
        for t in ["exec", "fs", "git", "kai", "code_index", "memory"] {
            let d = defs.iter().find(|d| d["name"] == t).unwrap_or_else(|| panic!("{t} is not listed"));
            assert!(d.get("annotations").is_none(), "{t} must not claim to be read-only");
        }
    }

    #[tokio::test]
    async fn test_proc_execute() {
        let registry = ToolRegistry::new();
        let result = registry.execute("exec", json!({
            "action": "help"
        })).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_fs_execute() {
        let registry = ToolRegistry::new();
        let result = registry.execute("fs", json!({
            "action": "help"
        })).await;
        assert!(result.is_ok());
    }

    #[test]
    fn test_version() {
        let v = version();
        assert!(v.get("name").is_some());
        assert!(v.get("version").is_some());
        assert!(v.get("tools").is_some());
    }
}
