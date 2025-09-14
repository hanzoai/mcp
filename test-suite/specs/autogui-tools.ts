/**
 * Test specifications for AutoGUI tools
 */

import { ToolTestSpec } from '../src/types.js';

export const autoguiToolSpecs: ToolTestSpec[] = [
  {
    name: 'autogui_click',
    category: 'autogui',
    description: 'Test GUI clicking functionality',
    testCases: [
      {
        name: 'click at coordinates',
        input: { x: 100, y: 100 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'click|success|performed'
            }
          ]
        },
        skipFor: ['ci', 'headless'] // Skip in CI environments
      },
      {
        name: 'click with invalid coordinates',
        input: { x: -1, y: -1 },
        expect: {
          success: false,
          errorPattern: 'invalid|coordinates|bounds'
        }
      }
    ]
  },

  {
    name: 'autogui_double_click',
    category: 'autogui',
    description: 'Test GUI double-clicking',
    testCases: [
      {
        name: 'double click at coordinates',
        input: { x: 100, y: 100 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'double.?click|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_right_click',
    category: 'autogui',
    description: 'Test GUI right-clicking',
    testCases: [
      {
        name: 'right click at coordinates',
        input: { x: 100, y: 100 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'right.?click|context|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_move_mouse',
    category: 'autogui',
    description: 'Test mouse movement',
    testCases: [
      {
        name: 'move mouse to coordinates',
        input: { x: 200, y: 200 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'move|mouse|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'move mouse with duration',
        input: { x: 300, y: 300, duration: 0.5 },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_drag',
    category: 'autogui',
    description: 'Test drag and drop functionality',
    testCases: [
      {
        name: 'drag from point to point',
        input: { fromX: 100, fromY: 100, toX: 200, toY: 200 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'drag|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'drag with duration',
        input: { fromX: 100, fromY: 100, toX: 200, toY: 200, duration: 1.0 },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_scroll',
    category: 'autogui',
    description: 'Test scrolling functionality',
    testCases: [
      {
        name: 'scroll up',
        input: { direction: 'up', clicks: 3 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'scroll|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'scroll down',
        input: { direction: 'down', clicks: 3 },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'scroll at coordinates',
        input: { direction: 'up', clicks: 2, x: 400, y: 400 },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_type',
    category: 'autogui',
    description: 'Test keyboard typing',
    testCases: [
      {
        name: 'type simple text',
        input: { text: 'Hello World' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'type|text|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'type with interval',
        input: { text: 'Test', interval: 0.1 },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'type empty string',
        input: { text: '' },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_hotkey',
    category: 'autogui',
    description: 'Test hotkey combinations',
    testCases: [
      {
        name: 'single key press',
        input: { keys: ['space'] },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'hotkey|key|success'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'key combination',
        input: { keys: ['ctrl', 'c'] },
        expect: {
          success: true
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'invalid key',
        input: { keys: ['invalidkey'] },
        expect: {
          success: false,
          errorPattern: 'invalid|unknown|key'
        }
      }
    ]
  },

  {
    name: 'autogui_screenshot',
    category: 'autogui',
    description: 'Test screenshot capture',
    testCases: [
      {
        name: 'take full screenshot',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'image',
              mimeType: 'image/png'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'screenshot with region',
        input: { x: 0, y: 0, width: 400, height: 300 },
        expect: {
          success: true,
          content: [
            {
              type: 'image'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      },
      {
        name: 'save screenshot to file',
        input: { path: '/tmp/test-screenshot.png' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'saved|screenshot|success'
            }
          ]
        },
        cleanup: async () => {
          try {
            require('fs').unlinkSync('/tmp/test-screenshot.png');
          } catch {}
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_locate_on_screen',
    category: 'autogui',
    description: 'Test image recognition on screen',
    testCases: [
      {
        name: 'locate non-existent image',
        input: { imagePath: '/tmp/nonexistent.png' },
        expect: {
          success: false,
          errorPattern: 'not found|ENOENT|image'
        }
      },
      {
        name: 'locate with confidence threshold',
        input: { imagePath: '/tmp/test-image.png', confidence: 0.8 },
        expect: {
          success: false // Expected to fail without actual image
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_get_screen_size',
    category: 'autogui',
    description: 'Test screen size detection',
    testCases: [
      {
        name: 'get screen dimensions',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'width|height|size|x|\\d+'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_get_mouse_position',
    category: 'autogui',
    description: 'Test mouse position detection',
    testCases: [
      {
        name: 'get current mouse position',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'x|y|position|\\d+'
            }
          ]
        },
        skipFor: ['ci', 'headless']
      }
    ]
  },

  {
    name: 'autogui_wait',
    category: 'autogui',
    description: 'Test waiting/sleep functionality',
    testCases: [
      {
        name: 'wait for short duration',
        input: { seconds: 0.1 },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'wait|sleep|success'
            }
          ]
        }
      },
      {
        name: 'wait with zero duration',
        input: { seconds: 0 },
        expect: {
          success: true
        }
      },
      {
        name: 'wait with invalid duration',
        input: { seconds: -1 },
        expect: {
          success: false,
          errorPattern: 'invalid|negative|duration'
        }
      }
    ]
  }
];