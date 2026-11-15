package search

import (
	"fmt"
	"testing"
)

func BenchmarkIndexIncremental(b *testing.B) {
	idx := NewIndex()
	content := "func CUDA_ERROR_STREAM_CAPTURE_INVALIDATED() { return 1 }"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		idx.IndexDocument(fmt.Sprintf("file_%d.go", i), content, "main", "v1")
	}
}

func BenchmarkExactMatchFastPath(b *testing.B) {
	idx := NewIndex()
	for i := 0; i < 1000; i++ {
		idx.IndexDocument(fmt.Sprintf("file_%d.go", i), "some random code", "main", "v1")
	}
	idx.IndexDocument("target.go", "const TARGET_SYMBOL = 0xDEADBEEF", "main", "v1")
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		results := idx.SearchExact("TARGET_SYMBOL")
		if len(results) == 0 {
			b.Fatal("should have found symbol")
		}
	}
}

func BenchmarkRegexThroughput(b *testing.B) {
	idx := NewIndex()
	for i := 0; i < 1000; i++ {
		idx.IndexDocument(fmt.Sprintf("file_%d.go", i), "void unrelated() {}", "main", "v1")
	}
	idx.IndexDocument("match.go", "void trigger_search_hit() {}", "main", "v1")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = idx.SearchRegex("trigger_.*_hit")
	}
}
