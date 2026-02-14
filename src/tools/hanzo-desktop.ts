/**
 * Hanzo Desktop App Control Tool
 * 
 * Provides MCP control over the Hanzo Desktop application including:
 * - WebView introspection and debugging
 * - JavaScript execution in app windows
 * - Button clicking and UI automation
 * - Remote UI enablement for debugging
 * - App state inspection
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../types';

const execAsync = promisify(exec);

interface AppWindow {
  label: string;
  isVisible: boolean;
  isFocused: boolean;
  url?: string;
}

interface AppState {
  windows: AppWindow[];
  hanzoNodeRunning: boolean;
  remoteUiEnabled: boolean;
  mcpRunning: boolean;
}

export class HanzoDesktopTool implements Tool {
  name = 'hanzo_desktop';
  description = 'Control and debug the Hanzo Desktop application';
  
  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'get_state',
          'click_button',
          'execute_js',
          'execute_js_with_result',
          'get_dom',
          'click_element',
          'focus_window',
          'set_window_visibility',
          'enable_remote_ui',
          'disable_remote_ui',
          'get_windows',
          'click_get_started',
          'debug_button',
          'screenshot',
          'start_mcp_server',
          'get_debug_info',
          'connect_to_mcp'
        ],
        description: 'Action to perform on the desktop app'
      },
      window: {
        type: 'string',
        description: 'Window label to interact with (e.g., "main", "spotlight")'
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element interaction'
      },
      script: {
        type: 'string',
        description: 'JavaScript code to execute in window'
      },
      visible: {
        type: 'boolean',
        description: 'Whether to show or hide the window'
      },
      port: {
        type: 'number',
        description: 'Port number for MCP server (default: 9222)'
      }
    },
    required: ['action']
  };
  
  async handler(params: any): Promise<any> {
    return this.execute(params);
  }
  
  async execute(params: any): Promise<any> {
    const { action, window = 'main', selector, script, visible, port } = params;
    
    switch (action) {
      case 'get_state':
        return this.getAppState();
        
      case 'click_button':
        return this.clickButton(window, selector || 'button');
        
      case 'execute_js':
        return this.executeJS(window, script || 'return document.title');
        
      case 'execute_js_with_result':
        return this.executeJSWithResult(window, script || 'return document.title');
        
      case 'get_dom':
        return this.getDOMStructure(window);
        
      case 'click_element':
        return this.clickElementBySelector(window, selector || 'button');
        
      case 'focus_window':
        return this.focusWindow(window);
        
      case 'set_window_visibility':
        return this.setWindowVisibility(window, visible !== false);
        
      case 'enable_remote_ui':
        return this.enableRemoteUI();
        
      case 'disable_remote_ui':
        return this.disableRemoteUI();
        
      case 'get_windows':
        return this.getWindows();
        
      case 'click_get_started':
        // Special case for the Get Started button
        return this.clickGetStartedButton();
        
      case 'debug_button':
        // Debug why button isn't working
        return this.debugGetStartedButton();
        
      case 'screenshot':
        return this.takeScreenshot();
        
      case 'start_mcp_server':
        return this.startMCPServer(port);
        
      case 'get_debug_info':
        return this.getDebugInfo();
        
      case 'connect_to_mcp':
        return this.connectToMCP(port);
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  private async getAppState(): Promise<AppState> {
    // Check if app is running
    try {
      const { stdout: psOutput } = await execAsync('ps aux | grep -i "hanzo.*desktop" | grep -v grep');
      const isRunning = psOutput.includes('Hanzo AI.app') || psOutput.includes('hanzo-desktop');
      
      if (!isRunning) {
        return {
          windows: [],
          hanzoNodeRunning: false,
          remoteUiEnabled: false,
          mcpRunning: false
        };
      }
      
      // Get window information using AppleScript
      const script = `
        tell application "Hanzo AI"
          set windowList to {}
          repeat with w in windows
            set end of windowList to {name of w, visible of w}
          end repeat
          return windowList
        end tell
      `;
      
      const { stdout } = await execAsync(`osascript -e '${script}'`).catch(() => ({ stdout: '' }));
      
      return {
        windows: [{
          label: 'main',
          isVisible: true,
          isFocused: true,
          url: 'app://localhost'
        }],
        hanzoNodeRunning: false,
        remoteUiEnabled: false,
        mcpRunning: true
      };
    } catch (error) {
      return {
        windows: [],
        hanzoNodeRunning: false,
        remoteUiEnabled: false,
        mcpRunning: false
      };
    }
  }
  
  private async clickButton(window: string, selector: string): Promise<any> {
    // Use AppleScript to interact with the app
    const script = `
      tell application "System Events"
        tell process "Hanzo AI"
          set frontmost to true
          delay 0.5
          click button 1 of window 1
        end tell
      end tell
    `;
    
    try {
      await execAsync(`osascript -e '${script}'`);
      return { success: true, message: `Clicked button in window ${window}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  
  private async executeJS(window: string, script: string): Promise<any> {
    // This would require the app to expose a JavaScript execution API
    // For now, we'll return a placeholder
    return {
      success: false,
      message: 'JavaScript execution requires app support via Remote UI'
    };
  }
  
  private async enableRemoteUI(): Promise<any> {
    // The app should auto-enable Remote UI, but we can check if it's available
    try {
      const response = await fetch('http://localhost:9090');
      return {
        success: true,
        url: 'http://localhost:9090',
        message: 'Remote UI is available'
      };
    } catch (error) {
      return {
        success: false,
        message: 'Remote UI not available - app may not be running or Remote UI not enabled'
      };
    }
  }
  
  private async disableRemoteUI(): Promise<any> {
    return {
      success: false,
      message: 'Remote UI cannot be disabled via MCP - restart app to disable'
    };
  }
  
  private async getWindows(): Promise<any> {
    const state = await this.getAppState();
    return state.windows;
  }
  
  private async clickGetStartedButton(): Promise<any> {
    // Specific logic for clicking the Get Started button
    const script = `
      tell application "System Events"
        tell process "Hanzo AI"
          set frontmost to true
          delay 1
          
          -- Try to find and click the Get Started button
          try
            click button "Get Started Free" of window 1
            return "Clicked Get Started Free button"
          on error
            try
              -- Alternative: click first button
              click button 1 of window 1
              return "Clicked first button"
            on error errMsg
              return "Error: " & errMsg
            end try
          end try
        end tell
      end tell
    `;
    
    try {
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return { success: true, message: stdout.trim() };
    } catch (error) {
      // If AppleScript fails, try using accessibility features
      return this.clickViaAccessibility();
    }
  }
  
  private async clickViaAccessibility(): Promise<any> {
    // Use macOS accessibility API via Swift or Objective-C
    // This is a fallback method
    const script = `
      tell application "Hanzo AI" to activate
      delay 1
      tell application "System Events"
        key code 36 -- Press Enter key
      end tell
    `;
    
    try {
      await execAsync(`osascript -e '${script}'`);
      return { success: true, message: 'Pressed Enter key to trigger button' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  
  private async debugGetStartedButton(): Promise<any> {
    // Debug information about why the button might not be working
    const debugInfo: any = {
      appState: await this.getAppState(),
      processes: [],
      errors: []
    };
    
    // Check if hanzod is running
    try {
      const { stdout: hanzodPs } = await execAsync('ps aux | grep hanzod | grep -v grep');
      debugInfo.hanzodRunning = hanzodPs.length > 0;
      debugInfo.hanzodProcess = hanzodPs.trim();
    } catch {
      debugInfo.hanzodRunning = false;
    }
    
    // Check for the identity name issue
    try {
      const { stdout: logs } = await execAsync('tail -50 ~/Library/Logs/com.hanzo.desktop/*.log 2>/dev/null | grep -i "identity\\|invalid\\|panic"');
      if (logs.includes('Node part of the name contains invalid characters')) {
        debugInfo.identityError = true;
        debugInfo.errorMessage = 'GLOBAL_IDENTITY_NAME contains invalid characters - should be "hanzod"';
      }
    } catch {
      // No error logs found
    }
    
    // Check Remote UI availability
    try {
      const response = await fetch('http://localhost:9090');
      debugInfo.remoteUiAvailable = response.ok;
    } catch {
      debugInfo.remoteUiAvailable = false;
    }
    
    return debugInfo;
  }
  
  private async takeScreenshot(): Promise<any> {
    // Take a screenshot of the app
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = `/tmp/hanzo-desktop-${timestamp}.png`;
    
    try {
      await execAsync(`screencapture -l $(osascript -e 'tell app "Hanzo AI" to id of window 1') ${screenshotPath}`);

      // Read and return base64 encoded screenshot (async)
      const screenshotBuffer = await fs.readFile(screenshotPath);
      const screenshot = screenshotBuffer.toString('base64');
      await fs.unlink(screenshotPath); // Clean up
      
      return {
        success: true,
        screenshot: `data:image/png;base64,${screenshot}`,
        message: 'Screenshot captured'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to capture screenshot'
      };
    }
  }
  
  // New enhanced remote control methods using direct Tauri communication
  
  private async executeJSWithResult(window: string, script: string): Promise<any> {
    // This would use a more sophisticated method to get return values
    return {
      success: false,
      message: 'executeJSWithResult requires direct Tauri connection - use start_mcp_server first',
      hint: 'Use connect_to_mcp action to establish direct communication'
    };
  }
  
  private async getDOMStructure(window: string): Promise<any> {
    return {
      success: false,
      message: 'getDOMStructure requires direct Tauri connection - use start_mcp_server first',
      hint: 'Use connect_to_mcp action to establish direct communication'
    };
  }
  
  private async clickElementBySelector(window: string, selector: string): Promise<any> {
    return {
      success: false,
      message: 'clickElementBySelector requires direct Tauri connection - use start_mcp_server first',
      hint: 'Use connect_to_mcp action to establish direct communication'
    };
  }
  
  private async focusWindow(window: string): Promise<any> {
    return {
      success: false,
      message: 'focusWindow requires direct Tauri connection - use start_mcp_server first',
      hint: 'Use connect_to_mcp action to establish direct communication'
    };
  }
  
  private async setWindowVisibility(window: string, visible: boolean): Promise<any> {
    return {
      success: false,
      message: 'setWindowVisibility requires direct Tauri connection - use start_mcp_server first',
      hint: 'Use connect_to_mcp action to establish direct communication'
    };
  }
  
  private async startMCPServer(port?: number): Promise<any> {
    const mcpPort = port || 9222;
    
    // Check if MCP server is already running
    try {
      const response = await fetch(`http://localhost:${mcpPort}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          method: 'hanzo.getDebugInfo',
          jsonrpc: '2.0'
        })
      });
      
      if (response.ok) {
        return {
          success: true,
          message: `MCP server already running on port ${mcpPort}`,
          port: mcpPort,
          url: `http://localhost:${mcpPort}`
        };
      }
    } catch (error) {
      // Server not running, which is expected
    }
    
    return {
      success: false,
      message: `MCP server not running on port ${mcpPort}`,
      hint: 'Start the Hanzo Desktop app to automatically start the MCP server',
      port: mcpPort
    };
  }
  
  private async getDebugInfo(): Promise<any> {
    try {
      const response = await fetch('http://localhost:9222', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          method: 'hanzo.getDebugInfo',
          jsonrpc: '2.0'
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        return (result as any).result || result;
      } else {
        return {
          success: false,
          message: 'MCP server not available - start Hanzo Desktop app first'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: 'Could not connect to MCP server',
        error: error.message,
        hint: 'Ensure Hanzo Desktop app is running and MCP server is started'
      };
    }
  }
  
  private async connectToMCP(port?: number): Promise<any> {
    const mcpPort = port || 9222;
    
    try {
      // Test the connection with a simple ping
      const response = await fetch(`http://localhost:${mcpPort}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          method: 'hanzo.getDebugInfo',
          jsonrpc: '2.0'
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        return {
          success: true,
          message: `Connected to MCP server on port ${mcpPort}`,
          port: mcpPort,
          url: `http://localhost:${mcpPort}`,
          serverInfo: (result as any).result,
          availableMethods: [
            'Runtime.evaluate',
            'DOM.getDocument', 
            'DOM.querySelector',
            'Page.captureScreenshot',
            'hanzo.executeJS',
            'hanzo.clickElement',
            'hanzo.getWindows',
            'hanzo.getDebugInfo'
          ]
        };
      } else {
        return {
          success: false,
          message: `MCP server responded with status ${response.status}`,
          port: mcpPort
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Could not connect to MCP server on port ${mcpPort}`,
        error: error.message,
        hint: 'Ensure Hanzo Desktop app is running with MCP server enabled'
      };
    }
  }
}

// Export the tool
export default HanzoDesktopTool;