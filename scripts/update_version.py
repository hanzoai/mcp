#!/usr/bin/env python
"""Version synchronization script for hanzo-mcp.

This script ensures that the version in hanzo_mcp/__init__.py matches
the version in pyproject.toml. It's intended to be run as part of the
build process or version bumping workflow.
"""

import os
import re
import sys
import tomllib
from pathlib import Path


def get_pyproject_version(project_root: Path) -> str:
    """Get the version from pyproject.toml.
    
    Args:
        project_root: Path to the project root
        
    Returns:
        The version string from pyproject.toml
        
    Raises:
        FileNotFoundError: If pyproject.toml doesn't exist
        KeyError: If version is not defined in pyproject.toml
    """
    pyproject_path = project_root / "pyproject.toml"
    
    if not pyproject_path.exists():
        raise FileNotFoundError(f"pyproject.toml not found at {pyproject_path}")
    
    with open(pyproject_path, "rb") as f:
        pyproject_data = tomllib.load(f)
    
    try:
        return pyproject_data["project"]["version"]
    except KeyError:
        raise KeyError("Version not found in pyproject.toml")


def update_init_version(project_root: Path, version: str) -> bool:
    """Update the __version__ in __init__.py.
    
    Args:
        project_root: Path to the project root
        version: The version string to set
        
    Returns:
        True if the file was updated, False if it already had the correct version
        
    Raises:
        FileNotFoundError: If __init__.py doesn't exist
    """
    init_path = project_root / "hanzo_mcp" / "__init__.py"
    
    if not init_path.exists():
        raise FileNotFoundError(f"__init__.py not found at {init_path}")
    
    with open(init_path, "r") as f:
        init_content = f.read()
    
    # Look for the version pattern
    version_pattern = r'__version__\s*=\s*["\']([^"\']+)["\']'
    match = re.search(version_pattern, init_content)
    
    if match:
        current_version = match.group(1)
        if current_version == version:
            print(f"Version in __init__.py already matches: {version}")
            return False
        
        # Replace the version
        new_content = re.sub(
            version_pattern, 
            f'__version__ = "{version}"', 
            init_content
        )
        
        with open(init_path, "w") as f:
            f.write(new_content)
        
        print(f"Updated __init__.py version from {current_version} to {version}")
        return True
    else:
        # If __version__ isn't defined yet, add it after the module docstring
        docstring_pattern = r'""".*?"""\s*'
        if re.search(docstring_pattern, init_content, re.DOTALL):
            new_content = re.sub(
                docstring_pattern, 
                f'{match.group(0)}\n__version__ = "{version}"\n', 
                init_content, 
                count=1, 
                flags=re.DOTALL
            )
        else:
            # If no docstring, add to top of file
            new_content = f'__version__ = "{version}"\n\n{init_content}'
            
        with open(init_path, "w") as f:
            f.write(new_content)
        
        print(f"Added __version__ = \"{version}\" to __init__.py")
        return True


def main() -> int:
    """Main entry point for the script.
    
    Returns:
        Exit code (0 for success, 1 for error)
    """
    try:
        # Determine project root
        project_root = Path(__file__).parent.parent
        
        # Get version from pyproject.toml
        version = get_pyproject_version(project_root)
        print(f"Found version in pyproject.toml: {version}")
        
        # Update __init__.py
        update_init_version(project_root, version)
        
        return 0
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
