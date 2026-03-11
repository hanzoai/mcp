//! C FFI for hanzo-mcp tools.
//!
//! Exposes the full HIP-0300 tool surface as a C-compatible shared/static library.
//! Designed for consumption via Go cgo, Python ctypes, or any C-compatible FFI.
//!
//! # Thread safety
//! All functions are safe to call from any OS thread. The internal tokio runtime
//! handles async scheduling. Multiple concurrent `hanzo_mcp_call_tool` calls are
//! supported — they block their respective calling threads while the tokio runtime
//! executes the tool asynchronously.
//!
//! # Memory ownership
//! - Strings returned by Rust (from `call_tool`, `list_tools`, `last_error`) must
//!   be freed by the caller via `hanzo_mcp_free_string`.
//! - Strings passed to Rust (tool_name, params_json, config_json) are borrowed —
//!   the caller retains ownership.

use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::ptr;

use crate::ToolRegistry;

/// Opaque handle wrapping a tokio runtime + tool registry.
struct FFIContext {
    runtime: tokio::runtime::Runtime,
    registry: ToolRegistry,
}

/// Opaque handle type exposed to C.
pub type HanzoMCPHandle = *mut FFIContext;

// Thread-local storage for the last error message.
thread_local! {
    static LAST_ERROR: RefCell<Option<CString>> = RefCell::new(None);
}

fn set_last_error(msg: &str) {
    LAST_ERROR.with(|cell| {
        *cell.borrow_mut() = CString::new(msg).ok();
    });
}

/// Convert a raw C string pointer to a Rust &str.
/// Returns None if the pointer is null or not valid UTF-8.
unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Return a heap-allocated C string. Caller must free with `hanzo_mcp_free_string`.
fn to_c_string(s: &str) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => {
            // String contained an interior NUL — replace them
            let sanitized = s.replace('\0', "\\0");
            CString::new(sanitized)
                .unwrap_or_else(|_| CString::new("internal error").unwrap())
                .into_raw()
        }
    }
}

// ─── Public C API ──────────────────────────────────────────────────────────

/// Initialize the Hanzo MCP tool runtime.
///
/// Creates a multi-threaded tokio runtime and a `ToolRegistry` with all 13
/// HIP-0300 tools registered. The returned handle must be destroyed with
/// `hanzo_mcp_destroy`.
///
/// # Parameters
/// - `config_json`: Optional JSON configuration string (may be NULL for defaults).
///
/// # Returns
/// Opaque handle, or NULL on failure (call `hanzo_mcp_last_error` for details).
#[no_mangle]
pub extern "C" fn hanzo_mcp_init(config_json: *const c_char) -> HanzoMCPHandle {
    let result = std::panic::catch_unwind(|| {
        // Parse optional config
        let _config: Option<serde_json::Value> = unsafe {
            cstr_to_str(config_json).and_then(|s| serde_json::from_str(s).ok())
        };

        // Build tokio runtime
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("hanzo-mcp-ffi")
            .build()
            .map_err(|e| format!("Failed to create tokio runtime: {}", e))?;

        // Build registry with all default tools
        let registry = ToolRegistry::with_defaults();

        let ctx = Box::new(FFIContext { runtime, registry });
        Ok::<*mut FFIContext, String>(Box::into_raw(ctx))
    });

    match result {
        Ok(Ok(ptr)) => ptr,
        Ok(Err(msg)) => {
            set_last_error(&msg);
            ptr::null_mut()
        }
        Err(_) => {
            set_last_error("panic during hanzo_mcp_init");
            ptr::null_mut()
        }
    }
}

/// Call a tool by name with JSON parameters.
///
/// This function blocks the calling thread until the tool completes.
/// The internal tokio runtime handles async execution.
///
/// # Parameters
/// - `handle`: Handle from `hanzo_mcp_init`.
/// - `tool_name`: Tool name (e.g., "fs", "exec", "think").
/// - `params_json`: JSON object with tool parameters (e.g., `{"action":"read","path":"/tmp/foo"}`).
///
/// # Returns
/// JSON string with the result. Caller must free with `hanzo_mcp_free_string`.
/// Returns NULL on fatal error (call `hanzo_mcp_last_error`).
///
/// The result JSON has the shape:
/// ```json
/// {"success": true, "content": {...}, "error": null}
/// ```
#[no_mangle]
pub extern "C" fn hanzo_mcp_call_tool(
    handle: HanzoMCPHandle,
    tool_name: *const c_char,
    params_json: *const c_char,
) -> *mut c_char {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return Err("null handle".to_string());
        }

        let ctx = unsafe { &*handle };

        let name = unsafe { cstr_to_str(tool_name) }
            .ok_or_else(|| "invalid tool_name".to_string())?;

        let params_str = unsafe { cstr_to_str(params_json) }.unwrap_or("{}");
        let params: serde_json::Value = serde_json::from_str(params_str)
            .map_err(|e| format!("invalid params JSON: {}", e))?;

        // Block on the async tool execution from the FFI thread.
        // This is safe because cgo threads are plain OS threads, not tokio workers.
        let tool_result = ctx
            .runtime
            .block_on(ctx.registry.execute(name, params))
            .map_err(|e| format!("tool execution error: {}", e))?;

        serde_json::to_string(&tool_result)
            .map_err(|e| format!("serialization error: {}", e))
    }));

    match result {
        Ok(Ok(json)) => to_c_string(&json),
        Ok(Err(msg)) => {
            // Return a structured error JSON instead of NULL for non-fatal errors
            let err_json = serde_json::json!({
                "success": false,
                "content": null,
                "error": msg
            });
            to_c_string(&err_json.to_string())
        }
        Err(_) => {
            set_last_error("panic during hanzo_mcp_call_tool");
            ptr::null_mut()
        }
    }
}

/// List all available tools.
///
/// # Returns
/// JSON array of tool definitions. Caller must free with `hanzo_mcp_free_string`.
/// Returns NULL on fatal error.
#[no_mangle]
pub extern "C" fn hanzo_mcp_list_tools(handle: HanzoMCPHandle) -> *mut c_char {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return Err("null handle".to_string());
        }
        let ctx = unsafe { &*handle };
        let defs = ctx.registry.get_definitions();
        serde_json::to_string(&defs).map_err(|e| format!("serialization error: {}", e))
    }));

    match result {
        Ok(Ok(json)) => to_c_string(&json),
        Ok(Err(msg)) => {
            set_last_error(&msg);
            ptr::null_mut()
        }
        Err(_) => {
            set_last_error("panic during hanzo_mcp_list_tools");
            ptr::null_mut()
        }
    }
}

/// Get the last error message (thread-local).
///
/// # Returns
/// Error string, or NULL if no error. Caller must free with `hanzo_mcp_free_string`.
#[no_mangle]
pub extern "C" fn hanzo_mcp_last_error() -> *mut c_char {
    LAST_ERROR.with(|cell| {
        let err = cell.borrow();
        match err.as_ref() {
            Some(cs) => {
                // Clone the error so the caller owns it
                match CString::new(cs.to_bytes()) {
                    Ok(clone) => clone.into_raw(),
                    Err(_) => ptr::null_mut(),
                }
            }
            None => ptr::null_mut(),
        }
    })
}

/// Free a string previously returned by `hanzo_mcp_call_tool`, `hanzo_mcp_list_tools`,
/// or `hanzo_mcp_last_error`.
///
/// # Safety
/// The pointer must have been returned by one of the above functions and must not
/// have been freed already. Passing NULL is safe (no-op).
#[no_mangle]
pub extern "C" fn hanzo_mcp_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}

/// Destroy the handle and release all resources (shuts down tokio runtime).
///
/// # Safety
/// The handle must not be used after this call. Passing NULL is safe (no-op).
/// Must not be called while `hanzo_mcp_call_tool` is in progress on another thread.
#[no_mangle]
pub extern "C" fn hanzo_mcp_destroy(handle: HanzoMCPHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Get version information as a JSON string.
///
/// # Returns
/// JSON string. Caller must free with `hanzo_mcp_free_string`.
#[no_mangle]
pub extern "C" fn hanzo_mcp_version() -> *mut c_char {
    let v = crate::version();
    to_c_string(&v.to_string())
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn test_init_and_destroy() {
        let handle = hanzo_mcp_init(ptr::null());
        assert!(!handle.is_null());
        hanzo_mcp_destroy(handle);
    }

    #[test]
    fn test_list_tools() {
        let handle = hanzo_mcp_init(ptr::null());
        assert!(!handle.is_null());

        let result = hanzo_mcp_list_tools(handle);
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let tools: Vec<serde_json::Value> = serde_json::from_str(json_str).unwrap();
        assert!(tools.len() >= 9); // At least the wired tools

        hanzo_mcp_free_string(result);
        hanzo_mcp_destroy(handle);
    }

    #[test]
    fn test_call_tool_think() {
        let handle = hanzo_mcp_init(ptr::null());
        assert!(!handle.is_null());

        let tool = CString::new("think").unwrap();
        let params = CString::new(r#"{"action":"think","thought":"FFI test"}"#).unwrap();

        let result = hanzo_mcp_call_tool(handle, tool.as_ptr(), params.as_ptr());
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["success"], true);

        hanzo_mcp_free_string(result);
        hanzo_mcp_destroy(handle);
    }

    #[test]
    fn test_call_tool_fs_help() {
        let handle = hanzo_mcp_init(ptr::null());
        let tool = CString::new("fs").unwrap();
        let params = CString::new(r#"{"action":"help"}"#).unwrap();

        let result = hanzo_mcp_call_tool(handle, tool.as_ptr(), params.as_ptr());
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["success"], true);

        hanzo_mcp_free_string(result);
        hanzo_mcp_destroy(handle);
    }

    #[test]
    fn test_null_handle() {
        let tool = CString::new("think").unwrap();
        let params = CString::new("{}").unwrap();

        let result = hanzo_mcp_call_tool(ptr::null_mut(), tool.as_ptr(), params.as_ptr());
        // Should return error JSON, not NULL
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["success"], false);

        hanzo_mcp_free_string(result);
    }

    #[test]
    fn test_unknown_tool() {
        let handle = hanzo_mcp_init(ptr::null());
        let tool = CString::new("nonexistent").unwrap();
        let params = CString::new("{}").unwrap();

        let result = hanzo_mcp_call_tool(handle, tool.as_ptr(), params.as_ptr());
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["success"], false);

        hanzo_mcp_free_string(result);
        hanzo_mcp_destroy(handle);
    }

    #[test]
    fn test_version() {
        let result = hanzo_mcp_version();
        assert!(!result.is_null());

        let json_str = unsafe { CStr::from_ptr(result).to_str().unwrap() };
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["name"], "hanzo-mcp");

        hanzo_mcp_free_string(result);
    }

    #[test]
    fn test_free_null() {
        // Should not crash
        hanzo_mcp_free_string(ptr::null_mut());
    }

    #[test]
    fn test_destroy_null() {
        // Should not crash
        hanzo_mcp_destroy(ptr::null_mut());
    }
}
