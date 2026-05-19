package mcp

import "encoding/json"

// overrideAction rewrites the JSON object body so its "action" key is set
// to the given value. If the body is empty or not a JSON object, returns
// a minimal {"action": v} payload.
func overrideAction(body []byte, v string) []byte {
	var m map[string]any
	if len(body) == 0 || json.Unmarshal(body, &m) != nil {
		out, _ := json.Marshal(map[string]any{"action": v})
		return out
	}
	m["action"] = v
	out, _ := json.Marshal(m)
	return out
}
