use anyhow::Result;
use clap::Parser;
use env_logger;
use hanzo_mcp::{Config, MCPServer};
use log::info;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[clap(
    name = "hanzo-mcp",
    version = "0.1.0",
    about = "Hanzo MCP Server - Rust implementation with computer control, blockchain, and tool coordination"
)]
struct Args {
    /// Path to configuration file
    #[clap(short, long, default_value = "~/.hanzo/mcp.toml")]
    config: PathBuf,

    /// Enable debug logging
    #[clap(short, long)]
    debug: bool,

    /// Port to listen on
    #[clap(short, long, default_value = "3333")]
    port: u16,

    /// Connect to existing hanzo-node if running
    #[clap(long)]
    connect_node: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    if args.debug {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
            .init();
    } else {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .init();
    }

    info!("Starting Hanzo MCP Server v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let config = if args.config.exists() {
        Config::from_file(&args.config)?
    } else {
        Config::default()
    };

    // Check if hanzo-node is running and connect if requested
    if args.connect_node {
        if let Ok(node_status) = check_hanzo_node().await {
            info!("Connected to hanzo-node: {}", node_status);
        } else {
            info!("hanzo-node not found, running standalone");
        }
    }

    // Create and start MCP server
    let server = MCPServer::new(config, args.port)?;
    
    info!("MCP Server listening on port {}", args.port);
    info!("Available tools:");
    info!("  - computer_control: Screenshot, mouse, keyboard control");
    info!("  - blockchain: Ethereum/Web3 operations and payments");
    info!("  - vector_store: Shared embeddings and semantic search");
    info!("  - file_system: File operations and search");
    info!("  - web_search: Web scraping and search");
    info!("  - code_execution: Safe code execution sandbox");
    
    server.run().await?;

    Ok(())
}

async fn check_hanzo_node() -> Result<String> {
    // Check if hanzo-node is running by looking for its process or API
    // This would connect to the hanzo-node's management API if available
    
    // Try to connect to default hanzo-node management port
    if let Ok(response) = reqwest::get("http://localhost:9999/status").await {
        if response.status().is_success() {
            return Ok("Connected to hanzo-node on localhost:9999".to_string());
        }
    }
    
    // Check for hanzod process
    use std::process::Command;
    let output = Command::new("pgrep")
        .arg("-f")
        .arg("hanzod")
        .output()?;
    
    if output.status.success() && !output.stdout.is_empty() {
        return Ok("hanzo-node process detected".to_string());
    }
    
    Err(anyhow::anyhow!("hanzo-node not found"))
}