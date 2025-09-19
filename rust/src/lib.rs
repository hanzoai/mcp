pub mod config;
pub mod server;
pub mod protocol;
pub mod tools;

pub use config::Config;
pub use server::MCPServer;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// Tool registry for managing all available tools
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn MCPTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }
    
    pub fn register(&mut self, tool: Box<dyn MCPTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }
    
    pub fn get(&self, name: &str) -> Option<&Box<dyn MCPTool>> {
        self.tools.get(name)
    }
    
    pub fn list(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }
    
    /// Initialize with all default tools
    pub fn with_defaults() -> Self {
        let registry = Self::new();
        
        // Register computer control tool
        #[cfg(feature = "computer-control")]
        {
            use computer_control::ComputerControlTool;
            registry.register(Box::new(ComputerControlTool::new()));
        }
        
        // Register blockchain tool
        #[cfg(feature = "blockchain")]
        {
            use blockchain::BlockchainTool;
            registry.register(Box::new(BlockchainTool::new()));
        }
        
        // Register vector store tool
        #[cfg(feature = "vector-store")]
        {
            use vector_store::VectorStoreTool;
            registry.register(Box::new(VectorStoreTool::new()));
        }
        
        // Register file system tool
        #[cfg(feature = "file-system")]
        {
            use file_system::FileSystemTool;
            registry.register(Box::new(FileSystemTool::new()));
        }
        
        // Register web search tool
        #[cfg(feature = "web-search")]
        {
            use web_search::WebSearchTool;
            registry.register(Box::new(WebSearchTool::new()));
        }
        
        // Register code execution tool
        #[cfg(feature = "code-execution")]
        {
            use code_execution::CodeExecutionTool;
            registry.register(Box::new(CodeExecutionTool::new()));
        }
        
        registry
    }
}