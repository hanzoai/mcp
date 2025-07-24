# Creating Custom Tools for Hanzo MCP

This guide explains how to create and add custom tools to Hanzo MCP without forking the repository.

## Quick Start

1. Create a plugin directory:
```bash
mkdir -p ~/.hanzo/plugins
```

2. Create your tool file (e.g., `~/.hanzo/plugins/my_tool.py`):
```python
from hanzo_mcp.tools.common.base import BaseTool
from typing import Dict, Any

class MyTool(BaseTool):
    name = "mytool"
    description = "My custom tool"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        # Your tool logic here
        return {"status": "success", "result": "Hello from my tool!"}
```

3. The tool will be automatically loaded when Hanzo MCP starts!

## Plugin Locations

Hanzo MCP looks for plugins in these locations (in order):

1. **User plugins**: `~/.hanzo/plugins/`
2. **Project plugins**: `./.hanzo/plugins/` (in current directory)
3. **Custom paths**: Any path in `HANZO_PLUGIN_PATH` environment variable

Example:
```bash
export HANZO_PLUGIN_PATH="/opt/hanzo-plugins:/usr/local/hanzo-plugins"
```

## Tool Structure

### Basic Tool

```python
from hanzo_mcp.tools.common.base import BaseTool
from typing import Dict, Any

class CustomTool(BaseTool):
    """Your tool documentation."""
    
    name = "custom"  # Tool name used in modes
    description = "Custom tool description"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        """Execute the tool.
        
        Args:
            params: Tool parameters from user
            ctx: Tool context for logging and progress
            
        Returns:
            Dict with results or error
        """
        # Access parameters
        action = params.get("action", "default")
        
        # Log progress
        ctx.info(f"Running {action} action")
        
        # Your logic here
        if action == "hello":
            name = params.get("name", "World")
            return {
                "status": "success",
                "message": f"Hello, {name}!"
            }
        
        return {"error": f"Unknown action: {action}"}
```

### Tool with Multiple Actions

```python
class MultiActionTool(BaseTool):
    name = "multi"
    description = "Tool with multiple actions"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        action = params.get("action", "list")
        
        if action == "list":
            return await self._list_items(params, ctx)
        elif action == "create":
            return await self._create_item(params, ctx)
        elif action == "delete":
            return await self._delete_item(params, ctx)
        else:
            return {"error": f"Unknown action: {action}"}
    
    async def _list_items(self, params: Dict[str, Any], ctx):
        # Implementation
        pass
    
    async def _create_item(self, params: Dict[str, Any], ctx):
        # Implementation
        pass
    
    async def _delete_item(self, params: Dict[str, Any], ctx):
        # Implementation
        pass
```

### Tool Using Other Tools

```python
from hanzo_mcp.tools.filesystem.read import ReadTool
from hanzo_mcp.tools.shell.bash_tool import BashTool

class CompositeTool(BaseTool):
    name = "composite"
    description = "Tool that uses other tools"
    
    def __init__(self):
        super().__init__()
        self.read_tool = ReadTool()
        self.bash_tool = BashTool()
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        # Read a file
        file_content = await self.read_tool.run({
            "file_path": params.get("config_file", "config.json")
        }, ctx)
        
        # Run a command
        result = await self.bash_tool.run({
            "command": "echo 'Processing...'"
        }, ctx)
        
        return {
            "status": "success",
            "file_content": file_content,
            "command_result": result
        }
```

## Plugin Metadata

You can add metadata alongside your tool file (`my_tool.json`):

```json
{
  "name": "mytool",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "My custom tool",
  "modes": ["custom", "personal"],
  "dependencies": ["requests", "pandas"],
  "config": {
    "api_key": "${MYTOOL_API_KEY}",
    "endpoint": "https://api.example.com"
  }
}
```

## Adding Tools to Modes

### Method 1: Update Existing Mode

```python
# In your plugin file
from hanzo_mcp.tools.common.personality import PersonalityRegistry

def register_with_modes():
    """Add this tool to specific modes."""
    # Add to existing mode
    fullstack = PersonalityRegistry.get("fullstack")
    if fullstack and "mytool" not in fullstack.tools:
        fullstack.tools.append("mytool")
    
    # Add to multiple modes
    for mode_name in ["dev", "personal", "custom"]:
        mode = PersonalityRegistry.get(mode_name)
        if mode and "mytool" not in mode.tools:
            mode.tools.append("mytool")

# Call this when plugin loads
register_with_modes()
```

### Method 2: Create New Mode

```python
from hanzo_mcp.tools.common.personality import ToolPersonality, PersonalityRegistry

# Create a custom mode
custom_mode = ToolPersonality(
    name="myworkflow",
    programmer="My Workflow",
    description="My personal development workflow",
    philosophy="Automate everything!",
    tools=[
        # Core tools
        "read", "write", "edit", "bash",
        # My custom tools
        "mytool", "gitflow", "dc", "db"
    ],
    environment={
        "EDITOR": "nvim",
        "SHELL": "/bin/zsh"
    }
)

# Register the mode
PersonalityRegistry.register(custom_mode)
```

## Real-World Examples

### 1. Project Build Tool

```python
class BuildTool(BaseTool):
    name = "build"
    description = "Project build automation"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        project_type = params.get("type", "auto")
        
        # Auto-detect project type
        if project_type == "auto":
            if os.path.exists("package.json"):
                project_type = "node"
            elif os.path.exists("Cargo.toml"):
                project_type = "rust"
            elif os.path.exists("go.mod"):
                project_type = "go"
            elif os.path.exists("pom.xml"):
                project_type = "java"
        
        # Build based on type
        commands = {
            "node": ["npm install", "npm run build"],
            "rust": ["cargo build --release"],
            "go": ["go build -o bin/app"],
            "java": ["mvn clean package"]
        }
        
        if project_type not in commands:
            return {"error": f"Unknown project type: {project_type}"}
        
        results = []
        for cmd in commands[project_type]:
            ctx.info(f"Running: {cmd}")
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            results.append({
                "command": cmd,
                "success": result.returncode == 0,
                "output": result.stdout
            })
        
        return {"status": "success", "project_type": project_type, "results": results}
```

### 2. AWS CLI Wrapper

```python
class AWSTools(BaseTool):
    name = "aws"
    description = "AWS CLI shortcuts"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        service = params.get("service", "s3")
        action = params.get("action", "list")
        
        if service == "s3":
            if action == "list":
                bucket = params.get("bucket", "")
                cmd = f"aws s3 ls {bucket}"
            elif action == "upload":
                source = params.get("source", "")
                dest = params.get("dest", "")
                cmd = f"aws s3 cp {source} {dest}"
            elif action == "sync":
                source = params.get("source", "")
                dest = params.get("dest", "")
                cmd = f"aws s3 sync {source} {dest}"
        
        elif service == "ec2":
            if action == "list":
                cmd = "aws ec2 describe-instances --query 'Reservations[*].Instances[*].[InstanceId,State.Name,Tags[?Key==`Name`].Value|[0]]' --output table"
            elif action == "start":
                instance_id = params.get("instance_id", "")
                cmd = f"aws ec2 start-instances --instance-ids {instance_id}"
            elif action == "stop":
                instance_id = params.get("instance_id", "")
                cmd = f"aws ec2 stop-instances --instance-ids {instance_id}"
        
        # Execute AWS command
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        return {
            "status": "success" if result.returncode == 0 else "error",
            "command": cmd,
            "output": result.stdout,
            "error": result.stderr
        }
```

### 3. Kubernetes Helper

```python
class K8sTool(BaseTool):
    name = "k8s"
    description = "Kubernetes shortcuts"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        resource = params.get("resource", "pods")
        action = params.get("action", "get")
        namespace = params.get("namespace", "default")
        
        # Build kubectl command
        cmd = f"kubectl -n {namespace}"
        
        if action == "get":
            output = params.get("output", "")
            cmd += f" get {resource}"
            if output:
                cmd += f" -o {output}"
        
        elif action == "describe":
            name = params.get("name", "")
            if not name:
                return {"error": "Resource name required"}
            cmd += f" describe {resource} {name}"
        
        elif action == "logs":
            pod = params.get("pod", "")
            if not pod:
                return {"error": "Pod name required"}
            follow = params.get("follow", False)
            cmd += f" logs {pod}"
            if follow:
                cmd += " -f"
        
        elif action == "exec":
            pod = params.get("pod", "")
            command = params.get("command", "/bin/bash")
            cmd += f" exec -it {pod} -- {command}"
        
        # Execute kubectl command
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        return {
            "status": "success" if result.returncode == 0 else "error",
            "command": cmd,
            "output": result.stdout,
            "error": result.stderr
        }
```

## Testing Your Plugin

```python
# test_my_plugin.py
import asyncio
from hanzo_mcp.tools.common.plugin_loader import load_user_plugins
from hanzo_mcp.tools.common.context import Context

async def test_plugin():
    # Load plugins
    plugins = load_user_plugins()
    print(f"Loaded plugins: {list(plugins.keys())}")
    
    # Get your tool
    mytool_class = plugins.get("mytool")
    if mytool_class:
        tool = mytool_class.tool_class()
        ctx = Context()  # Mock context
        
        # Test the tool
        result = await tool.run({"action": "hello", "name": "Test"}, ctx)
        print(f"Result: {result}")

# Run test
asyncio.run(test_plugin())
```

## Distribution

To share your plugin:

1. **Single file**: Share the `.py` file
2. **Package**: Create a directory with `__init__.py`
3. **Repository**: Create a Git repo with installation instructions
4. **PyPI**: Package and publish to PyPI

Example plugin structure:
```
my-hanzo-plugins/
├── README.md
├── requirements.txt
├── my_tool.py
├── my_tool.json
└── install.sh
```

Install script (`install.sh`):
```bash
#!/bin/bash
mkdir -p ~/.hanzo/plugins
cp *.py ~/.hanzo/plugins/
cp *.json ~/.hanzo/plugins/
echo "Plugin installed to ~/.hanzo/plugins/"
```

## Best Practices

1. **Namespace your tools**: Use prefixes to avoid conflicts (e.g., `mycompany_build`)
2. **Handle errors gracefully**: Always return proper error messages
3. **Use the context**: Log progress and info via `ctx.info()`, `ctx.error()`
4. **Document parameters**: Clear documentation helps users
5. **Test thoroughly**: Test with different parameter combinations
6. **Version your plugins**: Use metadata files for versioning
7. **Respect permissions**: Use the permission system for dangerous operations

## Troubleshooting

If your plugin doesn't load:

1. Check file permissions (must be readable)
2. Verify Python syntax: `python -m py_compile my_tool.py`
3. Check class has `name` attribute
4. Look for errors in Hanzo MCP startup logs
5. Ensure plugin directory is in search path

Enable debug logging:
```bash
export HANZO_DEBUG=true
hanzo-mcp
```

This will show plugin loading details.