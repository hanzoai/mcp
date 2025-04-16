# Recent Changes

## April 2025

### Testing Improvements

- Fixed CLI.py to handle project_dir parameter correctly when not explicitly provided
- Commented out asyncio-specific configuration in pyproject.toml to prevent errors when pytest-asyncio is not available
- Created test guide documentation to explain how to run and fix skipped tests
- Added clean install-test target to the Makefile

## To Enable All Tests

To run all the skipped tests (primarily the asyncio tests), you need to:

1. Install the pytest-asyncio plugin:
   ```
   uv pip install pytest-asyncio>=0.25.3
   ```

2. Uncomment the asyncio config in pyproject.toml:
   ```toml
   # If you need to run asyncio tests, uncomment the following lines:
   asyncio_mode = "strict"
   asyncio_default_fixture_loop_scope = "function"
   ```

3. Run the tests again:
   ```
   make test
   ```

Most of the previously skipped tests will now run, except for those that require external API keys or special environments.

## Statistics

- Before fixes: 107 passed, 102 skipped
- Current status (without pytest-asyncio): 107 passed, 102 skipped
- Expected after installing pytest-asyncio: ~180 passed, ~29 skipped