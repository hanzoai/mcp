# Changelog

All notable changes to the Hanzo MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.19] - 2025-03-23

### Added
- Added Jupyter notebook support with `read_notebook` and `edit_notebook` tools
- Implemented reading of notebook cells with their outputs (text, error messages, etc.)
- Added capabilities for editing, inserting, and deleting cells in Jupyter notebooks
- Added comprehensive test suite for the notebook operations

### Changed
- Updated tools registration to include the new Jupyter notebook tools
- Enhanced README.md with Jupyter notebook functionality documentation
- New CLI, binary location, etc

## [0.1.15] - 2025-03-23

### Added
- Added support for file paths in `search_content` and `content_replace` tools
- Extended functionality to search within and modify a single file directly
- Implemented smarter path handling to detect file vs directory inputs

### Changed
- Updated docstrings to clarify that `path` parameter now accepts both file and directory paths
- Enhanced tool parameter descriptions for improved clarity

### Improved
- Added extensive test coverage for the new file path functionality
- Improved error messaging for file operations

## [0.1.14] - 2025-03-23

### Added
- Enhanced `directory_tree` tool with depth limits and filtering capabilities
- Added parameter `depth` to control traversal depth (default: 3, 0 or -1 for unlimited)
- Added parameter `include_filtered` to optionally include commonly filtered directories
- Added statistics summary to directory tree output

### Changed
- Improved directory tree output format from JSON to more readable indented text
- Added filtering for common development directories (.git, node_modules, etc.)
- Enhanced directory tree structure to show skipped directories with reason

## [0.1.13] - 2025-03-23

### Changed
- Improved README instructions regarding the placement of the system prompt in Claude Desktop
- Clarified that the system prompt must be placed in the "Project instructions" section for optimal performance

## [0.1.12] - 2025-03-22

### Changed
- Modified permissions system to allow access to `.git` folders by default
- Updated tests to reflect the new permission behavior

## [0.1.11] - 2025-03-22

### Changed
- Improved documentation in file_operations.py to clarify that the `path` parameter refers to an absolute path rather than a relative path
- Enhanced developer experience by providing clearer API documentation for FileOperations class methods


## [0.1.10] - 2025-03-22

### Added
- Enhanced release workflow to reliably extract and display release notes

### Changed
- Improved error handling and fallback mechanism for the release process

## [0.1.9] - 2025-03-22

### Fixed
- Fixed GitHub Actions workflow to properly display release notes from CHANGELOG.md
- Added fallback mechanism when release notes aren't found in CHANGELOG.md

## [0.1.8] - 2025-03-22

### Added
- Added "think" tool based on Anthropic's research to enhance Claude's complex reasoning abilities
- Updated documentation with guidance on when and how to use the think tool

## [0.1.7] - 2025-03-22

### Fixed
- Added validation in `edit_file` to ensure `oldText` parameter is not empty

## [0.1.6] - 2025-03-22

### Fixed
- Fixed GitHub Actions workflow permissions for creating releases

## [0.1.5] - 2025-03-22

### Changed
- Updated GitHub Actions to latest versions (v3 to v4 for artifacts, v3 to v4 for checkout, v4 to v5 for setup-python)

## [0.1.4] - 2025-03-22

### Added
- Added UVX support for zero-install usage

### Changed
- Simplified README.md to focus only on configuration with uvx usage
- Updated command arguments in documentation for improved clarity

## [0.1.3] - 2025-03-21

### Fixed
- Fixed package structure to include all subpackages
- Updated build configuration to properly include all modules

## [0.1.2] - 2025-03-21

### Added
- Published to PyPI for easier installation
- Improved package metadata

## [0.1.1] - 2025-03-21

### Added
- Initial public release
- Complete MCP server implementation with Hanzo capabilities
- Tools for code understanding, modification, and analysis
- Security features for safe file operations
- Comprehensive test suite
- Documentation in README

### Changed
- Improved error handling in file operations
- Enhanced permission validation

### Fixed
- Version synchronization between package files

## [0.1.0] - 2025-03-15

### Added
- Initial development version
- Basic MCP server structure
- Core tool implementations
