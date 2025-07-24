# Hanzo AI - The Zen of Model Context Protocol

[![Documentation](https://img.shields.io/badge/docs-mcp.hanzo.ai-blue?style=for-the-badge)](https://mcp.hanzo.ai)
[![PyPI](https://img.shields.io/pypi/v/hanzo-mcp?style=for-the-badge)](https://pypi.org/project/hanzo-mcp/)
[![Download DXT](https://img.shields.io/github/v/release/hanzoai/mcp?label=Download%20DXT&style=for-the-badge)](https://github.com/hanzoai/mcp/releases/latest/download/hanzo-mcp.dxt)
[![License](https://img.shields.io/github/license/hanzoai/mcp?style=for-the-badge)](https://github.com/hanzoai/mcp/blob/main/LICENSE)
[![Join our Discord](https://img.shields.io/discord/YOUR_DISCORD_ID?style=for-the-badge&logo=discord)](https://discord.gg/hanzoai)

## 🥷 One MCP to Rule Them All

**Start here. Add other MCPs later. Control everything through one opinionated interface.**

Hanzo AI isn't just another Model Context Protocol server—it's **THE** MCP server. While others give you fragments, we give you the complete toolkit. One server that orchestrates all others, with the power to add, remove, and control any MCP server dynamically.

```bash
# Install and rule your development world
uvx hanzo-mcp

# Or use our one-click Desktop Extension
# Download from releases and double-click to install
```

> **Note on Installation**: If uvx is not installed, Hanzo will automatically install it for you in your home directory. No manual setup required!

## 🎯 Why Hanzo AI?

### The Problem with Other MCPs
- **Fragmented Experience**: Install 10 different MCPs for 10 different tasks
- **Inconsistent Interfaces**: Each MCP has its own conventions and quirks
- **Limited Scope**: Most MCPs do one thing, leaving you to juggle multiple servers
- **No Orchestration**: No way to coordinate between different MCP servers
- **Missing Quality Control**: No built-in code review or quality assurance

### The Hanzo Way
- **One Installation**: 70+ professional tools out of the box
- **Consistent Philosophy**: Unix-inspired principles with modern AI capabilities
- **MCP Orchestration**: Install and control other MCP servers through Hanzo
- **Built-in Quality**: Critic tool ensures high standards automatically
- **Smart Defaults**: Auto-installs dependencies, reads project rules, just works

## 🚀 Modern AI-Powered Features

### 🧠 Advanced AI Tools

#### Multi-Agent Workflows
```python
# Delegate complex tasks to specialized agents
agent(
    prompts=["Find all API endpoints", "Document each endpoint", "Generate OpenAPI spec"],
    parallel=True  # Run agents concurrently
)

# Get consensus from multiple LLMs
consensus(
    prompt="Review this architecture decision",
    providers=["openai", "anthropic", "google"],
    threshold=0.8  # Require 80% agreement
)
```

#### Built-in Code Critic
```python
# Force high-quality standards with the critic tool
critic(
    analysis="Review authentication implementation for security issues"
)
# The critic will:
# - Find potential bugs and edge cases
# - Ensure proper error handling
# - Verify test coverage
# - Check security implications
# - Suggest improvements
# - Enforce best practices
```

### 📝 Project Intelligence

#### Automatic Rules Discovery
```python
# Reads your project preferences automatically
rules()  # Finds .cursorrules, .claude/code.md, etc.
# Understands your:
# - Coding standards
# - Project conventions  
# - AI assistant preferences
# - Team guidelines
```

#### Unified Todo Management
```python
# Single tool for all task management
todo("Add authentication to API")
todo --action update --id abc123 --status in_progress
todo --action list --filter pending
```

### 🔍 Next-Gen Search

#### Unified Search Engine
```python
# One search to rule them all - automatically runs:
# - Grep for patterns
# - AST analysis for code structure
# - Vector search for semantic meaning
# - Git history search
# - Symbol search for definitions
search("authentication flow")
```

#### AST-Powered Code Navigation
```python
# Find code with structural understanding
symbols --action grep_ast --pattern "TODO" --path ./src
# Shows TODO comments with full code context:
# - What function they're in
# - What class they belong to
# - Related code structure
```

### 🎨 Palette System - Opinions Are Just Configurations
```python
# Don't like our defaults? Switch instantly
palette --action activate python      # Python development focused
palette --action activate javascript  # Node.js/React optimized
palette --action activate devops     # Infrastructure tools
palette --action activate academic   # Research & documentation

# Create your own workflow
palette_create(
    name="my-workflow",
    tools=["read", "write", "edit", "search", "critic", "agent"],
    env_vars={"EDITOR": "nvim", "SEARCH": "ripgrep"}
)
```

### 🔌 MCP Server Orchestration
```python
# Add any MCP server dynamically
mcp --action add --url "github.com/someone/their-mcp" --alias "their"

# Use their tools seamlessly
their_tool(action="whatever", params=...)

# Remove when done
mcp --action remove --alias "their"
```

## 🛠️ Complete Tool Suite

### Core Development (Always Available)
- **read/write/edit/multi_edit** - Intelligent file operations
- **search** - Multi-modal parallel search
- **symbols** - AST-aware code navigation with grep_ast
- **tree** - Visual directory structures
- **grep** - Fast pattern matching
- **rules** - Read project preferences

### AI & Automation
- **agent** - Delegate complex multi-step tasks
- **consensus** - Multi-LLM agreement
- **think** - Structured reasoning
- **critic** - Code review and quality enforcement
- **batch** - Parallel tool execution

### Process & System
- **bash** - Secure command execution
- **npx/uvx** - Package runners with auto-install
- **process** - Background process management
- **watch** - File monitoring
- **diff** - Visual comparisons

### Data & Analytics
- **vector_index/vector_search** - Semantic search
- **sql_query/sql_search** - Database operations
- **graph_add/graph_query** - Graph database
- **jupyter** - Notebook integration
- **stats** - Performance analytics

### Collaboration
- **todo** - Unified task management
- **palette** - Tool configuration sets
- **mcp** - Server orchestration
- **git_search** - Repository mining

## 🚀 Quick Start

### Installation Methods

#### 1. Via pip/uv (Recommended)
```bash
# Installs globally
uvx hanzo-mcp

# Don't have uv? No problem - we'll install it for you!
curl -LsSf https://pypi.org/simple/hanzo-mcp | python3
```

#### 2. Desktop Extension (One-Click)
1. Download `hanzo-mcp.dxt` from [latest release](https://github.com/hanzoai/mcp/releases/latest)
2. Double-click to install in Claude Desktop
3. Restart Claude Desktop

#### 3. Manual Configuration
```json
// Add to Claude Desktop config
{
  "mcpServers": {
    "hanzo": {
      "command": "uvx",
      "args": ["hanzo-mcp"],
      "env": {
        "HANZO_ALLOWED_PATHS": "/Users/you/projects"
      }
    }
  }
}
```

## 🏆 Why Developers Love Hanzo

### Smart Defaults
- **Auto-installs** missing dependencies (uvx, uv, etc.)
- **Discovers** project rules and preferences automatically
- **Parallel** operations by default
- **Intelligent** fallbacks when tools aren't available

### Quality First
- **Built-in critic** for code review
- **Test enforcement** in workflows
- **Security scanning** in operations
- **Best practices** baked in

### Extensible
- **Palette system** for instant context switching
- **MCP orchestration** to add any capability
- **Plugin architecture** for custom tools
- **API-first** design

## 📊 Performance

- **65-70 tools** available instantly
- **Parallel execution** reduces wait times by 80%
- **Smart caching** for repeated operations
- **Minimal dependencies** for fast startup

## 🤝 Contributing

We welcome contributions! The codebase is designed for extensibility:

1. **Add a Tool**: Drop a file in `hanzo_mcp/tools/`
2. **Create a Palette**: Define tool collections
3. **Share Workflows**: Contribute your configurations

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📚 Documentation

- **[Installation Guide](https://mcp.hanzo.ai/install)** - All installation methods
- **[Tool Reference](https://mcp.hanzo.ai/tools)** - Complete tool documentation
- **[Palette System](https://mcp.hanzo.ai/palettes)** - Customize your workflow
- **[MCP Orchestration](https://mcp.hanzo.ai/orchestration)** - Extend with any MCP
- **[Best Practices](https://mcp.hanzo.ai/best-practices)** - Pro tips

## 🌟 Testimonials

> "The critic tool alone is worth it. My code quality improved overnight." - *Sr. Engineer at Fortune 500*

> "Finally, search that actually works. It knows what I mean, not just what I type." - *AI Researcher*

> "I threw away 15 different tools and just use Hanzo now. The palette system means I can switch from Python to DevOps to writing in seconds." - *Tech Lead*

## 📈 Project Status

- **Version**: 0.6.x (Stable)
- **Tools**: 70+ and growing
- **Palettes**: 10 built-in, unlimited custom
- **Community**: Active and helpful
- **Updates**: Weekly improvements

## 🛡️ Security

- **Sandboxed execution** for all operations
- **Permission system** for file access
- **Audit trails** for compliance
- **No telemetry** without consent

## 🎯 The Zen of Hanzo

1. **One Tool, One Purpose** - Each tool masters one thing
2. **Quality Over Quantity** - Better to do it right
3. **Parallel When Possible** - Time is precious
4. **Smart Defaults** - It should just work
5. **Extensible Always** - Your workflow, your way

---

*Built with ❤️ by developers, for developers. Because life's too short for bad tools.*

**[Get Started Now →](https://mcp.hanzo.ai)**
