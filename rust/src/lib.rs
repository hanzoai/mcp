/// Hanzo MCP Server - Rust implementation (HIP-0300)
///
/// Provides full tool parity with Python hanzo-mcp:
/// - proc: Unified process execution
/// - fs: File system operations
/// - plan: Plan tracking
/// - think: Reasoning tools (think, critic, review)
/// - memory: Memory and knowledge management
/// - ui: Native computer control
/// - browser: Playwright-based browser automation
/// - mode: Development modes
/// - search: Unified code search

pub mod config;
pub mod server;
pub mod protocol;
pub mod tools;
pub mod search;

pub use config::Config;
pub use server::MCPServer;
pub use tools::{
    ShellTool, FsTool, PlanTool, ThinkTool, MemoryTool,
    UiTool, BrowserTool, ModeTool,
    list_tools, parity_status,
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
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
    shell: Arc<RwLock<ShellTool>>,
    fs: Arc<RwLock<FsTool>>,
    plan: Arc<RwLock<PlanTool>>,
    think: Arc<RwLock<ThinkTool>>,
    memory: Arc<RwLock<MemoryTool>>,
    ui: Arc<RwLock<UiTool>>,
    browser: Arc<RwLock<BrowserTool>>,
    mode: Arc<RwLock<ModeTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            shell: Arc::new(RwLock::new(ShellTool::new())),
            fs: Arc::new(RwLock::new(FsTool::new())),
            plan: Arc::new(RwLock::new(PlanTool::new())),
            think: Arc::new(RwLock::new(ThinkTool::new())),
            memory: Arc::new(RwLock::new(MemoryTool::new())),
            ui: Arc::new(RwLock::new(UiTool::new())),
            browser: Arc::new(RwLock::new(BrowserTool::new())),
            mode: Arc::new(RwLock::new(ModeTool::new())),
        }
    }

    pub fn register(&mut self, tool: Box<dyn MCPTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Box<dyn MCPTool>> {
        self.tools.get(name)
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        // Add built-in tools
        names.extend(vec![
            "proc".to_string(),
            "fs".to_string(),
            "plan".to_string(),
            "think".to_string(),
            "memory".to_string(),
            "ui".to_string(),
            "browser".to_string(),
            "mode".to_string(),
        ]);
        names.sort();
        names.dedup();
        names
    }

    /// Execute a tool by name
    pub async fn execute(&self, name: &str, params: Value) -> Result<ToolResult> {
        match name {
            "proc" => {
                let args: tools::ProcToolArgs = serde_json::from_value(params)?;
                let result = self.shell.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "fs" => {
                let args: tools::FsToolArgs = serde_json::from_value(params)?;
                let result = self.fs.read().await.execute(args).await?;
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
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "memory" => {
                let args: tools::MemoryToolArgs = serde_json::from_value(params)?;
                let result = self.memory.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "ui" | "computer" => {
                let args: tools::UiToolArgs = serde_json::from_value(params)?;
                let mut ui = self.ui.write().await;
                let result = ui.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "browser" => {
                let args: tools::BrowserToolArgs = serde_json::from_value(params)?;
                let result = self.browser.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
            }
            "mode" => {
                let args: tools::ModeToolArgs = serde_json::from_value(params)?;
                let result = self.mode.read().await.execute(args).await?;
                Ok(ToolResult::ok(serde_json::from_str(&result)?))
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

    /// Get tool definitions for MCP protocol
    pub fn get_definitions(&self) -> Vec<Value> {
        let mut definitions = vec![
            json!({
                "name": "proc",
                "description": tools::ShellToolDefinition::new().description,
                "inputSchema": tools::ShellToolDefinition::new().input_schema
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
                "name": "ui",
                "description": tools::UiToolDefinition::new().description,
                "inputSchema": tools::UiToolDefinition::new().input_schema
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
        ];

        // Add custom registered tools
        for tool in self.tools.values() {
            definitions.push(json!({
                "name": tool.name(),
                "description": tool.description(),
                "inputSchema": tool.parameters()
            }));
        }

        definitions
    }

    /// Initialize with all default tools
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();

        // All core tools are already initialized in new()
        // Add any additional optional tools here

        #[cfg(feature = "computer-control")]
        {
            // Additional computer control features
        }

        #[cfg(feature = "vector-store")]
        {
            // Vector store integration
        }

        registry
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
        assert!(tools.contains(&"proc".to_string()));
        assert!(tools.contains(&"fs".to_string()));
        assert!(tools.contains(&"plan".to_string()));
        assert!(tools.contains(&"think".to_string()));
        assert!(tools.contains(&"memory".to_string()));
        assert!(tools.contains(&"ui".to_string()));
        assert!(tools.contains(&"browser".to_string()));
        assert!(tools.contains(&"mode".to_string()));
    }

    #[test]
    fn test_tool_definitions() {
        let registry = ToolRegistry::new();
        let definitions = registry.get_definitions();
        assert!(definitions.len() >= 8);
    }

    #[tokio::test]
    async fn test_proc_execute() {
        let registry = ToolRegistry::new();
        let result = registry.execute("proc", json!({
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
