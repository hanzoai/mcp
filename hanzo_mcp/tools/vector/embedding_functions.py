"""Embedding function implementations for vector storage.

This module provides embedding function implementations for various LLM providers
to use with ChromaDB, including:
- VoyageAI (voyage-large-2)
- OpenAI (text-embedding-3-small, text-embedding-3-large)
- Anthropic (claude-3-embedding-*)
- SentenceTransformer (local embeddings)

The module automatically selects the best available embedding model based on
environment variables.
"""

import os
import logging
from typing import Dict, List, Any, Optional, Union, Callable
import numpy as np

from chromadb.api.types import EmbeddingFunction, Embeddings, Documents, Space

logger = logging.getLogger(__name__)

class VoyageAIEmbeddingFunction(EmbeddingFunction[Documents]):
    """
    Embedding function that uses the VoyageAI API to generate embeddings.
    """
    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: str = "voyage-large-2",
        api_key_env_var: str = "VOYAGE_API_KEY",
        alternative_env_var: str = "CHROMA_VOYAGE_API_KEY",
    ):
        """
        Initialize the VoyageAIEmbeddingFunction.
        
        Args:
            api_key: API key for the VoyageAI API. If not provided, will look for it in the environment variables.
            model_name: The name of the model to use for text embeddings.
            api_key_env_var: Primary environment variable name that contains your API key.
            alternative_env_var: Alternative environment variable name for the API key.
        """
        try:
            import voyageai
        except ImportError:
            raise ValueError(
                "The voyageai python package is not installed. Please install it with `pip install voyageai`"
            )
        
        self.api_key_env_var = api_key_env_var
        self.alternative_env_var = alternative_env_var
        self.api_key = api_key or os.getenv(api_key_env_var) or os.getenv(alternative_env_var)
        
        if not self.api_key:
            raise ValueError(f"No API key found. Please set {api_key_env_var} or {alternative_env_var} environment variable.")
        
        self.model_name = model_name
        self._client = voyageai.Client(api_key=self.api_key)

    def __call__(self, input: Documents) -> Embeddings:
        """
        Generate embeddings for the given documents.
        
        Args:
            input: Documents to generate embeddings for.
            
        Returns:
            Embeddings for the documents.
        """
        embeddings = self._client.embed(texts=input, model=self.model_name)
        return [np.array(embedding, dtype=np.float32) for embedding in embeddings]
    
    @staticmethod
    def name() -> str:
        return "voyageai"
    
    def default_space(self) -> Space:
        return "cosine"
    
    def supported_spaces(self) -> List[Space]:
        return ["cosine", "l2", "ip"]


class OpenAIEmbeddingFunction(EmbeddingFunction[Documents]):
    """
    Embedding function that uses the OpenAI API to generate embeddings.
    """
    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: str = "text-embedding-3-small",
        api_key_env_var: str = "OPENAI_API_KEY",
        alternative_env_var: str = "CHROMA_OPENAI_API_KEY",
        dimensions: Optional[int] = None,
    ):
        """
        Initialize the OpenAIEmbeddingFunction.
        
        Args:
            api_key: API key for the OpenAI API. If not provided, will look for it in the environment variables.
            model_name: The name of the model to use for text embeddings.
            api_key_env_var: Primary environment variable name that contains your API key.
            alternative_env_var: Alternative environment variable name for the API key.
            dimensions: The dimensions of the embeddings to generate (only for text-embedding-3 models).
        """
        try:
            import openai
        except ImportError:
            raise ValueError(
                "The openai python package is not installed. Please install it with `pip install openai`"
            )
        
        self.api_key_env_var = api_key_env_var
        self.alternative_env_var = alternative_env_var
        self.api_key = api_key or os.getenv(api_key_env_var) or os.getenv(alternative_env_var)
        
        if not self.api_key:
            raise ValueError(f"No API key found. Please set {api_key_env_var} or {alternative_env_var} environment variable.")
        
        self.model_name = model_name
        self.dimensions = dimensions
        self._client = openai.OpenAI(api_key=self.api_key)

    def __call__(self, input: Documents) -> Embeddings:
        """
        Generate embeddings for the given documents.
        
        Args:
            input: Documents to generate embeddings for.
            
        Returns:
            Embeddings for the documents.
        """
        # Prepare embedding request parameters
        kwargs = {"model": self.model_name}
        if self.dimensions is not None and self.model_name.startswith("text-embedding-3"):
            kwargs["dimensions"] = self.dimensions
            
        # OpenAI has a max batch size, so process in batches if needed
        batch_size = 1000  # OpenAI recommended batch size
        all_embeddings = []
        
        for i in range(0, len(input), batch_size):
            batch = input[i:i + batch_size]
            response = self._client.embeddings.create(
                input=batch,
                **kwargs
            )
            batch_embeddings = [embedding.embedding for embedding in response.data]
            all_embeddings.extend(batch_embeddings)
            
        return [np.array(embedding, dtype=np.float32) for embedding in all_embeddings]
    
    @staticmethod
    def name() -> str:
        return "openai"
    
    def default_space(self) -> Space:
        return "cosine"
    
    def supported_spaces(self) -> List[Space]:
        return ["cosine", "l2", "ip"]


class AnthropicEmbeddingFunction(EmbeddingFunction[Documents]):
    """
    Embedding function that uses the Anthropic API to generate embeddings.
    """
    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: str = "claude-3-embedding-1",
        api_key_env_var: str = "ANTHROPIC_API_KEY",
        alternative_env_var: str = "CHROMA_ANTHROPIC_API_KEY",
    ):
        """
        Initialize the AnthropicEmbeddingFunction.
        
        Args:
            api_key: API key for the Anthropic API. If not provided, will look for it in the environment variables.
            model_name: The name of the model to use for text embeddings.
            api_key_env_var: Primary environment variable name that contains your API key.
            alternative_env_var: Alternative environment variable name for the API key.
        """
        try:
            import anthropic
        except ImportError:
            raise ValueError(
                "The anthropic python package is not installed. Please install it with `pip install anthropic`"
            )
        
        self.api_key_env_var = api_key_env_var
        self.alternative_env_var = alternative_env_var
        self.api_key = api_key or os.getenv(api_key_env_var) or os.getenv(alternative_env_var)
        
        if not self.api_key:
            raise ValueError(f"No API key found. Please set {api_key_env_var} or {alternative_env_var} environment variable.")
        
        self.model_name = model_name
        self._client = anthropic.Anthropic(api_key=self.api_key)

    def __call__(self, input: Documents) -> Embeddings:
        """
        Generate embeddings for the given documents.
        
        Args:
            input: Documents to generate embeddings for.
            
        Returns:
            Embeddings for the documents.
        """
        # Process documents one by one since Anthropic doesn't support batching yet
        # This could be optimized with async/await in a future version
        all_embeddings = []
        
        for document in input:
            response = self._client.embeddings.create(
                model=self.model_name,
                input=document
            )
            all_embeddings.append(response.embedding)
            
        return [np.array(embedding, dtype=np.float32) for embedding in all_embeddings]
    
    @staticmethod
    def name() -> str:
        return "anthropic"
    
    def default_space(self) -> Space:
        return "cosine"
    
    def supported_spaces(self) -> List[Space]:
        return ["cosine", "l2", "ip"]


def get_best_available_embedding_function() -> Optional[EmbeddingFunction]:
    """
    Get the best available embedding function based on available API keys.
    
    The priority order is:
    1. Voyage AI
    2. OpenAI
    3. Anthropic
    4. None (caller may try to fall back to SentenceTransformer if installed)
    
    Returns:
        The best available embedding function, or None if no API keys are available.
    """
    # Check for Voyage AI API key
    if os.getenv("VOYAGE_API_KEY") or os.getenv("CHROMA_VOYAGE_API_KEY"):
        try:
            return VoyageAIEmbeddingFunction()
        except (ImportError, ValueError) as e:
            logger.warning(f"Failed to initialize VoyageAI embedding function: {e}")
    
    # Check for OpenAI API key
    if os.getenv("OPENAI_API_KEY") or os.getenv("CHROMA_OPENAI_API_KEY"):
        try:
            return OpenAIEmbeddingFunction()
        except (ImportError, ValueError) as e:
            logger.warning(f"Failed to initialize OpenAI embedding function: {e}")
    
    # Check for Anthropic API key
    if os.getenv("ANTHROPIC_API_KEY") or os.getenv("CHROMA_ANTHROPIC_API_KEY"):
        try:
            return AnthropicEmbeddingFunction()
        except (ImportError, ValueError) as e:
            logger.warning(f"Failed to initialize Anthropic embedding function: {e}")
    
    # No API keys available, return None
    return None
