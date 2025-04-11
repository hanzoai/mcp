"""Tests for the session management module."""

import os
import pytest
from pathlib import Path

from hanzo_mcp.tools.common.session import SessionManager


def test_session_manager_initialization():
    """Test that SessionManager initializes correctly."""
    session_id = "test-session-id"
    session = SessionManager.get_instance(session_id)
    assert session.session_id == session_id
    assert session._current_working_dir is None
    assert session._initial_working_dir is None
    assert session._environment_vars == {}


def test_session_manager_singleton():
    """Test that SessionManager is a singleton per session_id."""
    session_id = "test-session-singleton"
    session1 = SessionManager.get_instance(session_id)
    session2 = SessionManager.get_instance(session_id)
    assert session1 is session2


def test_session_manager_different_ids():
    """Test that different session_ids get different instances."""
    session1 = SessionManager.get_instance("test-session-1")
    session2 = SessionManager.get_instance("test-session-2")
    assert session1 is not session2


def test_current_working_dir_default():
    """Test that current_working_dir defaults to current directory."""
    session_id = "test-session-cwd-default"
    session = SessionManager.get_instance(session_id)
    assert session.current_working_dir == Path(os.getcwd())
    assert session._initial_working_dir == session.current_working_dir


def test_set_working_dir():
    """Test setting the working directory."""
    session_id = "test-session-set-cwd"
    session = SessionManager.get_instance(session_id)
    test_path = Path("/tmp")
    session.set_working_dir(test_path)
    assert session.current_working_dir == test_path


def test_reset_working_dir():
    """Test resetting the working directory to the initial directory."""
    session_id = "test-session-reset-cwd"
    session = SessionManager.get_instance(session_id)
    initial_dir = session.current_working_dir
    test_path = Path("/tmp")
    session.set_working_dir(test_path)
    session.reset_working_dir()
    assert session.current_working_dir == initial_dir


def test_environment_vars():
    """Test setting and getting environment variables."""
    session_id = "test-session-env-vars"
    session = SessionManager.get_instance(session_id)
    session.set_env_var("TEST_VAR", "test_value")
    assert session.get_env_var("TEST_VAR") == "test_value"
    assert session.get_env_vars() == {"TEST_VAR": "test_value"}
