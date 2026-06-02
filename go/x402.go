package mcp

import "encoding/json"

// injectPayment merges the X-Payment header value into the JSON params body
// under the "payment" key so the unified fetch tool can replay the payment
// per x402. If the body is empty or not a JSON object, returns a minimal
// {"payment": v} payload. If the caller already supplied a payment field
// (e.g. a structured payment object), it is preserved unchanged. Returns
// body verbatim when v is empty.
func injectPayment(body []byte, v string) []byte {
	if v == "" {
		return body
	}
	var m map[string]any
	if len(body) == 0 || json.Unmarshal(body, &m) != nil {
		out, _ := json.Marshal(map[string]any{"payment": v})
		return out
	}
	if _, exists := m["payment"]; exists {
		out, _ := json.Marshal(m)
		return out
	}
	m["payment"] = v
	out, _ := json.Marshal(m)
	return out
}

// paymentRequiredFromEnvelope returns true iff raw is a JSON object emitted
// by the unified fetch tool to surface an x402 402 Payment Required
// response, of the shape:
//
//	{ "status": 402, "payment_required": { ... } }
//
// The HTTP layer maps this to a real 402 on the wire (with
// WWW-Authenticate: x402) so downstream agents see a Payment-Required
// response instead of an opaque 200 carrying an in-band marker.
func paymentRequiredFromEnvelope(raw []byte) bool {
	var env struct {
		Status          int             `json:"status"`
		PaymentRequired json.RawMessage `json:"payment_required"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return false
	}
	return env.Status == 402 && len(env.PaymentRequired) > 0
}
