use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub tools: ToolsConfig,
    pub node: NodeConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub max_connections: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsConfig {
    pub computer_control: bool,
    pub blockchain: bool,
    pub vector_store: bool,
    pub file_system: bool,
    pub web_search: bool,
    pub code_execution: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    pub connect_to_hanzo_node: bool,
    pub node_api_url: String,
    pub node_api_key: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 3333,
                max_connections: 100,
            },
            tools: ToolsConfig {
                computer_control: true,
                blockchain: true,
                vector_store: true,
                file_system: true,
                web_search: true,
                code_execution: true,
            },
            node: NodeConfig {
                connect_to_hanzo_node: true,
                node_api_url: "http://localhost:9999".to_string(),
                node_api_key: None,
            },
        }
    }
}

impl Config {
    pub fn from_file(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
    
    pub fn save(&self, path: &Path) -> Result<()> {
        let content = toml::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}