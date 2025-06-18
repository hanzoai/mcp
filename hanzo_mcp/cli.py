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
        description="MCP server implementing Hanzo AI capabilities"
    )

    _ = parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport protocol to use (default: stdio)",
    )

    _ = parser.add_argument(
        "--name",
        default="hanzo-mcp",
        help="Name of the MCP server (default: hanzo-mcp)",
    )

    _ = parser.add_argument(
        "--allow-path",
        action="append",
        dest="allowed_paths",
        help="Add an allowed path (can be specified multiple times)",
    )

    _ = parser.add_argument(
        "--project",
        action="append",
        dest="project_paths",
        help="Add a project path for prompt generation (can be specified multiple times)",
    )

    _ = parser.add_argument(
        "--agent-model",
        dest="agent_model",
        help="Specify the model name in LiteLLM format (e.g., 'openai/gpt-4o', 'anthropic/claude-4-sonnet')",
    )

    _ = parser.add_argument(
        "--agent-max-tokens",
        dest="agent_max_tokens",
        type=int,
        help="Specify the maximum tokens for agent responses",
    )

    _ = parser.add_argument(
        "--agent-api-key",
        dest="agent_api_key",
        help="Specify the API key for the LLM provider (for development/testing only)",
    )

    _ = parser.add_argument(
        "--agent-base-url",
        dest="agent_base_url",
        help="Specify the base URL for the LLM provider API endpoint (e.g., 'http://localhost:1234/v1')",
    )

    _ = parser.add_argument(
        "--agent-max-iterations",
        dest="agent_max_iterations",
        type=int,
        default=10,
        help="Maximum number of iterations for agent (default: 10)",
    )

    _ = parser.add_argument(
        "--agent-max-tool-uses",
        dest="agent_max_tool_uses",
        type=int,
        default=30,
        help="Maximum number of total tool uses for agent (default: 30)",
    )

    _ = parser.add_argument(
        "--enable-agent-tool",
        dest="enable_agent_tool",
        action="store_true",
        default=False,
        help="Enable the agent tool (disabled by default)",
    )

    _ = parser.add_argument(
        "--command-timeout",
        dest="command_timeout",
        type=float,
        default=120.0,
        help="Default timeout for command execution in seconds (default: 120.0)",
    )

    _ = parser.add_argument(
        "--disable-write-tools",
        dest="disable_write_tools",
        action="store_true",
        default=False,
        help="Disable write tools (edit, write, etc.)",
    )

    _ = parser.add_argument(
        "--disable-search-tools",
        dest="disable_search_tools",
        action="store_true",
        default=False,
        help="Disable search tools (grep, search_content, etc.)",
    )

    _ = parser.add_argument(
        "--host",
        dest="host",
        default="127.0.0.1",
        help="Host for SSE server (default: 127.0.0.1)",
    )

    _ = parser.add_argument(
        "--port",
        dest="port",
        type=int,
        default=3000,
        help="Port for SSE server (default: 3000)",
    )

    _ = parser.add_argument(
        "--log-level",
        dest="log_level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level (default: INFO)",
    )

    _ = parser.add_argument(
        "--project-dir",
        dest="project_dir",
        help="Single project directory (alias for --project)",
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
    agent_model: str | None = cast(str | None, args.agent_model)
    agent_max_tokens: int | None = cast(int | None, args.agent_max_tokens)
    agent_api_key: str | None = cast(str | None, args.agent_api_key)
    agent_base_url: str | None = cast(str | None, args.agent_base_url)
    agent_max_iterations: int = cast(int, args.agent_max_iterations)
    agent_max_tool_uses: int = cast(int, args.agent_max_tool_uses)
    enable_agent_tool: bool = cast(bool, args.enable_agent_tool)
    command_timeout: float = cast(float, args.command_timeout)
    disable_write_tools: bool = cast(bool, args.disable_write_tools)
    disable_search_tools: bool = cast(bool, args.disable_search_tools)
    host: str = cast(str, args.host)
    port: int = cast(int, args.port)
    log_level: str = cast(str, args.log_level)
    project_dir: str | None = cast(str | None, args.project_dir)
    allowed_paths: list[str] = (
        cast(list[str], args.allowed_paths) if args.allowed_paths else []
    )
    project_paths: list[str] = (
        cast(list[str], args.project_paths) if args.project_paths else []
    )

    # Handle project_dir parameter (add to both allowed_paths and project_paths)
    if project_dir:
        if project_dir not in allowed_paths:
            allowed_paths.append(project_dir)
        if project_dir not in project_paths:
            project_paths.append(project_dir)

    if install:
        install_claude_desktop_config(
            name, 
            allowed_paths, 
            disable_write_tools, 
            disable_search_tools, 
            host, 
            port
        )
        return

    # If no allowed paths are specified, use the current directory
    if not allowed_paths:
        allowed_paths = [os.getcwd()]

    # Run the server
    server = HanzoMCPServer(
        name=name,
        allowed_paths=allowed_paths,
        project_dir=project_dir,
        agent_model=agent_model,
        agent_max_tokens=agent_max_tokens,
        agent_api_key=agent_api_key,
        agent_base_url=agent_base_url,
        agent_max_iterations=agent_max_iterations,
        agent_max_tool_uses=agent_max_tool_uses,
        enable_agent_tool=enable_agent_tool,
        disable_write_tools=disable_write_tools,
        disable_search_tools=disable_search_tools,
        host=host,
        port=port,
    )
    # Transport will be automatically cast to Literal['stdio', 'sse'] by the server
    server.run(transport=transport)


def install_claude_desktop_config(
    name: str = "hanzo-mcp",
    allowed_paths: list[str] | None = None,
    disable_write_tools: bool = False,
    disable_search_tools: bool = False,
    host: str = "127.0.0.1",
    port: int = 3000,
) -> None:
    """Install the server configuration in Claude Desktop.

    Args:
        name: The name to use for the server in the config
        allowed_paths: Optional list of paths to allow
        disable_write_tools: Whether to disable write tools
        disable_search_tools: Whether to disable search tools
        host: Host for SSE server
        port: Port for SSE server
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

    # Add tool disable flags if specified
    if disable_write_tools:
        args.append("--disable-write-tools")
    
    if disable_search_tools:
        args.append("--disable-search-tools")

    # Create config object
    config: dict[str, Any] = {
        "mcpServers": {name: {"command": script_path.as_posix(), "args": args}}
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

    print(
        "\nYou can modify allowed paths in the config file directly."
    )
    print("Restart Claude Desktop for changes to take effect.")


if __name__ == "__main__":
    main()
