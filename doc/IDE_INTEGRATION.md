# IDE Integration with Hanzo MCP

This document explains how to use Hanzo MCP alongside an IDE or other external editor for an improved development workflow.

## Using `--disable-write-tools` Flag

Hanzo MCP provides a `--disable-write-tools` flag that disables all file writing and editing tools, allowing you to use your preferred IDE or editor for making changes while still using MCP for analysis, search, and exploration.

### What It Does

When the `--disable-write-tools` flag is enabled:

1. **Disabled Tools:**
   - `write_file`: Creating or overwriting files
   - `edit_file`: Making changes to existing files
   - `content_replace`: Finding and replacing text across files
   - `edit_notebook`: Editing Jupyter notebook cells

2. **Available Tools:**
   - All read-only filesystem tools (`read_files`, `directory_tree`, `get_file_info`, `search_content`)
   - Read-only Jupyter tools (`read_notebook`)
   - All shell tools (`run_command`, `run_script`, `script_tool`)
   - Project analysis tools
   - Thinking tool

> **Note:** Shell commands can still modify files even with this flag enabled. This is by design, as shell commands are necessary for many analysis operations.

### Using with Claude Desktop

You can configure Claude Desktop to use Hanzo MCP with write tools disabled:

```bash
hanzo-mcp --install --disable-write-tools
```

This will install a configuration in Claude Desktop that launches Hanzo MCP with write tools disabled.

### Using from Command Line

To start Hanzo MCP with write tools disabled:

```bash
hanzo-mcp --disable-write-tools
```

## Recommended Workflow

1. **Start Hanzo MCP with write tools disabled**:
   ```bash
   hanzo-mcp --disable-write-tools --project-dir /path/to/your/project
   ```

2. **Use Claude with Hanzo MCP for:**
   - Exploring and understanding code
   - Searching for patterns and usages
   - Analyzing project structure
   - Planning changes
   - Running commands or scripts

3. **Use your IDE or editor for:**
   - Making changes to files
   - Creating new files
   - Editing and running Jupyter notebooks
   - Refactoring code

This workflow combines the analytical strengths of Claude with the editing capabilities of your preferred development environment.

## Benefits

- **Better Editor Integration**: Use your familiar IDE features like syntax highlighting, auto-completion, and debugging
- **Version Control Integration**: Use your IDE's Git integration for staging, committing, and reviewing changes
- **Task Separation**: Let Claude focus on analysis and exploration while your IDE handles editing
- **Performance**: Reduce the number of MCP tools being registered for faster startup and operation

## Limitations

- Shell commands can still modify files, so be careful when running them through Claude
- You'll need to manually switch between Claude and your IDE when making changes
- Claude won't be able to see changes you've made in your IDE until you explicitly tell it to check the file again
