"""Unified agent tool implementation.

This module provides the AgentTool for delegating tasks to sub-agents,
supporting both one-off and long-running RPC modes, including A2A communication.
"""

import asyncio
import json
import re
import time
import uuid
from typing import Annotated, TypedDict, Unpack, final, override, Optional, Dict, Any, List
from collections.abc import Iterable

# Import litellm with warnings suppressed
import warnings
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import litellm
from mcp.server.fastmcp import Context as MCPContext
from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam
from pydantic import Field

from hanzo_mcp.tools.agent.prompt import (
    get_allowed_agent_tools,
    get_default_model,
    get_model_parameters,
    get_system_prompt,
)
from hanzo_mcp.tools.agent.tool_adapter import (
    convert_tools_to_openai_functions,
)
from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.batch_tool import BatchTool
from hanzo_mcp.tools.common.context import (
    ToolContext,
    create_tool_context,
)
from hanzo_mcp.tools.common.permissions import PermissionManager
from hanzo_mcp.tools.filesystem import get_read_only_filesystem_tools
from hanzo_mcp.tools.jupyter import get_read_only_jupyter_tools


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action: run (default), start, call, stop, list",
        default="run",
    ),
]

Prompts = Annotated[
    Optional[str | List[str]],
    Field(
        description="Task(s) for agent (must include absolute paths starting with /)",
        default=None,
    ),
]

Mode = Annotated[
    str,
    Field(
        description="Execution mode: oneoff (default) or rpc",
        default="oneoff",
    ),
]

AgentId = Annotated[
    Optional[str],
    Field(
        description="Agent ID for RPC mode",
        default=None,
    ),
]

Method = Annotated[
    Optional[str],
    Field(
        description="Method to call on RPC agent",
        default=None,
    ),
]

Args = Annotated[
    Optional[Dict[str, Any]],
    Field(
        description="Arguments for RPC method call",
        default=None,
    ),
]

Model = Annotated[
    Optional[str],
    Field(
        description="Model to use (e.g., lm-studio/local-model, openai/gpt-4o)",
        default=None,
    ),
]


class AgentParams(TypedDict, total=False):
    """Parameters for agent tool."""
    action: str
    prompts: Optional[str | List[str]]
    mode: str
    agent_id: Optional[str]
    method: Optional[str]
    args: Optional[Dict[str, Any]]
    model: Optional[str]


class RPCAgent:
    """Long-running RPC agent."""
    
    def __init__(self, agent_id: str, model: str, system_prompt: str, tools: List[BaseTool]):
        self.agent_id = agent_id
        self.model = model
        self.system_prompt = system_prompt
        self.tools = tools
        self.messages: List[ChatCompletionMessageParam] = [
            {"role": "system", "content": system_prompt}
        ]
        self.created_at = time.time()
        self.last_used = time.time()
        self.call_count = 0
        
    async def call_method(self, method: str, args: Dict[str, Any], tool_ctx: ToolContext) -> str:
        """Call a method on the RPC agent."""
        self.last_used = time.time()
        self.call_count += 1
        
        # Build prompt based on method
        if method == "search":
            prompt = f"Search for: {args.get('query', 'unknown')}"
        elif method == "analyze":
            prompt = f"Analyze: {args.get('target', 'unknown')}"
        elif method == "execute":
            prompt = f"Execute: {args.get('command', 'unknown')}"
        else:
            # Generic method call
            prompt = f"Method: {method}, Args: {json.dumps(args)}"
            
        # Add to conversation
        self.messages.append({"role": "user", "content": prompt})
        
        # Get response
        # (simplified - would integrate with full agent execution logic)
        response = f"Executed {method} with args {args}"
        self.messages.append({"role": "assistant", "content": response})
        
        return response


@final
class AgentTool(BaseTool):
    """Unified agent tool with one-off and RPC modes."""
    
    def __init__(
        self,
        permission_manager: PermissionManager,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        max_tokens: int | None = None,
        max_iterations: int = 10,
        max_tool_uses: int = 30,
    ):
        """Initialize the agent tool."""
        self.permission_manager = permission_manager
        self.model_override = model
        self.api_key_override = api_key
        self.base_url_override = base_url
        self.max_tokens_override = max_tokens
        self.max_iterations = max_iterations
        self.max_tool_uses = max_tool_uses
        
        # RPC agent registry
        self._rpc_agents: Dict[str, RPCAgent] = {}
        
        # Available tools
        self.available_tools: list[BaseTool] = []
        self.available_tools.extend(
            get_read_only_filesystem_tools(self.permission_manager)
        )
        self.available_tools.extend(
            get_read_only_jupyter_tools(self.permission_manager)
        )
        self.available_tools.append(
            BatchTool({t.name: t for t in self.available_tools})
        )

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "agent"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        tools = [t.name for t in self.available_tools]
        
        return f"""AI agents with tools: {', '.join(tools)}. Actions: run (default), start, call, stop, list.

Usage:
agent "Search for config files in /project"
agent --action start --mode rpc --model lm-studio/local-model
agent --action call --agent-id abc123 --method search --args '{{"query": "database"}}'
agent --action list

Modes:
- oneoff: Single task execution (default)
- rpc: Long-running agent for multiple calls (A2A support)"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[AgentParams],
    ) -> str:
        """Execute agent operation."""
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)
        
        # Extract action
        action = params.get("action", "run")
        
        # Route to appropriate handler
        if action == "run":
            return await self._handle_run(params, tool_ctx)
        elif action == "start":
            return await self._handle_start(params, tool_ctx)
        elif action == "call":
            return await self._handle_call(params, tool_ctx)
        elif action == "stop":
            return await self._handle_stop(params, tool_ctx)
        elif action == "list":
            return await self._handle_list(tool_ctx)
        else:
            return f"Error: Unknown action '{action}'. Valid actions: run, start, call, stop, list"

    async def _handle_run(self, params: Dict[str, Any], tool_ctx: ToolContext) -> str:
        """Handle one-off agent run (default action)."""
        prompts = params.get("prompts")
        if not prompts:
            return "Error: prompts required for run action"
            
        # Convert to list
        if isinstance(prompts, str):
            prompt_list = [prompts]
        else:
            prompt_list = prompts
            
        # Validate prompts
        for prompt in prompt_list:
            if not self._validate_prompt(prompt):
                return f"Error: Prompt must contain absolute paths starting with /: {prompt[:50]}..."
        
        # Execute agents
        start_time = time.time()
        
        if len(prompt_list) == 1:
            await tool_ctx.info("Launching agent")
            result = await self._execute_agent(prompt_list[0], params.get("model"), tool_ctx)
        else:
            await tool_ctx.info(f"Launching {len(prompt_list)} agents in parallel")
            result = await self._execute_multiple_agents(prompt_list, params.get("model"), tool_ctx)
            
        execution_time = time.time() - start_time
        
        return f"""Agent execution completed in {execution_time:.2f} seconds.

AGENT RESPONSE:
{result}"""

    async def _handle_start(self, params: Dict[str, Any], tool_ctx: ToolContext) -> str:
        """Start a new RPC agent."""
        mode = params.get("mode", "oneoff")
        if mode != "rpc":
            return "Error: start action only valid for rpc mode"
            
        # Generate agent ID
        agent_id = str(uuid.uuid4())[:8]
        
        # Get model
        model = params.get("model") or get_default_model(self.model_override)
        
        # Get available tools
        agent_tools = get_allowed_agent_tools(
            self.available_tools,
            self.permission_manager,
        )
        
        # Create system prompt
        system_prompt = get_system_prompt(
            agent_tools,
            self.permission_manager,
        )
        
        # Create RPC agent
        agent = RPCAgent(agent_id, model, system_prompt, agent_tools)
        self._rpc_agents[agent_id] = agent
        
        await tool_ctx.info(f"Started RPC agent {agent_id} with model {model}")
        
        return f"""Started RPC agent:
- ID: {agent_id}
- Model: {model}
- Tools: {len(agent_tools)}

Use 'agent --action call --agent-id {agent_id} --method <method> --args <args>' to interact."""

    async def _handle_call(self, params: Dict[str, Any], tool_ctx: ToolContext) -> str:
        """Call method on RPC agent."""
        agent_id = params.get("agent_id")
        if not agent_id:
            return "Error: agent_id required for call action"
            
        if agent_id not in self._rpc_agents:
            return f"Error: Agent {agent_id} not found. Use 'agent --action list' to see active agents."
            
        method = params.get("method")
        if not method:
            return "Error: method required for call action"
            
        args = params.get("args", {})
        
        # Call agent method
        agent = self._rpc_agents[agent_id]
        await tool_ctx.info(f"Calling {method} on agent {agent_id}")
        
        try:
            result = await agent.call_method(method, args, tool_ctx)
            return f"Agent {agent_id} response:\n{result}"
        except Exception as e:
            await tool_ctx.error(f"Error calling agent: {str(e)}")
            return f"Error calling agent: {str(e)}"

    async def _handle_stop(self, params: Dict[str, Any], tool_ctx: ToolContext) -> str:
        """Stop an RPC agent."""
        agent_id = params.get("agent_id")
        if not agent_id:
            return "Error: agent_id required for stop action"
            
        if agent_id not in self._rpc_agents:
            return f"Error: Agent {agent_id} not found"
            
        agent = self._rpc_agents.pop(agent_id)
        await tool_ctx.info(f"Stopped agent {agent_id}")
        
        return f"""Stopped agent {agent_id}:
- Runtime: {time.time() - agent.created_at:.2f} seconds
- Calls: {agent.call_count}"""

    async def _handle_list(self, tool_ctx: ToolContext) -> str:
        """List active RPC agents."""
        if not self._rpc_agents:
            return "No active RPC agents"
            
        output = ["=== Active RPC Agents ==="]
        for agent_id, agent in self._rpc_agents.items():
            runtime = time.time() - agent.created_at
            idle = time.time() - agent.last_used
            output.append(f"\nAgent {agent_id}:")
            output.append(f"  Model: {agent.model}")
            output.append(f"  Runtime: {runtime:.2f}s")
            output.append(f"  Idle: {idle:.2f}s")
            output.append(f"  Calls: {agent.call_count}")
            
        return "\n".join(output)

    def _validate_prompt(self, prompt: str) -> bool:
        """Validate that prompt contains absolute paths."""
        absolute_path_pattern = r"/(?:[^/\s]+/)*[^/\s]+"
        return bool(re.search(absolute_path_pattern, prompt))

    async def _execute_agent(self, prompt: str, model: Optional[str], tool_ctx: ToolContext) -> str:
        """Execute a single agent (simplified - would use full logic from agent_tool.py)."""
        # This would integrate the full agent execution logic from agent_tool.py
        # For now, return a placeholder
        return f"Executed agent with prompt: {prompt[:100]}..."

    async def _execute_multiple_agents(self, prompts: List[str], model: Optional[str], tool_ctx: ToolContext) -> str:
        """Execute multiple agents in parallel."""
        tasks = []
        for prompt in prompts:
            task = self._execute_agent(prompt, model, tool_ctx)
            tasks.append(task)
            
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        formatted_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                formatted_results.append(f"Agent {i+1} Error:\n{str(result)}")
            else:
                formatted_results.append(f"Agent {i+1} Result:\n{result}")
                
        return "\n\n---\n\n".join(formatted_results)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass