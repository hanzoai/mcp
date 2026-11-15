package search

import (
	"regexp"
	"strings"
)

// Trigram represents a 3-character sequence
type Trigram [3]byte

// ExtractTrigrams extracts all unique trigrams from a string
func ExtractTrigrams(s string) map[string]struct{} {
	trigrams := make(map[string]struct{})
	if len(s) < 3 {
		return trigrams
	}
	for i := 0; i < len(s)-2; i++ {
		trigrams[s[i:i+3]] = struct{}{}
	}
	return trigrams
}

// ExtractRequiredTrigrams extracts trigrams that MUST be present for a regex to match
// This is a simplified version of the logic used in Zoekt
func ExtractRequiredTrigrams(re *regexp.Regexp) []string {
	prefix, complete := re.LiteralPrefix()
	if complete || len(prefix) >= 3 {
		res := []string{}
		for i := 0; i < len(prefix)-2; i++ {
			res = append(res, prefix[i:i+3])
		}
		return res
	}
	return nil
}
