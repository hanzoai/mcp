# UI Tool Consolidation - Migration Guide

## Overview

We've consolidated all 14+ UI tools into a single unified `ui` tool with method-based routing. This significantly reduces the MCP tool surface area while maintaining full functionality.

## Architecture Benefits

### Before (14 tools)
- `ui_init`
- `ui_list_components`
- `ui_get_component`
- `ui_get_component_source`
- `ui_get_component_demo`
- `ui_add_component`
- `ui_list_blocks`
- `ui_get_block`
- `ui_list_styles`
- `ui_search_registry`
- `ui_get_installation_guide`
- `ui_add_multi_framework`
- `ui_compare_frameworks`
- `ui_convert_framework`

### After (1 tool)
- `ui` with `method` parameter

## Migration Steps

### 1. Update Tool Registration

**Before:**
```typescript
import { uiTools } from '../ui/ui-tools.js';
import { multiFrameworkTools } from '../ui/multi-framework-tools.js';

// Register 14 tools
const allTools = [
  ...uiTools,
  ...multiFrameworkTools,
  // other tools
];
```

**After:**
```typescript
import { unifiedUITool } from '../ui/unified-ui-tool.js';

// Register 1 tool
const allTools = [
  unifiedUITool,
  // other tools
];
```

### 2. Update Tool Usage

**Before:**
```typescript
// Each operation was a separate tool
await ui_list_components({ type: 'ui' });
await ui_get_component({ name: 'button' });
await ui_get_component_source({ name: 'button' });
```

**After:**
```typescript
// All operations through single tool with method parameter
await ui({ method: 'list_components', type: 'ui' });
await ui({ method: 'get_component', name: 'button' });
await ui({ method: 'get_source', name: 'button' });
```

## Method Mapping

| Old Tool | New Method | Parameters |
|----------|------------|------------|
| `ui_init` | `init` | `style?` |
| `ui_list_components` | `list_components` | `type?`, `category?` |
| `ui_get_component` | `get_component` | `name` or `component` |
| `ui_get_component_source` | `get_source` | `name` or `component` |
| `ui_get_component_demo` | `get_demo` | `name` or `component` |
| `ui_add_component` | `add_component` | `name`, `style?`, `framework?` |
| `ui_list_blocks` | `list_blocks` | `category?` |
| `ui_get_block` | `get_block` | `name` or `block` |
| `ui_list_styles` | `list_styles` | none |
| `ui_search_registry` | `search` | `query` or `search` |
| `ui_get_installation_guide` | `installation_guide` | `framework?` |
| `ui_add_multi_framework` | `add_component` | `component`, `framework` |
| `ui_compare_frameworks` | `compare_frameworks` | `component?` |
| `ui_convert_framework` | `convert_framework` | `component`, `from`, `to` |

## AI Assistant Usage

### For Claude/GPT/Other AI

The unified tool is more discoverable and easier to use:

```typescript
// List all UI operations
ui({ method: 'list_components' })

// Get specific component
ui({
  method: 'get_component',
  name: 'button'
})

// Search components
ui({
  method: 'search',
  query: 'form'
})

// Multi-framework support
ui({
  method: 'add_component',
  component: 'button',
  framework: 'vue'
})
```

## Advantages

1. **Reduced Complexity**: 1 tool instead of 14
2. **Better Discovery**: AI can see all methods in one place
3. **Consistent Interface**: Same pattern for all operations
4. **Easier Maintenance**: Single file to update
5. **Backward Compatible**: Parameter aliases support old naming
6. **Extensible**: Easy to add new methods

## Implementation Details

### Tool Structure
```typescript
const unifiedUITool: Tool = {
  name: 'ui',
  description: 'Comprehensive UI tool for Hanzo UI components',
  inputSchema: {
    method: enum([...methods]),
    // Common parameters
    name: string (optional),
    component: string (optional),
    // Method-specific parameters
    ...
  },
  handler: async (args) => {
    // Route to appropriate method handler
    return methodHandlers[args.method](args);
  }
}
```

### Method Handlers
Each method is implemented as a separate async function, maintaining the same logic as the original tools but with unified parameter handling.

## Testing

### Test the unified tool:
```bash
# Run tests
npm test src/ui/unified-ui-tool.test.ts

# Test each method
npm run test:ui -- --grep "method: init"
npm run test:ui -- --grep "method: list_components"
```

## Rollback Plan

If needed, the original tools are preserved and can be restored by:
1. Switching imports back to original files
2. Re-registering individual tools
3. No code changes needed in tool implementations

## Future Enhancements

1. **Smart Method Detection**: Auto-detect method from parameters
2. **Method Aliases**: Support multiple names for same operation
3. **Batch Operations**: Execute multiple methods in one call
4. **Caching**: Share registry cache across methods
5. **Streaming**: Support streaming responses for large results

## Questions?

Contact the Hanzo MCP team or open an issue on GitHub.