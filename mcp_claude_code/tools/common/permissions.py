"""Permission system for the MCP Claude Code server."""

import json
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar, final

# Define type variables for better type annotations
T = TypeVar("T")
P = TypeVar("P")


@final
class PermissionManager:
    """Manages permissions for file and command operations."""

    def __init__(self) -> None:
        """Initialize the permission manager."""
        # Allowed paths
        self.allowed_paths: set[Path] = set()

        # Approved operations (path -> operation -> timestamp)
        self.approved_operations: dict[str, dict[str, float]] = {}

        # Operation timeout in seconds (default: 5 minutes)
        self.operation_timeout: float = 300.0

        # Excluded paths
        self.excluded_paths: set[Path] = set()
        self.excluded_patterns: list[str] = []

        # Default excluded patterns
        self._add_default_exclusions()

    def _add_default_exclusions(self) -> None:
        """Add default exclusions for sensitive files and directories."""
        # Sensitive directories
        sensitive_dirs: list[str] = [
            ".git",
            ".github",
            ".ssh",
            ".gnupg",
            ".config",
            "node_modules",
            "__pycache__",
            ".venv",
            "venv",
            "env",
            ".idea",
            ".vscode",
            ".DS_Store",
        ]
        self.excluded_patterns.extend(sensitive_dirs)

        # Sensitive file patterns
        sensitive_patterns: list[str] = [
            ".env",
            "*.key",
            "*.pem",
            "*.crt",
            "*password*",
            "*secret*",
            "*.sqlite",
            "*.db",
            "*.sqlite3",
            "*.log",
        ]
        self.excluded_patterns.extend(sensitive_patterns)

    def add_allowed_path(self, path: str) -> None:
        """Add a path to the allowed paths.

        Args:
            path: The path to allow
        """
        resolved_path: Path = Path(path).resolve()
        self.allowed_paths.add(resolved_path)

    def remove_allowed_path(self, path: str) -> None:
        """Remove a path from the allowed paths.

        Args:
            path: The path to remove
        """
        resolved_path: Path = Path(path).resolve()
        if resolved_path in self.allowed_paths:
            self.allowed_paths.remove(resolved_path)

    def exclude_path(self, path: str) -> None:
        """Exclude a path from allowed operations.

        Args:
            path: The path to exclude
        """
        resolved_path: Path = Path(path).resolve()
        self.excluded_paths.add(resolved_path)

    def add_exclusion_pattern(self, pattern: str) -> None:
        """Add an exclusion pattern.

        Args:
            pattern: The pattern to exclude
        """
        self.excluded_patterns.append(pattern)

    def is_path_allowed(self, path: str) -> bool:
        """Check if a path is allowed.

        Args:
            path: The path to check

        Returns:
            True if the path is allowed, False otherwise
        """
        resolved_path: Path = Path(path).resolve()

        # Check exclusions first
        if self._is_path_excluded(resolved_path):
            return False

        # Check if the path is within any allowed path
        for allowed_path in self.allowed_paths:
            try:
                resolved_path.relative_to(allowed_path)
                return True
            except ValueError:
                continue

        return False

    def _is_path_excluded(self, path: Path) -> bool:
        """Check if a path is excluded.

        Args:
            path: The path to check

        Returns:
            True if the path is excluded, False otherwise
        """

        # Check exact excluded paths
        if path in self.excluded_paths:
            return True

        # Check excluded patterns
        path_str: str = str(path)

        # Get path parts to check for exact directory/file name matches
        path_parts = path_str.split(os.sep)

        for pattern in self.excluded_patterns:
            # Handle wildcard patterns (e.g., "*.log")
            if pattern.startswith("*"):
                if path_str.endswith(pattern[1:]):
                    return True
            else:
                # For non-wildcard patterns, check if any path component matches exactly
                if pattern in path_parts:
                    return True

        return False

    def approve_operation(self, path: str, operation: str) -> None:
        """Approve an operation on a path.

        Args:
            path: The path to approve
            operation: The operation to approve (read, write, execute, etc.)
        """
        if path not in self.approved_operations:
            self.approved_operations[path] = {}

        self.approved_operations[path][operation] = time.time()

    def is_operation_approved(self, path: str, operation: str) -> bool:
        """Check if an operation is approved.

        Args:
            path: The path to check
            operation: The operation to check

        Returns:
            True if the operation is approved, False otherwise
        """
        # If path isn't allowed, operation isn't approved
        if not self.is_path_allowed(path):
            return False

        # Check if the operation is approved
        if (
            path in self.approved_operations
            and operation in self.approved_operations[path]
        ):
            timestamp: float = self.approved_operations[path][operation]

            # Check if the approval is still valid
            if time.time() - timestamp <= self.operation_timeout:
                return True

        return False

    def clear_approvals(self) -> None:
        """Clear all approved operations."""
        self.approved_operations = {}

    def clear_expired_approvals(self) -> None:
        """Clear expired approved operations."""
        now: float = time.time()

        for path in list(self.approved_operations.keys()):
            for operation in list(self.approved_operations[path].keys()):
                timestamp: float = self.approved_operations[path][operation]

                if now - timestamp > self.operation_timeout:
                    del self.approved_operations[path][operation]

            if not self.approved_operations[path]:
                del self.approved_operations[path]

    def to_json(self) -> str:
        """Convert the permission manager to a JSON string.

        Returns:
            A JSON string representation of the permission manager
        """
        data: dict[str, Any] = {
            "allowed_paths": [str(p) for p in self.allowed_paths],
            "excluded_paths": [str(p) for p in self.excluded_paths],
            "excluded_patterns": self.excluded_patterns,
            "approved_operations": self.approved_operations,
            "operation_timeout": self.operation_timeout,
        }

        return json.dumps(data)

    @classmethod
    def from_json(cls, json_str: str) -> "PermissionManager":
        """Create a permission manager from a JSON string.

        Args:
            json_str: The JSON string

        Returns:
            A new PermissionManager instance
        """
        data: dict[str, Any] = json.loads(json_str)

        manager = cls()

        for path in data.get("allowed_paths", []):
            manager.add_allowed_path(path)

        for path in data.get("excluded_paths", []):
            manager.exclude_path(path)

        manager.excluded_patterns = data.get("excluded_patterns", [])
        manager.approved_operations = data.get("approved_operations", {})
        manager.operation_timeout = data.get("operation_timeout", 300)

        return manager


class PermissibleOperation:
    """A decorator for operations that require permission."""

    def __init__(
        self,
        permission_manager: PermissionManager,
        operation: str,
        get_path_fn: Callable[[list[Any], dict[str, Any]], str] | None = None,
    ) -> None:
        """Initialize the permissible operation.

        Args:
            permission_manager: The permission manager
            operation: The operation type (read, write, execute, etc.)
            get_path_fn: Optional function to extract the path from args and kwargs
        """
        self.permission_manager: PermissionManager = permission_manager
        self.operation: str = operation
        self.get_path_fn: Callable[[list[Any], dict[str, Any]], str] | None = (
            get_path_fn
        )

    def __call__(
        self, func: Callable[..., Awaitable[T]]
    ) -> Callable[..., Awaitable[T]]:
        """Decorate the function.

        Args:
            func: The function to decorate

        Returns:
            The decorated function
        """

        async def wrapper(*args: Any, **kwargs: Any) -> T:
            # Extract the path
            if self.get_path_fn:
                # Pass args as a list and kwargs as a dict to the path function
                path = self.get_path_fn(list(args), kwargs)
            else:
                # Default to first argument
                path = args[0] if args else next(iter(kwargs.values()), None)

            if not isinstance(path, str):
                raise ValueError(f"Invalid path type: {type(path)}")

            # Check permission
            if not self.permission_manager.is_operation_approved(path, self.operation):
                raise PermissionError(
                    f"Operation '{self.operation}' not approved for path: {path}"
                )

            # Call the function
            return await func(*args, **kwargs)

        return wrapper
