# Hanzo MCP Documentation

This directory contains the Sphinx documentation for the Hanzo MCP project.

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

## Documentation Structure

- `source/`: Contains the source files for the documentation
  - `conf.py`: Sphinx configuration file
  - `index.rst`: Main index file that defines the documentation structure
  - `*.md`: Markdown files containing documentation content
- `build/`: Generated documentation (not tracked in git)
- `Makefile`: Used by Sphinx to build documentation

## Adding New Documentation

1. Create a new Markdown (`.md`) file in the `source/` directory
2. Add the file to the table of contents in `source/index.rst`
3. Rebuild the documentation with `make docs`

## Documentation Format

The documentation uses Markdown with MyST extensions for easier writing. Sphinx converts these into HTML when building the documentation.
