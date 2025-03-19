.PHONY: install test lint clean dev

# Python interpreter
PYTHON = python
# Path to package manager (uv or pip)
# Check if uv is available, otherwise use plain pip
UV := $(shell command -v uv 2> /dev/null)
ifeq ($(UV),)
	PACKAGE_CMD = pip install
else
	PACKAGE_CMD = $(UV) pip install
endif

# Project paths
SRC_DIR = mcp_claude_code
TEST_DIR = tests

install:
	$(PACKAGE_CMD) -e "."

uninstall:
	$(PYTHON) -m pip uninstall mcp-claude-code

install-dev: 
	$(PACKAGE_CMD) -e ".[dev]"

install-test: 
	$(PACKAGE_CMD) -e ".[test]"

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
