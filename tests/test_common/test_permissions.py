"""Tests for the permissions module."""

import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from mcp_claude_code.tools.common.permissions import (PermissibleOperation,
                                                      PermissionManager)


class TestPermissionManager:
    """Test the PermissionManager class."""

    def test_add_allowed_path(self, temp_dir):
        """Test adding an allowed path."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)

        assert Path(temp_dir).resolve() in manager.allowed_paths

    def test_remove_allowed_path(self, temp_dir):
        """Test removing an allowed path."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.remove_allowed_path(temp_dir)

        assert Path(temp_dir).resolve() not in manager.allowed_paths

    def test_exclude_path(self, temp_dir):
        """Test excluding a path."""
        manager = PermissionManager()
        manager.exclude_path(temp_dir)

        assert Path(temp_dir).resolve() in manager.excluded_paths

    def test_add_exclusion_pattern(self):
        """Test adding an exclusion pattern."""
        manager = PermissionManager()
        pattern = "secret_*"
        manager.add_exclusion_pattern(pattern)

        assert pattern in manager.excluded_patterns

    def test_is_path_allowed_with_allowed_path(self, temp_dir):
        """Test checking if an allowed path is allowed."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)

        test_file = os.path.join(temp_dir, "test.txt")

        assert manager.is_path_allowed(test_file)

    def test_is_path_allowed_with_disallowed_path(self, temp_dir):
        """Test checking if a disallowed path is allowed."""
        manager = PermissionManager()
        # Don't add the path to allowed_paths

        assert not manager.is_path_allowed(temp_dir)

    def test_is_path_allowed_with_excluded_path(self, temp_dir):
        """Test checking if an excluded path is allowed."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.exclude_path(temp_dir)

        assert not manager.is_path_allowed(temp_dir)

    def test_is_path_allowed_with_excluded_pattern(self, temp_dir):
        """Test checking if a path matching an excluded pattern is allowed."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)

        secret_file = os.path.join(temp_dir, "secret_data.txt")
        manager.add_exclusion_pattern("secret_")

        assert not manager.is_path_allowed(secret_file)

    def test_approve_operation(self, temp_dir):
        """Test approving an operation."""
        manager = PermissionManager()
        manager.approve_operation(temp_dir, "read")

        assert temp_dir in manager.approved_operations
        assert "read" in manager.approved_operations[temp_dir]

    def test_is_operation_approved_with_approval(self, temp_dir):
        """Test checking if an approved operation is approved."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.approve_operation(temp_dir, "read")

        assert manager.is_operation_approved(temp_dir, "read")

    def test_is_operation_approved_without_approval(self, temp_dir):
        """Test checking if an unapproved operation is approved."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        # Don't approve the operation

        assert not manager.is_operation_approved(temp_dir, "read")

    def test_is_operation_approved_with_expired_approval(self, temp_dir):
        """Test checking if an expired approval is approved."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.approve_operation(temp_dir, "read")

        # Set a short timeout
        manager.operation_timeout = 0.1

        # Wait for the approval to expire
        time.sleep(0.2)

        assert not manager.is_operation_approved(temp_dir, "read")

    def test_clear_approvals(self, temp_dir):
        """Test clearing all approvals."""
        manager = PermissionManager()
        manager.approve_operation(temp_dir, "read")
        manager.clear_approvals()

        assert not manager.approved_operations

    def test_clear_expired_approvals(self, temp_dir):
        """Test clearing expired approvals."""
        manager = PermissionManager()

        # Set a short timeout
        manager.operation_timeout = 0.1

        # Approve operations
        manager.approve_operation(temp_dir, "read")
        manager.approve_operation(temp_dir + "/subdir", "write")

        # Wait for the approvals to expire
        time.sleep(0.2)

        # Clear expired approvals
        manager.clear_expired_approvals()

        assert not manager.approved_operations

    def test_to_json(self, temp_dir):
        """Test converting the manager to JSON."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.exclude_path(temp_dir + "/excluded")
        manager.add_exclusion_pattern("secret_")
        manager.approve_operation(temp_dir, "read")

        json_str = manager.to_json()

        assert isinstance(json_str, str)
        assert temp_dir in json_str
        assert "secret_" in json_str

    def test_from_json(self, temp_dir):
        """Test creating a manager from JSON."""
        original = PermissionManager()
        original.add_allowed_path(temp_dir)
        original.exclude_path(temp_dir + "/excluded")
        original.add_exclusion_pattern("secret_")
        original.approve_operation(temp_dir, "read")

        json_str = original.to_json()
        reconstructed = PermissionManager.from_json(json_str)

        # Check that the reconstructed manager has the same state
        assert len(reconstructed.allowed_paths) == len(original.allowed_paths)
        assert len(reconstructed.excluded_paths) == len(original.excluded_paths)
        assert reconstructed.excluded_patterns == original.excluded_patterns
        assert temp_dir in reconstructed.approved_operations


class TestPermissibleOperation:
    """Test the PermissibleOperation decorator."""

    @pytest.mark.asyncio
    async def test_permissible_operation_with_approval(self, temp_dir):
        """Test the decorator with an approved operation."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.approve_operation(temp_dir, "read")

        # Create a decorated function
        @PermissibleOperation(manager, "read")
        async def test_func(path):
            return f"Read {path}"

        # Call the function
        result = await test_func(temp_dir)

        assert result == f"Read {temp_dir}"

    @pytest.mark.asyncio
    async def test_permissible_operation_without_approval(self, temp_dir):
        """Test the decorator without an approved operation."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        # Don't approve the operation

        # Create a decorated function
        @PermissibleOperation(manager, "read")
        async def test_func(path):
            return f"Read {path}"

        # Call the function
        with pytest.raises(PermissionError):
            await test_func(temp_dir)

    @pytest.mark.asyncio
    async def test_permissible_operation_with_custom_path_fn(self, temp_dir):
        """Test the decorator with a custom path function."""
        manager = PermissionManager()
        manager.add_allowed_path(temp_dir)
        manager.approve_operation(temp_dir, "read")

        # Custom path function
        def get_path(args, kwargs):
            return kwargs.get("filepath", args[0] if args else None)

        # Create a decorated function
        @PermissibleOperation(manager, "read", get_path_fn=get_path)
        async def test_func(data, filepath=None):
            return f"Read {filepath}"

        # Call the function with a kwarg
        result = await test_func("dummy", filepath=temp_dir)

        assert result == f"Read {temp_dir}"

    @pytest.mark.asyncio
    async def test_permissible_operation_with_invalid_path(self, temp_dir):
        """Test the decorator with an invalid path type."""
        manager = PermissionManager()

        # Create a decorated function
        @PermissibleOperation(manager, "read")
        async def test_func(path):
            return f"Read {path}"

        # Call the function with an invalid path type
        with pytest.raises(ValueError):
            await test_func(123)  # Not a string
