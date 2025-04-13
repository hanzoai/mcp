"""LM Studio provider for agent delegation.

Enables the use of local LLMs via LM Studio's Python SDK.
"""

import logging
import asyncio
import functools
from typing import Any, Dict, List, Optional, Tuple

from hanzo_mcp.tools.agent.base_provider import BaseModelProvider

logger = logging.getLogger(__name__)


class LMStudioProvider(BaseModelProvider):
    """Provider for local models via LM Studio Python SDK."""

    def __init__(self):
        """Initialize the LM Studio provider."""
        self.models = {}
        self.initialized = False
        
    async def initialize(self) -> None:
        """Initialize the LM Studio provider.
        
        Import is done here to avoid dependency issues if LM Studio SDK is not installed.
        """
        if self.initialized:
            return
            
        try:
            # Dynamic import to avoid dependency issues if LM Studio is not installed
            from importlib.util import find_spec
            if find_spec("lmstudio") is None:
                logger.warning("LM Studio Python SDK not installed. Install with 'pip install lmstudio'")
                return
                
            # Import the LM Studio module
            import lmstudio as lms
            self.lms = lms
            self.initialized = True
            logger.info("LM Studio provider initialized successfully")
        except ImportError as e:
            logger.error(f"Failed to import LM Studio Python SDK: {str(e)}")
            logger.error("Install LM Studio Python SDK with 'pip install lmstudio'")
        except Exception as e:
            logger.error(f"Failed to initialize LM Studio provider: {str(e)}")
            
    async def load_model(self, model_name: str, identifier: Optional[str] = None) -> str:
        """Load a model from LM Studio.
        
        Args:
            model_name: The name of the model to load
            identifier: Optional identifier for the model instance
            
        Returns:
            The identifier for the loaded model
        """
        if not self.initialized:
            await self.initialize()
            if not self.initialized:
                raise RuntimeError("LM Studio provider failed to initialize")
        
        model_id = identifier or model_name
        
        try:
            if model_id in self.models:
                logger.info(f"Model {model_id} already loaded")
                return model_id
                
            logger.info(f"Loading model {model_name}")
            
            # Use the thread pool to run the blocking operation
            loop = asyncio.get_event_loop()
            model = await loop.run_in_executor(
                None, 
                functools.partial(self.lms.llm, model_name)
            )
            
            # Store the model with its identifier
            self.models[model_id] = model
            logger.info(f"Model {model_name} loaded successfully as {model_id}")
            return model_id
            
        except Exception as e:
            logger.error(f"Failed to load model {model_name}: {str(e)}")
            raise RuntimeError(f"Failed to load model {model_name}: {str(e)}")
    
    async def generate(
        self,
        model_id: str,
        prompt: str,
        system_prompt: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        top_p: float = 0.95,
        stop_sequences: Optional[List[str]] = None,
    ) -> Tuple[str, Dict[str, Any]]:
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
            A tuple of (generated text, metadata)
        """
        if not self.initialized:
            await self.initialize()
            if not self.initialized:
                raise RuntimeError("LM Studio provider failed to initialize")
        
        if model_id not in self.models:
            raise ValueError(f"Model {model_id} not loaded")
            
        model = self.models[model_id]
        
        try:
            logger.debug(f"Generating with model {model_id}")
            
            # Prepare generation parameters
            params = {
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": top_p
            }
            
            if stop_sequences:
                params["stop"] = stop_sequences
                
            # Generate response
            loop = asyncio.get_event_loop()
            
            if system_prompt:
                # For chat models with system prompt
                response_future = loop.run_in_executor(
                    None,
                    functools.partial(
                        model.chat,
                        system=system_prompt, 
                        message=prompt,
                        **params
                    )
                )
            else:
                # For completion models without system prompt
                response_future = loop.run_in_executor(
                    None,
                    functools.partial(
                        model.respond,
                        prompt,
                        **params
                    )
                )
                
            response = await response_future
            
            # Extract the generated text
            if isinstance(response, dict) and "text" in response:
                generated_text = response["text"]
            elif isinstance(response, str):
                generated_text = response
            else:
                generated_text = str(response)
                
            # Metadata
            metadata = {
                "model": model_id,
                "usage": {
                    "prompt_tokens": -1,  # LM Studio Python SDK doesn't provide token counts
                    "completion_tokens": -1,
                    "total_tokens": -1
                }
            }
            
            logger.debug(f"Generated {len(generated_text)} chars with model {model_id}")
            return generated_text, metadata
        except Exception as e:
            logger.error(f"Failed to generate with model {model_id}: {str(e)}")
            raise RuntimeError(f"Failed to generate with model {model_id}: {str(e)}")
            
    async def unload_model(self, model_id: str) -> None:
        """Unload a model from LM Studio.
        
        Args:
            model_id: The identifier of the model to unload
        """
        if not self.initialized:
            return
            
        if model_id not in self.models:
            logger.warning(f"Model {model_id} not loaded")
            return
            
        try:
            # Just remove the model reference, Python garbage collection will handle it
            del self.models[model_id]
            logger.info(f"Model {model_id} unloaded")
        except Exception as e:
            logger.error(f"Failed to unload model {model_id}: {str(e)}")
            
    async def shutdown(self) -> None:
        """Shutdown the LM Studio provider."""
        if not self.initialized:
            return
            
        try:
            # Clear all model references
            self.models = {}
            self.initialized = False
            logger.info("LM Studio provider shut down")
        except Exception as e:
            logger.error(f"Failed to shut down LM Studio provider: {str(e)}")
