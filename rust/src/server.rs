use crate::{Config, ToolRegistry};
use anyhow::Result;
use jsonrpc_core::{IoHandler, Params, Value};
use jsonrpc_http_server::{ServerBuilder, Server};
use log::{debug, info, error};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct MCPServer {
    config: Config,
    port: u16,
    tools: Arc<RwLock<ToolRegistry>>,
    handler: IoHandler,
}

impl MCPServer {
    pub fn new(config: Config, port: u16) -> Result<Self> {
        let tools = Arc::new(RwLock::new(ToolRegistry::with_defaults()));
        let mut handler = IoHandler::new();
        
        // Clone for move into closures
        let tools_clone = tools.clone();
        
        // Initialize method
        handler.add_method("initialize", move |params: Params| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                debug!("Received initialize request: {:?}", params);
                
                let tools = tools.read().await;
                let tool_list = tools.list();
                
                Ok(json!({
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "hanzo-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "tools": {},
                        "resources": {},
                        "prompts": {}
                    }
                }))
            })
        });
        
        // List tools method
        let tools_clone = tools.clone();
        handler.add_method("tools/list", move |_params: Params| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                let tools = tools.read().await;
                let mut tool_list = Vec::new();
                
                for name in tools.list() {
                    if let Some(tool) = tools.get(&name) {
                        tool_list.push(json!({
                            "name": tool.name(),
                            "description": tool.description(),
                            "inputSchema": tool.parameters()
                        }));
                    }
                }
                
                Ok(json!({
                    "tools": tool_list
                }))
            })
        });
        
        // Call tool method
        let tools_clone = tools.clone();
        handler.add_method("tools/call", move |params: Params| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                let params = params.parse::<serde_json::Value>()
                    .map_err(|e| jsonrpc_core::Error::invalid_params(e.to_string()))?;
                
                let tool_name = params["name"].as_str()
                    .ok_or_else(|| jsonrpc_core::Error::invalid_params("Missing tool name"))?;
                
                let tool_params = params.get("arguments").cloned().unwrap_or(json!({}));
                
                let tools = tools.read().await;
                let tool = tools.get(tool_name)
                    .ok_or_else(|| jsonrpc_core::Error::invalid_params(format!("Unknown tool: {}", tool_name)))?;
                
                match tool.execute(tool_params).await {
                    Ok(result) => {
                        Ok(json!({
                            "content": [{
                                "type": "text",
                                "text": serde_json::to_string(&result.content).unwrap_or_default()
                            }]
                        }))
                    },
                    Err(e) => {
                        error!("Tool execution failed: {}", e);
                        Ok(json!({
                            "content": [{
                                "type": "text",
                                "text": format!("Error: {}", e)
                            }],
                            "isError": true
                        }))
                    }
                }
            })
        });
        
        // List resources method
        handler.add_method("resources/list", |_params: Params| {
            Box::pin(async move {
                Ok(json!({
                    "resources": []
                }))
            })
        });
        
        // List prompts method
        handler.add_method("prompts/list", |_params: Params| {
            Box::pin(async move {
                Ok(json!({
                    "prompts": []
                }))
            })
        });
        
        // Ping method for health checks
        handler.add_method("ping", |_params: Params| {
            Box::pin(async move {
                Ok(json!("pong"))
            })
        });
        
        Ok(Self {
            config,
            port,
            tools,
            handler,
        })
    }
    
    pub async fn run(self) -> Result<()> {
        let server = ServerBuilder::new(self.handler)
            .start_http(&format!("127.0.0.1:{}", self.port).parse()?)
            .map_err(|e| anyhow::anyhow!("Failed to start server: {}", e))?;
        
        info!("MCP Server running on http://127.0.0.1:{}", self.port);
        
        // Keep server running
        server.wait();
        
        Ok(())
    }
    
    pub async fn add_tool(&self, tool: Box<dyn crate::MCPTool>) {
        let mut tools = self.tools.write().await;
        tools.register(tool);
    }
}