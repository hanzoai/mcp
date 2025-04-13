"""Provider registry for agent delegation.

Manages different model providers for agent delegation.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple, Type

from hanzo_mcp.tools.agent.base_provider import BaseModelProvider

logger = logging.getLogger(__name__)


class ProviderRegistry:
    """Registry for model providers."""
    
    _instance = None
    
    def __new__(cls):
        """Singleton pattern to ensure only one registry instance exists."""
        if cls._instance is None:
            cls._instance = super(ProviderRegistry, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
        
    def __init__(self):
        """Initialize the provider registry."""
        if self._initialized:
            return
            
        self.providers = {}
        self.provider_classes = {}
        self._initialized = True
        logger.info("Provider registry initialized")
        
    def register_provider_class(self, provider_type: str, provider_class: Type[BaseModelProvider]) -> None:
        """Register a provider class with the registry.
        
        Args:
            provider_type: The type identifier for the provider
            provider_class: The provider class to register
        """
        self.provider_classes[provider_type] = provider_class
        logger.info(f"Registered provider class: {provider_type}")
        
    async def get_provider(self, provider_type: str) -> BaseModelProvider:
        """Get or create a provider instance for the given type.
        
        Args:
            provider_type: The type identifier for the provider
            
        Returns:
            A provider instance
            
        Raises:
            ValueError: If the provider type is not registered
        """
        # Check if we already have an instance
        if provider_type in self.providers:
            return self.providers[provider_type]
            
        # Check if we have a class for this type
        if provider_type not in self.provider_classes:
            raise ValueError(f"Unknown provider type: {provider_type}")
            
        # Create a new instance
        provider_class = self.provider_classes[provider_type]
        provider = provider_class()
        
        # Initialize the provider
        await provider.initialize()
        
        # Store and return the provider
        self.providers[provider_type] = provider
        logger.info(f"Created and initialized provider: {provider_type}")
        return provider
        
    async def shutdown_all(self) -> None:
        """Shutdown all providers."""
        for provider_type, provider in self.providers.items():
            try:
                await provider.shutdown()
                logger.info(f"Provider shut down: {provider_type}")
            except Exception as e:
                logger.error(f"Failed to shut down provider {provider_type}: {str(e)}")
                
        self.providers = {}
        logger.info("All providers shut down")
        
    async def shutdown_provider(self, provider_type: str) -> None:
        """Shutdown a specific provider.
        
        Args:
            provider_type: The type identifier for the provider
        """
        if provider_type not in self.providers:
            logger.warning(f"Provider not found: {provider_type}")
            return
            
        try:
            await self.providers[provider_type].shutdown()
            del self.providers[provider_type]
            logger.info(f"Provider shut down: {provider_type}")
        except Exception as e:
            logger.error(f"Failed to shut down provider {provider_type}: {str(e)}")


# Create a singleton instance
registry = ProviderRegistry()

# Register LiteLLM provider
from hanzo_mcp.tools.agent.litellm_provider import LiteLLMProvider
registry.register_provider_class("litellm", LiteLLMProvider)

# Try to register LM Studio provider if available
try:
    from hanzo_mcp.tools.agent.lmstudio_provider import LMStudioProvider
    registry.register_provider_class("lmstudio", LMStudioProvider)
except ImportError:
    logger.warning("LM Studio provider not available. Install the package if needed.")
