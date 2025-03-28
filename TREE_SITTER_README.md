# Tree-sitter Integration for Hanzo MCP

This update adds tree-sitter integration to Hanzo MCP for advanced code exploration capabilities.

## Features

- **Symbol Finding**: Locate definitions of variables, functions, classes, and methods
- **Reference Finding**: Discover where symbols are used throughout a codebase
- **AST Exploration**: Navigate and understand code structure via Abstract Syntax Trees
- **Symbolic Search**: Find related symbols and patterns across files

## Installation

1. Build the package
```bash
# Option 1: Use the provided build script
./build_local.sh

# Option 2: Use make
make build-package
```

2. Install with tree-sitter support
```bash
# Install the wheel with symbols support
./install_wheel.sh
```

## Testing the installation

Run the test script to verify the installation:
```bash
./test_hanzo_mcp.sh
```

## Available Symbol Tools

The following tools are available through the `dev` operation:

- `symbol_find`: Find symbol definitions in a file or directory
  ```
  await dev(ctx, operation="symbol_find", path="/path/to/file.py", symbol_name="MyClass")
  ```

- `symbol_references`: Find references to a symbol
  ```
  await dev(ctx, operation="symbol_references", path="/path/to/project", symbol_name="my_function", recursive=True)
  ```

- `ast_explore`: Explore and visualize AST
  ```
  await dev(ctx, operation="ast_explore", path="/path/to/file.py", output_format="structure")
  ```

- `ast_query`: Query AST using tree-sitter query language
  ```
  await dev(ctx, operation="ast_query", path="/path/to/file.py", query="(function_definition name: (identifier) @func)")
  ```

- `symbolic_search`: Perform symbolic search operations
  ```
  await dev(ctx, operation="symbolic_search", project_dir="/path/to/project", search_type="related_symbols", symbol_name="MyClass")
  ```

## Dependencies

This integration requires tree-sitter to be installed. It is configured as an optional dependency, so you can install it with:

```bash
pip install hanzo-mcp[symbols]
```

Or install everything with:

```bash
pip install hanzo-mcp[all]
```
