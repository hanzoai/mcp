/**
 * PyAutoGUI Adapter
 * Interfaces with PyAutoGUI through Python subprocess for cross-platform GUI automation
 */

import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseAutoGUIAdapter, AdapterUtils } from './base.js';
import {
  Point,
  Size,
  ScreenInfo,
  MouseButton,
  MouseClickOptions,
  MouseMoveOptions,
  MouseDragOptions,
  ScrollOptions,
  TypeOptions,
  KeyPressOptions,
  ScreenshotOptions,
  ImageSearchOptions,
  ImageMatch,
  WindowInfo,
  AutoGUIError,
  AutoGUINotAvailableError
} from '../types.js';

interface PyAutoGUICommand {
  action: string;
  params?: Record<string, any>;
}

interface PyAutoGUIResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export class PyAutoGUIAdapter extends BaseAutoGUIAdapter {
  private pythonPath: string | null = null;
  private pyautoguiScript: string | null = null;
  private version: string = 'unknown';

  constructor(config?: any) {
    super(config);
  }

  protected async initializeImplementation(): Promise<void> {
    await this.findPythonEnvironment();
    await this.createPyAutoGUIScript();
    await this.testPyAutoGUI();
  }

  private async findPythonEnvironment(): Promise<void> {
    const possiblePythonPaths = [
      'python3',
      'python',
      '/usr/bin/python3',
      '/usr/bin/python',
      '/usr/local/bin/python3',
      '/usr/local/bin/python',
      process.env.PYTHON_PATH
    ].filter(Boolean) as string[];

    for (const pythonPath of possiblePythonPaths) {
      try {
        const result = await this.executePythonCommand(
          'import pyautogui; print(pyautogui.__version__)',
          pythonPath
        );
        if (result.success) {
          this.pythonPath = pythonPath;
          this.version = result.data?.trim() || 'unknown';
          this.log(`Found Python with PyAutoGUI at: ${pythonPath}, version: ${this.version}`);
          return;
        }
      } catch (error) {
        // Continue searching
      }
    }

    throw new AutoGUINotAvailableError('python', new Error('Python with PyAutoGUI not found'));
  }

  private async createPyAutoGUIScript(): Promise<void> {
    const scriptContent = `
import sys
import json
import pyautogui
import time
import base64
from io import BytesIO

# Configure PyAutoGUI
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1

def handle_command(command):
    try:
        action = command.get('action')
        params = command.get('params', {})
        
        if action == 'get_screen_size':
            size = pyautogui.size()
            return {'success': True, 'data': {'width': size.width, 'height': size.height}}
            
        elif action == 'get_mouse_position':
            pos = pyautogui.position()
            return {'success': True, 'data': {'x': pos.x, 'y': pos.y}}
            
        elif action == 'move_to':
            x, y = params['x'], params['y']
            duration = params.get('duration', 0)
            pyautogui.moveTo(x, y, duration)
            return {'success': True}
            
        elif action == 'move_rel':
            x, y = params['x'], params['y']
            duration = params.get('duration', 0)
            pyautogui.moveRel(x, y, duration)
            return {'success': True}
            
        elif action == 'click':
            x = params.get('x')
            y = params.get('y')
            button = params.get('button', 'left')
            clicks = params.get('clicks', 1)
            pyautogui.click(x, y, clicks, button=button)
            return {'success': True}
            
        elif action == 'mouse_down':
            x = params.get('x')
            y = params.get('y')
            button = params.get('button', 'left')
            if x is not None and y is not None:
                pyautogui.moveTo(x, y)
            pyautogui.mouseDown(button=button)
            return {'success': True}
            
        elif action == 'mouse_up':
            x = params.get('x')
            y = params.get('y')
            button = params.get('button', 'left')
            if x is not None and y is not None:
                pyautogui.moveTo(x, y)
            pyautogui.mouseUp(button=button)
            return {'success': True}
            
        elif action == 'drag_to':
            x, y = params['x'], params['y']
            button = params.get('button', 'left')
            duration = params.get('duration', 0)
            pyautogui.dragTo(x, y, duration, button=button)
            return {'success': True}
            
        elif action == 'drag_rel':
            x, y = params['x'], params['y']
            button = params.get('button', 'left')
            duration = params.get('duration', 0)
            pyautogui.dragRel(x, y, duration, button=button)
            return {'success': True}
            
        elif action == 'scroll':
            x, y = params['x'], params['y']
            scrolls = params['scrolls']
            pyautogui.moveTo(x, y)
            pyautogui.scroll(scrolls)
            return {'success': True}
            
        elif action == 'type':
            text = params['text']
            interval = params.get('interval', 0)
            pyautogui.write(text, interval)
            return {'success': True}
            
        elif action == 'press':
            key = params['key']
            duration = params.get('duration', 0)
            modifiers = params.get('modifiers', [])
            
            if modifiers:
                pyautogui.hotkey(*modifiers, key)
            else:
                if duration > 0:
                    presses = max(1, int(duration * 10))
                    for _ in range(presses):
                        pyautogui.press(key)
                        time.sleep(0.05)
                else:
                    pyautogui.press(key)
            return {'success': True}
            
        elif action == 'key_down':
            key = params['key']
            pyautogui.keyDown(key)
            return {'success': True}
            
        elif action == 'key_up':
            key = params['key']
            pyautogui.keyUp(key)
            return {'success': True}
            
        elif action == 'hotkey':
            keys = params['keys']
            pyautogui.hotkey(*keys)
            return {'success': True}
            
        elif action == 'screenshot':
            bounds = params.get('bounds')
            if bounds:
                screenshot = pyautogui.screenshot(region=(bounds['x'], bounds['y'], bounds['width'], bounds['height']))
            else:
                screenshot = pyautogui.screenshot()
            
            # Convert to base64
            buffer = BytesIO()
            screenshot.save(buffer, format='PNG')
            image_data = base64.b64encode(buffer.getvalue()).decode()
            return {'success': True, 'data': {'image': image_data}}
            
        elif action == 'get_pixel':
            x, y = params['x'], params['y']
            pixel = pyautogui.pixel(x, y)
            return {'success': True, 'data': {'r': pixel[0], 'g': pixel[1], 'b': pixel[2]}}
            
        elif action == 'locate_on_screen':
            image_path = params['image_path']
            confidence = params.get('confidence', 0.8)
            region = params.get('region')
            
            try:
                if region:
                    region_tuple = (region['x'], region['y'], region['width'], region['height'])
                    location = pyautogui.locateOnScreen(image_path, confidence=confidence, region=region_tuple)
                else:
                    location = pyautogui.locateOnScreen(image_path, confidence=confidence)
                
                if location:
                    center = pyautogui.center(location)
                    return {
                        'success': True,
                        'data': {
                            'x': location.left,
                            'y': location.top,
                            'width': location.width,
                            'height': location.height,
                            'center_x': center.x,
                            'center_y': center.y,
                            'confidence': confidence
                        }
                    }
                else:
                    return {'success': False, 'error': 'Image not found'}
            except pyautogui.ImageNotFoundException:
                return {'success': False, 'error': 'Image not found'}
                
        elif action == 'locate_all_on_screen':
            image_path = params['image_path']
            confidence = params.get('confidence', 0.8)
            region = params.get('region')
            limit = params.get('limit', 10)
            
            try:
                if region:
                    region_tuple = (region['x'], region['y'], region['width'], region['height'])
                    locations = list(pyautogui.locateAllOnScreen(image_path, confidence=confidence, region=region_tuple))
                else:
                    locations = list(pyautogui.locateAllOnScreen(image_path, confidence=confidence))
                
                matches = []
                for location in locations[:limit]:
                    center = pyautogui.center(location)
                    matches.append({
                        'x': location.left,
                        'y': location.top,
                        'width': location.width,
                        'height': location.height,
                        'center_x': center.x,
                        'center_y': center.y,
                        'confidence': confidence
                    })
                
                return {'success': True, 'data': {'matches': matches}}
            except pyautogui.ImageNotFoundException:
                return {'success': True, 'data': {'matches': []}}
                
        elif action == 'get_active_window':
            # Limited window support in PyAutoGUI
            try:
                import pygetwindow as gw
                window = gw.getActiveWindow()
                if window:
                    return {
                        'success': True,
                        'data': {
                            'id': str(window._hWnd) if hasattr(window, '_hWnd') else 'active',
                            'title': window.title,
                            'x': window.left,
                            'y': window.top,
                            'width': window.width,
                            'height': window.height,
                            'visible': window.visible,
                            'minimized': window.isMinimized,
                            'maximized': window.isMaximized
                        }
                    }
                else:
                    return {'success': False, 'error': 'No active window'}
            except ImportError:
                return {'success': False, 'error': 'pygetwindow not available'}
                
        elif action == 'get_all_windows':
            try:
                import pygetwindow as gw
                windows = gw.getAllWindows()
                window_list = []
                for window in windows:
                    if window.title:  # Filter out empty titles
                        window_list.append({
                            'id': str(window._hWnd) if hasattr(window, '_hWnd') else str(hash(window.title)),
                            'title': window.title,
                            'x': window.left,
                            'y': window.top,
                            'width': window.width,
                            'height': window.height,
                            'visible': window.visible,
                            'minimized': window.isMinimized,
                            'maximized': window.isMaximized
                        })
                return {'success': True, 'data': {'windows': window_list}}
            except ImportError:
                return {'success': False, 'error': 'pygetwindow not available'}
                
        else:
            return {'success': False, 'error': f'Unknown action: {action}'}
            
    except Exception as e:
        return {'success': False, 'error': str(e)}

def main():
    try:
        # Read command from stdin
        command_line = sys.stdin.read().strip()
        if not command_line:
            return
            
        command = json.loads(command_line)
        result = handle_command(command)
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {'success': False, 'error': str(e)}
        print(json.dumps(error_result))

if __name__ == '__main__':
    main()
`;

    const tempDir = os.tmpdir();
    this.pyautoguiScript = path.join(tempDir, 'hanzo_pyautogui_bridge.py');
    await fs.writeFile(this.pyautoguiScript, scriptContent);
    this.log(`Created PyAutoGUI bridge script at: ${this.pyautoguiScript}`);
  }

  private async testPyAutoGUI(): Promise<void> {
    const result = await this.executeCommand({ action: 'get_screen_size' });
    if (!result.success) {
      throw new AutoGUINotAvailableError('python', new Error(`PyAutoGUI test failed: ${result.error}`));
    }
  }

  private async executePythonCommand(code: string, pythonPath?: string): Promise<PyAutoGUIResponse> {
    const python = pythonPath || this.pythonPath;
    if (!python) {
      throw new AutoGUINotAvailableError('python', new Error('Python path not available'));
    }

    return new Promise((resolve, reject) => {
      const process = spawn(python, ['-c', code], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, data: stdout });
        } else {
          reject(new AutoGUIError(`Python command failed: ${stderr}`, 'python'));
        }
      });

      process.on('error', (error) => {
        reject(new AutoGUINotAvailableError('python', error));
      });
    });
  }

  private async executeCommand(command: PyAutoGUICommand): Promise<PyAutoGUIResponse> {
    if (!this.pythonPath || !this.pyautoguiScript) {
      throw new AutoGUINotAvailableError('python', new Error('PyAutoGUI not initialized'));
    }

    return new Promise((resolve, reject) => {
      const process = spawn(this.pythonPath!, [this.pyautoguiScript!], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        try {
          if (code === 0 && stdout.trim()) {
            const response = JSON.parse(stdout.trim());
            resolve(response);
          } else {
            reject(new AutoGUIError(`PyAutoGUI process failed: ${stderr || 'unknown error'}`, 'python'));
          }
        } catch (error) {
          reject(new AutoGUIError(`Failed to parse PyAutoGUI response: ${error}`, 'python'));
        }
      });

      process.on('error', (error) => {
        reject(new AutoGUINotAvailableError('python', error));
      });

      // Send command
      process.stdin.write(JSON.stringify(command));
      process.stdin.end();
    });
  }

  async getScreenSize(): Promise<Size> {
    const result = await this.withPause('getScreenSize', async () => {
      return this.executeCommand({ action: 'get_screen_size' });
    });

    if (!result.success || !result.data) {
      throw new AutoGUIError('Failed to get screen size');
    }

    return {
      width: result.data.width,
      height: result.data.height
    };
  }

  async getScreens(): Promise<ScreenInfo[]> {
    // PyAutoGUI primarily supports single screen
    const size = await this.getScreenSize();
    return [{
      size,
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
      primary: true,
      id: 0
    }];
  }

  async getMousePosition(): Promise<Point> {
    const result = await this.withPause('getMousePosition', async () => {
      return this.executeCommand({ action: 'get_mouse_position' });
    });

    if (!result.success || !result.data) {
      throw new AutoGUIError('Failed to get mouse position');
    }

    return {
      x: result.data.x,
      y: result.data.y
    };
  }

  // Implementation methods follow the same pattern as RustAutoGUI adapter
  // but use the PyAutoGUI bridge script

  async moveTo(x: number, y: number, options?: MouseMoveOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);
    
    await this.withPause('moveTo', async () => {
      return this.executeCommand({
        action: 'move_to',
        params: {
          x,
          y,
          duration: options?.duration || 0
        }
      });
    });
  }

  async moveRel(x: number, y: number, options?: MouseMoveOptions): Promise<void> {
    await this.withPause('moveRel', async () => {
      return this.executeCommand({
        action: 'move_rel',
        params: {
          x,
          y,
          duration: options?.duration || 0
        }
      });
    });
  }

  async click(x?: number, y?: number, options?: MouseClickOptions): Promise<void> {
    if (x !== undefined && y !== undefined) {
      AdapterUtils.validateCoordinates(x, y);
    }

    await this.withPause('click', async () => {
      return this.executeCommand({
        action: 'click',
        params: {
          x,
          y,
          button: AdapterUtils.parseMouseButton(options?.button),
          clicks: options?.clicks || 1
        }
      });
    });
  }

  async doubleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void> {
    await this.click(x, y, { ...options, clicks: 2 });
  }

  async rightClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void> {
    await this.click(x, y, { ...options, button: 'right' });
  }

  async middleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void> {
    await this.click(x, y, { ...options, button: 'middle' });
  }

  async mouseDown(x?: number, y?: number, button?: MouseButton): Promise<void> {
    if (x !== undefined && y !== undefined) {
      AdapterUtils.validateCoordinates(x, y);
    }

    await this.withPause('mouseDown', async () => {
      return this.executeCommand({
        action: 'mouse_down',
        params: {
          x,
          y,
          button: AdapterUtils.parseMouseButton(button)
        }
      });
    });
  }

  async mouseUp(x?: number, y?: number, button?: MouseButton): Promise<void> {
    if (x !== undefined && y !== undefined) {
      AdapterUtils.validateCoordinates(x, y);
    }

    await this.withPause('mouseUp', async () => {
      return this.executeCommand({
        action: 'mouse_up',
        params: {
          x,
          y,
          button: AdapterUtils.parseMouseButton(button)
        }
      });
    });
  }

  async dragTo(x: number, y: number, options?: MouseDragOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);

    await this.withPause('dragTo', async () => {
      return this.executeCommand({
        action: 'drag_to',
        params: {
          x,
          y,
          button: AdapterUtils.parseMouseButton(options?.button),
          duration: options?.duration || 0
        }
      });
    });
  }

  async dragRel(x: number, y: number, options?: MouseDragOptions): Promise<void> {
    await this.withPause('dragRel', async () => {
      return this.executeCommand({
        action: 'drag_rel',
        params: {
          x,
          y,
          button: AdapterUtils.parseMouseButton(options?.button),
          duration: options?.duration || 0
        }
      });
    });
  }

  async scroll(x: number, y: number, scrolls: number, options?: ScrollOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);

    await this.withPause('scroll', async () => {
      return this.executeCommand({
        action: 'scroll',
        params: {
          x,
          y,
          scrolls
        }
      });
    });
  }

  async type(text: string, options?: TypeOptions): Promise<void> {
    if (!text || typeof text !== 'string') {
      throw new AutoGUIError('Text must be a non-empty string');
    }

    await this.withPause('type', async () => {
      return this.executeCommand({
        action: 'type',
        params: {
          text,
          interval: options?.interval || 0
        }
      });
    });
  }

  async press(key: string, options?: KeyPressOptions): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('press', async () => {
      return this.executeCommand({
        action: 'press',
        params: {
          key: key.toLowerCase(),
          duration: options?.duration || 0,
          modifiers: options?.modifiers || []
        }
      });
    });
  }

  async keyDown(key: string): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('keyDown', async () => {
      return this.executeCommand({
        action: 'key_down',
        params: { key: key.toLowerCase() }
      });
    });
  }

  async keyUp(key: string): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('keyUp', async () => {
      return this.executeCommand({
        action: 'key_up',
        params: { key: key.toLowerCase() }
      });
    });
  }

  async hotkey(...keys: string[]): Promise<void> {
    const processedKeys = AdapterUtils.parseHotkeyKeys(keys);

    await this.withPause('hotkey', async () => {
      return this.executeCommand({
        action: 'hotkey',
        params: { keys: processedKeys }
      });
    });
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const result = await this.withPause('screenshot', async () => {
      return this.executeCommand({
        action: 'screenshot',
        params: {
          bounds: options?.bounds
        }
      });
    });

    if (!result.success || !result.data?.image) {
      throw new AutoGUIError('Failed to take screenshot');
    }

    return Buffer.from(result.data.image, 'base64');
  }

  async getPixel(x: number, y: number): Promise<{r: number, g: number, b: number}> {
    AdapterUtils.validateCoordinates(x, y);

    const result = await this.withPause('getPixel', async () => {
      return this.executeCommand({
        action: 'get_pixel',
        params: { x, y }
      });
    });

    if (!result.success || !result.data) {
      throw new AutoGUIError('Failed to get pixel color');
    }

    return {
      r: result.data.r,
      g: result.data.g,
      b: result.data.b
    };
  }

  async locateOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch | null> {
    AdapterUtils.validateImagePath(imagePath);

    if (!await AdapterUtils.fileExists(imagePath)) {
      throw new AutoGUIError(`Image file not found: ${imagePath}`);
    }

    const result = await this.withPause('locateOnScreen', async () => {
      return this.executeCommand({
        action: 'locate_on_screen',
        params: {
          image_path: imagePath,
          confidence: AdapterUtils.clampConfidence(options?.confidence),
          region: options?.region
        }
      });
    });

    if (!result.success) {
      if (result.error?.includes('not found')) {
        return null;
      }
      throw new AutoGUIError('Failed to locate image on screen');
    }

    if (!result.data) {
      return null;
    }

    return {
      center: { x: result.data.center_x, y: result.data.center_y },
      bounds: {
        x: result.data.x,
        y: result.data.y,
        width: result.data.width,
        height: result.data.height
      },
      confidence: result.data.confidence
    };
  }

  async locateAllOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch[]> {
    AdapterUtils.validateImagePath(imagePath);

    if (!await AdapterUtils.fileExists(imagePath)) {
      throw new AutoGUIError(`Image file not found: ${imagePath}`);
    }

    const result = await this.withPause('locateAllOnScreen', async () => {
      return this.executeCommand({
        action: 'locate_all_on_screen',
        params: {
          image_path: imagePath,
          confidence: AdapterUtils.clampConfidence(options?.confidence),
          region: options?.region,
          limit: options?.limit || 10
        }
      });
    });

    if (!result.success || !result.data?.matches) {
      return [];
    }

    return result.data.matches.map((match: any) => ({
      center: { x: match.center_x, y: match.center_y },
      bounds: {
        x: match.x,
        y: match.y,
        width: match.width,
        height: match.height
      },
      confidence: match.confidence
    }));
  }

  async locateCenterOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<Point | null> {
    const match = await this.locateOnScreen(imagePath, options);
    return match ? match.center : null;
  }

  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      const result = await this.withPause('getActiveWindow', async () => {
        return this.executeCommand({ action: 'get_active_window' });
      });

      if (!result.success || !result.data) {
        return null;
      }

      return this.parseWindowInfo(result.data);
    } catch {
      return null;
    }
  }

  async getAllWindows(): Promise<WindowInfo[]> {
    try {
      const result = await this.withPause('getAllWindows', async () => {
        return this.executeCommand({ action: 'get_all_windows' });
      });

      if (!result.success || !result.data?.windows) {
        return [];
      }

      return result.data.windows.map(this.parseWindowInfo);
    } catch {
      return [];
    }
  }

  async getWindowByTitle(title: string): Promise<WindowInfo | null> {
    const windows = await this.getAllWindows();
    return windows.find(w => w.title.includes(title)) || null;
  }

  async activateWindow(windowId: string | number): Promise<void> {
    // PyAutoGUI has limited window management - would need pygetwindow
    this.log('Window activation requires pygetwindow package');
  }

  async minimizeWindow(windowId: string | number): Promise<void> {
    this.log('Window minimization requires pygetwindow package');
  }

  async maximizeWindow(windowId: string | number): Promise<void> {
    this.log('Window maximization requires pygetwindow package');
  }

  async resizeWindow(windowId: string | number, width: number, height: number): Promise<void> {
    this.log('Window resizing requires pygetwindow package');
  }

  async moveWindow(windowId: string | number, x: number, y: number): Promise<void> {
    this.log('Window moving requires pygetwindow package');
  }

  async closeWindow(windowId: string | number): Promise<void> {
    this.log('Window closing requires pygetwindow package');
  }

  private parseWindowInfo(data: any): WindowInfo {
    return {
      id: data.id,
      title: data.title || '',
      bounds: {
        x: data.x || 0,
        y: data.y || 0,
        width: data.width || 0,
        height: data.height || 0
      },
      isVisible: data.visible !== false,
      isMinimized: data.minimized === true,
      isMaximized: data.maximized === true,
      processId: data.process_id
    };
  }

  getImplementationName(): string {
    return 'python';
  }

  async getImplementationVersion(): Promise<string> {
    return this.version;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.pythonPath) {
        await this.findPythonEnvironment();
      }
      return this.pythonPath !== null;
    } catch {
      return false;
    }
  }
}