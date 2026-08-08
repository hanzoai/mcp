//! Hanzo API client — the shared conduit to the live api.hanzo.ai backend.
//!
//! One value owns credentials, base URL, and the HTTP client so every
//! cloud-backed tool composes over the same seam (HIP-0300).
//!
//! Auth: a `pk-`/`sk-` bearer key from `HANZO_API_KEY`, else
//! `~/.hanzo/config.json` field `apiKey`. Base URL: `HANZO_API_BASE`, else
//! `https://api.hanzo.ai`.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// Default base URL for the Hanzo cloud API.
pub const DEFAULT_BASE_URL: &str = "https://api.hanzo.ai";

/// What every cloud-backed tool says when no key resolved — one sentence in one
/// place, so the shapes cannot drift apart tool by tool.
///
/// Cloud admits two: `pk-` is the publishable key you may ship in a browser
/// bundle, `sk-` is the one you may not. `APIKeyPrefixes` in cloud's
/// `auth_identity.go` is the authority; anything else resolves to no principal.
pub const NO_KEY: &str = "no API key: run `hanzo login` or set HANZO_API_KEY (pk-/sk-)";

/// Client for the Hanzo cloud API (code knowledge, web, vision).
#[derive(Clone)]
pub struct HanzoApi {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl HanzoApi {
    /// Build a client from the environment: `HANZO_API_BASE` / `HANZO_API_KEY`,
    /// falling back to `~/.hanzo/config.json` and the default base URL.
    pub fn from_env() -> Self {
        let base_url = std::env::var("HANZO_API_BASE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            base_url,
            api_key: resolve_api_key(),
            client,
        }
    }

    /// Whether an API key was resolved. Tools surface a clear error when false.
    pub fn has_key(&self) -> bool {
        self.api_key.as_deref().map_or(false, |k| !k.is_empty())
    }

    /// The resolved base URL (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// GET `path` with query params, returning the parsed JSON body.
    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        let mut req = self.client.get(join_url(&self.base_url, path));
        if !query.is_empty() {
            req = req.query(query);
        }
        self.send(req).await
    }

    /// POST `path` with a JSON body, returning the parsed JSON body.
    pub async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let req = self.client.post(join_url(&self.base_url, path)).json(&body);
        self.send(req).await
    }

    /// POST `path` with a JSON body over `text/event-stream`, returning the
    /// stream's decoded `data:` frames in order.
    ///
    /// The body arrives complete before it is decoded: a tool answers its caller
    /// once, so nothing downstream can consume a partial stream, and the whole
    /// response is exactly what [`frames`] already parses. An HTTP failure is an
    /// `Err` carrying the status and body — a stream that never started is not
    /// an empty stream.
    pub async fn events(&self, path: &str, body: Value) -> Result<Vec<Value>> {
        let req = self
            .client
            .post(join_url(&self.base_url, path))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&body);
        let resp = self.auth(req).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("{} {}", status.as_u16(), text.trim()));
        }
        Ok(frames(&text))
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value> {
        // A transport error (DNS/refused/timeout) becomes Err so callers may
        // fall back to a local path; an HTTP error body is still JSON we pass on.
        let resp = self.auth(req).send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        Ok(serde_json::from_str::<Value>(&text)
            .unwrap_or_else(|_| json!({ "status": status, "body": text })))
    }

    /// Attach the bearer key. The one place credentials meet a request.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}

impl Default for HanzoApi {
    fn default() -> Self {
        Self::from_env()
    }
}

/// Decode an SSE body into its `data:` payloads, in order.
///
/// Hanzo's streams are data-only JSON that self-describes via `type`, so an
/// `event:` line carries nothing and is skipped. Per the SSE rule, repeated
/// `data:` lines within one frame join with a newline. The terminal `[DONE]`
/// sentinel mirrors the OpenAI convention and is a marker, not an event, so it
/// is dropped along with any payload that is not JSON.
pub fn frames(body: &str) -> Vec<Value> {
    fn flush(data: &mut String, out: &mut Vec<Value>) {
        let payload = std::mem::take(data);
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(payload) {
            out.push(v);
        }
    }

    let mut out = Vec::new();
    let mut data = String::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            flush(&mut data, &mut out);
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush(&mut data, &mut out);
    out
}

/// Resolve the API key: `HANZO_API_KEY` first, then `~/.hanzo/config.json`.
fn resolve_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("HANZO_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let path = dirs::home_dir()?.join(".hanzo").join("config.json");
    let content = std::fs::read_to_string(path).ok()?;
    api_key_from_config_json(&content)
}

/// Extract the `apiKey` field from a `~/.hanzo/config.json` document.
pub fn api_key_from_config_json(content: &str) -> Option<String> {
    let v: Value = serde_json::from_str(content).ok()?;
    v.get("apiKey")
        .and_then(|k| k.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Join a base URL and a path with exactly one separating slash.
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_api_key() {
        let doc = r#"{"apiKey":"sk-abc123","accessToken":"x","user":{}}"#;
        assert_eq!(api_key_from_config_json(doc).as_deref(), Some("sk-abc123"));
    }

    #[test]
    fn missing_or_blank_api_key_is_none() {
        assert!(api_key_from_config_json(r#"{"user":{}}"#).is_none());
        assert!(api_key_from_config_json(r#"{"apiKey":""}"#).is_none());
        assert!(api_key_from_config_json(r#"{"apiKey":"   "}"#).is_none());
        assert!(api_key_from_config_json("not json").is_none());
    }

    #[test]
    fn join_url_normalizes_slashes() {
        assert_eq!(join_url("https://api.hanzo.ai", "/v1/code/search"), "https://api.hanzo.ai/v1/code/search");
        assert_eq!(join_url("https://api.hanzo.ai/", "v1/code/search"), "https://api.hanzo.ai/v1/code/search");
        assert_eq!(join_url("https://api.hanzo.ai/", "/v1/code/search"), "https://api.hanzo.ai/v1/code/search");
    }

    #[test]
    fn default_base_url_is_wired() {
        assert_eq!(DEFAULT_BASE_URL, "https://api.hanzo.ai");
    }

    #[test]
    fn frames_decode_in_order_and_drop_the_done_sentinel() {
        let body = concat!(
            "data: {\"type\":\"status\",\"stage\":\"searching\"}\n\n",
            "data: {\"type\":\"text\",\"delta\":\"a\"}\n\n",
            "data: [DONE]\n\n",
        );
        let f = frames(body);
        assert_eq!(f.len(), 2, "[DONE] is a marker, not an event");
        assert_eq!(f[0]["stage"], "searching");
        assert_eq!(f[1]["delta"], "a");
    }

    #[test]
    fn frames_join_multiline_data_and_skip_non_events() {
        let body = ": keep-alive\nevent: ignored\ndata: {\"type\":\"text\",\n\
                    data: \"delta\":\"x\"}\n\nretry: 100\ndata: not json\n\n";
        let f = frames(body);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["delta"], "x");
    }

    #[test]
    fn frames_read_crlf_and_an_unterminated_last_frame() {
        let f = frames("data: {\"type\":\"done\",\"answer\":\"ok\"}\r\n");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["answer"], "ok");
    }
}
