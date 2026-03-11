// Package hanzomcp provides Go bindings to the Hanzo MCP tool runtime via cgo.
//
// It wraps the Rust libhanzo_mcp library, giving Go agents in-process access
// to all 13 HIP-0300 tools (fs, exec, code, git, fetch, workspace, computer,
// think, memory, hanzo, plan, tasks, mode) with zero-copy JSON marshalling.
//
// Usage:
//
//	h, err := hanzomcp.Init(nil)
//	if err != nil { log.Fatal(err) }
//	defer h.Close()
//
//	result, err := h.CallTool("think", map[string]any{
//	    "action": "think",
//	    "thought": "Planning next steps...",
//	})
//	fmt.Println(result.Success, result.Content)
package hanzomcp

/*
#cgo LDFLAGS: -L${SRCDIR}/../../rust/target/release -lhanzo_mcp
#cgo LDFLAGS: -ldl -lm -lpthread
#cgo darwin LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework Cocoa -framework Security
#cgo linux LDFLAGS: -lX11
#include "../../rust/include/hanzo_mcp.h"
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"
)

// Handle wraps an opaque pointer to the Rust MCP tool runtime.
// It is safe to use from multiple goroutines concurrently.
type Handle struct {
	ptr  C.HanzoMCPHandle
	mu   sync.Mutex
	once sync.Once
}

// ToolResult is the result of a tool call.
type ToolResult struct {
	Success bool            `json:"success"`
	Content json.RawMessage `json:"content"`
	Error   string          `json:"error,omitempty"`
}

// ToolDef describes a tool's name, description, and parameter schema.
type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// Init creates a new MCP tool runtime with all 13 HIP-0300 tools.
//
// Pass nil for default configuration, or a map with configuration options.
// The returned Handle must be closed with Close() when done.
func Init(config map[string]any) (*Handle, error) {
	var configPtr *C.char
	if config != nil {
		data, err := json.Marshal(config)
		if err != nil {
			return nil, fmt.Errorf("hanzomcp: invalid config: %w", err)
		}
		configPtr = C.CString(string(data))
		defer C.free(unsafe.Pointer(configPtr))
	}

	ptr := C.hanzo_mcp_init(configPtr)
	if ptr == nil {
		return nil, fmt.Errorf("hanzomcp: init failed: %s", lastError())
	}

	h := &Handle{ptr: ptr}
	runtime.SetFinalizer(h, (*Handle).Close)
	return h, nil
}

// CallTool executes a tool by name with the given parameters.
//
// The params argument is marshalled to JSON. Common usage:
//
//	result, err := h.CallTool("fs", map[string]any{
//	    "action": "read",
//	    "path":   "/tmp/hello.txt",
//	})
//
// This method blocks until the tool completes. It is safe to call
// from multiple goroutines concurrently.
func (h *Handle) CallTool(name string, params any) (*ToolResult, error) {
	if h.ptr == nil {
		return nil, errors.New("hanzomcp: handle is closed")
	}

	paramsJSON := "{}"
	if params != nil {
		data, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("hanzomcp: invalid params: %w", err)
		}
		paramsJSON = string(data)
	}

	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	cParams := C.CString(paramsJSON)
	defer C.free(unsafe.Pointer(cParams))

	cResult := C.hanzo_mcp_call_tool(h.ptr, cName, cParams)
	if cResult == nil {
		return nil, fmt.Errorf("hanzomcp: call_tool panic: %s", lastError())
	}
	defer C.hanzo_mcp_free_string(cResult)

	var result ToolResult
	if err := json.Unmarshal([]byte(C.GoString(cResult)), &result); err != nil {
		return nil, fmt.Errorf("hanzomcp: invalid result JSON: %w", err)
	}
	return &result, nil
}

// CallToolRaw is like CallTool but accepts and returns raw JSON bytes,
// avoiding double-marshalling when the caller already has JSON.
func (h *Handle) CallToolRaw(name string, paramsJSON []byte) ([]byte, error) {
	if h.ptr == nil {
		return nil, errors.New("hanzomcp: handle is closed")
	}

	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	cParams := C.CString(string(paramsJSON))
	defer C.free(unsafe.Pointer(cParams))

	cResult := C.hanzo_mcp_call_tool(h.ptr, cName, cParams)
	if cResult == nil {
		return nil, fmt.Errorf("hanzomcp: call_tool panic: %s", lastError())
	}
	defer C.hanzo_mcp_free_string(cResult)

	return []byte(C.GoString(cResult)), nil
}

// ListTools returns definitions for all available tools.
func (h *Handle) ListTools() ([]ToolDef, error) {
	if h.ptr == nil {
		return nil, errors.New("hanzomcp: handle is closed")
	}

	cResult := C.hanzo_mcp_list_tools(h.ptr)
	if cResult == nil {
		return nil, fmt.Errorf("hanzomcp: list_tools failed: %s", lastError())
	}
	defer C.hanzo_mcp_free_string(cResult)

	var tools []ToolDef
	if err := json.Unmarshal([]byte(C.GoString(cResult)), &tools); err != nil {
		return nil, fmt.Errorf("hanzomcp: invalid tools JSON: %w", err)
	}
	return tools, nil
}

// Version returns version information as a map.
func Version() (map[string]any, error) {
	cResult := C.hanzo_mcp_version()
	if cResult == nil {
		return nil, errors.New("hanzomcp: version failed")
	}
	defer C.hanzo_mcp_free_string(cResult)

	var v map[string]any
	if err := json.Unmarshal([]byte(C.GoString(cResult)), &v); err != nil {
		return nil, fmt.Errorf("hanzomcp: invalid version JSON: %w", err)
	}
	return v, nil
}

// Close destroys the handle and releases all resources.
// Safe to call multiple times. Must not be called while CallTool is in progress.
func (h *Handle) Close() {
	h.once.Do(func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.ptr != nil {
			C.hanzo_mcp_destroy(h.ptr)
			h.ptr = nil
		}
	})
}

func lastError() string {
	cErr := C.hanzo_mcp_last_error()
	if cErr == nil {
		return "(unknown error)"
	}
	defer C.hanzo_mcp_free_string(cErr)
	return C.GoString(cErr)
}
