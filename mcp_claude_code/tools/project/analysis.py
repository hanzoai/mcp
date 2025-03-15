"""Project analysis tools for MCP Claude Code.

This module provides tools for analyzing project structure and dependencies.
"""

from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext, FastMCP

from mcp_claude_code.executors import ProjectAnalyzer
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.project import ProjectManager
from mcp_claude_code.tools.common.context import ToolContext, create_tool_context


@final
class ProjectAnalysis:
    """Project analysis tools for MCP Claude Code."""
    
    def __init__(self, 
                 project_manager: ProjectManager, 
                 project_analyzer: ProjectAnalyzer,
                 permission_manager: PermissionManager) -> None:
        """Initialize project analysis.
        
        Args:
            project_manager: Project manager for tracking projects
            project_analyzer: Project analyzer for analyzing project structure and dependencies
            permission_manager: Permission manager for access control
        """
        self.project_manager: ProjectManager = project_manager
        self.project_analyzer: ProjectAnalyzer = project_analyzer
        self.permission_manager: PermissionManager = permission_manager
    
    def register_tools(self, mcp_server: FastMCP) -> None:
        """Register project analysis tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
        """
        # Project analysis tool
        @mcp_server.tool()
        async def project_analyze_tool(project_dir: str, ctx: MCPContext) -> str:
            """Analyze a project directory structure and dependencies.
            
            Args:
                project_dir: Path to the project directory
                ctx: MCP context for logging and progress tracking
                
            Returns:
                Analysis of the project
            """
            tool_ctx = create_tool_context(ctx)
            tool_ctx.set_tool_info("project_analyze")
            tool_ctx.info(f"Analyzing project: {project_dir}")
            
            # Check if directory is allowed
            if not self.permission_manager.is_path_allowed(project_dir):
                tool_ctx.error(f"Directory not allowed: {project_dir}")
                return f"Error: Directory not allowed: {project_dir}"
            
            # Set project root
            if not self.project_manager.set_project_root(project_dir):
                tool_ctx.error(f"Failed to set project root: {project_dir}")
                return f"Error: Failed to set project root: {project_dir}"
            
            tool_ctx.info("Analyzing project structure...")
            
            # Report intermediate progress
            await tool_ctx.report_progress(10, 100)
            
            # Analyze project
            analysis: dict[str, Any] = await self.project_manager.analyze_project()
            if "error" in analysis:
                tool_ctx.error(f"Error analyzing project: {analysis['error']}")
                return f"Error analyzing project: {analysis['error']}"
            
            # Report more progress
            await tool_ctx.report_progress(50, 100)
            
            tool_ctx.info("Generating project summary...")
            
            # Generate summary
            summary = self.project_manager.generate_project_summary()
            
            # Complete progress
            await tool_ctx.report_progress(100, 100)
            
            tool_ctx.info("Project analysis complete")
            return summary
