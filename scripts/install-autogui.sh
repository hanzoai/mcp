#!/bin/bash

# Hanzo MCP AutoGUI Installation Script
# Installs dependencies for computer control capabilities

echo "🤖 Installing AutoGUI dependencies for Hanzo MCP..."
echo ""

# Check OS
OS="$(uname -s)"
case "${OS}" in
    Linux*)     OS_TYPE=Linux;;
    Darwin*)    OS_TYPE=Mac;;
    CYGWIN*)    OS_TYPE=Windows;;
    MINGW*)     OS_TYPE=Windows;;
    *)          OS_TYPE="UNKNOWN:${OS}"
esac

echo "Detected OS: ${OS_TYPE}"
echo ""

# Install JSAutoGUI (Node.js)
echo "📦 Installing JSAutoGUI (Node.js implementation)..."
if command -v npm &> /dev/null; then
    npm install jsautogui --save-optional
    echo "✅ JSAutoGUI installed"
else
    echo "⚠️  npm not found, skipping JSAutoGUI"
fi
echo ""

# Install PyAutoGUI (Python)
echo "🐍 Installing PyAutoGUI (Python implementation)..."
if command -v pip3 &> /dev/null; then
    pip3 install pyautogui pillow opencv-python-headless
    echo "✅ PyAutoGUI installed"
elif command -v pip &> /dev/null; then
    pip install pyautogui pillow opencv-python-headless
    echo "✅ PyAutoGUI installed"
else
    echo "⚠️  pip not found, skipping PyAutoGUI"
fi
echo ""

# Install RustAutoGUI
echo "🦀 Installing RustAutoGUI (Rust implementation)..."
if command -v cargo &> /dev/null; then
    echo "Building from source..."
    git clone https://github.com/hanzoai/rustautogui.git /tmp/rustautogui 2>/dev/null || true
    cd /tmp/rustautogui
    cargo build --release
    
    # Copy binary to appropriate location
    if [ "${OS_TYPE}" = "Mac" ] || [ "${OS_TYPE}" = "Linux" ]; then
        sudo cp target/release/rustautogui /usr/local/bin/
        echo "✅ RustAutoGUI installed to /usr/local/bin/"
    else
        cp target/release/rustautogui.exe ~/bin/
        echo "✅ RustAutoGUI installed to ~/bin/"
    fi
    
    cd -
    rm -rf /tmp/rustautogui
else
    echo "⚠️  cargo not found, skipping RustAutoGUI"
    echo "   To install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi
echo ""

# OS-specific dependencies
if [ "${OS_TYPE}" = "Mac" ]; then
    echo "🍎 macOS specific setup..."
    echo "   You may need to grant accessibility permissions:"
    echo "   System Preferences > Security & Privacy > Privacy > Accessibility"
    echo "   Add Terminal/iTerm and any Node.js/Python executables"
elif [ "${OS_TYPE}" = "Linux" ]; then
    echo "🐧 Linux specific setup..."
    if command -v apt-get &> /dev/null; then
        echo "Installing X11 dependencies..."
        sudo apt-get update
        sudo apt-get install -y python3-tk python3-dev scrot xclip xdotool
    elif command -v yum &> /dev/null; then
        echo "Installing X11 dependencies..."
        sudo yum install -y python3-tkinter python3-devel scrot xclip xdotool
    fi
fi
echo ""

echo "✨ AutoGUI installation complete!"
echo ""
echo "Available implementations:"
command -v rustautogui &> /dev/null && echo "  ✅ RustAutoGUI (fastest)"
npm list jsautogui &> /dev/null 2>&1 && echo "  ✅ JSAutoGUI (Node.js)"
python3 -c "import pyautogui" &> /dev/null 2>&1 && echo "  ✅ PyAutoGUI (Python)"
echo ""
echo "To use AutoGUI tools in MCP:"
echo "  hanzo-mcp serve --enable-autogui"
echo ""
echo "To test AutoGUI status:"
echo "  hanzo-mcp list-tools --enable-autogui --category autogui"