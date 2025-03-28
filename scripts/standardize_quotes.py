#!/usr/bin/env python3
"""Standardize quote usage in Python files.

This script converts single quotes to double quotes in Python files
to maintain consistency throughout the codebase. It preserves single quotes
only when they appear within double-quoted strings or when used for escaping.
"""

import os
import re
import sys
from pathlib import Path
from typing import List, Tuple

# Files or directories to exclude
EXCLUDE_PATTERNS = [
    "__pycache__",
    ".git",
    ".pytest_cache",
    "venv",
    "env",
    ".venv",
    ".env",
]


def should_process_file(filepath: str) -> bool:
    """Check if a file should be processed based on exclusion patterns.
    
    Args:
        filepath: Path to the file
    
    Returns:
        True if the file should be processed, False otherwise
    """
    return (
        filepath.endswith(".py")
        and not any(pattern in filepath for pattern in EXCLUDE_PATTERNS)
    )


def convert_quotes(content: str) -> str:
    """Convert single quotes to double quotes in Python code.
    
    Args:
        content: The Python file content
    
    Returns:
        Content with standardized quotes
    """
    # Keep track of state
    in_triple_double = False
    in_triple_single = False
    in_double = False
    in_single = False
    escape_next = False
    
    # Result buffer
    result = []
    i = 0
    
    while i < len(content):
        char = content[i]
        
        # Handle escape sequences
        if char == "\\":
            result.append(char)
            escape_next = True
            i += 1
            continue
        
        if escape_next:
            result.append(char)
            escape_next = False
            i += 1
            continue
        
        # Check for triple quotes
        if i + 2 < len(content):
            triple = content[i:i+3]
            if triple == '"""' and not in_triple_single and not in_single and not in_double:
                in_triple_double = not in_triple_double
                result.append(triple)
                i += 3
                continue
            elif triple == "'''" and not in_triple_double and not in_single and not in_double:
                in_triple_single = not in_triple_single
                # Convert triple single quotes to triple double quotes
                result.append('"""')
                i += 3
                continue
        
        # Check for regular quotes
        if char == '"' and not in_triple_double and not in_triple_single and not in_single:
            in_double = not in_double
            result.append(char)
        elif char == "'" and not in_triple_double and not in_triple_single and not in_double:
            in_single = not in_single
            # Convert single quotes to double quotes when not in any string
            result.append('"')
        else:
            result.append(char)
        
        i += 1
    
    return "".join(result)


def process_file(filepath: str, dry_run: bool = False) -> Tuple[bool, int]:
    """Process a single file to standardize quotes.
    
    Args:
        filepath: Path to the file
        dry_run: If True, don't modify the file
    
    Returns:
        Tuple of (changed, changes_count)
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Convert quotes
        new_content = convert_quotes(content)
        
        # Check if anything changed
        if new_content == content:
            return False, 0
        
        # Calculate number of changes
        changes = sum(1 for a, b in zip(content, new_content) if a != b)
        
        