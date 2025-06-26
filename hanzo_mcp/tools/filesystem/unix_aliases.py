"""Unix command aliases for common tools.

Provides familiar Unix command names that map to MCP tools.
"""

from typing import Dict, Type
from hanzo_mcp.tools.common.base import BaseTool


def get_unix_aliases() -> Dict[str, str]:
    """Get mapping of Unix commands to MCP tool names.
    
    Returns:
        Dictionary mapping Unix command names to MCP tool names
    """
    return {
        # File operations
        "ls": "list_directory",
        "cat": "read_file", 
        "head": "read_file",  # With line limit
        "tail": "read_file",  # With offset
        "cp": "copy_path",
        "mv": "move_path",
        "rm": "delete_path",
        "mkdir": "create_directory",
        "touch": "write_file",  # Create empty file
        
        # Search operations
        "grep": "find",  # Our unified find tool
        "find": "glob",  # For finding files by name
        "ffind": "find",  # Fast file content search
        "rg": "find",  # Ripgrep alias
        "ag": "find",  # Silver searcher alias
        "ack": "find",  # Ack alias
        
        # Directory operations
        "tree": "tree",  # Already named correctly
        "pwd": "get_working_directory",
        "cd": "change_directory",
        
        # Git operations (if git tools enabled)
        "git": "git_command",
        
        # Process operations
        "ps": "list_processes",
        "kill": "kill_process",
        
        # Archive operations
        "tar": "archive",
        "unzip": "extract",
        
        # Network operations
        "curl": "http_request",
        "wget": "download_file",
    }


class UnixAliasRegistry:
    """Registry for Unix command aliases."""
    
    def __init__(self):
        self.aliases = get_unix_aliases()
        
    def register_aliases(self, mcp_server, tools: Dict[str, BaseTool]) -> None:
        """Register Unix aliases for tools.
        
        Args:
            mcp_server: The MCP server instance
            tools: Dictionary of tool name to tool instance
        """
        for alias, tool_name in self.aliases.items():
            if tool_name in tools:
                tool = tools[tool_name]
                # Register the tool under its alias name
                self._register_alias(mcp_server, alias, tool)
                
    def _register_alias(self, mcp_server, alias: str, tool: BaseTool) -> None:
        """Register a single alias for a tool.
        
        Args:
            mcp_server: The MCP server instance
            alias: The Unix command alias
            tool: The tool instance
        """
        # Create a wrapper that preserves the original tool's functionality
        # but registers under the alias name
        original_name = tool.name
        original_description = tool.description
        
        # Temporarily change the tool's name for registration
        tool.name = alias
        tool.description = f"{original_description}\n\n(Unix alias for {original_name})"
        
        # Register the tool
        tool.register(mcp_server)
        
        # Restore original name
        tool.name = original_name
        tool.description = original_description