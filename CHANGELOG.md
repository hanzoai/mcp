# Changelog

All notable changes to the MCP Claude Code project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Complete MCP server implementation with Claude Code capabilities
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