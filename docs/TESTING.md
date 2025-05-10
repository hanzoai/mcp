# Testing Guide for Hanzo MCP

## Running Tests

To run the standard test suite:

```bash
make test
```

To run tests with coverage reports:

```bash
make test-cov
```

For a quicker test run without reinstalling dependencies:

```bash
make test-quick
```

## Testing Framework

The project uses pytest for testing with a structured approach in the `/tests` directory. Tests are organized by component:
- `test_agent` - Tests for agent functionality
- `test_common` - Tests for common utilities
- `test_filesystem` - Tests for filesystem operations
- `test_jupyter` - Tests for Jupyter notebook handling
- `test_project` - Tests for project analysis tools
- `test_shell` - Tests for shell command execution

## Handling Asyncio Tests

Many tests use the `@pytest.mark.asyncio` decorator and require the pytest-asyncio plugin:

1. Install the pytest-asyncio plugin:

```bash
# Using uv (recommended)
uv pip install pytest-asyncio>=0.25.3
```

2. Make sure your pyproject.toml has the proper configuration:

```toml
[tool.pytest.ini_options]
asyncio_mode = "strict"
asyncio_default_fixture_loop_scope = "function"
```

## Test Dependencies

All testing dependencies are defined in pyproject.toml:

```toml
test = [
  "pytest>=7.0.0",
  "pytest-cov>=4.1.0",
  "pytest-mock>=3.10.0",
  "pytest-asyncio>=0.25.3",
  "twisted",
]
```

To install all test dependencies:

```bash
make install-test
```

## Debugging Tests

If you encounter skipped tests, there are several common reasons:

1. **Missing Dependencies**: Install the required packages using `make install-test`
2. **External Services**: Some tests may require API keys for services like OpenAI
3. **Platform-Specific**: Some tests may only run on certain platforms
4. **Resource Intensive**: Some tests may require significant resources

## Debugging with MCP Inspector

To debug your MCP project using the inspector tool:

```bash
npx @modelcontextprotocol/inspector \
  uv \
  --directory ~/project/hanzo-mcp \
  run \
  hanzo-mcp \
  --allow-path \
  {allow path} \
  "--agent-model" \
  "openrouter/google/gemini-2.0-flash-001" \
  "--agent-max-tokens" \
  "100000" \
  "--agent-api-key" \
  "{api key}" \
  "--enable-agent-tool" \
  "--agent-max-iterations" \
  "30" \
  "--agent-max-tool-uses" \
  "100" \
```

## Best Practices

1. Always use the Makefile for operations rather than running Python scripts or pytest directly
2. When running tests, use `make test` or `make test-quick` rather than invoking pytest directly
3. If specific tests are failing, isolate them with `-k` option through the Makefile
4. When adding new tools, follow the existing patterns for validation and permission checks
5. Add appropriate mocks for external dependencies like ripgrep or subprocess calls
6. If a test is too complex to mock properly, use `@pytest.mark.skip` with a clear reason
7. Ensure the virtual environment is properly set up with all dependencies before running tests
