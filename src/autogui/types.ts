/**
 * AutoGUI Types - Unified interface for cross-platform GUI automation
 * Supports RustAutoGUI, JSAutoGUI, and PyAutoGUI implementations
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenInfo {
  size: Size;
  bounds: Bounds;
  primary: boolean;
  id?: string | number;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface MouseClickOptions {
  button?: MouseButton;
  clicks?: number;
  interval?: number;
  duration?: number;
}

export interface MouseMoveOptions {
  duration?: number;
  tween?: string; // easing function
}

export interface MouseDragOptions {
  button?: MouseButton;
  duration?: number;
}

export interface ScrollOptions {
  direction?: 'up' | 'down' | 'left' | 'right';
  clicks?: number;
}

export interface TypeOptions {
  interval?: number;
  pause?: number;
}

export interface KeyPressOptions {
  duration?: number;
  modifiers?: string[];
}

export interface HotkeyOptions {
  interval?: number;
}

export interface ScreenshotOptions {
  bounds?: Bounds;
  format?: 'png' | 'jpeg' | 'bmp';
  quality?: number;
}

export interface ImageSearchOptions {
  confidence?: number;
  grayscale?: boolean;
  region?: Bounds;
  limit?: number;
}

export interface ImageMatch {
  center: Point;
  bounds: Bounds;
  confidence: number;
}

export interface WindowInfo {
  id: string | number;
  title: string;
  bounds: Bounds;
  isVisible: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  processId?: number;
}

export interface AutoGUIConfig {
  failsafe?: boolean;
  pause?: number;
  log?: boolean;
  implementation?: 'auto' | 'rust' | 'js' | 'python';
  fallbackOrder?: ('rust' | 'js' | 'python')[];
}

/**
 * Unified AutoGUI Interface
 * All implementations should conform to this interface
 */
export interface AutoGUIAdapter {
  // Configuration
  configure(config: AutoGUIConfig): Promise<void>;
  getConfig(): AutoGUIConfig;
  
  // Screen Information
  getScreenSize(): Promise<Size>;
  getScreens(): Promise<ScreenInfo[]>;
  
  // Mouse Control
  getMousePosition(): Promise<Point>;
  moveTo(x: number, y: number, options?: MouseMoveOptions): Promise<void>;
  moveRel(x: number, y: number, options?: MouseMoveOptions): Promise<void>;
  click(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  doubleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  rightClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  middleClick(x?: number, y?: number, options?: MouseClickOptions): Promise<void>;
  mouseDown(x?: number, y?: number, button?: MouseButton): Promise<void>;
  mouseUp(x?: number, y?: number, button?: MouseButton): Promise<void>;
  dragTo(x: number, y: number, options?: MouseDragOptions): Promise<void>;
  dragRel(x: number, y: number, options?: MouseDragOptions): Promise<void>;
  scroll(x: number, y: number, scrolls: number, options?: ScrollOptions): Promise<void>;
  
  // Keyboard Control
  type(text: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: KeyPressOptions): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
  
  // Screen Capture and Vision
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  getPixel(x: number, y: number): Promise<{r: number, g: number, b: number}>;
  locateOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch | null>;
  locateAllOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<ImageMatch[]>;
  locateCenterOnScreen(imagePath: string, options?: ImageSearchOptions): Promise<Point | null>;
  
  // Window Management
  getActiveWindow(): Promise<WindowInfo | null>;
  getAllWindows(): Promise<WindowInfo[]>;
  getWindowByTitle(title: string): Promise<WindowInfo | null>;
  activateWindow(windowId: string | number): Promise<void>;
  minimizeWindow(windowId: string | number): Promise<void>;
  maximizeWindow(windowId: string | number): Promise<void>;
  resizeWindow(windowId: string | number, width: number, height: number): Promise<void>;
  moveWindow(windowId: string | number, x: number, y: number): Promise<void>;
  closeWindow(windowId: string | number): Promise<void>;
  
  // Utility Functions
  sleep(seconds: number): Promise<void>;
  isPointOnScreen(x: number, y: number): boolean;
  
  // Implementation Info
  getImplementationName(): string;
  getImplementationVersion(): Promise<string>;
  isAvailable(): Promise<boolean>;
}

/**
 * AutoGUI Factory Interface
 */
export interface AutoGUIFactory {
  createAdapter(implementation?: string): Promise<AutoGUIAdapter>;
  getAvailableImplementations(): Promise<string[]>;
  detectBestImplementation(): Promise<string>;
}

/**
 * Implementation-specific errors
 */
export class AutoGUIError extends Error {
  constructor(message: string, public implementation?: string, public cause?: Error) {
    super(message);
    this.name = 'AutoGUIError';
  }
}

export class AutoGUINotAvailableError extends AutoGUIError {
  constructor(implementation: string, cause?: Error) {
    super(`AutoGUI implementation '${implementation}' is not available`, implementation, cause);
    this.name = 'AutoGUINotAvailableError';
  }
}

export class AutoGUIOperationError extends AutoGUIError {
  constructor(operation: string, implementation: string, cause?: Error) {
    super(`AutoGUI operation '${operation}' failed in ${implementation}`, implementation, cause);
    this.name = 'AutoGUIOperationError';
  }
}