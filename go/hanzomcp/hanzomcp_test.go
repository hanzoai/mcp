package hanzomcp

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestInitAndClose(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	h.Close()
}

func TestDoubleClose(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	h.Close()
	h.Close() // should not panic
}

func TestVersion(t *testing.T) {
	v, err := Version()
	if err != nil {
		t.Fatalf("Version failed: %v", err)
	}
	if v["name"] != "hanzo-mcp" {
		t.Errorf("expected name=hanzo-mcp, got %v", v["name"])
	}
}

func TestListTools(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	tools, err := h.ListTools()
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}

	if len(tools) < 13 {
		t.Errorf("expected >= 13 tools, got %d", len(tools))
	}

	// Check canonical tool names
	names := make(map[string]bool)
	for _, tool := range tools {
		names[tool.Name] = true
	}

	canonical := []string{"fs", "exec", "code", "git", "fetch", "workspace",
		"think", "memory", "plan", "tasks", "mode", "computer"}
	for _, name := range canonical {
		if !names[name] {
			t.Errorf("missing canonical tool: %s", name)
		}
	}
}

func TestCallToolThink(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	result, err := h.CallTool("think", map[string]any{
		"action":  "think",
		"thought": "Go cgo FFI test",
	})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if !result.Success {
		t.Errorf("expected success, got error: %s", result.Error)
	}
}

func TestCallToolFsHelp(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	result, err := h.CallTool("fs", map[string]any{
		"action": "help",
	})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if !result.Success {
		t.Errorf("expected success, got error: %s", result.Error)
	}
}

func TestCallToolExec(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	result, err := h.CallTool("exec", map[string]any{
		"action":  "exec",
		"command": "echo hello-from-go",
	})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if !result.Success {
		t.Errorf("expected success, got error: %s", result.Error)
	}

	// Check output contains our string
	var content map[string]any
	if err := json.Unmarshal(result.Content, &content); err == nil {
		if stdout, ok := content["stdout"].(string); ok {
			if stdout == "" {
				t.Error("expected stdout to contain output")
			}
		}
	}
}

func TestCallToolUnknown(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	result, err := h.CallTool("nonexistent_tool", map[string]any{})
	if err != nil {
		t.Fatalf("CallTool should not error for unknown tool: %v", err)
	}
	if result.Success {
		t.Error("expected failure for unknown tool")
	}
}

func TestCallToolRaw(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	raw, err := h.CallToolRaw("think", []byte(`{"action":"think","thought":"raw test"}`))
	if err != nil {
		t.Fatalf("CallToolRaw failed: %v", err)
	}

	var result ToolResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !result.Success {
		t.Errorf("expected success: %s", result.Error)
	}
}

func TestCallToolClosedHandle(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	h.Close()

	_, err = h.CallTool("think", map[string]any{"action": "help"})
	if err == nil {
		t.Error("expected error for closed handle")
	}
}

func TestConcurrentCalls(t *testing.T) {
	h, err := Init(nil)
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	defer h.Close()

	const n = 20
	errs := make(chan error, n)

	for i := 0; i < n; i++ {
		go func(i int) {
			result, err := h.CallTool("think", map[string]any{
				"action":  "think",
				"thought": "concurrent test",
			})
			if err != nil {
				errs <- err
				return
			}
			if !result.Success {
				errs <- fmt.Errorf("call %d failed: %s", i, result.Error)
				return
			}
			errs <- nil
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("concurrent call failed: %v", err)
		}
	}
}

