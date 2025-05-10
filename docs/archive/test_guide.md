# Testing Guide for Hanzo MCP

## Overview

This document provides guidance on running tests for the Hanzo MCP project, including how to handle skipped tests that use asyncio functionality.

## Basic Test Execution

To run the standard test suite:

```bash
make test
```

To run tests with coverage reports:

```bash
make test-cov
```

## Skipped Tests

As of the latest commit, there are 102 skipped tests in the project. The majority of these tests are skipped because they use the `@pytest.mark.asyncio` decorator, but the `pytest-asyncio` plugin is not available in the testing environment.

### Common Patterns in Skipped Tests

1. **Asyncio Tests**: Tests marked with `@pytest.mark.asyncio` that test asynchronous functionality.
2. **External API Integration Tests**: Tests that interact with external services like OpenAI or Anthropic APIs.
3. **File System Operation Tests**: Tests that perform actual file operations which may be incompatible with the testing environment.

## Enabling Asyncio Tests

To enable the asyncio tests, you need to:

1. Install the pytest-asyncio plugin:

```bash
# Using uv (recommended)
uv pip install pytest-asyncio>=0.25.3

# Using pip (alternative)
pip install pytest-asyncio>=0.25.3
```

2. Enable asyncio mode in pytest configuration. Uncomment these lines in `pyproject.toml`:

```toml
# asyncio_mode = "strict"
# asyncio_default_fixture_loop_scope = "function"
```

After making these changes, many of the previously skipped tests will run.

## Running Tests with External API Integration

Some skipped tests require external API keys or services. To run these tests:

1. Set the necessary environment variables:

```bash
export OPENAI_API_KEY="your-api-key"
export ANTHROPIC_API_KEY="your-api-key"
```

2. Run specific test categories:

```bash
python -m pytest tests/test_agent/test_litellm_providers.py -v
```

## Understanding Test Skip Reasons

Tests are skipped for various reasons:

1. **Missing Dependencies**: The test requires a package that isn't installed
2. **External Services**: The test needs access to an external service or API
3. **Platform-Specific**: The test may only run on certain platforms
4. **Resource Intensive**: The test requires significant resources

When reviewing skipped tests, look for skip markers or conditional logic that might indicate why a test is being skipped.

## Test Dependencies

The test dependencies are specified in the `pyproject.toml` file under the `[project.optional-dependencies]` section:

```toml
test = [
  "pytest>=7.0.0",
  "pytest-cov>=4.1.0",
  "pytest-mock>=3.10.0",
  "pytest-asyncio>=0.25.3",
  "twisted",
]
```

Install all test dependencies with:

```bash
make install-test
```

## Continuous Integration

The project's CI setup runs the tests in an environment that has all the required dependencies installed, including pytest-asyncio. This means that many of the tests that are skipped in a local development environment will run in CI.

## Future Improvements

To improve the testing experience:

1. Add explicit skip reasons to all skipped tests
2. Make tests more resilient to different environments
3. Move external API tests to a separate category that can be easily included/excluded
4. Improve the Makefile to automatically detect and install missing dependencies