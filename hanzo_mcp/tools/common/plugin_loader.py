"""Plugin loader for custom user tools."""

import importlib.util
import inspect
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Type, Any
from dataclasses import dataclass

from .base import BaseTool
from .context import ToolContext


@dataclass
class ToolPlugin:
    """Represents a loaded tool plugin."""
    name: str
    tool_class: Type[BaseTool]
    source_path: Path
    metadata: Optional[Dict[str, Any]] = None


class PluginLoader:
    """Loads custom tool plugins from user directories."""
    
    def __init__(self):
        self.plugins: Dict[str, ToolPlugin] = {}
        self.plugin_dirs: List[Path] = []
        self._setup_plugin_directories()
    
    def _setup_plugin_directories(self):
        """Set up standard plugin directories."""
        # User's home directory plugins
        home_plugins = Path.home() / ".hanzo" / "plugins"
        home_plugins.mkdir(parents=True, exist_ok=True)
        self.plugin_dirs.append(home_plugins)
        
        # Project-local plugins
        project_plugins = Path.cwd() / ".hanzo" / "plugins"
        if project_plugins.exists():
            self.plugin_dirs.append(project_plugins)
        
        # Environment variable for additional paths
        if custom_paths := os.environ.get("HANZO_PLUGIN_PATH"):
            for path in custom_paths.split(":"):
                plugin_dir = Path(path)
                if plugin_dir.exists():
                    self.plugin_dirs.append(plugin_dir)
    
    def load_plugins(self) -> Dict[str, ToolPlugin]:
        """Load all plugins from configured directories."""
        for plugin_dir in self.plugin_dirs:
            if not plugin_dir.exists():
                continue
                
            # Look for Python files
            for py_file in plugin_dir.glob("*.py"):
                if py_file.name.startswith("_"):
                    continue
                    
                try:
                    self._load_plugin_file(py_file)
                except Exception as e:
                    print(f"Failed to load plugin {py_file}: {e}")
            
            # Look for plugin packages
            for package_dir in plugin_dir.iterdir():
                if package_dir.is_dir() and (package_dir / "__init__.py").exists():
                    try:
                        self._load_plugin_package(package_dir)
                    except Exception as e:
                        print(f"Failed to load plugin package {package_dir}: {e}")
        
        return self.plugins
    
    def _load_plugin_file(self, file_path: Path):
        """Load a single plugin file."""
        # Load the module
        spec = importlib.util.spec_from_file_location(file_path.stem, file_path)
        if not spec or not spec.loader:
            return
            
        module = importlib.util.module_from_spec(spec)
        sys.modules[file_path.stem] = module
        spec.loader.exec_module(module)
        
        # Find tool classes
        for name, obj in inspect.getmembers(module):
            if (inspect.isclass(obj) and 
                issubclass(obj, BaseTool) and 
                obj != BaseTool and
                hasattr(obj, 'name')):
                
                # Load metadata if available
                metadata = None
                metadata_file = file_path.with_suffix('.json')
                if metadata_file.exists():
                    with open(metadata_file) as f:
                        metadata = json.load(f)
                
                plugin = ToolPlugin(
                    name=obj.name,
                    tool_class=obj,
                    source_path=file_path,
                    metadata=metadata
                )
                self.plugins[obj.name] = plugin
    
    def _load_plugin_package(self, package_dir: Path):
        """Load a plugin package."""
        # Add parent to path temporarily
        parent = str(package_dir.parent)
        if parent not in sys.path:
            sys.path.insert(0, parent)
        
        try:
            # Import the package
            module = importlib.import_module(package_dir.name)
            
            # Look for tools
            if hasattr(module, 'TOOLS'):
                # Package exports TOOLS list
                for tool_class in module.TOOLS:
                    if issubclass(tool_class, BaseTool):
                        plugin = ToolPlugin(
                            name=tool_class.name,
                            tool_class=tool_class,
                            source_path=package_dir
                        )
                        self.plugins[tool_class.name] = plugin
            else:
                # Search for tool classes
                for name, obj in inspect.getmembers(module):
                    if (inspect.isclass(obj) and 
                        issubclass(obj, BaseTool) and 
                        obj != BaseTool and
                        hasattr(obj, 'name')):
                        
                        plugin = ToolPlugin(
                            name=obj.name,
                            tool_class=obj,
                            source_path=package_dir
                        )
                        self.plugins[obj.name] = plugin
        finally:
            # Remove from path
            if parent in sys.path:
                sys.path.remove(parent)
    
    def get_tool_class(self, name: str) -> Optional[Type[BaseTool]]:
        """Get a tool class by name."""
        plugin = self.plugins.get(name)
        return plugin.tool_class if plugin else None
    
    def list_plugins(self) -> List[str]:
        """List all loaded plugin names."""
        return list(self.plugins.keys())


# Global plugin loader instance
_plugin_loader = PluginLoader()


def load_user_plugins() -> Dict[str, ToolPlugin]:
    """Load all user plugins."""
    return _plugin_loader.load_plugins()


def get_plugin_tool(name: str) -> Optional[Type[BaseTool]]:
    """Get a plugin tool class by name."""
    return _plugin_loader.get_tool_class(name)


def list_plugin_tools() -> List[str]:
    """List all available plugin tools."""
    return _plugin_loader.list_plugins()


def create_plugin_template(output_dir: Path, tool_name: str):
    """Create a template for a new plugin tool."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Create tool file
    tool_file = output_dir / f"{tool_name}_tool.py"
    tool_content = f'''"""Custom {tool_name} tool plugin."""

from hanzo_mcp.tools.common.base import BaseTool
from typing import Dict, Any


class {tool_name.title()}Tool(BaseTool):
    """Custom {tool_name} tool implementation."""
    
    name = "{tool_name}"
    description = "Custom {tool_name} tool"
    
    async def run(self, params: Dict[str, Any], ctx) -> Dict[str, Any]:
        """Execute the {tool_name} tool."""
        # Get parameters
        action = params.get("action", "default")
        
        # Implement your tool logic here
        if action == "default":
            return {{
                "status": "success",
                "message": f"Running {tool_name} tool",
                "data": {{
                    "params": params
                }}
            }}
        
        # Add more actions as needed
        elif action == "custom_action":
            # Your custom logic here
            pass
        
        return {{
            "status": "error",
            "message": f"Unknown action: {{action}}"
        }}


# Optional: Export tools explicitly
TOOLS = [{tool_name.title()}Tool]
'''
    
    with open(tool_file, 'w') as f:
        f.write(tool_content)
    
    # Create metadata file
    metadata_file = output_dir / f"{tool_name}_tool.json"
    metadata_content = {
        "name": tool_name,
        "version": "1.0.0",
        "author": "Your Name",
        "description": f"Custom {tool_name} tool",
        "modes": ["custom"],  # Modes this tool should be added to
        "dependencies": [],
        "config": {
            # Tool-specific configuration
        }
    }
    
    with open(metadata_file, 'w') as f:
        json.dump(metadata_content, f, indent=2)
    
    # Create README
    readme_file = output_dir / "README.md"
    readme_content = f"""# {tool_name.title()} Tool Plugin

Custom tool plugin for Hanzo MCP.

## Installation

1. Place this directory in one of:
   - `~/.hanzo/plugins/`
   - `./.hanzo/plugins/` (project-specific)
   - Any path in `HANZO_PLUGIN_PATH` environment variable

2. The tool will be automatically loaded when Hanzo MCP starts.

## Usage

The tool will be available as `{tool_name}` in any mode that includes it.

## Configuration

Edit the `{tool_name}_tool.json` file to:
- Add the tool to specific modes
- Configure tool-specific settings
- Specify dependencies

## Development

Modify `{tool_name}_tool.py` to implement your custom functionality.
"""
    
    with open(readme_file, 'w') as f:
        f.write(readme_content)
    
    print(f"Created plugin template in {output_dir}")
    print(f"Files created:")
    print(f"  - {tool_file}")
    print(f"  - {metadata_file}")
    print(f"  - {readme_file}")