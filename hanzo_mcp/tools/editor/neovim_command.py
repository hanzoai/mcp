"""Execute Neovim commands and macros."""

import os
import subprocess
import shutil
import tempfile
from typing import Annotated, Optional, TypedDict, Unpack, final, override, List

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.common.permissions import PermissionManager


Command = Annotated[
    Optional[str],
    Field(
        description="Neovim command to execute (Ex commands like :w, :q, etc.)",
        default=None,
    ),
]

Commands = Annotated[
    Optional[List[str]],
    Field(
        description="List of Neovim commands to execute in sequence",
        default=None,
    ),
]

Macro = Annotated[
    Optional[str],
    Field(
        description="Vim macro to execute (e.g., 'dd' to delete line)",
        default=None,
    ),
]

FilePath = Annotated[
    Optional[str],
    Field(
        description="File to operate on (optional, uses current buffer if not specified)",
        default=None,
    ),
]

SaveAfter = Annotated[
    bool,
    Field(
        description="Save file after executing commands",
        default=True,
    ),
]

ReturnOutput = Annotated[
    bool,
    Field(
        description="Return output/messages from Neovim",
        default=True,
    ),
]


class NeovimCommandParams(TypedDict, total=False):
    """Parameters for Neovim command tool."""

    command: Optional[str]
    commands: Optional[List[str]]
    macro: Optional[str]
    file_path: Optional[str]
    save_after: bool
    return_output: bool


@final
class NeovimCommandTool(BaseTool):
    """Tool for executing Neovim commands and macros."""

    def __init__(self, permission_manager: PermissionManager):
        """Initialize the Neovim command tool.

        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager = permission_manager

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "neovim_command"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Execute Neovim commands and macros programmatically.

Run Ex commands, normal mode commands, or complex macros in Neovim.
Can operate on files without opening the editor interface.

Examples:
- neovim_command --command ":set number" --file-path main.py
- neovim_command --command ":%s/old/new/g" --file-path config.json
- neovim_command --commands ":set expandtab" ":retab" --file-path script.sh
- neovim_command --macro "ggVG=" --file-path messy.py  # Format entire file
- neovim_command --macro "dd10j" --file-path list.txt  # Delete line and go down 10

Common commands:
- :w - Save file
- :q - Quit
- :%s/old/new/g - Replace all occurrences
- :set number - Show line numbers
- :set expandtab - Use spaces instead of tabs
- :retab - Convert tabs to spaces

Common macros:
- gg - Go to beginning of file
- G - Go to end of file
- dd - Delete line
- yy - Yank (copy) line
- p - Paste
- V - Visual line mode
- = - Format/indent

Note: Requires Neovim to be installed.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[NeovimCommandParams],
    ) -> str:
        """Execute Neovim command.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of the command execution
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        command = params.get("command")
        commands = params.get("commands")
        macro = params.get("macro")
        file_path = params.get("file_path")
        save_after = params.get("save_after", True)
        return_output = params.get("return_output", True)

        # Validate inputs
        if not any([command, commands, macro]):
            return "Error: Must provide either 'command', 'commands', or 'macro'"

        if sum(bool(x) for x in [command, commands, macro]) > 1:
            return "Error: Can only use one of 'command', 'commands', or 'macro' at a time"

        # Check if Neovim is available
        nvim_cmd = shutil.which("nvim")
        if not nvim_cmd:
            return "Error: Neovim (nvim) not found. Install it first."

        # Prepare commands list
        nvim_commands = []
        
        if command:
            nvim_commands.append(command)
        elif commands:
            nvim_commands.extend(commands)
        elif macro:
            # Convert macro to normal mode command
            # Escape special characters
            escaped_macro = macro.replace('"', '\\"')
            nvim_commands.append(f':normal "{escaped_macro}"')
        
        # Add save command if requested
        if save_after:
            nvim_commands.append(":w")
        
        # Always quit at the end
        nvim_commands.append(":q")

        # Build Neovim command line
        cmd = [nvim_cmd, "-n", "-i", "NONE"]  # No swap file, no shada file
        
        # Add commands
        for vim_cmd in nvim_commands:
            cmd.extend(["-c", vim_cmd])
        
        # Add file if specified
        if file_path:
            file_path = os.path.abspath(file_path)
            
            # Check permissions
            if not self.permission_manager.has_permission(file_path):
                return f"Error: No permission to access {file_path}"
            
            if not os.path.exists(file_path):
                return f"Error: File not found: {file_path}"
            
            cmd.append(file_path)
        else:
            # Create empty buffer
            cmd.append("-")
        
        await tool_ctx.info(f"Executing Neovim commands: {nvim_commands}")
        
        try:
            # Execute Neovim
            if return_output:
                # Capture output by redirecting messages
                output_file = tempfile.NamedTemporaryFile(mode='w+', delete=False)
                output_file.close()
                
                # Add command to redirect messages
                cmd.insert(3, "-c")
                cmd.insert(4, f":redir! > {output_file.name}")
                
                # Execute
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True
                )
                
                # Read output
                output_content = ""
                try:
                    with open(output_file.name, 'r') as f:
                        output_content = f.read().strip()
                finally:
                    os.unlink(output_file.name)
                
                if result.returncode == 0:
                    response = "Commands executed successfully"
                    if file_path:
                        response += f" on {os.path.basename(file_path)}"
                    if output_content:
                        response += f"\n\nOutput:\n{output_content}"
                    return response
                else:
                    error_msg = "Error executing Neovim commands"
                    if result.stderr:
                        error_msg += f"\n\nError:\n{result.stderr}"
                    if output_content:
                        error_msg += f"\n\nOutput:\n{output_content}"
                    return error_msg
            else:
                # Just execute without capturing output
                result = subprocess.run(cmd)
                
                if result.returncode == 0:
                    response = "Commands executed successfully"
                    if file_path:
                        response += f" on {os.path.basename(file_path)}"
                    return response
                else:
                    return f"Neovim exited with code {result.returncode}"
        
        except Exception as e:
            await tool_ctx.error(f"Failed to execute Neovim commands: {str(e)}")
            return f"Error executing Neovim commands: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
