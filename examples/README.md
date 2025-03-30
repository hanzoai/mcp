# MCP Examples

This directory contains examples demonstrating how to use the Hanzo MCP framework.

## Computer Use Example

The `computer_use_example.py` script demonstrates how to use the MCP computer use interface to interact with the computer-use MCP server, which provides full computer access capabilities.

### Prerequisites

- Hanzo MCP should be installed
- The computer-use server should be available and configured

By default, the computer-use server is disabled for security reasons. To enable it, you need to modify the MCP servers configuration file located at `~/.config/hanzo/mcp_servers.json` and set the `enabled` property to `"true"` for the `computer-use` server:

```json
{
  "computer-use": {
    "enabled": "true",
    "command": "uvx",
    "args": ["mcp-server-computer-use"],
    "description": "Provides full computer access (use with caution)",
    "env": {}
  }
}
```

### Usage

The example script provides several commands to demonstrate different capabilities:

```bash
# List computer capabilities
python computer_use_example.py list

# Open an application
python computer_use_example.py open-app firefox

# Take a screenshot
python computer_use_example.py screenshot --output screenshot.png

# Open file explorer
python computer_use_example.py explorer /path/to/explore

# Get clipboard contents
python computer_use_example.py clipboard

# Set clipboard contents
python computer_use_example.py clipboard --set "Hello, MCP!"

# Run a complete workflow demonstration
python computer_use_example.py workflow
```

### Example API Usage

Here's how you can use the computer use interface in your own code:

```python
import asyncio
from hanzo_mcp.tools.computer_use import (
    get_computer_capabilities,
    open_application,
    take_screenshot,
    file_explorer,
    clipboard_get,
    clipboard_set,
)

async def example():
    # Check if computer use is available
    capabilities = await get_computer_capabilities()
    if not capabilities["available"]:
        print("Computer use is not available on this system")
        return
        
    # Open an application
    await open_application("firefox")
    
    # Take a screenshot
    result = await take_screenshot()
    if result["success"]:
        print(f"Screenshot taken: {result['path']}")
    
    # Get clipboard contents
    result = await clipboard_get()
    if result["success"]:
        print(f"Clipboard contents: {result['text']}")
    
    # Set clipboard contents
    await clipboard_set("Hello from MCP!")

# Run the example
asyncio.run(example())
```

For more advanced usage, you can create your own instance of the `ComputerUseInterface` class:

```python
import asyncio
from hanzo_mcp.tools.computer_use import ComputerUseInterface

async def advanced_example():
    # Create a custom interface
    interface = ComputerUseInterface()
    
    # Make sure the server is running
    await interface.ensure_running()
    
    # Get available tools
    tools = await interface.get_available_tools()
    for tool in tools:
        print(f"Available tool: {tool['name']}")
    
    # Execute a custom tool
    result = await interface.execute_tool(
        tool_name="open_application",
        params={"name": "firefox"}
    )
    
    # Stop the server when done
    await interface.stop()

# Run the example
asyncio.run(advanced_example())
```

## External Servers Example

The `external-servers.json` file demonstrates how to configure external MCP servers that can be used with Hanzo MCP.

### Configuring External Servers

You can define external servers in a JSON file that can be loaded by the MCP server manager:

```json
{
  "servers": [
    {
      "name": "iterm2",
      "command": "iterm2-mcp",
      "args": [],
      "enabled": true,
      "description": "iTerm2 MCP server for terminal integration"
    },
    {
      "name": "neovim",
      "command": "nvim-mcp",
      "args": [],
      "enabled": true,
      "description": "Neovim MCP server for editor integration"
    }
  ]
}
```

### Loading External Servers

You can load external servers programmatically:

```python
import json
from hanzo_mcp.external.mcp_manager import ExternalMCPServerManager

# Load servers from a file
with open("external-servers.json", "r") as f:
    config = json.load(f)

# Initialize the manager
manager = ExternalMCPServerManager()

# Add servers from the configuration
for server_config in config.get("servers", []):
    name = server_config.get("name")
    command = server_config.get("command")
    args = server_config.get("args", [])
    enabled = server_config.get("enabled", True)
    description = server_config.get("description", "")
    
    # Skip if no command
    if not command:
        continue
    
    # Add the server
    server = ExternalMCPServer(
        name=name,
        command=command,
        args=args,
        enabled=enabled,
        description=description
    )
    
    manager.servers[name] = server

# Start all enabled servers
manager.start_all()
```

## Registry Example

The `mcp-registry.json` file demonstrates how to configure the registry of available MCP servers that can be installed and used with Hanzo MCP.

### Registry Configuration

The registry configuration defines the available MCP servers that can be installed:

```json
{
  "registry": [
    {
      "id": "iterm2",
      "name": "iTerm2 MCP",
      "description": "MCP server for iTerm2 terminal integration",
      "command": "npx",
      "args": ["-y", "iterm2-mcp"]
    },
    {
      "id": "neovim",
      "name": "Neovim MCP",
      "description": "MCP server for Neovim editor integration",
      "command": "npx",
      "args": ["-y", "@bigcodegen/mcp-neovim-server"]
    }
  ]
}
```

### Using the Registry

You can interact with the registry using the `hanzo-mcp-servers` command:

```bash
# Search for available servers
uvx run hanzo-mcp-servers registry search

# Install a server
uvx run hanzo-mcp-servers registry install iterm2

# List installed servers
uvx run hanzo-mcp-servers registry list
```

Or programmatically:

```python
from hanzo_mcp.external.registry import MCPServerRegistry

# Initialize the registry
registry = MCPServerRegistry()

# Search for servers
results = registry.search("term")
for server in results:
    print(f"Found server: {server['name']} - {server['description']}")

# Install a server
registry.install("iterm2")
```

## Creating Your Own MCP Integration

You can create your own integration with Hanzo MCP by following these steps:

1. Create a clear and composable API interface:

```python
# my_integration.py
import asyncio
from typing import Dict, Any, List, Optional

from hanzo_mcp.tools.mcp_manager import MCPServerManager

class MyIntegrationInterface:
    def __init__(self, manager: Optional[MCPServerManager] = None):
        self.manager = manager or MCPServerManager()
        self._server_name = "my-integration"
    
    async def ensure_running(self) -> Dict[str, Any]:
        # Code to ensure the server is running
        ...
    
    async def execute_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        # Code to execute a tool
        ...
    
    # More methods for specific functionality
    ...

# Create a singleton instance
my_integration = MyIntegrationInterface()

# Helper functions for common operations
async def do_something() -> Dict[str, Any]:
    return await my_integration.execute_tool("do_something", {})
```

2. Add proper tests for your interface:

```python
# test_my_integration.py
import pytest
from unittest.mock import MagicMock, patch

from my_integration import MyIntegrationInterface

@pytest.fixture
def mock_manager():
    # Set up mock manager
    ...

@pytest.mark.asyncio
async def test_ensure_running(mock_manager):
    # Test ensuring the server is running
    ...

@pytest.mark.asyncio
async def test_execute_tool(mock_manager):
    # Test executing a tool
    ...
```

3. Create an example script demonstrating usage:

```python
# my_integration_example.py
import asyncio
import argparse

from my_integration import MyIntegrationInterface, do_something

async def main():
    parser = argparse.ArgumentParser(description="My Integration Example")
    # Add command-line arguments
    ...
    
    args = parser.parse_args()
    
    # Parse arguments and run commands
    ...

if __name__ == "__main__":
    asyncio.run(main())
```

## Best Practices

When creating integrations with Hanzo MCP, follow these best practices:

1. **Clear API Design**: Design your API to be clear, composable, and easy to understand.

2. **Error Handling**: Properly handle errors and provide meaningful error messages.

3. **Documentation**: Document your code with docstrings and comments.

4. **Type Annotations**: Use type annotations to make your code more maintainable.

5. **Tests**: Write comprehensive tests for your code.

6. **Examples**: Provide examples of how to use your integration.

7. **Security**: Consider security implications, especially when dealing with sensitive operations.

8. **Graceful Degradation**: Handle cases where servers or dependencies may not be available.

9. **Resource Management**: Properly manage resources like server processes and connections.

10. **Asynchronous Operations**: Use async/await for operations that might take time.

By following these guidelines, you can create reliable and maintainable integrations with Hanzo MCP.
