"""Provider-specific LLM tools."""

import os
from typing import Annotated, Optional, TypedDict, Unpack, final, override, Dict, Any

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.llm.llm_tool import LLMTool


Prompt = Annotated[
    str,
    Field(
        description="The prompt or question to send to the model",
        min_length=1,
    ),
]

Model = Annotated[
    Optional[str],
    Field(
        description="Specific model variant (defaults to provider's best model)",
        default=None,
    ),
]

SystemPrompt = Annotated[
    Optional[str],
    Field(
        description="System prompt to set context",
        default=None,
    ),
]

Temperature = Annotated[
    float,
    Field(
        description="Temperature for response randomness (0.0-2.0)",
        default=0.7,
    ),
]

MaxTokens = Annotated[
    Optional[int],
    Field(
        description="Maximum tokens in response",
        default=None,
    ),
]

JsonMode = Annotated[
    bool,
    Field(
        description="Request JSON formatted response",
        default=False,
    ),
]


class ProviderToolParams(TypedDict, total=False):
    """Parameters for provider-specific tools."""

    prompt: str
    model: Optional[str]
    system_prompt: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    json_mode: bool


class BaseProviderTool(BaseTool):
    """Base class for provider-specific LLM tools."""
    
    def __init__(self, provider: str, default_model: str, model_variants: Dict[str, str]):
        """Initialize provider tool.
        
        Args:
            provider: Provider name
            default_model: Default model to use
            model_variants: Map of short names to full model names
        """
        self.provider = provider
        self.default_model = default_model
        self.model_variants = model_variants
        self.llm_tool = LLMTool()
        self.is_available = provider in self.llm_tool.available_providers

    def get_full_model_name(self, model: Optional[str]) -> str:
        """Get full model name from short name or default."""
        if not model:
            return self.default_model
        
        # Check if it's a short name
        if model in self.model_variants:
            return self.model_variants[model]
        
        # Return as-is if not found (assume full name)
        return model

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ProviderToolParams],
    ) -> str:
        """Call the provider's LLM."""
        if not self.is_available:
            env_vars = LLMTool.API_KEY_ENV_VARS.get(self.provider, [])
            return f"Error: {self.provider.title()} API key not found. Set one of: {', '.join(env_vars)}"
        
        # Get full model name
        model = self.get_full_model_name(params.get("model"))
        
        # Prepare LLM tool parameters
        llm_params = {
            "model": model,
            "prompt": params["prompt"],
        }
        
        # Add optional parameters
        if "system_prompt" in params:
            llm_params["system_prompt"] = params["system_prompt"]
        if "temperature" in params:
            llm_params["temperature"] = params["temperature"]
        if "max_tokens" in params:
            llm_params["max_tokens"] = params["max_tokens"]
        if "json_mode" in params:
            llm_params["json_mode"] = params["json_mode"]
        
        # Call the LLM tool
        return await self.llm_tool.call(ctx, **llm_params)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass


@final
class OpenAITool(BaseProviderTool):
    """OpenAI-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="openai",
            default_model="gpt-4o",
            model_variants={
                "4o": "gpt-4o",
                "4": "gpt-4",
                "3.5": "gpt-3.5-turbo",
                "o1": "o1-preview",
                "o1-mini": "o1-mini",
                "4-turbo": "gpt-4-turbo-preview",
                "4-vision": "gpt-4-vision-preview",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "openai"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query OpenAI models directly ({status}).

Models:
- 4o (default): GPT-4o - Latest and most capable
- 4: GPT-4 - Advanced reasoning
- 3.5: GPT-3.5 Turbo - Fast and efficient
- o1: O1 Preview - Chain of thought reasoning
- o1-mini: O1 Mini - Smaller reasoning model

Examples:
- openai --prompt "Explain quantum computing"
- openai --model 4 --prompt "Write a Python function"
- openai --model o1 --prompt "Solve this step by step"
"""


@final
class AnthropicTool(BaseProviderTool):
    """Anthropic-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="anthropic",
            default_model="claude-3-sonnet-20240229",
            model_variants={
                "opus": "claude-3-opus-20240229",
                "sonnet": "claude-3-sonnet-20240229",
                "haiku": "claude-3-haiku-20240307",
                "2.1": "claude-2.1",
                "2": "claude-2",
                "instant": "claude-instant-1.2",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "anthropic"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query Anthropic Claude models directly ({status}).

Models:
- sonnet (default): Claude 3 Sonnet - Balanced performance
- opus: Claude 3 Opus - Most capable
- haiku: Claude 3 Haiku - Fast and efficient
- 2.1: Claude 2.1 - Previous generation
- instant: Claude Instant - Very fast

Examples:
- anthropic --prompt "Analyze this code"
- anthropic --model opus --prompt "Write a detailed essay"
- anthropic --model haiku --prompt "Quick question"
"""


@final
class GeminiTool(BaseProviderTool):
    """Google Gemini-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="google",
            default_model="gemini/gemini-pro",
            model_variants={
                "pro": "gemini/gemini-pro",
                "pro-vision": "gemini/gemini-pro-vision",
                "1.5-pro": "gemini/gemini-1.5-pro-latest",
                "1.5-flash": "gemini/gemini-1.5-flash-latest",
                "ultra": "gemini/gemini-ultra",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "gemini"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query Google Gemini models directly ({status}).

Models:
- pro (default): Gemini Pro - Balanced model
- 1.5-pro: Gemini 1.5 Pro - Advanced with long context
- 1.5-flash: Gemini 1.5 Flash - Fast and efficient
- pro-vision: Gemini Pro Vision - Multimodal
- ultra: Gemini Ultra - Most capable (if available)

Examples:
- gemini --prompt "Explain this concept"
- gemini --model 1.5-pro --prompt "Analyze this long document"
- gemini --model 1.5-flash --prompt "Quick task"
"""


@final
class GroqTool(BaseProviderTool):
    """Groq-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="groq",
            default_model="groq/mixtral-8x7b-32768",
            model_variants={
                "mixtral": "groq/mixtral-8x7b-32768",
                "llama3-70b": "groq/llama3-70b-8192",
                "llama3-8b": "groq/llama3-8b-8192",
                "llama2-70b": "groq/llama2-70b-4096",
                "gemma-7b": "groq/gemma-7b-it",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "groq"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query Groq LPU models - ultra-fast inference ({status}).

Models:
- mixtral (default): Mixtral 8x7B - High quality
- llama3-70b: Llama 3 70B - Very capable
- llama3-8b: Llama 3 8B - Fast and efficient
- llama2-70b: Llama 2 70B - Previous gen
- gemma-7b: Google Gemma 7B - Efficient

Examples:
- groq --prompt "Fast response needed"
- groq --model llama3-70b --prompt "Complex reasoning"
- groq --model gemma-7b --prompt "Quick task"
"""


@final
class MistralTool(BaseProviderTool):
    """Mistral-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="mistral",
            default_model="mistral/mistral-medium",
            model_variants={
                "tiny": "mistral/mistral-tiny",
                "small": "mistral/mistral-small-latest",
                "medium": "mistral/mistral-medium-latest",
                "large": "mistral/mistral-large-latest",
                "embed": "mistral/mistral-embed",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "mistral"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query Mistral AI models directly ({status}).

Models:
- medium (default): Mistral Medium - Balanced
- large: Mistral Large - Most capable
- small: Mistral Small - Efficient
- tiny: Mistral Tiny - Very fast

Examples:
- mistral --prompt "Explain this"
- mistral --model large --prompt "Complex analysis"
- mistral --model tiny --prompt "Quick response"
"""


@final
class PerplexityTool(BaseProviderTool):
    """Perplexity-specific LLM tool."""
    
    def __init__(self):
        super().__init__(
            provider="perplexity",
            default_model="perplexity/sonar-medium-online",
            model_variants={
                "sonar-small": "perplexity/sonar-small-online",
                "sonar-medium": "perplexity/sonar-medium-online",
                "sonar-small-chat": "perplexity/sonar-small-chat",
                "sonar-medium-chat": "perplexity/sonar-medium-chat",
            }
        )

    @property
    @override
    def name(self) -> str:
        return "perplexity"

    @property
    @override
    def description(self) -> str:
        status = "✓ Available" if self.is_available else "✗ No API key"
        return f"""Query Perplexity models with internet access ({status}).

Models:
- sonar-medium (default): Online search + reasoning
- sonar-small: Faster online search
- sonar-medium-chat: Chat without search
- sonar-small-chat: Fast chat without search

Examples:
- perplexity --prompt "Latest news about AI"
- perplexity --model sonar-small --prompt "Quick fact check"
- perplexity --model sonar-medium-chat --prompt "Explain without search"
"""


# Export all provider tools
PROVIDER_TOOLS = [
    OpenAITool,
    AnthropicTool,
    GeminiTool,
    GroqTool,
    MistralTool,
    PerplexityTool,
]


def create_provider_tools() -> list[BaseTool]:
    """Create instances of all provider tools."""
    tools = []
    for tool_class in PROVIDER_TOOLS:
        tool = tool_class()
        # Only include tools with available API keys
        if tool.is_available:
            tools.append(tool)
    return tools
