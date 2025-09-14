/**
 * Test specifications for core MCP tools
 */

import { ToolTestSpec } from '../src/types.js';

export const coreToolSpecs: ToolTestSpec[] = [
  // File Operations
  {
    name: 'read_file',
    category: 'files',
    description: 'Test file reading functionality',
    testCases: [
      {
        name: 'read existing text file',
        input: { path: '/tmp/test-file.txt' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 0
            }
          ]
        },
        setup: async () => {
          // Create test file
          require('fs').writeFileSync('/tmp/test-file.txt', 'Hello, World!');
        },
        cleanup: async () => {
          // Clean up test file
          require('fs').unlinkSync('/tmp/test-file.txt');
        }
      },
      {
        name: 'read non-existent file',
        input: { path: '/non/existent/file.txt' },
        expect: {
          success: false,
          errorPattern: 'ENOENT|no such file'
        }
      },
      {
        name: 'read with encoding',
        input: { path: '/tmp/test-utf8.txt', encoding: 'utf8' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'UTF-8 content'
            }
          ]
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/test-utf8.txt', 'UTF-8 content with émojis 🎉');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/test-utf8.txt');
        }
      }
    ]
  },

  {
    name: 'write_file',
    category: 'files',
    description: 'Test file writing functionality',
    testCases: [
      {
        name: 'write to new file',
        input: { path: '/tmp/test-write.txt', content: 'Test content' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'successfully|written'
            }
          ]
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/test-write.txt');
        }
      },
      {
        name: 'overwrite existing file',
        input: { path: '/tmp/test-overwrite.txt', content: 'New content' },
        expect: {
          success: true
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/test-overwrite.txt', 'Old content');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/test-overwrite.txt');
        }
      },
      {
        name: 'write to invalid path',
        input: { path: '/invalid/path/file.txt', content: 'Test' },
        expect: {
          success: false,
          errorPattern: 'ENOENT|permission denied|no such file'
        }
      }
    ]
  },

  {
    name: 'list_files',
    category: 'files',
    description: 'Test directory listing functionality',
    testCases: [
      {
        name: 'list current directory',
        input: { path: '.' },
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
        name: 'list with hidden files',
        input: { path: '.', showHidden: true },
        expect: {
          success: true
        }
      },
      {
        name: 'list non-existent directory',
        input: { path: '/non/existent/dir' },
        expect: {
          success: false,
          errorPattern: 'ENOENT|no such file'
        }
      }
    ]
  },

  {
    name: 'get_file_info',
    category: 'files',
    description: 'Test file metadata retrieval',
    testCases: [
      {
        name: 'get info for existing file',
        input: { path: '/tmp/info-test.txt' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'size|modified|type'
            }
          ]
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/info-test.txt', 'Test file for info');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/info-test.txt');
        }
      },
      {
        name: 'get info for non-existent file',
        input: { path: '/non/existent/file.txt' },
        expect: {
          success: false,
          errorPattern: 'ENOENT|no such file'
        }
      }
    ]
  },

  {
    name: 'directory_tree',
    category: 'files',
    description: 'Test directory tree visualization',
    testCases: [
      {
        name: 'tree of current directory',
        input: { path: '.' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 20
            }
          ]
        }
      },
      {
        name: 'tree with depth limit',
        input: { path: '.', depth: 2 },
        expect: {
          success: true
        }
      }
    ]
  },

  // Search Tools
  {
    name: 'grep',
    category: 'search',
    description: 'Test grep search functionality',
    testCases: [
      {
        name: 'search in file',
        input: { pattern: 'test', files: ['/tmp/grep-test.txt'] },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'test'
            }
          ]
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/grep-test.txt', 'This is a test file\nwith test content');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/grep-test.txt');
        }
      },
      {
        name: 'case insensitive search',
        input: { pattern: 'TEST', files: ['/tmp/grep-case.txt'], caseInsensitive: true },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'test|TEST'
            }
          ]
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/grep-case.txt', 'test content');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/grep-case.txt');
        }
      },
      {
        name: 'no matches found',
        input: { pattern: 'nonexistent', files: ['/tmp/grep-empty.txt'] },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'no matches|not found|0 matches'
            }
          ]
        },
        setup: async () => {
          require('fs').writeFileSync('/tmp/grep-empty.txt', 'some other content');
        },
        cleanup: async () => {
          require('fs').unlinkSync('/tmp/grep-empty.txt');
        }
      }
    ]
  },

  {
    name: 'find_files',
    category: 'search',
    description: 'Test file finding by pattern',
    testCases: [
      {
        name: 'find by extension',
        input: { pattern: '*.txt', directory: '/tmp' },
        expect: {
          success: true
        }
      },
      {
        name: 'find by name pattern',
        input: { pattern: 'test-*', directory: '/tmp' },
        expect: {
          success: true
        }
      }
    ]
  },

  {
    name: 'search',
    category: 'search',
    description: 'Test unified search functionality',
    testCases: [
      {
        name: 'basic text search',
        input: { query: 'function', path: '.' },
        expect: {
          success: true
        }
      },
      {
        name: 'search with file type filter',
        input: { query: 'export', path: '.', fileTypes: ['ts', 'js'] },
        expect: {
          success: true
        }
      }
    ]
  },

  // Shell Tools
  {
    name: 'bash',
    category: 'shell',
    description: 'Test bash command execution',
    testCases: [
      {
        name: 'simple echo command',
        input: { command: 'echo "Hello, World!"' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'Hello, World!'
            }
          ]
        }
      },
      {
        name: 'ls command',
        input: { command: 'ls -la' },
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
        name: 'invalid command',
        input: { command: 'nonexistentcommand' },
        expect: {
          success: false,
          errorPattern: 'command not found|not recognized'
        }
      },
      {
        name: 'command with timeout',
        input: { command: 'sleep 0.1', timeout: 1000 },
        expect: {
          success: true
        }
      }
    ]
  },

  {
    name: 'run_command',
    category: 'shell',
    description: 'Test shell command execution (alias for bash)',
    testCases: [
      {
        name: 'echo command via run_command',
        input: { command: 'echo "test"' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'test'
            }
          ]
        }
      }
    ]
  },

  {
    name: 'run_background',
    category: 'shell',
    description: 'Test background process execution',
    testCases: [
      {
        name: 'start background process',
        input: { command: 'sleep 1' },
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              textPattern: 'background|process|started'
            }
          ]
        }
      }
    ]
  },

  {
    name: 'list_processes',
    category: 'shell',
    description: 'Test background process listing',
    testCases: [
      {
        name: 'list running processes',
        input: {},
        expect: {
          success: true,
          content: [
            {
              type: 'text',
              minLength: 0 // May be empty if no background processes
            }
          ]
        }
      }
    ]
  },

  {
    name: 'kill_process',
    category: 'shell',
    description: 'Test process termination',
    testCases: [
      {
        name: 'kill non-existent process',
        input: { processId: 'nonexistent' },
        expect: {
          success: false,
          errorPattern: 'not found|invalid|does not exist'
        }
      }
    ]
  }
];