#!/usr/bin/env python3
"""Example script demonstrating browser automation with MCP.

This script shows how to use the MCP browser-use interface to automate
common browser operations.

To run this example:
    python browser_use_example.py [command] [args...]

Available commands:
    info        - Show information about available browser automation tools
    navigate    - Navigate to a URL
    screenshot  - Take a screenshot of the current page
    content     - Get the HTML content of the current page
    click       - Click an element with the specified CSS selector
    fill        - Fill a form field with a value
    demo        - Run a complete automation demo
"""

import os
import sys
import json
import asyncio
import argparse
import tempfile
from pathlib import Path

# Add the parent directory to the Python path to allow importing from hanzo_mcp
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hanzo_mcp.tools.browser_use import (
    get_browser_capabilities,
    navigate_to,
    take_screenshot,
    get_page_content,
    click_element,
    fill_form
)


async def show_info():
    """Show information about available browser automation tools."""
    print("Getting browser automation capabilities...")
    result = await get_browser_capabilities()
    
    if not result["available"]:
        print(f"Browser automation is not available: {result.get('message', 'Unknown error')}")
        return
    
    print(f"Browser automation is {'running' if result['running'] else 'not running'}")
    print(f"Available tools ({len(result['tools'])}):")
    
    for tool in result["tools"]:
        print(f"- {tool['name']}")
        if "definition" in tool and "params" in tool["definition"]:
            params = tool["definition"]["params"]
            if params:
                print("  Parameters:")
                for param_name, param_type in params.items():
                    print(f"    {param_name}: {param_type}")


async def browser_navigate(url):
    """Navigate to a URL in the browser.
    
    Args:
        url (str): The URL to navigate to
    """
    print(f"Navigating to {url}...")
    result = await navigate_to(url)
    
    if result["success"]:
        print(f"Successfully navigated to {url}")
    else:
        print(f"Failed to navigate: {result.get('error', 'Unknown error')}")


async def browser_screenshot(output_path=None):
    """Take a screenshot of the current browser window.
    
    Args:
        output_path (str, optional): The path to save the screenshot to.
            If not provided, a temporary file will be used.
    """
    print("Taking screenshot...")
    result = await take_screenshot()
    
    if result["success"]:
        screenshot_path = result.get("path")
        
        if output_path and screenshot_path:
            # If output_path is provided, copy the screenshot there
            import shutil
            shutil.copy(screenshot_path, output_path)
            print(f"Screenshot saved to {output_path}")
        else:
            print(f"Screenshot taken: {screenshot_path}")
    else:
        print(f"Failed to take screenshot: {result.get('error', 'Unknown error')}")


async def browser_content(output_path=None):
    """Get the HTML content of the current page.
    
    Args:
        output_path (str, optional): The path to save the HTML content to.
            If not provided, the content is printed to the console.
    """
    print("Getting page content...")
    result = await get_page_content()
    
    if result["success"]:
        content = result.get("content", "")
        
        if output_path:
            with open(output_path, "w") as f:
                f.write(content)
            print(f"Page content saved to {output_path}")
        else:
            # Print just the first few lines
            content_preview = "\n".join(content.split("\n")[:10])
            print(f"Page content (first 10 lines):\n{content_preview}...")
            print(f"Total content length: {len(content)} characters")
    else:
        print(f"Failed to get page content: {result.get('error', 'Unknown error')}")


async def browser_click(selector):
    """Click an element on the page.
    
    Args:
        selector (str): The CSS selector for the element to click
    """
    print(f"Clicking element with selector: {selector}")
    result = await click_element(selector)
    
    if result["success"]:
        print(f"Successfully clicked element: {selector}")
    else:
        print(f"Failed to click element: {result.get('error', 'Unknown error')}")


async def browser_fill(selector, value):
    """Fill a form field with a value.
    
    Args:
        selector (str): The CSS selector for the form field
        value (str): The value to enter into the form field
    """
    print(f"Filling element {selector} with value: {value}")
    result = await fill_form(selector, value)
    
    if result["success"]:
        print(f"Successfully filled form field: {selector}")
    else:
        print(f"Failed to fill form field: {result.get('error', 'Unknown error')}")


async def run_demo():
    """Run a complete browser automation demo.
    
    This demo:
    1. Navigates to a search engine
    2. Enters a search term
    3. Clicks the search button
    4. Takes a screenshot of the results
    5. Gets the HTML content of the results page
    """
    print("Running browser automation demo...")
    
    # Check if browser automation is available
    capabilities = await get_browser_capabilities()
    if not capabilities["available"]:
        print(f"Browser automation is not available: {capabilities.get('message', 'Unknown error')}")
        return
    
    # Navigate to a search engine
    print("\n1. Navigating to search engine...")
    result = await navigate_to("https://duckduckgo.com")
    if not result["success"]:
        print(f"Failed to navigate: {result.get('error', 'Unknown error')}")
        return
    print("✓ Navigation successful")
    
    # Wait a moment for the page to load
    await asyncio.sleep(1)
    
    # Fill the search form
    print("\n2. Entering search term...")
    result = await fill_form("#searchbox_input", "Python Browser Automation")
    if not result["success"]:
        print(f"Failed to fill search box: {result.get('error', 'Unknown error')}")
        return
    print("✓ Search term entered")
    
    # Wait a moment before clicking
    await asyncio.sleep(0.5)
    
    # Click the search button
    print("\n3. Clicking search button...")
    result = await click_element("button[type='submit']")
    if not result["success"]:
        print(f"Failed to click search button: {result.get('error', 'Unknown error')}")
        return
    print("✓ Search button clicked")
    
    # Wait for results to load
    await asyncio.sleep(2)
    
    # Take a screenshot of the results
    print("\n4. Taking screenshot of results...")
    screenshot_file = os.path.join(tempfile.gettempdir(), "search_results.png")
    result = await take_screenshot()
    if not result["success"]:
        print(f"Failed to take screenshot: {result.get('error', 'Unknown error')}")
    else:
        screenshot_path = result.get("path")
        if screenshot_path:
            # Copy to our preferred location
            import shutil
            shutil.copy(screenshot_path, screenshot_file)
            print(f"✓ Screenshot saved to {screenshot_file}")
    
    # Get the HTML content
    print("\n5. Getting page content...")
    content_file = os.path.join(tempfile.gettempdir(), "search_results.html")
    result = await get_page_content()
    if not result["success"]:
        print(f"Failed to get page content: {result.get('error', 'Unknown error')}")
    else:
        content = result.get("content", "")
        with open(content_file, "w") as f:
            f.write(content)
        print(f"✓ Page content saved to {content_file}")
        print(f"  Content length: {len(content)} characters")
    
    print("\nDemo completed successfully!")
    print(f"Screenshot: {screenshot_file}")
    print(f"HTML Content: {content_file}")


async def main():
    """Main entry point for the browser automation example."""
    parser = argparse.ArgumentParser(description="MCP Browser Automation Example")
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")
    
    # info command
    subparsers.add_parser("info", help="Show browser automation capabilities")
    
    # navigate command
    navigate_parser = subparsers.add_parser("navigate", help="Navigate to a URL")
    navigate_parser.add_argument("url", help="The URL to navigate to")
    
    # screenshot command
    screenshot_parser = subparsers.add_parser("screenshot", help="Take a screenshot")
    screenshot_parser.add_argument("--output", "-o", help="Output path for the screenshot")
    
    # content command
    content_parser = subparsers.add_parser("content", help="Get page content")
    content_parser.add_argument("--output", "-o", help="Output path for the HTML content")
    
    # click command
    click_parser = subparsers.add_parser("click", help="Click an element")
    click_parser.add_argument("selector", help="CSS selector for the element to click")
    
    # fill command
    fill_parser = subparsers.add_parser("fill", help="Fill a form field")
    fill_parser.add_argument("selector", help="CSS selector for the form field")
    fill_parser.add_argument("value", help="Value to enter into the form field")
    
    # demo command
    subparsers.add_parser("demo", help="Run a complete demo")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    if args.command == "info":
        await show_info()
    elif args.command == "navigate":
        await browser_navigate(args.url)
    elif args.command == "screenshot":
        await browser_screenshot(args.output)
    elif args.command == "content":
        await browser_content(args.output)
    elif args.command == "click":
        await browser_click(args.selector)
    elif args.command == "fill":
        await browser_fill(args.selector, args.value)
    elif args.command == "demo":
        await run_demo()


if __name__ == "__main__":
    asyncio.run(main())
