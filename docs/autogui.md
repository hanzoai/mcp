# AutoGUI Integration for Hanzo MCP

The AutoGUI integration provides comprehensive computer control capabilities through the Model Context Protocol (MCP). It supports multiple implementations with automatic fallback for cross-platform compatibility.

## Overview

AutoGUI allows AI assistants to:
- Control mouse movement, clicking, and dragging
- Simulate keyboard input and key combinations
- Take screenshots and perform image recognition
- Manage windows and applications
- Get pixel colors and screen information

## Supported Implementations

### 1. RustAutoGUI (Primary)
- **Source**: https://github.com/hanzoai/rustautogui
- **Performance**: Fastest, native performance
- **Platform**: Windows, macOS, Linux
- **Requirements**: RustAutoGUI binary in PATH or specified location

### 2. JSAutoGUI (Fallback)
- **Source**: https://github.com/hanzoai/jsautogui
- **Performance**: Good, native Node.js
- **Platform**: Windows, macOS, Linux
- **Requirements**: `npm install jsautogui`

### 3. PyAutoGUI (Fallback)
- **Performance**: Good, subprocess-based
- **Platform**: Windows, macOS, Linux
- **Requirements**: Python with `pyautogui` package

## Installation

### Basic Installation
The AutoGUI integration is included with Hanzo MCP but requires additional setup for each implementation.

### Install JSAutoGUI (Recommended)
```bash
npm install jsautogui
```

### Install PyAutoGUI
```bash
pip install pyautogui

# Optional for better window management
pip install pygetwindow
```

### Install RustAutoGUI
```bash
# Download from releases or build from source
# Place binary in PATH as 'rustautogui'
```

## Usage

### Enable AutoGUI Tools
```bash
# Start MCP server with AutoGUI enabled
hanzo-mcp serve --enable-autogui

# List available AutoGUI tools
hanzo-mcp list-tools --enable-autogui --category autogui
```

### Configuration
Configure AutoGUI through the `autogui_configure` tool or environment variables:

```javascript
// Configure implementation preference
{
  "tool": "autogui_configure",
  "arguments": {
    "implementation": "auto", // or "rust", "js", "python"
    "failsafe": true,
    "pause": 0.1,
    "log": true
  }
}
```

## Available Tools

### System & Configuration
- `autogui_status` - Get system status and available implementations
- `autogui_configure` - Configure settings and select implementation

### Screen Information
- `autogui_get_screen_size` - Get screen dimensions
- `autogui_get_screens` - Get information about all screens

### Mouse Control
- `autogui_get_mouse_position` - Get current cursor position
- `autogui_move_mouse` - Move cursor to position
- `autogui_click` - Click at position or current location
- `autogui_drag` - Drag from current or specific position
- `autogui_scroll` - Scroll at specific position

### Keyboard Control
- `autogui_type` - Type text
- `autogui_press_key` - Press individual keys
- `autogui_hotkey` - Press key combinations

### Screen Capture & Vision
- `autogui_screenshot` - Take screenshots
- `autogui_get_pixel` - Get pixel color at coordinates
- `autogui_locate_image` - Find images on screen

### Window Management
- `autogui_get_windows` - List open windows
- `autogui_control_window` - Control window state

### Utilities
- `autogui_sleep` - Pause execution

## Examples

### Take a Screenshot
```javascript
{
  "tool": "autogui_screenshot",
  "arguments": {}
}
```

### Click at Coordinates
```javascript
{
  "tool": "autogui_click",
  "arguments": {
    "x": 100,
    "y": 200,
    "button": "left"
  }
}
```

### Type Text
```javascript
{
  "tool": "autogui_type",
  "arguments": {
    "text": "Hello, World!",
    "interval": 0.05
  }
}
```

### Press Hotkey
```javascript
{
  "tool": "autogui_hotkey",
  "arguments": {
    "keys": ["ctrl", "c"]
  }
}
```

### Find Image on Screen
```javascript
{
  "tool": "autogui_locate_image",
  "arguments": {
    "image_path": "/path/to/button.png",
    "confidence": 0.8
  }
}
```

### Get Window Information
```javascript
{
  "tool": "autogui_get_windows",
  "arguments": {
    "title_filter": "Chrome"
  }
}
```

## Security & Safety

### Failsafe Mode
AutoGUI includes failsafe protection:
- Move mouse to any screen corner to abort operations
- Configurable pause between operations
- Error handling and validation

### Permissions
Some operations may require system permissions:
- **macOS**: Accessibility permissions for GUI automation
- **Linux**: X11 access for display control
- **Windows**: UAC elevation for certain operations

### Best Practices
1. Always test in safe environments first
2. Use reasonable pause intervals between operations
3. Implement proper error handling
4. Validate coordinates and image paths
5. Use confidence thresholds for image recognition

## Troubleshooting

### Implementation Not Available
```javascript
// Check which implementations are available
{
  "tool": "autogui_status",
  "arguments": {}
}
```

### Permission Denied
- macOS: Grant accessibility permissions in System Preferences
- Linux: Ensure proper X11 display access
- Windows: Run with appropriate privileges

### Image Recognition Issues
- Use high-quality, clear images
- Adjust confidence threshold (0.7-0.9)
- Ensure image format is supported (PNG recommended)
- Consider screen scaling differences

### Performance Issues
- Use RustAutoGUI for best performance
- Reduce pause intervals for faster execution
- Minimize screenshot operations
- Use region-based image searches

## Advanced Configuration

### Environment Variables
```bash
# Specify implementation preference
export AUTOGUI_IMPLEMENTATION=rust

# Set RustAutoGUI binary path
export RUSTAUTOGUI_PATH=/path/to/rustautogui

# Set Python path for PyAutoGUI
export PYTHON_PATH=/usr/bin/python3
```

### Implementation Fallback Order
```javascript
{
  "tool": "autogui_configure",
  "arguments": {
    "implementation": "auto",
    "fallbackOrder": ["rust", "js", "python"]
  }
}
```

## API Reference

All AutoGUI tools follow consistent patterns:
- Input validation using Zod schemas
- Standardized error handling
- Consistent coordinate systems (0,0 at top-left)
- Cross-platform compatibility
- Detailed response information

For detailed API documentation, use:
```bash
hanzo-mcp list-tools --enable-autogui --category autogui
```

## Contributing

To contribute to AutoGUI integration:
1. Follow existing adapter patterns in `/src/autogui/adapters/`
2. Implement all methods from `AutoGUIAdapter` interface
3. Add comprehensive error handling
4. Include platform-specific considerations
5. Update tool listings and documentation