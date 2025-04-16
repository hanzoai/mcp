# Testing Improvements for Hanzo MCP

## Changes Made

### 1. Fixed CLI project_dir handling

- Modified `cli.py` to correctly handle cases where project_dir is not explicitly provided
- The code now keeps project_dir as None when not specified, instead of defaulting to the first allowed path
- This fixed the failing test in `test_main_without_allowed_paths`

### 2. Improved pytest configuration

- Removed unsupported config options in `pyproject.toml` that were causing warnings
- Added proper registration for the asyncio marker to prevent marker warnings
- Reduced warnings from 208 to 99

### 3. Added asyncio support in conftest.py

- Added a hook to handle asyncio tests even without pytest-asyncio installed
- This approach preserves the current test suite behavior while setting the groundwork for enabling asyncio tests

## Remaining Issues

### 1. Skipped Tests

- 102 tests are still being skipped, primarily due to:
  - Tests using asyncio decorators but lacking proper plugin support
  - Tests potentially requiring external dependencies or API keys
  - Tests that might interact with real file systems or services

### 2. Dependency Management

- The environment is missing pytest-asyncio and possibly other dependencies
- The standard dependency management tools (pip, uv) seem to have issues in the environment

## Recommendations

To fully resolve the skipped tests, the following steps are recommended:

1. **Install pytest-asyncio**: Use the project's dependency management system to install pytest-asyncio and other required test dependencies:
   ```bash
   uv pip install pytest-asyncio>=0.25.3
   ```

2. **Enable asyncio configuration**: Uncomment the asyncio configuration in pyproject.toml:
   ```toml
   [tool.pytest.ini_options]
   asyncio_mode = "strict"
   asyncio_default_fixture_loop_scope = "function"
   ```

3. **Add explicit skip markers**: For tests that should be skipped for specific reasons (e.g., requiring external APIs), add clear skip markers with reason:
   ```python
   @pytest.mark.skipif(
       os.environ.get("OPENAI_API_KEY") is None,
       reason="Requires OpenAI API key for integration testing"
   )
   ```

4. **Test categorization**: Consider categorizing tests into:
   - Core tests (that should always pass)
   - Integration tests (that may require external dependencies)
   - Extended tests (that test all functionality but may be environment-dependent)

5. **Enhanced CI support**: Ensure CI environments have all necessary dependencies and environment variables to run the full test suite

## Current Test Statistics

- Before fixes: 1 failing, 106 passing, 102 skipped, 208 warnings
- After fixes: 0 failing, 107 passing, 102 skipped, 99 warnings

The changes made so far have fixed the failing test and reduced warnings, but fully enabling the skipped tests requires additional environment setup that's beyond the scope of the current changes.