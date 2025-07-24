# Set test as the default target
.DEFAULT_GOAL := test

.PHONY: install test coverage lint clean dev venv build _publish publish setup bump-patch bump-minor bump-major publish-patch publish-minor publish-major tag-version docs docs-serve install-desktop build-dxt

# Virtual environment settings
VENV_NAME ?= .venv

# Define comma and space for list operations
COMMA := ,
SPACE := $(eval) $(eval)

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

# Create virtual environment using uv
venv:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(UV) venv $(VENV_NAME) --python=3.12

# Install the package
install: venv
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	. $(VENV_ACTIVATE) && $(UV) pip install -e ".[dev,test]"

uninstall:
	$(call run_in_venv, $(UV) pip uninstall -y hanzo-mcp)

reinstall: uninstall install

# Make test target depend on the venv existing
.venv:
	$(MAKE) venv

# Run tests, always ensure venv first
test: .venv
	$(call run_in_venv, python -m pytest $(TEST_DIR) -v --disable-warnings)

# Run tests with coverage
test-cov: install
	$(call run_in_venv, python -m pytest --cov=$(SRC_DIR) $(TEST_DIR))

# Lint code
lint: install
	$(call run_in_venv, ruff check $(SRC_DIR) $(TEST_DIR))

# Format code
format: install

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

# Documentation targets
docs: venv install-docs-deps
	@echo "$(YELLOW)Building documentation...$(NC)"
	$(call run_in_venv, cd docs && python -m sphinx -M html . _build)
	@echo "$(GREEN)Documentation built successfully! Open docs/_build/html/index.html$(NC)"

docs-serve: docs
	@echo "$(YELLOW)Starting documentation server on http://localhost:8000...$(NC)"
	@cd docs/_build/html && python -m http.server 8000

docs-clean:
	@echo "$(YELLOW)Cleaning documentation build...$(NC)"
	@rm -rf docs/_build
	@echo "$(GREEN)Documentation cleaned!$(NC)"

install-docs-deps: venv
	@echo "$(YELLOW)Installing documentation dependencies...$(NC)"
	$(call run_in_venv, $(UV) pip install -e ".[docs]")

# Update dependencies
update-deps:
	@command -v $(UV) >/dev/null 2>&1 || { echo "Error: uv is not installed. Install it with 'pip install uv'."; exit 1; }
	$(call run_in_venv, $(UV) pip compile pyproject.toml -o requirements.txt)

# Version bumping targets
bump-patch:
	@echo "Running version bump script (patch)..."
	$(call run_in_venv, python -m scripts.bump_version patch)

bump-minor:
	@echo "Running version bump script (minor)..."
	$(call run_in_venv, python -m scripts.bump_version minor)

bump-major:
	@echo "Running version bump script (major)..."
	$(call run_in_venv, python -m scripts.bump_version major)

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

# Install to Claude Desktop
# Usage: make install-desktop [ALLOWED_PATHS=/path1,/path2] [SERVER_NAME=hanzo] [DISABLE_WRITE=1] [DISABLE_SEARCH=1]
install-desktop: install
	@echo "Installing Hanzo MCP to Claude Desktop..."
	$(eval ALLOWED_PATHS ?= $(HOME))
	$(eval SERVER_NAME ?= hanzo)
	$(eval DISABLE_WRITE ?= )
	$(eval DISABLE_SEARCH ?= )
	$(call run_in_venv, python scripts/install_desktop.py "$(ALLOWED_PATHS)" "$(SERVER_NAME)" "$(DISABLE_WRITE)" "$(DISABLE_SEARCH)")
	@echo "Installation complete. Restart Claude Desktop for changes to take effect."

# Build DXT package for Claude Desktop
# Creates a .dxt file that can be installed by double-clicking
build-dxt: install
	@echo "Building Hanzo MCP Desktop Extension (.dxt)..."
	$(call run_in_venv, python dxt/build_dxt.py)
	@echo "DXT package built successfully. Check the dist/ directory."

# Display help information
help:
	@echo "Hanzo MCP Makefile Commands:"
	@echo ""
	@echo "Development:"
	@echo "  make               Run tests (default target)"
	@echo "  make setup         Setup everything at once"
	@echo "  make test          Run tests (installs test dependencies first)"
	@echo "  make coverage      Run test coverage report"
	@echo "  make lint          Run linting checks"
	@echo "  make format        Format code"
	@echo ""
	@echo "Installation:"
	@echo "  make install       Install dependencies and package"
	@echo "  make install-desktop [ALLOWED_PATHS=/path1,/path2] [SERVER_NAME=hanzo]  Install to Claude Desktop"
	@echo "  make build-dxt     Build .dxt package for easy Claude Desktop installation"
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
