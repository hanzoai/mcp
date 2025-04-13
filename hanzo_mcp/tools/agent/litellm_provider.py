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
            
    async def load_model(self, model_name: str, identifier: Optional[str] = None