#!/bin/bash
set -e

echo "Running hanzo-mcp with a test directory..."

# Create a test directory if it doesn't exist
TEST_DIR="$HOME/hanzo_mcp_test"
mkdir -p "$TEST_DIR"

# Run hanzo-mcp with the test directory allowed
hanzo-mcp --allow-path "$TEST_DIR" --name "test-server"

# For convenience, you can also run other variants:
# hanzo-meta-mcp --allow-path "$TEST_DIR" --name "meta-test"
# hanzo-mcp-servers list
