"""Tool for managing development modes with programmer personalities."""

from typing import Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.mode import ModeRegistry, register_default_modes
from mcp.server import FastMCP


class ModeTool(BaseTool):
    """Tool for managing development modes."""
    
    name = "mode"
    
    def __init__(self):
        """Initialize the mode tool."""
        super().__init__()
        # Register default modes on initialization
        register_default_modes()
    
    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Manage development modes (programmer personalities). Actions: list (default), activate, show, current.

Usage:
mode
mode --action list
mode --action activate guido
mode --action show linus
mode --action current"""
    
    @override
    async def run(
        self,
        ctx: MCPContext,
        action: str = "list",
        name: Optional[str] = None,
    ) -> str:
        """Manage development modes.
        
        Args:
            ctx: MCP context
            action: Action to perform (list, activate, show, current)
            name: Mode name (for activate/show actions)
            
        Returns:
            Action result
        """
        if action == "list":
            modes = ModeRegistry.list()
            if not modes:
                return "No modes registered"
            
            output = ["Available development modes (100 programmer personalities):"]
            active = ModeRegistry.get_active()
            
            # Group modes by category
            categories = {
                "Language Creators": ["guido", "matz", "brendan", "dennis", "bjarne", "james", "anders", "larry", "rasmus", "rich"],
                "Systems & Infrastructure": ["linus", "rob", "ken", "bill", "richard", "brian", "donald", "graydon", "ryan", "mitchell"],
                "Web & Frontend": ["tim", "douglas", "john", "evan", "jordan", "jeremy", "david", "taylor", "adrian", "matt"],
                "Database & Data": ["michael_s", "michael_w", "salvatore", "dwight", "edgar", "jim_gray", "jeff_dean", "sanjay", "mike", "matei"],
                "AI & Machine Learning": ["yann", "geoffrey", "yoshua", "andrew", "demis", "ilya", "andrej", "chris", "francois", "jeremy_howard"],
                "Security & Cryptography": ["bruce", "phil", "whitfield", "ralph", "daniel_b", "moxie", "theo", "dan_kaminsky", "katie", "matt_blaze"],
                "Gaming & Graphics": ["john_carmack", "sid", "shigeru", "gabe", "markus", "jonathan", "casey", "tim_sweeney", "hideo", "will"],
                "Open Source Leaders": ["miguel", "nat", "patrick", "ian", "mark_shuttleworth", "lennart", "bram", "daniel_r", "judd", "fabrice"],
                "Modern Innovators": ["vitalik", "satoshi", "chris_lattner", "joe", "jose", "sebastian", "palmer", "dylan", "guillermo", "tom"],
                "Special Configurations": ["fullstack", "minimal", "data_scientist", "devops", "security", "academic", "startup", "enterprise", "creative", "hanzo"],
            }
            
            for category, mode_names in categories.items():
                output.append(f"\n{category}:")
                for mode_name in mode_names:
                    mode = next((m for m in modes if m.name == mode_name), None)
                    if mode:
                        marker = " (active)" if active and active.name == mode.name else ""
                        output.append(f"  {mode.name}{marker}: {mode.programmer} - {mode.description}")
            
            output.append("\nUse 'mode --action activate <name>' to activate a mode")
            
            return "\n".join(output)
        
        elif action == "activate":
            if not name:
                return "Error: Mode name required for activate action"
            
            try:
                ModeRegistry.set_active(name)
                mode = ModeRegistry.get(name)
                
                output = [f"Activated mode: {mode.name}"]
                output.append(f"Programmer: {mode.programmer}")
                output.append(f"Description: {mode.description}")
                if mode.philosophy:
                    output.append(f"Philosophy: {mode.philosophy}")
                output.append(f"\nEnabled tools ({len(mode.tools)}):")
                
                # Group tools by category
                core_tools = []
                package_tools = []
                ai_tools = []
                search_tools = []
                other_tools = []
                
                for tool in sorted(mode.tools):
                    if tool in ["read", "write", "edit", "multi_edit", "bash", "tree", "grep"]:
                        core_tools.append(tool)
                    elif tool in ["npx", "uvx", "pip", "cargo", "gem"]:
                        package_tools.append(tool)
                    elif tool in ["agent", "consensus", "critic", "think"]:
                        ai_tools.append(tool)
                    elif tool in ["search", "symbols", "git_search"]:
                        search_tools.append(tool)
                    else:
                        other_tools.append(tool)
                
                if core_tools:
                    output.append(f"  Core: {', '.join(core_tools)}")
                if package_tools:
                    output.append(f"  Package managers: {', '.join(package_tools)}")
                if ai_tools:
                    output.append(f"  AI tools: {', '.join(ai_tools)}")
                if search_tools:
                    output.append(f"  Search: {', '.join(search_tools)}")
                if other_tools:
                    output.append(f"  Specialized: {', '.join(other_tools)}")
                
                if mode.environment:
                    output.append("\nEnvironment variables:")
                    for key, value in mode.environment.items():
                        output.append(f"  {key}={value}")
                
                output.append("\nNote: Restart MCP session for changes to take full effect")
                
                return "\n".join(output)
                
            except ValueError as e:
                return str(e)
        
        elif action == "show":
            if not name:
                return "Error: Mode name required for show action"
            
            mode = ModeRegistry.get(name)
            if not mode:
                return f"Mode '{name}' not found"
            
            output = [f"Mode: {mode.name}"]
            output.append(f"Programmer: {mode.programmer}")
            output.append(f"Description: {mode.description}")
            if mode.philosophy:
                output.append(f"Philosophy: {mode.philosophy}")
            output.append(f"\nTools ({len(mode.tools)}):")
            
            for tool in sorted(mode.tools):
                output.append(f"  - {tool}")
            
            if mode.environment:
                output.append("\nEnvironment:")
                for key, value in mode.environment.items():
                    output.append(f"  {key}={value}")
            
            return "\n".join(output)
        
        elif action == "current":
            active = ModeRegistry.get_active()
            if not active:
                return "No mode currently active\nUse 'mode --action activate <name>' to activate one"
            
            output = [f"Current mode: {active.name}"]
            output.append(f"Programmer: {active.programmer}")
            output.append(f"Description: {active.description}")
            if active.philosophy:
                output.append(f"Philosophy: {active.philosophy}")
            output.append(f"Enabled tools: {len(active.tools)}")
            
            return "\n".join(output)
        
        else:
            return f"Unknown action: {action}. Use 'list', 'activate', 'show', or 'current'"

    def register(self, server: FastMCP) -> None:
        """Register the tool with the MCP server."""
        tool_self = self
        
        @server.tool(name=self.name, description=self.description)
        async def mode_handler(
            ctx: MCPContext,
            action: str = "list",
            name: Optional[str] = None
        ) -> str:
            """Handle mode tool calls."""
            return await tool_self.run(ctx, action=action, name=name)
    
    async def call(self, ctx: MCPContext, **params) -> str:
        """Call the tool with arguments."""
        return await self.run(
            ctx,
            action=params.get("action", "list"),
            name=params.get("name")
        )


# Create tool instance
mode_tool = ModeTool()