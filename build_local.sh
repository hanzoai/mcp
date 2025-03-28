#!/bin/bash
set -e

echo "Building hanzo-mcp package locally..."

# Clean up any previous builds
rm -rf dist build hanzo_mcp.egg-info

# Build the package
python -m pip install --upgrade pip
python -m pip install build wheel
python -m build

echo "Package built successfully."
echo "To install for testing, run:"
echo "python -m pip install dist/hanzo_mcp-*.whl[all]"
