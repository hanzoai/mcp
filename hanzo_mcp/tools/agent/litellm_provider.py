"""LiteLLM provider for agent delegation.

Enables the use of various cloud LLM providers via LiteLLM.
"""

import asyncio
import logging
import json
from typing import Any, Dict, List, Optional, Tuple

from hanzo_mcp.tools.agent.base_provider import BaseModelProvider

logger = logging.getLogger(__name__)

# Define model capabilities
DEFAULT_MAX_TOKENS = 4096
DEFAULT_CONTEXT_WINDOW = 8192


class LiteLLMProvider(BaseModelProvider):
    """Provider for cloud models via LiteLLM."""

    def __init__(self):
        """Initialize the LiteLLM provider."""
        self.models = {}
        self.initialized = False
        
    async def initialize(self) -> None:
        """Initialize the LiteLLM provider."""
        if self.initialized:
            return
            
        try:
            # Import LiteLLM
            import litellm
            self.litellm = litellm
            self.initialized = True
            logger.info("LiteLLM provider initialized successfully")
        except ImportError:
            logger.error("Failed to import LiteLLM")
            logger.error("Install LiteLLM with 'pip install litellm'")
        except Exception as e:
            logger.error(f"Failed to initialize LiteLLM provider: {str(e)}")
            
    async def load_model(self, model_name: str, identifier: Optional[str] = None) -> str:
        """Load a model from LiteLLM.
        
        Args:
            model_name: The name of the model to load
            identifier: Optional identifier for the model instance
            
        Returns:
            The identifier for the loaded model
        """
        if not self.initialized:
            await self.initialize()
            if not self.initialized:
                raise RuntimeError("LiteLLM provider failed to initialize")
        
        # Generate a unique identifier if none provided
        model_id = identifier or f"{model_name}-{len(self.models)}"
        
        # Store model reference
        self.models[model_id] = model_name
        logger.info(f"Model {model_name} loaded with ID {model_id}")
        
        return model_id
    
    async def generate(self, 
                      model_id: str, 
                      prompt: str, 
                      system_prompt: Optional[str] = None, 
                      max_tokens: int = DEFAULT_MAX_TOKENS, 
                      temperature: float = 0.7, 
                      top_p: float = 0.95, 
                      stop_sequences: Optional[List[str]] = None) -> Tuple[str, Dict[str, Any]]:
        """Generate a response from the model.
        
        Args:
            model_id: The identifier of the model to use
            prompt: The prompt to send to the model
            system_prompt: Optional system prompt to send to the model
            max_tokens: Maximum number of tokens to generate
            temperature: Sampling temperature
            top_p: Top-p sampling parameter
            stop_sequences: Optional list of strings that will stop generation
            
        Returns:
            Tuple of (generated_text, metadata)
        """
        if not self.initialized:
            await self.initialize()
            if not self.initialized:
                raise RuntimeError("LiteLLM provider failed to initialize")
        
        if model_id not in self.models:
            raise ValueError(f"Model {model_id} not loaded")
        
        model_name = self.models[model_id]
        
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        
        messages.append({"role": "user", "content": prompt})
        
        try:
            response = await self.litellm.acompletion(
                model=model_name,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
                stop=stop_sequences
            )
            
            generated_text = response.choices[0].message.content
            metadata = {
                "model": model_name,
                "usage": response.usage,
                "finish_reason": response.choices[0].finish_reason
            }
            
            return generated_text, metadata
        except Exception as e:
            logger.error(f"Failed to generate with model {model_id}: {str(e)}")
            raise RuntimeError(f"Failed to generate with model {model_id}: {str(e)}")
        
    async def unload_model(self, model_id: str) -> None:
        """Unload a model from LiteLLM.
        
        Args:
            model_id: The identifier of the model to unload
        """
        if model_id in self.models:
            del self.models[model_id]
            logger.info(f"Model {model_id} unloaded")
    
    async def shutdown(self) -> None:
        """Shutdown the LiteLLM provider."""
        self.models = {}
        self.initialized = False
        logger.info("LiteLLM provider shut down")