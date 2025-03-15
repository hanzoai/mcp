#!/bin/bash

# Ensure we exit on any error
set -e

# Detect the script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create virtual environment if it doesn't exist
if [ ! -d .venv ]; then
    echo "Creating virtual environment..."
    python -m venv .venv
fi

# Activate virtual environment
source .venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install -e .

# Install the server in Claude Desktop
echo "Installing in Claude Desktop..."
python -m mcp_claude_code.cli --install --allow-path "$HOME" --name "claude-code"

echo ""
echo "Installation complete!"
echo "You can now use the MCP Claude Code server in Claude Desktop."
echo "Restart Claude Desktop for changes to take effect."
