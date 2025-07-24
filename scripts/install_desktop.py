#!/usr/bin/env python
"""
Script to install Hanzo AI to Claude Desktop.

Usage:
    python -m scripts.install_desktop [allowed_paths] [server_name] [disable_write] [disable_search]
"""

import subprocess
import sys


def main():
    """Install Hanzo AI to Claude Desktop."""
    # Get arguments from command line
    allowed_paths = sys.argv[1] if len(sys.argv) > 1 else ""
    server_name = sys.argv[2] if len(sys.argv) > 2 else "hanzo"
    disable_write = sys.argv[3] if len(sys.argv) > 3 else ""
    disable_search = sys.argv[4] if len(sys.argv) > 4 else ""

    # Build command
    command = ["python", "-m", "hanzo_mcp.cli", "--install", "--name", server_name]

    # Add allowed paths
    if allowed_paths:
        for path in allowed_paths.split(","):
            path = path.strip()
            if path:
                print(f"Adding allowed path: {path}")
                command.extend(["--allow-path", path])

    # Add flags
    if disable_write:
        print("Disabling write tools")
        command.append("--disable-write-tools")

    if disable_search:
        print("Disabling search tools")
        command.append("--disable-search-tools")

    # Print command
    print(f"Running: {' '.join(command)}")

    # Run command
    result = subprocess.run(command, capture_output=True, text=True)

    # Print output
    print(result.stdout)
    
    if result.stderr:
        print(f"Errors: {result.stderr}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
