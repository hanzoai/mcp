"""Base classes for MCP Claude Code tools.

This module provides abstract base classes that define interfaces and common functionality
for all tools used in MCP Claude Code. These abstractions help ensure consistent tool
behavior and provide a foundation for tool registration and management.
"""

from abc import ABC, abstractmethod
from typing import Any, final

from mcp.server.fastmcp import Context as MCPContext
from mcp.server.fastmcp import FastMCP

from mcp_claude_code.tools.common.context import DocumentContext 
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.common.validation import ValidationResult, validate_path_parameter


class BaseTool(ABC):
    """Abstract base class for all MCP Claude Code tools.
    
    This class defines the core interface that all tools must implement, ensuring
    consistency in how tools are registered, documented, and called.
    """
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Get the tool name.
        
        Returns:
            The tool name as it will appear in the MCP server
        """
        pass
        
    @property
    @abstractmethod
    def description(self) -> str:
        """Get the tool description.
        
        Returns:
            Detailed description of the tool's purpose and usage
        """
        pass
        
    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """Get the parameter specifications for the tool.
        
        Returns:
            Dictionary containing parameter specifications in JSON Schema format
        """
        pass
        
    @property
    @abstractmethod
    def required(self) -> list[str]:
        """Get the list of required parameter names.
        
        Returns:
            List of parameter names that are required for the tool
        """
        pass
        
    @abstractmethod
    async def call(self, ctx: MCPContext, **params: Any) -> str:
        """Execute the tool with the given parameters.
        
        Args:
            ctx: MCP context for the tool call
            **params: Tool parameters provided by the caller
            
        Returns:
            Tool execution result as a string
        """
        pass


class FileSystemTool(BaseTool,ABC):
    """Base class for filesystem-related tools.
    
    Provides common functionality for working with files and directories,
    including permission checking and path validation.
    """
    
    def __init__(
        self, 
        document_context: DocumentContext, 
        permission_manager: PermissionManager
    ) -> None:
        """Initialize filesystem tool.
        
        Args:
            document_context: Document context for tracking file contents
            permission_manager: Permission manager for access control
        """
        self.document_context:DocumentContext = document_context
        self.permission_manager:PermissionManager = permission_manager
        
    def validate_path(self, path: str, param_name: str = "path") -> ValidationResult:
        """Validate a path parameter.
        
        Args:
            path: Path to validate
            param_name: Name of the parameter (for error messages)
            
        Returns:
            Validation result containing validation status and error message if any
        """
        return validate_path_parameter(path, param_name)
        
    def is_path_allowed(self, path: str) -> bool:
        """Check if a path is allowed according to permission settings.
        
        Args:
            path: Path to check
            
        Returns:
            True if the path is allowed, False otherwise
        """
        return self.permission_manager.is_path_allowed(path)


@final
class ToolRegistry:
    """Registry for MCP Claude Code tools.
    
    Provides functionality for registering tool implementations with an MCP server,
    handling the conversion between tool classes and MCP tool functions.
    """
    
    @staticmethod
    def register_tool(mcp_server: FastMCP, tool: BaseTool) -> None:
        """Register a tool with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
            tool: The tool to register
        """
        # Create a wrapper function that will be registered with MCP
        @mcp_server.tool(name=tool.name, description=tool.description)
        async def tool_wrapper(**kwargs: Any) -> str:
            # Extract context from kwargs
            ctx = kwargs.pop("ctx")
            # Call the actual tool implementation
            return await tool.call(ctx=ctx, **kwargs)
            
    @staticmethod
    def register_tools(mcp_server: FastMCP, tools: list[BaseTool]) -> None:
        """Register multiple tools with the MCP server.
        
        Args:
            mcp_server: The FastMCP server instance
            tools: List of tools to register
        """
        for tool in tools:
            ToolRegistry.register_tool(mcp_server, tool)
