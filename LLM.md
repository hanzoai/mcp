# Hanzo MCP Project Documentation

## Project Overview

Hanzo MCP is an implementation of Hanzo capabilities using the Model Context Protocol (MCP). It provides an MCP server that enables Claude to directly execute instructions for modifying and improving project files. The implementation leverages the Model Context Protocol to facilitate seamless integration with various MCP clients, including Claude Desktop.

ALWAYS use `Makefile` for running commands as it uses `uv` to configure the venv
and otherwise deps will not be installed. most commands you would want just add
to Makefile or improve as necessary if missing.

## Architecture

### High-Level Architecture

```
┌───────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│                   │     │                  │     │                   │
│  Claude Desktop  ◄─────►  Hanzo MCP Server ◄─────►  Project Files    │
│  (MCP Client)     │     │                  │     │                   │
└───────────────────┘     └──────────────────┘     └───────────────────┘
                                   ▲
                                   │
                                   ▼
                          ┌──────────────────┐
                          │                  │
                          │  Tool Modules    │
                          │                  │
                          └──────────────────┘
```

### Core Components

1. **HanzoServer**: Main server class that initializes and manages the MCP communication
   - Registers all tools with the MCP framework
   - Manages permissions and contexts
   - Handles session state and working directories

2. **Tool Modules**: Specialized tools organized by functionality
   - Filesystem tools: File reading, writing, editing, and searching
   - Shell tools: Command execution and script running
   - Project tools: Analysis of project structure and dependencies
   - Jupyter tools: Notebook operations with cell handling
   - Agent tools: Delegation to sub-agents for concurrent operations
   - Common tools: Shared functionality including thinking tool and permissions

3. **Context and Permissions**: Security and session management
   - `DocumentContext`: Tracks file contents and allowed paths
   - `PermissionManager`: Controls access to filesystem operations
   - `CommandExecutor`: Executes shell commands with security constraints

### Module Structure

```
hanzo_mcp/
├── tools/                      # Tool implementations
│   ├── agent/                  # Agent delegation functionality
│   ├── common/                 # Shared components and utilities
│   ├── filesystem/             # File operation tools
│   ├── jupyter/                # Jupyter notebook tools
│   ├── project/                # Project analysis tools
│   └── shell/                  # Shell command execution tools
└── server.py                   # Main server implementation
└── cli.py                      # Command-line interface
```

## Design Patterns

### Tool Abstraction

Each tool follows a common interface pattern, making it easy to add new tools or modify existing ones.

### Command Pattern

Commands are executed through a unified execution framework:
- `CommandExecutor`: Central execution point with security checks
- Command implementations in `shell` module

### Permission Model

A robust permission system controls access to sensitive operations:
- Allowed paths must be explicitly defined
- File operations are restricted to allowed paths
- Shell commands are validated before execution

### Observer Pattern

The `PermissionManager` observes and controls access to system resources, ensuring security.

## Key Interfaces

### CLI Interface (`cli.py`)

Entry point for running the server with various configuration options:
- Transport protocol selection (stdio, sse)
- Allowed paths for file access
- Project directory setting
- Agent model configuration
- Tool enablement options (e.g., disabling write/edit tools for IDE integration)

### Server API (`server.py`)

Core server implementation with tool registration and execution handling:
- Tool registration through `register_all_tools`
- Context and permission management
- Agent configuration

### Tool Interfaces

Each tool category implements specific interfaces for its functionality:
- Filesystem tools: File reading, writing, and searching
- Shell tools: Command and script execution
- Project tools: Structure analysis
- Jupyter tools: Notebook operations

## Configuration Options

### Server Configuration

- **Transport Protocol**: Selectable between stdio and sse
- **Allowed Paths**: Restricted file access paths
- **Project Directory**: Initial working directory
- **Server Name**: Identifier for the MCP server

### Agent Configuration

- **Agent Model**: LiteLLM-compatible model specification
- **Token Limits**: Maximum tokens for agent responses
- **API Keys**: Provider-specific API keys
- **Iteration Limits**: Constraints on agent execution

## Security Considerations

- **Permission Prompts**: Required for file modifications and command execution
- **Path Restrictions**: Access limited to specified directories only
- **Input Validation**: Thorough validation of all inputs
- **Error Handling**: Proper error capturing and reporting

## Development Workflow

### Git Workflow

Follows GitHub Flow:
- Branch creation for features/fixes
- Atomic commits with meaningful messages
- Pull requests for code review
- Main branch always deployable

### Testing

Comprehensive testing suite with pytest:
- Unit tests for individual components
- Integration tests for tool interactions
- Async testing support for server operations

### Versioning

Automatic version management:
- Patch, minor, major version bumping
- Git tagging for releases
- PyPI publishing with version tracking
- Version defined in `hanzo_mcp/__init__.py` as `__version__`
- Version tool directly imports this value for consistency
- Build-time hooks ensure `__version__` is synchronized with `pyproject.toml`
- Scripts available for version management:
  - `scripts/update_version.py`: Updates `__init__.py` from `pyproject.toml`
  - `scripts/bump_version.py`: Bumps version in `pyproject.toml` and propagates to `__init__.py`

## Implementation Notes

### Tool Registration Process

All tools are registered with the MCP server through a centralized registration process:
1. `register_all_tools` in `__init__.py` coordinates registration
2. Each tool category has its own registration function
3. Tools receive necessary context and permission instances

### IDE Integration Support

The server can be configured to disable write/edit tools to allow integration with IDEs and other external editing tools:
1. Use the `--disable-write-tools` flag when starting the server
2. With this flag, only read-only filesystem and Jupyter notebook tools are registered
3. This allows using IDE tools (like Cursor or other AI-enabled editors) for making changes to files while still using MCP for analysis and exploration
4. Note that shell commands (`run_command`, `run_script`, `script_tool`) can still modify files even with this flag set, as they're necessary for various analysis operations

### Security Implementation

Security is implemented through multiple layers:
1. Allowed paths define boundaries for file operations
2. Permission checks prevent unauthorized access
3. Command validation prevents execution of dangerous commands
4. Input sanitization prevents injection attacks

### Agent Tool Implementation

The agent tool enables delegation to sub-agents:
1. Sub-agents are created with specific tool sets
2. They operate concurrently on separate tasks
3. Results are aggregated and returned to the main agent
4. Model selection allows customization of agent capabilities

## Project Insights

- **Modular Design**: Clear separation of concerns for maintainability
- **Security-First**: Strong emphasis on secure operations
- **Extensibility**: Easy to add new tools and capabilities
- **Integration**: Designed to work with Claude Desktop and other MCP clients
- **LLM Provider Flexibility**: Supports multiple LLM providers through LiteLLM

## Key Files

- `server.py`: Core server implementation
- `cli.py`: Command-line interface and entry point
- `tools/__init__.py`: Tool registration and coordination
- `tools/common/permissions.py`: Permission management
- `tools/common/context.py`: Document and session context
- `tools/shell/command_executor.py`: Command execution with security
- `tools/agent/agent_tool.py`: Agent delegation implementation

## Extension Points

When extending the project, consider these key areas:

1. **Adding New Tools**: Create a new tool module and register it in the appropriate category
2. **Enhancing Security**: Extend the permission model for finer-grained control
3. **Improving Agent Capabilities**: Enhance the agent tool with additional delegation patterns
4. **Adding New Shell Commands**: Extend command execution with new specialized commands
5. **Supporting New File Types**: Add handling for additional file formats

## Development Guidelines

- Follow the existing module structure for new additions
- Maintain strong typing with proper annotations
- Implement comprehensive tests for new functionality
- Document all public interfaces with clear docstrings
- Consider security implications for all operations
- Ensure backward compatibility when modifying existing tools

## User Commands

- /init: Investigate project structure and generate LLM.md
- /version: Display the current version of hanzo-mcp (implemented in `tools/common/version_tool.py`, reads version directly from `hanzo_mcp.__version__`)

## Version Checking Options

There are several ways to check the version of hanzo-mcp:

1. **Command-line flag**: Using the `--version` option
   ```
   python -m hanzo_mcp.cli --version
   ```

2. **Version subcommand**: Using the `version` subcommand
   ```
   python -m hanzo_mcp.cli version
   ```

3. **Version script**: Using the script in the scripts directory
   ```
   ./scripts/hanzo-mcp-version
   ```

4. **Version tool**: Using the version tool when the server is running
