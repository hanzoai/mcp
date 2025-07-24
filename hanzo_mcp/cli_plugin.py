#!/usr/bin/env python3
"""CLI for managing Hanzo MCP plugins."""

import argparse
import sys
from pathlib import Path

from hanzo_mcp.tools.common.plugin_loader import create_plugin_template, list_plugin_tools


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Hanzo MCP Plugin Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Create a new plugin template
  hanzo-plugin create mytool
  
  # List installed plugins
  hanzo-plugin list
  
  # Create plugin in specific directory
  hanzo-plugin create mytool --output /path/to/plugins
"""
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # Create command
    create_parser = subparsers.add_parser("create", help="Create a new plugin template")
    create_parser.add_argument("name", help="Name of the tool (e.g., 'mytool')")
    create_parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path.home() / ".hanzo" / "plugins",
        help="Output directory for the plugin (default: ~/.hanzo/plugins)"
    )
    
    # List command
    list_parser = subparsers.add_parser("list", help="List installed plugins")
    
    args = parser.parse_args()
    
    if args.command == "create":
        # Create plugin template
        output_dir = args.output / args.name
        try:
            create_plugin_template(output_dir, args.name)
            print(f"\n✅ Plugin template created successfully!")
            print(f"\nTo use your plugin:")
            print(f"1. Edit the tool implementation in {output_dir / f'{args.name}_tool.py'}")
            print(f"2. Restart Hanzo MCP to load the plugin")
            print(f"3. Add '{args.name}' to your mode's tool list")
        except Exception as e:
            print(f"❌ Error creating plugin: {e}", file=sys.stderr)
            sys.exit(1)
    
    elif args.command == "list":
        # List installed plugins
        try:
            from hanzo_mcp.tools.common.plugin_loader import load_user_plugins
            plugins = load_user_plugins()
            
            if not plugins:
                print("No plugins installed.")
                print("\nPlugin directories:")
                print("  ~/.hanzo/plugins/")
                print("  ./.hanzo/plugins/")
                print("  $HANZO_PLUGIN_PATH")
            else:
                print(f"Installed plugins ({len(plugins)}):")
                for name, plugin in plugins.items():
                    print(f"\n  {name}:")
                    print(f"    Source: {plugin.source_path}")
                    if plugin.metadata:
                        print(f"    Version: {plugin.metadata.get('version', 'unknown')}")
                        print(f"    Author: {plugin.metadata.get('author', 'unknown')}")
                        print(f"    Description: {plugin.metadata.get('description', '')}")
        except Exception as e:
            print(f"❌ Error listing plugins: {e}", file=sys.stderr)
            sys.exit(1)
    
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()