Installation
============

Hanzo MCP can be installed in multiple ways depending on your use case.

Prerequisites
-------------

- Python 3.12 or higher
- `uv` package manager (recommended) or `pip`
- Claude Desktop (for MCP integration)

Quick Install
-------------

Using uv (Recommended)
~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: bash

    # Install uv if you haven't already
    pip install uv

    # Install Hanzo MCP
    uv pip install hanzo-mcp

Using pip
~~~~~~~~~

.. code-block:: bash

    pip install hanzo-mcp

Development Installation
------------------------

For contributing or customizing Hanzo MCP:

.. code-block:: bash

    # Clone the repository
    git clone https://github.com/hanzoai/mcp.git
    cd mcp

    # Create virtual environment
    uv venv .venv --python=3.12
    source .venv/bin/activate  # On Windows: .venv\Scripts\activate

    # Install in development mode
    uv pip install -e "."

Claude Desktop Integration
--------------------------

The easiest way to use Hanzo MCP with Claude Desktop:

.. code-block:: bash

    # Automatic installation
    hanzo-mcp --install

    # With custom configuration
    hanzo-mcp --install \
        --allowed-paths "/path/to/projects,/another/path" \
        --server-name "my-hanzo"

Manual Claude Desktop Setup
~~~~~~~~~~~~~~~~~~~~~~~~~~~

1. Locate your Claude Desktop configuration:
   
   - **macOS**: ``~/Library/Application Support/Claude/claude_desktop_config.json``
   - **Windows**: ``%APPDATA%\Claude\claude_desktop_config.json``

2. Add Hanzo MCP to the configuration:

.. code-block:: json

    {
      "mcpServers": {
        "hanzo": {
          "command": "uvx",
          "args": ["--from", "hanzo-mcp", "hanzo-mcp"],
          "env": {
            "HANZO_ALLOWED_PATHS": "/Users/you/projects",
            "OPENAI_API_KEY": "sk-...",
            "ANTHROPIC_API_KEY": "sk-ant-..."
          }
        }
      }
    }

3. Restart Claude Desktop

Docker Installation
-------------------

For isolated environments:

.. code-block:: bash

    docker pull hanzoai/mcp:latest
    
    docker run -it \
        -v /path/to/projects:/workspace \
        -e OPENAI_API_KEY=$OPENAI_API_KEY \
        hanzoai/mcp

Verifying Installation
----------------------

Check that Hanzo MCP is installed correctly:

.. code-block:: bash

    # Check version
    hanzo-mcp --version

    # Run in standalone mode
    hanzo-mcp --allowed-paths /path/to/project

    # View available tools
    hanzo-mcp --list-tools

Troubleshooting
---------------

**Command not found**
    Ensure your Python scripts directory is in PATH

**Permission errors**
    Use ``--allowed-paths`` to grant access to specific directories

**Import errors**
    Install missing dependencies: ``uv pip install hanzo-mcp[all]``

Next Steps
----------

- :doc:`quickstart` - Get started with your first project
- :doc:`claude-desktop` - Detailed Claude Desktop configuration
- :doc:`../concepts/permissions` - Understanding the permission system