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

install-test: 
	$(UV) pip install -e ".[test]"

test:
	pytest $(TEST_DIR) --disable-warnings

test-cov:
	pytest --cov=$(SRC_DIR) $(TEST_DIR)

lint:
	ruff check $(SRC_DIR) $(TEST_DIR)

format:
	ruff format $(SRC_DIR) $(TEST_DIR)

clean:
	rm -rf .pytest_cache htmlcov .coverage
	find . -name "__pycache__" -type d -exec rm -rf {} +

# Default target
all: test
