"""Tool for managing development tool palettes."""

from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.palette import PaletteRegistry, register_default_palettes


class PaletteTool(BaseTool):
    """Tool for managing tool palettes."""
    
    name = "palette"
    
    def __init__(self):
        """Initialize the palette tool."""
        super().__init__()
        # Register default palettes on initialization
        register_default_palettes()
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Manage tool palettes. Actions: list (default), activate, show, current.

Usage:
palette
palette --action list
palette --action activate python
palette --action show javascript
palette --action current"""
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        action: str = "list",
        name: Optional[str] = None,
    ) -> str:
        """Manage tool palettes.
        
        Args:
            ctx: MCP context
            action: Action to perform (list, activate, show, current)
            name: Palette name (for activate/show actions)
            
        Returns:
            Action result
        """
        if action == "list":
            palettes = PaletteRegistry.list()
            if not palettes:
                return "No palettes registered"
            
            output = ["Available tool palettes:"]
            active = PaletteRegistry.get_active()
            
            for palette in sorted(palettes, key=lambda p: p.name):
                marker = " (active)" if active and active.name == palette.name else ""
                author = f" by {palette.author}" if palette.author else ""
                output.append(f"\n{palette.name}{marker}:")
                output.append(f"  {palette.description}{author}")
                output.append(f"  Tools: {len(palette.tools)} enabled")
            
            return "\n".join(output)
        
        elif action == "activate":
            if not name:
                return "Error: Palette name required for activate action"
            
            try:
                PaletteRegistry.set_active(name)
                palette = PaletteRegistry.get(name)
                
                output = [f"Activated palette: {palette.name}"]
                if palette.author:
                    output.append(f"Author: {palette.author}")
                output.append(f"Description: {palette.description}")
                output.append(f"\nEnabled tools ({len(palette.tools)}):")
                
                # Group tools by category
                core_tools = []
                package_tools = []
                other_tools = []
                
                for tool in sorted(palette.tools):
                    if tool in ["read", "write", "edit", "grep", "tree", "find", "bash"]:
                        core_tools.append(tool)
                    elif tool in ["npx", "uvx", "pip", "cargo", "gem"]:
                        package_tools.append(tool)
                    else:
                        other_tools.append(tool)
                
                if core_tools:
                    output.append(f"  Core: {', '.join(core_tools)}")
                if package_tools:
                    output.append(f"  Package managers: {', '.join(package_tools)}")
                if other_tools:
                    output.append(f"  Specialized: {', '.join(other_tools)}")
                
                if palette.environment:
                    output.append("\nEnvironment variables:")
                    for key, value in palette.environment.items():
                        output.append(f"  {key}={value}")
                
                output.append("\nNote: Restart MCP session for changes to take full effect")
                
                return "\n".join(output)
                
            except ValueError as e:
                return str(e)
        
        elif action == "show":
            if not name:
                return "Error: Palette name required for show action"
            
            palette = PaletteRegistry.get(name)
            if not palette:
                return f"Palette '{name}' not found"
            
            output = [f"Palette: {palette.name}"]
            if palette.author:
                output.append(f"Author: {palette.author}")
            output.append(f"Description: {palette.description}")
            output.append(f"\nTools ({len(palette.tools)}):")
            
            for tool in sorted(palette.tools):
                output.append(f"  - {tool}")
            
            if palette.environment:
                output.append("\nEnvironment:")
                for key, value in palette.environment.items():
                    output.append(f"  {key}={value}")
            
            return "\n".join(output)
        
        elif action == "current":
            active = PaletteRegistry.get_active()
            if not active:
                return "No palette currently active\nUse 'palette --action activate <name>' to activate one"
            
            output = [f"Current palette: {active.name}"]
            if active.author:
                output.append(f"Author: {active.author}")
            output.append(f"Description: {active.description}")
            output.append(f"Enabled tools: {len(active.tools)}")
            
            return "\n".join(output)
        
        else:
            return f"Unknown action: {action}. Use 'list', 'activate', 'show', or 'current'"


# Create tool instance
palette_tool = PaletteTool()