use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol revisions this server speaks, newest first.
///
/// Initialize is a NEGOTIATION: the client states the revision it wants and the
/// server answers with the one it will actually use. Answering with a fixed
/// string is not a negotiation, and a client that requires a newer revision has
/// no choice but to refuse the connection — which is what happened. `hanzo dev`
/// asks for 2025-06-18, got 2024-11-05 back, and reported the server as failed
/// to start. The tools were listed, the binary was on PATH, the server answered
/// a hand-written handshake perfectly, and no agent could use any of it.
///
/// The list is what this server can SERVE, not what exists. Across these three
/// revisions the shapes it implements — initialize, tools/list, tools/call — are
/// unchanged; the later ones add capabilities (elicitation, structured content,
/// resource links) that are optional and that this server does not advertise.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// The newest revision this server speaks, and what it answers a client whose
/// request it cannot honour.
pub const PROTOCOL_VERSION: &str = PROTOCOL_VERSIONS[0];

/// Resolve the revision to speak with a client that asked for `requested`.
///
/// Echo what was asked for when it is one of ours — that is the whole contract,
/// and it is what lets one server serve both an old client and a new one. A
/// client that asks for something we do not speak, or names nothing at all, is
/// answered with our newest: the spec's instruction, and it leaves the decision
/// to disconnect with the client rather than guessing on its behalf.
pub fn negotiate_version(requested: Option<&str>) -> &'static str {
    match requested {
        Some(want) => PROTOCOL_VERSIONS
            .iter()
            .find(|v| **v == want)
            .copied()
            .unwrap_or(PROTOCOL_VERSION),
        None => PROTOCOL_VERSION,
    }
}

/// MCP Request structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

/// MCP Response structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MCPError>,
}

/// MCP Error structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Initialize request params
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeParams {
    pub protocol_version: String,
    pub capabilities: ClientCapabilities,
    pub client_info: ClientInfo,
}

/// Client capabilities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling: Option<Value>,
}

/// Client information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

/// Server capabilities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Value>,
}

/// Tool definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// Tool call params
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallParams {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
}

/// Content types for responses
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { 
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    #[serde(rename = "resource")]
    Resource {
        uri: String,
        #[serde(rename = "mimeType")]
        mime_type: Option<String>,
        text: Option<String>,
    },
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoes_a_revision_we_speak() {
        // The regression: `hanzo dev` asks for 2025-06-18 and refuses the server
        // unless it hears 2025-06-18 back. Answering a fixed string made every
        // agent-facing use of this server fail while every hand-written probe of
        // it passed.
        for want in PROTOCOL_VERSIONS {
            assert_eq!(negotiate_version(Some(want)), *want);
        }
    }

    #[test]
    fn answers_our_newest_when_we_cannot_honour_the_request() {
        // Not an error: the spec has the server state what it WILL speak and
        // leaves the client to decide whether that is acceptable.
        assert_eq!(negotiate_version(Some("1999-01-01")), PROTOCOL_VERSION);
        assert_eq!(negotiate_version(None), PROTOCOL_VERSION);
        assert_eq!(PROTOCOL_VERSION, "2025-06-18");
    }

    #[test]
    fn the_oldest_revision_is_still_served() {
        // Clients pinned to the original revision must keep working — the point
        // of negotiating is serving both, not trading one break for another.
        assert_eq!(negotiate_version(Some("2024-11-05")), "2024-11-05");
    }
}
