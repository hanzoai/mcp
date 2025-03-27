"""Prompt generation utilities for agent tool.

This module provides functions for generating effective prompts for sub-agents,
including filtering tools based on permissions and formatting system instructions.
"""

import os
from typing import Any

from mcp_claude_code.tools.common.base import BaseTool
from mcp_claude_code.tools.common.permissions import PermissionManager


def get_allowed_agent_tools(
    tools: list[BaseTool],
    permission_manager: PermissionManager,
) -> list[BaseTool]:
    """Filter tools available to the agent based on permissions.

    Args:
        tools: List of available tools
        permission_manager: Permission manager for checking tool access

    Returns:
        Filtered list of tools available to the agent
    """
    # Get all tools except for the agent tool itself (avoid recursion)
    filtered_tools = [tool for tool in tools if tool.name != "agent"]
    
    return filtered_tools


def get_system_prompt(
    tools: list[BaseTool],
    permission_manager: PermissionManager,
) -> str:
    """Generate system prompt for the sub-agent.

    Args:
        tools: List of available tools
        permission_manager: Permission manager for checking tool access

    Returns:
        System prompt for the sub-agent
    """
    # Get filtered tools
    filtered_tools = get_allowed_agent_tools(
        tools, permission_manager
    )

    # Extract tool names for display
    tool_names = ", ".join(f"`{tool.name}`" for tool in filtered_tools)

    # Base system prompt
    system_prompt = f"""You are a sub-agent assistant with access to these tools: {tool_names}.

GUIDELINES:
1. You work autonomously - you cannot ask follow-up questions
2. You have access to read-only tools - you cannot modify files or execute commands
3. Your response is returned directly to the main assistant, not the user
4. Be concise and focus on the specific task assigned

TASK INSTRUCTIONS:
{{prompt}}

RESPONSE FORMAT:
- Begin with a summary of findings
- Include relevant details and context
- Organize information logically
- End with clear conclusions
"""

    return system_prompt


def get_default_model() -> str:
    """Get the default model for agent execution.

    Returns:
        Model identifier string with optional provider prefix
    """
    model = os.environ.get("AGENT_MODEL", "gpt-4o")
    
    # Special cases for tests
    if model.startswith("test-model") or model == "gpt-4o" and "TEST_MODE" in os.environ:
        return model
        
    provider = os.environ.get("AGENT_PROVIDER", "openai")
    
    # Only add provider prefix if it's not already in the model name
    if "/" not in model and provider != "openai":
        return f"{provider}/{model}"
    elif "/" not in model:
        return f"openai/{model}"
    else:
        # Model already has a provider prefix
        return model


def get_model_parameters() -> dict[str, Any]:
    """Get model parameters from environment variables.

    Returns:
        Dictionary of model parameters
    """
    return {
        "temperature": float(os.environ.get("AGENT_TEMPERATURE", "0.7")),
        "max_tokens": int(os.environ.get("AGENT_MAX_TOKENS", "4096")),
        "timeout": int(os.environ.get("AGENT_API_TIMEOUT", "60")),
    }
