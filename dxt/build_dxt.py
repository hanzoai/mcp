#!/usr/bin/env python3
"""
Build script to package Hanzo AI as a .dxt file for Claude Desktop.

This script creates a Desktop Extension (.dxt) file that can be installed
with a simple double-click in Claude Desktop.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, Any


def get_hanzo_version() -> str:
    """Get Hanzo AI version."""
    try:
        # Add parent directory to path for imports
        project_root = Path(__file__).parent.parent
        if str(project_root) not in sys.path:
            sys.path.insert(0, str(project_root))
        
        from hanzo_mcp import __version__
        return __version__
    except ImportError:
        return "0.0.0"


def load_manifest(manifest_path: Path) -> Dict[str, Any]:
    """Load and validate the manifest.json file."""
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)
    
    # Validate required fields according to Anthropic DXT spec
    required_fields = ['dxt_version', 'name', 'version', 'description', 'author', 'server']
    for field in required_fields:
        if field not in manifest:
            raise ValueError(f"Missing required field in manifest.json: {field}")
    
    # Validate author has required name field
    if 'name' not in manifest.get('author', {}):
        raise ValueError("Missing required field in manifest.json: author.name")
    
    # Validate server structure
    server = manifest.get('server', {})
    server_required = ['type', 'entry_point', 'mcp_config']
    for field in server_required:
        if field not in server:
            raise ValueError(f"Missing required field in manifest.json server: {field}")
    
    # Validate mcp_config
    mcp_config = server.get('mcp_config', {})
    if 'command' not in mcp_config or 'args' not in mcp_config:
        raise ValueError("Missing required fields in manifest.json server.mcp_config: command and args")
    
    return manifest


def get_project_root() -> Path:
    """Get the project root directory."""
    return Path(__file__).parent.parent


def get_version() -> str:
    """Get the current version from pyproject.toml or setup.py."""
    project_root = get_project_root()
    
    # Try pyproject.toml first
    pyproject_path = project_root / "pyproject.toml"
    if pyproject_path.exists():
        try:
            # Python 3.11+
            import tomllib
        except ImportError:
            try:
                # Fallback for older Python versions
                import tomli as tomllib
            except ImportError:
                # If neither is available, skip pyproject.toml
                tomllib = None
        
        if tomllib:
            with open(pyproject_path, 'rb') as f:
                data = tomllib.load(f)
                version = data.get('project', {}).get('version', '0.0.0')
                if version != '0.0.0':
                    return version
    
    # Fallback to setup.py
    setup_path = project_root / "setup.py"
    if setup_path.exists():
        # Run setup.py to get version
        result = subprocess.run(
            [sys.executable, setup_path, '--version'],
            capture_output=True,
            text=True,
            cwd=project_root
        )
        if result.returncode == 0:
            return result.stdout.strip()
    
    # Try importing hanzo_mcp directly
    version = get_hanzo_version()
    if version != "0.0.0":
        return version
    
    return "0.0.0"


def create_launcher_script() -> str:
    """Create a launcher script for the extension."""
    return """#!/usr/bin/env python3
import os
import sys
import subprocess

# Add the extension directory to Python path
extension_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, extension_dir)

# Handle user configuration from environment
allowed_paths = os.environ.get('ALLOWED_PATHS', '').split(',') if os.environ.get('ALLOWED_PATHS') else []
disable_write = os.environ.get('DISABLE_WRITE_TOOLS', 'false').lower() == 'true'
disable_search = os.environ.get('DISABLE_SEARCH_TOOLS', 'false').lower() == 'true'
enable_agent = os.environ.get('ENABLE_AGENT_TOOL', 'false').lower() == 'true'

# Handle mode and API configuration
hanzo_mode = os.environ.get('HANZO_MODE', 'hanzo')
hanzo_api_key = os.environ.get('HANZO_API_KEY', '')
disable_login = os.environ.get('DISABLE_HANZO_LOGIN', 'true').lower() == 'true'

# Auto-enable agent if API key is provided
if hanzo_api_key:
    enable_agent = True

# Build command line arguments
args = []
if allowed_paths:
    for path in allowed_paths:
        args.extend(['--allow-path', path.strip()])
if disable_write:
    args.append('--disable-write-tools')
if disable_search:
    args.append('--disable-search-tools')
if enable_agent:
    args.append('--enable-agent-tool')

# Pass mode configuration
args.extend(['--force-mode', hanzo_mode])

# Set environment for mode system
os.environ['HANZO_MODE'] = hanzo_mode
if hanzo_api_key:
    os.environ['HANZO_API_KEY'] = hanzo_api_key
if disable_login:
    os.environ['DISABLE_HANZO_LOGIN'] = 'true'

# Set up sys.argv
sys.argv = ['hanzo-mcp'] + args

# Run the Hanzo AI CLI
from hanzo_mcp.cli import main
main()
"""


def build_dxt(output_dir: Path) -> Path:
    """Build the .dxt file."""
    project_root = get_project_root()
    manifest_path = Path(__file__).parent / "manifest.json"
    
    # Load manifest
    manifest = load_manifest(manifest_path)
    
    # Update version
    manifest['version'] = get_version()
    
    # Create temporary build directory
    with tempfile.TemporaryDirectory() as temp_dir:
        build_dir = Path(temp_dir) / "hanzo-mcp"
        build_dir.mkdir()
        
        # Copy manifest
        manifest_dest = build_dir / "manifest.json"
        with open(manifest_dest, 'w') as f:
            json.dump(manifest, f, indent=2)
        
        # Copy icon if it exists
        icon_path = Path(__file__).parent / "icon.png"
        if icon_path.exists():
            shutil.copy2(icon_path, build_dir / "icon.png")
            print("   ✅ Included icon.png")
        else:
            icon_svg = Path(__file__).parent / "icon.svg"
            if icon_svg.exists():
                print("   ⚠️  Found icon.svg but DXT requires icon.png")
                print("      Run: python3 create_simple_icon.py")
            else:
                print("   ⚠️  No icon found - extension will use default icon")
        
        # Copy Python package
        src_dir = project_root / "hanzo_mcp"
        dest_dir = build_dir / "hanzo_mcp"
        shutil.copytree(src_dir, dest_dir, ignore=shutil.ignore_patterns(
            '*.pyc', '__pycache__', '*.egg-info', '.git', '.pytest_cache'
        ))
        
        # Create launcher script
        launcher_path = build_dir / "launcher.py"
        with open(launcher_path, 'w') as f:
            f.write(create_launcher_script())
        os.chmod(launcher_path, 0o755)
        
        # Create requirements.txt with all necessary dependencies
        requirements = [
            "mcp>=1.9.4",
            "fastmcp>=2.9.2",
            "httpx>=0.28.1",
            "uvicorn>=0.34.0",
            "openai>=1.62.0",
            "python-dotenv>=1.0.1",
            "litellm>=1.73.2",
            "grep-ast>=0.8.1",
            "bashlex>=0.18",
            "libtmux>=0.39.0",
            "nbformat>=5.10.4",
            "psutil>=6.1.1",
            "pydantic>=2.11.1",
            "pydantic-settings>=2.7.0",
            "typing-extensions>=4.13.0",
            "watchdog>=6.0.0",
            "tree-sitter>=0.20.0",
            "tree-sitter-python>=0.20.0",
            "tree-sitter-javascript>=0.20.0",
            "tree-sitter-typescript>=0.20.0",
            "tree-sitter-language-pack>=0.1.0",
            "pygments>=2.0.0",
            "rich>=13.0.0"
        ]
        
        requirements_path = build_dir / "requirements.txt"
        with open(requirements_path, 'w') as f:
            f.write('\n'.join(requirements))
        
        # Create install script
        install_script = """#!/bin/bash
# Installation script for Hanzo AI Desktop Extension

echo "Installing Hanzo AI dependencies..."

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi

# Activate virtual environment and install dependencies
source .venv/bin/activate
pip install -r requirements.txt

echo "Hanzo AI installed successfully!"
"""
        
        install_path = build_dir / "install.sh"
        with open(install_path, 'w') as f:
            f.write(install_script)
        os.chmod(install_path, 0o755)
        
        # Create install.bat for Windows
        install_bat = """@echo off
REM Installation script for Hanzo AI Desktop Extension

echo Installing Hanzo AI dependencies...

REM Create virtual environment if it doesn't exist
if not exist ".venv" (
    python -m venv .venv
)

REM Activate virtual environment and install dependencies
call .venv\\Scripts\\activate.bat
pip install -r requirements.txt

echo Hanzo AI installed successfully!
pause
"""
        
        install_bat_path = build_dir / "install.bat"
        with open(install_bat_path, 'w') as f:
            f.write(install_bat)
        
        # Create README
        readme_content = f"""# Hanzo AI Desktop Extension

Version: {manifest['version']}

## Installation

1. Double-click this .dxt file to install in Claude Desktop
2. Or manually extract and run the appropriate install script:
   - macOS/Linux: `./install.sh`
   - Windows: `install.bat`

## Configuration

The extension will be available in Claude Desktop after installation.
You can configure allowed paths and other settings in Claude Desktop's
extension settings.

## Tools Available

This extension provides {len(manifest.get('tools', []))} tools including:
- File system operations (read, write, edit)
- Code search with AST awareness
- Shell command execution
- Process management
- Todo list management
- And more!

## Documentation

For full documentation, visit: https://github.com/hanzoai/mcp
"""
        
        readme_path = build_dir / "README.md"
        with open(readme_path, 'w') as f:
            f.write(readme_content)
        
        # Create the .dxt file (ZIP archive)
        dxt_filename = f"hanzo-mcp-{manifest['version']}.dxt"
        dxt_path = output_dir / dxt_filename
        
        with zipfile.ZipFile(dxt_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            # Add all files from build directory
            for root, dirs, files in os.walk(build_dir):
                for file in files:
                    file_path = Path(root) / file
                    # Create the archive name relative to build_dir (not its parent)
                    # This puts files at the root of the ZIP instead of in a subdirectory
                    arcname = file_path.relative_to(build_dir)
                    zf.write(file_path, arcname)
        
        return dxt_path


def main():
    """Main entry point."""
    # Determine output directory
    output_dir = Path.cwd() / "dist"
    output_dir.mkdir(exist_ok=True)
    
    print("🔨 Building Hanzo AI Desktop Extension (.dxt)...")
    
    try:
        dxt_path = build_dxt(output_dir)
        print(f"✅ Successfully built: {dxt_path}")
        print(f"📦 File size: {dxt_path.stat().st_size / 1024 / 1024:.2f} MB")
        print("\n📋 Installation instructions:")
        print("1. Double-click the .dxt file to install in Claude Desktop")
        print("2. Or drag and drop it into Claude Desktop's extension manager")
        
    except Exception as e:
        print(f"❌ Build failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
