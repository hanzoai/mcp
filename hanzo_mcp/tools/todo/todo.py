"""Unified todo tool."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
import json
import uuid
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.todo.base import TodoBaseTool


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action to perform: list (default), add, update, remove, clear",
        default="list",
    ),
]

Content = Annotated[
    Optional[str],
    Field(
        description="Todo content for add/update",
        default=None,
    ),
]

TodoId = Annotated[
    Optional[str],
    Field(
        description="Todo ID for update/remove",
        default=None,
    ),
]

Status = Annotated[
    Optional[str],
    Field(
        description="Status: pending, in_progress, completed",
        default="pending",
    ),
]

Priority = Annotated[
    Optional[str],
    Field(
        description="Priority: high, medium, low",
        default="medium",
    ),
]

Filter = Annotated[
    Optional[str],
    Field(
        description="Filter todos by status for list action",
        default=None,
    ),
]


class TodoParams(TypedDict, total=False):
    """Parameters for todo tool."""
    action: str
    content: Optional[str]
    id: Optional[str]
    status: Optional[str]
    priority: Optional[str]
    filter: Optional[str]


@final
class TodoTool(TodoBaseTool):
    """Unified todo management tool."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "todo"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Manage todos. Actions: list (default), add, update, remove, clear.

Usage:
todo
todo "Fix the bug in authentication"
todo --action update --id abc123 --status completed
todo --action remove --id abc123
todo --filter in_progress
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[TodoParams],
    ) -> str:
        """Execute todo operation."""
        tool_ctx = self.create_tool_context(ctx)

        # Extract action
        action = params.get("action", "list")
        
        # Route to appropriate handler
        if action == "list":
            return await self._handle_list(params.get("filter"), tool_ctx)
        elif action == "add":
            return await self._handle_add(params, tool_ctx)
        elif action == "update":
            return await self._handle_update(params, tool_ctx)
        elif action == "remove":
            return await self._handle_remove(params.get("id"), tool_ctx)
        elif action == "clear":
            return await self._handle_clear(params.get("filter"), tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: list, add, update, remove, clear"

    async def _handle_list(self, filter_status: Optional[str], tool_ctx) -> str:
        """List todos."""
        todos = self.read_todos()
        
        if not todos:
            return "No todos found. Use 'todo \"Your task here\"' to add one."
        
        # Apply filter if specified
        if filter_status:
            todos = [t for t in todos if t.get("status") == filter_status]
            if not todos:
                return f"No todos with status '{filter_status}'"
        
        # Group by status
        by_status = {}
        for todo in todos:
            status = todo.get("status", "pending")
            if status not in by_status:
                by_status[status] = []
            by_status[status].append(todo)
        
        # Format output
        output = ["=== Todo List ==="]
        
        # Show in order: in_progress, pending, completed
        for status in ["in_progress", "pending", "completed"]:
            if status in by_status:
                output.append(f"\n{status.replace('_', ' ').title()}:")
                for todo in by_status[status]:
                    priority_icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(todo.get("priority", "medium"), "⚪")
                    output.append(f"{priority_icon} [{todo['id'][:8]}] {todo['content']}")
        
        # Summary
        output.append(f"\nTotal: {len(todos)} | In Progress: {len(by_status.get('in_progress', []))} | Pending: {len(by_status.get('pending', []))} | Completed: {len(by_status.get('completed', []))}")
        
        return "\n".join(output)

    async def _handle_add(self, params: Dict[str, Any], tool_ctx) -> str:
        """Add new todo."""
        content = params.get("content")
        if not content:
            return "Error: content is required for add action"
        
        todos = self.read_todos()
        
        new_todo = {
            "id": str(uuid.uuid4()),
            "content": content,
            "status": params.get("status", "pending"),
            "priority": params.get("priority", "medium"),
            "created_at": datetime.now().isoformat(),
        }
        
        todos.append(new_todo)
        self.write_todos(todos)
        
        await tool_ctx.info(f"Added todo: {content}")
        return f"Added todo [{new_todo['id'][:8]}]: {content}"

    async def _handle_update(self, params: Dict[str, Any], tool_ctx) -> str:
        """Update existing todo."""
        todo_id = params.get("id")
        if not todo_id:
            return "Error: id is required for update action"
        
        todos = self.read_todos()
        
        # Find todo (support partial ID match)
        todo_found = None
        for todo in todos:
            if todo["id"].startswith(todo_id):
                todo_found = todo
                break
        
        if not todo_found:
            return f"Error: Todo with ID '{todo_id}' not found"
        
        # Update fields
        if params.get("content"):
            todo_found["content"] = params["content"]
        if params.get("status"):
            todo_found["status"] = params["status"]
        if params.get("priority"):
            todo_found["priority"] = params["priority"]
        
        todo_found["updated_at"] = datetime.now().isoformat()
        
        self.write_todos(todos)
        
        await tool_ctx.info(f"Updated todo: {todo_found['content']}")
        return f"Updated todo [{todo_found['id'][:8]}]: {todo_found['content']} (status: {todo_found['status']})"

    async def _handle_remove(self, todo_id: Optional[str], tool_ctx) -> str:
        """Remove todo."""
        if not todo_id:
            return "Error: id is required for remove action"
        
        todos = self.read_todos()
        
        # Find and remove (support partial ID match)
        removed = None
        for i, todo in enumerate(todos):
            if todo["id"].startswith(todo_id):
                removed = todos.pop(i)
                break
        
        if not removed:
            return f"Error: Todo with ID '{todo_id}' not found"
        
        self.write_todos(todos)
        
        await tool_ctx.info(f"Removed todo: {removed['content']}")
        return f"Removed todo [{removed['id'][:8]}]: {removed['content']}"

    async def _handle_clear(self, filter_status: Optional[str], tool_ctx) -> str:
        """Clear todos."""
        todos = self.read_todos()
        
        if filter_status:
            # Clear only todos with specific status
            original_count = len(todos)
            todos = [t for t in todos if t.get("status") != filter_status]
            removed_count = original_count - len(todos)
            
            if removed_count == 0:
                return f"No todos with status '{filter_status}' to clear"
            
            self.write_todos(todos)
            return f"Cleared {removed_count} todo(s) with status '{filter_status}'"
        else:
            # Clear all
            if not todos:
                return "No todos to clear"
            
            count = len(todos)
            self.write_todos([])
            return f"Cleared all {count} todo(s)"

    @override
    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        tool_self = self  # Create a reference to self for use in the closure

        @mcp_server.tool(name=self.name, description=self.description)
        async def todo(
            action: Action = "list",
            content: Content = None,
            id: TodoId = None,
            status: Status = None,
            priority: Priority = None,
            filter: Filter = None,
            ctx: MCPContext = None,
        ) -> str:
            return await tool_self.call(
                ctx,
                action=action,
                content=content,
                id=id,
                status=status,
                priority=priority,
                filter=filter,
            )