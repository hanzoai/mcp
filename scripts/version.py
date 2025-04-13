#!/usr/bin/env python3
"""
Simple script to display the version of hanzo-mcp.
Can be run directly or through the installed package.
"""

import sys
from hanzo_mcp import __version__

if __name__ == "__main__":
    print(f"hanzo-mcp {__version__}")
    sys.exit(0)
