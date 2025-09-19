// Tool modules will be loaded from /Users/z/work/hanzo/tools/rust/*
// This module provides the integration point for the canonical tool implementations

pub mod personality;
pub mod mode_tool;

pub use mode_tool::{ModeTool, ModeToolArgs, ModeToolDefinition};
pub use personality::{ToolPersonality, PersonalityRegistry};

// These will be loaded from /Users/z/work/hanzo/tools/rust/* when available
// pub use computer_control::ComputerControlTool;
// pub use blockchain::BlockchainTool;
// pub use vector_store::VectorStoreTool;
// pub use file_system::FileSystemTool;
// pub use web_search::WebSearchTool;
// pub use code_execution::CodeExecutionTool;