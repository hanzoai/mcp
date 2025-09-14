/**
 * Base AutoGUI Adapter
 * Provides common functionality and abstract interface for all implementations
 */

import {
  AutoGUIAdapter,
  AutoGUIConfig,
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
  AutoGUIOperationError
} from '../types.js';

export abstract class BaseAutoGUIAdapter implements AutoGUIAdapter {
  protected config: AutoGUIConfig = {
    failsafe: true,
    pause: 0.1,
    log: false,
    implementation: 'auto',
    fallbackOrder: ['rust', 'js', 'python']
  };

  protected lastOperation: string = '';

  constructor(config?: Partial<AutoGUIConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  async configure(config: AutoGUIConfig): Promise<void> {
    this.config = { ...this.config, ...config };
    await this.initializeImplementation();
  }

  getConfig(): AutoGUIConfig {
    return { ...this.config };
  }

  protected abstract initializeImplementation(): Promise<void>;
  
  protected log(message: string, operation?: string): void {
    if (this.config.log) {
      const prefix = operation ? `[${operation}]` : '[AutoGUI]';
      console.error(`${prefix} ${message}`);
    }
  }

  protected async withPause<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    this.lastOperation = operation;
    this.log(`Starting operation: ${operation}`, operation);
    
    try {
      const result = await fn();
      
      if (this.config.pause && this.config.pause > 0) {
        await this.sleep(this.config.pause);
      }
      
      this.log(`Completed operation: ${operation}`, operation);
      return result;
    } catch (error) {
      this.log(`Failed operation: ${operation} - ${error}`, operation);
      throw new AutoGUIOperationError(operation, this.getImplementationName(), error as Error);
    }
  }

  protected checkFailsafe(): void {
    if (this.config.failsafe) {
      // Implement failsafe check based on mouse position
      // This is a simplified implementation
      // Each adapter should implement its own failsafe logic
    }
  }

  // Default implementations that can be overridden
  async sleep(seconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  isPointOnScreen(x: number, y: number): boolean {
    // Basic implementation - adapters should override with actual screen bounds
    return x >= 0 && y >= 0;
  }

  // Abstract methods that must be implemented by each adapter
  abstract getScreenSize(): Promise<Size>;
  abstract getScreens(): Promise<ScreenInfo[]>;
  abstract getMousePosition(): Promise<Point>;
  abstract moveTo(x: number, y: number, options?: MouseMoveOptions): Promise<void>;
  abstract moveRel(x: number, y: number, options?: MouseMoveOptions): Promise<void>;
  abstract click(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  abstract doubleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  abstract rightClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  abstract middleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  abstract mouseDown(x?: number, y?: number, button?: MouseButton): Promise<void>;
  abstract mouseUp(x?: number, y?: number, button?: MouseButton): Promise<void>;
  abstract dragTo(x: number, y: number, options?: MouseDragOptions): Promise<void>;
  abstract dragRel(x: number, y: number, options?: MouseDragOptions): Promise<void>;
  abstract scroll(x: number, y: number, scrolls: number, options?: ScrollOptions): Promise<void>;
  abstract type(text: string, options?: TypeOptions): Promise<void>;
  abstract press(key: string, options?: KeyPressOptions): Promise<void>;
  abstract keyDown(key: string): Promise<void>;
  abstract keyUp(key: string): Promise<void>;
  abstract hotkey(...keys: string[]): Promise<void>;
  abstract screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  abstract getPixel(x: number, y: number): Promise<{r: number, g: number, b: number}>;
  abstract locateOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch | null>;
  abstract locateAllOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch[]>;
  abstract locateCenterOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<Point | null>;
  abstract getActiveWindow(): Promise<WindowInfo | null>;
  abstract getAllWindows(): Promise<WindowInfo[]>;
  abstract getWindowByTitle(title: string): Promise<WindowInfo | null>;
  abstract activateWindow(windowId: string | number): Promise<void>;
  abstract minimizeWindow(windowId: string | number): Promise<void>;
  abstract maximizeWindow(windowId: string | number): Promise<void>;
  abstract resizeWindow(windowId: string | number, width: number, height: number): Promise<void>;
  abstract moveWindow(windowId: string | number, x: number, y: number): Promise<void>;
  abstract closeWindow(windowId: string | number): Promise<void>;
  abstract getImplementationName(): string;
  abstract getImplementationVersion(): Promise<string>;
  abstract isAvailable(): Promise<boolean>;
}

/**
 * Utility functions for adapters
 */
export class AdapterUtils {
  static parseMouseButton(button?: MouseButton): string {
    switch (button) {
      case 'left': return 'left';
      case 'right': return 'right';
      case 'middle': return 'middle';
      default: return 'left';
    }
  }

  static validateCoordinates(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new AutoGUIError('Coordinates must be integers');
    }
    if (x < 0 || y < 0) {
      throw new AutoGUIError('Coordinates must be non-negative');
    }
  }

  static validateImagePath(imagePath: string): void {
    if (!imagePath || typeof imagePath !== 'string') {
      throw new AutoGUIError('Image path must be a non-empty string');
    }
  }

  static clampConfidence(confidence?: number): number {
    if (confidence === undefined) return 0.8;
    return Math.max(0, Math.min(1, confidence));
  }

  static validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new AutoGUIError('Key must be a non-empty string');
    }
  }

  static parseHotkeyKeys(keys: string[]): string[] {
    if (!keys || keys.length === 0) {
      throw new AutoGUIError('Hotkey must have at least one key');
    }
    return keys.map(key => key.toLowerCase());
  }

  static async fileExists(path: string): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  static async readImageAsBase64(path: string): Promise<string> {
    const fs = await import('fs/promises');
    const buffer = await fs.readFile(path);
    return buffer.toString('base64');
  }
}