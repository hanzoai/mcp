"""Script execution system for the MCP Claude Code server."""

import asyncio
import json
import os
import tempfile
from typing import Any, final

from mcp_claude_code.tools.shell.command_executor import CommandExecutor, CommandResult


@final
class ScriptExecutor:
    """Executes scripts in various languages with proper sandboxing."""
    
    def __init__(self, permission_manager: PermissionManager) -> None:
        """Initialize the script executor.
        
        Args:
            permission_manager: The permission manager for checking permissions
        """
        self.permission_manager: PermissionManager = permission_manager
        
        # Map of supported languages to their interpreters/compilers
        self.language_map: dict[str, dict[str, str]] = {
            "python": {
                "command": "python",
                "file_extension": ".py",
                "comment_prefix": "#",
            },
            "javascript": {
                "command": "node",
                "file_extension": ".js",
                "comment_prefix": "//",
            },
            "typescript": {
                "command": "ts-node",
                "file_extension": ".ts",
                "comment_prefix": "//",
            },
            "bash": {
                "command": "bash",
                "file_extension": ".sh",
                "comment_prefix": "#",
            },
            "ruby": {
                "command": "ruby",
                "file_extension": ".rb",
                "comment_prefix": "#",
            },
            "php": {
                "command": "php",
                "file_extension": ".php",
                "comment_prefix": "//",
            },
            "perl": {
                "command": "perl",
                "file_extension": ".pl",
                "comment_prefix": "#",
            },
            "r": {
                "command": "Rscript",
                "file_extension": ".R",
                "comment_prefix": "#",
            },
        }
    
    def get_available_languages(self) -> list[str]:
        """Get a list of available script languages.
        
        Returns:
            List of supported language names
        """
        return list(self.language_map.keys())
    
    async def is_language_installed(self, language: str) -> bool:
        """Check if the required interpreter/compiler is installed.
        
        Args:
            language: The language to check
            
        Returns:
            True if the language is supported and installed, False otherwise
        """
        if language not in self.language_map:
            return False
        
        command: str = self.language_map[language]["command"]
        
        try:
            # Try to execute the command with --version or -v
            process = await asyncio.create_subprocess_exec(
                command, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            _ = await process.communicate()
            return process.returncode == 0
        except Exception:
            try:
                # Some commands use -v instead
                process = await asyncio.create_subprocess_exec(
                    command, "-v",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                _ = await process.communicate()
                return process.returncode == 0
            except Exception:
                return False
    
    async def execute_script(
        self,
        language: str,
        script: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = 60.0,
        args: list[str] | None = None,
    ) -> tuple[int, str, str]:
        """Execute a script in the specified language.
        
        Args:
            language: The programming language to use
            script: The script content to execute
            cwd: Optional working directory
            env: Optional environment variables
            timeout: Optional timeout in seconds
            args: Optional command-line arguments
            
        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check if language is supported
        if language not in self.language_map:
            return (
                1,
                "",
                f"Error: Unsupported language: {language}. Supported languages: {', '.join(self.language_map.keys())}"
            )
        
        # Check if working directory is allowed
        if cwd and not self.permission_manager.is_path_allowed(cwd):
            return (
                1,
                "",
                f"Error: Working directory not allowed: {cwd}"
            )
        
        # Set up environment
        script_env: dict[str, str] = os.environ.copy()
        if env:
            script_env.update(env)
        
        try:
            # Create a temporary file for the script
            language_info: dict[str, str] = self.language_map[language]
            file_extension: str = language_info["file_extension"]
            command: str = language_info["command"]
            
            with tempfile.NamedTemporaryFile(suffix=file_extension, mode='w', delete=False) as temp:
                temp_path: str = temp.name
                temp.write(script)
            
            try:
                # Build command arguments
                cmd_args: list[str] = [command, temp_path]
                if args:
                    cmd_args.extend(args)
                
                # Create and run the process
                process = await asyncio.create_subprocess_exec(
                    *cmd_args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=script_env
                )
                
                # Wait for the process to complete with timeout
                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(), 
                        timeout=timeout
                    )
                    
                    return (
                        process.returncode or 0,
                        stdout_bytes.decode('utf-8', errors='replace'),
                        stderr_bytes.decode('utf-8', errors='replace')
                    )
                except asyncio.TimeoutError:
                    # Kill the process if it times out
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass  # Process already terminated
                    
                    return (
                        -1, 
                        "", 
                        f"Error: Script execution timed out after {timeout} seconds"
                    )
            finally:
                # Clean up temporary file
                os.unlink(temp_path)
        except Exception as e:
            return (
                1, 
                "", 
                f"Error executing script: {str(e)}"
            )
    
    async def execute_script_inline(
        self,
        language: str,
        script: str,
        timeout: float | None = 60.0,
    ) -> tuple[int, str, str]:
        """Execute a script directly without creating a temporary file.
        
        This method is useful for short scripts that don't need file I/O.
        
        Args:
            language: The programming language to use
            script: The script content to execute
            timeout: Optional timeout in seconds
            
        Returns:
            A tuple of (return_code, stdout, stderr)
        """
        # Check if language is supported
        if language not in self.language_map:
            return (
                1,
                "",
                f"Error: Unsupported language: {language}. Supported languages: {', '.join(self.language_map.keys())}"
            )
        
        # Get language info
        language_info: dict[str, str] = self.language_map[language]
        command: str = language_info["command"]
        
        try:
            # Create and run the process
            process = await asyncio.create_subprocess_exec(
                command, "-c" if command == "python" else "-e",
                script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            # Wait for the process to complete with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=timeout
                )
                
                return (
                    process.returncode or 0,
                    stdout_bytes.decode('utf-8', errors='replace'),
                    stderr_bytes.decode('utf-8', errors='replace')
                )
            except asyncio.TimeoutError:
                # Kill the process if it times out
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # Process already terminated
                
                return (
                    -1, 
                    "", 
                    f"Error: Script execution timed out after {timeout} seconds"
                )
        except Exception as e:
            return (
                1, 
                "", 
                f"Error executing script: {str(e)}"
            )


@final
class ProjectAnalyzer:
    """Analyzes project structure and dependencies."""
    
    def __init__(self, command_executor: CommandExecutor) -> None:
        """Initialize the project analyzer.
        
        Args:
            command_executor: The command executor for running analysis scripts
        """
        self.command_executor: CommandExecutor = command_executor
    
    async def analyze_python_dependencies(self, project_dir: str) -> dict[str, Any]:
        """Analyze Python project dependencies.
        
        Args:
            project_dir: The project directory
            
        Returns:
            Dictionary of dependency information
        """
        script: str = """
import os
import sys
import json
import pkg_resources
from pathlib import Path

# Scan for requirements files
requirements_files = []
for root, _, files in os.walk('.'):
    for file in files:
        if file in ('requirements.txt', 'pyproject.toml', 'setup.py'):
            requirements_files.append(os.path.join(root, file))

# Get installed packages
installed_packages = {pkg.key: pkg.version for pkg in pkg_resources.working_set}

# Scan for import statements
imports = set()
for root, _, files in os.walk('.'):
    for file in files:
        if file.endswith('.py'):
            try:
                with open(os.path.join(root, file), 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith('import ') or line.startswith('from '):
                            parts = line.split()
                            if parts[0] == 'import':
                                imports.add(parts[1].split('.')[0])
                            elif parts[0] == 'from' and parts[1] != '.':
                                imports.add(parts[1].split('.')[0])
            except:
                pass  # Skip files that can't be read

# Create result
result = {
    'requirements_files': requirements_files,
    'installed_packages': installed_packages,
    'imports': list(imports)
}

print(json.dumps(result))
"""
        
        # Execute script
        result = await self.command_executor.execute_script_from_file(
            script=script,
            language="python",
            cwd=project_dir,
            timeout=30.0
        )
        code, stdout, stderr = result.return_code, result.stdout, result.stderr
        
        if code != 0:
            return {
                "error": f"Failed to analyze Python dependencies: {stderr}"
            }
        
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {
                "error": "Failed to parse analysis result"
            }
    
    async def analyze_javascript_dependencies(self, project_dir: str) -> dict[str, Any]:
        """Analyze JavaScript/Node.js project dependencies.
        
        Args:
            project_dir: The project directory
            
        Returns:
            Dictionary of dependency information
        """
        script: str = """
const fs = require('fs');
const path = require('path');

// Scan for package.json files
const packageFiles = [];
function findPackageFiles(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(dir, file.name);
        
        if (file.isDirectory() && file.name !== 'node_modules') {
            findPackageFiles(filePath);
        } else if (file.name === 'package.json') {
            packageFiles.push(filePath);
        }
    }
}

// Find imports
const imports = new Set();
function scanImports(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(dir, file.name);
        
        if (file.isDirectory() && file.name !== 'node_modules') {
            scanImports(filePath);
        } else if (file.name.endsWith('.js') || file.name.endsWith('.jsx') || 
                   file.name.endsWith('.ts') || file.name.endsWith('.tsx')) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                
                // Match import statements
                const importRegex = /import.*?from\\s+['"](.*?)['"];/g;
                let match;
                while (match = importRegex.exec(content)) {
                    const importPath = match[1];
                    if (!importPath.startsWith('.')) {
                        imports.add(importPath.split('/')[0]);
                    }
                }
                
                // Match require statements
                const requireRegex = /require\\(['"](.*?)['"]\\)/g;
                while (match = requireRegex.exec(content)) {
                    const importPath = match[1];
                    if (!importPath.startsWith('.')) {
                        imports.add(importPath.split('/')[0]);
                    }
                }
            } catch (err) {
                // Skip files that can't be read
            }
        }
    }
}

try {
    findPackageFiles('.');
    scanImports('.');
    
    // Parse package.json files
    const packageDetails = [];
    for (const pkgFile of packageFiles) {
        try {
            const pkgJson = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
            packageDetails.push({
                path: pkgFile,
                name: pkgJson.name,
                version: pkgJson.version,
                dependencies: pkgJson.dependencies || {},
                devDependencies: pkgJson.devDependencies || {}
            });
        } catch (err) {
            packageDetails.push({
                path: pkgFile,
                error: 'Failed to parse package.json'
            });
        }
    }
    
    const result = {
        packageFiles: packageFiles,
        packageDetails: packageDetails,
        imports: Array.from(imports)
    };
    
    console.log(JSON.stringify(result));
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
"""
        
        # Execute script
        result = await self.command_executor.execute_script_from_file(
            script=script,
            language="javascript",
            cwd=project_dir,
            timeout=30.0
        )
        code, stdout, stderr = result.return_code, result.stdout, result.stderr
        
        if code != 0:
            return {
                "error": f"Failed to analyze JavaScript dependencies: {stderr}"
            }
        
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {
                "error": "Failed to parse analysis result"
            }
    
    async def analyze_project_structure(self, project_dir: str) -> dict[str, Any]:
        """Analyze project structure.
        
        Args:
            project_dir: The project directory
            
        Returns:
            Dictionary of project structure information
        """
        script: str = """
import os
import json
from pathlib import Path

def count_lines(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return len(f.readlines())
    except:
        return 0

# Get file extensions
extensions = {}
file_count = 0
dir_count = 0
total_size = 0
total_lines = 0

# Scan files
for root, dirs, files in os.walk('.'):
    dir_count += len(dirs)
    file_count += len(files)
    
    for file in files:
        file_path = Path(root) / file
        ext = file_path.suffix.lower()
        size = file_path.stat().st_size
        total_size += size
        
        if ext in ('.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.h', '.go', '.rb', '.php'):
            lines = count_lines(file_path)
            total_lines += lines
        
        if ext in extensions:
            extensions[ext]['count'] += 1
            extensions[ext]['size'] += size
        else:
            extensions[ext] = {'count': 1, 'size': size}

# Sort extensions by count
sorted_extensions = {k: v for k, v in sorted(
    extensions.items(), 
    key=lambda item: item[1]['count'], 
    reverse=True
)}

# Create result
result = {
    'file_count': file_count,
    'directory_count': dir_count,
    'total_size': total_size,
    'total_lines': total_lines,
    'extensions': sorted_extensions
}

print(json.dumps(result))
"""
        
        # Execute script
        result = await self.command_executor.execute_script_from_file(
            script=script,
            language="python",
            cwd=project_dir,
            timeout=30.0
        )
        code, stdout, stderr = result.return_code, result.stdout, result.stderr
        
        if code != 0:
            return {
                "error": f"Failed to analyze project structure: {stderr}"
            }
        
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {
                "error": "Failed to parse analysis result"
            }
