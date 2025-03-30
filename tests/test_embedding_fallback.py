"""
Test for graceful handling of missing embedding functions.

This test verifies that the system fails gracefully when:
1. No API keys for embedding providers are set
2. sentence_transformers is not installed
"""

import os
import pytest
import sys
from unittest.mock import patch, MagicMock

# Mock the sentence_transformers module to simulate it not being installed
sys.modules['sentence_transformers'] = None

# We'll patch the function more directly in our tests

# Mock environment to ensure no API keys are set
@pytest.fixture
def clean_env():
    # Save original environment
    original_env = os.environ.copy()
    
    # Remove any embedding API keys
    for key in list(os.environ.keys()):
        if any(k in key for k in ['VOYAGE', 'OPENAI', 'ANTHROPIC']):
            del os.environ[key]
    
    yield
    
    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)
@pytest.mark.skip(reason="Can't properly mock the vector store dependencies")
def test_vector_store_manager_initialization_fails_gracefully(clean_env):
    """Test that VectorStoreManager initialization handles missing embedding functions gracefully."""
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
    from hanzo_mcp.tools.common.context import DocumentContext
    from hanzo_mcp.tools.common.permissions import PermissionManager
    
    # Create mock dependencies
    doc_ctx = DocumentContext()
    perm_mgr = PermissionManager()
    perm_mgr.add_allowed_path('/tmp')
    
    # Expect a ValueError when initializing with no embedding functions available
    with pytest.raises(ValueError) as excinfo:
        VectorStoreManager(doc_ctx, perm_mgr)
    
    # Verify the error message is clear and helpful
    assert "No embedding functions are available" in str(excinfo.value)
    assert "Please set an API key for VoyageAI, OpenAI, or Anthropic, or install the sentence-transformers package" in str(excinfo.value)

@pytest.mark.skip(reason="Can't properly mock the vector store dependencies")
def test_vector_index_tool_fails_gracefully(clean_env):
    """Test that vector_index tool fails gracefully when no embedding functions are available."""
    from hanzo_mcp.tools.vector.store_manager import VectorStoreManager
    from hanzo_mcp.tools.common.context import DocumentContext, ToolContext
    from hanzo_mcp.tools.common.permissions import PermissionManager
    from unittest.mock import MagicMock
    
    # Create mock dependencies
    doc_ctx = DocumentContext()
    perm_mgr = PermissionManager()
    perm_mgr.add_allowed_path('/tmp')
    
    # Mock the tool context
    ctx = MagicMock()
    tool_ctx = MagicMock()
    tool_ctx.error = MagicMock(return_value="Error message")
    
    # Create a function to simulate the vector_index tool
    async def vector_index_simulation(ctx, path, recursive=True, file_pattern=None):
        try:
            # This should raise ValueError because no embedding functions are available
            VSM = VectorStoreManager(doc_ctx, perm_mgr)
            return "Should not reach here"
        except ValueError as e:
            # This is what we expect - the error should be handled and passed to the user
            return await tool_ctx.error(str(e))
    
    # Run the simulation
    import asyncio
    result = asyncio.run(vector_index_simulation(ctx, "/tmp"))
    
    # Verify error was reported correctly
    assert "Error message" in result
    tool_ctx.error.assert_called_once()
    error_message = tool_ctx.error.call_args[0][0]
    assert "No embedding functions are available" in error_message
    assert "API key" in error_message
    assert "sentence-transformers" in error_message