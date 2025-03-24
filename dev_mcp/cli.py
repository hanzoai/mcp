"""Command-line interface for the MCP Claude Code server."""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, cast

from dev_mcp.server import HanzoDevServer


def main() -> None:
    """Run the CLI for the MCP Claude Code server."""
    parser = argparse.ArgumentParser(
        description="MCP server implementing Claude Code capabilities"
    )

    _ = parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )

    _ = parser.add_argument(
        "--name",
        default="claude-code",
        help="Name of the MCP server (default: claude-code)",
    )

    _ = parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
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

    # Run the server
    server = HanzoDevServer(name=name, allowed_paths=allowed_paths)
    # Transport will be automatically cast to Literal['stdio', 'sse'] by the server
    server.run(transport=transport)


def install_claude_desktop_config(
    name: str = "claude-code", allowed_paths: list[str] | None = None
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
    args: list[str] = ["-m", "dev_mcp.cli"]

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
