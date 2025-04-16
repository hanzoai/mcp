# Test Setup for Hanzo MCP

## Prerequisites

This project uses the `uv` package manager for dependency management. You'll need to have it installed:

```bash
# Install uv using the provided script
./scripts/install_uv.sh

# Or install with pip
pip install uv
```

## Running Tests

Once `uv` is installed, you can run the tests with:

```bash
# Run all tests (will install test dependencies first)
make test

# Run tests with coverage
make test-cov
```

The `make test` command will:
1. Install all test dependencies automatically 
2. Run the test suite with pytest

## Test Organization

- All tests are located in the `tests/` directory
- Async tests use the `pytest-asyncio` plugin with the `@pytest.mark.asyncio` decorator
- Configuration for pytest is in `tests/conftest.py`

## Adding New Tests

When adding new tests:

1. Put them in the appropriate subdirectory under `tests/`
2. For async tests, use the `@pytest.mark.asyncio` decorator
3. Run `make test` to verify they work correctly

## Common Issues

If you encounter the error `uv: command not found`, make sure:
1. You've installed uv (see Prerequisites section)
2. The uv binary is in your PATH
3. You've restarted your terminal after installation

If tests fail to collect, check:
1. Your test function names start with `test_`
2. Async tests are properly decorated with `@pytest.mark.asyncio`
3. You're not mixing async and sync patterns in the same test function
