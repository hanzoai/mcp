package hanzomcp

import (
	"github.com/hanzoai/mcp/go/search"
)

// SearchProvider wraps the trigram index for MCP tool usage
type SearchProvider struct {
	Index *search.Index
}

func NewSearchProvider() *SearchProvider {
	return &SearchProvider{
		Index: search.NewIndex(),
	}
}

// FastSearch handles the logic for immediate exact-match retrieval
func (sp *SearchProvider) FastSearch(query string) []search.Document {
	// This is the 'fast path' requested in the bounty
	return sp.Index.SearchExact(query)
}

// RegexSearch handles complex pattern matching
func (sp *SearchProvider) RegexSearch(pattern string) ([]search.Document, error) {
	return sp.Index.SearchRegex(pattern)
}
