"""Tests for LLM providers."""

import os
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import httpx

from hanzo_mcp.tools.common.llm_providers import (
    LLMProvider,
    HanzoLLMProvider,
    OpenAILLMProvider,
    AnthropicLLMProvider,
    LLMProviderManager,
    LLMProviderException,
)


class TestLLMProviders:
    """Test suite for LLM providers."""

    def test_hanzo_provider_availability(self):
        """Test Hanzo provider availability check."""
        # Test with API key
        with patch.dict(os.environ, {"HANZO_API_KEY": "test-key"}):
            provider = HanzoLLMProvider()
            assert provider.is_available() is True
            assert provider.name == "Hanzo AI"

        # Test without API key
        with patch.dict(os.environ, {"HANZO_API_KEY": ""}):
            provider = HanzoLLMProvider()
            assert provider.is_available() is False

    def test_openai_provider_availability(self):
        """Test OpenAI provider availability check."""
        # Test with API key
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            provider = OpenAILLMProvider()
            assert provider.is_available() is True
            assert provider.name == "OpenAI"

        # Test without API key
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            provider = OpenAILLMProvider()
            assert provider.is_available() is False

    def test_anthropic_provider_availability(self):
        """Test Anthropic provider availability check."""
        # Test with API key
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            provider = AnthropicLLMProvider()
            assert provider.is_available() is True
            assert provider.name == "Anthropic Claude"

        # Test without API key
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
            provider = AnthropicLLMProvider()
            assert provider.is_available() is False

    @pytest.mark.asyncio
    async def test_hanzo_provider_generate_thought(self):
        """Test generating a thought with Hanzo provider."""
        with patch.dict(os.environ, {"HANZO_API_KEY": "test-key"}):
            provider = HanzoLLMProvider()
            
            # Mock httpx.AsyncClient
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {
                "choices": [{"text": "Generated thought"}]
            }
            
            mock_client = AsyncMock()
            mock_client.__aenter__.return_value.post.return_value = mock_response
            
            with patch("httpx.AsyncClient", return_value=mock_client):
                result = await provider.generate_thought("Test prompt")
                assert result == "Generated thought"

    @pytest.mark.asyncio
    async def test_provider_manager_priority(self):
        """Test provider manager selects providers in priority order."""
        # Set up environment with multiple API keys
        with patch.dict(os.environ, {
            "HANZO_API_KEY": "hanzo-key",
            "OPENAI_API_KEY": "openai-key",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "HANZO_MCP_THINKING_ENABLED": "true"
        }):
            # Create mock providers
            mock_hanzo = AsyncMock(spec=HanzoLLMProvider)
            mock_hanzo.name = "Hanzo AI"
            mock_hanzo.is_available.return_value = True
            mock_hanzo.generate_thought.return_value = "Hanzo thought"
            
            mock_openai = AsyncMock(spec=OpenAILLMProvider)
            mock_openai.name = "OpenAI"
            mock_openai.is_available.return_value = True
            
            mock_anthropic = AsyncMock(spec=AnthropicLLMProvider)
            mock_anthropic.name = "Anthropic Claude"
            mock_anthropic.is_available.return_value = True
            
            # Create manager with mocked providers
            manager = LLMProviderManager()
            manager._providers = [mock_hanzo, mock_openai, mock_anthropic]
            
            # Test auto selection (should choose first available - Hanzo)
            manager._specified_provider = "auto"
            result = await manager.generate_thought("Test prompt")
            assert result == "Hanzo thought"
            mock_hanzo.generate_thought.assert_called_once()
            mock_openai.generate_thought.assert_not_called()
            mock_anthropic.generate_thought.assert_not_called()

    @pytest.mark.asyncio
    async def test_provider_manager_fallback(self):
        """Test provider manager falls back to next provider if first fails."""
        # Set up environment with multiple API keys
        with patch.dict(os.environ, {
            "HANZO_API_KEY": "hanzo-key",
            "OPENAI_API_KEY": "openai-key",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "HANZO_MCP_THINKING_ENABLED": "true"
        }):
            # Create mock providers
            mock_hanzo = AsyncMock(spec=HanzoLLMProvider)
            mock_hanzo.name = "Hanzo AI"
            mock_hanzo.is_available.return_value = True
            mock_hanzo.generate_thought.side_effect = LLMProviderException("API error")
            
            mock_openai = AsyncMock(spec=OpenAILLMProvider)
            mock_openai.name = "OpenAI"
            mock_openai.is_available.return_value = True
            mock_openai.generate_thought.return_value = "OpenAI thought"
            
            mock_anthropic = AsyncMock(spec=AnthropicLLMProvider)
            mock_anthropic.name = "Anthropic Claude"
            mock_anthropic.is_available.return_value = True
            
            # Create manager with mocked providers
            manager = LLMProviderManager()
            manager._providers = [mock_hanzo, mock_openai, mock_anthropic]
            
            # Test fallback to OpenAI when Hanzo fails
            manager._specified_provider = "auto"
            result = await manager.generate_thought("Test prompt")
            assert result == "OpenAI thought"
            mock_hanzo.generate_thought.assert_called_once()
            mock_openai.generate_thought.assert_called_once()
            mock_anthropic.generate_thought.assert_not_called()
