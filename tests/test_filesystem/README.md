# Filesystem Tool Tests

This directory contains tests for the filesystem tools in the Hanzo MCP project.

## Test Files

- `test_fs_tools.py`: Tests for the refactored filesystem tools
- `test_file_operations.py`: Tests for various file operations
- `test_write_file.py`: Comprehensive tests for the write file tool

## Write File Tool Testing

The `test_write_file.py` file contains comprehensive tests for the write file tool, including:

### Success Cases
- Writing files with standard content
- Creating nested directories
- Writing files with Unicode content
- Overwriting existing files
- Writing large files

### Error Cases
- Missing path parameter
- Empty path parameter
- Missing content parameter
- Path not allowed
- Parent directory not allowed
- Write permission issues
- Encoding errors
- I/O errors

## Running Tests

To run all filesystem tests:

```bash
make test TEST_DIR=tests/test_filesystem
```

To run a specific test file:

```bash
make test TEST_DIR=tests/test_filesystem/test_write_file.py
```

## Adding New Tests

When adding new tests for filesystem tools, follow these guidelines:

1. Use appropriate fixtures for setup and teardown
2. Mock external dependencies and tool context
3. Test both success and error paths
4. Verify file content and filesystem state after operations
5. Clean up temporary files after tests
6. Add tests for various edge cases (permissions, encoding, large files, etc.)

## Error Handling

The write_file tool has been enhanced with improved error handling:

1. Error categorization: Different types of errors are caught and handled appropriately
2. Detailed error messages: Error messages include specific information about what went wrong
3. Logging: All errors are logged with appropriate severity levels
4. Error propagation: Errors are properly returned to the client

## Debug Logging

To enable debug logging during tests:

```bash
make test TEST_DIR=tests/test_filesystem LOG_LEVEL=DEBUG
```

This will provide detailed logs of the test execution, including input parameters, error conditions, and results.
