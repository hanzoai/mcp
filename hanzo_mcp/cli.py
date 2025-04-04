"""Command-line interface for the Hanzo MCP server."""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, cast

from hanzo_mcp.server import HanzoMCPServer


def main() -> None:
    """Run the CLI for the Hanzo MCP server."""
    parser = argparse.ArgumentParser(
        description="MCP server for accessing Hanzo APIs and Platform capabilities"
    )

    _ = parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )

    _ = parser.add_argument(
        "--name",
        default="hanzo",
        help="Name of the MCP server (default: hanzo)",
    )

    _ = parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
    )

    # LLM Provider configuration
    _ = parser.add_argument(
        "--llm-provider",
        choices=["auto", "hanzo", "openai", "anthropic"],
        default="auto",
        help="LLM provider to use for enhanced thinking (default: auto)",
    )
    
    _ = parser.add_argument(
        "--enhanced-thinking",
        action="store_true",
        default=True,
        help="Enable enhanced thinking using external LLM (default: enabled)",
    )
    
    _ = parser.add_argument(
        "--external-servers",
        action="store_true",
        default=True,
        help="Enable external MCP servers (default: enabled)",
    )
    
    _ = parser.add_argument(
        "--mcp",
        action="append",
        dest="mcp_servers",
        help="Specify external MCP server command (can be used multiple times)",
    )
    
    _ = parser.add_argument(
        "--external-servers-config",
        help="Path to external MCP servers configuration file",
    )

    _ = parser.add_argument(
        "--project-dir", dest="project_dir", help="Set the project directory to analyze"
    )

    _ = parser.add_argument(
        "--install",
        action="store_true",
        help="Install server configuration in Claude Desktop",
    )

    args = parser.parse_args()

    # Cast args attributes to appropriate types to avoid 'Any' warnings
    name: str = cast(str, args.name)
    install: bool = cast(bool, args.install)
    transport: str = cast(str, args.transport)
    project_dir: str | None = cast(str | None, args.project_dir)
    allowed_paths: list[str] = (
        cast(list[str], args.allowed_paths) if args.allowed_paths else []
    )

    if install:
        install_claude_desktop_config(name, allowed_paths)
        return

    # If no allowed paths are specified, use the current directory
    if not allowed_paths:
        allowed_paths = [os.getcwd()]

    # If project directory is specified, add it to allowed paths
    if project_dir and project_dir not in allowed_paths:
        allowed_paths.append(project_dir)
        
    # Set LLM provider configuration
    os.environ["HANZO_MCP_LLM_PROVIDER"] = args.llm_provider
    os.environ["HANZO_MCP_ENHANCED_THINKING"] = str(args.enhanced_thinking).lower()
    
    # Set external servers configuration
    if args.external_servers_config:
        os.environ["HANZO_MCP_EXTERNAL_SERVERS_CONFIG"] = args.external_servers_config
    
    # Process direct MCP server specifications
    mcp_servers = args.mcp_servers
    if mcp_servers:
        # Create temporary config for these servers
        from hanzo_mcp.external.config_manager import MCPServerConfig
        config = MCPServerConfig()
        for i, server_cmd in enumerate(mcp_servers):
            parts = server_cmd.split()
            if len(parts) > 0:
                server_id = f"cli-server-{i+1}"
                config.set_server_config(server_id, {
                    "command": parts[0],
                    "args": parts[1:],
                    "enabled": True,
                    "description": f"CLI-specified MCP server: {server_cmd}"
                })
        config.save_config()

    # Run the server
    server = HanzoMCPServer(
        name=name, 
        allowed_paths=allowed_paths,
        enable_external_servers=args.external_servers
    )
    # Transport will be automatically cast to Literal['stdio', 'sse'] by the server
    server.run(transport=transport)


def install_claude_desktop_config(
    name: str = "hanzo", allowed_paths: list[str] | None = None
) -> None:
    """Install the server configuration in Claude Desktop.

    Args:
        name: The name to use for the server in the config
        allowed_paths: Optional list of paths to allow
    """
    # Find the Claude Desktop config directory
    home: Path = Path.home()

    if sys.platform == "darwin":  # macOS
        config_dir: Path = home / "Library" / "Application Support" / "Claude"
    elif sys.platform == "win32":  # Windows
        config_dir = Path(os.environ.get("APPDATA", "")) / "Claude"
    else:  # Linux and others
        config_dir = home / ".config" / "claude"

    config_file: Path = config_dir / "claude_desktop_config.json"

    # Create directory if it doesn't exist
    config_dir.mkdir(parents=True, exist_ok=True)

    # Get current script path
    script_path: Path = Path(sys.executable)

    # Create args array
    args: list[str] = ["-m", "hanzo_mcp.cli"]

    # Add allowed paths if specified
    if allowed_paths:
        for path in allowed_paths:
            args.extend(["--allow-path", path])
    else:
        # Allow home directory by default
        args.extend(["--allow-path", str(home)])

    # Create config object
    config: dict[str, Any] = {
        "mcpServers": {name: {"command": str(script_path), "args": args}}
    }

    # Check if the file already exists
    if config_file.exists():
        try:
            with open(config_file, "r") as f:
                existing_config: dict[str, Any] = json.load(f)

            # Update the existing config
            if "mcpServers" not in existing_config:
                existing_config["mcpServers"] = {}

            existing_config["mcpServers"][name] = config["mcpServers"][name]
            config = existing_config
        except Exception as e:
            print(f"Error reading existing config: {e}")
            print("Creating new config file.")

    # Write the config file
    with open(config_file, mode="w") as f:
        json.dump(config, f, indent=2)

    print(f"Successfully installed {name} in Claude Desktop configuration.")
    print(f"Config file: {config_file}")

    if allowed_paths:
        print("\nAllowed paths:")
        for path in allowed_paths:
            print(f"- {path}")
    else:
        print(f"\nDefault allowed path: {home}")
    print("\nYou can modify allowed paths in the config file directly.")
    print("Restart Claude Desktop for changes to take effect.")


if __name__ == "__main__":
    main()
