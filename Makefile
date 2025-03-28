.PHONY: install test lint clean dev venv help docker-build docker-run docker-push

# ANSI color codes
GREEN=$(shell tput -Txterm setaf 2)
YELLOW=$(shell tput -Txterm setaf 3)
RED=$(shell tput -Txterm setaf 1)
BLUE=$(shell tput -Txterm setaf 6)
RESET=$(shell tput -Txterm sgr0)

# Docker image variables
IMAGE_NAME ?= hanzoai/mcp
IMAGE_TAG ?= latest

# Virtual environment detection and activation
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
SRC_DIR = hanzo_mcp
TEST_DIR = tests

# Create virtual environment
venv:
	@echo "$(YELLOW)Creating virtual environment...$(RESET)"
	$(PYTHON) -m venv $(VENV_NAME)
ifeq ($(OS),Windows_NT)
	@echo "Virtual environment created. Run '$(VENV_ACTIVATE)' to activate it."
else
	@echo "Virtual environment created. Run 'source $(VENV_ACTIVATE)' to activate it."
endif

install: venv-check
	@echo "$(YELLOW)Installing package...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e "."
	@echo "$(GREEN)Installation complete.$(RESET)"

uninstall: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PYTHON) -m pip uninstall -y mcp-claude-code

reinstall: uninstall install

install-dev: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e ".[dev]"

install-test: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && $(PACKAGE_CMD) -e ".[test]"

test: venv-check
	@echo "$(YELLOW)Running tests...$(RESET)"
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && python -m pytest $(TEST_DIR) --disable-warnings
	@echo "$(GREEN)Tests complete.$(RESET)"

test-cov: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && python -m pytest --cov=$(SRC_DIR) $(TEST_DIR)

lint: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && ruff check $(SRC_DIR) $(TEST_DIR)

format: venv-check
	$(ACTIVATE_CMD) $(VENV_ACTIVATE) && ruff format $(SRC_DIR) $(TEST_DIR)

clean:
	$(RM_CMD) .pytest_cache htmlcov .coverage 2>nul || true
ifeq ($(OS),Windows_NT)
	for /d /r . %d in (__pycache__) do @if exist "%d" rd /s /q "%d"
else
	find . -name "__pycache__" -type d -exec rm -rf {} +
endif

# Helper to check for virtual environment
venv-check:
	@if [ ! -f $(VENV_ACTIVATE) ]; then \
		echo "Virtual environment not found. Creating one..." ; \
		$(MAKE) venv ; \
	fi



# Default target
all: test
	@echo "$(GREEN)All tasks completed.$(RESET)"

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
	@echo "  $(GREEN)all$(RESET)                 - Run tests and show completion message"
	@echo "  $(GREEN)install$(RESET)             - Install dependencies"
	@echo "  $(GREEN)install-dev$(RESET)         - Install development dependencies"
	@echo "  $(GREEN)install-test$(RESET)        - Install test dependencies"
	@echo "  $(GREEN)test$(RESET)                - Run tests"
	@echo "  $(GREEN)test-cov$(RESET)            - Run tests with coverage"
	@echo "  $(GREEN)lint$(RESET)                - Run linting"
	@echo "  $(GREEN)format$(RESET)              - Format code"
	@echo "  $(GREEN)clean$(RESET)               - Clean cache files"
	@echo "  $(GREEN)docker-build$(RESET)        - Build Docker image"
	@echo "  $(GREEN)docker-push$(RESET)         - Push Docker image"
	@echo "  $(GREEN)docker-run$(RESET)          - Run application in Docker"
	@echo "  $(GREEN)venv$(RESET)                - Create virtual environment"
	@echo "  $(GREEN)help$(RESET)                - Show this help message"
