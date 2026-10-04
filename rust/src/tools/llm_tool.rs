//! Unified LLM tool (HIP-0300).
//!
//! `llm` — query language models through the live api.hanzo.ai gateway
//! (POST /v1/chat/completions, OpenAI-compatible). The gateway routes by model
//! id, so a single bearer key reaches every provider SKU it fronts.
//!
//! Actions:
//! - `query`     → one model, returns the assistant text (default action);
//!                 Enso routes it when the model is `auto` or an `enso-*` id, and
//!                 `max_cost` / `max_latency_ms` ride as its routing headers
//! - `consensus` → many models in parallel, a judge model synthesizes them
//! - `list`      → the built-in default model set (no network)
//! - `models`    → GET /v1/models: each model's family, class and price
//! - `feedback`  → POST /v1/ai/feedback: how a routed answer went
//!
//! The chat / embed / consensus helpers are `pub` so the `think` tool composes
//! its consensus/agent/embed actions over the same seam — one way to reach the
//! LLM, no duplicate HTTP.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

/// Default single-query model: Enso's managed default, the id Hanzo Dev sends
/// when no model is named.
pub const DEFAULT_MODEL: &str = "enso-auto";
/// The signals `/v1/ai/feedback` takes.
pub const SIGNALS: &[&str] = &["up", "accept", "regenerate", "down", "switch", "abandon", "revert", "rating", "dismiss"];
/// Default aggregator/judge for consensus synthesis.
pub const DEFAULT_JUDGE_MODEL: &str = "gpt-4o";
/// Default embedding model.
pub const DEFAULT_EMBED_MODEL: &str = "text-embedding-3-small";
/// Default models consulted for consensus, in order of preference.
pub const DEFAULT_MODELS: &[&str] = &[
    "gpt-4o-mini",
    "claude-3-5-sonnet-20241022",
    "gemini/gemini-1.5-pro",
];
/// Default sampling temperature.
pub const DEFAULT_TEMPERATURE: f64 = 0.7;

// ---------------------------------------------------------------------------
// Shared seam — reused by the `think` tool's consensus/agent/embed actions.
// ---------------------------------------------------------------------------

/// Build an OpenAI-style `messages` array from an optional system prompt + user prompt.
pub fn build_messages(system: Option<&str>, prompt: &str) -> Value {
    let mut messages = Vec::new();
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    Value::Array(messages)
}

/// Extract the assistant text from a `/v1/chat/completions` response. Reasoning
/// SKUs may place text in `reasoning_content` when `content` is null.
pub fn extract_content(resp: &Value) -> Option<String> {
    let message = &resp["choices"][0]["message"];
    if let Some(text) = message["content"].as_str() {
        return Some(text.to_string());
    }
    message["reasoning_content"].as_str().map(str::to_string)
}

/// One chat completion → assistant text. POST /v1/chat/completions.
pub async fn chat(
    api: &HanzoApi,
    model: &str,
    messages: Value,
    temperature: f64,
    max_tokens: Option<u32>,
) -> Result<String> {
    let mut body = json!({ "model": model, "messages": messages, "temperature": temperature });
    if let Some(mt) = max_tokens {
        body["max_tokens"] = json!(mt);
    }
    let resp = api.post("/v1/chat/completions", body).await?;
    extract_content(&resp).ok_or_else(|| anyhow!("no completion content: {}", resp))
}

/// One embedding request. POST /v1/embeddings.
pub async fn embed(api: &HanzoApi, model: &str, input: &str) -> Result<Value> {
    api.post("/v1/embeddings", json!({ "model": model, "input": input })).await
}

/// Run consensus: query `models` in parallel, synthesize with `judge`.
/// Returns a data object `{synthesis, judge, models, succeeded, failed, ...}`.
pub async fn run_consensus(
    api: &HanzoApi,
    prompt: &str,
    system: Option<&str>,
    models: &[String],
    judge: &str,
    temperature: f64,
    max_tokens: Option<u32>,
    include_raw: bool,
) -> Result<Value> {
    if models.len() < 2 {
        return Err(anyhow!("consensus requires at least 2 models"));
    }

    // HanzoApi is cheap to clone (an Arc-backed reqwest client); each model runs
    // on its own task for real parallelism without a futures dependency.
    let mut handles = Vec::with_capacity(models.len());
    for model in models {
        let api = api.clone();
        let model = model.clone();
        let messages = build_messages(system, prompt);
        handles.push(tokio::spawn(async move {
            let started = std::time::Instant::now();
            let res = chat(&api, &model, messages, temperature, max_tokens).await;
            (model, res, started.elapsed().as_millis() as u64)
        }));
    }

    let mut successes: Vec<(String, String, u64)> = Vec::new();
    let mut failures: Vec<Value> = Vec::new();
    for handle in handles {
        match handle.await {
            Ok((model, Ok(content), ms)) => successes.push((model, content, ms)),
            Ok((model, Err(e), ms)) => {
                failures.push(json!({ "model": model, "error": e.to_string(), "time_ms": ms }))
            }
            Err(e) => failures.push(json!({ "error": e.to_string() })),
        }
    }

    if successes.is_empty() {
        return Err(anyhow!("all models failed to respond"));
    }

    let responses_text = successes
        .iter()
        .map(|(m, c, _)| format!("Model: {}\nResponse: {}", m, c))
        .collect::<Vec<_>>()
        .join("\n\n");
    let aggregation_prompt = format!(
        "Analyze the following responses from multiple AI models to this question:\n\n\
         <original_question>\n{}\n</original_question>\n\n\
         <model_responses>\n{}\n</model_responses>\n\n\
         Provide: (1) a synthesis of points where the models agree, (2) notable \
         disagreements, and (3) a balanced conclusion incorporating the best insights. \
         Be concise.",
        prompt, responses_text
    );
    let synthesis = chat(api, judge, build_messages(None, &aggregation_prompt), 0.3, None).await?;

    let mut data = json!({
        "synthesis": synthesis,
        "judge": judge,
        "models": successes.iter().map(|(m, _, _)| m.clone()).collect::<Vec<_>>(),
        "succeeded": successes.len(),
        "failed": failures.len(),
    });
    if !failures.is_empty() {
        data["failures"] = json!(failures);
    }
    if include_raw {
        data["raw"] = json!(successes
            .iter()
            .map(|(m, c, ms)| json!({ "model": m, "response": c, "time_ms": ms }))
            .collect::<Vec<_>>());
    }
    Ok(data)
}

/// The catalog as one row per model: its family, class, outputs, context window
/// and price per million tokens, as `/v1/models` states them and never restated
/// here. `family` narrows to one family (enso, kai, ...).
pub fn catalog(body: &Value, family: Option<&str>) -> Value {
    let rows = body["data"].as_array().or_else(|| body["models"].as_array()).cloned().unwrap_or_default();
    let family = family.map(str::to_lowercase).filter(|f| !f.is_empty());
    let models: Vec<Value> = rows
        .iter()
        .filter(|m| family.as_deref().is_none_or(|f| m["family"].as_str().map(str::to_lowercase).as_deref() == Some(f)))
        .map(|m| {
            json!({
                "id": m["id"],
                "family": m["family"],
                "class": m["class"],
                "outputs": m["outputs"],
                "context_window": m["context_window"],
                "input_per_million": m["pricing"]["input_per_million"],
                "output_per_million": m["pricing"]["output_per_million"],
            })
        })
        .collect();
    json!({ "count": models.len(), "models": models })
}

// ---------------------------------------------------------------------------
// llm tool — action-routed dyn-trait tool
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct LlmArgs {
    action: Option<String>,
    #[serde(alias = "q", alias = "question", alias = "text")]
    prompt: Option<String>,
    model: Option<String>,
    models: Option<Vec<String>>,
    #[serde(alias = "system_prompt")]
    system: Option<String>,
    temperature: Option<f64>,
    #[serde(alias = "max_tokens")]
    max_tokens: Option<u32>,
    #[serde(alias = "json_mode")]
    json_mode: Option<bool>,
    #[serde(alias = "judge_model")]
    judge: Option<String>,
    #[serde(alias = "include_raw")]
    include_raw: Option<bool>,
    /// The whole conversation, instead of `prompt`.
    messages: Option<Value>,
    /// USD per 1,000 tokens — `X-Max-Cost`.
    max_cost: Option<f64>,
    /// Milliseconds — `X-Max-Latency-Ms`.
    max_latency_ms: Option<f64>,
    family: Option<String>,
    request_id: Option<String>,
    signal: Option<String>,
    rating: Option<f64>,
}

/// Enso's two routing bounds as the headers it reads; an unset one is not sent.
fn bounds(args: &LlmArgs) -> std::result::Result<Vec<(&'static str, String)>, String> {
    let mut out = Vec::new();
    for (name, header, v) in [("max_cost", "X-Max-Cost", args.max_cost), ("max_latency_ms", "X-Max-Latency-Ms", args.max_latency_ms)] {
        let Some(n) = v else { continue };
        if !n.is_finite() || n <= 0.0 {
            return Err(format!("{name} must be a positive number, not {n}"));
        }
        out.push((header, if header == "X-Max-Latency-Ms" { format!("{}", n.round() as u64) } else { n.to_string() }));
    }
    Ok(out)
}

pub struct LlmTool {
    api: HanzoApi,
}

impl LlmTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }

    pub fn schema() -> Value {
        json!({
            "name": "llm",
            "description": "Models through api.hanzo.ai. query (default): one completion; model defaults to enso-auto, and \"auto\" lets Enso, the router, pick across the models your org can serve; max_cost (USD per 1,000 tokens) and max_latency_ms bound the pick; returns {id, model, content, finish_reason, usage}, where model is the one that served and id is what feedback takes. consensus: several models and a judge. list: the defaults, offline. models: the catalog with each model's family, class and price per million input and output tokens (family filters, e.g. enso or kai). feedback: tell Enso how a routed answer went: request_id is the completion id, signal one of up, accept, regenerate, down, switch, abandon, revert, rating, dismiss, and rating 1 to 3 with signal rating.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["query", "consensus", "list", "models", "feedback"],
                        "default": "query",
                        "description": "What to do"
                    },
                    "prompt": { "type": "string", "description": "Prompt for query/consensus" },
                    "model": { "type": "string", "description": "A model id, \"auto\", or an enso id (enso-auto, enso-flash, enso-pro, enso-ultra, enso-free); default enso-auto" },
                    "messages": { "type": "array", "items": { "type": "object" }, "description": "query: the whole conversation as [{role, content}], instead of prompt" },
                    "max_cost": { "type": "number", "description": "query: the most you will pay, in USD per 1,000 tokens (X-Max-Cost)" },
                    "max_latency_ms": { "type": "number", "description": "query: the slowest model you will accept, in milliseconds (X-Max-Latency-Ms)" },
                    "family": { "type": "string", "description": "models: only this family, e.g. enso or kai" },
                    "request_id": { "type": "string", "description": "feedback: the completion id query returned (chatcmpl-...)" },
                    "signal": { "type": "string", "enum": SIGNALS, "description": "feedback: how the answer went" },
                    "rating": { "type": "number", "enum": [1, 2, 3], "description": "feedback: 1 to 3, with signal rating" },
                    "models": { "type": "array", "items": { "type": "string" }, "description": "Models for consensus" },
                    "system": { "type": "string", "description": "System prompt" },
                    "temperature": { "type": "number", "default": DEFAULT_TEMPERATURE },
                    "max_tokens": { "type": "number", "description": "Max tokens in the response" },
                    "json_mode": { "type": "boolean", "default": false, "description": "Request a JSON object response" },
                    "judge_model": { "type": "string", "description": "Judge/aggregator for consensus (default gpt-4o)" },
                    "include_raw": { "type": "boolean", "default": false, "description": "Include raw per-model responses in consensus" }
                },
                "required": []
            }
        })
    }

    async fn query(&self, args: &LlmArgs) -> Result<ToolResult> {
        let invalid = |m: &str| Ok(ToolResult::ok(envelope_err("llm", "query", "INVALID_ARGS", m)));
        let messages = match (&args.messages, args.prompt.as_deref().filter(|p| !p.trim().is_empty())) {
            (Some(Value::Array(m)), _) if !m.is_empty() => Value::Array(m.clone()),
            (Some(_), _) => return invalid("messages must be a non-empty array of {role, content}"),
            (None, Some(p)) => build_messages(args.system.as_deref(), p),
            (None, None) => return invalid("prompt or messages required"),
        };
        let headers = match bounds(args) {
            Ok(h) => h,
            Err(e) => return invalid(&e),
        };
        let model = args.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());

        let mut body = json!({
            "model": model,
            "messages": messages,
            "temperature": args.temperature.unwrap_or(DEFAULT_TEMPERATURE),
        });
        if let Some(mt) = args.max_tokens {
            body["max_tokens"] = json!(mt);
        }
        if args.json_mode.unwrap_or(false) {
            body["response_format"] = json!({ "type": "json_object" });
        }

        Ok(match self.api.call(reqwest::Method::POST, "/v1/chat/completions", Some(body), &headers).await {
            Ok(crate::hanzo_api::Answer { body: resp, headers }) => {
                // The model that served: Enso names it in X-Routed-Model when it
                // rewrote the request, and the body's model always says the same.
                let routed = headers
                    .get("x-routed-model")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| json!(v))
                    .or_else(|| resp.get("model").cloned())
                    .unwrap_or(json!(model));
                let data = json!({
                    "id": resp.get("id").cloned().unwrap_or(Value::Null),
                    "model": routed,
                    "content": extract_content(&resp),
                    "finish_reason": resp["choices"][0]["finish_reason"].clone(),
                    "usage": resp.get("usage").cloned().unwrap_or(Value::Null),
                    "response": resp,
                });
                ToolResult::ok(envelope_ok("llm", "query", data))
            }
            Err(e) => ToolResult::ok(envelope_err("llm", "query", "UPSTREAM", e.to_string())),
        })
    }

    async fn consensus(&self, args: &LlmArgs) -> Result<ToolResult> {
        let prompt = match args.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(p) => p,
            None => return Ok(ToolResult::ok(envelope_err("llm", "consensus", "INVALID_ARGS", "prompt required"))),
        };
        let models: Vec<String> = args
            .models
            .clone()
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| DEFAULT_MODELS.iter().map(|s| s.to_string()).collect());
        if models.len() < 2 {
            return Ok(ToolResult::ok(envelope_err("llm", "consensus", "INVALID_ARGS", "consensus requires at least 2 models")));
        }
        let judge = args.judge.clone().filter(|j| !j.is_empty()).unwrap_or_else(|| DEFAULT_JUDGE_MODEL.to_string());

        Ok(match run_consensus(
            &self.api,
            prompt,
            args.system.as_deref(),
            &models,
            &judge,
            args.temperature.unwrap_or(DEFAULT_TEMPERATURE),
            args.max_tokens,
            args.include_raw.unwrap_or(false),
        )
        .await
        {
            Ok(data) => ToolResult::ok(envelope_ok("llm", "consensus", data)),
            Err(e) => ToolResult::ok(envelope_err("llm", "consensus", "UPSTREAM", e.to_string())),
        })
    }

    fn list(&self) -> ToolResult {
        ToolResult::ok(envelope_ok(
            "llm",
            "list",
            json!({
                "default_model": DEFAULT_MODEL,
                "default_judge_model": DEFAULT_JUDGE_MODEL,
                "default_embed_model": DEFAULT_EMBED_MODEL,
                "consensus_models": DEFAULT_MODELS,
                "note": "Models route through api.hanzo.ai /v1/chat/completions. Use action=models for the live catalog."
            }),
        ))
    }

    async fn models(&self, args: &LlmArgs) -> Result<ToolResult> {
        let body = match self.api.call(reqwest::Method::GET, "/v1/models", None, &[]).await {
            Ok(a) => a.body,
            Err(e) => return Ok(ToolResult::ok(envelope_err("llm", "models", "UPSTREAM", e.to_string()))),
        };
        Ok(ToolResult::ok(envelope_ok("llm", "models", catalog(&body, args.family.as_deref()))))
    }

    async fn feedback(&self, args: &LlmArgs) -> Result<ToolResult> {
        let invalid = |m: String| Ok(ToolResult::ok(envelope_err("llm", "feedback", "INVALID_ARGS", m)));
        let Some(id) = args.request_id.as_deref().filter(|s| !s.is_empty()) else {
            return invalid("request_id required: the id of the completion (chatcmpl-...)".into());
        };
        let signal = args.signal.as_deref().unwrap_or("");
        if !SIGNALS.contains(&signal) {
            return invalid(format!("signal must be one of {}", SIGNALS.join(", ")));
        }
        let mut body = json!({ "request_id": id, "signal": signal });
        if signal == "rating" {
            match args.rating {
                Some(r) if [1.0, 2.0, 3.0].contains(&r) => body["rating"] = json!(r as u8),
                _ => return invalid("rating must be 1, 2 or 3 when signal is rating".into()),
            }
        }
        Ok(match self.api.call(reqwest::Method::POST, "/v1/ai/feedback", Some(body), &[]).await {
            Ok(a) => ToolResult::ok(envelope_ok("llm", "feedback", a.body.get("data").cloned().unwrap_or(a.body))),
            Err(e) => ToolResult::ok(envelope_err("llm", "feedback", "UPSTREAM", e.to_string())),
        })
    }
}

impl Default for LlmTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for LlmTool {
    fn name(&self) -> &str {
        "llm"
    }
    fn description(&self) -> &str {
        "Models through api.hanzo.ai: query (Enso routes), consensus, list, models (with prices), feedback"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: LlmArgs = serde_json::from_value(params).unwrap_or_default();
        let action = args.action.as_deref().unwrap_or("query").to_lowercase();

        // `list` is static; the rest reach the gateway and need a key.
        if action == "list" {
            return Ok(self.list());
        }
        if !self.api.has_key() {
            return Ok(ToolResult::ok(envelope_err(
                "llm",
                &action,
                "NO_API_KEY",
                crate::hanzo_api::NO_KEY,
            )));
        }

        match action.as_str() {
            "query" => self.query(&args).await,
            "consensus" => self.consensus(&args).await,
            "models" => self.models(&args).await,
            "feedback" => self.feedback(&args).await,
            other => Ok(ToolResult::ok(envelope_err(
                "llm",
                other,
                "UNKNOWN_ACTION",
                "unknown action; valid: query, consensus, list, models, feedback",
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_shape() {
        let s = LlmTool::schema();
        assert_eq!(s["name"], "llm");
        let actions = s["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        for a in ["query", "consensus", "list", "models", "feedback"] {
            assert!(actions.iter().any(|v| v == a), "missing action {}", a);
        }
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(LlmTool::new().name(), "llm");
    }

    #[test]
    fn args_accept_aliases() {
        let a: LlmArgs = serde_json::from_value(json!({
            "q": "hello", "system_prompt": "be terse", "max_tokens": 32, "json_mode": true
        }))
        .unwrap();
        assert_eq!(a.prompt.as_deref(), Some("hello"));
        assert_eq!(a.system.as_deref(), Some("be terse"));
        assert_eq!(a.max_tokens, Some(32));
        assert_eq!(a.json_mode, Some(true));
    }

    #[test]
    fn build_messages_prepends_system() {
        let m = build_messages(Some("sys"), "user");
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], "sys");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"], "user");
        // Blank system is dropped.
        let m2 = build_messages(Some("   "), "user");
        assert_eq!(m2.as_array().unwrap().len(), 1);
        assert_eq!(m2[0]["role"], "user");
    }

    #[test]
    fn extract_content_prefers_content_then_reasoning() {
        let a = json!({ "choices": [{ "message": { "content": "hi" } }] });
        assert_eq!(extract_content(&a).as_deref(), Some("hi"));
        let b = json!({ "choices": [{ "message": { "content": null, "reasoning_content": "because" } }] });
        assert_eq!(extract_content(&b).as_deref(), Some("because"));
        let c = json!({ "choices": [{ "message": {} }] });
        assert_eq!(extract_content(&c), None);
    }

    #[test]
    fn list_is_offline_and_enveloped() {
        let out = LlmTool::new().list();
        assert_eq!(out.content["ok"], true);
        assert_eq!(out.content["data"]["default_model"], DEFAULT_MODEL);
        assert_eq!(out.content["meta"]["action"], "list");
    }

    /// Live end-to-end via the registry. Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_llm_query_via_registry() {
        let registry = crate::ToolRegistry::with_defaults();
        let out = registry
            .execute("llm", json!({ "action": "query", "prompt": "Reply with the single word: pong" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true, "llm envelope: {}", out.content);
        assert!(out.content["data"]["content"].is_string(), "expected assistant text: {}", out.content["data"]);
        println!("llm content: {}", out.content["data"]["content"]);
    }
}
