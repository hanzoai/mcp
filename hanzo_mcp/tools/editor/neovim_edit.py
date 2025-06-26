"""Open files in Neovim editor."""

import os
import subprocess
import shutil
from typing import Annotated, Optional, TypedDict, Unpack, final, override
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


FilePath = Annotated[
    str,
    Field(
        description="Path to the file to open",
        min_length=1,
    ),
]

LineNumber = Annotated[
    Optional[int],
    Field(
        description="Line number to jump to",
        default=None,
    ),
]

ColumnNumber = Annotated[
    Optional[int],
    Field(
        description="Column number to jump to",
        default=None,
    ),
]

ReadOnly = Annotated[
    bool,
    Field(
        description="Open file in read-only mode",
        default=False,
    ),
]

Split = Annotated[
    Optional[str],
    Field(
        description="Split mode: vsplit, split, tab",
        default=None,
    ),
]

Wait = Annotated[
    bool,
    Field(
        description="Wait for Neovim to exit before returning",
        default=True,
    ),
]

InTerminal = Annotated[
    bool,
    Field(
        description="Open in terminal (requires terminal that supports it)",
        default=True,
    ),
]


class NeovimEditParams(TypedDict, total=False):
    """Parameters for Neovim edit tool."""

    file_path: str
    line_number: Optional[int]
    column_number: Optional[int]
    read_only: bool
    split: Optional[str]
    wait: bool
    in_terminal: bool


@final
class NeovimEditTool(BaseTool):
    """Tool for opening files in Neovim."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the Neovim edit tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "neovim_edit"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Open files in Neovim editor with advanced options.

Open files at specific lines/columns, in different split modes, or read-only.
Integrates with your existing Neovim configuration.

Examples:
- neovim_edit --file-path main.py
- neovim_edit --file-path main.py --line-number 42
- neovim_edit --file-path main.py --line-number 42 --column-number 10
- neovim_edit --file-path config.json --read-only
- neovim_edit --file-path test.py --split vsplit
- neovim_edit --file-path README.md --split tab

Split modes:
- vsplit: Open in vertical split
- split: Open in horizontal split  
- tab: Open in new tab

Note: Requires Neovim to be installed and available in PATH.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[NeovimEditParams],
    ) -> str:
        """Open file in Neovim.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of the operation
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        file_path = params.get("file_path")
        if not file_path:
            return "Error: file_path is required"

        line_number = params.get("line_number")
        column_number = params.get("column_number")
        read_only = params.get("read_only", False)
        split = params.get("split")
        wait = params.get("wait", True)
        in_terminal = params.get("in_terminal", True)

        # Check if Neovim is available
        nvim_cmd = shutil.which("nvim")
        if not nvim_cmd:
            # Try common locations
            common_paths = [
                "/usr/local/bin/nvim",
                "/usr/bin/nvim",
                "/opt/homebrew/bin/nvim",
                os.path.expanduser("~/.local/bin/nvim"),
            ]
            for path in common_paths:
                if os.path.exists(path):
                    nvim_cmd = path
                    break
            
            if not nvim_cmd:
                return """Error: Neovim (nvim) not found. Install it with:

On macOS:
brew install neovim

On Ubuntu/Debian:
sudo apt install neovim

On Arch:
sudo pacman -S neovim

Or visit: https://neovim.io/"""

        # Convert to absolute path
        file_path = os.path.abspath(file_path)
        
        # Check permissions
        if not self.permission_manager.has_permission(file_path):
            return f"Error: No permission to access {file_path}"

        # Build Neovim command
        cmd = [nvim_cmd]
        
        # Add read-only flag
        if read_only:
            cmd.append("-R")
        
        # Add split mode
        if split:
            if split == "vsplit":
                cmd.extend(["-c", "vsplit"])
            elif split == "split":
                cmd.extend(["-c", "split"])
            elif split == "tab":
                cmd.extend(["-c", "tabnew"])
            else:
                return f"Error: Invalid split mode '{split}'. Use 'vsplit', 'split', or 'tab'"
        
        # Add file path
        cmd.append(file_path)
        
        # Add line/column positioning
        if line_number:
            if column_number:
                # Go to specific line and column
                cmd.extend(["+call cursor({}, {})".format(line_number, column_number)])
            else:
                # Go to specific line
                cmd.append(f"+{line_number}")
        
        await tool_ctx.info(f"Opening {file_path} in Neovim")
        
        try:
            # Determine how to run Neovim
            if in_terminal and not wait:
                # Open in a new terminal window (platform-specific)
                if os.uname().sysname == "Darwin":  # macOS
                    # Try to use iTerm2 if available, otherwise Terminal
                    if shutil.which("osascript"):
                        # Build AppleScript to open in iTerm2 or Terminal
                        nvim_cmd_str = " ".join(f'"{arg}"' for arg in cmd)
                        
                        # Try iTerm2 first
                        applescript = f'''tell application "System Events"
                            if exists application process "iTerm2" then
                                tell application "iTerm"
                                    activate
                                    tell current window
                                        create tab with default profile
                                        tell current session
                                            write text "{nvim_cmd_str}"
                                        end tell
                                    end tell
                                end tell
                            else
                                tell application "Terminal"
                                    activate
                                    do script "{nvim_cmd_str}"
                                end tell
                            end if
                        end tell'''
                        
                        subprocess.run(["osascript", "-e", applescript])
                        return f"Opened {file_path} in Neovim (new terminal window)"
                
                elif shutil.which("gnome-terminal"):
                    # Linux with GNOME
                    subprocess.Popen(["gnome-terminal", "--"] + cmd)
                    return f"Opened {file_path} in Neovim (new terminal window)"
                
                elif shutil.which("xterm"):
                    # Fallback to xterm
                    subprocess.Popen(["xterm", "-e"] + cmd)
                    return f"Opened {file_path} in Neovim (new terminal window)"
                
                else:
                    # Can't open in terminal, fall back to subprocess
                    subprocess.Popen(cmd)
                    return f"Opened {file_path} in Neovim (background process)"
            
            else:
                # Run and wait for completion
                result = subprocess.run(cmd)
                
                if result.returncode == 0:
                    return f"Successfully edited {file_path} in Neovim"
                else:
                    return f"Neovim exited with code {result.returncode}"
        
        except Exception as e:
            await tool_ctx.error(f"Failed to open Neovim: {str(e)}")
            return f"Error opening Neovim: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
