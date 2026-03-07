/// Unified network tool (HIP-0300)
///
/// Handles network operations:
/// - request: HTTP request
/// - download: Save URL to file
/// - open: Open URL in browser

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NetAction {
    Request,
    Download,
    Open,
    Help,
}

impl Default for NetAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for NetAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "request" | "fetch" | "get" => Ok(Self::Request),
            "download" | "save" => Ok(Self::Download),
            "open" | "browse" => Ok(Self::Open),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FetchToolArgs {
    pub action: Option<String>,
    pub url: Option<String>,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub output: Option<String>,
    pub timeout: Option<u64>,
}

pub struct FetchToolDefinition;

impl FetchToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "fetch",
            "description": "Network operations: request, download, open",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["request", "download", "open", "help"],
                        "description": "Network action"
                    },
                    "url": { "type": "string", "description": "URL" },
                    "method": { "type": "string", "description": "HTTP method", "default": "GET" },
                    "headers": { "type": "object", "description": "HTTP headers" },
                    "body": { "type": "string", "description": "Request body" },
                    "output": { "type": "string", "description": "Output file for download" },
                    "timeout": { "type": "number", "description": "Timeout in ms", "default": 30000 }
                },
                "required": ["action", "url"]
            }
        })
    }
}

pub struct FetchTool;

impl FetchTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: FetchToolArgs) -> Result<Value> {
        let action: NetAction = args.action.as_deref().unwrap_or("help").parse()?;

        match action {
            NetAction::Request => self.request(&args).await,
            NetAction::Download => self.download(&args).await,
            NetAction::Open => self.open(&args).await,
            NetAction::Help => Ok(self.help()),
        }
    }

    async fn request(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let method = args.method.as_deref().unwrap_or("GET");
        let timeout = args.timeout.unwrap_or(30000);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout))
            .build()?;

        let mut req = match method.to_uppercase().as_str() {
            "GET" => client.get(url),
            "POST" => client.post(url),
            "PUT" => client.put(url),
            "DELETE" => client.delete(url),
            "PATCH" => client.patch(url),
            "HEAD" => client.head(url),
            _ => return Err(anyhow!("Unsupported method: {}", method)),
        };

        if let Some(headers) = &args.headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }

        if let Some(body) = &args.body {
            req = req.body(body.clone());
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp.headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let content_type = headers.get("content-type").cloned().unwrap_or_default();
        let body_text = resp.text().await?;
        let body_val: Value = if content_type.contains("json") {
            serde_json::from_str(&body_text).unwrap_or(Value::String(body_text.clone()))
        } else {
            // Truncate large text responses
            Value::String(if body_text.len() > 50000 {
                body_text[..50000].to_string()
            } else {
                body_text
            })
        };

        Ok(json!({
            "ok": true,
            "data": { "status": status, "headers": headers, "body": body_val },
            "error": null,
            "meta": { "tool": "fetch", "action": "request" }
        }))
    }

    async fn download(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let output = args.output.as_deref().ok_or_else(|| anyhow!("output path required"))?;
        let timeout = args.timeout.unwrap_or(60000);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout))
            .build()?;

        let resp = client.get(url).send().await?;
        if !resp.status().is_success() {
            return Ok(json!({
                "ok": false,
                "data": null,
                "error": { "code": "HTTP_ERROR", "message": format!("{}", resp.status()) },
                "meta": { "tool": "fetch", "action": "download" }
            }));
        }

        let bytes = resp.bytes().await?;
        if let Some(parent) = std::path::Path::new(output).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(output, &bytes).await?;

        Ok(json!({
            "ok": true,
            "data": { "url": url, "output": output, "size": bytes.len() },
            "error": null,
            "meta": { "tool": "fetch", "action": "download" }
        }))
    }

    async fn open(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;

        #[cfg(target_os = "macos")]
        let cmd = "open";
        #[cfg(target_os = "linux")]
        let cmd = "xdg-open";
        #[cfg(target_os = "windows")]
        let cmd = "start";

        tokio::process::Command::new(cmd)
            .arg(url)
            .output()
            .await?;

        Ok(json!({
            "ok": true,
            "data": { "url": url, "opened": true },
            "error": null,
            "meta": { "tool": "fetch", "action": "open" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "fetch",
                "actions": {
                    "request": "HTTP request (requires url, optional method/headers/body)",
                    "download": "Save URL to file (requires url, output)",
                    "open": "Open URL in browser (requires url)"
                }
            },
            "error": null,
            "meta": { "tool": "fetch", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_net_action_parse() {
        assert_eq!("request".parse::<NetAction>().unwrap(), NetAction::Request);
        assert_eq!("fetch".parse::<NetAction>().unwrap(), NetAction::Request);
        assert_eq!("download".parse::<NetAction>().unwrap(), NetAction::Download);
    }
}
