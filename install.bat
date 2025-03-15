@echo off
setlocal enabledelayedexpansion

REM Ensure we're in the script's directory
cd /d "%~dp0"

REM Create virtual environment if it doesn't exist
if not exist .venv (
    echo Creating virtual environment...
    python -m venv .venv
)

REM Activate virtual environment
call .venv\Scripts\activate.bat

REM Install dependencies
echo Installing dependencies...
pip install -e .

REM Install the server in Claude Desktop
echo Installing in Claude Desktop...
python -m mcp_claude_code.cli --install --allow-path "%USERPROFILE%" --name "claude-code"

echo.
echo Installation complete!
echo You can now use the MCP Claude Code server in Claude Desktop.
echo Restart Claude Desktop for changes to take effect.

pause
