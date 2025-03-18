#!/bin/bash
set -e

# Initialize git repository if not already initialized
if [ ! -d ".git" ]; then
  echo "Initializing git repository..."
  git init
else
  echo "Git repository already initialized."
fi

# Add all files to git
echo "Adding files to git..."
git add .

# Create initial commit
echo "Creating initial commit..."
git commit -m "Initial commit"

# Create GitHub repository and push
echo "Creating GitHub repository..."
gh repo create mcp-claude-code --public --source=. --push --description "MCP implementation of Claude Code capabilities"

echo "Setup complete! Repository is now available on GitHub."
