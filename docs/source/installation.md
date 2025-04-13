# Installation Guide

## Prerequisites

- [uv](https://github.com/astral-sh/uv) - Fast Python package installer and resolver

If you don't have `uv` installed, you can install it following the [official instructions](https://github.com/astral-sh/uv#installation).

## Installation Options

### Quick Install

The quickest way to install and run without setting up a development environment:

```bash
# Install directly from PyPI
uv pip install hanzo-mcp
```

### Development Setup

For contributing or modifying the code:

```bash
# Clone the repository
git clone https://github.com/hanzoai/mcp.git
cd mcp

# Install Python 3.13 (if not already installed)
make install-python

# Create a virtual environment and install dependencies
make install-dev

# Activate the virtual environment
# On Unix/macOS
source .venv/bin/activate
# On Windows
.venv\Scripts\activate
```

## Running Tests

After setting up the development environment:

```bash
# Run the tests
make test

# Run tests with coverage report
make test-cov
```

## Usage

### Running with uvx

You can run it without installation using uvx:

```bash
uvx run hanzo-mcp
```

### Configuring Claude Desktop

Configure Claude Desktop to use this server by adding the following to your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "uvx",
      "args": [
        "--from",
        "hanzo-mcp",
        "hanzo-mcp",
        "--allow-path",
        "/path/to/your/project"
      ]
    }
  }
}
```

Make sure to replace `/path/to/your/project` with the actual path to the project you want Claude to access.

## Advanced Configuration Options

For more advanced configuration options, including LLM model selection and token limits, please see the full [configuration guide](quick-start.md).

## Publishing to PyPI

If you have the necessary credentials, you can publish updates to PyPI. Each publish operation automatically creates and pushes a git tag matching the current version.

```bash
# Update the version number
make bump-patch    # Increment patch version (0.1.x → 0.1.x+1)
make bump-minor    # Increment minor version (0.x.0 → 0.x+1.0)
make bump-major    # Increment major version (x.0.0 → x+1.0.0)

# Build, publish, and create git tag
make publish

# Combined commands (bump version, publish, create git tag)
make publish-patch  # Bump patch version, publish, and create git tag
make publish-minor  # Bump minor version, publish, and create git tag
make publish-major  # Bump major version, publish, and create git tag
```