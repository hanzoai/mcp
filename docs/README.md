# Hanzo MCP Documentation

This directory contains the source files for the Hanzo MCP documentation, which is published at [mcp.hanzo.ai](https://mcp.hanzo.ai).

## Documentation Structure

### Core Documentation
- [**INSTALL.md**](./INSTALL.md) - Installation and setup instructions
- [**TESTING.md**](./TESTING.md) - Testing guidelines and procedures
- [**MCP_SECURITY.md**](./MCP_SECURITY.md) - Security information and best practices
- [**SYSTEM_PROMPTS.md**](./SYSTEM_PROMPTS.md) - Guide to system prompts and their usage
- [**TOOLS_DOCUMENTATION.md**](../TOOLS_DOCUMENTATION.md) - Complete tool reference

### New Sphinx Documentation
- `getting-started/` - Installation and quick start guides
- `concepts/` - Core concepts and philosophy
- `tools/` - Detailed tool documentation
- `advanced/` - Advanced usage and customization
- `guides/` - Integration and workflow guides
- `reference/` - API and CLI reference

### Integration Guides
- [**IDE_INTEGRATION.md**](./IDE_INTEGRATION.md) - Integrating with IDEs
- [**LIBRECHAT_INTEGRATION.md**](./guides/LIBRECHAT_INTEGRATION.md) - LibreChat integration
- [**MCP_SSE_CONNECTION_GUIDE.md**](./guides/MCP_SSE_CONNECTION_GUIDE.md) - SSE connection guide

### Prompt Libraries
- [**USEFUL_PROMPTS.md**](./USEFUL_PROMPTS.md) - Collection of useful prompts
- [**prompts/**](./prompts/) - System prompt templates for different use cases

### Media
- [**media/example.gif**](./media/example.gif) - Example usage animation

## Building the Documentation

You can build the documentation using the Makefile at the project root:

```bash
# From the project root
make docs
```

This will generate the HTML documentation in the `docs/_build/html` directory.

## Viewing the Documentation Locally

To view the documentation in your browser, you can use the serve target:

```bash
# From the project root
make docs-serve
```

This will start a local web server at http://localhost:8000/. Open this URL in your browser to view the documentation.

## Deployment to Cloudflare Pages

Documentation is automatically deployed to [mcp.hanzo.ai](https://mcp.hanzo.ai) when changes are pushed to the main branch.

### Cloudflare Pages Setup

1. Connect your GitHub repository to Cloudflare Pages
2. Set the build command: `./build-docs.sh`
3. Set the build output directory: `docs/_build/html`
4. Configure custom domain: `mcp.hanzo.ai`

### Required Environment Variables

Set these in your GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token with Pages permissions
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

## Writing Documentation

We use Sphinx with MyST parser for Markdown support. You can write documentation in either:

- `.rst` files (reStructuredText)
- `.md` files (Markdown with MyST extensions)

### Adding New Documentation

1. Create a new file in the appropriate directory (`.rst` or `.md`)
2. Add the file to the table of contents in `index.rst`
3. Update this README.md to reference the new documentation
4. Rebuild the documentation with `make docs`

## Theme and Styling

The documentation uses a customized Sphinx RTD theme with:

- Black background for Hanzo branding
- Inter font for consistency
- Custom CSS in `_static/custom.css`

## Documentation Standards

- Use clear, concise language
- Include code examples for all tools
- Provide both basic and advanced usage examples
- Cross-reference related tools and concepts
- Keep the table of contents organized and intuitive