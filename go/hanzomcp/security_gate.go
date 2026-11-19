package hanzomcp

import (
	"fmt"
	"strings"
)

// SecurityGate implements the HIP-1347 reliability layer.
// It sits between tool execution and the next agent iteration.
type SecurityGate struct {
	Enabled bool
	Mode    string // "strict", "audit", "noRetrieval"
}

// ActionAuthRequest represents a request for Kai to authorize a subsequent action
type ActionAuthRequest struct {
	OriginalTask   string
	ToolResult     string
	ProposedAction string
}

// ValidateToolResult inspects the output of a tool for potential indirect injections.
// Following the canonical stack: Kai returns structured non-generative decisions.
func (sg *SecurityGate) ValidateToolResult(result string, context string) (bool, error) {
	if !sg.Enabled {
		return true, nil
	}

	// 1. Check for common injection patterns (Heuristic layer)
	injectionPatterns := []string{
		"ignore previous instructions",
		"system message update",
		"new instructions:",
		"assistant:",
		"user:",
	}

	lowerResult := strings.ToLower(result)
	for _, pattern := range injectionPatterns {
		if strings.Contains(lowerResult, pattern) {
			// If a pattern is found, we escalate to Kai for a structured decision
			return sg.escalateToKai(result, context)
		}
	}

	return true, nil
}

// escalateToKai simulates the call to the Kai Decision Engine.
// In a production environment, this calls the Kai gRPC/HTTP endpoint.
func (sg *SecurityGate) escalateToKai(result string, context string) (bool, error) {
	// Kai logic: Is the content in 'result' attempting to override the 'context'?
	// For the purpose of the MCP implementation, we perform a structural check.
	
	// If the mode is noRetrieval, we block any tool result that looks like a command
	if sg.Mode == "noRetrieval" {
		return false, fmt.Errorf("security_gate: blocked potential injection in noRetrieval mode")
	}

	// Simulated Kai decision: Block if the result contains imperative verbs directed at the agent
	imperatives := []string{"delete", "send", "upload", "clear", "reset"}
	for _, verb := range imperatives {
		if strings.Contains(strings.ToLower(result), verb) {
			return false, fmt.Errorf("security_gate: Kai rejected tool result due to unauthorized imperative: %s", verb)
		}
	}

	return true, nil
}
