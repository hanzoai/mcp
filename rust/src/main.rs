use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use hanzo_mcp::{Config, MCPServer};
use log::info;
use std::path::PathBuf;

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
enum Transport {
    /// Newline-delimited JSON-RPC over stdin/stdout (default; spawned by the CLI)
    Stdio,
    /// Server-Sent Events over HTTP
    Sse,
    /// JSON-RPC over HTTP
    Http,
}

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

    /// Transport to serve on
    #[clap(short, long, value_enum, default_value_t = Transport::Stdio)]
    transport: Transport,

    /// Filesystem root the server may operate under (repeatable)
    #[clap(long)]
    project_dir: Vec<PathBuf>,

    /// Port to listen on (http/sse transports)
    #[clap(short, long, default_value = "3333")]
    port: u16,

    #[clap(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Print this user's browser pairing code, for a browser that cannot start
    /// the native host and is not admitted by origin (snap or Flatpak Firefox,
    /// Safari): paste it into the extension's popup.
    Pair {
        /// Mint a new code on a new port; every paired browser pairs again.
        #[clap(long)]
        reset: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    // Started by a browser as its native messaging host: relay, nothing else.
    if hanzo_mcp::native::invoked() {
        return hanzo_mcp::native::relay(std::io::stdin(), std::io::stdout());
    }
    let args = Args::parse();
    if let Some(Cmd::Pair { reset }) = args.command {
        let p = if reset { zapd::pair::reset()? } else { zapd::pair::load()? };
        println!("{}", p.code());
        return Ok(());
    }

    // On stdio, logs must never pollute the JSON-RPC stream on stdout.
    let log_target = if args.transport == Transport::Stdio {
        env_logger::Target::Stderr
    } else {
        env_logger::Target::Stdout
    };
    let filter = if args.debug { "debug" } else { "info" };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(filter))
        .target(log_target)
        .init();

    info!("Starting Hanzo MCP Server v{}", env!("CARGO_PKG_VERSION"));

    let config = if args.config.exists() {
        Config::from_file(&args.config)?
    } else {
        Config::default()
    };

    // Stand for this user's ZAP router and take our seat on it, as every
    // hanzo-mcp does: the browser tools reach the extension through it.
    hanzo_mcp::zap::seat();
    match hanzo_mcp::native::install() {
        Ok(written) => written.iter().for_each(|m| info!("[ZAP] native host registered: {}", m.display())),
        Err(e) => log::warn!("[ZAP] native host not registered: {e}"),
    }

    let mut server = MCPServer::new(config, args.port)?;
    for root in args.project_dir {
        server.allow_root(root);
    }

    match args.transport {
        Transport::Stdio => server.run_stdio().await?,
        Transport::Http | Transport::Sse => {
            info!("[MCP] JSON-RPC HTTP on http://127.0.0.1:{}", args.port);
            server.run().await?;
        }
    }

    Ok(())
}
