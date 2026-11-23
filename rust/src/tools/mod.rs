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
pub mod verdict;
pub mod shell;
pub mod fs_tool;
pub mod plan_tool;
pub mod think_tool;
pub mod memory_tool;
pub mod browser_tool;
pub mod cdp_tool;
pub mod jq_tool;
pub mod runner;
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
pub mod kai_tool;
pub mod actions_tool;
pub mod ui_tool;
pub mod agent_tool;
pub mod lsp_tool;
pub mod refactor_tool;
pub mod system_tool;
pub mod tracker_tool;
pub mod coding_tool;
pub mod skills_tool;
pub mod gimp_tool;
pub mod vault_tool;
pub mod connectors_tool;
pub mod kai_suite_tool;

// Re-export tools — HIP-0300 canonical names
pub use fs_tool::{FsTool, FsToolArgs, FsToolDefinition};
pub use exec_tool::{ExecTool, ExecToolArgs, ExecToolDefinition};
pub use verdict::{Classify, Risk, Verdict};
pub use shell::Shell;
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
pub use cdp_tool::CdpTool;
pub use jq_tool::JqTool;
pub use personality::{ToolPersonality, PersonalityRegistry};
// Cloud-backed tools (api.hanzo.ai) — registered via the generic MCPTool seam.
pub use cloud_code::{CodeSearchTool, CodeContextTool, CodeAskTool, CodeIndexTool};
pub use cloud_web::{WebSearchTool, WebReadTool, ResearchTool};
pub use tracker_tool::{TrackerTool, TrackerBoardsTool, TrackerIssuesTool, TrackerCreateTool, TrackerUpdateTool};
pub use coding_tool::CodingTool;
pub use skills_tool::SkillsTool;
pub use gimp_tool::GimpTool;
pub use vault_tool::VaultTool;
pub use connectors_tool::ConnectorsTool;
pub use vision_tool::VisionTool;
pub use config_tool::ConfigTool;
pub use llm_tool::LlmTool;
pub use kai_tool::KaiDecideTool;
pub use actions_tool::ActionsTool;
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

/// A plan refusal as an MCP error result, or `None` when `e` is another error.
/// The text is `{"error": {...}}`, the same the TypeScript runtime answers; the
/// content is the envelope, for callers of the registry.
pub(crate) fn refused(tool: &str, action: &str, e: &anyhow::Error) -> Option<crate::ToolResult> {
    let r = e.downcast_ref::<crate::hanzo_api::Refusal>()?;
    Some(crate::ToolResult {
        success: false,
        content: json!({ "ok": false, "data": null, "error": r.error, "meta": { "tool": tool, "action": action } }),
        error: Some(serde_json::to_string_pretty(&json!({ "error": r.error })).unwrap_or_default()),
    })
}

/// Tool category for organization
#[derive(Debug, Clone, PartialEq)]
pub enum ToolCategory {
    /// Core & Canonical HIP-0300 tools (19 orthogonal tools)
    FileSystem,    // fs
    Execution,     // exec
    Semantics,     // code
    VersionControl,// git
    Network,       // fetch
    Workspace,     // workspace
    Browser,       // browser
    Computer,      // computer
    Ui,            // ui
    Decision,      // kai
    Reasoning,     // think
    Planning,      // plan
    Memory,        // memory
    Tasks,         // tasks
    Tracker,       // tracker
    Coding,        // coding
    Research,      // research
    Skills,        // skills
    Platform,      // hanzo
    Configuration, // legacy alias category
}

/// Tool registry entry
pub struct ToolEntry {
    pub name: String,
    pub description: String,
    pub category: ToolCategory,
}

/// Get all available tools (HIP-0300 canonical 19-tool surface)
pub fn list_tools() -> Vec<ToolEntry> {
    vec![
        ToolEntry { name: "fs".into(), description: "Local filesystem & native tgrep search".into(), category: ToolCategory::FileSystem },
        ToolEntry { name: "exec".into(), description: "Process execution, background jobs & npx/uvx runners".into(), category: ToolCategory::Execution },
        ToolEntry { name: "code".into(), description: "AST symbols, LSP, refactoring, jq & Cloud RAG".into(), category: ToolCategory::Semantics },
        ToolEntry { name: "git".into(), description: "Git operations".into(), category: ToolCategory::VersionControl },
        ToolEntry { name: "fetch".into(), description: "HTTP requests, web search, markdown reader & vision".into(), category: ToolCategory::Network },
        ToolEntry { name: "workspace".into(), description: "Project discovery, config, mode & host system info".into(), category: ToolCategory::Workspace },
        ToolEntry { name: "browser".into(), description: "Web browser & CDP automation over ZAP".into(), category: ToolCategory::Browser },
        ToolEntry { name: "computer".into(), description: "Native OS desktop GUI & GIMP control".into(), category: ToolCategory::Computer },
        ToolEntry { name: "ui".into(), description: "@hanzo/ui & @hanzo/gui component registry".into(), category: ToolCategory::Ui },
        ToolEntry { name: "kai".into(), description: "Calibrated decisions, verified actions, compaction & guards".into(), category: ToolCategory::Decision },
        ToolEntry { name: "think".into(), description: "Structured reasoning, consensus, LLM & sub-agent delegation".into(), category: ToolCategory::Reasoning },
        ToolEntry { name: "plan".into(), description: "Execution plan creation & step tracking".into(), category: ToolCategory::Planning },
        ToolEntry { name: "memory".into(), description: "Persistent memory & recall".into(), category: ToolCategory::Memory },
        ToolEntry { name: "tasks".into(), description: "Local private session todo list".into(), category: ToolCategory::Tasks },
        ToolEntry { name: "tracker".into(), description: "Cloud /v1/tracker boards & work items".into(), category: ToolCategory::Tracker },
        ToolEntry { name: "coding".into(), description: "Cloud /v1/agent/coding autonomous runs".into(), category: ToolCategory::Coding },
        ToolEntry { name: "research".into(), description: "Hanzo Science /v1/research studies, runs, ledger & cited search".into(), category: ToolCategory::Research },
        ToolEntry { name: "skills".into(), description: "Hanzo Skills search, detection & SKILL.md installer".into(), category: ToolCategory::Skills },
        ToolEntry { name: "hanzo".into(), description: "Unified Hanzo Cloud router (auth, iam, kms/vault, connectors, 120+ services)".into(), category: ToolCategory::Platform },
    ]
}

/// Tool parity status across implementations
pub fn parity_status() -> serde_json::Value {
    let names: Vec<&str> = crate::CANONICAL_TOOLS.to_vec();
    serde_json::json!({
        "hip": "0300",
        "rust_version": env!("CARGO_PKG_VERSION"),
        "tools_implemented": names.len(),
        "surface": names,
        "cloud": {
            "backend": "https://api.hanzo.ai",
            "auth": "HANZO_API_KEY / HANZO_USER_KEY, else hanzo auth token, else ~/.hanzo/config.json .apiKey"
        },
        "notes": "Canonical 19-tool HIP-0300 surface (one and one way to do everything) identical across Rust, TypeScript, and Python."
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_tools() {
        let tools = list_tools();
        assert_eq!(tools.len(), 19);

        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names.as_slice(), crate::CANONICAL_TOOLS);
    }

    #[test]
    fn test_parity_status() {
        let status = parity_status();
        assert_eq!(status["tools_implemented"], 19);
        assert_eq!(status["hip"], "0300");
    }
}
