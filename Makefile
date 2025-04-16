# Set test as the default target
.DEFAULT_GOAL := test

.PHONY: install test lint clean dev venv build _publish publish setup bump-patch bump-minor bump-major publish-patch publish-minor publish-major tag-version docs docs-serve

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
all: setup

setup: install-python venv install

# Install Python using uv
install-python:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(UV) python install 3.12

# Create virtual environment using uv and install package
venv:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(UV) venv $(VENV_NAME) --python=3.12
	$(call run_in_venv, $(UV) pip install -e ".")

# Install the package
install:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip install -e ".")

uninstall:
	$(call run_in_venv, $(UV) pip uninstall -y hanzo-mcp)

reinstall: uninstall install

# Install development dependencies
install-dev:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip install -e ".[dev]")

# Install test dependencies
install-test:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip install -e ".[test]")
	@# Ensure conftest.py exists with proper pytest-asyncio configuration
	@if [ ! -f "$(TEST_DIR)/conftest.py" ]; then \
		echo "Creating pytest configuration..."; \
		echo '"""Pytest configuration for the Hanzo MCP project."""\n\nimport pytest\nimport os\n\n# Set environment variables for testing\nos.environ["TEST_MODE"] = "1"\n\n# Configure pytest\ndef pytest_configure(config):\n    """Configure pytest."""\n    # Register asyncio marker\n    config.addinivalue_line(\n        "markers", "asyncio: mark test as using asyncio"\n    )\n    \n    # Configure pytest-asyncio\n    config._inicache["asyncio_default_fixture_loop_scope"] = "function"' > $(TEST_DIR)/conftest.py; \
	fi

# Run tests
test: install-test
	$(call run_in_venv, python -m pytest $(TEST_DIR) -v --disable-warnings)

# Quick test - run without installing dependencies (assumes they're already installed)
test-quick:
	$(call run_in_venv, python -m pytest $(TEST_DIR) -v --disable-warnings)

# Run tests with coverage
test-cov: install-test
	$(call run_in_venv, python -m pytest --cov=$(SRC_DIR) $(TEST_DIR))

# Lint code
lint: install-dev
	$(call run_in_venv, ruff check $(SRC_DIR) $(TEST_DIR))

# Format code
format: install-dev
	$(call run_in_venv, ruff format $(SRC_DIR) $(TEST_DIR))

# Fix common test issues (automatically adds asyncio imports and fixes test patterns)
fix-tests: install-test
	@echo "Fixing async test issues..."
	@for file in $$(find $(TEST_DIR) -name "*.py" -type f); do \
		if grep -q "async def" "$$file" && ! grep -q "import asyncio" "$$file"; then \
			echo "Adding asyncio import to $$file"; \
			sed -i '1,10 s/^import pytest/import pytest\nimport asyncio/' "$$file"; \
		fi; \
		if grep -q "async def _async_test" "$$file"; then \
			echo "Converting manual async wrapper to pytest.mark.asyncio in $$file"; \
			sed -i 's/def test_\([a-zA-Z0-9_]*\).*:\n.*async def _async_test.*:/@pytest.mark.asyncio\nasync def test_\1():/' "$$file"; \
			sed -i '/loop = asyncio.new_event_loop()/,/asyncio.set_event_loop(None)/d' "$$file"; \
		fi; \
	done
	@echo "Removing backup files..."
	@find $(TEST_DIR) -name "*.bak" -delete

# Documentation targets
docs: install-dev
	$(call run_in_venv, cd docs && make html)

# Start documentation server
docs-serve:
	$(call run_in_venv, cd docs && python -m http.server -d build/html)

# Clean documentation build
clean-docs:
	$(RM_CMD) docs/build 2>/dev/null || true

# Clean build artifacts
clean: clean-docs
	$(RM_CMD) .pytest_cache htmlcov .coverage $(DIST_DIR) 2>/dev/null || true
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Build package distribution files
build: clean install-publish
	$(call run_in_venv, python -m build)

# Install publish dependencies
install-publish:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip install -e ".[publish]")

# Publish package to PyPI
_publish:
ifdef PYPI_TOKEN
	$(call run_in_venv, TWINE_USERNAME=__token__ TWINE_PASSWORD=$(PYPI_TOKEN) python -m twine upload $(DIST_DIR)/*)
else
	$(call run_in_venv, python -m twine upload $(DIST_DIR)/*)
endif

# Publish package to Test PyPI
publish-test: build
ifdef PYPI_TOKEN
	$(call run_in_venv, TWINE_USERNAME=__token__ TWINE_PASSWORD=$(PYPI_TOKEN) python -m twine upload --repository testpypi $(DIST_DIR)/*)
else
	$(call run_in_venv, python -m twine upload --repository testpypi $(DIST_DIR)/*)
endif

# Check the package
check: build
	$(call run_in_venv, python -m twine check $(DIST_DIR)/*)

# Update dependencies
update-deps:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip compile pyproject.toml -o requirements.txt)

# Version bumping targets
bump-patch:
	@echo "Running version bump script (patch)..."
	@python -m scripts.bump_version patch

bump-minor:
	@echo "Running version bump script (minor)..."
	@python -m scripts.bump_version minor

bump-major:
	@echo "Running version bump script (major)..."
	@python -m scripts.bump_version major

# Tag creation and pushing
tag-version:
	@VERSION=$$(grep 'version =' pyproject.toml | sed 's/version = "\(.*\)"/\1/'); \
	echo "Creating git tag v$$VERSION"; \
	git tag -a "v$$VERSION" -m "Release v$$VERSION"; \
	echo "Pushing changes and tags to remote"; \
	git push origin main; \
	git push origin "v$$VERSION"

# Combined version bump and publish targets with tagging
publish: build _publish tag-version

patch: bump-patch build _publish tag-version

minor: bump-minor build _publish tag-version

major: bump-major build _publish tag-version

# Display help information
help:
	@echo "Hanzo MCP Makefile Commands:"
	@echo ""
	@echo "Development:"
	@echo "  make               Run tests (default target)"
	@echo "  make setup         Setup everything at once"
	@echo "  make test          Run tests (installs test dependencies first)"
	@echo "  make test-quick    Run tests quickly (without reinstalling dependencies)"
	@echo "  make test-cov      Run tests with coverage report"
	@echo "  make lint          Run linting checks"
	@echo "  make format        Format code"
	@echo "  make fix-tests     Fix common test issues automatically"
	@echo ""
	@echo "Installation:"
	@echo "  make install       Install the package"
	@echo "  make install-dev   Install development dependencies"
	@echo "  make install-test  Install test dependencies"
	@echo ""
	@echo "Documentation:"
	@echo "  make docs          Build documentation"
	@echo "  make docs-serve    Serve documentation locally"
	@echo ""
	@echo "Versioning:"
	@echo "  make bump-patch    Bump patch version"
	@echo "  make bump-minor    Bump minor version"
	@echo "  make bump-major    Bump major version"
	@echo ""
	@echo "Publishing:"
	@echo "  make publish       Build, publish, and tag version"
	@echo "  make publish-test  Publish to Test PyPI"
	@echo ""
	@echo "Cleaning:"
	@echo "  make clean         Clean build artifacts"
	@echo ""
	@echo "Note: This project requires 'uv' to be installed."
	@echo "      Install it with: pip install uv"