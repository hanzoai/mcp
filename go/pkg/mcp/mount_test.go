package mcp_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hanzoai/cloud/pkg/cloud"
	"github.com/hanzoai/mcp/go/pkg/mcp"
	"github.com/hanzoai/zip"
)

type stubInvoker struct {
	tools []byte
	last  string
}

func (s *stubInvoker) CallTool(_ context.Context, name string, params []byte) ([]byte, error) {
	s.last = name
	return []byte(`{"success":true,"content":{"tool":"` + name + `","params":` + string(params) + `}}`), nil
}

func (s *stubInvoker) ListTools(context.Context) ([]byte, error) {
	return s.tools, nil
}

func newTestApp(t *testing.T) (*zip.App, *stubInvoker) {
	t.Helper()
	app := zip.New(zip.Config{DisableStartupMessage: true})
	if err := mcp.Mount(app, cloud.Deps{}); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	inv := &stubInvoker{tools: []byte(`{"tools":[{"name":"fs","description":"","inputSchema":""}]}`)}
	mcp.SetInvoker(inv)
	return app, inv
}

func roundTrip(t *testing.T, app *zip.App, method, target string, body string) (*http.Response, []byte) {
	t.Helper()
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, bodyReader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
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

func TestMountHealthWithInvoker(t *testing.T) {
	app, _ := newTestApp(t)
	defer mcp.SetInvoker(nil)
	resp, body := roundTrip(t, app, http.MethodGet, "/v1/mcp/health", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

func TestMountHealthNoInvoker(t *testing.T) {
	app := zip.New(zip.Config{DisableStartupMessage: true})
	if err := mcp.Mount(app, cloud.Deps{}); err != nil {
		t.Fatalf("Mount: %v", err)
	}
	mcp.SetInvoker(nil)
	resp, _ := roundTrip(t, app, http.MethodGet, "/v1/mcp/health", "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", resp.StatusCode)
	}
}

func TestMountListTools(t *testing.T) {
	app, _ := newTestApp(t)
	defer mcp.SetInvoker(nil)
	resp, body := roundTrip(t, app, http.MethodGet, "/v1/mcp/tools", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
}

func TestMountCallTool(t *testing.T) {
	app, inv := newTestApp(t)
	defer mcp.SetInvoker(nil)
	resp, body := roundTrip(t, app, http.MethodPost, "/v1/mcp/tools/think", `{"action":"think","thought":"hi"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if inv.last != "think" {
		t.Fatalf("invoker.last=%q want think", inv.last)
	}
}

func TestMountSearchShortcut(t *testing.T) {
	app, inv := newTestApp(t)
	defer mcp.SetInvoker(nil)
	resp, body := roundTrip(t, app, http.MethodPost, "/v1/mcp/search", `{"query":"hello"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if inv.last != "fs" {
		t.Fatalf("expected fs invocation, got %q", inv.last)
	}
}
