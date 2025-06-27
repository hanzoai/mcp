"""Hanzo MCP - Implementation of Hanzo capabilities using MCP."""

import warnings

# Suppress deprecation warnings from litellm about Pydantic v1 style configs
warnings.filterwarnings(
    "ignore", 
    category=DeprecationWarning,
    message=".*class-based `config`.*"
)

__version__ = "0.6.6"
