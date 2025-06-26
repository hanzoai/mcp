"""LLM management tool for enabling/disabling LLM providers."""

import os
import json
from typing import Annotated, Optional, TypedDict, Unpack, final, override
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.llm.llm_tool import LLMTool


Action = Annotated[
    str,
    Field(
        description="Action to perform: list, enable, disable, test",
        min_length=1,
    ),
]

Provider = Annotated[
    Optional[str],
    Field(
        description="Provider name (for enable/disable/test actions)",
        default=None,
    ),
]

Model = Annotated[
    Optional[str],
    Field(
        description="Model to test (for test action)",
        default=None,
    ),
]


class LLMManageParams(TypedDict, total=False):
    """Parameters for LLM management tool."""

    action: str
    provider: Optional[str]
    model: Optional[str]


@final
class LLMManageTool(BaseTool):
    """Tool for managing LLM providers."""
    
    def __init__(self):
        """Initialize the LLM management tool."""
        self.llm_tool = LLMTool()
        self.config_file = Path.home() / ".hanzo" / "llm" / "providers.json"
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        self._load_config()

    def _load_config(self):
        """Load provider configuration."""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    self.config = json.load(f)
            except:
                self.config = {"disabled_providers": []}
        else:
            self.config = {"disabled_providers": []}

    def _save_config(self):
        """Save provider configuration."""
        with open(self.config_file, 'w') as f:
            json.dump(self.config, f, indent=2)

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "llm_manage"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        return """Manage LLM providers and test configurations.

Actions:
- list: Show all providers and their status
- models: List all available models (optionally filtered by provider)
- enable: Enable a provider's tools
- disable: Disable a provider's tools
- test: Test a model to verify it works

Examples:
- llm_manage --action list
- llm_manage --action models
- llm_manage --action models --provider openai
- llm_manage --action enable --provider openai
- llm_manage --action disable --provider perplexity
- llm_manage --action test --model "gpt-4" 
- llm_manage --action test --provider groq --model "mixtral"

Providers are automatically detected based on environment variables:
- OpenAI: OPENAI_API_KEY
- Anthropic: ANTHROPIC_API_KEY or CLAUDE_API_KEY
- Google: GOOGLE_API_KEY or GEMINI_API_KEY
- Groq: GROQ_API_KEY
- Mistral: MISTRAL_API_KEY
- Perplexity: PERPLEXITY_API_KEY
- And many more...
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[LLMManageParams],
    ) -> str:
        """Manage LLM providers.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Result of the management action
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        action = params.get("action")
        if not action:
            return "Error: action is required (list, enable, disable, test, models)"

        provider = params.get("provider")
        model = params.get("model")

        # Handle different actions
        if action == "list":
            return self._list_providers()
        elif action == "models":
            return self._list_all_models(provider)
        elif action == "enable":
            return self._enable_provider(provider)
        elif action == "disable":
            return self._disable_provider(provider)
        elif action == "test":
            return await self._test_model(ctx, provider, model)
        else:
            return f"Error: Invalid action '{action}'. Must be one of: list, models, enable, disable, test"

    def _list_providers(self) -> str:
        """List all providers and their status."""
        output = ["=== LLM Providers ==="]
        output.append("")
        
        # Get all possible providers
        all_providers = sorted(LLMTool.API_KEY_ENV_VARS.keys())
        available_providers = self.llm_tool.available_providers
        disabled_providers = self.config.get("disabled_providers", [])
        
        # Categorize providers
        active = []
        available_but_disabled = []
        no_api_key = []
        
        for provider in all_providers:
            if provider in available_providers:
                if provider in disabled_providers:
                    available_but_disabled.append(provider)
                else:
                    active.append(provider)
            else:
                no_api_key.append(provider)
        
        # Show active providers
        if active:
            output.append("✅ Active Providers (API key found, enabled):")
            for provider in active:
                env_vars = available_providers.get(provider, [])
                output.append(f"  - {provider}: {', '.join(env_vars)}")
                
                # Show example models
                examples = self._get_example_models(provider)
                if examples:
                    output.append(f"    Models: {', '.join(examples[:3])}")
            output.append("")
        
        # Show disabled providers
        if available_but_disabled:
            output.append("⚠️  Available but Disabled (API key found, disabled):")
            for provider in available_but_disabled:
                env_vars = available_providers.get(provider, [])
                output.append(f"  - {provider}: {', '.join(env_vars)}")
                output.append(f"    Use: llm_manage --action enable --provider {provider}")
            output.append("")
        
        # Show providers without API keys
        if no_api_key:
            output.append("❌ No API Key Found:")
            for provider in no_api_key[:10]:  # Show first 10
                env_vars = LLMTool.API_KEY_ENV_VARS.get(provider, [])
                output.append(f"  - {provider}: Set one of {', '.join(env_vars)}")
            if len(no_api_key) > 10:
                output.append(f"  ... and {len(no_api_key) - 10} more")
            output.append("")
        
        # Summary
        output.append("=== Summary ===")
        output.append(f"Total providers: {len(all_providers)}")
        output.append(f"Active: {len(active)}")
        output.append(f"Disabled: {len(available_but_disabled)}")
        output.append(f"No API key: {len(no_api_key)}")
        
        # Show available tools
        if active:
            output.append("\n=== Available LLM Tools ===")
            output.append("- llm: Universal LLM tool (all providers)")
            output.append("- consensus: Query multiple models in parallel")
            
            provider_tools = []
            for provider in active:
                if provider in ["openai", "anthropic", "google", "groq", "mistral", "perplexity"]:
                    tool_name = "gemini" if provider == "google" else provider
                    provider_tools.append(tool_name)
            
            if provider_tools:
                output.append(f"- Provider tools: {', '.join(provider_tools)}")
        
        return "\n".join(output)

    def _enable_provider(self, provider: Optional[str]) -> str:
        """Enable a provider."""
        if not provider:
            return "Error: provider is required for enable action"
        
        if provider not in self.llm_tool.available_providers:
            env_vars = LLMTool.API_KEY_ENV_VARS.get(provider, [])
            if env_vars:
                return f"Error: No API key found for {provider}. Set one of: {', '.join(env_vars)}"
            else:
                return f"Error: Unknown provider '{provider}'"
        
        disabled = self.config.get("disabled_providers", [])
        if provider in disabled:
            disabled.remove(provider)
            self.config["disabled_providers"] = disabled
            self._save_config()
            return f"Successfully enabled {provider}"
        else:
            return f"{provider} is already enabled"

    def _disable_provider(self, provider: Optional[str]) -> str:
        """Disable a provider."""
        if not provider:
            return "Error: provider is required for disable action"
        
        disabled = self.config.get("disabled_providers", [])
        if provider not in disabled:
            disabled.append(provider)
            self.config["disabled_providers"] = disabled
            self._save_config()
            return f"Successfully disabled {provider}. Its tools will no longer be available."
        else:
            return f"{provider} is already disabled"

    def _list_all_models(self, provider: Optional[str] = None) -> str:
        """List all available models from LiteLLM."""
        try:
            from hanzo_mcp.tools.llm.llm_tool import LLMTool
            
            all_models = LLMTool.get_all_models()
            
            if not all_models:
                return "No models available or LiteLLM not installed"
            
            output = ["=== Available LLM Models ==="]
            
            if provider:
                # Show models for specific provider
                provider_lower = provider.lower()
                models = all_models.get(provider_lower, [])
                
                if not models:
                    return f"No models found for provider '{provider}'"
                
                output.append(f"\n{provider.upper()} ({len(models)} models):")
                output.append("-" * 40)
                
                # Show first 50 models
                for model in models[:50]:
                    output.append(f"  {model}")
                
                if len(models) > 50:
                    output.append(f"  ... and {len(models) - 50} more")
            else:
                # Show summary of all providers
                total_models = sum(len(models) for models in all_models.values())
                output.append(f"Total models available: {total_models}")
                output.append("")
                
                # Show providers with counts
                for provider_name, models in sorted(all_models.items()):
                    if models:
                        output.append(f"{provider_name}: {len(models)} models")
                
                output.append("\nUse 'llm_manage --action models --provider <name>' to see models for a specific provider")
                
                # Show recommended models
                output.append("\n=== Recommended Models ===")
                recommended = {
                    "OpenAI": ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
                    "Anthropic": ["claude-3-opus-20240229", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"],
                    "Google": ["gemini/gemini-1.5-pro", "gemini/gemini-1.5-flash"],
                    "Groq": ["groq/llama3-70b-8192", "groq/llama3-8b-8192", "groq/gemma2-9b-it"],
                    "Mistral": ["mistral/mistral-large-latest", "mistral/mistral-medium"],
                }
                
                for provider_name, models in recommended.items():
                    available = LLMTool().available_providers
                    provider_key = provider_name.lower()
                    
                    if provider_key in available:
                        output.append(f"\n{provider_name} (✅ API key found):")
                        for model in models:
                            output.append(f"  - {model}")
                    else:
                        output.append(f"\n{provider_name} (❌ No API key):")
                        for model in models:
                            output.append(f"  - {model}")
            
            return "\n".join(output)
            
        except Exception as e:
            return f"Error listing models: {str(e)}"

    async def _test_model(self, ctx: MCPContext, provider: Optional[str], model: Optional[str]) -> str:
        """Test a model to verify it works."""
        if not model and not provider:
            return "Error: Either model or provider is required for test action"
        
        # Determine model to test
        if model:
            test_model = model
        else:
            # Use default model for provider
            default_models = {
                "openai": "gpt-3.5-turbo",
                "anthropic": "claude-3-haiku-20240307",
                "google": "gemini/gemini-pro",
                "groq": "groq/mixtral-8x7b-32768",
                "mistral": "mistral/mistral-tiny",
                "perplexity": "perplexity/sonar-small-online",
            }
            test_model = default_models.get(provider)
            if not test_model:
                return f"Error: No default model for provider '{provider}'. Please specify a model."
        
        # Test the model
        test_prompt = "Hello! Please respond with 'OK' if you can hear me."
        
        output = [f"Testing model: {test_model}"]
        output.append(f"Prompt: {test_prompt}")
        output.append("")
        
        try:
            # Call the LLM
            params = {
                "model": test_model,
                "prompt": test_prompt,
                "max_tokens": 10,
                "temperature": 0,
            }
            
            response = await self.llm_tool.call(ctx, **params)
            
            if response.startswith("Error:"):
                output.append("❌ Test failed:")
                output.append(response)
            else:
                output.append("✅ Test successful!")
                output.append(f"Response: {response}")
                output.append("")
                output.append(f"Model '{test_model}' is working correctly.")
                
                # Show provider info
                detected_provider = self.llm_tool._get_provider_for_model(test_model)
                if detected_provider:
                    output.append(f"Provider: {detected_provider}")
        
        except Exception as e:
            output.append("❌ Test failed with exception:")
            output.append(str(e))
        
        return "\n".join(output)

    def _get_example_models(self, provider: str) -> list[str]:
        """Get example models for a provider."""
        examples = {
            "openai": ["gpt-4o", "gpt-4", "gpt-3.5-turbo", "o1-preview"],
            "anthropic": ["claude-3-opus-20240229", "claude-3-sonnet-20240229", "claude-3-haiku-20240307"],
            "google": ["gemini/gemini-pro", "gemini/gemini-1.5-pro", "gemini/gemini-1.5-flash"],
            "groq": ["groq/mixtral-8x7b-32768", "groq/llama3-70b-8192", "groq/llama3-8b-8192"],
            "mistral": ["mistral/mistral-large-latest", "mistral/mistral-medium", "mistral/mistral-small"],
            "perplexity": ["perplexity/sonar-medium-online", "perplexity/sonar-small-online"],
        }
        return examples.get(provider, [])

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
