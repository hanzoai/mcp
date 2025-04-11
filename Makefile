.PHONY: install test lint clean dev venv build publish setup

# Virtual environment settings
VENV_NAME ?= .venv

# Detect OS for proper path handling
ifeq ($(OS),Windows_NT)
	VENV_ACTIVATE = $(VENV_NAME)\Scripts\activate
	PYTHON_BIN = $(VENV_NAME)\Scripts\python.exe
	RM_CMD = rmdir /s /q
	CP = copy
	SEP = \\
else
	VENV_ACTIVATE = $(VENV_NAME)/bin/activate
	PYTHON_BIN = $(VENV_NAME)/bin/python
	RM_CMD = rm -rf
	CP = cp
	SEP = /
endif

# Python and package management commands
UV = uv

# Project paths
SRC_DIR = hanzo_mcp
TEST_DIR = tests
DIST_DIR = dist

# Run commands in virtual environment
define run_in_venv
	. $(VENV_ACTIVATE) && $(1)
endef

# Setup everything at once
setup: install-python venv install

# Install Python using uv
install-python:
	$(UV) python install 3.13

# Create virtual environment using uv and install package
venv:
	$(UV) venv $(VENV_NAME) --python=3.13
	$(call run_in_venv, $(UV) pip install -e ".")

# Install the package
install:
	$(call run_in_venv, $(UV) pip install -e ".")

uninstall:
	$(call run_in_venv, $(UV) pip uninstall -y hanzo-mcp)

reinstall: uninstall install

# Install development dependencies
install-dev:
	$(call run_in_venv, $(UV) pip install -e ".[dev]")

# Install test dependencies
install-test:
	$(call run_in_venv, $(UV) pip install -e ".[test]")

# Run tests
test:
	$(call run_in_venv, python -m pytest $(TEST_DIR) --disable-warnings)

# Run tests with coverage
test-cov:
	$(call run_in_venv, python -m pytest --cov=$(SRC_DIR) $(TEST_DIR))

# Lint code
lint:
	$(call run_in_venv, ruff check $(SRC_DIR) $(TEST_DIR))

# Format code
format:
	$(call run_in_venv, ruff format $(SRC_DIR) $(TEST_DIR))

# Clean build artifacts
clean:
	$(RM_CMD) .pytest_cache htmlcov .coverage $(DIST_DIR) 2>/dev/null || true
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Build package distribution files
build:
	$(call run_in_venv, $(UV) pip build)

# Publish package to PyPI
publish: build
	$(call run_in_venv, $(UV) pip publish)

# Publish package to Test PyPI
publish-test: build
	$(call run_in_venv, $(UV) pip publish --repository testpypi)

# Update dependencies
update-deps:
	$(call run_in_venv, $(UV) pip compile pyproject.toml -o requirements.txt)

# Default target
all: setup test
