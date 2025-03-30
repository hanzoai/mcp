#!/usr/bin/env python3
"""Example script demonstrating how to use hanzo-code from Python.

This script shows how to call the hanzo-code CLI tool from Python
using subprocess to implement a simple AI-assisted development workflow.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union


class HanzoCodeClient:
    """Python client for the hanzo-code CLI tool."""
    
    def __init__(self, project_dir: str, verbose: bool = False):
        """Initialize the client.
        
        Args:
            project_dir: Path to the project directory
            verbose: Whether to enable verbose output
        """
        self.project_dir = os.path.abspath(project_dir)
        self.verbose = verbose
        
        # Check if project directory exists
        if not os.path.isdir(self.project_dir):
            raise ValueError(f"Project directory does not exist: {self.project_dir}")
    
    def execute(self, operation: str, **kwargs) -> Dict[str, Any]:
        """Execute a hanzo-dev operation.
        
        Args:
            operation: The operation to execute
            **kwargs: Arguments for the operation
            
        Returns:
            Operation result as a dictionary
        """
        # Build command
        cmd = ["hanzo-code", "--project-dir", self.project_dir]
        
        if self.verbose:
            cmd.append("--verbose")
            
        cmd.append(operation)
        
        # Add operation arguments
        for key, value in kwargs.items():
            arg_key = key.replace("_", "-")
            
            if isinstance(value, bool):
                if value:
                    cmd.append(f"--{arg_key}")
            elif isinstance(value, list):
                cmd.append(f"--{arg_key}")
                cmd.extend([str(item) for item in value])
            elif isinstance(value, dict):
                cmd.append(f"--{arg_key}")
                cmd.append(json.dumps(value))
            else:
                cmd.append(f"--{arg_key}")
                cmd.append(str(value))
        
        # Run command
        try:
            if self.verbose:
                print(f"Running command: {' '.join(cmd)}")
                
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
        except subprocess.CalledProcessError as e:
            if self.verbose:
                print(f"Error executing operation: {e}")
                print(f"Stdout: {e.stdout}")
                print(f"Stderr: {e.stderr}")
                
            try:
                return json.loads(e.stdout)
            except json.JSONDecodeError:
                return {"success": False, "error": f"Error executing operation: {e}"}
        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Error parsing result: {e}"}
    
    def analyze_project(self) -> Dict[str, Any]:
        """Analyze the project.
        
        Returns:
            Project analysis result
        """
        return self.execute("analyze_project", project_dir=self.project_dir)
    
    def read_file(self, path: str) -> Dict[str, Any]:
        """Read a file.
        
        Args:
            path: Path to the file to read
            
        Returns:
            File content
        """
        return self.execute("read", paths=[path])
    
    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        """Write to a file.
        
        Args:
            path: Path to the file to write
            content: Content to write
            
        Returns:
            Write result
        """
        return self.execute("write", path=path, content=content)
    
    def directory_tree(self, path: str, depth: int = 3) -> Dict[str, Any]:
        """Get a directory tree.
        
        Args:
            path: Path to the directory
            depth: Maximum depth
            
        Returns:
            Directory tree
        """
        return self.execute("directory_tree", path=path, depth=depth)
    
    def search_content(self, pattern: str, path: str, file_pattern: str = "*") -> Dict[str, Any]:
        """Search for content in files.
        
        Args:
            pattern: Pattern to search for
            path: Path to search in
            file_pattern: File pattern to match
            
        Returns:
            Search results
        """
        return self.execute("search_content", pattern=pattern, path=path, file_pattern=file_pattern)
    
    def run_command(self, command: str, cwd: str) -> Dict[str, Any]:
        """Run a shell command.
        
        Args:
            command: Command to run
            cwd: Working directory
            
        Returns:
            Command result
        """
        return self.execute("run_command", command=command, cwd=cwd)
    
    def llm_read(self) -> Dict[str, Any]:
        """Read LLM.md content.
        
        Returns:
            LLM.md content
        """
        return self.execute("llm_read", project_dir=self.project_dir)
    
    def llm_update(self, content: str) -> Dict[str, Any]:
        """Update LLM.md content.
        
        Args:
            content: New content
            
        Returns:
            Update result
        """
        return self.execute("llm_update", content=content)
    
    def llm_append(self, section: str, content: str) -> Dict[str, Any]:
        """Append a section to LLM.md.
        
        Args:
            section: Section title
            content: Section content
            
        Returns:
            Append result
        """
        return self.execute("llm_append", section=section, content=content)


def main():
    """Main entry point for the example script."""
    parser = argparse.ArgumentParser(
        description="Example script for hanzo-code client",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        "--project-dir",
        required=True,
        help="Path to the project directory"
    )
    
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Enable verbose output"
    )
    
    parser.add_argument(
        "--run-demo",
        action="store_true",
        default=False,
        help="Run a demo of common operations"
    )
    
    args = parser.parse_args()
    
    try:
        # Initialize client
        client = HanzoCodeClient(args.project_dir, args.verbose)
        
        if args.run_demo:
            # Run a demo of common operations
            print("\n=== Running hanzo-code demo ===")
            
            # 1. Analyze project
            print("\n1. Analyzing project...")
            result = client.analyze_project()
            if result.get("success", False):
                print(f"Project analysis successful! Found {len(result.get('data', {}).get('files', []))} files")
            else:
                print(f"Project analysis failed: {result.get('error')}")
            
            # 2. Get directory tree
            print("\n2. Getting directory tree...")
            result = client.directory_tree(args.project_dir, depth=2)
            if result.get("success", False):
                print(f"Directory tree:\n{result.get('data', {}).get('tree', '')}")
            else:
                print(f"Directory tree failed: {result.get('error')}")
            
            # 3. Search for TODO comments
            print("\n3. Searching for TODO comments...")
            result = client.search_content("TODO", args.project_dir, "*.py")
            if result.get("success", False):
                matches = result.get('data', {}).get('matches', [])
                print(f"Found {len(matches)} TODO comments")
                for i, match in enumerate(matches[:3], 1):
                    print(f"  {i}. {match.get('file')}:{match.get('line')}: {match.get('content')}")
                if len(matches) > 3:
                    print(f"  ... and {len(matches) - 3} more")
            else:
                print(f"Search failed: {result.get('error')}")
            
            # 4. Read LLM.md if it exists
            print("\n4. Reading LLM.md...")
            result = client.llm_read()
            if result.get("success", False):
                content = result.get('data', {}).get('content', '')
                lines = content.split('\n')
                print(f"LLM.md has {len(lines)} lines")
                print(f"First 3 lines:\n{'\n'.join(lines[:3])}\n...")
            else:
                print(f"LLM.md read failed: {result.get('error')}")
            
            # 5. Run a simple command
            print("\n5. Running a simple command...")
            result = client.run_command("ls -la", args.project_dir)
            if result.get("success", False):
                output = result.get('data', {}).get('output', '')
                lines = output.split('\n')
                print(f"Command output ({len(lines)} lines):\n{'\n'.join(lines[:5])}\n...")
            else:
                print(f"Command execution failed: {result.get('error')}")
            
            print("\n=== Demo complete ===\n")
        else:
            # Show basic usage if not running demo
            print("Initialize HanzoCodeClient with:")
            print(f"  client = HanzoCodeClient('{args.project_dir}')")
            print("\nAvailable methods:")
            methods = [
                "analyze_project()", 
                "read_file(path)", 
                "write_file(path, content)",
                "directory_tree(path, depth=3)",
                "search_content(pattern, path, file_pattern='*')",
                "run_command(command, cwd)",
                "llm_read()",
                "llm_update(content)",
                "llm_append(section, content)"
            ]
            for method in methods:
                print(f"  client.{method}")
            
            print("\nRun with --run-demo to see examples")
    
    except Exception as e:
        print(f"Error: {e}")
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
