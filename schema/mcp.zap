# Hanzo MCP — ZAP Schema (HIP-0106 / HIP-0300)
#
# Server: hanzoai/mcp mounted at /v1/mcp inside the unified cloud binary.
#
# Code generation:
#   zapc generate mcp.zap --lang go --out ./go/pkg/mcp/zap/
#   zapc generate mcp.zap --lang ts --out ./src/zap/
#   zapc generate mcp.zap --lang py --out ./py/zap/
#   zapc generate mcp.zap --lang rust --out ./rust/src/zap/

# ── Tool catalog ─────────────────────────────────────────────────────────

struct ToolDef
  name        Text
  description Text
  inputSchema Text   # JSON schema, serialized as Text to avoid recursion

struct ToolList
  tools List(ToolDef)

# ── Invocation ──────────────────────────────────────────────────────────

struct CallRequest
  name   Text
  params Text   # caller-supplied JSON params for the tool action

struct CallResult
  success bool
  content Text   # tool-specific JSON content
  error   Text   # populated when success=false

# ── Health ──────────────────────────────────────────────────────────────

struct Health
  status   Text   # "ok" | "no-runtime"
  backend  Text   # "ready" | "none"

# ── Service interface ───────────────────────────────────────────────────

interface MCP
  # List tool definitions registered with the runtime.
  list () -> (list ToolList)

  # Invoke a tool by name with caller-supplied JSON params.
  call (request CallRequest) -> (result CallResult)

  # Health probe; reports whether the runtime is wired.
  health () -> (status Health)
