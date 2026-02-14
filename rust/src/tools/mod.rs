/// Tool modules for hanzo-mcp (HIP-0300)
///
/// This module provides the complete tool implementation matching Python hanzo-mcp.
/// All tools follow the unified action-based pattern.

pub mod personality;
pub mod mode_tool;
pub mod ui_tool;
pub mod shell_tool;
pub mod fs_tool;
pub mod plan_tool;
pub mod think_tool;
pub mod memory_tool;
pub mod browser_tool;

// Re-export tools
pub use mode_tool::{ModeTool, ModeToolArgs, ModeToolDefinition};
pub use personality::{ToolPersonality, PersonalityRegistry};
pub use ui_tool::{UiTool, UiToolArgs, UiToolDefinition};
pub use shell_tool::{ShellTool, ProcToolArgs, ShellToolDefinition};
pub use fs_tool::{FsTool, FsToolArgs, FsToolDefinition};
pub use plan_tool::{PlanTool, PlanToolArgs, PlanToolDefinition};
pub use think_tool::{ThinkTool, ThinkToolArgs, ThinkToolDefinition};
pub use memory_tool::{MemoryTool, MemoryToolArgs, MemoryToolDefinition};
pub use browser_tool::{BrowserTool, BrowserToolArgs, BrowserToolDefinition};

/// Tool category for organization
#[derive(Debug, Clone, PartialEq)]
pub enum ToolCategory {
    /// Core execution tools (proc)
    Execution,
    /// File system tools (fs)
    FileSystem,
    /// Planning tools (plan)
    Planning,
    /// Reasoning tools (think, critic, review)
    Reasoning,
    /// Memory tools (memory, facts)
    Memory,
    /// UI/Computer control (ui)
    Computer,
    /// Browser automation (browser)
    Browser,
    /// Development modes (mode)
    Configuration,
}

/// Tool registry entry
pub struct ToolEntry {
    pub name: String,
    pub description: String,
    pub category: ToolCategory,
}

/// Get all available tools
pub fn list_tools() -> Vec<ToolEntry> {
    vec![
        ToolEntry {
            name: "proc".to_string(),
            description: "Unified process execution (HIP-0300)".to_string(),
            category: ToolCategory::Execution,
        },
        ToolEntry {
            name: "fs".to_string(),
            description: "Unified filesystem operations (HIP-0300)".to_string(),
            category: ToolCategory::FileSystem,
        },
        ToolEntry {
            name: "plan".to_string(),
            description: "Plan tracking with step status".to_string(),
            category: ToolCategory::Planning,
        },
        ToolEntry {
            name: "think".to_string(),
            description: "Reasoning tools (think, critic, review)".to_string(),
            category: ToolCategory::Reasoning,
        },
        ToolEntry {
            name: "memory".to_string(),
            description: "Memory and knowledge management".to_string(),
            category: ToolCategory::Memory,
        },
        ToolEntry {
            name: "ui".to_string(),
            description: "Native computer control (mouse, keyboard, screen)".to_string(),
            category: ToolCategory::Computer,
        },
        ToolEntry {
            name: "browser".to_string(),
            description: "Browser automation with Playwright".to_string(),
            category: ToolCategory::Browser,
        },
        ToolEntry {
            name: "mode".to_string(),
            description: "Development modes (programmer personalities)".to_string(),
            category: ToolCategory::Configuration,
        },
    ]
}

/// Tool parity status with Python hanzo-mcp
pub fn parity_status() -> serde_json::Value {
    serde_json::json!({
        "version": "0.12.0",
        "rust_version": env!("CARGO_PKG_VERSION"),
        "tools_implemented": 8,
        "parity_with_python": {
            "proc": "full",
            "fs": "full",
            "plan": "full",
            "think": "full",
            "memory": "full",
            "ui": "full",
            "browser": "partial",
            "mode": "full",
            "search": "full"
        },
        "missing_tools": [
            "agent (subagent orchestration)",
            "lsp (language server)",
            "refactor (code refactoring)",
            "api (REST API client)",
            "todo (todo list)"
        ],
        "search_features": {
            "text_search": "ripgrep-based",
            "ast_search": "tree-sitter (8 languages)",
            "symbol_search": "ctags + regex fallback",
            "vector_search": "stub (lance disabled due to arrow conflict)",
            "file_search": "glob patterns"
        },
        "notes": "Browser tool delegates complex actions to Playwright via subprocess. Vector search temporarily disabled due to dependency conflicts."
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_tools() {
        let tools = list_tools();
        assert!(tools.len() >= 8);

        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"proc"));
        assert!(names.contains(&"fs"));
        assert!(names.contains(&"plan"));
        assert!(names.contains(&"think"));
        assert!(names.contains(&"memory"));
        assert!(names.contains(&"ui"));
        assert!(names.contains(&"browser"));
        assert!(names.contains(&"mode"));
    }

    #[test]
    fn test_parity_status() {
        let status = parity_status();
        assert!(status.get("version").is_some());
        assert!(status.get("tools_implemented").is_some());
    }
}
