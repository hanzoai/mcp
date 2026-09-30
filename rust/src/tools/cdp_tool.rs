//! `cdp` — raw Chrome DevTools Protocol dispatch, peer of `browser`.
//!
//! Method-oriented where `browser` is action-oriented: the CDP method goes on
//! the wire verbatim (`Target.getTargets`, `Page.navigate`, …) to the browser
//! node on this user's ZAP router, whose CDP dispatch handles it directly. The
//! same transport as `browser` ([`crate::zap`]) and no Playwright fallback, as
//! in python-sdk `hanzo_tools.browser.cdp_tool`.

use anyhow::Result;
use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::time::Duration;

use super::browser_tool::{capture, extract_b64, wire_value};
use crate::{zap, MCPTool, ToolResult};

const DESCRIPTION: &str = r#"Raw Chrome DevTools Protocol dispatch — peer of `browser`.

ACTIONS:
- send       : send a CDP method (method=, params=, tab_id=, target_browser=)
- tabs       : Target.getTargets — list connected tabs
- status     : Browser.getVersion — connection + version
- list_browsers : list extension providers (firefox/chrome/safari/edge) connected

Page.captureScreenshot answers with a downscaled JPEG (~1280px, q70) by default
to save context; the capture is saved to a file whose path is returned. Pass
params={"format":"png","maxWidth":0} for pixel detail.

EXAMPLES:
- cdp(action="send", method="Page.navigate", params={"url": "https://example.com"})
- cdp(action="send", method="Runtime.evaluate", params={"expression": "document.title"})
- cdp(action="tabs")
- cdp(action="status")

Use `browser` for high-level verbs (navigate, click, screenshot)."#;

pub struct CdpTool;

impl CdpTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn run(&self, p: &Value) -> Value {
        let s = |k: &str| p.get(k).and_then(Value::as_str);
        let action = s("action").unwrap_or("send");
        let timeout = Duration::from_secs_f64(p.get("timeout").and_then(Value::as_f64).unwrap_or(30.0));
        let method = match action {
            "list_browsers" => {
                return match zap::browsers().await {
                    Ok(b) => json!({
                        "success": true, "transport": "native-zap", "count": b.len(),
                        "browsers": b.iter().map(zap::describe).collect::<Vec<_>>(),
                    }),
                    Err(e) => json!({ "error": e.to_string(), "transport": "native-zap" }),
                }
            }
            "tabs" => "Target.getTargets",
            "status" => "Browser.getVersion",
            "send" => match s("method") {
                Some(m) if !m.is_empty() => m,
                _ => return json!({ "error": "method required for action=send (e.g. 'Page.navigate')", "action": "send" }),
            },
            other => return json!({ "error": format!("unknown action '{other}'. Try: send, tabs, status, list_browsers") }),
        };

        let mut wire: Map<String, Value> = p.get("params").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Some(tab) = p.get("tab_id").filter(|v| !v.is_null()) {
            wire.entry("tabId").or_insert_with(|| tab.clone());
        }
        let params: Vec<(String, String)> =
            wire.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), wire_value(v))).collect();

        let meta = |mut v: Value, provider: &str| {
            v["transport"] = json!("native-zap");
            v["provider"] = json!(provider);
            v["method"] = json!(method);
            v
        };
        let provider = match zap::resolve(s("target_browser"), s("client_id")).await {
            Ok(Some(id)) => id,
            Ok(None) => return json!({ "error": zap::UNPAIRED, "transport": "native-zap", "method": method }),
            Err(e) => return json!({ "error": e.to_string(), "transport": "native-zap", "method": method }),
        };
        let text = match zap::route(&provider, method, &params, timeout).await {
            Ok(t) => t,
            Err(e) => return meta(json!({ "error": e.to_string() }), &provider),
        };
        if let Some(e) = text.strip_prefix("ERR:") {
            return meta(json!({ "error": e }), &provider);
        }
        // Raw dispatch, but a capture is still a capture: a file, and pixels.
        if method.ends_with("captureScreenshot") {
            if let Some(raw) = extract_b64(&text).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()) {
                return meta(capture(&raw, None), &provider);
            }
        }
        meta(json!({ "success": true, "result": text }), &provider)
    }
}

impl Default for CdpTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CdpTool {
    fn name(&self) -> &str {
        "cdp"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "CDP action: send | tabs | status | list_browsers", "default": "send"},
                "method": {"type": "string", "description": "CDP method name (e.g. 'Page.navigate', 'Runtime.evaluate')"},
                "params": {"type": "object", "description": "CDP method params"},
                "tab_id": {"type": ["string", "integer"], "description": "Target tab id (string or int)"},
                "target_browser": {"type": "string", "description": "Provider filter: firefox|chrome|safari|edge"},
                "client_id": {"type": "string", "description": "Specific extension client id"},
                "timeout": {"type": "number", "description": "Per-call timeout (seconds)"}
            }
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        Ok(ToolResult::ok(self.run(&params).await))
    }
}
