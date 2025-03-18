.PHONY: install test lint clean dev

# Python interpreter
PYTHON = python
# Path to package manager (uv or pip)
UV = uv

# Project paths
SRC_DIR = mcp_claude_code
TEST_DIR = tests

install:
	$(UV) pip install -e "."

install-dev: 
	$(UV) pip install -e ".[dev]"

test:
	pytest $(TEST_DIR)

test-cov:
	pytest --cov=$(SRC_DIR) $(TEST_DIR)

lint:
	ruff check $(SRC_DIR) $(TEST_DIR)

format:
	ruff format $(SRC_DIR) $(TEST_DIR)

clean:
	rm -rf .pytest_cache htmlcov .coverage
	find . -name "__pycache__" -type d -exec rm -rf {} +

# Dev setup with dependencies for CI
setup-ci:
	pip install pytest pytest-cov
	pip install -e ".[test]"

# Default target
all: test
