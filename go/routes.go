package mcp

import (
	"net/http"

	"github.com/hanzoai/cloud"
	"github.com/hanzoai/zip"
	luxlog "github.com/luxfi/log"
)

// Mount registers Hanzo MCP's HTTP surface per HIP-0106.
//
// Routes (all under /v1/mcp):
//
//	GET  /v1/mcp/tools              — list tool definitions
//	POST /v1/mcp/tools/:name        — invoke tool {name} with JSON body as params
//	POST /v1/mcp/search             — search shortcut (delegates to the fs tool)
//	POST /v1/mcp/fetch              — fetch shortcut (delegates to the fetch tool)
//	GET  /v1/mcp/health             — runtime liveness
//
// Identity comes from gateway-minted X-Org-Id / X-User-Id headers per
// HIP-0026. The MCP runtime is single-process today (see hanzomcp), so
// per-org scoping happens at the tool-action level (e.g. fs root, exec
// cwd) rather than the route layer.
func Mount(app *zip.App, deps cloud.Deps) error {
	log := deps.Logger
	if log == nil {
		log = luxlog.New("module", "mcp")
	}
	log.Info("mcp: mounting routes", "prefix", "/v1/mcp")

	g := app.Group("/v1/mcp")

	g.Get("/health", handleHealth)
	g.Get("/tools", handleListTools)
	g.Post("/tools/:name", handleCallTool)
	g.Post("/search", handleSearch)
	g.Post("/fetch", handleFetch)

	return nil
}

func init() {
	cloud.Register("mcp", 160, func(app any, deps cloud.Deps) error {
		return Mount(app.(*zip.App), deps)
	})
}

// handleHealth returns 200 when an invoker is registered, 503 otherwise.
func handleHealth(c *zip.Ctx) error {
	inv := get()
	if _, err := inv.ListTools(c.Context()); err != nil {
		c.SetHeader("X-MCP-Backend", "none")
		return c.JSON(http.StatusServiceUnavailable, map[string]any{
			"status": "no-runtime",
			"error":  err.Error(),
		})
	}
	c.SetHeader("X-MCP-Backend", "ready")
	return c.JSON(http.StatusOK, map[string]any{"status": "ok"})
}

// handleListTools returns the registered tool catalog.
func handleListTools(c *zip.Ctx) error {
	raw, err := get().ListTools(c.Context())
	if err != nil {
		return c.Bytes(http.StatusServiceUnavailable, encodeError(err.Error()))
	}
	c.SetHeader("Content-Type", "application/json")
	return c.Bytes(http.StatusOK, raw)
}

// handleCallTool dispatches a tool by name. The request body is forwarded
// verbatim as the params JSON. Per x402, an X-Payment request header is
// plumbed into the tool params under the "payment" key, and a tool result
// envelope of the shape {"status":402,"payment_required":{...}} is mapped
// to a real HTTP 402 with WWW-Authenticate: x402 so downstream agents see
// a Payment-Required response rather than an opaque 200.
func handleCallTool(c *zip.Ctx) error {
	name := c.Param("name")
	if name == "" {
		return zip.ErrBadRequest("missing tool name")
	}
	body := c.Body()
	if len(body) == 0 {
		body = []byte("{}")
	}
	body = injectPayment(body, c.Header("X-Payment"))
	raw, err := get().CallTool(c.Context(), name, body)
	if err != nil {
		return c.Bytes(http.StatusServiceUnavailable, encodeError(err.Error()))
	}
	c.SetHeader("Content-Type", "application/json")
	if paymentRequiredFromEnvelope(raw) {
		c.SetHeader("WWW-Authenticate", "x402")
		return c.Bytes(http.StatusPaymentRequired, raw)
	}
	return c.Bytes(http.StatusOK, raw)
}

// handleSearch is the standard MCP search shortcut. It delegates to the
// fs tool's search_text action.
func handleSearch(c *zip.Ctx) error {
	// Inject action=search_text into the body. We keep this dumb — the
	// caller is expected to send a body the fs tool understands; we only
	// fill in the action when omitted.
	raw, err := get().CallTool(c.Context(), "fs", overrideAction(c.Body(), "search_text"))
	if err != nil {
		return c.Bytes(http.StatusServiceUnavailable, encodeError(err.Error()))
	}
	c.SetHeader("Content-Type", "application/json")
	return c.Bytes(http.StatusOK, raw)
}

// handleFetch is the standard MCP fetch shortcut. It delegates to the
// fetch tool's get action and applies the same x402 propagation as
// handleCallTool: X-Payment is plumbed into the tool params, and a
// payment_required envelope from the fetch tool is mapped to HTTP 402.
func handleFetch(c *zip.Ctx) error {
	body := injectPayment(overrideAction(c.Body(), "get"), c.Header("X-Payment"))
	raw, err := get().CallTool(c.Context(), "fetch", body)
	if err != nil {
		return c.Bytes(http.StatusServiceUnavailable, encodeError(err.Error()))
	}
	c.SetHeader("Content-Type", "application/json")
	if paymentRequiredFromEnvelope(raw) {
		c.SetHeader("WWW-Authenticate", "x402")
		return c.Bytes(http.StatusPaymentRequired, raw)
	}
	return c.Bytes(http.StatusOK, raw)
}
