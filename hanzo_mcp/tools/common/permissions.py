"""Permission system for the Hanzo MCP server."""

import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar, final

# Define type variables for better type annotations
T = TypeVar("T")
P = TypeVar("P")


def normalize_path(path: str) -> Path:
    """Normalize a path with proper user directory expansion.

    This utility function handles path normalization with proper handling of
    tilde (~) for home directory expansion and ensures consistent path handling
    across the application.

    Args:
        path: The path to normalize (can include ~ for home directory)

    Returns:
        A normalized Path object with user directories expanded and resolved to
        its absolute canonical form.
    """
    # Expand the user directory, handling the tilde (~) if present.
    expanded_path = os.path.expanduser(path)
    # Resolve the expanded path to its absolute form.
    resolved_path = Path(expanded_path).resolve()
    return resolved_path


@final
class PermissionManager:
    """Manages permissions for file and command operations.

    This class is responsible for tracking allowed file system paths as well as
    paths and patterns that should be excluded from permitted operations.
    """

    def __init__(self) -> None:
        """Initialize the permission manager with default allowed and excluded paths.

        Allowed paths are those where operations (read, write, execute, etc.) are permitted,
        while excluded paths and patterns represent paths and file patterns that are sensitive
        and should be disallowed.
        """
        # Allowed paths: operations are permitted on these paths.
        self.allowed_paths: set[Path] = set(
            [Path("/tmp").resolve(), Path("/var").resolve()]
        )

        # Excluded paths: specific paths that are explicitly disallowed.
        self.excluded_paths: set[Path] = set()

        # Excluded patterns: patterns for sensitive directories and file names.
        self.excluded_patterns: list[str] = []

        # Add default exclusions for sensitive files and directories.
        self._add_default_exclusions()

    def _add_default_exclusions(self) -> None:
        """Add default exclusions for sensitive files and directories.

        This method populates the excluded_patterns list with common sensitive
        directories (e.g., .ssh, .gnupg) and file patterns (e.g., *.key, *.log)
        that should be excluded from allowed operations.
        """
        # Sensitive directories (Note: .git is allowed by default)
        sensitive_dirs: list[str] = [
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
        """Add a new path to the allowed paths.

        Args:
            path: The file system path to add to the allowed list.
        """
        resolved_path: Path = normalize_path(path)
        self.allowed_paths.add(resolved_path)

    def remove_allowed_path(self, path: str) -> None:
        """Remove a path from the allowed paths.

        Args:
            path: The file system path to remove from the allowed list.
        """
        resolved_path: Path = normalize_path(path)
        if resolved_path in self.allowed_paths:
            self.allowed_paths.remove(resolved_path)

    def exclude_path(self, path: str) -> None:
        """Add a path to the exclusion list.

        Args:
            path: The file system path to explicitly exclude from operations.
        """
        resolved_path: Path = normalize_path(path)
        self.excluded_paths.add(resolved_path)

    def add_exclusion_pattern(self, pattern: str) -> None:
        """Add a new exclusion pattern.

        Args:
            pattern: A string pattern that matches file or directory names to exclude.
        """
        self.excluded_patterns.append(pattern)

    def is_path_allowed(self, path: str) -> bool:
        """Determine if a given path is allowed for operations.

        The method normalizes the input path and then checks it against the list
        of excluded paths and patterns. If the path is not excluded and is a
        subpath of one of the allowed base paths, the method returns True.

        Args:
            path: The file system path to check.

        Returns:
            True if the path is allowed for operations, False otherwise.
        """
        resolved_path: Path = normalize_path(path)

        # First, check if the path matches any excluded paths or patterns.
        if self._is_path_excluded(resolved_path):
            return False

        # Check if the normalized path is within any allowed path.
        for allowed_path in self.allowed_paths:
            try:
                # relative_to will succeed if resolved_path is a subpath of allowed_path.
                resolved_path.relative_to(allowed_path)
                return True
            except ValueError:
                continue

        return False

    def _is_path_excluded(self, path: Path) -> bool:
        """Determine if a normalized path should be excluded.

        The method checks two conditions:
          1. If the path exactly matches an entry in the excluded_paths set.
          2. If the path string contains any of the excluded patterns, either as a
             suffix for wildcard patterns (e.g., "*.log") or as an exact match
             within any of the path's components.

        Args:
            path: The normalized path to check.

        Returns:
            True if the path is excluded, False otherwise.
        """
        # Direct match: Check if the path is in the explicitly excluded paths set.
        if path in self.excluded_paths:
            return True

        # Convert the path to a string for pattern matching.
        path_str: str = str(path)

        # Split the path into its individual components (directories and file name).
        path_parts = path_str.split(os.sep)

        # Iterate over each exclusion pattern to see if it matches.
        for pattern in self.excluded_patterns:
            # If the pattern starts with a wildcard, perform a suffix match.
            if pattern.startswith("*"):
                if path_str.endswith(pattern[1:]):
                    return True
            else:
                # For non-wildcard patterns, check if any path component exactly matches the pattern.
                if pattern in path_parts:
                    return True

        return False

    def to_json(self) -> str:
        """Serialize the permission manager's configuration to a JSON string.

        The JSON representation includes the allowed paths, excluded paths, and
        excluded patterns, which can be used to restore the configuration later.

        Returns:
            A JSON string representing the current state of the permission manager.
        """
        data: dict[str, Any] = {
            "allowed_paths": [str(p) for p in self.allowed_paths],
            "excluded_paths": [str(p) for p in self.excluded_paths],
            "excluded_patterns": self.excluded_patterns,
        }
        return json.dumps(data)

    @classmethod
    def from_json(cls, json_str: str) -> "PermissionManager":
        """Create a PermissionManager instance from a JSON string.

        The JSON string should represent a configuration with allowed paths,
        excluded paths, and exclusion patterns. This method rehydrates the state
        accordingly.

        Args:
            json_str: The JSON string containing the permission manager configuration.

        Returns:
            A new PermissionManager instance with configuration loaded from the JSON string.
        """
        data: dict[str, Any] = json.loads(json_str)
        manager = cls()

        for path in data.get("allowed_paths", []):
            manager.add_allowed_path(path)

        for path in data.get("excluded_paths", []):
            manager.exclude_path(path)

        manager.excluded_patterns = data.get("excluded_patterns", [])
        return manager


class PermissibleOperation:
    """A decorator for operations that require permission checks.

    This decorator uses a PermissionManager instance to enforce that a given
    operation (e.g., read, write, execute) is permitted on a provided file system
    path before allowing the decorated function to execute.
    """

    def __init__(
        self,
        permission_manager: PermissionManager,
        operation: str,
        get_path_fn: Callable[[list[Any], dict[str, Any]], str] | None = None,
    ) -> None:
        """Initialize the PermissibleOperation decorator.

        Args:
            permission_manager: The PermissionManager instance used for permission checks.
            operation: A string representing the operation type (e.g., 'read', 'write').
            get_path_fn: Optional function to extract the file system path from the function's
                         arguments. If not provided, defaults to using the first positional argument
                         or the first value from keyword arguments.
        """
        self.permission_manager: PermissionManager = permission_manager
        self.operation: str = operation
        self.get_path_fn: Callable[[list[Any], dict[str, Any]], str] | None = get_path_fn

    def __call__(
        self, func: Callable[..., Awaitable[T]]
    ) -> Callable[..., Awaitable[T]]:
        """Decorate the function to enforce permission checks before execution.

        This method wraps the original asynchronous function, extracting a file system path
        from its arguments and using the PermissionManager to verify if the specified operation
        is allowed on that path. If permission is denied, a PermissionError is raised.

        Args:
            func: The asynchronous function to decorate.

        Returns:
            An asynchronous function that includes permission checks prior to calling the original function.
        """
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            # Extract the file system path using the provided get_path_fn if available.
            if self.get_path_fn:
                path = self.get_path_fn(list(args), kwargs)
            else:
                # Default extraction: use the first positional argument if available,
                # otherwise use the first keyword argument value.
                path = args[0] if args else next(iter(kwargs.values()), None)

            # Ensure that the extracted path is a string.
            if not isinstance(path, str):
                raise ValueError(f"Invalid path type: {type(path)}. Expected a string.")

            # Check if the operation is allowed on the specified path.
            if not self.permission_manager.is_path_allowed(path):
                raise PermissionError(
                    f"Operation '{self.operation}' not allowed for path: {path}"
                )

            # Execute the original function if the permission check passes.
            return await func(*args, **kwargs)

        return wrapper
