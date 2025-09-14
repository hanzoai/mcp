# MCP Test Suite

A comprehensive, language-agnostic test suite for Model Context Protocol (MCP) implementations. This test suite ensures parity across different programming languages by testing the exact same MCP protocol messages and tool behaviors.

## Overview

The MCP Test Suite provides:

- 🌍 **Language-agnostic testing** - Test any MCP implementation (TypeScript, Rust, Python, Go, etc.)
- 🔧 **Comprehensive tool coverage** - Tests for all 45+ tools across core, UI, and AutoGUI categories
- ⚡ **Parallel execution** - Concurrent testing for performance
- 📊 **Rich reporting** - HTML and JSON reports with detailed results
- 🎯 **Parity validation** - Ensures implementations behave identically
- 🔌 **Easy integration** - Simple CLI and programmatic API

## Quick Start

### CLI Usage

```bash
# Test all enabled implementations
npx ts-node src/cli.ts test

# Test specific implementation
npx ts-node src/cli.ts test --implementations typescript

# Test only core tools
npx ts-node src/cli.ts test --quick

# Test specific categories
npx ts-node src/cli.ts test --categories files search shell

# Verbose output with custom timeout
npx ts-node src/cli.ts test --verbose --timeout 45000

# List available implementations
npx ts-node src/cli.ts list-implementations

# List available tools
npx ts-node src/cli.ts list-tools --stats

# Validate a specific implementation
npx ts-node src/cli.ts validate typescript
```

### Programmatic Usage

```typescript
import { runMCPTestSuite, quickTest } from './src/index.js';

// Run full test suite
const results = await runMCPTestSuite({
  implementations: ['typescript', 'rust'],
  toolSpecs: coreToolSpecs,
  parallel: {
    maxConcurrentImplementations: 2,
    maxConcurrentTestsPerImpl: 3
  }
});

// Quick test for development
const quickResults = await quickTest({
  implementation: 'typescript',
  categories: ['files', 'shell'],
  verbose: true
});
```

## Architecture

### Core Components

```
test-suite/
├── src/
│   ├── types.ts              # Type definitions
│   ├── mcp-protocol.ts       # MCP protocol utilities
│   ├── server-manager.ts     # Process lifecycle management
│   ├── test-runner.ts        # Main orchestration
│   ├── cli.ts               # Command-line interface
│   └── index.ts             # Public API
├── specs/
│   ├── core-tools.ts        # Core tool test specifications
│   ├── ui-tools.ts          # UI tool test specifications
│   ├── autogui-tools.ts     # AutoGUI tool test specifications
│   └── index.ts             # Unified specifications
├── configs/
│   └── implementations.ts   # Implementation configurations
├── fixtures/                # Test data and fixtures
└── utils/                  # Utility functions
```

### Test Flow

1. **Server Management** - Spawns MCP servers as child processes
2. **Protocol Handshake** - Initializes MCP connection with each server
3. **Tool Discovery** - Lists available tools and validates schemas
4. **Test Execution** - Runs tool-specific test cases in parallel
5. **Response Validation** - Validates MCP protocol compliance and tool behavior
6. **Report Generation** - Creates HTML and JSON reports

## Implementation Configuration

### Adding New Implementations

1. **Create configuration** in `configs/implementations.ts`:

```typescript
{
  id: 'rust',
  name: 'Hanzo MCP Rust',
  language: 'rust',
  command: 'cargo',
  args: ['run', '--bin', 'mcp-server', '--', 'serve'],
  cwd: '../mcp-rust',
  env: { RUST_LOG: 'error' },
  startupTimeout: 15000,
  enabled: true,
  expectedCategories: ['files', 'search', 'shell'],
  expectedToolCount: 15
}
```

2. **Generate configuration template**:

```bash
npx ts-node src/cli.ts dev generate-config rust rust
```

3. **Validate implementation**:

```bash
npx ts-node src/cli.ts validate rust
```

### Configuration Options

- `id`: Unique identifier
- `name`: Human-readable name
- `language`: Programming language
- `command` & `args`: How to start the server
- `cwd`: Working directory (optional)
- `env`: Environment variables
- `startupTimeout`: How long to wait for server startup
- `enabled`: Whether to include in tests
- `expectedCategories`: Tool categories this implementation supports
- `expectedToolCount`: Expected number of tools (for validation)

## Test Specifications

### Core Tool Categories

- **Files**: `read_file`, `write_file`, `list_files`, `get_file_info`, `directory_tree`
- **Search**: `grep`, `find_files`, `search`
- **Shell**: `bash`, `run_command`, `run_background`, `list_processes`, `kill_process`
- **Edit**: Text editing and manipulation tools
- **UI**: Component and design system tools
- **AutoGUI**: GUI automation tools

### Test Case Structure

```typescript
{
  name: 'read existing file',
  input: { path: '/tmp/test-file.txt' },
  expect: {
    success: true,
    content: [{
      type: 'text',
      minLength: 0
    }]
  },
  setup: async () => {
    require('fs').writeFileSync('/tmp/test-file.txt', 'Hello, World!');
  },
  cleanup: async () => {
    require('fs').unlinkSync('/tmp/test-file.txt');
  }
}
```

### Adding Custom Tests

Create new test specifications in the `specs/` directory:

```typescript
export const myToolSpecs: ToolTestSpec[] = [
  {
    name: 'my_custom_tool',
    category: 'custom',
    description: 'Test my custom tool',
    testCases: [
      {
        name: 'basic functionality',
        input: { param: 'value' },
        expect: { success: true }
      }
    ]
  }
];
```

## Protocol Validation

The test suite validates strict MCP protocol compliance:

### Message Format
- JSON-RPC 2.0 structure
- Required fields: `jsonrpc`, `id`, `method`
- Proper error vs result handling

### Tool Definitions
- Valid JSON Schema for input
- Required fields: `name`, `description`, `inputSchema`
- Schema type validation

### Response Format
- Content array structure
- Supported content types: `text`, `image`, `resource`
- Error handling and codes

## Reporting

### HTML Reports
Rich interactive reports with:
- Summary statistics
- Per-implementation results
- Detailed test case results
- Filtering and sorting
- Visual charts and graphs

### JSON Reports
Machine-readable results for CI/CD:
- Complete test results
- Timing information
- Error details
- Implementation comparison

### Example Report Structure

```json
{
  "implementations": ["typescript", "rust"],
  "timestamp": "2024-01-15T10:30:00Z",
  "totalTests": 150,
  "passedTests": 147,
  "failedTests": 3,
  "summary": {
    "typescript": {
      "total": 75,
      "passed": 75,
      "failed": 0,
      "categories": {
        "files": { "total": 15, "passed": 15, "failed": 0 }
      }
    }
  },
  "results": [...]
}
```

## CI/CD Integration

### GitHub Actions

```yaml
name: MCP Parity Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - run: npx ts-node test-suite/src/cli.ts test --implementations typescript
      - uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/
```

### Environment Variables

- `NODE_ENV=test` - Test environment
- `MCP_TEST_MODE=quick` - Quick test mode
- `CI=true` - Detected CI environment
- `VERBOSE=true` - Verbose output

## Performance Considerations

### Parallel Execution
- Configure `maxConcurrentImplementations` and `maxConcurrentTestsPerImpl`
- Balance between speed and resource usage
- Monitor system resources during testing

### Optimization Tips
- Use `--quick` for development
- Filter by categories or specific tools
- Increase timeouts for slow implementations
- Use fixtures for complex test data

## Troubleshooting

### Common Issues

1. **Server startup timeout**
   - Increase `startupTimeout` in implementation config
   - Check server logs for initialization errors
   - Verify command and arguments are correct

2. **Test failures**
   - Use `--verbose` for detailed output
   - Check implementation-specific logs
   - Validate tool schemas match expectations

3. **Protocol errors**
   - Ensure proper JSON-RPC 2.0 format
   - Check MCP version compatibility
   - Validate message structure

### Debug Mode

```bash
# Enable verbose logging
DEBUG=mcp:* npx ts-node src/cli.ts test --verbose

# Test single implementation
npx ts-node src/cli.ts validate typescript --verbose

# Test specific tool
npx ts-node src/cli.ts test --tools read_file --verbose
```

## Contributing

### Adding New Tool Tests

1. Add tool specification to appropriate `specs/*.ts` file
2. Include comprehensive test cases with setup/cleanup
3. Test both success and failure scenarios
4. Add documentation for any special requirements

### Supporting New Languages

1. Create implementation configuration
2. Ensure MCP protocol compliance
3. Test with existing tool specifications
4. Add language-specific considerations to documentation

## Development

### Setup

```bash
cd test-suite
npm install
npx ts-node src/cli.ts list-implementations
```

### Running Tests

```bash
# Quick development test
npx ts-node src/cli.ts test --quick --verbose

# Full test suite
npx ts-node src/cli.ts test

# Specific implementation
npx ts-node src/cli.ts test --implementations typescript-core
```

### Building

The test suite uses TypeScript with ES modules. No build step required for development.

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
- GitHub Issues: https://github.com/hanzoai/mcp/issues
- Documentation: https://docs.hanzo.ai/mcp
- Discord: https://discord.gg/hanzo