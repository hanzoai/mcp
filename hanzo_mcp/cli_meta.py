"""Command-line interface for the Meta MCP Server."""

import os
import sys
import json
import argparse
import asyncio
from typing import List, Optional, Dict, Any

from hanzo_mcp.meta_mcp import MetaMCPServer


def parse_args():
    """Parse command-line arguments.
    
    Returns:
        Parsed arguments
    """
    parser = argparse.ArgumentParser(
        description="Meta MCP Server for Hanzo MCP"
    )
    
    parser.add_argument(
        "--name",
        default="hanzo-meta",
        help="Name of the Meta MCP Server (default: hanzo-meta)"
    )
    
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)"
    )
    
    parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)"
    )
    
    parser.add_argument(
        "--config",
        type=str,
        help="Path to Meta MCP Server configuration file (JSON)"
    )
    
    parser.add_argument(
        "--disable-proxy-tools",
        action="store_true",
        help="Disable proxy tools for sub-MCP servers"
    )
    
    parser.add_argument(
        "--disable-auto-start",
        action="store_true",
        help="Disable automatic starting of sub-MCP servers"
    )
    
    return parser.parse_args()


def load_config(config_path: Optional[str]) -> tuple[Dict[str, Any], Dict[str, Dict[str, Any]]]:
    """Load configuration from a JSON file.
    
    Args:
        config_path: Path to the configuration file
        
    Returns:
        Tuple of (mcp_config, sub_mcps_config)
    """
    mcp_config = {}
    sub_mcps_config = {}
    
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                config = json.load(f)
                mcp_config = config.get("mcp", {})
                sub_mcps_config = config.get("sub_mcps", {})
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error loading configuration file: {e}")
    
    return mcp_config, sub_mcps_config


async def async_main():
    """Async main function."""
    args = parse_args()
    
    # Load configuration from file if provided
    mcp_config, sub_mcps_config = load_config(args.config)
    
    # Create the Meta MCP Server
    meta_server = MetaMCPServer(
        name=args.name,
        allowed_paths=args.allowed_paths,
        mcp_config=mcp_config,
        sub_mcps_config=sub_mcps_config,
        enable_proxy_tools=not args.disable_proxy_tools,
        auto_start_sub_mcps=not args.disable_auto_start
    )
    
    # Start sub-MCP servers
    await meta_server.start()
    
    # Return the server for further use
    return meta_server


def main():
    """Main function."""
    # Parse arguments and create the Meta MCP Server
    meta_server = asyncio.run(async_main())
    
    try:
        # Run the server
        meta_server.run()
    except KeyboardInterrupt:
        print("\nReceived keyboard interrupt, shutting down...")
    finally:
        # Clean up resources
        meta_server.cleanup()


if __name__ == "__main__":
    main()
