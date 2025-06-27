#!/bin/bash
# Script to publish hanzo-mcp to PyPI

echo "🚀 Publishing hanzo-mcp v0.6.12 to PyPI..."
echo ""
echo "To publish, run:"
echo "  export PYPI_API_TOKEN='your-pypi-token'"
echo "  twine upload --username __token__ --password \$PYPI_API_TOKEN dist/*"
echo ""
echo "Or use ~/.pypirc configuration file"
echo ""
echo "The package files are ready in dist/:"
ls -la dist/