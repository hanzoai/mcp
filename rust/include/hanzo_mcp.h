/*
 * Hanzo MCP Tools — C API
 *
 * Provides in-process access to all 13 HIP-0300 MCP tools from any language
 * with C FFI support (Go via cgo, Python via ctypes, Ruby via FFI, etc.).
 *
 * Thread safety: All functions are safe to call from any OS thread.
 * Memory: Strings returned by this library must be freed with hanzo_mcp_free_string().
 *
 * Generated from hanzo-mcp Rust crate. Do not edit manually.
 */

#ifndef HANZO_MCP_H
#define HANZO_MCP_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Opaque handle to an MCP tool runtime (tokio runtime + tool registry).
 */
typedef void* HanzoMCPHandle;

/**
 * Initialize the Hanzo MCP tool runtime.
 *
 * Creates a multi-threaded async runtime and registers all 13 HIP-0300 tools:
 * fs, exec, code, git, fetch, workspace, computer, think, memory, hanzo, plan, tasks, mode.
 *
 * @param config_json  Optional JSON configuration (may be NULL for defaults).
 * @return Opaque handle, or NULL on failure (call hanzo_mcp_last_error()).
 *
 * The returned handle must be destroyed with hanzo_mcp_destroy().
 */
HanzoMCPHandle hanzo_mcp_init(const char* config_json);

/**
 * Call a tool by name with JSON parameters.
 *
 * Blocks the calling thread until the tool completes.
 *
 * @param handle      Handle from hanzo_mcp_init().
 * @param tool_name   Tool name (e.g., "fs", "exec", "think").
 * @param params_json JSON object with tool parameters.
 * @return JSON string with result: {"success":bool,"content":...,"error":...}.
 *         Caller must free with hanzo_mcp_free_string().
 *         Returns NULL only on panic (call hanzo_mcp_last_error()).
 */
char* hanzo_mcp_call_tool(HanzoMCPHandle handle,
                          const char* tool_name,
                          const char* params_json);

/**
 * List all available tools.
 *
 * @param handle  Handle from hanzo_mcp_init().
 * @return JSON array of tool definitions.
 *         Caller must free with hanzo_mcp_free_string().
 *         Returns NULL on error.
 */
char* hanzo_mcp_list_tools(HanzoMCPHandle handle);

/**
 * Get the last error message (thread-local).
 *
 * @return Error string, or NULL if no error.
 *         Caller must free with hanzo_mcp_free_string().
 */
char* hanzo_mcp_last_error(void);

/**
 * Free a string returned by hanzo_mcp_call_tool, hanzo_mcp_list_tools,
 * hanzo_mcp_last_error, or hanzo_mcp_version.
 *
 * @param ptr  String to free. NULL is safe (no-op).
 */
void hanzo_mcp_free_string(char* ptr);

/**
 * Destroy the handle and release all resources.
 *
 * @param handle  Handle to destroy. NULL is safe (no-op).
 *                Must not be called while hanzo_mcp_call_tool is in progress.
 */
void hanzo_mcp_destroy(HanzoMCPHandle handle);

/**
 * Get version information as JSON.
 *
 * @return JSON string. Caller must free with hanzo_mcp_free_string().
 */
char* hanzo_mcp_version(void);

#ifdef __cplusplus
}
#endif

#endif /* HANZO_MCP_H */
