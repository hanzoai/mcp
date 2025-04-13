"""Base model provider for agent delegation.

Defines the interface for model providers.
"""

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class BaseModelProvider(ABC):
    """Base class for model providers."""
    
    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the provider."""
        pass
        
    @abstractmethod
    async def load_model(self, model_name: str, identifier: Optional[str] = None) -> str:
        """Load a model.
        
        Args:
            model_name: The name of the model to load
            identifier: Optional identifier for the model instance
            
        Returns:
            The identifier for the loaded model
        """
        pass
        
    @abstractmethod
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
        pass
        
    @abstractmethod
    async def unload_model(self, model_id: str) -> None:
        """Unload a model.
        
        Args:
            model_id: The identifier of the model to unload
        """
        pass
        
    @abstractmethod
    async def shutdown(self) -> None:
        """Shutdown the provider."""
        pass
