# Hanzo MCP v0.6.12 Release Notes

## 🐛 Bug Fixes

### Fixed Pydantic Deprecation Warnings
- Resolved persistent Pydantic v2 deprecation warnings from litellm library
- Wrapped all litellm imports with warning suppression context managers
- No more `PydanticDeprecatedSince20` warnings when running `uvx hanzo-mcp`

### Fixed stdio Transport Protocol Integrity
- Eliminated all logging output to stdout/stderr in stdio transport mode
- Configured FastMCP logging to ERROR level for stdio transport
- Redirected stderr to devnull for complete protocol compliance
- Ensures clean JSON-RPC communication without corruption

## 🧪 Testing Improvements

### New Tests Added
- `test_stdio_protocol.py`: Comprehensive stdio protocol integrity test
- `test_litellm_warnings.py`: Verification that deprecation warnings are suppressed
- All tests now properly organized in `tests/` directory

### Test Coverage
- Validates stdio transport produces only valid JSON output
- Tests error conditions don't break protocol
- Ensures no logging leaks into stdio communication
- Verifies litellm imports don't trigger warnings

## 🔧 Technical Details

### Warning Suppression Implementation
```python
# Import litellm with warnings suppressed
import warnings
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import litellm
```

### Logging Configuration for stdio
- Early configuration using FastMCP's `configure_logging(level="ERROR")`
- Standard logging disabled with empty handlers
- stderr redirected to devnull for complete silence

## 📝 Files Modified
- `hanzo_mcp/tools/agent/agent_tool.py`
- `hanzo_mcp/tools/agent/agent.py`
- `hanzo_mcp/tools/agent/tool_adapter.py`
- `hanzo_mcp/cli.py`
- `hanzo_mcp/server.py`
- `hanzo_mcp/__init__.py`
- 12 files converted from print() to logging
- New test files added

## ✅ All Tests Pass
- No Pydantic deprecation warnings
- stdio protocol integrity maintained
- All existing tests continue to pass