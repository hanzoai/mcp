//! Cloud-backed web tools (HIP-0300).
//!
//! - `web_search` → GET  /v1/websearch/search (Bing meta-search)
//! - `web_read`   → POST /v1/crawl            (URL → clean markdown, Crawl4AI)
//! - `research`   → POST /v1/ask              (streamed, source-cited report)
//!
//! The local `fetch` tool keeps direct HTTP (`request`/`fetch`/`download`) and a
//! DuckDuckGo fallback; these route through the platform for ranked results and
//! markdown extraction. Hybrid: local for a raw byte fetch, cloud for reading.
//!
//! All three are the ONE web capability, at three depths — a snippet, a page, a
//! report — so `ToolsConfig::web_search` governs the whole of it. Research is
//! not a second capability to toggle: it is search + read + synthesis run
//! server-side, where the loop is bounded and billed.

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
            crate::hanzo_api::NO_KEY,
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

// ---------------------------------------------------------------------------
// research → POST /v1/ask (mode=research)
// ---------------------------------------------------------------------------

/// The live mode name. `deep` is its retired name and resolves to this, exactly
/// as the server resolves it (cloud `apps/answer/mode.go`).
const RESEARCH: &str = "research";

#[derive(Debug, Default, Deserialize)]
struct ResearchArgs {
    action: Option<String>,
    #[serde(alias = "q")]
    query: Option<String>,
    mode: Option<String>,
    id: Option<String>,
    #[serde(alias = "run_id")]
    run_id: Option<String>,
    benchmark: Option<String>,
    system: Option<String>,
    completion: Option<String>,
    project: Option<String>,
    sha256: Option<String>,
    content_b64: Option<String>,
    kind: Option<String>,
    body: Option<Value>,
}

/// Resolve the requested mode to the one this door opens. Absent, `research` and
/// the retired `deep` all mean research; any other mode (`search`, `news`) is a
/// different depth with a different price, so it is refused rather than silently
/// answered here — `web_search` is that door.
fn mode(requested: Option<&str>) -> Result<&'static str, String> {
    match requested.map(str::trim).unwrap_or("").to_lowercase().as_str() {
        "" | "research" | "deep" => Ok(RESEARCH),
        other => Err(format!("unknown mode {other:?}: research accepts \"research\" (or its retired name \"deep\")")),
    }
}

/// Project one streamed source down to what a citation needs.
fn source(v: &Value) -> Value {
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    json!({ "url": field("url"), "title": field("title"), "favicon": field("favicon") })
}

/// Fold the answer-engine stream into the one result a tool call returns.
///
/// The terminal `done` frame is authoritative — it carries the checked answer and
/// the sources it actually cites. The `text` deltas rebuild the same answer when
/// a stream ends without reaching `done`, so a truncated report is still an
/// answer rather than nothing; `status` frames are progress and retain nothing.
fn fold(events: &[Value]) -> Result<Value, String> {
    let kind = |e: &Value| e.get("type").and_then(Value::as_str).unwrap_or("").to_string();

    if let Some(e) = events.iter().find(|e| kind(e) == "error") {
        return Err(e.get("error").and_then(Value::as_str).unwrap_or("answer failed").to_string());
    }

    let mut answer = String::new();
    let mut sources: Vec<Value> = Vec::new();
    let mut questions: Vec<Value> = Vec::new();
    let mut done = false;

    for e in events {
        match kind(e).as_str() {
            "text" => answer.push_str(e.get("delta").and_then(Value::as_str).unwrap_or("")),
            "sources" => {
                if let Some(list) = e.get("sources").and_then(Value::as_array) {
                    sources = list.iter().map(source).collect();
                }
            }
            "follow_ups" => {
                if let Some(list) = e.get("questions").and_then(Value::as_array) {
                    questions = list.clone();
                }
            }
            "done" => {
                done = true;
                if let Some(text) = e.get("answer").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    answer = text.to_string();
                }
                if let Some(list) = e.get("sources").and_then(Value::as_array).filter(|l| !l.is_empty()) {
                    sources = list.iter().map(source).collect();
                }
            }
            _ => {}
        }
    }

    if answer.is_empty() {
        return Err("stream ended without an answer".into());
    }
    Ok(json!({
        "mode": RESEARCH,
        "answer": answer,
        "sources": sources,
        "follow_ups": questions,
        "complete": done,
    }))
}

pub struct ResearchTool {
    api: HanzoApi,
}

impl ResearchTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "research",
            "description": "Hanzo Science & Research tool (/v1/research evidence plane + /v1/ask deep cited synthesis): studies, runs, start, status, ledger, artifacts, and search.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["studies", "runs", "start", "status", "ledger", "artifacts", "search"],
                        "default": "search",
                        "description": "Research action: studies | runs | start | status | ledger | artifacts | search"
                    },
                    "query": { "type": "string", "description": "Question to research (action=search; alias: q)" },
                    "mode": {
                        "type": "string",
                        "enum": ["research", "deep"],
                        "default": "research",
                        "description": "Answer mode for action=search (research or retired deep)"
                    },
                    "id": { "type": "string", "description": "Study, experiment, or run ID (status, runs, studies)" },
                    "benchmark": { "type": "string", "description": "Filter runs/ledger by benchmark ID" },
                    "system": { "type": "string", "description": "Filter runs by system under test" },
                    "completion": { "type": "string", "enum": ["complete", "partial", "inconsistent", "unknown"] },
                    "project": { "type": "string", "description": "Project sub-scope" },
                    "sha256": { "type": "string", "description": "Content-addressed artifact SHA-256 (artifacts)" },
                    "content_b64": { "type": "string", "description": "Base64-encoded artifact bytes to upload (artifacts)" },
                    "kind": { "type": "string", "description": "Target kind for start/artifacts (study, experiment, run, snapshot, report)" },
                    "body": { "type": "object", "description": "Payload for start or ledger write" }
                }
            }
        })
    }
}

impl Default for ResearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for ResearchTool {
    fn name(&self) -> &str {
        "research"
    }
    fn description(&self) -> &str {
        "Hanzo Science & Research (/v1/research studies, runs, ledger, artifacts + /v1/ask deep cited search)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: ResearchArgs = serde_json::from_value(params.clone()).unwrap_or_default();
        let action = args
            .action
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("search")
            .to_lowercase();

        if !self.api.has_key() {
            return Ok(ToolResult::ok(envelope_err(
                "research",
                &action,
                "NO_API_KEY",
                crate::hanzo_api::NO_KEY,
            )));
        }

        let mut qparams: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &args.id { qparams.push(("id", v.clone())); }
        if let Some(v) = &args.benchmark { qparams.push(("benchmark", v.clone())); }
        if let Some(v) = &args.system { qparams.push(("system", v.clone())); }
        if let Some(v) = &args.completion { qparams.push(("completion", v.clone())); }
        if let Some(v) = &args.project { qparams.push(("project", v.clone())); }

        match action.as_str() {
            "studies" => Ok(match self.api.get("/v1/research/studies", &qparams).await {
                Ok(b) => ToolResult::ok(envelope_ok("research", "studies", b)),
                Err(e) => ToolResult::ok(envelope_err("research", "studies", "UPSTREAM", e.to_string())),
            }),

            "runs" => Ok(match self.api.get("/v1/research/runs", &qparams).await {
                Ok(b) => ToolResult::ok(envelope_ok("research", "runs", b)),
                Err(e) => ToolResult::ok(envelope_err("research", "runs", "UPSTREAM", e.to_string())),
            }),

            "status" => {
                let target_id = args.id.or(args.run_id);
                let Some(id) = target_id.filter(|s| !s.trim().is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("research", "status", "INVALID_ARGS", "id required")));
                };
                let mut q = vec![("id", id)];
                if let Some(p) = args.project { q.push(("project", p)); }
                Ok(match self.api.get("/v1/research/runs", &q).await {
                    Ok(b) => ToolResult::ok(envelope_ok("research", "status", b)),
                    Err(e) => ToolResult::ok(envelope_err("research", "status", "UPSTREAM", e.to_string())),
                })
            }

            "start" => {
                let endpoint = match args.kind.as_deref().unwrap_or("run") {
                    "study" => "/v1/research/studies",
                    "experiment" => "/v1/research/experiments",
                    _ => "/v1/research/runs",
                };
                let payload = args.body.unwrap_or_else(|| params.clone());
                Ok(match self.api.post(endpoint, payload).await {
                    Ok(b) => ToolResult::ok(envelope_ok("research", "start", b)),
                    Err(e) => ToolResult::ok(envelope_err("research", "start", "UPSTREAM", e.to_string())),
                })
            }

            "ledger" => {
                if let Some(payload) = args.body {
                    Ok(match self.api.post("/v1/research/evidence", payload).await {
                        Ok(b) => ToolResult::ok(envelope_ok("research", "ledger", b)),
                        Err(e) => ToolResult::ok(envelope_err("research", "ledger", "UPSTREAM", e.to_string())),
                    })
                } else {
                    Ok(match self.api.get("/v1/research/evidence", &qparams).await {
                        Ok(b) => ToolResult::ok(envelope_ok("research", "ledger", b)),
                        Err(e) => ToolResult::ok(envelope_err("research", "ledger", "UPSTREAM", e.to_string())),
                    })
                }
            }

            "artifacts" => {
                if let Some(b64) = args.content_b64.filter(|s| !s.is_empty()) {
                    let payload = json!({
                        "content": b64,
                        "kind": args.kind.unwrap_or_else(|| "report".into()),
                        "run_id": args.run_id.or(args.id).unwrap_or_else(|| "standalone".into()),
                    });
                    Ok(match self.api.post("/v1/research/artifacts", payload).await {
                        Ok(b) => ToolResult::ok(envelope_ok("research", "artifacts", b)),
                        Err(e) => ToolResult::ok(envelope_err("research", "artifacts", "UPSTREAM", e.to_string())),
                    })
                } else if let Some(sha) = args.sha256.filter(|s| !s.is_empty()) {
                    let path = format!("/v1/research/artifacts/{sha}");
                    Ok(match self.api.get(&path, &[]).await {
                        Ok(b) => ToolResult::ok(envelope_ok("research", "artifacts", b)),
                        Err(e) => ToolResult::ok(envelope_err("research", "artifacts", "UPSTREAM", e.to_string())),
                    })
                } else {
                    Ok(match self.api.get("/v1/research/artifacts", &qparams).await {
                        Ok(b) => ToolResult::ok(envelope_ok("research", "artifacts", b)),
                        Err(e) => ToolResult::ok(envelope_err("research", "artifacts", "UPSTREAM", e.to_string())),
                    })
                }
            }

            "search" => {
                let query = match args.query.filter(|q| !q.trim().is_empty()) {
                    Some(q) => q,
                    None => return Ok(ToolResult::ok(envelope_err("research", RESEARCH, "INVALID_ARGS", "query required"))),
                };
                let mode = match mode(args.mode.as_deref()) {
                    Ok(m) => m,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("research", RESEARCH, "INVALID_ARGS", e))),
                };
                let body = json!({ "q": query, "mode": mode });
                Ok(match self.api.events("/v1/ask", body).await {
                    Ok(events) => match fold(&events) {
                        Ok(mut data) => {
                            data["query"] = json!(query);
                            ToolResult::ok(envelope_ok("research", RESEARCH, data))
                        }
                        Err(e) => ToolResult::ok(envelope_err("research", RESEARCH, "UPSTREAM", e)),
                    },
                    Err(e) => ToolResult::ok(envelope_err("research", RESEARCH, "UPSTREAM", e.to_string())),
                })
            }

            _ => Ok(ToolResult::ok(envelope_err(
                "research",
                &action,
                "INVALID_ARGS",
                "action must be one of: studies, runs, start, status, ledger, artifacts, search",
            ))),
        }
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
        assert_eq!(ResearchTool::schema()["name"], "research");
        assert_eq!(ResearchTool::schema()["inputSchema"]["properties"]["mode"]["default"], "research");
        assert_eq!(ResearchTool::schema()["inputSchema"]["properties"]["action"]["default"], "search");
    }

    #[test]
    fn names_are_stable() {
        assert_eq!(WebSearchTool::new().name(), "web_search");
        assert_eq!(WebReadTool::new().name(), "web_read");
        assert_eq!(ResearchTool::new().name(), "research");
    }

    #[test]
    fn websearch_accepts_q_alias() {
        let a: WebSearchArgs = serde_json::from_value(json!({ "q": "hello" })).unwrap();
        assert_eq!(a.query.as_deref(), Some("hello"));
    }

    #[test]
    fn research_accepts_q_alias_and_its_retired_mode_name() {
        let a: ResearchArgs = serde_json::from_value(json!({ "q": "hello", "mode": "DEEP " })).unwrap();
        assert_eq!(a.query.as_deref(), Some("hello"));
        assert_eq!(mode(a.mode.as_deref()).unwrap(), "research");
        assert_eq!(mode(None).unwrap(), "research");
        assert!(mode(Some("search")).is_err(), "a fast answer is web_search's door, not this one");
    }

    /// The exact stream the server writes for one answer (cloud `apps/answer`),
    /// terminated by the `[DONE]` sentinel that is NOT an event.
    fn answer_stream() -> String {
        let src = json!({
            "url": "https://a.com/x", "title": "A", "snippet": "alpha",
            "engine": "bing", "favicon": "https://f/a"
        });
        [
            json!({ "type": "status", "stage": "planning", "detail": "3 topics" }),
            json!({ "type": "sources", "sources": [src] }),
            json!({ "type": "status", "stage": "answering" }),
            json!({ "type": "text", "delta": "Grounded " }),
            json!({ "type": "text", "delta": "answer" }),
            json!({ "type": "follow_ups", "questions": ["More?", "Why?"] }),
            json!({ "type": "done", "answer": "Grounded answer", "sources": [src] }),
        ]
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect::<String>()
            + "data: [DONE]\n\n"
    }

    #[test]
    fn folds_the_ask_stream_into_a_cited_answer() {
        let data = fold(&crate::hanzo_api::frames(&answer_stream())).unwrap();
        assert_eq!(data["answer"], "Grounded answer");
        assert_eq!(data["mode"], "research");
        assert_eq!(data["complete"], true);
        assert_eq!(data["follow_ups"], json!(["More?", "Why?"]));
        // A source is exactly what a citation needs — url, title, favicon.
        assert_eq!(
            data["sources"],
            json!([{ "url": "https://a.com/x", "title": "A", "favicon": "https://f/a" }])
        );
    }

    #[test]
    fn a_truncated_stream_still_answers_from_its_deltas() {
        let body = "data: {\"type\":\"text\",\"delta\":\"half an \"}\n\n\
                    data: {\"type\":\"text\",\"delta\":\"answer\"}\n\n";
        let data = fold(&crate::hanzo_api::frames(body)).unwrap();
        assert_eq!(data["answer"], "half an answer");
        assert_eq!(data["complete"], false);
    }

    #[test]
    fn an_error_frame_and_an_empty_stream_are_failures() {
        let body = "data: {\"type\":\"error\",\"error\":\"401 sign in\"}\n\ndata: [DONE]\n\n";
        assert_eq!(fold(&crate::hanzo_api::frames(body)).unwrap_err(), "401 sign in");
        assert!(fold(&[]).is_err(), "no frames is no answer");
    }

    /// Live end-to-end via the registry. Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_research_via_registry() {
        let registry = crate::ToolRegistry::with_defaults();
        let out = registry
            .execute("research", json!({ "q": "what is the hanzo answer engine" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true, "research envelope: {}", out.content);
        let answer = out.content["data"]["answer"].as_str().unwrap_or_default();
        assert!(!answer.is_empty(), "expected a report");
        println!(
            "research: {} chars over {} sources",
            answer.len(),
            out.content["data"]["sources"].as_array().map_or(0, Vec::len)
        );
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
