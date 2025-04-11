"""Path utilities for Hanzo MCP.

This module provides path normalization and validation utilities.
"""

import os
from pathlib import Path
from typing import final


@final
class PathUtils:
    """Utilities for path handling."""

    @staticmethod
    def normalize_path(path: str) -> str:
        """Normalize a path by expanding user paths and making it absolute.
        
        Args:
            path: The path to normalize
            
        Returns:
            The normalized path
        """
        # Expand user paths (e.g., ~/ or $HOME)
        expanded_path = os.path.expanduser(path)
        
        # Make the path absolute if it isn't already
        if not os.path.isabs(expanded_path):
            expanded_path = os.path.abspath(expanded_path)
            
        # Normalize the path (resolve symlinks, etc.)
        try:
            normalized_path = os.path.normpath(expanded_path)
            return normalized_path
        except Exception:
            # Return the expanded path if normalization fails
            return expanded_path
            
    @staticmethod
    def is_dot_directory(path: Path) -> bool:
        """Check if a path is a dot directory (e.g., .git, .vscode).
        
        Args:
            path: The path to check
            
        Returns:
            True if the path is a dot directory, False otherwise
        """
        # Consider any directory starting with "." to be a dot directory
        return path.is_dir() and path.name.startswith(".")
