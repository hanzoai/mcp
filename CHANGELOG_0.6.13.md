# Changelog for v0.6.13

## Overview
This release fixes a critical issue with MCP tools when called externally through the protocol, and introduces a unified architecture for context handling.

## Key Changes

### 🐛 Bug Fixes
- **Fixed Context Parameter Validation**: MCP tools now properly handle context parameters when called externally (where context may be passed as a string like "{}" instead of an object)
- **Cleaned Up Project Structure**: Removed all temporary files, test scripts, and unified implementations that were causing issues

### 🏗️ Architecture Improvements  
- **Unified Context Handling**: Implemented a single, modular solution for context normalization using decorators
- **Enhanced MCP Server**: Created `EnhancedFastMCP` that automatically applies context normalization to all registered tools
- **No More Copy-Paste**: Removed all duplicate context normalization code from individual tools

### 📁 Project Cleanup
- Moved all test files to `tests/` directory
- Removed 30+ temporary and backup files
- Cleaned up unified tool implementations
- Proper separation of concerns

## Technical Details

### Context Normalization
- Added `@with_context_normalization` decorator that intercepts and normalizes context parameters
- Created `MockContext` class for external calls where proper MCP context isn't available
- Enhanced server automatically wraps all tool registrations with context normalization

### Files Added
- `hanzo_mcp/tools/common/decorators.py` - Core decorator implementation
- `hanzo_mcp/server_enhanced.py` - Enhanced FastMCP server with automatic normalization
- `hanzo_mcp/tools/common/enhanced_base.py` - Enhanced base classes for tools

### Files Modified
- `hanzo_mcp/server.py` - Now uses EnhancedFastMCP
- `hanzo_mcp/tools/common/context_fix.py` - Converted to backward compatibility wrapper

## Migration Notes
No changes required for existing users. The context normalization is applied automatically and transparently.

## Testing
All tools now properly handle:
- Proper MCPContext objects
- String contexts (e.g., "{}")
- None contexts
- Dictionary contexts

This ensures tools work reliably whether called internally or externally through the MCP protocol.