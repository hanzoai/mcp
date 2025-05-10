# Changelog

## v0.4.1 (2025-05-10)

### Added
- Improved backward compatibility with Anthropic MCP-Claude-Code
- Enhanced documentation describing Anthropic MCP-Claude-Code compatibility

### Fixed
- Synchronized version display between command line and version tool
- Fixed edge cases in ripgrep integration when searching large codebases
- Improved error handling for selective tool disabling

## v0.4.0 (2025-05-10)

### Changed
- Bumped version from 0.3.9 to 0.4.0 for official release
- Updated project structure documentation

## v0.3.9 (2025-05-09)

### Added
- Added AST-aware code search tool `grep_ast` that shows matched lines within the context of code structures
- Modified `search_content` tool to use ripgrep (rg) when available for faster searching, falling back to standard Python implementation
- Added `grep-ast` dependency to support the new tool

## v0.3.8 and earlier

- See commit history for earlier changes
