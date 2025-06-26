"""Consensus tool for querying multiple LLMs in parallel."""

import asyncio
import json
from typing import Annotated, Optional, TypedDict, Unpack, final, override, List, Dict, Any
from datetime import datetime

from mcp.server.fastmcp import Context as MCPContext
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context
from hanzo_mcp.tools.llm.llm_tool import LLMTool


Prompt = Annotated[
    str,
    Field(
        description="The prompt to send to all models",
        min_length=1,
    ),
]

Models = Annotated[
    Optional[List[str]],
    Field(
        description="List of models to query (defaults to a diverse set)",
        default=None,
    ),
]

SystemPrompt = Annotated[
    Optional[str],
    Field(
        description="System prompt for all models",
        default=None,
    ),
]

Temperature = Annotated[
    float,
    Field(
        description="Temperature for all models",
        default=0.7,
    ),
]

MaxTokens = Annotated[
    Optional[int],
    Field(
        description="Maximum tokens per response",
        default=None,
    ),
]

AggregationModel = Annotated[
    Optional[str],
    Field(
        description="Model to use for aggregating responses (defaults to gpt-4)",
        default="gpt-4",
    ),
]

IncludeRaw = Annotated[
    bool,
    Field(
        description="Include raw responses from each model",
        default=False,
    ),
]

Timeout = Annotated[
    int,
    Field(
        description="Timeout in seconds for each model",
        default=30,
    ),
]


class ConsensusToolParams(TypedDict, total=False):
    """Parameters for consensus tool."""

    prompt: str
    models: Optional[List[str]]
    system_prompt: Optional[str]
    temperature: float
    max_tokens: Optional[int]
    aggregation_model: Optional[str]
    include_raw: bool
    timeout: int


@final
class ConsensusTool(BaseTool):
    """Tool for getting consensus from multiple LLMs."""
    
    # Default models to use if none specified - mix of fast and powerful models
    DEFAULT_MODELS = [
        "gpt-4o-mini",  # OpenAI's fast model
        "claude-3-opus-20240229",  # Claude's most capable model
        "gemini/gemini-1.5-pro",  # Google's largest model
        "groq/llama3-70b-8192",  # Fast inference via Groq
        "mistral/mistral-large-latest",  # Mistral's best model
    ]

    def __init__(self):
        """Initialize the consensus tool."""
        self.llm_tool = LLMTool()

    @property
    @override
    def name(self) -> str:
        """Get the tool name."""
        return "consensus"

    @property
    @override
    def description(self) -> str:
        """Get the tool description."""
        available_providers = list(self.llm_tool.available_providers.keys())
        
        return f"""Query multiple LLMs in parallel and get a consensus response.

Queries multiple models simultaneously, then uses another model to
synthesize and analyze the responses for consensus, disagreements, and insights.

Available providers: {', '.join(available_providers)}

Default models (if available):
- GPT-4 (OpenAI)
- Claude 3 Sonnet (Anthropic)
- Gemini Pro (Google)
- Mixtral 8x7B (Groq)
- Mistral Medium (Mistral)

Examples:
- consensus --prompt "What are the key principles of good software design?"
- consensus --prompt "Analyze this code for security issues" --models '["gpt-4", "claude-3-opus-20240229"]'
- consensus --prompt "Is this implementation correct?" --include-raw
- consensus --prompt "What's the best approach?" --aggregation-model "claude-3-opus-20240229"

The tool will:
1. Query all specified models in parallel
2. Collect and analyze responses
3. Use the aggregation model to synthesize findings
4. Highlight areas of agreement and disagreement
5. Provide a balanced consensus view
"""

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[ConsensusToolParams],
    ) -> str:
        """Get consensus from multiple LLMs.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Consensus analysis
        """
        tool_ctx = create_tool_context(ctx)
        await tool_ctx.set_tool_info(self.name)

        # Extract parameters
        prompt = params.get("prompt")
        if not prompt:
            return "Error: prompt is required"

        models = params.get("models") or self.DEFAULT_MODELS
        system_prompt = params.get("system_prompt")
        temperature = params.get("temperature", 0.7)
        max_tokens = params.get("max_tokens")
        aggregation_model = params.get("aggregation_model", "gpt-4")
        include_raw = params.get("include_raw", False)
        timeout = params.get("timeout", 30)

        # Filter models to only those with available API keys
        available_models = []
        skipped_models = []
        
        for model in models:
            provider = self.llm_tool._get_provider_for_model(model)
            if provider in self.llm_tool.available_providers:
                available_models.append(model)
            else:
                skipped_models.append((model, provider))
        
        if not available_models:
            return "Error: No models available with configured API keys. Please set API keys for at least one provider."
        
        await tool_ctx.info(f"Querying {len(available_models)} models in parallel...")
        
        if skipped_models:
            skipped_info = ", ".join([f"{m[0]} ({m[1]})" for m in skipped_models])
            await tool_ctx.info(f"Skipping models without API keys: {skipped_info}")

        # Query all models in parallel
        results = await self._query_models_parallel(
            available_models, prompt, system_prompt, 
            temperature, max_tokens, timeout
        )

        # Prepare summary of results
        successful_responses = [(m, r) for m, r in results.items() if not r.startswith("Error:")]
        failed_responses = [(m, r) for m, r in results.items() if r.startswith("Error:")]

        if not successful_responses:
            return "Error: All model queries failed:\n\n" + "\n".join([f"{m}: {r}" for m, r in failed_responses])

        # Use aggregation model to synthesize responses
        consensus = await self._aggregate_responses(
            successful_responses, prompt, aggregation_model
        )

        # Format output
        output = ["=== LLM Consensus Analysis ==="]
        output.append(f"Query: {prompt}")
        output.append(f"Models queried: {len(available_models)}")
        output.append(f"Successful responses: {len(successful_responses)}")
        
        if failed_responses:
            output.append(f"Failed responses: {len(failed_responses)}")
        
        output.append("")
        output.append("=== Consensus Summary ===")
        output.append(consensus)
        
        if include_raw:
            output.append("\n=== Individual Responses ===")
            for model, response in successful_responses:
                output.append(f"\n--- {model} ---")
                output.append(response[:500] + "..." if len(response) > 500 else response)
        
        if failed_responses:
            output.append("\n=== Failed Queries ===")
            for model, error in failed_responses:
                output.append(f"{model}: {error}")
        
        return "\n".join(output)

    async def _query_models_parallel(
        self, models: List[str], prompt: str, 
        system_prompt: Optional[str], temperature: float,
        max_tokens: Optional[int], timeout: int
    ) -> Dict[str, str]:
        """Query multiple models in parallel."""
        async def query_with_timeout(model: str) -> tuple[str, str]:
            try:
                params = {
                    "model": model,
                    "prompt": prompt,
                    "temperature": temperature,
                }
                if system_prompt:
                    params["system_prompt"] = system_prompt
                if max_tokens:
                    params["max_tokens"] = max_tokens
                
                # Create a mock context for the LLM tool
                mock_ctx = type('MockContext', (), {'client': None})()
                
                result = await asyncio.wait_for(
                    self.llm_tool.call(mock_ctx, **params),
                    timeout=timeout
                )
                return (model, result)
            except asyncio.TimeoutError:
                return (model, f"Error: Timeout after {timeout} seconds")
            except Exception as e:
                return (model, f"Error: {str(e)}")
        
        # Run all queries in parallel
        tasks = [query_with_timeout(model) for model in models]
        results = await asyncio.gather(*tasks)
        
        return dict(results)

    async def _aggregate_responses(
        self, responses: List[tuple[str, str]], 
        original_prompt: str, aggregation_model: str
    ) -> str:
        """Use an LLM to aggregate and analyze responses."""
        # Prepare the aggregation prompt
        response_summary = "\n\n".join([
            f"Model: {model}\nResponse: {response}"
            for model, response in responses
        ])
        
        aggregation_prompt = f"""You are analyzing responses from multiple AI models to the following prompt:

<original_prompt>
{original_prompt}
</original_prompt>

<model_responses>
{response_summary}
</model_responses>

Please provide a comprehensive analysis that includes:

1. **Consensus Points**: What do most or all models agree on?
2. **Divergent Views**: Where do the models disagree or offer different perspectives?
3. **Key Insights**: What are the most valuable insights across all responses?
4. **Unique Contributions**: Did any model provide unique valuable information?
5. **Synthesis**: Provide a balanced, synthesized answer that incorporates the best elements from all responses.

Be concise but thorough. Focus on providing actionable insights."""

        try:
            # Use the LLM tool to get the aggregation
            mock_ctx = type('MockContext', (), {'client': None})()
            
            aggregation_params = {
                "model": aggregation_model,
                "prompt": aggregation_prompt,
                "temperature": 0.3,  # Lower temperature for more consistent analysis
                "system_prompt": "You are an expert at analyzing and synthesizing multiple AI responses to provide balanced, insightful consensus."
            }
            
            result = await self.llm_tool.call(mock_ctx, **aggregation_params)
            return result
            
        except Exception as e:
            # Fallback to simple aggregation if LLM fails
            return self._simple_aggregate(responses)

    def _simple_aggregate(self, responses: List[tuple[str, str]]) -> str:
        """Simple fallback aggregation without LLM."""
        output = []
        output.append("Summary of responses:")
        output.append("")
        
        # Find common themes (very basic)
        all_text = " ".join([r[1] for r in responses]).lower()
        
        output.append("Response lengths:")
        for model, response in responses:
            output.append(f"- {model}: {len(response)} characters")
        
        output.append("\nNote: Advanced consensus analysis unavailable. Showing basic summary only.")
        
        return "\n".join(output)

    def register(self, mcp_server) -> None:
        """Register this tool with the MCP server."""
        pass
