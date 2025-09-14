/**
 * AutoGUI Module - Computer Control for MCP
 * Provides unified interface for cross-platform GUI automation
 */

// Export all types
export * from './types.js';

// Export factory and convenience functions
export {
  HanzoAutoGUIFactory,
  createAutoGUI,
  getAvailableAutoGUIImplementations,
  detectBestAutoGUIImplementation,
  getAutoGUIImplementationStatus
} from './factory.js';

// Export adapters
export { BaseAutoGUIAdapter, AdapterUtils } from './adapters/base.js';
export { RustAutoGUIAdapter } from './adapters/rust.js';
export { JSAutoGUIAdapter } from './adapters/jsautogui.js';
export { PyAutoGUIAdapter } from './adapters/pyautogui.js';

// Export tools
export { autoguiTools } from './tools/autogui-tools.js';