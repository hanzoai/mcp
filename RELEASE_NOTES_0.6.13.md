# Release Notes - hanzo-mcp v0.6.13

## 🎉 Successfully Published to PyPI

**Package**: https://pypi.org/project/hanzo-mcp/0.6.13/

## 🐛 Critical Bug Fix

### Context Parameter Issue (FIXED)
- **Problem**: MCP tools were failing when called externally through the protocol because the Context parameter was being passed as a string (e.g., "{}") instead of a proper MCPContext object
- **Solution**: Implemented automatic context normalization at the server level using decorators

## 🏗️ Architecture Improvements

### Uniform Context Handling
- Created `@with_context_normalization` decorator that automatically handles various context types
- Introduced `EnhancedFastMCP` server that applies context normalization to ALL tools automatically
- No more copy-paste code - single point of implementation
- Works transparently for both internal and external calls

### Key Files Added
- `hanzo_mcp/tools/common/decorators.py` - Core decorator implementation
- `hanzo_mcp/server_enhanced.py` - Enhanced server with automatic normalization
- `hanzo_mcp/tools/common/enhanced_base.py` - Enhanced base classes for tools

## 🧹 Major Cleanup

### Removed Files (30+)
- All test files moved from root to `tests/` directory
- Removed temporary scripts and backup files
- Cleaned up unified tool implementations that were causing issues
- Removed icon creation utilities and demo files

### Project Structure
- Clean separation of concerns
- All tests properly organized in `tests/`
- No duplicate or temporary files
- Proper modular architecture

## 💻 Installation

```bash
pip install --upgrade hanzo-mcp==0.6.13
```

## 🔄 Migration

No changes required for existing users. The context normalization is applied automatically and transparently.

## ✅ What This Fixes

Tools now properly handle:
- Standard MCPContext objects ✓
- String contexts (e.g., "{}") ✓
- None contexts ✓
- Dictionary contexts ✓

This ensures MCP tools work reliably whether called internally by the server or externally through the MCP protocol.