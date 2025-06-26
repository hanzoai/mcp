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
    description="Ruby development tools for programmer happiness by Yukihiro Matsumoto",
    author="Yukihiro Matsumoto",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Ruby specific
        "process",
        # Ruby tooling - optimized for happiness
        "ruby",          # Ruby interpreter
        "gem",           # Package manager
        "bundler",       # Dependency management
        "rake",          # Task automation
        "irb",           # Interactive Ruby
        "pry",           # Enhanced REPL and debugging
        "rubocop",       # Style guide enforcement
        "rspec",         # Behavior-driven testing
        "minitest",      # Lightweight testing
        "yard",          # Documentation generator
        "rails",         # Web application framework
        "sinatra",       # Lightweight web framework
        "sidekiq",       # Background processing
        "capistrano",    # Deployment automation
    ],
    environment={
        "RUBYOPT": "-W:deprecated",
        "BUNDLE_JOBS": "4",
        "BUNDLE_RETRY": "3",
    }
)

# JavaScript/Node palette - Brendan Eich / Ryan Dahl style
javascript_palette = ToolPalette(
    name="javascript",
    description="JavaScript/Node.js development tools by Brendan Eich / Ryan Dahl",
    author="Brendan Eich / Ryan Dahl",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # JavaScript specific
        "npx", "process",
        # Package managers
        "npm", "yarn", "pnpm", "bun",
        # Core tooling via npx
        "node",              # Node.js runtime
        "prettier",          # Code formatting
        "eslint",            # Linting and static analysis
        "typescript",        # TypeScript compiler
        "jest",              # Testing framework
        "vitest",            # Fast testing with Vite
        "playwright",        # End-to-end testing
        # Build tools
        "webpack",           # Module bundler
        "vite",              # Fast dev server and bundler
        "rollup",            # Module bundler
        "esbuild",           # Fast bundler
        # Frameworks and scaffolding
        "create-react-app",  # React scaffolding
        "create-next-app",   # Next.js scaffolding
        "nuxt",              # Vue.js framework
        "svelte",            # Component framework
    ],
    environment={
        "NODE_ENV": "development",
        "NPM_CONFIG_PROGRESS": "false",
        "FORCE_COLOR": "1",
    }
)

# Go palette - Rob Pike / Ken Thompson style
go_palette = ToolPalette(
    name="go",
    description="Go development tools emphasizing simplicity by Rob Pike / Ken Thompson",
    author="Rob Pike / Ken Thompson",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Go specific
        "process",
        # Go tooling - emphasizing simplicity
        "go",            # Compiler and standard tools (go build, go test, go mod)
        "gofmt",         # Code formatting
        "goimports",     # Import management
        "golangci-lint", # Modern linting (replaces golint)
        "godoc",         # Documentation
        "delve",         # Debugger (dlv)
        "go-outline",    # Code outline
        "guru",          # Code analysis
        "goreleaser",    # Release automation
    ],
    environment={
        "GO111MODULE": "on",
        "GOPROXY": "https://proxy.golang.org,direct",
        "GOSUMDB": "sum.golang.org",
        "CGO_ENABLED": "0",  # Rob Pike prefers pure Go when possible
    }
)

# Rust palette - Graydon Hoare style  
rust_palette = ToolPalette(
    name="rust",
    description="Rust development tools for systems programming by Graydon Hoare",
    author="Graydon Hoare",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Rust specific
        "process",
        # Rust tooling - all via cargo/rustup
        "cargo",         # Build system and package manager
        "rustfmt",       # Code formatting (cargo fmt)
        "clippy",        # Linting (cargo clippy)
        "rustdoc",       # Documentation (cargo doc)
        "rust-analyzer", # Language server
        "miri",          # Interpreter for unsafe code checking
        "rustup",        # Rust toolchain manager
        "sccache",       # Shared compilation cache
        "wasm-pack",     # WebAssembly workflow
    ],
    environment={
        "RUST_BACKTRACE": "1",
        "RUSTFLAGS": "-D warnings",
        "CARGO_INCREMENTAL": "1",
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

# C/C++ palette - Dennis Ritchie / Bjarne Stroustrup style
cpp_palette = ToolPalette(
    name="cpp",
    description="C/C++ development tools for systems programming by Dennis Ritchie / Bjarne Stroustrup",
    author="Dennis Ritchie / Bjarne Stroustrup",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # C/C++ specific
        "process",
        # Compilers and build systems
        "gcc", "clang", "g++", "clang++",
        "make", "cmake", "ninja",
        # Debugging and analysis
        "gdb", "lldb", "valgrind",
        "clang-format", "clang-tidy",
        # Package management
        "conan", "vcpkg",
        # Documentation
        "doxygen",
    ],
    environment={
        "CC": "clang",
        "CXX": "clang++",
        "CFLAGS": "-Wall -Wextra",
        "CXXFLAGS": "-Wall -Wextra -std=c++20",
    }
)

# Data Science palette - Scientific computing
datascience_palette = ToolPalette(
    name="datascience",
    description="Data science and machine learning tools",
    author="Scientific Computing Community",
    tools=[
        # Core tools
        "bash", "read", "write", "edit", "grep", "tree", "find",
        # Python for data science
        "uvx", "process", "jupyter",
        # Data science tooling via uvx/pip
        "pandas", "numpy", "scipy", "matplotlib", "seaborn",
        "scikit-learn", "tensorflow", "pytorch",
        "plotly", "bokeh", "streamlit",
        "dvc", "mlflow", "wandb",
        "black", "isort", "mypy",
    ],
    environment={
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "JUPYTER_ENABLE_LAB": "yes",
    }
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
        cpp_palette,
        datascience_palette,
        devops_palette,
        fullstack_palette,
        minimal_palette,
    ]:
        PaletteRegistry.register(palette)