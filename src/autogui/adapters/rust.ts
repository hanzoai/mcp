/**
 * RustAutoGUI Adapter
 * Interfaces with the RustAutoGUI binary for high-performance GUI automation
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

interface RustAutoGUICommand {
  action: string;
  params?: Record<string, any>;
}

interface RustAutoGUIResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export class RustAutoGUIAdapter extends BaseAutoGUIAdapter {
  private binaryPath: string | null = null;
  private version: string | null = null;

  constructor(config?: any) {
    super(config);
  }

  protected async initializeImplementation(): Promise<void> {
    await this.findRustAutoGUIBinary();
    if (!this.binaryPath) {
      throw new AutoGUINotAvailableError('rust', new Error('RustAutoGUI binary not found'));
    }
  }

  private async findRustAutoGUIBinary(): Promise<void> {
    const possiblePaths = [
      'rustautogui', // In PATH
      './rustautogui', // Local
      '../rustautogui/target/release/rustautogui', // Build directory
      process.env.RUSTAUTOGUI_PATH, // Environment variable
    ].filter(Boolean) as string[];

    for (const binaryPath of possiblePaths) {
      try {
        const result = await this.executeCommand({ action: 'version' }, binaryPath);
        if (result.success) {
          this.binaryPath = binaryPath;
          this.version = result.data?.version || 'unknown';
          this.log(`Found RustAutoGUI at: ${binaryPath}, version: ${this.version}`);
          return;
        }
      } catch (error) {
        // Continue searching
      }
    }

    this.log('RustAutoGUI binary not found in any expected location');
  }

  private async executeCommand(command: RustAutoGUICommand, binaryPath?: string): Promise<RustAutoGUIResponse> {
    const binary = binaryPath || this.binaryPath;
    if (!binary) {
      throw new AutoGUINotAvailableError('rust', new Error('RustAutoGUI binary not available'));
    }

    return new Promise((resolve, reject) => {
      const process = spawn(binary, ['--json'], {
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
            reject(new AutoGUIError(`RustAutoGUI process failed: ${stderr || 'unknown error'}`, 'rust'));
          }
        } catch (error) {
          reject(new AutoGUIError(`Failed to parse RustAutoGUI response: ${error}`, 'rust'));
        }
      });

      process.on('error', (error) => {
        reject(new AutoGUINotAvailableError('rust', error));
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
    const result = await this.withPause('getScreens', async () => {
      return this.executeCommand({ action: 'get_screens' });
    });

    if (!result.success || !result.data) {
      throw new AutoGUIError('Failed to get screen information');
    }

    return result.data.screens.map((screen: any) => ({
      size: { width: screen.width, height: screen.height },
      bounds: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      primary: screen.primary || false,
      id: screen.id
    }));
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
          scrolls,
          direction: options?.direction || 'down'
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
          bounds: options?.bounds,
          format: options?.format || 'png'
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

  // Window management (may have limited support in RustAutoGUI)
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
    await this.withPause('activateWindow', async () => {
      return this.executeCommand({
        action: 'activate_window',
        params: { window_id: windowId }
      });
    });
  }

  async minimizeWindow(windowId: string | number): Promise<void> {
    await this.withPause('minimizeWindow', async () => {
      return this.executeCommand({
        action: 'minimize_window',
        params: { window_id: windowId }
      });
    });
  }

  async maximizeWindow(windowId: string | number): Promise<void> {
    await this.withPause('maximizeWindow', async () => {
      return this.executeCommand({
        action: 'maximize_window',
        params: { window_id: windowId }
      });
    });
  }

  async resizeWindow(windowId: string | number, width: number, height: number): Promise<void> {
    await this.withPause('resizeWindow', async () => {
      return this.executeCommand({
        action: 'resize_window',
        params: { window_id: windowId, width, height }
      });
    });
  }

  async moveWindow(windowId: string | number, x: number, y: number): Promise<void> {
    await this.withPause('moveWindow', async () => {
      return this.executeCommand({
        action: 'move_window',
        params: { window_id: windowId, x, y }
      });
    });
  }

  async closeWindow(windowId: string | number): Promise<void> {
    await this.withPause('closeWindow', async () => {
      return this.executeCommand({
        action: 'close_window',
        params: { window_id: windowId }
      });
    });
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
    return 'rust';
  }

  async getImplementationVersion(): Promise<string> {
    return this.version || 'unknown';
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.binaryPath) {
        await this.findRustAutoGUIBinary();
      }
      return this.binaryPath !== null;
    } catch {
      return false;
    }
  }
}