// Package mcp mounts the Hanzo MCP tool surface under /v1/mcp per HIP-0106.
//
// Hanzo MCP exposes the HIP-0300 unified tool catalog (fs, exec, code, git,
// fetch, workspace, computer, think, memory, hanzo, plan, tasks, mode) over
// HTTP. The Go bridge to the native tool runtime is the CGO package
// github.com/hanzoai/mcp/go/hanzomcp — keeping the route layer pure-Go means
// the unified cloud binary builds without CGO. A CGO-enabled build can
// register an invoker via SetInvoker before app.Listen.
package mcp
