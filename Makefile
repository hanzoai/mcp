.PHONY: all install install-dev install-test reinstall uninstall test test-cov lint format clean venv venv-check help docker-build docker-run docker-push build-package publish check-dependencies check-system check-python check-uv

# ANSI color codes
GREEN=$(shell tput -Txterm setaf 2)
YELLOW=$(shell tput -Txterm setaf 3)
RED=$(shell tput -Txterm setaf 1)
BLUE=$(shell tput -Txterm setaf 6)
RESET=$(shell tput -Txterm sgr0)

# Docker image variables
IMAGE_NAME ?= hanzoai/mcp
IMAGE_TAG ?= latest

# Variables
PYTHON_VERSION = 3.13
VENV_NAME ?= .venv

# Detect OS for proper path handling
ifeq ($(OS),Windows_NT)
	VENV_ACTIVATE = $(VENV_NAME)\Scripts\activate
	VENV_TEST = $(VENV_NAME)\Scripts\pytest.exe
	VENV_PYTHON = $(VENV_NAME)\Scripts\python.exe
	RM_CMD = rmdir /s /q
	CP = copy
	SEP = \\
	ACTIVATE_CMD = call
else
	VENV_ACTIVATE = $(VENV_NAME)/bin/activate
	VENV_TEST = $(VENV_NAME)/bin/pytest
	VENV_PYTHON = $(VENV_NAME)/bin/python
	RM_CMD = rm -rf
	CP = cp
	SEP = /
	ACTIVATE_CMD = .
endif

# Python interpreter and package manager
PYTHON = python

# Check if uv is available, otherwise use plain pip
UV := $(shell command -v uv 2> /dev/null)
ifeq ($(UV),)
	PACKAGE_CMD = pip install
	VENV_CMD = $(PYTHON) -m venv
else
	PACKAGE_CMD = uv pip install
	VENV_CMD = uv venv --python=python$(PYTHON_VERSION)
endif


# Project paths
SRC_DIR = hanzo_mcp
TEST_DIR = tests

# System & dependency checks
check-uv:
	@echo "$(YELLOW)Checking uv installation...$(RESET)"
	@if ! command -v uv > /dev/null; then \
		echo "$(YELLOW)uv not found. Installing uv...$(RESET)"; \
		pip install uv || { echo "$(RED)Failed to install uv. Please install it manually.$(RESET)"; exit 1; }; \
		echo "$(BLUE)uv installed successfully.$(RESET)"; \
	else \
		echo "$(BLUE)uv is installed.$(RESET)"; \
	fi

check-python:
	@echo "$(YELLOW)Checking Python $(PYTHON_VERSION) installation...$(RESET)"
	@if ! command -v python$(PYTHON_VERSION) > /dev/null; then \
		echo "$(YELLOW)Python $(PYTHON_VERSION) not found. Installing it using uv...$(RESET)"; \
		uv python install $(PYTHON_VERSION) || { echo "$(RED)Failed to install Python $(PYTHON_VERSION).$(RESET)"; exit 1; }; \
		echo "$(BLUE)Python $(PYTHON_VERSION) installed.$(RESET)"; \
	else \
		echo "$(BLUE)$$(python$(PYTHON_VERSION) --version) is installed.$(RESET)"; \
	fi

check-system:
	@echo "$(YELLOW)Checking system...$(RESET)"
	@if [ "$$(uname)" = "Darwin" ]; then \
		echo "$(BLUE)macOS detected.$(RESET)"; \
	elif [ "$$(uname)" = "Linux" ]; then \
		if [ -f "/etc/manjaro-release" ]; then \
			echo "$(BLUE)Manjaro Linux detected.$(RESET)"; \
		else \
			echo "$(BLUE)Linux detected.$(RESET)"; \
		fi; \
	elif [ "$$(uname -r | grep -i microsoft)" ]; then \
		echo "$(BLUE)Windows Subsystem for Linux detected.$(RESET)"; \
	else \
		echo "$(RED)Unsupported system detected. Please use macOS, Linux, or WSL.$(RESET)"; \
		exit 1; \
	fi

check-dependencies: check-system check-uv check-python
	@echo "$(GREEN)Dependencies checked successfully.$(RESET)"

# Create virtual environment
venv: check-python
	@echo "$(YELLOW)Creating virtual environment...$(RESET)"
	@$(VENV_CMD) $(VENV_NAME)
ifeq ($(OS),Windows_NT)
	@echo "Virtual environment created. Run '$(VENV_ACTIVATE)' to activate it."
else
	@echo "Virtual environment created. Run 'source $(VENV_ACTIVATE)' to activate it."
endif

install: venv-check
	@echo "$(YELLOW)Installing package...$(RESET)"
	@if [ -z "$${TZ}" ]; then \
		echo "Defaulting TZ (timezone) to UTC"; \
		export TZ="UTC"; \
	fi; \
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e "." || { \
		echo "$(YELLOW)Installation with uv failed. Trying with pip in development mode...$(RESET)"; \
		$(ACTIVATE_CMD) $(VENV_ACTIVATE) && pip install -e . || { \
			echo "$(RED)Installation failed. Check your pyproject.toml for deprecated configurations.$(RESET)"; \
			echo "$(YELLOW)Hint: If you're seeing license deprecation warnings, update the license format in pyproject.toml.$(RESET)"; \
			exit 1; \
		}; \
	};
	@echo "$(GREEN)Installation complete.$(RESET)"

uninstall: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PYTHON) -m pip uninstall -y mcp-claude-code

reinstall: uninstall install

install-dev: venv-check
	@echo "$(YELLOW)Installing development dependencies...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e ".[dev]" || $(ACTIVATE_CMD) $(VENV_ACTIVATE) && pip install -e ".[dev]"
	@echo "$(GREEN)Development dependencies installed.$(RESET)"

install-test: venv-check
	@echo "$(YELLOW)Installing test dependencies...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e ".[test]" || $(ACTIVATE_CMD) $(VENV_ACTIVATE) && pip install -e ".[test]"
	@echo "$(GREEN)Test dependencies installed.$(RESET)"

test: venv-check
	@echo "$(YELLOW)Running tests...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && python -m pytest $(TEST_DIR) --disable-warnings
	@echo "$(GREEN)Tests complete.$(RESET)"

test-cov: venv-check
	@echo "$(YELLOW)Running tests with coverage...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && python -m pytest --cov=$(SRC_DIR) $(TEST_DIR)
	@echo "$(GREEN)Tests with coverage complete.$(RESET)"

lint: venv-check
	@echo "$(YELLOW)Running linters...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && ruff check $(SRC_DIR) $(TEST_DIR)
	@echo "$(GREEN)Linting complete.$(RESET)"

format: venv-check
	@echo "$(YELLOW)Formatting code...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && ruff format $(SRC_DIR) $(TEST_DIR)
	@echo "$(GREEN)Formatting complete.$(RESET)"

clean:
	@echo "$(YELLOW)Cleaning caches...$(RESET)"
	$(RM_CMD) .pytest_cache htmlcov .coverage 2>nul || true
ifeq ($(OS),Windows_NT)
	for /d /r . %d in (__pycache__) do @if exist "%d" rd /s /q "%d"
else
	find . -name "__pycache__" -type d -exec rm -rf {} +
endif
	@echo "$(GREEN)Caches cleaned.$(RESET)"

# Helper to check for virtual environment
venv-check:
	@if [ ! -f $(VENV_ACTIVATE) ]; then \
		echo "$(YELLOW)Virtual environment not found. Creating one...$(RESET)" ; \
		$(MAKE) venv ; \
	fi



# Default target
all: install test
	@echo "$(GREEN)All tasks completed.$(RESET)"

### Build Python package (CLI) distribution
build-package: install
	@echo "$(YELLOW)Building package (Python CLI)...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && uv build
	@echo "$(GREEN)Package built. Distribution files are in 'dist/'$(RESET)"

### Publish package to PyPI (requires twine)
publish: build-package
	@echo "$(YELLOW)Publishing package...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && twine upload dist/*
	@echo "$(GREEN)Package published.$(RESET)"

# Docker targets
docker-build:
	@echo "$(YELLOW)Building Docker image...$(RESET)"
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) .
	@echo "$(GREEN)Docker image built: $(IMAGE_NAME):$(IMAGE_TAG)$(RESET)"

docker-push: docker-build
	@echo "$(YELLOW)Pushing Docker image...$(RESET)"
	docker push $(IMAGE_NAME):$(IMAGE_TAG)
	@echo "$(GREEN)Docker image pushed: $(IMAGE_NAME):$(IMAGE_TAG)$(RESET)"

docker-run:
	@echo "$(YELLOW)Running the app in Docker...$(RESET)"
	docker run -it --rm -v $(PWD):/app $(IMAGE_NAME):$(IMAGE_TAG)
	@echo "$(GREEN)Docker container stopped.$(RESET)"

# Help target
help:
	@echo "$(BLUE)Usage: make [target]$(RESET)"
	@echo "Targets:"
	@echo "  $(GREEN)all$(RESET)                 - Install dependencies, run tests"
	@echo "  $(GREEN)install$(RESET)             - Install dependencies"
	@echo "  $(GREEN)install-dev$(RESET)         - Install development dependencies"
	@echo "  $(GREEN)install-test$(RESET)        - Install test dependencies"
	@echo "  $(GREEN)uninstall$(RESET)           - Uninstall the package"
	@echo "  $(GREEN)reinstall$(RESET)           - Uninstall and reinstall the package"
	@echo "  $(GREEN)test$(RESET)                - Run tests"
	@echo "  $(GREEN)test-cov$(RESET)            - Run tests with coverage"
	@echo "  $(GREEN)lint$(RESET)                - Run linting"
	@echo "  $(GREEN)format$(RESET)              - Format code"
	@echo "  $(GREEN)clean$(RESET)               - Clean cache files"
	@echo "  $(GREEN)build-package$(RESET)       - Build Python package distribution"
	@echo "  $(GREEN)publish$(RESET)             - Publish package to PyPI"
	@echo "  $(GREEN)docker-build$(RESET)        - Build Docker image"
	@echo "  $(GREEN)docker-push$(RESET)         - Push Docker image"
	@echo "  $(GREEN)docker-run$(RESET)          - Run application in Docker"
	@echo "  $(GREEN)venv$(RESET)                - Create virtual environment"
	@echo "  $(GREEN)check-dependencies$(RESET)  - Check system dependencies"
	@echo "  $(GREEN)check-python$(RESET)        - Check Python installation"
	@echo "  $(GREEN)check-uv$(RESET)            - Check uv installation"
	@echo "  $(GREEN)help$(RESET)                - Show this help message"
