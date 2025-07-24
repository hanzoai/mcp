"""Base classes for process execution tools."""

import asyncio
import subprocess
import tempfile
import uuid
from abc import abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional, override

from mcp.server.fastmcp import Context as MCPContext

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.permissions import PermissionManager


class ProcessManager:
    """Singleton manager for background processes."""
    
    _instance = None
    _processes: Dict[str, subprocess.Popen] = {}
    _logs: Dict[str, List[str]] = {}
    _log_dir = Path(tempfile.gettempdir()) / "hanzo_mcp_logs"
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._log_dir.mkdir(exist_ok=True)
        return cls._instance
    
    def add_process(self, process_id: str, process: subprocess.Popen, log_file: Path) -> None:
        """Add a process to track."""
        self._processes[process_id] = process
        self._logs[process_id] = str(log_file)
    
    def get_process(self, process_id: str) -> Optional[subprocess.Popen]:
        """Get a tracked process."""
        return self._processes.get(process_id)
    
    def remove_process(self, process_id: str) -> None:
        """Remove a process from tracking."""
        self._processes.pop(process_id, None)
        self._logs.pop(process_id, None)
    
    def list_processes(self) -> Dict[str, Dict[str, Any]]:
        """List all tracked processes."""
        result = {}
        for pid, proc in list(self._processes.items()):
            if proc.poll() is None:
                result[pid] = {
                    "pid": proc.pid,
                    "running": True,
                    "log_file": self._logs.get(pid)
                }
            else:
                result[pid] = {
                    "pid": proc.pid,
                    "running": False,
                    "return_code": proc.returncode,
                    "log_file": self._logs.get(pid)
                }
                # Clean up finished processes
                self.remove_process(pid)
        return result
    
    def get_log_file(self, process_id: str) -> Optional[Path]:
        """Get log file path for a process."""
        log_path = self._logs.get(process_id)
        return Path(log_path) if log_path else None
    
    @property
    def log_dir(self) -> Path:
        """Get the log directory."""
        return self._log_dir


class BaseProcessTool(BaseTool):
    """Base class for all process execution tools."""
    
    def __init__(self, permission_manager: Optional[PermissionManager] = None):
        """Initialize the process tool.
        
        Args:
            permission_manager: Optional permission manager for access control
        """
        super().__init__()
        self.permission_manager = permission_manager
        self.process_manager = ProcessManager()
    
    @abstractmethod
    def get_command_args(self, command: str, **kwargs) -> List[str]:
        """Get the command arguments for subprocess.
        
        Args:
            command: The command or script to run
            **kwargs: Additional arguments specific to the tool
            
        Returns:
            List of command arguments for subprocess
        """
        pass
    
    @abstractmethod
    def get_tool_name(self) -> str:
        """Get the name of the tool being used (e.g., 'bash', 'uvx', 'npx')."""
        pass
    
    async def execute_sync(
        self,
        command: str,
        cwd: Optional[Path] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[int] = None,
        **kwargs
    ) -> str:
        """Execute a command synchronously and return output.
        
        Args:
            command: Command to execute
            cwd: Working directory
            env: Environment variables
            timeout: Timeout in seconds
            **kwargs: Additional tool-specific arguments
            
        Returns:
            Command output
            
        Raises:
            RuntimeError: If command fails
        """
        # Check permissions if manager is available
        if self.permission_manager and cwd:
            if not self.permission_manager.is_path_allowed(str(cwd)):
                raise PermissionError(f"Access denied to path: {cwd}")
        
        # Get command arguments
        cmd_args = self.get_command_args(command, **kwargs)
        
        # Prepare environment
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        
        try:
            result = subprocess.run(
                cmd_args,
                cwd=cwd,
                env=process_env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=True
            )
            return result.stdout
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"{self.get_tool_name()} command timed out after {timeout} seconds")
        except subprocess.CalledProcessError as e:
            error_msg = f"{self.get_tool_name()} command failed with exit code {e.returncode}"
            if e.stderr:
                error_msg += f"\nError: {e.stderr}"
            raise RuntimeError(error_msg)
    
    async def execute_background(
        self,
        command: str,
        cwd: Optional[Path] = None,
        env: Optional[Dict[str, str]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Execute a command in the background.
        
        Args:
            command: Command to execute
            cwd: Working directory
            env: Environment variables
            **kwargs: Additional tool-specific arguments
            
        Returns:
            Dict with process_id and log_file
        """
        # Check permissions if manager is available
        if self.permission_manager and cwd:
            if not self.permission_manager.is_path_allowed(str(cwd)):
                raise PermissionError(f"Access denied to path: {cwd}")
        
        # Generate process ID and log file
        process_id = f"{self.get_tool_name()}_{uuid.uuid4().hex[:8]}"
        log_file = self.process_manager.log_dir / f"{process_id}.log"
        
        # Get command arguments
        cmd_args = self.get_command_args(command, **kwargs)
        
        # Prepare environment
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        
        # Start process with output to log file
        with open(log_file, "w") as f:
            process = subprocess.Popen(
                cmd_args,
                cwd=cwd,
                env=process_env,
                stdout=f,
                stderr=subprocess.STDOUT,
                text=True
            )
        
        # Track the process
        self.process_manager.add_process(process_id, process, log_file)
        
        return {
            "process_id": process_id,
            "pid": process.pid,
            "log_file": str(log_file),
            "status": "started"
        }


class BaseBinaryTool(BaseProcessTool):
    """Base class for binary execution tools (like npx, uvx)."""
    
    @abstractmethod
    def get_binary_name(self) -> str:
        """Get the name of the binary to execute."""
        pass
    
    @override
    def get_command_args(self, command: str, **kwargs) -> List[str]:
        """Get command arguments for binary execution.
        
        Args:
            command: The package or command to run
            **kwargs: Additional arguments (args, flags, etc.)
            
        Returns:
            List of command arguments
        """
        cmd_args = [self.get_binary_name()]
        
        # Add any binary-specific flags
        if "flags" in kwargs:
            cmd_args.extend(kwargs["flags"])
        
        # Add the command/package
        cmd_args.append(command)
        
        # Add any additional arguments
        if "args" in kwargs:
            if isinstance(kwargs["args"], str):
                cmd_args.extend(kwargs["args"].split())
            else:
                cmd_args.extend(kwargs["args"])
        
        return cmd_args
    
    @override
    def get_tool_name(self) -> str:
        """Get the tool name (same as binary name by default)."""
        return self.get_binary_name()


class BaseScriptTool(BaseProcessTool):
    """Base class for script execution tools (like bash, python)."""
    
    @abstractmethod
    def get_interpreter(self) -> str:
        """Get the interpreter to use."""
        pass
    
    @abstractmethod
    def get_script_flags(self) -> List[str]:
        """Get default flags for the interpreter."""
        pass
    
    @override
    def get_command_args(self, command: str, **kwargs) -> List[str]:
        """Get command arguments for script execution.
        
        Args:
            command: The script content to execute
            **kwargs: Additional arguments
            
        Returns:
            List of command arguments
        """
        cmd_args = [self.get_interpreter()]
        cmd_args.extend(self.get_script_flags())
        
        # For inline scripts, use -c flag
        if not kwargs.get("is_file", False):
            cmd_args.extend(["-c", command])
        else:
            cmd_args.append(command)
        
        return cmd_args
    
    @override  
    def get_tool_name(self) -> str:
        """Get the tool name (interpreter name by default)."""
        return self.get_interpreter()


# Import os at the top of the file
import os