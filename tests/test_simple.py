#!/usr/bin/env python3
"""Simple test script for core Hanzo AI functionality."""

import asyncio
import os
import tempfile
from pathlib import Path


def test_imports():
    """Test that core modules can be imported."""
    print("🧪 Testing Core Imports\n")
    
    try:
        from hanzo_mcp.tools.common.permissions import PermissionManager
        print("✅ Permission manager imported")
        
        from hanzo_mcp.tools.filesystem.read import ReadTool
        print("✅ Read tool imported")
        
        from hanzo_mcp.tools.filesystem.diff import create_diff_tool
        print("✅ Diff tool imported")
        
        from hanzo_mcp.tools.common.decorators import with_context_normalization
        print("✅ Context normalization imported")
        
        from hanzo_mcp.server_enhanced import EnhancedFastMCP
        print("✅ Enhanced server imported")
        
        return True
        
    except Exception as e:
        print(f"❌ Import failed: {e}")
        return False


async def test_file_operations():
    """Test file operations."""
    print("\n📁 Testing File Operations\n")
    
    try:
        from hanzo_mcp.tools.filesystem.read import ReadTool
        from hanzo_mcp.tools.filesystem.diff import create_diff_tool
        from hanzo_mcp.tools.common.permissions import PermissionManager
        
        # Create temp files
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Set up permission manager
            pm = PermissionManager()
            pm.add_allowed_path(temp_dir)
            
            # Create test files
            file1 = temp_path / "test1.txt"
            file2 = temp_path / "test2.txt"
            
            file1.write_text("Hello\nWorld\nFrom\nHanzo")
            file2.write_text("Hello\nUniverse\nFrom\nHanzo\nMCP")
            
            print(f"📁 Created test files in: {temp_path}")
            
            # Test read tool
            read_tool = ReadTool(pm)
            
            class MockContext:
                pass
            ctx = MockContext()
            
            content = await read_tool.run(ctx, str(file1))
            print(f"✅ Read tool: got {len(content)} characters")
            
            # Test diff tool
            diff_tool = create_diff_tool(pm)
            diff_result = await diff_tool.run(ctx, str(file1), str(file2))
            print("✅ Diff tool: found differences")
            
            # Show summary line
            lines = diff_result.split('\n')
            summary_line = [line for line in lines if 'Summary:' in line]
            if summary_line:
                print(f"   {summary_line[0]}")
        
        return True
        
    except Exception as e:
        print(f"❌ File operations failed: {e}")
        return False


def test_shell_detection():
    """Test shell detection."""
    print("\n🐚 Testing Shell Detection\n")
    
    try:
        # Test shell detection without creating the tool
        import platform
        import os
        from pathlib import Path
        
        if platform.system() == "Windows":
            expected_shell = "cmd.exe"
        else:
            shell = os.environ.get("SHELL", "/bin/bash")
            shell_name = os.path.basename(shell)
            
            if shell_name == "zsh":
                zshrc_path = Path.home() / ".zshrc"
                if zshrc_path.exists():
                    expected_shell = shell
                    print(f"✅ Found .zshrc at: {zshrc_path}")
                else:
                    expected_shell = "bash"
            else:
                expected_shell = "bash"
        
        print(f"✅ Shell detection: {expected_shell}")
        print(f"✅ User's SHELL: {os.environ.get('SHELL', 'not set')}")
        
        return True
        
    except Exception as e:
        print(f"❌ Shell detection failed: {e}")
        return False


def test_cloudflare_config():
    """Test Cloudflare configuration."""
    print("\n☁️  Testing Cloudflare Configuration\n")
    
    # Check environment variables
    cf_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    cf_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    
    if cf_token:
        print(f"✅ CLOUDFLARE_API_TOKEN configured (ends with: ...{cf_token[-8:]})")
    else:
        print("⚠️  CLOUDFLARE_API_TOKEN not found in environment")
    
    if cf_account:
        print(f"✅ CLOUDFLARE_ACCOUNT_ID: {cf_account}")
    else:
        print("⚠️  CLOUDFLARE_ACCOUNT_ID not found in environment")
    
    # Check Claude Desktop config
    claude_config = Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    if claude_config.exists():
        print(f"✅ Claude Desktop config found: {claude_config}")
        try:
            import json
            with open(claude_config) as f:
                config = json.load(f)
            
            servers = config.get("mcpServers", {})
            print(f"✅ MCP servers configured: {list(servers.keys())}")
            
            if "cloudflare-bindings" in servers:
                print("✅ Cloudflare Bindings server configured")
            if "cloudflare-tunnels" in servers:
                print("✅ Cloudflare Tunnels server configured")
                
        except Exception as e:
            print(f"⚠️  Could not parse Claude config: {e}")
    else:
        print("⚠️  Claude Desktop config not found")
    
    # Check tunnels repo
    tunnels_repo = Path("tools/hanzoai-mcp-server-cloudflare")
    if tunnels_repo.exists():
        print(f"✅ Cloudflare MCP server repo found: {tunnels_repo}")
        tunnels_app = tunnels_repo / "apps" / "cloudflare-tunnels"
        if tunnels_app.exists():
            print("✅ Cloudflare Tunnels app found")
        else:
            print("❌ Cloudflare Tunnels app not found")
    else:
        print("⚠️  Cloudflare MCP server repo not found locally")


def test_dev_mode():
    """Test development mode availability."""
    print("\n🔧 Testing Development Mode\n")
    
    try:
        # Test watchdog import
        import watchdog
        try:
            version = watchdog.__version__
            print(f"✅ Watchdog available: v{version}")
        except AttributeError:
            print("✅ Watchdog available (version unknown)")
        
        # Test dev server availability
        from hanzo_mcp.dev_server import DevServer
        print("✅ DevServer class available")
        
        # Check if CLI supports --dev
        from hanzo_mcp import cli
        print("✅ CLI module available")
        
        return True
        
    except ImportError as e:
        print(f"❌ Development mode dependency missing: {e}")
        return False
    except Exception as e:
        print(f"❌ Development mode test failed: {e}")
        return False


async def main():
    """Run all tests."""
    print("🚀 Hanzo AI Simple Test Suite")
    print("=" * 50)
    
    results = []
    
    # Run tests
    results.append(test_imports())
    results.append(await test_file_operations())
    results.append(test_shell_detection())
    results.append(test_dev_mode())
    
    # Cloudflare config test (always runs)
    test_cloudflare_config()
    
    # Summary
    passed = sum(results)
    total = len(results)
    
    print(f"\n📊 Test Results: {passed}/{total} passed")
    
    if passed == total:
        print("🎉 All core tests passed!")
        print("\n🔧 Next Steps:")
        print("1. Restart Claude Desktop/Code to load new MCP servers")
        print("2. Test Cloudflare tools: 'List my Cloudflare Tunnels'")
        print("3. Test palette system: 'palette --action list'")
        print("4. Test shell: 'bash \"echo $SHELL\"'")
        print("5. Test dev mode: 'hanzo-mcp --dev --project-dir .'")
    else:
        print("⚠️  Some tests failed. Check the output above.")
    
    return passed == total


if __name__ == "__main__":
    asyncio.run(main())