"""Universal LLM tool using LiteLLM."""

import os
import json
from typing import Annotated, Optional, TypedDict, Unpack, final, override, List, Dict, Any
import asyncio

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context

try:
    import litellm
    from litellm import completion, acompletion
    LITELLM_AVAILABLE = True
except ImportError:
    LITELLM_AVAILABLE = False


Model = Annotated[
    str,
    Field(
        description="Model name in LiteLLM format (e.g., 'gpt-4', 'claude-3-opus-20240229', 'gemini/gemini-pro')",
        min_length=1,
    ),
]

Prompt = Annotated[
    str,
    Field(
        description="The prompt or question to send to the model",
        min_length=1,
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

Stream = Annotated[
    bool,
    Field(
        description="Stream the response",
        default=False,
    ),
]


class LLMToolParams(TypedDict, total=False):
    """Parameters for LLM tool."""

    model: str
    prompt: str
    system_prompt: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    json_mode: bool
    stream: bool


@final
class LLMTool(BaseTool):
    """Universal LLM tool using LiteLLM."""
    
    # Common environment variables for API keys
    API_KEY_ENV_VARS = {
        "openai": ["OPENAI_API_KEY"],
        "anthropic": ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
        "google": ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
        "groq": ["GROQ_API_KEY"],
        "cohere": ["COHERE_API_KEY"],
        "replicate": ["REPLICATE_API_KEY"],
        "huggingface": ["HUGGINGFACE_API_KEY", "HF_TOKEN"],
        "together": ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
        "mistral": ["MISTRAL_API_KEY"],
        "perplexity": ["PERPLEXITY_API_KEY"],
        "anyscale": ["ANYSCALE_API_KEY"],
        "deepinfra": ["DEEPINFRA_API_KEY"],
        "ai21": ["AI21_API_KEY"],
        "nvidia": ["NVIDIA_API_KEY"],
        "voyage": ["VOYAGE_API_KEY"],
        "aws": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],  # For Bedrock
        "azure": ["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"],
    }
    
    # Model prefixes for each provider
    PROVIDER_MODELS = {
        "openai": ["gpt-4", "gpt-3.5", "o1", "davinci", "curie", "babbage", "ada"],
        "anthropic": ["claude-3", "claude-2", "claude-instant"],
        "google": ["gemini", "palm", "bison", "gecko"],
        "groq": ["mixtral", "llama2", "llama3"],
        "cohere": ["command", "command-light"],
        "mistral": ["mistral-tiny", "mistral-small", "mistral-medium", "mistral-large"],
        "perplexity": ["pplx", "sonar"],
        "together": ["together"],
        "bedrock": ["bedrock/"],
        "azure": ["azure/"],
    }

    def __init__(self):
        """Initialize the LLM tool."""
        self.available_providers = self._detect_available_providers()
        
        # Configure LiteLLM settings
        if LITELLM_AVAILABLE:
            # Enable verbose logging for debugging
            litellm.set_verbose = False
            # Set default timeout
            litellm.request_timeout = 120

    def _detect_available_providers(self) -> Dict[str, List[str]]:
        """Detect which LLM providers have API keys configured."""
        available = {}
        
        for provider, env_vars in self.API_KEY_ENV_VARS.items():
            for var in env_vars:
                if os.getenv(var):
                    if provider not in available:
                        available[provider] = []
                    available[provider].append(var)
                    break
        
        return available

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "llm"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        providers_list = ", ".join(sorted(self.available_providers.keys())) if self.available_providers else "None"
        
        return f"""Query any LLM using LiteLLM's unified interface.

Supports 100+ models from various providers through a single interface.
Automatically uses API keys from environment variables.

Detected providers: {providers_list}

Common models:
- OpenAI: gpt-4o, gpt-4, gpt-3.5-turbo, o1-preview, o1-mini
- Anthropic: claude-3-opus-20240229, claude-3-sonnet-20240229, claude-3-haiku-20240307
- Google: gemini/gemini-pro, gemini/gemini-1.5-pro, gemini/gemini-1.5-flash
- Groq: groq/mixtral-8x7b-32768, groq/llama3-70b-8192
- Mistral: mistral/mistral-large-latest, mistral/mistral-medium
- Perplexity: perplexity/sonar-medium-online
- Together: together/mixtral-8x22b

Examples:
- llm --model "gpt-4" --prompt "Explain quantum computing"
- llm --model "claude-3-opus-20240229" --prompt "Write a haiku about coding"
- llm --model "gemini/gemini-pro" --prompt "What is the meaning of life?" --temperature 0.9
- llm --model "groq/mixtral-8x7b-32768" --prompt "Generate a JSON schema" --json-mode

For provider-specific tools, use: openai, anthropic, gemini, groq, etc.
For consensus across models, use: consensus
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[LLMToolParams],
    ) -> str:
        """Query an LLM.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            LLM response
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        if not LITELLM_AVAILABLE:
            return "Error: LiteLLM is not installed. Install it with: pip install litellm"

        # Extract parameters
        model = params.get("model")
        if not model:
            return "Error: model is required"

        prompt = params.get("prompt")
        if not prompt:
            return "Error: prompt is required"

        system_prompt = params.get("system_prompt")
        temperature = params.get("temperature", 0.7)
        max_tokens = params.get("max_tokens")
        json_mode = params.get("json_mode", False)
        stream = params.get("stream", False)

        # Check if we have API key for this model
        provider = self._get_provider_for_model(model)
        if provider and provider not in self.available_providers:
            env_vars = self.API_KEY_ENV_VARS.get(provider, [])
            return f"Error: No API key found for {provider}. Set one of: {', '.join(env_vars)}"

        # Build messages
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        # Build kwargs
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        await tool_ctx.info(f"Querying {model}...")

        try:
            if stream:
                # Streaming response
                response_text = ""
                async for chunk in await acompletion(**kwargs, stream=True):
                    if chunk.choices[0].delta.content:
                        response_text += chunk.choices[0].delta.content
                        # Could emit progress here if needed
                
                return response_text
            else:
                # Non-streaming response
                response = await acompletion(**kwargs)
                return response.choices[0].message.content

        except Exception as e:
            error_msg = str(e)
            
            # Provide helpful error messages
            if "api_key" in error_msg.lower():
                provider = self._get_provider_for_model(model)
                env_vars = self.API_KEY_ENV_VARS.get(provider, [])
                return f"Error: API key issue for {provider}. Make sure one of these is set: {', '.join(env_vars)}\n\nOriginal error: {error_msg}"
            elif "model" in error_msg.lower() and "not found" in error_msg.lower():
                return f"Error: Model '{model}' not found or not accessible. Check the model name and your API permissions.\n\nOriginal error: {error_msg}"
            else:
                return f"Error calling LLM: {error_msg}"

    def _get_provider_for_model(self, model: str) -> Optional[str]:
        """Determine the provider for a given model."""
        model_lower = model.lower()
        
        # Check explicit provider prefix (e.g., "groq/mixtral")
        if "/" in model:
            provider = model.split("/")[0]
            return provider
        
        # Check model prefixes
        for provider, prefixes in self.PROVIDER_MODELS.items():
            for prefix in prefixes:
                if model_lower.startswith(prefix.lower()):
                    return provider
        
        # Default to OpenAI for unknown models
        return "openai"

    @classmethod
    def get_all_models(cls) -> Dict[str, List[str]]:
        """Get all available models from LiteLLM organized by provider."""
        if not LITELLM_AVAILABLE:
            return {}
        
        try:
            import litellm
            
            # Get all models
            all_models = litellm.model_list
            
            # Organize by provider
            providers = {}
            
            for model in all_models:
                # Extract provider
                if "/" in model:
                    provider = model.split("/")[0]
                elif model.startswith("gpt"):
                    provider = "openai"
                elif model.startswith("claude"):
                    provider = "anthropic"
                elif model.startswith("gemini"):
                    provider = "google"
                elif model.startswith("command"):
                    provider = "cohere"
                else:
                    provider = "other"
                
                if provider not in providers:
                    providers[provider] = []
                providers[provider].append(model)
            
            # Sort models within each provider
            for provider in providers:
                providers[provider] = sorted(providers[provider])
            
            return providers
        except Exception:
            return {}

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
