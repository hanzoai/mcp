#!/usr/bin/env python
"""Version bumping script for hanzo-mcp.

This script bumps the version in pyproject.toml and then updates
hanzo_mcp/__init__.py to match.

Usage:
    python -m scripts.bump_version [major|minor|patch]
"""

import argparse
import os
import re
import sys
import tomllib
from pathlib import Path


def read_pyproject(path: Path) -> dict:
    """Read pyproject.toml.
    
    Args:
        path: Path to pyproject.toml
        
    Returns:
        The parsed pyproject.toml content
    """
    with open(path, "rb") as f:
        return tomllib.load(f)


def write_pyproject(path: Path, data: dict) -> None:
    """Write pyproject.toml.
    
    Args:
        path: Path to pyproject.toml
        data: The data to write
    """
    # Simple TOML writer for pyproject.toml
    # We can't use tomllib because it's read-only
    # This is a simplified approach that preserves most formatting
    
    with open(path, "r") as f:
        content = f.read()
    
    # Update the version
    version_pattern = r'version\s*=\s*["\']([^"\']+)["\']'
    new_version = data["project"]["version"]
    content = re.sub(version_pattern, f'version = "{new_version}"', content)
    
    with open(path, "w") as f:
        f.write(content)


def bump_version(version: str, bump_type: str) -> str:
    """Bump a version string.
    
    Args:
        version: The current version string (e.g., "0.1.34")
        bump_type: The type of bump (major, minor, or patch)
        
    Returns:
        The new version string
    """
    if not re.match(r'^\d+\.\d+\.\d+$', version):
        raise ValueError(f"Invalid version format: {version}")
    
    major, minor, patch = map(int, version.split('.'))
    
    if bump_type == "major":
        major += 1
        minor = 0
        patch = 0
    elif bump_type == "minor":
        minor += 1
        patch = 0
    elif bump_type == "patch":
        patch += 1
    else:
        raise ValueError(f"Invalid bump type: {bump_type}")
    
    return f"{major}.{minor}.{patch}"


def main() -> int:
    """Main entry point for the script.
    
    Returns:
        Exit code (0 for success, 1 for error)
    """
    parser = argparse.ArgumentParser(description="Bump the project version")
    parser.add_argument(
        "bump_type", 
        choices=["major", "minor", "patch"],
        help="Type of version bump"
    )
    args = parser.parse_args()
    
    try:
        # Determine project root
        project_root = Path(__file__).parent.parent
        pyproject_path = project_root / "pyproject.toml"
        
        # Read pyproject.toml
        pyproject_data = read_pyproject(pyproject_path)
        current_version = pyproject_data["project"]["version"]
        
        # Calculate new version
        new_version = bump_version(current_version, args.bump_type)
        pyproject_data["project"]["version"] = new_version
        
        print(f"Bumping version: {current_version} → {new_version}")
        
        # Update pyproject.toml
        write_pyproject(pyproject_path, pyproject_data)
        
        # Run the version update script to sync __init__.py
        update_script = project_root / "scripts" / "update_version.py"
        if update_script.exists():
            print("Updating __init__.py...")
            os.system(f"{sys.executable} {update_script}")
        
        # Create a git commit
        print("\nTo commit this version bump, run:")
        print(f"git commit -am \"Bump version to {new_version}\"")
        
        return 0
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
