/**
 * AutoGUI MCP Tools
 * Provides MCP tools for computer control using AutoGUI adapters
 */

import { Tool, ToolResult } from '../../types/index.js';
import { createAutoGUI, getAvailableAutoGUIImplementations, getAutoGUIImplementationStatus } from '../factory.js';
import { AutoGUIAdapter, AutoGUIConfig } from '../types.js';
import { z } from 'zod';

// Global AutoGUI adapter instance
let autoguiAdapter: AutoGUIAdapter | null = null;

// Schemas for validation
const PointSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0)
});

const BoundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1)
});

const MouseButtonSchema = z.enum(['left', 'right', 'middle']).optional();

// Helper function to ensure AutoGUI is initialized
async function ensureAutoGUI(implementation?: string): Promise<AutoGUIAdapter> {
  if (!autoguiAdapter) {
    autoguiAdapter = await createAutoGUI(implementation);
  }
  return autoguiAdapter;
}

export const autoguiTools: Tool[] = [
  // System and Configuration Tools
  {
    name: 'autogui_status',
    description: 'Get AutoGUI system status and available implementations',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (): Promise<ToolResult> => {
      try {
        const available = await getAvailableAutoGUIImplementations();
        const status = await getAutoGUIImplementationStatus();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              available_implementations: available,
              implementation_status: status,
              current_adapter: autoguiAdapter?.getImplementationName() || null
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting AutoGUI status: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_configure',
    description: 'Configure AutoGUI settings and select implementation',
    inputSchema: {
      type: 'object',
      properties: {
        implementation: {
          type: 'string',
          enum: ['auto', 'rust', 'js', 'python'],
          description: 'AutoGUI implementation to use'
        },
        failsafe: {
          type: 'boolean',
          description: 'Enable failsafe mode (move mouse to corner to abort)'
        },
        pause: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description: 'Pause between operations in seconds'
        },
        log: {
          type: 'boolean',
          description: 'Enable verbose logging'
        }
      },
      required: []
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const config: Partial<AutoGUIConfig> = {};
        
        if (args.implementation) config.implementation = args.implementation;
        if (args.failsafe !== undefined) config.failsafe = args.failsafe;
        if (args.pause !== undefined) config.pause = args.pause;
        if (args.log !== undefined) config.log = args.log;

        // Reset adapter if implementation changed
        if (args.implementation && autoguiAdapter?.getImplementationName() !== args.implementation) {
          autoguiAdapter = null;
        }

        const adapter = await ensureAutoGUI(args.implementation);
        await adapter.configure(config);

        return {
          content: [{
            type: 'text',
            text: `AutoGUI configured with ${adapter.getImplementationName()} implementation`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error configuring AutoGUI: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Screen Information Tools
  {
    name: 'autogui_get_screen_size',
    description: 'Get the screen size in pixels',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        const size = await adapter.getScreenSize();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(size, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting screen size: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_get_screens',
    description: 'Get information about all available screens',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        const screens = await adapter.getScreens();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(screens, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting screen information: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Mouse Control Tools
  {
    name: 'autogui_get_mouse_position',
    description: 'Get the current mouse cursor position',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        const position = await adapter.getMousePosition();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(position, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting mouse position: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_move_mouse',
    description: 'Move the mouse cursor to a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        relative: { type: 'boolean', description: 'Move relative to current position' },
        duration: { type: 'number', minimum: 0, maximum: 10, description: 'Duration of movement in seconds' }
      },
      required: ['x', 'y']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        PointSchema.parse({ x: args.x, y: args.y });
        
        const adapter = await ensureAutoGUI();
        const options = args.duration ? { duration: args.duration } : undefined;
        
        if (args.relative) {
          await adapter.moveRel(args.x, args.y, options);
        } else {
          await adapter.moveTo(args.x, args.y, options);
        }
        
        return {
          content: [{
            type: 'text',
            text: `Mouse moved to (${args.x}, ${args.y})`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error moving mouse: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_click',
    description: 'Click the mouse at a specific position or current position',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (optional)' },
        y: { type: 'number', description: 'Y coordinate (optional)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to click' },
        clicks: { type: 'number', minimum: 1, maximum: 10, description: 'Number of clicks' },
        interval: { type: 'number', minimum: 0, maximum: 2, description: 'Interval between clicks' }
      },
      required: []
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        if (args.x !== undefined && args.y !== undefined) {
          PointSchema.parse({ x: args.x, y: args.y });
        }

        const adapter = await ensureAutoGUI();
        const options = {
          button: args.button,
          clicks: args.clicks,
          interval: args.interval
        };

        await adapter.click(args.x, args.y, options);
        
        const position = args.x !== undefined && args.y !== undefined ? `at (${args.x}, ${args.y})` : 'at current position';
        const button = args.button || 'left';
        const clicks = args.clicks || 1;
        
        return {
          content: [{
            type: 'text',
            text: `${clicks > 1 ? `${clicks}x clicked` : 'Clicked'} ${button} button ${position}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error clicking mouse: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_drag',
    description: 'Drag the mouse from current position or specific position to target',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
        relative: { type: 'boolean', description: 'Drag relative to current position' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to drag with' },
        duration: { type: 'number', minimum: 0, maximum: 10, description: 'Duration of drag in seconds' }
      },
      required: ['x', 'y']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        PointSchema.parse({ x: args.x, y: args.y });
        
        const adapter = await ensureAutoGUI();
        const options = {
          button: args.button,
          duration: args.duration
        };

        if (args.relative) {
          await adapter.dragRel(args.x, args.y, options);
        } else {
          await adapter.dragTo(args.x, args.y, options);
        }
        
        return {
          content: [{
            type: 'text',
            text: `Dragged to (${args.x}, ${args.y})`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error dragging mouse: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_scroll',
    description: 'Scroll at a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        scrolls: { type: 'number', description: 'Number of scroll clicks (positive up, negative down)' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' }
      },
      required: ['x', 'y', 'scrolls']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        PointSchema.parse({ x: args.x, y: args.y });
        
        const adapter = await ensureAutoGUI();
        const options = args.direction ? { direction: args.direction } : undefined;
        
        await adapter.scroll(args.x, args.y, args.scrolls, options);
        
        return {
          content: [{
            type: 'text',
            text: `Scrolled ${args.scrolls} clicks at (${args.x}, ${args.y})`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error scrolling: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Keyboard Control Tools
  {
    name: 'autogui_type',
    description: 'Type text using the keyboard',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        interval: { type: 'number', minimum: 0, maximum: 1, description: 'Interval between keystrokes in seconds' }
      },
      required: ['text']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        const options = args.interval ? { interval: args.interval } : undefined;
        
        await adapter.type(args.text, options);
        
        return {
          content: [{
            type: 'text',
            text: `Typed: "${args.text}"`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error typing text: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_press_key',
    description: 'Press a specific key or key combination',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press (e.g., "enter", "space", "a", "f1")' },
        modifiers: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'Modifier keys (e.g., ["ctrl", "shift"])'
        },
        duration: { type: 'number', minimum: 0, maximum: 5, description: 'Duration to hold key' }
      },
      required: ['key']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        const options = {
          modifiers: args.modifiers,
          duration: args.duration
        };
        
        await adapter.press(args.key, options);
        
        const modifierText = args.modifiers && args.modifiers.length > 0 ? `${args.modifiers.join('+')}+` : '';
        
        return {
          content: [{
            type: 'text',
            text: `Pressed key: ${modifierText}${args.key}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error pressing key: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_hotkey',
    description: 'Press a hotkey combination',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'Keys to press simultaneously (e.g., ["ctrl", "c"])'
        }
      },
      required: ['keys']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        
        await adapter.hotkey(...args.keys);
        
        return {
          content: [{
            type: 'text',
            text: `Pressed hotkey: ${args.keys.join('+')}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error pressing hotkey: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Screen Capture and Vision Tools
  {
    name: 'autogui_screenshot',
    description: 'Take a screenshot of the screen or a specific region',
    inputSchema: {
      type: 'object',
      properties: {
        bounds: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          },
          required: ['x', 'y', 'width', 'height'],
          description: 'Region to capture (optional, full screen if not specified)'
        },
        format: { type: 'string', enum: ['png', 'jpeg', 'bmp'], description: 'Image format' }
      },
      required: []
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        if (args.bounds) {
          BoundsSchema.parse(args.bounds);
        }

        const adapter = await ensureAutoGUI();
        const options = {
          bounds: args.bounds,
          format: args.format
        };
        
        const screenshot = await adapter.screenshot(options);
        const base64Data = screenshot.toString('base64');
        
        return {
          content: [{
            type: 'image',
            data: base64Data,
            mimeType: `image/${args.format || 'png'}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error taking screenshot: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_get_pixel',
    description: 'Get the color of a pixel at specific coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' }
      },
      required: ['x', 'y']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        PointSchema.parse({ x: args.x, y: args.y });
        
        const adapter = await ensureAutoGUI();
        const pixel = await adapter.getPixel(args.x, args.y);
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              position: { x: args.x, y: args.y },
              color: pixel,
              hex: `#${pixel.r.toString(16).padStart(2, '0')}${pixel.g.toString(16).padStart(2, '0')}${pixel.b.toString(16).padStart(2, '0')}`
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting pixel color: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_locate_image',
    description: 'Find an image on the screen',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path to the image file to find' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence threshold (0-1)' },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          },
          required: ['x', 'y', 'width', 'height'],
          description: 'Region to search in (optional)'
        },
        find_all: { type: 'boolean', description: 'Find all matches instead of just the first' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum number of matches to return when find_all is true' }
      },
      required: ['image_path']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        if (args.region) {
          BoundsSchema.parse(args.region);
        }

        const adapter = await ensureAutoGUI();
        const options = {
          confidence: args.confidence,
          region: args.region,
          limit: args.limit
        };

        if (args.find_all) {
          const matches = await adapter.locateAllOnScreen(args.image_path, options);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                matches_found: matches.length,
                matches: matches
              }, null, 2)
            }]
          };
        } else {
          const match = await adapter.locateOnScreen(args.image_path, options);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                found: match !== null,
                match: match
              }, null, 2)
            }]
          };
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error locating image: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Window Management Tools
  {
    name: 'autogui_get_windows',
    description: 'Get information about open windows',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'Get only the active window' },
        title_filter: { type: 'string', description: 'Filter windows by title (partial match)' }
      },
      required: []
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();

        if (args.active_only) {
          const activeWindow = await adapter.getActiveWindow();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                active_window: activeWindow
              }, null, 2)
            }]
          };
        }

        let windows = await adapter.getAllWindows();

        if (args.title_filter) {
          const filter = args.title_filter.toLowerCase();
          windows = windows.filter(w => w.title.toLowerCase().includes(filter));
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              window_count: windows.length,
              windows: windows
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error getting window information: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'autogui_control_window',
    description: 'Control a window (activate, minimize, maximize, resize, move, close)',
    inputSchema: {
      type: 'object',
      properties: {
        window_id: { type: ['string', 'number'], description: 'Window ID or title' },
        action: { 
          type: 'string', 
          enum: ['activate', 'minimize', 'maximize', 'resize', 'move', 'close'],
          description: 'Action to perform on the window'
        },
        width: { type: 'number', description: 'New width (for resize action)' },
        height: { type: 'number', description: 'New height (for resize action)' },
        x: { type: 'number', description: 'New X position (for move action)' },
        y: { type: 'number', description: 'New Y position (for move action)' }
      },
      required: ['window_id', 'action']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        let windowId = args.window_id;

        // If window_id is a string, try to find window by title
        if (typeof windowId === 'string' && isNaN(Number(windowId))) {
          const window = await adapter.getWindowByTitle(windowId);
          if (!window) {
            return {
              content: [{
                type: 'text',
                text: `Window with title "${windowId}" not found`
              }],
              isError: true
            };
          }
          windowId = window.id;
        }

        switch (args.action) {
          case 'activate':
            await adapter.activateWindow(windowId);
            break;
          case 'minimize':
            await adapter.minimizeWindow(windowId);
            break;
          case 'maximize':
            await adapter.maximizeWindow(windowId);
            break;
          case 'resize':
            if (!args.width || !args.height) {
              throw new Error('Width and height required for resize action');
            }
            await adapter.resizeWindow(windowId, args.width, args.height);
            break;
          case 'move':
            if (args.x === undefined || args.y === undefined) {
              throw new Error('X and Y coordinates required for move action');
            }
            await adapter.moveWindow(windowId, args.x, args.y);
            break;
          case 'close':
            await adapter.closeWindow(windowId);
            break;
          default:
            throw new Error(`Unknown window action: ${args.action}`);
        }

        return {
          content: [{
            type: 'text',
            text: `Window ${args.action} action completed for window ${windowId}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error controlling window: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },

  // Utility Tools
  {
    name: 'autogui_sleep',
    description: 'Pause execution for a specified duration',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Duration to sleep in seconds' }
      },
      required: ['seconds']
    },
    handler: async (args: any): Promise<ToolResult> => {
      try {
        const adapter = await ensureAutoGUI();
        await adapter.sleep(args.seconds);
        
        return {
          content: [{
            type: 'text',
            text: `Slept for ${args.seconds} seconds`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error during sleep: ${error.message}`
          }],
          isError: true
        };
      }
    }
  }
];