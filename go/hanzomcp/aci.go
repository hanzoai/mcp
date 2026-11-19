package hanzomcp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ACIViewOptions defines the parameters for the concise viewing tool
type ACIViewOptions struct {
	Path      string `json:"path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

// ACIEditOptions defines the parameters for deterministic search-and-replace
type ACIEditOptions struct {
	Path    string `json:"path"`
	OldText string `json:"old_text"`
	NewText string `json:"new_text"`
}

// ACIResult encapsulates the structured response for the agent
type ACIResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output"`
	Error   string `json:"error,omitempty"`
}

// ACIController handles the logic for optimized agent-computer interaction
type ACIController struct {
	RootPath string
}

func NewACIController(root string) *ACIController {
	return &ACIController{RootPath: root}
}

// ViewFile provides a line-numbered, windowed view of a file to optimize context usage
func (c *ACIController) ViewFile(opt ACIViewOptions) ACIResult {
	fullPath := filepath.Join(c.RootPath, opt.Path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return ACIResult{Success: false, Error: fmt.Sprintf("File not found: %v", err)}
	}

	lines := strings.Split(string(content), "\n")
	totalLines := len(lines)

	start := opt.StartLine
	if start < 1 {
		start = 1
	}
	end := opt.EndLine
	if end <= 0 || end > totalLines {
		end = totalLines
	}

	var output strings.Builder
	output.WriteString(fmt.Sprintf("--- Viewing %s (Lines %d-%d of %d) ---\n", opt.Path, start, end, totalLines))
	
	for i := start - 1; i < end; i++ {
		output.WriteString(fmt.Sprintf("%d: %s\n", i+1, lines[i]))
	}

	return ACIResult{
		Success: true,
		Output:  output.String(),
	}
}

// EditFile implements a deterministic search-and-replace to ensure patch correctness
func (c *ACIController) EditFile(opt ACIEditOptions) ACIResult {
	fullPath := filepath.Join(c.RootPath, opt.Path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return ACIResult{Success: false, Error: fmt.Sprintf("Read error: %v", err)}
	}

	strContent := string(content)
	count := strings.Count(strContent, opt.OldText)

	if count == 0 {
		return ACIResult{Success: false, Error: "The exact 'old_text' block was not found in the file."}
	}
	if count > 1 {
		return ACIResult{Success: false, Error: "Multiple occurrences of 'old_text' found. Please provide a more specific block to ensure determinism."}
	}

	newContent := strings.Replace(strContent, opt.OldText, opt.NewText, 1)
	err = os.WriteFile(fullPath, []byte(newContent), 0644)
	if err != nil {
		return ACIResult{Success: false, Error: fmt.Sprintf("Write error: %v", err)}
	}

	return ACIResult{
		Success: true,
		Output:  fmt.Sprintf("File %s updated successfully.", opt.Path),
	}
}
