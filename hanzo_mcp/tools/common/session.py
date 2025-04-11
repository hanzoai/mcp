"""Session management for maintaining state across tool executions."""

import os
from pathlib import Path
from typing import Dict, Optional, final


@final
class SessionManager:
    """Manages session state across tool executions."""

    _instances: Dict[str, "SessionManager"] = {}

    @classmethod
    def get_instance(cls, session_id: str) -> "SessionManager":
        """Get or create a session manager instance for the given session ID.

        Args:
            session_id: The session ID

        Returns:
            The session manager instance
        """
        if session_id not in cls._instances:
            cls._instances[session_id] = cls(session_id)
        return cls._instances[session_id]

    def __init__(self, session_id: str):
        """Initialize the session manager.

        Args:
            session_id: The session ID
        """
        self.session_id = session_id
        self._current_working_dir: Optional[Path] = None
        self._initial_working_dir: Optional[Path] = None
        self._environment_vars: Dict[str, str] = {}

    @property
    def current_working_dir(self) -> Path:
        """Get the current working directory.

        Returns:
            The current working directory
        """
        if self._current_working_dir is None:
            # Default to project directory if set, otherwise use current directory
            self._current_working_dir = Path(os.getcwd())
            self._initial_working_dir = self._current_working_dir
        return self._current_working_dir

    def set_working_dir(self, path: Path) -> None:
        """Set the current working directory.

        Args:
            path: The path to set as the current working directory
        """
        self._current_working_dir = path

    def reset_working_dir(self) -> None:
        """Reset the working directory to the initial directory."""
        if self._initial_working_dir is not None:
            self._current_working_dir = self._initial_working_dir

    def set_env_var(self, key: str, value: str) -> None:
        """Set an environment variable.

        Args:
            key: The environment variable name
            value: The environment variable value
        """
        self._environment_vars[key] = value

    def get_env_var(self, key: str) -> Optional[str]:
        """Get an environment variable.

        Args:
            key: The environment variable name

        Returns:
            The environment variable value, or None if not set
        """
        return self._environment_vars.get(key)

    def get_env_vars(self) -> Dict[str, str]:
        """Get all environment variables.

        Returns:
            A dictionary of environment variables
        """
        return self._environment_vars.copy()
