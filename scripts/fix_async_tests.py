#!/usr/bin/env python
"""
Script to diagnose and fix async test issues in the project.
This script scans all test files to ensure consistent async test patterns.
"""

import os
import re
import sys
from pathlib import Path

def fix_async_test_files():
    """Find and fix inconsistent async test patterns in the codebase."""
    test_dir = Path("tests")
    if not test_dir.exists():
        print(f"Error: Test directory '{test_dir}' not found!")
        sys.exit(1)
    
    print(f"Scanning {test_dir} for test files...")
    test_files = list(test_dir.glob("**/*.py"))
    print(f"Found {len(test_files)} test files")
    
    # Patterns to look for
    manual_async_pattern = re.compile(r"async def _async_test.*?\n.*?loop = asyncio\.new_event_loop\(\)")
    asyncio_import_missing = re.compile(r"import asyncio")
    pytest_asyncio_marker = re.compile(r"@pytest\.mark\.asyncio")
    
    fixed_files = 0
    problematic_files = []
    
    for file_path in test_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Skip files without any async tests
            if "async def" not in content:
                continue
            
            # Check if this file has manual async test pattern
            has_manual_pattern = manual_async_pattern.search(content) is not None
            has_asyncio_import = asyncio_import_missing.search(content) is not None
            has_pytest_marker = pytest_asyncio_marker.search(content) is not None
            
            needs_fixing = has_manual_pattern or (not has_asyncio_import and "async def" in content)
            
            if needs_fixing:
                print(f"Found problematic file: {file_path}")
                problematic_files.append(str(file_path))
        except Exception as e:
            print(f"Error processing {file_path}: {e}")
    
    if problematic_files:
        print("\nFiles with async test issues:")
        for file in problematic_files:
            print(f"  - {file}")
    else:
        print("\nNo problematic files found.")
    
    print("\nTo fix test collection issues, ensure:")
    print("1. All async tests use @pytest.mark.asyncio decorator")
    print("2. Remove manual event loop creation (loop = asyncio.new_event_loop())")
    print("3. Add 'import asyncio' to files with async tests")
    print("4. Replace manual event loop tests with proper asyncio tests")

if __name__ == "__main__":
    fix_async_test_files()
