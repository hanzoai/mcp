/**
 * JSAutoGUI Adapter
 * Interfaces with the jsautogui npm package for JavaScript-based GUI automation
 */

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

export class JSAutoGUIAdapter extends BaseAutoGUIAdapter {
  private jsautogui: any = null;
  private version: string = 'unknown';

  constructor(config?: any) {
    super(config);
  }

  protected async initializeImplementation(): Promise<void> {
    try {
      // Dynamic import since jsautogui is an optional dependency
      this.jsautogui = await import('jsautogui');
      
      // Try to get version if available
      try {
        this.version = this.jsautogui.version || this.jsautogui.default?.version || 'unknown';
      } catch {
        this.version = 'unknown';
      }

      this.log(`Initialized JSAutoGUI, version: ${this.version}`);
    } catch (error: any) {
      throw new AutoGUINotAvailableError('js', error);
    }
  }

  private ensureInitialized(): void {
    if (!this.jsautogui) {
      throw new AutoGUIError('JSAutoGUI not initialized', 'js');
    }
  }

  async getScreenSize(): Promise<Size> {
    return this.withPause('getScreenSize', async () => {
      this.ensureInitialized();
      
      const size = await this.jsautogui.size();
      return {
        width: size.width || size[0],
        height: size.height || size[1]
      };
    });
  }

  async getScreens(): Promise<ScreenInfo[]> {
    return this.withPause('getScreens', async () => {
      this.ensureInitialized();
      
      // JSAutoGUI might not support multiple screens directly
      // Return primary screen info
      const size = await this.getScreenSize();
      return [{
        size,
        bounds: { x: 0, y: 0, width: size.width, height: size.height },
        primary: true,
        id: 0
      }];
    });
  }

  async getMousePosition(): Promise<Point> {
    return this.withPause('getMousePosition', async () => {
      this.ensureInitialized();
      
      const position = await this.jsautogui.position();
      return {
        x: position.x || position[0],
        y: position.y || position[1]
      };
    });
  }

  async moveTo(x: number, y: number, options?: MouseMoveOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);
    
    await this.withPause('moveTo', async () => {
      this.ensureInitialized();
      
      if (options?.duration) {
        await this.jsautogui.moveTo(x, y, options.duration);
      } else {
        await this.jsautogui.moveTo(x, y);
      }
    });
  }

  async moveRel(x: number, y: number, options?: MouseMoveOptions): Promise<void> {
    await this.withPause('moveRel', async () => {
      this.ensureInitialized();
      
      if (options?.duration) {
        await this.jsautogui.moveRel(x, y, options.duration);
      } else {
        await this.jsautogui.moveRel(x, y);
      }
    });
  }

  async click(x?: number, y?: number, options?: MouseClickOptions): Promise<void> {
    if (x !== undefined && y !== undefined) {
      AdapterUtils.validateCoordinates(x, y);
    }

    await this.withPause('click', async () => {
      this.ensureInitialized();
      
      const button = AdapterUtils.parseMouseButton(options?.button);
      const clicks = options?.clicks || 1;
      
      if (x !== undefined && y !== undefined) {
        await this.jsautogui.click(x, y, button, clicks);
      } else {
        await this.jsautogui.click(null, null, button, clicks);
      }
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
      this.ensureInitialized();
      
      const mouseButton = AdapterUtils.parseMouseButton(button);
      
      if (x !== undefined && y !== undefined) {
        await this.jsautogui.mouseDown(x, y, mouseButton);
      } else {
        await this.jsautogui.mouseDown(null, null, mouseButton);
      }
    });
  }

  async mouseUp(x?: number, y?: number, button?: MouseButton): Promise<void> {
    if (x !== undefined && y !== undefined) {
      AdapterUtils.validateCoordinates(x, y);
    }

    await this.withPause('mouseUp', async () => {
      this.ensureInitialized();
      
      const mouseButton = AdapterUtils.parseMouseButton(button);
      
      if (x !== undefined && y !== undefined) {
        await this.jsautogui.mouseUp(x, y, mouseButton);
      } else {
        await this.jsautogui.mouseUp(null, null, mouseButton);
      }
    });
  }

  async dragTo(x: number, y: number, options?: MouseDragOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);

    await this.withPause('dragTo', async () => {
      this.ensureInitialized();
      
      const button = AdapterUtils.parseMouseButton(options?.button);
      const duration = options?.duration || 0;
      
      await this.jsautogui.dragTo(x, y, duration, button);
    });
  }

  async dragRel(x: number, y: number, options?: MouseDragOptions): Promise<void> {
    await this.withPause('dragRel', async () => {
      this.ensureInitialized();
      
      const button = AdapterUtils.parseMouseButton(options?.button);
      const duration = options?.duration || 0;
      
      await this.jsautogui.dragRel(x, y, duration, button);
    });
  }

  async scroll(x: number, y: number, scrolls: number, options?: ScrollOptions): Promise<void> {
    AdapterUtils.validateCoordinates(x, y);

    await this.withPause('scroll', async () => {
      this.ensureInitialized();
      
      // Move to position first, then scroll
      await this.moveTo(x, y);
      await this.jsautogui.scroll(scrolls);
    });
  }

  async type(text: string, options?: TypeOptions): Promise<void> {
    if (!text || typeof text !== 'string') {
      throw new AutoGUIError('Text must be a non-empty string');
    }

    await this.withPause('type', async () => {
      this.ensureInitialized();
      
      if (options?.interval) {
        await this.jsautogui.typewrite(text, options.interval);
      } else {
        await this.jsautogui.typewrite(text);
      }
    });
  }

  async press(key: string, options?: KeyPressOptions): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('press', async () => {
      this.ensureInitialized();
      
      const presses = options?.duration ? Math.max(1, Math.floor(options.duration * 10)) : 1;
      
      if (options?.modifiers && options.modifiers.length > 0) {
        // Handle modifier keys
        const allKeys = [...options.modifiers, key];
        await this.jsautogui.hotkey(...allKeys);
      } else {
        for (let i = 0; i < presses; i++) {
          await this.jsautogui.press(key.toLowerCase());
          if (presses > 1 && i < presses - 1) {
            await this.sleep(0.05); // Small delay between presses
          }
        }
      }
    });
  }

  async keyDown(key: string): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('keyDown', async () => {
      this.ensureInitialized();
      await this.jsautogui.keyDown(key.toLowerCase());
    });
  }

  async keyUp(key: string): Promise<void> {
    AdapterUtils.validateKey(key);

    await this.withPause('keyUp', async () => {
      this.ensureInitialized();
      await this.jsautogui.keyUp(key.toLowerCase());
    });
  }

  async hotkey(...keys: string[]): Promise<void> {
    const processedKeys = AdapterUtils.parseHotkeyKeys(keys);

    await this.withPause('hotkey', async () => {
      this.ensureInitialized();
      await this.jsautogui.hotkey(...processedKeys);
    });
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return this.withPause('screenshot', async () => {
      this.ensureInitialized();
      
      let screenshot;
      if (options?.bounds) {
        const { x, y, width, height } = options.bounds;
        screenshot = await this.jsautogui.screenshot(null, x, y, width, height);
      } else {
        screenshot = await this.jsautogui.screenshot();
      }
      
      // Convert screenshot to Buffer
      if (typeof screenshot === 'string') {
        // If it's a base64 string
        return Buffer.from(screenshot, 'base64');
      } else if (screenshot instanceof Buffer) {
        return screenshot;
      } else if (screenshot && screenshot.data) {
        return Buffer.from(screenshot.data);
      } else {
        throw new AutoGUIError('Invalid screenshot format returned');
      }
    });
  }

  async getPixel(x: number, y: number): Promise<{r: number, g: number, b: number}> {
    AdapterUtils.validateCoordinates(x, y);

    return this.withPause('getPixel', async () => {
      this.ensureInitialized();
      
      const pixel = await this.jsautogui.pixel(x, y);
      
      if (Array.isArray(pixel)) {
        return { r: pixel[0], g: pixel[1], b: pixel[2] };
      } else if (typeof pixel === 'object') {
        return { r: pixel.r, g: pixel.g, b: pixel.b };
      } else {
        throw new AutoGUIError('Invalid pixel format returned');
      }
    });
  }

  async locateOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch | null> {
    AdapterUtils.validateImagePath(imagePath);

    if (!await AdapterUtils.fileExists(imagePath)) {
      throw new AutoGUIError(`Image file not found: ${imagePath}`);
    }

    return this.withPause('locateOnScreen', async () => {
      this.ensureInitialized();
      
      try {
        const confidence = AdapterUtils.clampConfidence(options?.confidence);
        const result = await this.jsautogui.locateOnScreen(imagePath, confidence);
        
        if (!result) {
          return null;
        }
        
        const bounds = {
          x: result.left || result.x || result[0],
          y: result.top || result.y || result[1],
          width: result.width || result[2],
          height: result.height || result[3]
        };
        
        return {
          center: {
            x: bounds.x + Math.floor(bounds.width / 2),
            y: bounds.y + Math.floor(bounds.height / 2)
          },
          bounds,
          confidence: confidence
        };
      } catch (error: any) {
        if (error.message?.includes('not found') || error.message?.includes('could not locate')) {
          return null;
        }
        throw error;
      }
    });
  }

  async locateAllOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch[]> {
    AdapterUtils.validateImagePath(imagePath);

    if (!await AdapterUtils.fileExists(imagePath)) {
      throw new AutoGUIError(`Image file not found: ${imagePath}`);
    }

    return this.withPause('locateAllOnScreen', async () => {
      this.ensureInitialized();
      
      try {
        const confidence = AdapterUtils.clampConfidence(options?.confidence);
        const results = await this.jsautogui.locateAllOnScreen(imagePath, confidence);
        
        if (!results || !Array.isArray(results)) {
          return [];
        }
        
        return results.slice(0, options?.limit || 10).map((result: any) => {
          const bounds = {
            x: result.left || result.x || result[0],
            y: result.top || result.y || result[1],
            width: result.width || result[2],
            height: result.height || result[3]
          };
          
          return {
            center: {
              x: bounds.x + Math.floor(bounds.width / 2),
              y: bounds.y + Math.floor(bounds.height / 2)
            },
            bounds,
            confidence: confidence
          };
        });
      } catch (error: any) {
        if (error.message?.includes('not found') || error.message?.includes('could not locate')) {
          return [];
        }
        throw error;
      }
    });
  }

  async locateCenterOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<Point | null> {
    const match = await this.locateOnScreen(imagePath, options);
    return match ? match.center : null;
  }

  // Window management (limited support in JSAutoGUI)
  async getActiveWindow(): Promise<WindowInfo | null> {
    try {
      return this.withPause('getActiveWindow', async () => {
        this.ensureInitialized();
        
        // JSAutoGUI might not have direct window management
        // Return a placeholder or try to detect
        const screenSize = await this.getScreenSize();
        
        return {
          id: 'active',
          title: 'Active Window',
          bounds: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
          isVisible: true,
          isMinimized: false,
          isMaximized: false
        };
      });
    } catch {
      return null;
    }
  }

  async getAllWindows(): Promise<WindowInfo[]> {
    // JSAutoGUI might not support window enumeration
    const activeWindow = await this.getActiveWindow();
    return activeWindow ? [activeWindow] : [];
  }

  async getWindowByTitle(title: string): Promise<WindowInfo | null> {
    const windows = await this.getAllWindows();
    return windows.find(w => w.title.includes(title)) || null;
  }

  async activateWindow(windowId: string | number): Promise<void> {
    // Limited window management in JSAutoGUI
    this.log('Window activation not fully supported in JSAutoGUI');
  }

  async minimizeWindow(windowId: string | number): Promise<void> {
    this.log('Window minimization not supported in JSAutoGUI');
  }

  async maximizeWindow(windowId: string | number): Promise<void> {
    this.log('Window maximization not supported in JSAutoGUI');
  }

  async resizeWindow(windowId: string | number, width: number, height: number): Promise<void> {
    this.log('Window resizing not supported in JSAutoGUI');
  }

  async moveWindow(windowId: string | number, x: number, y: number): Promise<void> {
    this.log('Window moving not supported in JSAutoGUI');
  }

  async closeWindow(windowId: string | number): Promise<void> {
    this.log('Window closing not supported in JSAutoGUI');
  }

  getImplementationName(): string {
    return 'js';
  }

  async getImplementationVersion(): Promise<string> {
    return this.version;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.jsautogui) {
        await this.initializeImplementation();
      }
      return true;
    } catch {
      return false;
    }
  }
}