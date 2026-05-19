package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// Invoker is the contract between mcp's HTTP routes and the underlying
// tool runtime. The CGO-backed hanzomcp package implements this; a
// pure-Go cloud build with no MCP backend registers nil and the routes
// return 503.
type Invoker interface {
	// CallTool dispatches a tool by name with JSON-encoded params and
	// returns the JSON-encoded result envelope.
	CallTool(ctx context.Context, name string, paramsJSON []byte) ([]byte, error)

	// ListTools returns JSON-encoded definitions for the available tools.
	ListTools(ctx context.Context) ([]byte, error)
}

// ErrNoInvoker is returned when the route layer is mounted but no Invoker
// has been registered. Callers see HTTP 503.
var ErrNoInvoker = errors.New("mcp: no invoker registered (build without MCP runtime)")

var (
	mu      sync.RWMutex
	current Invoker
)

// SetInvoker registers the active Invoker. Pass nil to deactivate
// (routes return 503). Safe for concurrent use.
func SetInvoker(inv Invoker) {
	mu.Lock()
	current = inv
	mu.Unlock()
}

// get returns the active Invoker or the null implementation if none
// registered.
func get() Invoker {
	mu.RLock()
	inv := current
	mu.RUnlock()
	if inv == nil {
		return nullInvoker{}
	}
	return inv
}

// nullInvoker is the standby when no real backend is wired. Returns
// ErrNoInvoker so route handlers respond with 503.
type nullInvoker struct{}

func (nullInvoker) CallTool(context.Context, string, []byte) ([]byte, error) {
	return nil, ErrNoInvoker
}

func (nullInvoker) ListTools(context.Context) ([]byte, error) {
	return nil, ErrNoInvoker
}

// errorEnvelope is the JSON shape returned when the runtime fails or
// no invoker is registered.
type errorEnvelope struct {
	Success bool   `json:"success"`
	Error   string `json:"error"`
}

func encodeError(msg string) []byte {
	b, _ := json.Marshal(errorEnvelope{Success: false, Error: msg})
	return b
}
