"""LLM Provider abstraction for Hanzo MCP.

This module provides an abstraction layer for different LLM providers,
allowing tools like the thinking tool to use different LLMs based on
available API keys and configuration.
"""

import os
import json
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, final
import logging
import httpx

# Set up logging
logger = logging.getLogger(__name__)


class LLMProviderException(Exception):
    """Exception raised for LLM provider issues."""
    pass


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""

    @abstractmethod
    async def generate_thought(self, prompt: str, **kwargs) -> str:
        """Generate a thought using the LLM.
        
        Args:
            prompt: The prompt to send to the LLM
            **kwargs: Additional provider-specific parameters
            
        Returns:
            The generated thought as a string
        """
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Get the name of the LLM provider.
        
        Returns:
            The provider name
        """
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        """Check if this provider is available for use.
        
        Returns:
            True if the provider can be used, False otherwise
        """
        pass


@final
class HanzoLLMProvider(LLMProvider):
    """Hanzo AI LLM provider."""
    
    def __init__(self) -> None:
        """Initialize the Hanzo LLM provider."""
        self._api_key = os.environ.get("HANZO_API_KEY")
        self._api_url = os.environ.get("HANZO_API_URL", "https://api.hanzo.ai/v1")
        self._model = os.environ.get("HANZO_API_MODEL", "o1-preview")
    
    @property
    def name(self) -> str:
        """Get the provider name.
        
        Returns:
            The provider name
        """
        return "Hanzo AI"
    
    def is_available(self) -> bool:
        """Check if the Hanzo API is available.
        
        Returns:
            True if the API key is set, False otherwise
        """
        return self._api_key is not None and self._api_key != ""
    
    async def generate_thought(self, prompt: str, **kwargs) -> str:
        """Generate a thought using Hanzo AI.
        
        Args:
            prompt: The prompt to send to Hanzo
            **kwargs: Additional parameters
            
        Returns:
            The generated thought as a string
            
        Raises:
            LLMProviderException: If the API call fails
        """
        if not self.is_available():
            raise LLMProviderException("Hanzo API key not found")
        
        max_tokens = kwargs.get("max_tokens", 1000)
        temperature = kwargs.get("temperature", 0.7)
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self._api_url}/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self._api_key}"
                    },
                    json={
                        "model": self._model,
                        "prompt": prompt,
                        "max_tokens": max_tokens,
                        "temperature": temperature
                    },
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    raise LLMProviderException(f"Hanzo API error: {response.text}")
                
                data = response.json()
                return data.get("choices", [{}])[0].get("text", "")
                
        except httpx.HTTPError as e:
            raise LLMProviderException(f"HTTP error with Hanzo API: {str(e)}")
        except Exception as e:
            raise LLMProviderException(f"Error calling Hanzo API: {str(e)}")


@final
class OpenAILLMProvider(LLMProvider):
    """OpenAI LLM provider."""
    
    def __init__(self) -> None:
        """Initialize the OpenAI LLM provider."""
        self._api_key = os.environ.get("OPENAI_API_KEY")
        self._api_url = "https://api.openai.com/v1"
        self._model = os.environ.get("OPENAI_API_MODEL", "gpt-4o")
    
    @property
    def name(self) -> str:
        """Get the provider name.
        
        Returns:
            The provider name
        """
        return "OpenAI"
    
    def is_available(self) -> bool:
        """Check if the OpenAI API is available.
        
        Returns:
            True if the API key is set, False otherwise
        """
        return self._api_key is not None and self._api_key != ""
    
    async def generate_thought(self, prompt: str, **kwargs) -> str:
        """Generate a thought using OpenAI.
        
        Args:
            prompt: The prompt to send to OpenAI
            **kwargs: Additional parameters
            
        Returns:
            The generated thought as a string
            
        Raises:
            LLMProviderException: If the API call fails
        """
        if not self.is_available():
            raise LLMProviderException("OpenAI API key not found")
        
        max_tokens = kwargs.get("max_tokens", 1000)
        temperature = kwargs.get("temperature", 0.7)
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self._api_url}/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self._api_key}"
                    },
                    json={
                        "model": self._model,
                        "messages": [
                            {"role": "system", "content": "You are a helpful assistant analyzing code and issues."},
                            {"role": "user", "content": prompt}
                        ],
                        "max_tokens": max_tokens,
                        "temperature": temperature
                    },
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    raise LLMProviderException(f"OpenAI API error: {response.text}")
                
                data = response.json()
                return data.get("choices", [{}])[0].get("message", {}).get("content", "")
                
        except httpx.HTTPError as e:
            raise LLMProviderException(f"HTTP error with OpenAI API: {str(e)}")
        except Exception as e:
            raise LLMProviderException(f"Error calling OpenAI API: {str(e)}")


@final
class AnthropicLLMProvider(LLMProvider):
    """Anthropic Claude LLM provider."""
    
    def __init__(self) -> None:
        """Initialize the Anthropic LLM provider."""
        self._api_key = os.environ.get("ANTHROPIC_API_KEY")
        self._api_url = "https://api.anthropic.com/v1"
        self._model = os.environ.get("ANTHROPIC_API_MODEL", "claude-3-opus-20240229")
    
    @property
    def name(self) -> str:
        """Get the provider name.
        
        Returns:
            The provider name
        """
        return "Anthropic Claude"
    
    def is_available(self) -> bool:
        """Check if the Anthropic API is available.
        
        Returns:
            True if the API key is set, False otherwise
        """
        return self._api_key is not None and self._api_key != ""
    
    async def generate_thought(self, prompt: str, **kwargs) -> str:
        """Generate a thought using Anthropic Claude.
        
        Args:
            prompt: The prompt to send to Claude
            **kwargs: Additional parameters
            
        Returns:
            The generated thought as a string
            
        Raises:
            LLMProviderException: If the API call fails
        """
        if not self.is_available():
            raise LLMProviderException("Anthropic API key not found")
        
        max_tokens = kwargs.get("max_tokens", 1000)
        temperature = kwargs.get("temperature", 0.7)
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self._api_url}/messages",
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": self._api_key,
                        "anthropic-version": "2023-06-01"
                    },
                    json={
                        "model": self._model,
                        "messages": [
                            {"role": "user", "content": prompt}
                        ],
                        "max_tokens": max_tokens,
                        "temperature": temperature
                    },
                    timeout=30.0
                )
                
                if response.status_code != 200:
                    raise LLMProviderException(f"Anthropic API error: {response.text}")
                
                data = response.json()
                return data.get("content", [{}])[0].get("text", "")
                
        except httpx.HTTPError as e:
            raise LLMProviderException(f"HTTP error with Anthropic API: {str(e)}")
        except Exception as e:
            raise LLMProviderException(f"Error calling Anthropic API: {str(e)}")


@final
class LLMProviderManager:
    """Manager for LLM providers.
    
    This class manages the available LLM providers and selects the appropriate
    provider based on availability and configuration.
    """
    
    def __init__(self) -> None:
        """Initialize the LLM provider manager."""
        self._providers: List[LLMProvider] = [
            HanzoLLMProvider(),      # First priority
            OpenAILLMProvider(),     # Second priority
            AnthropicLLMProvider(),  # Third priority
        ]
        
        # Configuration from environment
        self._specified_provider = os.environ.get("HANZO_MCP_LLM_PROVIDER", "auto")
        self._thinking_enabled = os.environ.get("HANZO_MCP_THINKING_ENABLED", "true").lower() == "true"
    
    @property
    def thinking_enabled(self) -> bool:
        """Check if enhanced thinking mode is enabled.
        
        Returns:
            True if enhanced thinking is enabled, False otherwise
        """
        return self._thinking_enabled
    
    async def generate_thought(self, prompt: str, **kwargs) -> Optional[str]:
        """Generate a thought using the best available LLM provider.
        
        Args:
            prompt: The prompt to send to the LLM
            **kwargs: Additional provider-specific parameters
            
        Returns:
            The generated thought as a string, or None if no provider is available
            or thinking is disabled
        """
        if not self.thinking_enabled:
            logger.info("Enhanced thinking mode is disabled")
            return None
        
        # If a specific provider is requested
        if self._specified_provider != "auto":
            for provider in self._providers:
                if provider.name.lower() == self._specified_provider.lower() and provider.is_available():
                    try:
                        logger.info(f"Using specified LLM provider: {provider.name}")
                        return await provider.generate_thought(prompt, **kwargs)
                    except LLMProviderException as e:
                        logger.error(f"Error with specified provider {provider.name}: {str(e)}")
                        return None
            
            logger.warning(f"Specified provider '{self._specified_provider}' not available")
            return None
        
        # Try providers in priority order
        for provider in self._providers:
            if provider.is_available():
                try:
                    logger.info(f"Using LLM provider: {provider.name}")
                    return await provider.generate_thought(prompt, **kwargs)
                except LLMProviderException as e:
                    logger.error(f"Error with provider {provider.name}: {str(e)}")
                    continue
        
        logger.warning("No LLM providers available for enhanced thinking")
        return None


# Global instance for easy access
provider_manager = LLMProviderManager()
