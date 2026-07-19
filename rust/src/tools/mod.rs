/// Tool modules for hanzo-mcp (HIP-0300)
///
/// 13 unified action-routed tools matching TypeScript and Python, plus
/// cloud-backed tools that expose the live api.hanzo.ai code-knowledge, web,
/// and vision backend. Local (tree-sitter AST) and cloud (cross-repo RAG) are
/// hybrid: instant single-file ops stay local; corpus-scale ops go to cloud.

use serde_json::{json, Value};

pub mod personality;
pub mod mode_tool;
pub mod computer_tool;
pub mod exec_tool;
pub mod fs_tool;
pub mod plan_tool;
pub mod think_tool;
pub mod memory_tool;
pub mod browser_tool;
pub mod code_tool;
pub mod git_tool;
pub mod fetch_tool;
pub mod workspace_tool;
pub mod tasks_tool;
pub mod hanzo_tool;
pub mod cloud_code;
pub mod cloud_web;
pub mod vision_tool;
pub mod config_tool;
pub mod llm_tool;
pub mod ui_tool;
pub mod agent_tool;
pub mod lsp_tool;
pub mod refactor_tool;
pub mod system_tool;

// Re-export tools — HIP-0300 canonical names
pub use fs_tool::{FsTool, FsToolArgs, FsToolDefinition};
pub use exec_tool::{ExecTool, ExecToolArgs, ExecToolDefinition};
pub use code_tool::{CodeTool, CodeToolArgs, CodeToolDefinition};
pub use git_tool::{GitTool, GitToolArgs, GitToolDefinition};
pub use fetch_tool::{FetchTool, FetchToolArgs, FetchToolDefinition};
pub use workspace_tool::{WorkspaceTool, WorkspaceToolArgs, WorkspaceToolDefinition};
pub use computer_tool::{ComputerTool, ComputerToolArgs, ComputerToolDefinition};
pub use think_tool::{ThinkTool, ThinkToolArgs, ThinkToolDefinition};
pub use memory_tool::{MemoryTool, MemoryToolArgs, MemoryToolDefinition};
pub use hanzo_tool::{HanzoTool, HanzoToolArgs, HanzoToolDefinition};
pub use plan_tool::{PlanTool, PlanToolArgs, PlanToolDefinition};
pub use tasks_tool::{TasksTool, TasksToolArgs, TasksToolDefinition};
pub use mode_tool::{ModeTool, ModeToolArgs, ModeToolDefinition};
pub use browser_tool::{BrowserTool, BrowserToolArgs, BrowserToolDefinition};
pub use personality::{ToolPersonality, PersonalityRegistry};
// Cloud-backed tools (api.hanzo.ai) — registered via the generic MCPTool seam.
pub use cloud_code::{CodeSearchTool, CodeContextTool, CodeAskTool, CodeIndexTool};
pub use cloud_web::{WebSearchTool, WebReadTool};
pub use vision_tool::VisionTool;
pub use config_tool::ConfigTool;
pub use llm_tool::LlmTool;
pub use ui_tool::UiTool;
pub use agent_tool::AgentTool;
pub use lsp_tool::LspTool;
pub use refactor_tool::RefactorTool;
pub use system_tool::SystemTool;

/// Standard success envelope shared by cloud-backed tools: `{ok,data,error,meta}`.
pub(crate) fn envelope_ok(tool: &str, action: &str, data: Value) -> Value {
    json!({ "ok": true, "data": data, "error": null, "meta": { "tool": tool, "action": action } })
}

/// Standard error envelope shared by cloud-backed tools: `{ok,data,error,meta}`.
pub(crate) fn envelope_err(tool: &str, action: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "ok": false, "data": null, "error": { "code": code, "message": message.into() }, "meta": { "tool": tool, "action": action } })
}

/// Tool category for organization
#[derive(Debug, Clone, PartialEq)]
pub enum ToolCategory {
    /// Core tools
    FileSystem,    // fs
    Execution,     // exec
    Semantics,     // code
    VersionControl,// git
    Network,       // fetch
    Workspace,     // workspace
    Computer,      // computer
    /// Optional tools
    Reasoning,     // think
    Memory,        // memory
    Platform,      // hanzo
    Planning,      // plan
    Tasks,         // tasks
    Configuration, // mode
    /// Extensions
    Browser,       // browser (extension)
}

/// Tool registry entry
pub struct ToolEntry {
    pub name: String,
    pub description: String,
    pub category: ToolCategory,
}

/// Get all available tools (HIP-0300 canonical surface)
pub fn list_tools() -> Vec<ToolEntry> {
    vec![
        // Core (8)
        ToolEntry { name: "fs".into(), description: "Filesystem operations".into(), category: ToolCategory::FileSystem },
        ToolEntry { name: "exec".into(), description: "Process execution".into(), category: ToolCategory::Execution },
        ToolEntry { name: "code".into(), description: "Code semantics + AST + LSP".into(), category: ToolCategory::Semantics },
        ToolEntry { name: "git".into(), description: "Version control".into(), category: ToolCategory::VersionControl },
        ToolEntry { name: "fetch".into(), description: "Network operations".into(), category: ToolCategory::Network },
        ToolEntry { name: "workspace".into(), description: "Project context".into(), category: ToolCategory::Workspace },
        ToolEntry { name: "computer".into(), description: "Native OS control".into(), category: ToolCategory::Computer },
        // Optional (7)
        ToolEntry { name: "think".into(), description: "Structured reasoning".into(), category: ToolCategory::Reasoning },
        ToolEntry { name: "memory".into(), description: "Knowledge persistence".into(), category: ToolCategory::Memory },
        ToolEntry { name: "hanzo".into(), description: "Hanzo platform".into(), category: ToolCategory::Platform },
        ToolEntry { name: "plan".into(), description: "Task planning".into(), category: ToolCategory::Planning },
        ToolEntry { name: "tasks".into(), description: "Task tracking".into(), category: ToolCategory::Tasks },
        ToolEntry { name: "mode".into(), description: "Development modes".into(), category: ToolCategory::Configuration },
    ]
}

/// Tool parity status across implementations
pub fn parity_status() -> serde_json::Value {
    serde_json::json!({
        "hip": "0300",
        "rust_version": env!("CARGO_PKG_VERSION"),
        "tools_implemented": 13,
        "surface": ["fs", "exec", "code", "git", "fetch", "workspace", "computer", "think", "memory", "hanzo", "plan", "tasks", "mode"],
        "parity": {
            "fs": "full",
            "exec": "full",
            "code": "basic (regex, no tree-sitter yet)",
            "git": "full",
            "fetch": "full (reqwest)",
            "workspace": "full",
            "computer": "full",
            "think": "full (reasoning journal)",
            "memory": "full",
            "hanzo": "stub (progressive reveal only)",
            "plan": "full",
            "tasks": "full",
            "mode": "full"
        },
        "cloud": {
            "backend": "api.hanzo.ai",
            "tools": ["code_search", "code_context", "code_ask", "code_index", "web_search", "web_read", "vision"],
            "auth": "hk- bearer from HANZO_API_KEY or ~/.hanzo/config.json .apiKey"
        },
        "notes": "Local tree-sitter AST engine for single-file ops; cloud tools for cross-repo search/index, web, and vision. Browser tool available as extension."
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_tools() {
        let tools = list_tools();
        assert_eq!(tools.len(), 13);

        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        // Core
        assert!(names.contains(&"fs"));
        assert!(names.contains(&"exec"));
        assert!(names.contains(&"code"));
        assert!(names.contains(&"git"));
        assert!(names.contains(&"fetch"));
        assert!(names.contains(&"workspace"));
        assert!(names.contains(&"computer"));
        // Optional
        assert!(names.contains(&"think"));
        assert!(names.contains(&"memory"));
        assert!(names.contains(&"hanzo"));
        assert!(names.contains(&"plan"));
        assert!(names.contains(&"tasks"));
        assert!(names.contains(&"mode"));
    }

    #[test]
    fn test_parity_status() {
        let status = parity_status();
        assert_eq!(status["tools_implemented"], 13);
        assert_eq!(status["hip"], "0300");
    }
}
