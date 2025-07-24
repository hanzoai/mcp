# Hanzo AI Desktop Extension (DXT) Packaging

This directory contains the files needed to package Hanzo AI as a Desktop Extension (.dxt) file for easy installation in Claude Desktop.

## What is DXT?

Desktop Extensions (DXT) are a packaging format for MCP servers that allows:
- One-click installation in Claude Desktop
- Automatic dependency management
- Cross-platform compatibility
- Secure credential storage
- Easy distribution

## Files in this Directory

- `manifest.json` - Extension metadata and configuration
- `build_dxt.py` - Build script to create the .dxt package
- `README.md` - This file

## Building a DXT Package

To build a .dxt file, run:

```bash
make build-dxt
```

This will:
1. Package the Hanzo AI Python code
2. Include the manifest.json with tool definitions
3. Add installation scripts for all platforms
4. Create a .dxt file in the `dist/` directory

## Installing the DXT File

Users can install the Hanzo AI extension by:

1. **Double-clicking** the .dxt file
2. **Drag and drop** into Claude Desktop's extension manager
3. **Using the extension manager** in Claude Desktop settings

## Manifest Configuration

The `manifest.json` file defines:
- Extension metadata (name, version, description)
- Runtime requirements (Python version)
- Required permissions (filesystem, network, execute)
- Available tools and their categories
- Configuration options (allowed paths, feature flags)

## Development Notes

When updating the extension:
1. Modify tool definitions in `manifest.json` if tools change
2. Update version number (handled automatically by build script)
3. Test the .dxt file installation on all platforms
4. Ensure all dependencies are properly specified

## Distribution

The generated .dxt files can be:
- Uploaded to GitHub releases
- Distributed via the Desktop Extensions Hub
- Shared directly with users
- Installed from local filesystem

## Security Considerations

The DXT format includes:
- Permission declarations for transparency
- Sandboxed execution environment
- Secure credential storage via OS keychain
- Code signing support (future enhancement)

## Troubleshooting

If the .dxt build fails:
1. Ensure all dependencies are installed: `make install`
2. Check that the virtual environment is activated
3. Verify the manifest.json is valid JSON
4. Check file permissions in the project directory

For more information about Desktop Extensions, see:
https://desktop-extensions.com
