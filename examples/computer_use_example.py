#!/usr/bin/env python
"""Example of using the MCP computer use interface.

This script demonstrates how to use the MCP computer use interface to interact
with the computer-use MCP server, which provides full computer access capabilities.

Usage:
    python computer_use_example.py

Requirements:
    - Hanzo MCP should be installed
    - The computer-use server should be available and configured
"""

import os
import asyncio
import argparse
import logging
from typing import Dict, Any

from hanzo_mcp.tools.computer_use import (
    ComputerUseInterface,
    get_computer_capabilities,
    open_application,
    take_screenshot,
    file_explorer,
    clipboard_get,
    clipboard_set,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def list_capabilities():
    """List the computer's capabilities."""
    logger.info("Getting computer capabilities...")
    capabilities = await get_computer_capabilities()
    
    if not capabilities["available"]:
        logger.warning(capabilities["message"])
        return
        
    logger.info(f"Computer use is available: {capabilities['available']}")
    logger.info(f"Computer use is running: {capabilities['running']}")
    logger.info(f"Available tools: {len(capabilities['tools'])}")
    
    for i, tool in enumerate(capabilities["tools"], 1):
        logger.info(f"{i}. {tool['name']}")


async def open_app(app_name: str):
    """Open an application.
    
    Args:
        app_name: Name of the application to open
    """
    logger.info(f"Opening application: {app_name}")
    result = await open_application(app_name)
    
    if result["success"]:
        logger.info(f"Successfully opened {app_name}")
    else:
        logger.error(f"Failed to open {app_name}: {result.get('error', 'Unknown error')}")


async def capture_screenshot(output_path: str):
    """Capture a screenshot and save it to the specified path.
    
    Args:
        output_path: Path to save the screenshot to
    """
    logger.info(f"Taking screenshot and saving to: {output_path}")
    result = await take_screenshot()
    
    if result["success"]:
        screenshot_path = result.get("path")
        if screenshot_path:
            # Copy the screenshot to the specified path
            os.rename(screenshot_path, output_path)
            logger.info(f"Screenshot saved to: {output_path}")
        else:
            logger.warning("Screenshot was taken but path was not returned")
    else:
        logger.error(f"Failed to take screenshot: {result.get('error', 'Unknown error')}")


async def explore_files(path: str):
    """Open the file explorer at the specified path.
    
    Args:
        path: Path to explore
    """
    logger.info(f"Opening file explorer at: {path}")
    result = await file_explorer(path)
    
    if result["success"]:
        logger.info(f"Successfully opened file explorer at {path}")
    else:
        logger.error(f"Failed to open file explorer: {result.get('error', 'Unknown error')}")


async def get_clipboard():
    """Get the current clipboard contents."""
    logger.info("Getting clipboard contents...")
    result = await clipboard_get()
    
    if result["success"]:
        text = result.get("text", "")
        logger.info(f"Clipboard contents: {text}")
        return text
    else:
        logger.error(f"Failed to get clipboard: {result.get('error', 'Unknown error')}")
        return None


async def set_clipboard(text: str):
    """Set the clipboard contents.
    
    Args:
        text: Text to set in the clipboard
    """
    logger.info(f"Setting clipboard contents to: {text}")
    result = await clipboard_set(text)
    
    if result["success"]:
        logger.info("Successfully set clipboard contents")
    else:
        logger.error(f"Failed to set clipboard: {result.get('error', 'Unknown error')}")


async def computer_use_workflow():
    """Demonstrate a complete workflow using the computer use interface."""
    # First, check if computer use is available
    capabilities = await get_computer_capabilities()
    if not capabilities["available"]:
        logger.error("Computer use is not available on this system")
        return
        
    # 1. Open a text editor
    await open_app("notepad")  # On Windows
    # For macOS, use "TextEdit"
    # For Linux, use "gedit" or another text editor
    
    # 2. Wait for the app to open
    await asyncio.sleep(2)
    
    # 3. Set the clipboard with some text
    await set_clipboard("Hello from MCP computer-use example!")
    
    # 4. Verify the clipboard contents
    clipboard_text = await get_clipboard()
    logger.info(f"Current clipboard text: {clipboard_text}")
    
    # 5. Take a screenshot
    await capture_screenshot("mcp_screenshot.png")
    
    # 6. Open file explorer to the current directory
    current_dir = os.path.abspath(os.path.dirname(__file__))
    await explore_files(current_dir)
    
    logger.info("Workflow completed successfully!")


async def main():
    """Main function for the example script."""
    parser = argparse.ArgumentParser(description="MCP Computer Use Example")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # List capabilities
    subparsers.add_parser("list", help="List computer capabilities")
    
    # Open application
    app_parser = subparsers.add_parser("open-app", help="Open an application")
    app_parser.add_argument("app_name", help="Name of the application to open")
    
    # Take screenshot
    screenshot_parser = subparsers.add_parser("screenshot", help="Take a screenshot")
    screenshot_parser.add_argument("--output", "-o", default="screenshot.png", help="Output path for the screenshot")
    
    # File explorer
    explorer_parser = subparsers.add_parser("explorer", help="Open file explorer")
    explorer_parser.add_argument("path", nargs="?", default=".", help="Path to explore")
    
    # Clipboard
    clipboard_parser = subparsers.add_parser("clipboard", help="Get or set clipboard")
    clipboard_parser.add_argument("--set", "-s", help="Text to set in the clipboard")
    
    # Workflow
    subparsers.add_parser("workflow", help="Run a complete workflow demonstration")
    
    args = parser.parse_args()
    
    if args.command == "list" or not args.command:
        await list_capabilities()
    elif args.command == "open-app":
        await open_app(args.app_name)
    elif args.command == "screenshot":
        await capture_screenshot(args.output)
    elif args.command == "explorer":
        path = os.path.abspath(args.path)
        await explore_files(path)
    elif args.command == "clipboard":
        if args.set:
            await set_clipboard(args.set)
        else:
            await get_clipboard()
    elif args.command == "workflow":
        await computer_use_workflow()
    else:
        parser.print_help()
        

if __name__ == "__main__":
    asyncio.run(main())
