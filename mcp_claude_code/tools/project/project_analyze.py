"""Project analyze tool implementation.

This module provides the ProjectAnalyzeTool for analyzing project structure and dependencies.
"""

from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext

from mcp_claude_code.tools.common.context import create_tool_context
from mcp_claude_code.tools.project.analysis import ProjectAnalyzer, ProjectManager
from mcp_claude_code.tools.project.base import ProjectBaseTool


@final
class ProjectAnalyzeTool(ProjectBaseTool):
    """Tool for analyzing project structure and dependencies."""
    
    def __init__(
        self, 
        permission_manager: Any,
        project_manager: ProjectManager,
        project_analyzer: ProjectAnalyzer
    ) -> None:
        """Initialize the project analyze tool.
        
        Args:
            permission_manager: Permission manager for access control
            project_manager: Project manager for tracking projects
            project_analyzer: Project analyzer for analyzing project structure
        """
        super().__init__(permission_manager)
        self.project_manager: ProjectManager = project_manager
        self.project_analyzer: ProjectAnalyzer = project_analyzer
        
    @property
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            Tool name
        """
        return "project_analyze_tool"
        
    @property
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Tool description
        """
        return """Analyze a project directory structure and dependencies.

Args:
    project_dir: Path to the project directory

Returns:
    Analysis of the project
"""
        
    @property
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Parameter specifications
        """
        return {
            "properties": {
                "project_dir": {
                    "title": "Project Dir",
                    "type": "string"
                }
            },
            "required": ["project_dir"],
            "title": "project_analyze_toolArguments",
            "type": "object"
        }
        
    @property
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of required parameter names
        """
        return ["project_dir"]
    
    async def prepare_tool_context(self, ctx: MCPContext) -> Any:
        """Create and prepare the tool context.
        
        Args:
            ctx: MCP context
            
        Returns:
            Prepared tool context
        """
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)
        return tool_ctx
        
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context
            **params: Tool parameters
            
        Returns:
            Tool result
        """
        tool_ctx = await self.prepare_tool_context(ctx)
        
        # Extract parameters
        project_dir = params.get("project_dir")
        
        # Validate project_dir parameter
        path_validation = self.validate_path(project_dir, "project_dir")
        if path_validation.is_error:
            await tool_ctx.error(path_validation.error_message)
            return f"Error: {path_validation.error_message}"
            
        await tool_ctx.info(f"Analyzing project: {project_dir}")
        
        # Check if directory is allowed
        if not self.is_path_allowed(project_dir):
            await tool_ctx.error(f"Directory not allowed: {project_dir}")
            return f"Error: Directory not allowed: {project_dir}"
            
        # Set project root
        if not self.project_manager.set_project_root(project_dir):
            await tool_ctx.error(f"Failed to set project root: {project_dir}")
            return f"Error: Failed to set project root: {project_dir}"
            
        await tool_ctx.info("Analyzing project structure...")
        
        # Report intermediate progress
        await tool_ctx.report_progress(10, 100)
        
        # Analyze project
        analysis = await self.project_manager.analyze_project()
        if "error" in analysis:
            await tool_ctx.error(f"Error analyzing project: {analysis['error']}")
            return f"Error analyzing project: {analysis['error']}"
            
        # Report more progress
        await tool_ctx.report_progress(50, 100)
        
        await tool_ctx.info("Generating project summary...")
        
        # Generate summary
        summary = self.project_manager.generate_project_summary()
        
        # Complete progress
        await tool_ctx.report_progress(100, 100)
        
        await tool_ctx.info("Project analysis complete")
        return summary
