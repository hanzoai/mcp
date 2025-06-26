"""Tool palette system for organizing development tools."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from hanzo_mcp.tools.common.base import BaseTool


@dataclass
class ToolPalette:
    """A collection of tools for a specific development environment."""
    
    name: str
    description: str
    author: Optional[str] = None
    tools: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    environment: Dict[str, str] = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate palette configuration."""
        if not self.name:
            raise ValueError("Palette name is required")
        if not self.tools:
            raise ValueError("Palette must include at least one tool")


class PaletteRegistry:
    """Registry for tool palettes."""
    
    _palettes: Dict[str, ToolPalette] = {}
    _active_palette: Optional[str] = None
    
    @classmethod
    def register(cls, palette: ToolPalette) -> None:
        """Register a tool palette."""
        cls._palettes[palette.name] = palette
    
    @classmethod
    def get(cls, name: str) -> Optional[ToolPalette]:
        """Get a palette by name."""
        return cls._palettes.get(name)
    
    @classmethod
    def list(cls) -> List[ToolPalette]:
        """List all registered palettes."""
        return list(cls._palettes.values())
    
    @classmethod
    def set_active(cls, name: str) -> None:
        """Set the active palette."""
        if name not in cls._palettes:
            raise ValueError(f"Palette '{name}' not found")
        cls._active_palette = name
    
    @classmethod
    def get_active(cls) -> Optional[ToolPalette]:
        """Get the active palette."""
        if cls._active_palette:
            return cls._palettes.get(cls._active_palette)
        return None
    
    @classmethod
    def get_active_tools(cls) -> Set[str]:
        """Get the set of tools from the active palette."""
        palette = cls.get_active()
        if palette:
            return set(palette.tools)
        return set()


# Pre-defined palettes for famous programmers and ecosystems

# Python palette - Guido van Rossum style
python_palette = ToolPalette(
    name="python",
    description="Python development tools following Guido's philosophy",
    author="Guido van Rossum",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Python specific
        "uvx", "process",
        # Python tooling commands via uvx
        "ruff",      # Linting and formatting
        "black",     # Code formatting
        "mypy",      # Type checking
        "pytest",    # Testing
        "poetry",    # Dependency management
        "pip-tools", # Requirements management
        "jupyter",   # Interactive notebooks
        "sphinx",    # Documentation
    ],
    environment={
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
    }
)

# Ruby palette - Yukihiro Matsumoto (Matz) style
ruby_palette = ToolPalette(
    name="ruby",
    description="Ruby development tools for programmer happiness",
    author="Yukihiro Matsumoto",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Ruby specific
        "process",
        # Ruby tooling
        "rubocop",   # Linting
        "rspec",     # Testing
        "bundler",   # Dependency management
        "rake",      # Task automation
        "pry",       # REPL and debugging
        "yard",      # Documentation
        "rails",     # Web framework
    ],
    environment={
        "RUBYOPT": "-W:deprecated",
    }
)

# JavaScript/Node palette - Brendan Eich / Ryan Dahl style
javascript_palette = ToolPalette(
    name="javascript",
    description="JavaScript/Node.js development tools",
    author="Brendan Eich / Ryan Dahl",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # JavaScript specific
        "npx", "process",
        # JS tooling via npx
        "prettier",      # Code formatting
        "eslint",        # Linting
        "jest",          # Testing
        "webpack",       # Bundling
        "vite",          # Fast dev server
        "typescript",    # TypeScript compiler
        "create-react-app",  # React scaffolding
        "next",          # Next.js
    ],
    environment={
        "NODE_ENV": "development",
    }
)

# Go palette - Rob Pike / Ken Thompson style
go_palette = ToolPalette(
    name="go",
    description="Go development tools emphasizing simplicity",
    author="Rob Pike / Ken Thompson",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Go specific
        "process",
        # Go tooling
        "gofmt",     # Code formatting
        "golint",    # Linting
        "go",        # Compiler and tools
        "godoc",     # Documentation
        "delve",     # Debugger
    ],
    environment={
        "GO111MODULE": "on",
        "GOPROXY": "https://proxy.golang.org,direct",
    }
)

# Rust palette - Graydon Hoare style
rust_palette = ToolPalette(
    name="rust",
    description="Rust development tools for systems programming",
    author="Graydon Hoare",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Rust specific
        "process",
        # Rust tooling
        "cargo",     # Build system and package manager
        "rustfmt",   # Code formatting
        "clippy",    # Linting
        "rustdoc",   # Documentation
        "rust-analyzer",  # Language server
    ],
    environment={
        "RUST_BACKTRACE": "1",
    }
)

# DevOps palette - Infrastructure and operations
devops_palette = ToolPalette(
    name="devops",
    description="DevOps and infrastructure tools",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        "process", "open",
        # DevOps tooling
        "docker",        # Containerization
        "kubectl",       # Kubernetes
        "terraform",     # Infrastructure as code
        "ansible",       # Configuration management
        "helm",          # Kubernetes package manager
        "prometheus",    # Monitoring
        "grafana",       # Visualization
    ],
    environment={
        "DOCKER_BUILDKIT": "1",
    }
)

# Full stack palette - Everything enabled
fullstack_palette = ToolPalette(
    name="fullstack",
    description="All development tools enabled",
    tools=[
        # All filesystem tools
        "read", "write", "edit", "multi_edit", "grep", "tree", "find",
        "symbols", "git_search", "watch",
        # All shell tools
        "bash", "npx", "uvx", "process", "open",
        # All other tools
        "agent", "thinking", "llm", "mcp", "sql", "graph", "config",
        "todo", "jupyter", "vim",
    ]
)

# Minimal palette - Just the essentials
minimal_palette = ToolPalette(
    name="minimal",
    description="Minimal set of essential tools",
    tools=[
        "read", "write", "edit", "bash", "grep", "tree"
    ]
)

# Register all pre-defined palettes
def register_default_palettes():
    """Register all default tool palettes."""
    for palette in [
        python_palette,
        ruby_palette,
        javascript_palette,
        go_palette,
        rust_palette,
        devops_palette,
        fullstack_palette,
        minimal_palette,
    ]:
        PaletteRegistry.register(palette)