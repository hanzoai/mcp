//! Vision tool (HIP-0300).
//!
//! `vision` → POST /v1/chat/completions with an `image_url` content part to the
//! vision SKU (default `zen3-vl`; `zen3-omni` also available — see GET /v1/models).
//! Accepts an http(s)/data URL or a local file path (read + base64 data URI).

use anyhow::Result;
use async_trait::async_trait;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const DEFAULT_MODEL: &str = "zen3-vl";
const DEFAULT_PROMPT: &str = "Describe this image.";
const DEFAULT_MAX_TOKENS: u32 = 512;

#[derive(Debug, Default, Deserialize)]
struct VisionArgs {
    /// http(s) URL, data: URI, or local file path.
    #[serde(alias = "image_url", alias = "url", alias = "path")]
    image: Option<String>,
    #[serde(alias = "prompt", alias = "text")]
    query: Option<String>,
    model: Option<String>,
    #[serde(alias = "max_tokens")]
    max_tokens: Option<u32>,
}

pub struct VisionTool {
    api: HanzoApi,
}

impl VisionTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "vision",
            "description": "Analyze an image with a vision model on api.hanzo.ai (default zen3-vl). `image` is an http(s)/data URL or local file path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "image": { "type": "string", "description": "http(s) URL, data: URI, or local file path" },
                    "query": { "type": "string", "description": "Prompt about the image", "default": DEFAULT_PROMPT },
                    "model": { "type": "string", "description": "Vision SKU", "default": DEFAULT_MODEL },
                    "max_tokens": { "type": "number", "default": DEFAULT_MAX_TOKENS }
                },
                "required": ["image"]
            }
        })
    }
}

impl Default for VisionTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve an image reference to something the API accepts as `image_url.url`:
/// pass http(s)/data URIs through; read a local file into a base64 data URI.
async fn resolve_image(image: &str) -> Result<String> {
    if image.starts_with("http://") || image.starts_with("https://") || image.starts_with("data:") {
        return Ok(image.to_string());
    }
    let bytes = tokio::fs::read(image).await?;
    let mime = match Path::new(image)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[async_trait]
impl MCPTool for VisionTool {
    fn name(&self) -> &str {
        "vision"
    }
    fn description(&self) -> &str {
        "Analyze an image with a vision model on api.hanzo.ai (default zen3-vl)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        if !self.api.has_key() {
            return Ok(ToolResult::ok(envelope_err(
                "vision",
                "analyze",
                "NO_API_KEY",
                crate::hanzo_api::NO_KEY,
            )));
        }
        let args: VisionArgs = serde_json::from_value(params).unwrap_or_default();
        let image = match args.image.filter(|s| !s.trim().is_empty()) {
            Some(i) => i,
            None => return Ok(ToolResult::ok(envelope_err("vision", "analyze", "INVALID_ARGS", "image required"))),
        };
        let image_url = match resolve_image(&image).await {
            Ok(u) => u,
            Err(e) => return Ok(ToolResult::ok(envelope_err("vision", "analyze", "IMAGE_READ", e.to_string()))),
        };

        let model = args.model.filter(|m| !m.is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let prompt = args.query.filter(|p| !p.is_empty()).unwrap_or_else(|| DEFAULT_PROMPT.to_string());
        let body = json!({
            "model": model,
            "max_tokens": args.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": image_url } }
                ]
            }]
        });

        Ok(match self.api.post("/v1/chat/completions", body).await {
            Ok(resp) => {
                // Surface the assistant text alongside the raw completion. Reasoning
                // vision SKUs (zen3-vl/zen3-omni) may put text in `reasoning_content`
                // when `content` is null (e.g. truncated mid-reasoning).
                let message = &resp["choices"][0]["message"];
                let content = if message["content"].is_string() {
                    message["content"].clone()
                } else {
                    message["reasoning_content"].clone()
                };
                let data = json!({
                    "model": resp.get("model").cloned().unwrap_or(json!(model)),
                    "content": content,
                    "finish_reason": resp["choices"][0]["finish_reason"].clone(),
                    "usage": resp.get("usage").cloned().unwrap_or(Value::Null),
                    "response": resp,
                });
                ToolResult::ok(envelope_ok("vision", "analyze", data))
            }
            Err(e) => ToolResult::ok(envelope_err("vision", "analyze", "UPSTREAM", e.to_string())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_shape() {
        let s = VisionTool::schema();
        assert_eq!(s["name"], "vision");
        assert_eq!(s["inputSchema"]["required"][0], "image");
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(VisionTool::new().name(), "vision");
    }

    #[tokio::test]
    async fn resolve_image_passes_through_urls() {
        assert_eq!(resolve_image("https://x/y.png").await.unwrap(), "https://x/y.png");
        assert_eq!(resolve_image("data:image/png;base64,AAAA").await.unwrap(), "data:image/png;base64,AAAA");
    }

    #[tokio::test]
    async fn resolve_image_encodes_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("pix.png");
        std::fs::write(&p, b"\x89PNG\r\n").unwrap();
        let out = resolve_image(p.to_str().unwrap()).await.unwrap();
        assert!(out.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn vision_args_alias_image_url_and_prompt() {
        let a: VisionArgs = serde_json::from_value(json!({ "image_url": "https://x/y.png", "prompt": "what" })).unwrap();
        assert_eq!(a.image.as_deref(), Some("https://x/y.png"));
        assert_eq!(a.query.as_deref(), Some("what"));
    }

    /// Live end-to-end via the registry, using a 1x1 PNG data URI.
    /// Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_vision_via_registry() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let registry = crate::ToolRegistry::with_defaults();
        let out = registry
            .execute("vision", json!({ "image": png, "query": "What color? One word.", "max_tokens": 256 }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true, "vision envelope: {}", out.content);
        assert!(out.content["data"]["content"].is_string(), "expected assistant text, got: {}", out.content["data"]);
        println!("vision content: {}", out.content["data"]["content"]);
    }
}
