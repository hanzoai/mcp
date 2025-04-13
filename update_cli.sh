#!/bin/bash

# Ensure script is executable
chmod +x $(dirname "$0")/update_cli.sh

echo "Building and installing the updated hanzo-mcp package..."

# Install in development mode to make the changes available immediately
pip install -e .

echo "Installation complete."
echo "To use the updated CLI, run:"
echo "  python -m hanzo_mcp.cli --transport sse --port 3001"
echo ""
echo "Or if you're using LibreChat, go to the LibreChat directory and run:"
echo "  ./update_mcp.sh"
