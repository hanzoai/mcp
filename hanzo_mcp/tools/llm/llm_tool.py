"""Unified LLM tool with multiple actions including consensus mode."""

from typing import Annotated, TypedDict, Unpack, final, override, Optional, List, Dict, Any
import asyncio
import os
import json
from pathlib import Path

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context

# Check if litellm is available
try:
    import litellm
    LITELLM_AVAILABLE = True
except ImportError:
    LITELLM_AVAILABLE = False


# Parameter types
Action = Annotated[
    str,
    Field(
        description="Action to perform: query, consensus, list, models, enable, disable, test",
        default="query",
    ),
]

Model = Annotated[
    Optional[str],
    Field(
        description="Model name (e.g., gpt-4, claude-3-opus-20240229)",
        default=None,
    ),
]

Models = Annotated[
    Optional[List[str]],
    Field(
        description="List of models for consensus mode",
        default=None,
    ),
]

Prompt = Annotated[
    Optional[str],
    Field(
        description="The prompt to send to the LLM",
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
        description="Temperature for response randomness (0-2)",
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

Provider = Annotated[
    Optional[str],
    Field(
        description="Provider name for list/enable/disable actions",
        default=None,
    ),
]

IncludeRaw = Annotated[
    bool,
    Field(
        description="Include raw responses in consensus mode",
        default=False,
    ),
]

JudgeModel = Annotated[
    Optional[str],
    Field(
        description="Model to use as judge/aggregator in consensus",
        default=None,
    ),
]

DevilsAdvocate = Annotated[
    bool,
    Field(
        description="Enable devil's advocate mode (10th model critiques others)",
        default=False,
    ),
]

ConsensusSize = Annotated[
    Optional[int],
    Field(
        description="Number of models to use in consensus (default: 3)",
        default=None,
    ),
]


class LLMParams(TypedDict, total=False):
    """Parameters for LLM tool."""
    action: str
    model: Optional[str]
    models: Optional[List[str]]
    prompt: Optional[str]
    system_prompt: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    json_mode: bool
    stream: bool
    provider: Optional[str]
    include_raw: bool
    judge_model: Optional[str]
    devils_advocate: bool
    consensus_size: Optional[int]


@final
class LLMTool(BaseTool):
    """Unified LLM tool with multiple actions."""
    
    # Config file for settings
    CONFIG_FILE = Path.home() / ".hanzo" / "mcp" / "llm_config.json"
    
    # Default consensus models in order of preference
    DEFAULT_CONSENSUS_MODELS = [
        "gpt-4o",  # OpenAI's latest
        "claude-3-opus-20240229",  # Claude's most capable
        "gemini/gemini-1.5-pro",  # Google's best
        "groq/llama3-70b-8192",  # Fast Groq
        "mistral/mistral-large-latest",  # Mistral's best
        "perplexity/llama-3.1-sonar-large-128k-chat",  # Perplexity with search
    ]
    
    # API key environment variables
    API_KEY_ENV_VARS = {
        "openai": ["OPENAI_API_KEY"],
        "anthropic": ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
        "google": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "groq": ["GROQ_API_KEY"],
        "mistral": ["MISTRAL_API_KEY"],
        "perplexity": ["PERPLEXITY_API_KEY", "PERPLEXITYAI_API_KEY"],
        "together": ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
        "cohere": ["COHERE_API_KEY"],
        "replicate": ["REPLICATE_API_KEY"],
        "huggingface": ["HUGGINGFACE_API_KEY", "HF_TOKEN"],
        "bedrock": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        "vertex": ["GOOGLE_APPLICATION_CREDENTIALS"],
        "azure": ["AZURE_API_KEY"],
        "voyage": ["VOYAGE_API_KEY"],
        "deepseek": ["DEEPSEEK_API_KEY"],
    }
    
    def __init__(self):
        """Initialize the unified LLM tool."""
        self.available_providers = self._detect_available_providers()
        self.config = self._load_config()
        
    def _detect_available_providers(self) -> Dict[str, List[str]]:
        """Detect which providers have API keys configured."""
        available = {}
        
        for provider, env_vars in self.API_KEY_ENV_VARS.items():
            for var in env_vars:
                if os.getenv(var):
                    available[provider] = env_vars
                    break
        
        return available
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file."""
        if self.CONFIG_FILE.exists():
            try:
                with open(self.CONFIG_FILE, 'r') as f:
                    return json.load(f)
            except:
                pass
        
        # Default config
        return {
            "disabled_providers": [],
            "consensus_models": None,  # Use defaults if None
            "default_judge_model": "gpt-4o",
            "consensus_size": 3,
        }
    
    def _save_config(self):
        """Save configuration to file."""
        self.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(self.CONFIG_FILE, 'w') as f:
            json.dump(self.config, f, indent=2)

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "llm"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        available = list(self.available_providers.keys())
        
        return f"""Query LLMs. Default: single query. Actions: consensus, list, models, test.

Usage:
llm "What is the capital of France?"
llm "Explain this code" --model gpt-4o
llm --action consensus "Is this approach correct?" --devils-advocate
llm --action models --provider openai

Available: {', '.join(available) if available else 'None'}"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[LLMParams],
    ) -> str:
        """Execute LLM action."""
        # Create tool context only if we have a proper MCP context
        tool_ctx = None
        try:
            if hasattr(ctx, 'client') and ctx.client and hasattr(ctx.client, 'server'):
                tool_ctx = create_tool_context(ctx)
                if tool_ctx:
                    await tool_ctx.set_tool_info(self.name)
        except:
            # Running in test mode without MCP context
            pass

        if not LITELLM_AVAILABLE:
            return "Error: LiteLLM is not installed. Install it with: pip install litellm"

        # Extract action
        action = params.get("action", "query")
        
        # Route to appropriate handler
        if action == "query":
            return await self._handle_query(tool_ctx, params)
        elif action == "consensus":
            return await self._handle_consensus(tool_ctx, params)
        elif action == "list":
            return self._handle_list()
        elif action == "models":
            return self._handle_models(params.get("provider"))
        elif action == "enable":
            return self._handle_enable(params.get("provider"))
        elif action == "disable":
            return self._handle_disable(params.get("provider"))
        elif action == "test":
            return await self._handle_test(tool_ctx, params.get("model"), params.get("provider"))
        else:
            return f"Error: Unknown action '{action}'. Valid actions: query, consensus, list, models, enable, disable, test"

    async def _handle_query(self, tool_ctx, params: Dict[str, Any]) -> str:
        """Handle single model query."""
        model = params.get("model")
        prompt = params.get("prompt")
        
        if not prompt:
            return "Error: prompt is required for query action"
        
        # Auto-select model if not specified
        if not model:
            if self.available_providers:
                # Use first available model
                if "openai" in self.available_providers:
                    model = "gpt-4o-mini"
                elif "anthropic" in self.available_providers:
                    model = "claude-3-haiku-20240307"
                elif "google" in self.available_providers:
                    model = "gemini/gemini-1.5-flash"
                else:
                    # Use first provider's default
                    provider = list(self.available_providers.keys())[0]
                    model = f"{provider}/default"
            else:
                return "Error: No model specified and no API keys found"
        
        # Check if we have API key for this model
        provider = self._get_provider_for_model(model)
        if provider and provider not in self.available_providers:
            env_vars = self.API_KEY_ENV_VARS.get(provider, [])
            return f"Error: No API key found for {provider}. Set one of: {', '.join(env_vars)}"
        
        # Build messages
        messages = []
        if params.get("system_prompt"):
            messages.append({"role": "system", "content": params["system_prompt"]})
        messages.append({"role": "user", "content": prompt})
        
        # Build kwargs
        kwargs = {
            "model": model,
            "messages": messages,
            "temperature": params.get("temperature", 0.7),
        }
        
        if params.get("max_tokens"):
            kwargs["max_tokens"] = params["max_tokens"]
        
        if params.get("json_mode"):
            kwargs["response_format"] = {"type": "json_object"}
        
        if params.get("stream"):
            kwargs["stream"] = True
        
        try:
            if tool_ctx:
                await tool_ctx.info(f"Querying {model}...")
            
            if kwargs.get("stream"):
                # Handle streaming response
                response_text = ""
                async for chunk in await litellm.acompletion(**kwargs):
                    if chunk.choices[0].delta.content:
                        response_text += chunk.choices[0].delta.content
                return response_text
            else:
                # Regular response
                response = await litellm.acompletion(**kwargs)
                return response.choices[0].message.content
                
        except Exception as e:
            error_msg = str(e)
            if "model_not_found" in error_msg or "does not exist" in error_msg:
                return f"Error: Model '{model}' not found. Use 'llm --action models' to see available models."
            else:
                return f"Error calling LLM: {error_msg}"

    async def _handle_consensus(self, tool_ctx, params: Dict[str, Any]) -> str:
        """Handle consensus mode with multiple models."""
        prompt = params.get("prompt")
        if not prompt:
            return "Error: prompt is required for consensus action"
        
        # Determine models to use
        models = params.get("models")
        if not models:
            # Use configured or default models
            consensus_size = params.get("consensus_size") or self.config.get("consensus_size", 3)
            models = self._get_consensus_models(consensus_size)
        
        if not models:
            return "Error: No models available for consensus. Set API keys for at least 2 providers."
        
        if len(models) < 2:
            return "Error: Consensus requires at least 2 models"
        
        # Check for devil's advocate mode
        devils_advocate = params.get("devils_advocate", False)
        if devils_advocate and len(models) < 3:
            return "Error: Devil's advocate mode requires at least 3 models"
        
        if tool_ctx:
            await tool_ctx.info(f"Running consensus with {len(models)} models...")
        
        # Query models in parallel
        system_prompt = params.get("system_prompt")
        temperature = params.get("temperature", 0.7)
        max_tokens = params.get("max_tokens")
        
        # Split models if using devil's advocate
        if devils_advocate:
            consensus_models = models[:-1]
            devil_model = models[-1]
        else:
            consensus_models = models
            devil_model = None
        
        # Query consensus models
        responses = await self._query_models_parallel(
            consensus_models, prompt, system_prompt, temperature, max_tokens, tool_ctx
        )
        
        # Get devil's advocate response if enabled
        devil_response = None
        if devil_model:
            # Create devil's advocate prompt
            responses_text = "\n\n".join([
                f"Model {i+1}: {resp['response']}" 
                for i, resp in enumerate(responses) if resp['response']
            ])
            
            devil_prompt = f"""You are a critical analyst. Review these responses to the question below and provide a devil's advocate perspective. Challenge assumptions, point out weaknesses, and suggest alternative viewpoints.

Original Question: {prompt}

Responses from other models:
{responses_text}

Provide your critical analysis:"""
            
            devil_result = await self._query_single_model(
                devil_model, devil_prompt, system_prompt, temperature, max_tokens
            )
            
            if devil_result['success']:
                devil_response = {
                    'model': devil_model,
                    'response': devil_result['response'],
                    'time_ms': devil_result['time_ms']
                }
        
        # Aggregate responses
        judge_model = params.get("judge_model") or self.config.get("default_judge_model", "gpt-4o")
        include_raw = params.get("include_raw", False)
        
        return await self._aggregate_consensus(
            responses, prompt, judge_model, include_raw, devil_response, tool_ctx
        )

    def _handle_list(self) -> str:
        """List available providers."""
        output = ["=== LLM Providers ==="]
        
        # Get all possible providers
        all_providers = sorted(self.API_KEY_ENV_VARS.keys())
        disabled = self.config.get("disabled_providers", [])
        
        output.append(f"Total providers: {len(all_providers)}")
        output.append(f"Available: {len(self.available_providers)}")
        output.append(f"Disabled: {len(disabled)}\n")
        
        for provider in all_providers:
            status_parts = []
            
            # Check if API key exists
            if provider in self.available_providers:
                status_parts.append("✅ API key found")
            else:
                status_parts.append("❌ No API key")
            
            # Check if disabled
            if provider in disabled:
                status_parts.append("🚫 Disabled")
            
            # Show environment variables
            env_vars = self.API_KEY_ENV_VARS.get(provider, [])
            status = " | ".join(status_parts)
            
            output.append(f"{provider}: {status}")
            output.append(f"  Environment variables: {', '.join(env_vars)}")
        
        output.append("\nUse 'llm --action enable/disable --provider <name>' to manage providers")
        
        return "\n".join(output)

    def _handle_models(self, provider: Optional[str] = None) -> str:
        """List available models."""
        try:
            all_models = self._get_all_models()
            
            if not all_models:
                return "No models available or LiteLLM not properly initialized"
            
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
                        available = "✅" if provider_name in self.available_providers else "❌"
                        output.append(f"{available} {provider_name}: {len(models)} models")
                
                output.append("\nUse 'llm --action models --provider <name>' to see specific models")
            
            return "\n".join(output)
            
        except Exception as e:
            return f"Error listing models: {str(e)}"

    def _handle_enable(self, provider: Optional[str]) -> str:
        """Enable a provider."""
        if not provider:
            return "Error: provider is required for enable action"
        
        provider = provider.lower()
        disabled = self.config.get("disabled_providers", [])
        
        if provider in disabled:
            disabled.remove(provider)
            self.config["disabled_providers"] = disabled
            self._save_config()
            return f"Successfully enabled {provider}"
        else:
            return f"{provider} is already enabled"

    def _handle_disable(self, provider: Optional[str]) -> str:
        """Disable a provider."""
        if not provider:
            return "Error: provider is required for disable action"
        
        provider = provider.lower()
        disabled = self.config.get("disabled_providers", [])
        
        if provider not in disabled:
            disabled.append(provider)
            self.config["disabled_providers"] = disabled
            self._save_config()
            return f"Successfully disabled {provider}"
        else:
            return f"{provider} is already disabled"

    async def _handle_test(self, tool_ctx, model: Optional[str], provider: Optional[str]) -> str:
        """Test a model or provider."""
        if not model and not provider:
            return "Error: Either model or provider is required for test action"
        
        # If provider specified, test its default model
        if provider and not model:
            provider = provider.lower()
            if provider == "openai":
                model = "gpt-3.5-turbo"
            elif provider == "anthropic":
                model = "claude-3-haiku-20240307"
            elif provider == "google":
                model = "gemini/gemini-1.5-flash"
            elif provider == "groq":
                model = "groq/llama3-8b-8192"
            else:
                model = f"{provider}/default"
        
        # Test the model
        test_prompt = "Say 'Hello from Hanzo AI!' in exactly 5 words."
        
        try:
            if tool_ctx:
                await tool_ctx.info(f"Testing {model}...")
            
            response = await litellm.acompletion(
                model=model,
                messages=[{"role": "user", "content": test_prompt}],
                temperature=0,
                max_tokens=20
            )
            
            result = response.choices[0].message.content
            return f"✅ {model} is working!\nResponse: {result}"
            
        except Exception as e:
            return f"❌ {model} failed: {str(e)}"

    def _get_consensus_models(self, size: int) -> List[str]:
        """Get models for consensus based on availability."""
        # Use configured models if set
        configured = self.config.get("consensus_models")
        if configured:
            return configured[:size]
        
        # Otherwise, build list from available providers
        models = []
        disabled = self.config.get("disabled_providers", [])
        
        # Try default models first
        for model in self.DEFAULT_CONSENSUS_MODELS:
            if len(models) >= size:
                break
                
            provider = self._get_provider_for_model(model)
            if provider and provider in self.available_providers and provider not in disabled:
                models.append(model)
        
        # If still need more, add from available providers
        if len(models) < size:
            for provider in self.available_providers:
                if provider in disabled:
                    continue
                    
                if provider == "openai" and "gpt-4o" not in models:
                    models.append("gpt-4o")
                elif provider == "anthropic" and "claude-3-opus-20240229" not in models:
                    models.append("claude-3-opus-20240229")
                elif provider == "google" and "gemini/gemini-1.5-pro" not in models:
                    models.append("gemini/gemini-1.5-pro")
                
                if len(models) >= size:
                    break
        
        return models

    async def _query_models_parallel(
        self, models: List[str], prompt: str, system_prompt: Optional[str],
        temperature: float, max_tokens: Optional[int], tool_ctx
    ) -> List[Dict[str, Any]]:
        """Query multiple models in parallel."""
        async def query_with_info(model: str) -> Dict[str, Any]:
            result = await self._query_single_model(model, prompt, system_prompt, temperature, max_tokens)
            return {
                'model': model,
                'response': result.get('response'),
                'success': result.get('success', False),
                'error': result.get('error'),
                'time_ms': result.get('time_ms', 0)
            }
        
        # Run all queries in parallel
        tasks = [query_with_info(model) for model in models]
        results = await asyncio.gather(*tasks)
        
        # Report results
        successful = sum(1 for r in results if r['success'])
        if tool_ctx:
            await tool_ctx.info(f"Completed {successful}/{len(models)} model queries")
        
        return results

    async def _query_single_model(
        self, model: str, prompt: str, system_prompt: Optional[str],
        temperature: float, max_tokens: Optional[int]
    ) -> Dict[str, Any]:
        """Query a single model and return result with metadata."""
        import time
        start_time = time.time()
        
        try:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})
            
            kwargs = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
            }
            if max_tokens:
                kwargs["max_tokens"] = max_tokens
            
            response = await litellm.acompletion(**kwargs)
            
            return {
                'success': True,
                'response': response.choices[0].message.content,
                'time_ms': int((time.time() - start_time) * 1000)
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'time_ms': int((time.time() - start_time) * 1000)
            }

    async def _aggregate_consensus(
        self, responses: List[Dict[str, Any]], original_prompt: str,
        judge_model: str, include_raw: bool, devil_response: Optional[Dict[str, Any]],
        tool_ctx
    ) -> str:
        """Aggregate consensus responses using a judge model."""
        # Prepare response data
        successful_responses = [r for r in responses if r['success']]
        
        if not successful_responses:
            return "Error: All models failed to respond"
        
        # Format responses for aggregation
        responses_text = "\n\n".join([
            f"Model: {r['model']}\nResponse: {r['response']}"
            for r in successful_responses
        ])
        
        if devil_response:
            responses_text += f"\n\nDevil's Advocate ({devil_response['model']}):\n{devil_response['response']}"
        
        # Create aggregation prompt
        aggregation_prompt = f"""Analyze the following responses from multiple AI models to this question:

<original_question>
{original_prompt}
</original_question>

<model_responses>
{responses_text}
</model_responses>

Please provide:
1. A synthesis of the key points where models agree
2. Notable differences or disagreements between responses
3. A balanced conclusion incorporating the best insights
{f"4. Evaluation of the devil's advocate critique" if devil_response else ""}

Be concise and highlight the most important findings."""
        
        # Get aggregation
        try:
            if tool_ctx:
                await tool_ctx.info(f"Aggregating responses with {judge_model}...")
            
            judge_result = await self._query_single_model(
                judge_model, aggregation_prompt, None, 0.3, None
            )
            
            if not judge_result['success']:
                return f"Error: Judge model failed: {judge_result.get('error', 'Unknown error')}"
            
            # Format output
            output = [f"=== Consensus Analysis ({len(successful_responses)} models) ===\n"]
            output.append(judge_result['response'])
            
            # Add model list
            output.append(f"\nModels consulted: {', '.join([r['model'] for r in successful_responses])}")
            if devil_response:
                output.append(f"Devil's Advocate: {devil_response['model']}")
            
            # Add timing info
            avg_time = sum(r['time_ms'] for r in responses) / len(responses)
            output.append(f"\nAverage response time: {avg_time:.0f}ms")
            
            # Include raw responses if requested
            if include_raw:
                output.append("\n\n=== Raw Responses ===")
                for r in successful_responses:
                    output.append(f"\n{r['model']}:")
                    output.append("-" * 40)
                    output.append(r['response'])
                
                if devil_response:
                    output.append(f"\nDevil's Advocate ({devil_response['model']}):")
                    output.append("-" * 40)
                    output.append(devil_response['response'])
            
            return "\n".join(output)
            
        except Exception as e:
            return f"Error during aggregation: {str(e)}"

    def _get_provider_for_model(self, model: str) -> Optional[str]:
        """Determine the provider for a given model."""
        model_lower = model.lower()
        
        # Check explicit provider prefix
        if "/" in model:
            return model.split("/")[0]
        
        # Check model prefixes
        if model_lower.startswith("gpt"):
            return "openai"
        elif model_lower.startswith("claude"):
            return "anthropic"
        elif model_lower.startswith("gemini"):
            return "google"
        elif model_lower.startswith("command"):
            return "cohere"
        
        # Default to OpenAI
        return "openai"

    def _get_all_models(self) -> Dict[str, List[str]]:
        """Get all available models from LiteLLM."""
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