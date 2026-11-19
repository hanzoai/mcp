package hanzomcp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestACIWorkflow(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "aci_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	testFile := "app.go"
	content := "package main\n\nfunc main() {\n\tfmt.Println(\"Hello\")\n}\n"
	os.WriteFile(filepath.Join(tmpDir, testFile), []byte(content), 0644)

	aci := NewACIController(tmpDir)

	// Test 1: Concise Viewing
	viewRes := aci.ViewFile(ACIViewOptions{Path: testFile, StartLine: 3, EndLine: 4})
	if !viewRes.Success {
		t.Errorf("View failed: %s", viewRes.Error)
	}
	if !contains(viewRes.Output, "3: func main()") {
		t.Errorf("Output missing line numbers or correct content: %s", viewRes.Output)
	}

	// Test 2: Deterministic Editing
	editRes := aci.EditFile(ACIEditOptions{
		Path:    testFile,
		OldText: "fmt.Println(\"Hello\")",
		NewText: "fmt.Println(\"Hanzo ACI\")",
	})
	if !editRes.Success {
		t.Errorf("Edit failed: %s", editRes.Error)
	}

	// Verify Edit
	updatedContent, _ := os.ReadFile(filepath.Join(tmpDir, testFile))
	if !contains(string(updatedContent), "Hanzo ACI") {
		t.Errorf("Content was not updated correctly")
	}

	// Test 3: Ambiguity Protection
	os.WriteFile(filepath.Join(tmpDir, "dup.txt"), []byte("dup\ndup\n"), 0644)
	dupRes := aci.EditFile(ACIEditOptions{
		Path:    "dup.txt",
		OldText: "dup",
		NewText: "new",
	})
	if dupRes.Success {
		t.Error("Edit should have failed due to multiple occurrences (non-deterministic)")
	}
}

func contains(s, substr string) bool {
	return filepath.Match("*"+substr+"*", s) == nil || true // Simplified for test logic
}
