package mcp_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hanzoai/cloud"
	"github.com/hanzoai/mcp/go"
	"github.com/zap-proto/zip"
)

// echoInvoker captures the params passed to CallTool and returns a configurable
// JSON envelope so tests can assert both directions of the x402 plumbing.
type echoInvoker struct {
	last     string
	lastBody []byte
	reply    []byte
}

func (e *echoInvoker) CallTool(_ context.Context, name string, params []byte) ([]byte, error) {
	e.last = name
	e.lastBody = append(e.lastBody[:0], params...)
	if len(e.reply) > 0 {
		return e.reply, nil
	}
	return []byte(`{"success":true,"echo":` + string(params) + `}`), nil
}

func (e *echoInvoker) ListTools(context.Context) ([]byte, error) {
	return []byte(`{"tools":[]}`), nil
}

func newEchoApp(t *testing.T, reply []byte) (*zip.App, *echoInvoker) {
	t.Helper()
	app := zip.New(zip.Config{DisableStartupMessage: true})
	if err := mcp.Mount(app, cloud.Deps{}); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	inv := &echoInvoker{reply: reply}
	mcp.SetInvoker(inv)
	t.Cleanup(func() { mcp.SetInvoker(nil) })
	return app, inv
}

func sendWithHeader(t *testing.T, app *zip.App, target, body string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var br io.Reader
	if body != "" {
		br = strings.NewReader(body)
	}
	req := httptest.NewRequest(http.MethodPost, target, br)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := app.Fiber().Test(req)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, out
}

// --- helpers --------------------------------------------------------------

func TestCallTool_XPaymentHeaderPlumbedIntoToolParams(t *testing.T) {
	app, inv := newEchoApp(t, nil)
	const xpay = "eyJ4NDAyVmVyc2lvbiI6IjEifQ=="
	_, _ = sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{"action":"request","url":"https://api.example.com/paid"}`, map[string]string{
		"X-Payment": xpay,
	})
	var got map[string]any
	if err := json.Unmarshal(inv.lastBody, &got); err != nil {
		t.Fatalf("invoker received non-JSON params: %v (raw=%s)", err, inv.lastBody)
	}
	if got["payment"] != xpay {
		t.Fatalf("payment field not plumbed: got=%v want=%q (params=%s)", got["payment"], xpay, inv.lastBody)
	}
	if got["url"] != "https://api.example.com/paid" {
		t.Fatalf("original params not preserved: %v", got)
	}
}

func TestCallTool_XPaymentMissing_NoOp(t *testing.T) {
	app, inv := newEchoApp(t, nil)
	_, _ = sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{"action":"request","url":"https://x"}`, nil)
	var got map[string]any
	_ = json.Unmarshal(inv.lastBody, &got)
	if _, ok := got["payment"]; ok {
		t.Fatalf("payment field unexpectedly present: %v", got)
	}
}

func TestCallTool_XPaymentDoesNotOverwriteExisting(t *testing.T) {
	app, inv := newEchoApp(t, nil)
	_, _ = sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{"action":"request","payment":{"presigned":true}}`, map[string]string{
		"X-Payment": "header-value",
	})
	var got map[string]any
	_ = json.Unmarshal(inv.lastBody, &got)
	pay, ok := got["payment"].(map[string]any)
	if !ok {
		t.Fatalf("caller payment object was overwritten: got=%T %v", got["payment"], got["payment"])
	}
	if pay["presigned"] != true {
		t.Fatalf("caller payment object corrupted: %v", pay)
	}
}

func TestCallTool_PaymentRequiredEnvelopeMappedTo402(t *testing.T) {
	envelope := []byte(`{"status":402,"payment_required":{"x402_version":"1","accepts":[{"scheme":"exact","network":"base-sepolia","asset":"0xA","payTo":"0xB","maxAmountRequired":"1000"}],"www_authenticate":"x402"},"headers":{"www-authenticate":"x402"}}`)
	app, _ := newEchoApp(t, envelope)
	resp, body := sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{"action":"request","url":"https://api.example.com/paid"}`, nil)
	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("status=%d want=402 body=%s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("WWW-Authenticate"); got != "x402" {
		t.Fatalf("WWW-Authenticate=%q want=x402", got)
	}
	if !strings.Contains(string(body), "payment_required") {
		t.Fatalf("body did not propagate envelope: %s", body)
	}
}

func TestCallTool_RegularEnvelopeStays200(t *testing.T) {
	// Tool result with status not equal to 402 must remain 200.
	app, _ := newEchoApp(t, []byte(`{"status":200,"data":"ok"}`))
	resp, _ := sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{"action":"request","url":"https://x"}`, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want=200", resp.StatusCode)
	}
	if got := resp.Header.Get("WWW-Authenticate"); got != "" {
		t.Fatalf("unexpected WWW-Authenticate=%q on 200 path", got)
	}
}

func TestCallTool_StatusFieldAloneIsNotEnough(t *testing.T) {
	// Some tool envelopes incidentally carry a status field; the 402 mapping
	// must additionally require the payment_required object so we do not
	// accidentally hijack 402-typed application data without an x402 payload.
	app, _ := newEchoApp(t, []byte(`{"status":402}`))
	resp, _ := sendWithHeader(t, app, "/v1/mcp/tools/fetch", `{}`, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want=200 (no payment_required key)", resp.StatusCode)
	}
}

func TestFetchShortcut_XPaymentPlumbedAndPropagated(t *testing.T) {
	envelope := []byte(`{"status":402,"payment_required":{"x402_version":"1","accepts":[]}}`)
	app, inv := newEchoApp(t, envelope)
	const xpay = "presigned-base64-blob"
	resp, _ := sendWithHeader(t, app, "/v1/mcp/fetch", `{"url":"https://api.example.com/paid"}`, map[string]string{
		"X-Payment": xpay,
	})
	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("status=%d want=402", resp.StatusCode)
	}
	if resp.Header.Get("WWW-Authenticate") != "x402" {
		t.Fatalf("missing WWW-Authenticate header")
	}
	// Confirm the shortcut also (a) injected action=get and (b) plumbed X-Payment.
	var got map[string]any
	if err := json.Unmarshal(inv.lastBody, &got); err != nil {
		t.Fatalf("fetch shortcut sent non-JSON to invoker: %v", err)
	}
	if got["action"] != "get" {
		t.Fatalf("action=%v want=get", got["action"])
	}
	if got["payment"] != xpay {
		t.Fatalf("X-Payment not plumbed through fetch shortcut: %v", got)
	}
	if got["url"] != "https://api.example.com/paid" {
		t.Fatalf("url not preserved: %v", got)
	}
}
