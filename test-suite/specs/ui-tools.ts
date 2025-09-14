/**
 * Test specifications for UI tools
 */

import { ToolTestSpec } from '../src/types.js';

export const uiToolSpecs: ToolTestSpec[] = [
  {
    name: 'ui_init',
    category: 'ui',
    description: 'Test UI framework initialization',
    testCases: [
      {
        name: 'initialize with default framework',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'initialized|ready|success'
            }
          ]
        }
      },
      {
        name: 'initialize with specific framework',
        input: { framework: 'react' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'react|initialized'
            }
          ]
        }
      }
    ]
  },

  {
    name: 'ui_list_components',
    category: 'ui',
    description: 'Test component listing functionality',
    testCases: [
      {
        name: 'list all components',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 10
            }
          ]
        }
      },
      {
        name: 'list components by category',
        input: { category: 'form' },
        expect: {
          success: true
        }
      },
      {
        name: 'search components',
        input: { search: 'button' },
        expect: {
          success: true
        }
      }
    ]
  },

  {
    name: 'ui_get_component',
    category: 'ui',
    description: 'Test component retrieval',
    testCases: [
      {
        name: 'get existing component',
        input: { name: 'button' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'button|component'
            }
          ]
        }
      },
      {
        name: 'get non-existent component',
        input: { name: 'nonexistent-component' },
        expect: {
          success: false,
          errorPattern: 'not found|does not exist'
        }
      }
    ]
  },

  {
    name: 'ui_get_component_source',
    category: 'ui',
    description: 'Test component source code retrieval',
    testCases: [
      {
        name: 'get component source',
        input: { name: 'button' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 50
            }
          ]
        }
      },
      {
        name: 'get source for non-existent component',
        input: { name: 'invalid-component' },
        expect: {
          success: false
        }
      }
    ]
  },

  {
    name: 'ui_get_component_demo',
    category: 'ui',
    description: 'Test component demo/example retrieval',
    testCases: [
      {
        name: 'get component demo',
        input: { name: 'button' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'demo|example|usage'
            }
          ]
        }
      }
    ]
  },

  {
    name: 'ui_add_component',
    category: 'ui',
    description: 'Test component addition to project',
    testCases: [
      {
        name: 'add component to project',
        input: { name: 'button', destination: '/tmp/test-ui' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'added|installed|success'
            }
          ]
        },
        setup: async () => {
          require('fs').mkdirSync('/tmp/test-ui', { recursive: true });
        },
        cleanup: async () => {
          require('fs').rmSync('/tmp/test-ui', { recursive: true, force: true });
        }
      },
      {
        name: 'add to invalid destination',
        input: { name: 'button', destination: '/invalid/path' },
        expect: {
          success: false,
          errorPattern: 'ENOENT|permission denied|not found'
        }
      }
    ]
  },

  {
    name: 'ui_list_blocks',
    category: 'ui',
    description: 'Test UI block listing',
    testCases: [
      {
        name: 'list all blocks',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 0
            }
          ]
        }
      },
      {
        name: 'list blocks by category',
        input: { category: 'layout' },
        expect: {
          success: true
        }
      }
    ]
  },

  {
    name: 'ui_get_block',
    category: 'ui',
    description: 'Test UI block retrieval',
    testCases: [
      {
        name: 'get existing block',
        input: { name: 'header' },
        expect: {
          success: true
        }
      },
      {
        name: 'get non-existent block',
        input: { name: 'invalid-block' },
        expect: {
          success: false
        }
      }
    ]
  },

  {
    name: 'ui_list_styles',
    category: 'ui',
    description: 'Test style/theme listing',
    testCases: [
      {
        name: 'list available styles',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 0
            }
          ]
        }
      }
    ]
  },

  {
    name: 'ui_search_registry',
    category: 'ui',
    description: 'Test registry search functionality',
    testCases: [
      {
        name: 'search for components',
        input: { query: 'form' },
        expect: {
          success: true
        }
      },
      {
        name: 'empty search query',
        input: { query: '' },
        expect: {
          success: true
        }
      }
    ]
  },

  {
    name: 'ui_get_installation_guide',
    category: 'ui',
    description: 'Test installation guide retrieval',
    testCases: [
      {
        name: 'get installation guide',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'install|setup|guide'
            }
          ]
        }
      },
      {
        name: 'get framework-specific guide',
        input: { framework: 'react' },
        expect: {
          success: true
        }
      }
    ]
  }
];