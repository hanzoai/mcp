//! Cloud-backed web tools (HIP-0300).
//!
//! - `web_search` → GET  /v1/websearch/search (Bing meta-search)
//! - `web_read`   → POST /v1/crawl            (URL → clean markdown, Crawl4AI)
//!
//! The local `fetch` tool keeps direct HTTP (`request`/`fetch`/`download`) and a
//! DuckDuckGo fallback; these route through the platform for ranked results and
//! markdown extraction. Hybrid: local for a raw byte fetch, cloud for reading.

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

fn require_key(api: &HanzoApi, tool: &'static str, action: &'static str) -> Option<Result<ToolResult>> {
    if api.has_key() {
        None
    } else {
        Some(Ok(ToolResult::ok(envelope_err(
            tool,
            action,
            "NO_API_KEY",
            "no hk- key: set HANZO_API_KEY or ~/.hanzo/config.json .apiKey",
        ))))
    }
}

// ---------------------------------------------------------------------------
// web_search → GET /v1/websearch/search
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct WebSearchArgs {
    #[serde(alias = "q", alias = "query")]
    query: Option<String>,
}

pub struct WebSearchTool {
    api: HanzoApi,
}

impl WebSearchTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "web_search",
            "description": "Web search via api.hanzo.ai (Bing meta-search). Returns ranked {url,title,content} results.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" }
                },
                "required": ["query"]
            }
        })
    }
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "Web search via api.hanzo.ai (Bing meta-search)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "web_search", "search") {
            return r;
        }
        let args: WebSearchArgs = serde_json::from_value(params).unwrap_or_default();
        let query = match args.query.filter(|q| !q.trim().is_empty()) {
            Some(q) => q,
            None => return Ok(ToolResult::ok(envelope_err("web_search", "search", "INVALID_ARGS", "query required"))),
        };
        let q = [("q", query)];
        Ok(match self.api.get("/v1/websearch/search", &q).await {
            Ok(body) => ToolResult::ok(envelope_ok("web_search", "search", body)),
            Err(e) => ToolResult::ok(envelope_err("web_search", "search", "UPSTREAM", e.to_string())),
        })
    }
}

// ---------------------------------------------------------------------------
// web_read → POST /v1/crawl
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct WebReadArgs {
    url: Option<String>,
}

pub struct WebReadTool {
    api: HanzoApi,
}

impl WebReadTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "web_read",
            "description": "Read a URL as clean markdown via api.hanzo.ai (Crawl4AI).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "URL to read" }
                },
                "required": ["url"]
            }
        })
    }
}

impl Default for WebReadTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for WebReadTool {
    fn name(&self) -> &str {
        "web_read"
    }
    fn description(&self) -> &str {
        "Read a URL as clean markdown via api.hanzo.ai (Crawl4AI)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if let Some(r) = require_key(&self.api, "web_read", "read") {
            return r;
        }
        let args: WebReadArgs = serde_json::from_value(params).unwrap_or_default();
        let url = match args.url.filter(|u| !u.trim().is_empty()) {
            Some(u) => u,
            None => return Ok(ToolResult::ok(envelope_err("web_read", "read", "INVALID_ARGS", "url required"))),
        };
        let body = json!({ "url": url });
        Ok(match self.api.post("/v1/crawl", body).await {
            Ok(body) => ToolResult::ok(envelope_ok("web_read", "read", body)),
            Err(e) => ToolResult::ok(envelope_err("web_read", "read", "UPSTREAM", e.to_string())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_shape() {
        assert_eq!(WebSearchTool::schema()["name"], "web_search");
        assert_eq!(WebSearchTool::schema()["inputSchema"]["required"][0], "query");
        assert_eq!(WebReadTool::schema()["name"], "web_read");
        assert_eq!(WebReadTool::schema()["inputSchema"]["required"][0], "url");
    }

    #[test]
    fn names_are_stable() {
        assert_eq!(WebSearchTool::new().name(), "web_search");
        assert_eq!(WebReadTool::new().name(), "web_read");
    }

    #[test]
    fn websearch_accepts_q_alias() {
        let a: WebSearchArgs = serde_json::from_value(json!({ "q": "hello" })).unwrap();
        assert_eq!(a.query.as_deref(), Some("hello"));
    }

    /// Live end-to-end via the registry. Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_web_search_via_registry() {
        let registry = crate::ToolRegistry::with_defaults();
        let out = registry
            .execute("web_search", json!({ "q": "hanzo ai" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true, "web_search envelope: {}", out.content);
        let results = out.content["data"]["results"].as_array().cloned().unwrap_or_default();
        assert!(!results.is_empty(), "expected web results");
        println!("web_search returned {} results", results.len());
    }
}
