"""Base classes for project tools.

This module provides abstract base classes for project analysis tools.
"""

from abc import ABC, abstractmethod
from typing import Any

from mcp.server.fastmcp import Context as MCPContext

from mcp_claude_code.tools.common.base import BaseTool
from mcp_claude_code.tools.common.permissions import PermissionManager
from mcp_claude_code.tools.common.validation import validate_path_parameter


class ProjectBaseTool(BaseTool, ABC):
    """Base class for project-related tools.
    
    Provides common functionality for project analysis and scanning.
    """
    
    def __init__(
        self, 
        permission_manager: PermissionManager
    ) -> None:
        """Initialize project base tool.
        
        Args:
            permission_manager: Permission manager for access control
        """
        self.permission_manager: PermissionManager = permission_manager
        
    def validate_path(self, path: str, param_name: str = "path") -> Any:
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
    
    @abstractmethod
    async def prepare_tool_context(self, ctx: MCPContext) -> Any:
        """Create and prepare the tool context.
        
        Args:
            ctx: MCP context
            
        Returns:
            Prepared tool context
        """
        pass
