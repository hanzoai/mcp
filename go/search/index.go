package search

import (
	"regexp"
	"sync"
)

type Document struct {
	ID       uint32
	Path     string
	Content  string
	Branch   string
	Version  string
}

type Index struct {
	mu        sync.RWMutex
	postings  map[string][]uint32
	docs      map[uint32]Document
	nextDocID uint32
}

func NewIndex() *Index {
	return &Index{
		postings: make(map[string][]uint32),
		docs:     make(map[uint32]Document),
	}
}

// IndexDocument adds a document to the trigram index
func (idx *Index) IndexDocument(path, content, branch, version string) uint32 {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	docID := idx.nextDocID
	idx.nextDocID++

	doc := Document{
		ID:      docID,
		Path:    path,
		Content: content,
		Branch:  branch,
		Version: version,
	}
	idx.docs[docID] = doc

	// Index content
	trigrams := ExtractTrigrams(content)
	for tri := range trigrams {
		idx.postings[tri] = append(idx.postings[tri], docID)
	}

	// Index filename/path
	pathTrigrams := ExtractTrigrams(path)
	for tri := range pathTrigrams {
		idx.postings[tri] = append(idx.postings[tri], docID)
	}

	return docID
}

// SearchExact performs a fast-path exact match search
func (idx *Index) SearchExact(query string) []Document {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	if len(query) < 3 {
		return idx.fallbackSearch(query)
	}

	queryTrigrams := ExtractTrigrams(query)
	var candidates []uint32
	first := true

	for tri := range queryTrigrams {
		hits, ok := idx.postings[tri]
		if !ok {
			return nil // Trigram not found, exact match impossible
		}
		if first {
			candidates = append([]uint32(nil), hits...)
			first = false
		} else {
			candidates = intersect(candidates, hits)
		}
		if len(candidates) == 0 {
			break
		}
	}

	var results []Document
	for _, id := range candidates {
		doc := idx.docs[id]
		if strings.Contains(doc.Content, query) || strings.Contains(doc.Path, query) {
			results = append(results, doc)
		}
	}
	return results
}

// SearchRegex performs a trigram-accelerated regex search
func (idx *Index) SearchRegex(pattern string) ([]Document, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}

	idx.mu.RLock()
	defer idx.mu.RUnlock()

	required := ExtractRequiredTrigrams(re)
	var candidates []uint32
	
	if len(required) > 0 {
		first := true
		for _, tri := range required {
			hits := idx.postings[tri]
			if first {
				candidates = append([]uint32(nil), hits...)
				first = false
			} else {
				candidates = intersect(candidates, hits)
			}
		}
	} else {
		// Fallback: check all docs if no trigrams can be extracted
		for id := range idx.docs {
			candidates = append(candidates, id)
		}
	}

	var results []Document
	for _, id := range candidates {
		doc := idx.docs[id]
		if re.MatchString(doc.Content) || re.MatchString(doc.Path) {
			results = append(results, doc)
		}
	}
	return results, nil
}

func (idx *Index) fallbackSearch(query string) []Document {
	var results []Document
	for _, doc := range idx.docs {
		if strings.Contains(doc.Content, query) {
			results = append(results, doc)
		}
	}
	return results
}

// Helper: intersect two sorted slices
func intersect(a, b []uint32) []uint32 {
	var res []uint32
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		if a[i] == b[j] {
			if len(res) == 0 || res[len(res)-1] != a[i] {
				res = append(res, a[i])
			}
			i++
			j++
		} else if a[i] < b[j] {
			i++
		} else {
			j++
		}
	}
	return res
}
