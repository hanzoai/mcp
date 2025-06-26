#!/bin/bash
# Build script for Cloudflare Pages

# Install Python dependencies
pip install sphinx sphinx-rtd-theme myst-parser sphinx-copybutton

# Install the package
pip install -e .

# Build documentation
cd docs
python -m sphinx -M html . _build -W --keep-going

# Create redirects for Cloudflare Pages
echo "/* /index.html 200" > _build/html/_redirects

# Copy headers file
cp _headers _build/html/

echo "Documentation built successfully!"