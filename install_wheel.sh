#!/bin/bash
set -e

echo "Installing hanzo-mcp wheel with symbols..."

# Install with system pip
pip3 install "dist/hanzo_mcp-0.1.29-py3-none-any.whl[symbols]" --force-reinstall --break-system-packages

echo "Installation complete. You can now run hanzo-mcp!"
echo
echo "Usage examples:"
echo "  hanzo-mcp --allow-path /your/project/path"
echo "  hanzo-mcp-servers list"
echo "  hanzo-meta-mcp --help"
