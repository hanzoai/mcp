package hanzomcp

import (
	"testing"
)

func TestSimulateToolEffect(t *testing.T) {
	args := map[string]interface{}{
		"command": "rm -rf /",
	}

	result := SimulateToolEffect("shell_exec", args)
	
	if result.Allowed != false {
		t.Errorf("Expected simulation to block destructive command, but it was allowed")
	}

	if result.Risk != Destructive {
		t.Errorf("Expected Destructive risk level, got %v", result.Risk)
	}
}
