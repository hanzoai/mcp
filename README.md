# Hanzo MCP - The Zen of Model Context Protocol

[![Documentation](https://img.shields.io/badge/docs-mcp.hanzo.ai-blue?style=for-the-badge)](https://mcp.hanzo.ai)
[![PyPI](https://img.shields.io/pypi/v/hanzo-mcp?style=for-the-badge)](https://pypi.org/project/hanzo-mcp/)
[![License](https://img.shields.io/github/license/hanzoai/mcp?style=for-the-badge)](https://github.com/hanzoai/mcp/blob/main/LICENSE)
[![Join our Discord](https://img.shields.io/discord/YOUR_DISCORD_ID?style=for-the-badge&logo=discord)](https://discord.gg/hanzoai)

## 🥷 One MCP to Rule Them All

**Start here. Add other MCPs later. Control everything through one opinionated interface.**

Hanzo MCP isn't just another Model Context Protocol server—it's **THE** MCP server. While others give you fragments, we give you the complete toolkit. One server that orchestrates all others, with the power to add, remove, and control any MCP server dynamically.

```bash
# Install and rule your development world
uvx hanzo-mcp
```

## 🎯 Why Hanzo MCP?

### The Problem with Other MCPs
- **Fragmented Experience**: Install 10 different MCPs for 10 different tasks
- **Inconsistent Interfaces**: Each MCP has its own conventions and quirks  
- **Limited Scope**: Most MCPs do one thing, leaving you to juggle multiple servers
- **No Orchestration**: No way to coordinate between different MCP servers

### The Hanzo Way
- **One Installation**: 65+ professional tools out of the box
- **Unified Philosophy**: Consistent, opinionated interface following Unix principles
- **MCP Orchestration**: Install and control other MCP servers through Hanzo
- **Swappable Opinions**: Don't like our way? Load a different palette and change everything

## 🚀 Features That Set Us Apart

### 🎨 Palette System - Opinions Are Just Configurations
```python
# Don't like our shell tools? Swap the palette
palette_load(palette="minimal")  # Just the essentials
palette_load(palette="pentesting")  # Security focused tools  
palette_load(palette="data-science")  # Jupyter, pandas, numpy focused
palette_load(palette="your-custom")  # Your tools, your way
```

### 🔌 MCP Server Orchestration
```python
# Add any MCP server dynamically
mcp_add(url="github.com/someone/their-mcp", alias="their")

# Use their tools through our unified interface
their_tool(action="whatever", params=...)

# Remove when done
mcp_remove(alias="their")
```

### 🛠️ 65+ Battle-Tested Tools

#### Intelligent Multi-Modal Search
- **search**: Combines grep, AST analysis, vector embeddings, and git history
- **symbols**: Find any code symbol across languages instantly
- **git_search**: Search through git history, branches, and commits

#### Advanced Development
- **agent**: Delegate complex tasks to specialized AI agents
- **llm**: Query multiple LLM providers with consensus
- **jupyter**: Full Jupyter notebook support
- **neovim**: Integrated Neovim for power users

#### File Operations That Just Work
- **edit/multi_edit**: Intelligent pattern-based editing
- **read/write**: Automatic encoding detection
- **tree**: Visual directory structures
- **watch**: Monitor file changes in real-time

#### Process & System Control  
- **run_command**: Secure command execution with timeout
- **processes**: Monitor and manage system processes
- **npx/uvx**: Package runners with background support

#### And So Much More
- Database tools (SQL, Graph)
- Vector search and indexing
- Todo management
- Configuration management
- MCP server management
- Statistical analysis
- Batch operations

## 🎯 The Zen of Hanzo

1. **One Tool, One Purpose** - Each tool does one thing exceptionally well
2. **Actions Over Tools** - Complex tools support multiple actions, not multiple interfaces
3. **Parallel by Default** - Run multiple operations concurrently
4. **Smart Fallbacks** - Automatically choose the best available backend
5. **Secure by Design** - Fine-grained permissions and audit trails
6. **Opinionated but Flexible** - Strong defaults with palette customization

## 🚀 Quick Start

### Installation

```bash
# Install globally with uvx (recommended)
uvx hanzo-mcp

# Or install with pip
pip install hanzo-mcp

# Or install from source for development
git clone https://github.com/hanzoai/mcp
cd mcp
make install
```

### Add to Claude Desktop

```bash
# Automatic installation
make install-desktop

# Or manual configuration
cat >> ~/Library/Application\ Support/Claude/claude_desktop_config.json << 'EOF'
{
  "mcpServers": {
    "hanzo": {
      "command": "uvx",
      "args": ["hanzo-mcp"]
    }
  }
}
EOF
```

### Your First Session

1. Open Claude Desktop
2. Start with `search` to explore any codebase
3. Use `tree` to understand structure  
4. Edit files with `edit` or `multi_edit`
5. Run commands with `run_command`
6. Add other MCP servers with `mcp_add`

## 🎨 Palette System

Palettes let you completely transform Hanzo MCP's behavior:

```python
# List available palettes
palette_list()

# Load a different personality
palette_load(palette="minimal")  # Just core tools
palette_load(palette="academic")  # Research and writing focused
palette_load(palette="devops")   # Infrastructure and deployment

# Create your own
palette_create(
    name="my-workflow",
    tools=["read", "write", "edit", "search", "my-custom-tool"],
    config={"editor": "vim", "search_backend": "ripgrep"}
)
```

## 🔌 MCP Orchestration

Hanzo MCP can manage other MCP servers:

```python
# Add any MCP server
mcp_add(url="github.com/modelcontextprotocol/servers/tree/main/postgres")

# List installed servers
mcp_stats()

# Use tools from other servers seamlessly
postgres_query(query="SELECT * FROM users")

# Remove when done
mcp_remove(alias="postgres")
```

## 📊 Advanced Features

### Intelligent Search
```python
# Multi-modal search across your codebase
results = search(
    query="authentication",
    include_git=True,      # Search git history
    include_vector=True,   # Semantic search
    include_ast=True,      # AST symbol search
    parallel=True          # Search all modes concurrently
)
```

### Agent Orchestration  
```python
# Delegate complex tasks to specialized agents
agent(
    task="Refactor this codebase to use async/await",
    files=["src/**/*.py"],
    instructions="Maintain backwards compatibility"
)
```

### Consensus LLM Queries
```python
# Query multiple LLMs and get consensus
llm(
    action="consensus",
    prompt="Is this code secure?",
    providers=["openai", "anthropic", "google"],
    threshold=0.8
)
```

## 🏗️ Architecture

Built on modern Python with:
- **FastMCP**: High-performance MCP framework
- **UV**: Lightning-fast Python package management
- **Parallel Execution**: Concurrent operations by default
- **Smart Backends**: Automatic selection of best available tools
- **Type Safety**: Full type hints and validation

## 🤝 Contributing

We welcome contributions! The codebase is designed for extensibility:

1. **Add a Tool**: Drop a file in `hanzo_mcp/tools/`
2. **Create a Palette**: Define tool collections and configurations
3. **Improve Existing Tools**: Each tool is independently testable

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📚 Documentation

- **[Quick Start Guide](https://mcp.hanzo.ai/quickstart)** - Get running in 5 minutes
- **[Tool Reference](https://mcp.hanzo.ai/tools)** - Detailed documentation for all 65+ tools  
- **[Palette System](https://mcp.hanzo.ai/palettes)** - Customize your experience
- **[MCP Orchestration](https://mcp.hanzo.ai/orchestration)** - Control other MCP servers
- **[Best Practices](https://mcp.hanzo.ai/best-practices)** - Tips from power users

## 🌟 Why Developers Choose Hanzo MCP

> "I replaced 12 different MCP servers with just Hanzo. The palette system means I can switch contexts instantly—from web dev to data science to DevOps." - *Power User*

> "The agent orchestration is incredible. I can delegate entire refactoring tasks and it just works." - *Sr. Engineer*

> "Finally, an MCP that thinks like a developer. Smart defaults, great errors, and everything is parallel." - *Tech Lead*

## 📈 Stats

- **65+** Professional Tools
- **10x** Faster than installing multiple MCPs
- **1** Unified interface to rule them all
- **∞** Possibilities with the palette system

## 📄 License

MIT - Use it, extend it, make it yours.

## 🔗 Links

- [GitHub](https://github.com/hanzoai/mcp)
- [Documentation](https://mcp.hanzo.ai)
- [PyPI](https://pypi.org/project/hanzo-mcp/)
- [Discord Community](https://discord.gg/hanzoai)
- [Report Issues](https://github.com/hanzoai/mcp/issues)

---

<p align="center">
  <b>The Zen of Hanzo MCP</b><br>
  <i>One server. All tools. Your way.</i><br><br>
  <code>uvx hanzo-mcp</code>
</p>