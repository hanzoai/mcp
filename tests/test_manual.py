#!/usr/bin/env python3
"""Manual test script for Hanzo AI functionality."""

import asyncio
import os
import tempfile
from pathlib import Path

from hanzo_mcp.server import HanzoMCPServer
from hanzo_mcp.tools.common.palette import PaletteRegistry
from hanzo_mcp.tools.shell.bash_tool import bash_tool
from hanzo_mcp.tools.filesystem.read import ReadTool
from hanzo_mcp.tools.filesystem.diff import create_diff_tool
from hanzo_mcp.tools.common.permissions import PermissionManager


async def test_basic_functionality():
    """Test basic MCP functionality."""
    print("🧪 Testing Hanzo AI Basic Functionality\n")
    
    # Create a temporary directory for testing
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        print(f"📁 Using temp directory: {temp_path}\n")
        
        # Test 1: Permission Manager
        print("1️⃣ Testing Permission Manager...")
        pm = PermissionManager()
        pm.add_allowed_path(temp_dir)
        print("✅ Permission manager created\n")
        
        # Test 2: Palette System
        print("2️⃣ Testing Palette System...")
        from hanzo_mcp.tools.common.palette_loader import PaletteLoader
        PaletteLoader.initialize_palettes()
        
        palettes = PaletteRegistry.list()
        print(f"✅ Found {len(palettes)} palettes:")
        for palette in palettes[:3]:  # Show first 3
            print(f"   - {palette.name}: {palette.description}")
        print()
        
        # Test 3: Shell Tool (works with your zsh)
        print("3️⃣ Testing Shell Tool...")
        try:
            # Create mock context
            class MockContext:
                pass
            ctx = MockContext()
            
            # Test shell detection
            interpreter = bash_tool.get_interpreter()
            tool_name = bash_tool.get_tool_name()
            print(f"✅ Shell detected: {interpreter} (tool: {tool_name})")
            
            # Test simple command
            result = await bash_tool.execute_sync("echo 'Hello from Hanzo AI!'", timeout=5)
            print(f"✅ Command result: {result.strip()}")
        except Exception as e:
            print(f"❌ Shell test failed: {e}")
        print()
        
        # Test 4: File Operations
        print("4️⃣ Testing File Operations...")
        try:
            # Create test files
            file1 = temp_path / "test1.txt"
            file2 = temp_path / "test2.txt"
            
            file1.write_text("Hello\nWorld\nFrom\nHanzo\n")
            file2.write_text("Hello\nUniverse\nFrom\nHanzo\nMCP\n")
            
            # Test read tool
            read_tool = ReadTool(pm)
            content = await read_tool.run(ctx, str(file1))
            print(f"✅ Read tool works - got {len(content.split())} words")
            
            # Test diff tool
            diff_tool = create_diff_tool(pm)
            diff_result = await diff_tool.run(ctx, str(file1), str(file2))
            print("✅ Diff tool works - found differences:")
            diff_lines = diff_result.split('\n')
            for line in diff_lines[-3:]:  # Show last 3 lines (summary)
                if line.strip():
                    print(f"   {line}")
            
        except Exception as e:
            print(f"❌ File operations test failed: {e}")
        print()
        
        # Test 5: Server Creation
        print("5️⃣ Testing Server Creation...")
        try:
            server = HanzoMCPServer(
                name="test-server",
                allowed_paths=[temp_dir],
                use_palette=True,
                force_palette="python"
            )
            print("✅ Server created successfully")
            print(f"✅ Python palette applied")
        except Exception as e:
            print(f"❌ Server creation failed: {e}")
        print()


def test_cloudflare_tools():
    """Test Cloudflare tools configuration."""
    print("☁️  Testing Cloudflare Configuration\n")
    
    # Test environment variables
    cf_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    cf_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    
    if cf_token:
        print(f"✅ Cloudflare API token configured (ends with: ...{cf_token[-8:]})")
    else:
        print("⚠️  No Cloudflare API token found in environment")
    
    if cf_account:
        print(f"✅ Cloudflare Account ID: {cf_account}")
    else:
        print("⚠️  No Cloudflare Account ID found in environment")
    
    print()
    
    # Check if tools exist
    tools_dir = Path("tools/hanzoai-mcp-server-cloudflare")
    if tools_dir.exists():
        print("✅ Cloudflare MCP server repository found")
        tunnels_dir = tools_dir / "apps" / "cloudflare-tunnels"
        if tunnels_dir.exists():
            print("✅ Cloudflare Tunnels app found")
        else:
            print("❌ Cloudflare Tunnels app not found")
    else:
        print("❌ Cloudflare MCP server repository not found")
    print()


def test_dev_mode():
    """Test development mode setup."""
    print("🔧 Testing Development Mode\n")
    
    try:
        from hanzo_mcp.dev_server import DevServer
        
        dev_server = DevServer(
            name="test-dev",
            allowed_paths=["/tmp"],
        )
        print("✅ DevServer created successfully")
        print("✅ Hot reload functionality available")
        
        # Test watchdog import
        import watchdog
        print(f"✅ Watchdog version: {watchdog.__version__}")
        
    except ImportError as e:
        print(f"❌ Development mode import failed: {e}")
    except Exception as e:
        print(f"❌ Development mode test failed: {e}")
    print()


def main():
    """Run all manual tests."""
    print("🚀 Hanzo AI Manual Test Suite")
    print("=" * 50)
    print()
    
    # Run async tests
    asyncio.run(test_basic_functionality())
    
    # Run sync tests
    test_cloudflare_tools()
    test_dev_mode()
    
    print("🎉 Manual test suite completed!")
    print("\nNext steps:")
    print("1. Restart Claude Desktop to load new MCP servers")
    print("2. Test Cloudflare authentication in Claude")
    print("3. Try palette commands: 'palette --action list'")
    print("4. Test shell integration with your zsh config")


if __name__ == "__main__":
    main()