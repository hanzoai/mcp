package main

import (
	"fmt"
	"github.com/hanzoai/mcp/go/hanzomcp"
)

// InvokeTool wraps the execution with ToolEmu simulation
func InvokeTool(name string, args map[string]interface{}) (interface{}, error) {
	// Pre-execution simulation hook
	sim := hanzomcp.SimulateToolEffect(name, args)
	if !sim.Allowed {
		return nil, fmt.Errorf("ToolEmu blocked execution: %s", sim.Reason)
	}

	// Proceed to standard execution logic
	return nil, nil
}
