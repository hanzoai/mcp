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

# Setup everything at once (default target)
all: setup

setup: install-python venv install

# Install Python using uv
install-python:
	$(UV) python install 3.12

# Create virtual environment using uv and install package
venv:
	$(UV) venv $(VENV_NAME) --python=3.12
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

# Install publish dependencies
install-publish:
	$(call run_in_venv, $(UV) pip install -e ".[publish]")

# Run tests
test: install-test
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

# Documentation targets
docs:
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