"""Manage Neovim sessions."""

import os
import subprocess
import shutil
import json
from typing import Annotated, Optional, TypedDict, Unpack, final, override, List
from pathlib import Path
from datetime import datetime

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


Action = Annotated[
    str,
    Field(
        description="Action to perform: save, restore, list, delete",
        min_length=1,
    ),
]

SessionName = Annotated[
    Optional[str],
    Field(
        description="Name of the session",
        default=None,
    ),
]

ProjectPath = Annotated[
    Optional[str],
    Field(
        description="Project path (defaults to current directory)",
        default=None,
    ),
]

AutoName = Annotated[
    bool,
    Field(
        description="Auto-generate session name based on project and timestamp",
        default=False,
    ),
]

Overwrite = Annotated[
    bool,
    Field(
        description="Overwrite existing session",
        default=False,
    ),
]


class NeovimSessionParams(TypedDict, total=False):
    """Parameters for Neovim session tool."""

    action: str
    session_name: Optional[str]
    project_path: Optional[str]
    auto_name: bool
    overwrite: bool


@final
class NeovimSessionTool(BaseTool):
    """Tool for managing Neovim sessions."""

    def __init__(self):
        """Initialize the Neovim session tool."""
        self.session_dir = Path.home() / ".hanzo" / "neovim" / "sessions"
        self.session_dir.mkdir(parents=True, exist_ok=True)

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "neovim_session"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Save and restore Neovim editing sessions.

Manage Neovim sessions to save your workspace state including:
- Open files and buffers
- Window layouts and splits
- Cursor positions
- Marks and registers
- Local options and mappings

Actions:
- save: Save current Neovim session
- restore: Restore a saved session
- list: List all saved sessions
- delete: Delete a saved session

Examples:
- neovim_session --action save --session-name "feature-work"
- neovim_session --action save --auto-name  # Auto-generate name
- neovim_session --action restore --session-name "feature-work"
- neovim_session --action list
- neovim_session --action list --project-path /path/to/project
- neovim_session --action delete --session-name "old-session"

Sessions are stored in ~/.hanzo/neovim/sessions/
Project-specific sessions are automatically organized by project path.

Note: Requires Neovim to be installed.
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[NeovimSessionParams],
    ) -> str:
        """Manage Neovim session.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of the session operation
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        action = params.get("action")
        if not action:
            return "Error: action is required (save, restore, list, delete)"

        session_name = params.get("session_name")
        project_path = params.get("project_path") or os.getcwd()
        auto_name = params.get("auto_name", False)
        overwrite = params.get("overwrite", False)

        # Validate action
        valid_actions = ["save", "restore", "list", "delete"]
        if action not in valid_actions:
            return f"Error: Invalid action '{action}'. Must be one of: {', '.join(valid_actions)}"

        # Check if Neovim is available
        nvim_cmd = shutil.which("nvim")
        if not nvim_cmd and action in ["save", "restore"]:
            return "Error: Neovim (nvim) not found. Install it first."

        # Get project-specific session directory
        project_hash = str(hash(os.path.abspath(project_path)) % 10**8)
        project_name = os.path.basename(project_path) or "root"
        project_session_dir = self.session_dir / f"{project_name}_{project_hash}"
        project_session_dir.mkdir(exist_ok=True)

        # Handle different actions
        if action == "save":
            return await self._save_session(
                tool_ctx, session_name, project_session_dir, 
                auto_name, overwrite, project_path
            )
        elif action == "restore":
            return await self._restore_session(
                tool_ctx, session_name, project_session_dir
            )
        elif action == "list":
            return self._list_sessions(project_session_dir, project_path)
        elif action == "delete":
            return self._delete_session(session_name, project_session_dir)

    async def _save_session(
        self, tool_ctx, session_name: Optional[str], 
        project_dir: Path, auto_name: bool, overwrite: bool,
        project_path: str
    ) -> str:
        """Save Neovim session."""
        # Generate session name if needed
        if auto_name or not session_name:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            session_name = f"session_{timestamp}"
        
        # Sanitize session name
        session_name = session_name.replace("/", "_").replace(" ", "_")
        
        session_file = project_dir / f"{session_name}.vim"
        metadata_file = project_dir / f"{session_name}.json"
        
        # Check if exists
        if session_file.exists() and not overwrite:
            return f"Error: Session '{session_name}' already exists. Use --overwrite to replace."
        
        await tool_ctx.info(f"Saving Neovim session: {session_name}")
        
        # Create temporary vim script to save session
        vim_script = f'''
:mksession! {session_file}
:echo "Session saved to {session_file}"
:qa
'''
        
        try:
            # Run Neovim to save session
            # First, check if Neovim is already running
            # For now, we'll create a new instance
            result = subprocess.run(
                ["nvim", "-c", vim_script.strip()],
                capture_output=True,
                text=True
            )
            
            if result.returncode != 0 and result.stderr:
                return f"Error saving session: {result.stderr}"
            
            # Save metadata
            metadata = {
                "name": session_name,
                "created_at": datetime.now().isoformat(),
                "project_path": project_path,
                "description": f"Neovim session for {project_path}"
            }
            
            with open(metadata_file, 'w') as f:
                json.dump(metadata, f, indent=2)
            
            return f"""Successfully saved Neovim session '{session_name}'

Session file: {session_file}
Project: {project_path}

To restore this session:
neovim_session --action restore --session-name "{session_name}"

Or manually in Neovim:
:source {session_file}"""
            
        except Exception as e:
            return f"Error saving session: {str(e)}"

    async def _restore_session(
        self, tool_ctx, session_name: Optional[str], 
        project_dir: Path
    ) -> str:
        """Restore Neovim session."""
        if not session_name:
            # List available sessions
            sessions = list(project_dir.glob("*.vim"))
            if not sessions:
                return "Error: No sessions found for this project. Use 'neovim_session --action list' to see all sessions."
            
            # Use most recent
            sessions.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            session_file = sessions[0]
            session_name = session_file.stem
        else:
            session_file = project_dir / f"{session_name}.vim"
            if not session_file.exists():
                return f"Error: Session '{session_name}' not found. Use 'neovim_session --action list' to see available sessions."
        
        await tool_ctx.info(f"Restoring Neovim session: {session_name}")
        
        try:
            # Open Neovim with the session
            subprocess.run(["nvim", "-S", str(session_file)])
            
            return f"Restored Neovim session '{session_name}'"
            
        except Exception as e:
            return f"Error restoring session: {str(e)}"

    def _list_sessions(self, project_dir: Path, project_path: str) -> str:
        """List available sessions."""
        output = ["=== Neovim Sessions ==="]
        output.append(f"Project: {project_path}\n")
        
        # List project-specific sessions
        sessions = list(project_dir.glob("*.vim"))
        
        if sessions:
            output.append("Project Sessions:")
            sessions.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            
            for session_file in sessions:
                session_name = session_file.stem
                metadata_file = project_dir / f"{session_name}.json"
                
                # Get metadata if available
                created_at = "Unknown"
                if metadata_file.exists():
                    try:
                        with open(metadata_file, 'r') as f:
                            metadata = json.load(f)
                            created_at = metadata.get("created_at", "Unknown")
                            if created_at != "Unknown":
                                # Format date
                                dt = datetime.fromisoformat(created_at)
                                created_at = dt.strftime("%Y-%m-%d %H:%M:%S")
                    except:
                        pass
                
                # Get file size
                size = session_file.stat().st_size
                size_kb = size / 1024
                
                output.append(f"  - {session_name}")
                output.append(f"    Created: {created_at}")
                output.append(f"    Size: {size_kb:.1f} KB")
        else:
            output.append("No sessions found for this project.")
        
        # Also list all sessions
        all_sessions = list(self.session_dir.rglob("*.vim"))
        other_sessions = [s for s in all_sessions if s.parent != project_dir]
        
        if other_sessions:
            output.append("\nOther Projects' Sessions:")
            for session_file in other_sessions[:10]:  # Show max 10
                project_name = session_file.parent.name
                session_name = session_file.stem
                output.append(f"  - {project_name}/{session_name}")
            
            if len(other_sessions) > 10:
                output.append(f"  ... and {len(other_sessions) - 10} more")
        
        output.append("\nUse 'neovim_session --action restore --session-name <name>' to restore a session.")
        
        return "\n".join(output)

    def _delete_session(self, session_name: Optional[str], project_dir: Path) -> str:
        """Delete a session."""
        if not session_name:
            return "Error: session_name is required for delete action"
        
        session_file = project_dir / f"{session_name}.vim"
        metadata_file = project_dir / f"{session_name}.json"
        
        if not session_file.exists():
            return f"Error: Session '{session_name}' not found"
        
        try:
            session_file.unlink()
            if metadata_file.exists():
                metadata_file.unlink()
            
            return f"Successfully deleted session '{session_name}'"
            
        except Exception as e:
            return f"Error deleting session: {str(e)}"

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
