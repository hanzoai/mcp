# Hanzo MCP Documentation

This directory contains documentation for the Hanzo MCP project.

## Documentation Structure

### Core Documentation
- [**INSTALL.md**](./INSTALL.md) - Installation and setup instructions
- [**TESTING.md**](./TESTING.md) - Testing guidelines and procedures
- [**MCP_SECURITY.md**](./MCP_SECURITY.md) - Security information and best practices
- [**SYSTEM_PROMPTS.md**](./SYSTEM_PROMPTS.md) - Guide to system prompts and their usage

### Integration Guides
- [**IDE_INTEGRATION.md**](./IDE_INTEGRATION.md) - Integrating with IDEs
- [**LIBRECHAT_INTEGRATION.md**](./guides/LIBRECHAT_INTEGRATION.md) - LibreChat integration
- [**MCP_SSE_CONNECTION_GUIDE.md**](./guides/MCP_SSE_CONNECTION_GUIDE.md) - SSE connection guide

### Prompt Libraries
- [**USEFUL_PROMPTS.md**](./USEFUL_PROMPTS.md) - Collection of useful prompts
- [**prompts/**](./prompts/) - System prompt templates for different use cases

### Building Documentation
- [**source/**](./source/) - Source files for Sphinx documentation
- [**Makefile**](./Makefile) and [**make.bat**](./make.bat) - Build scripts

### Media
- [**media/example.gif**](./media/example.gif) - Example usage animation

### Archived Files
- [**archive/**](./archive/) - Previous versions and outdated documentation

## Building the Documentation

You can build the documentation using the Makefile at the project root:

```bash
# From the project root
make docs
```

This will generate the HTML documentation in the `docs/build/html` directory.

## Viewing the Documentation Locally

To view the documentation in your browser, you can use the serve target:

```bash
# From the project root
make docs-serve
```

This will start a local web server at http://localhost:8000/. Open this URL in your browser to view the documentation.

## Adding New Documentation

1. Create a new Markdown (`.md`) file in the appropriate directory
2. Add the file to the table of contents in `source/index.rst` if needed
3. Update this README.md to reference the new documentation
4. Rebuild the documentation with `make docs`

## Documentation Format

The documentation uses Markdown with MyST extensions for easier writing. Sphinx converts these into HTML when building the documentation.
