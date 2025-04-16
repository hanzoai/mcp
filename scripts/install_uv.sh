#!/bin/bash
# Script to install uv package manager

# Check for curl
if ! command -v curl &> /dev/null; then
    echo "Error: curl is required but not installed. Please install curl first."
    exit 1
fi

# Install uv using the official installation script
curl -fsSL https://astral.sh/uv/install.sh | sh

# Add message about PATH
echo ""
echo "uv has been installed. If you're seeing 'command not found' errors,"
echo "you may need to add it to your PATH or restart your terminal session."
echo ""
echo "You can now run 'make test' to install test dependencies and run the tests."
