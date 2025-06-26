#!/usr/bin/env python3
"""Test palette functionality in current environment."""

from hanzo_mcp.tools.config.palette_tool import palette_tool

async def test_palette():
    """Test palette commands."""
    print("🎨 Testing Palette System\n")
    
    # Test listing palettes
    print("1. Listing all palettes:")
    result = await palette_tool.run(None, action="list")
    print(result)
    print()
    
    # Test showing Python palette
    print("2. Showing Python palette details:")
    result = await palette_tool.run(None, action="show", name="python")
    print(result)
    print()
    
    # Test activating Python palette
    print("3. Activating Python palette:")
    result = await palette_tool.run(None, action="activate", name="python")
    print(result)
    print()
    
    # Test showing current palette
    print("4. Current active palette:")
    result = await palette_tool.run(None, action="current")
    print(result)

if __name__ == "__main__":
    import asyncio
    asyncio.run(test_palette())