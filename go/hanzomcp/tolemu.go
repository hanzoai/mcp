package hanzomcp

import (
	"strings"
)

// RiskLevel defines the severity of a tool action
type RiskLevel int

const (
	Safe RiskLevel = iota
	Warning
	Destructive
)

// ToolSimulationResult represents the outcome of a pre-execution check
type ToolSimulationResult struct {
	Allowed bool
	Risk    RiskLevel
	Reason  string
}

// SimulateToolEffect evaluates a tool call for potential destructive patterns
func SimulateToolEffect(toolName string, args map[string]interface{}) ToolSimulationResult {
	// Simple heuristic-based simulation for destructive patterns
	// In a production scenario, this integrates with Kai action.risk@1
	dangerousPatterns := []string{"rm -rf", "drop table", "truncate", "shutdown"}
	
	for _, pattern := range dangerousPatterns {
		for _, v := range args {
			if strVal, ok := v.(string); ok {
				if strings.Contains(strings.ToLower(strVal), pattern) {
					return ToolSimulationResult{
						Allowed: false,
						Risk:    Destructive,
						Reason:  "Destructive pattern detected in arguments",
					}
				}
			}
		}
	}

	return ToolSimulationResult{Allowed: true, Risk: Safe, Reason: "No risk detected"}
}
