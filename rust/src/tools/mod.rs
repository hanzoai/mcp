/// Tool modules for hanzo-mcp (HIP-0300)
///
/// 13 unified tools matching TypeScript and Python implementations.
/// All tools follow the action-routed pattern with unified envelope.

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
        "notes": "Browser tool available as extension. Vector search temporarily disabled."
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
