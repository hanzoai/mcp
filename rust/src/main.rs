use anyhow::Result;
use clap::Parser;
use hanzo_mcp::{Config, MCPServer};
use log::info;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[clap(
    name = "hanzo-mcp",
    version = env!("CARGO_PKG_VERSION"),
    about = "Hanzo MCP Server — 13 HIP-0300 tools over MCP (JSON-RPC)"
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
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    if args.debug {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
            .init();
    } else {
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .init();
    }

    info!("Starting Hanzo MCP Server v{}", env!("CARGO_PKG_VERSION"));

    let config = if args.config.exists() {
        Config::from_file(&args.config)?
    } else {
        Config::default()
    };

    let server = MCPServer::new(config, args.port)?;
    info!("[MCP] JSON-RPC HTTP on http://127.0.0.1:{}", args.port);

    server.run().await?;

    Ok(())
}
