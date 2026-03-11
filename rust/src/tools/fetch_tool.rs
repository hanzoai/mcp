/// Unified network tool (HIP-0300)
///
/// Handles network operations:
/// - request: Full HTTP request with method/headers/body
/// - fetch: Simplified GET returning text
/// - head: HEAD request for headers only
/// - download: Save URL to file
/// - open: Open URL in browser
/// - search: Web search query
/// - crawl: Recursive site mirror

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NetAction {
    Request,
    Fetch,
    Head,
    Download,
    Open,
    Search,
    Crawl,
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
            "request" | "get" => Ok(Self::Request),
            "fetch" => Ok(Self::Fetch),
            "head" => Ok(Self::Head),
            "download" | "save" => Ok(Self::Download),
            "open" | "browse" => Ok(Self::Open),
            "search" => Ok(Self::Search),
            "crawl" | "mirror" => Ok(Self::Crawl),
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
    pub query: Option<String>,
    pub depth: Option<usize>,
    pub limit: Option<usize>,
}

pub struct FetchToolDefinition;

impl FetchToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "fetch",
            "description": "Network operations: request, fetch, head, download, open, search, crawl",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["request", "fetch", "head", "download", "open", "search", "crawl", "help"],
                        "description": "Network action"
                    },
                    "url": { "type": "string", "description": "URL" },
                    "method": { "type": "string", "description": "HTTP method", "default": "GET" },
                    "headers": { "type": "object", "description": "HTTP headers" },
                    "body": { "type": "string", "description": "Request body" },
                    "output": { "type": "string", "description": "Output file/dir for download/crawl" },
                    "timeout": { "type": "number", "description": "Timeout in ms", "default": 30000 },
                    "query": { "type": "string", "description": "Search query" },
                    "depth": { "type": "number", "description": "Crawl depth", "default": 2 },
                    "limit": { "type": "number", "description": "Max results/pages", "default": 10 }
                },
                "required": ["action"]
            }
        })
    }
}

pub struct FetchTool;

impl FetchTool {
    pub fn new() -> Self {
        Self
    }

    fn build_client(&self, timeout: u64) -> Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout))
            .user_agent("Mozilla/5.0 (compatible; HanzoBot/1.0)")
            .build()?)
    }

    pub async fn execute(&self, args: FetchToolArgs) -> Result<Value> {
        let action: NetAction = args.action.as_deref().unwrap_or("help").parse()?;

        match action {
            NetAction::Request => self.request(&args).await,
            NetAction::Fetch => self.fetch_url(&args).await,
            NetAction::Head => self.head(&args).await,
            NetAction::Download => self.download(&args).await,
            NetAction::Open => self.open(&args).await,
            NetAction::Search => self.search(&args).await,
            NetAction::Crawl => self.crawl(&args).await,
            NetAction::Help => Ok(self.help()),
        }
    }

    async fn request(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let method = args.method.as_deref().unwrap_or("GET");
        let timeout = args.timeout.unwrap_or(30000);
        let client = self.build_client(timeout)?;

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
            Value::String(if body_text.len() > 50000 { body_text[..50000].to_string() } else { body_text })
        };

        Ok(json!({
            "ok": true,
            "data": { "status": status, "headers": headers, "body": body_val },
            "error": null,
            "meta": { "tool": "fetch", "action": "request" }
        }))
    }

    async fn fetch_url(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let timeout = args.timeout.unwrap_or(30000);
        let client = self.build_client(timeout)?;

        let mut req = client.get(url);
        if let Some(headers) = &args.headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp.headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let text = resp.text().await?;
        let text = if text.len() > 50000 { text[..50000].to_string() } else { text };

        Ok(json!({
            "ok": true,
            "data": { "text": text, "status": status, "headers": headers },
            "error": null,
            "meta": { "tool": "fetch", "action": "fetch" }
        }))
    }

    async fn head(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let timeout = args.timeout.unwrap_or(30000);
        let client = self.build_client(timeout)?;

        let mut req = client.head(url);
        if let Some(headers) = &args.headers {
            for (k, v) in headers {
                req = req.header(k.as_str(), v.as_str());
            }
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp.headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        Ok(json!({
            "ok": true,
            "data": { "status": status, "headers": headers },
            "error": null,
            "meta": { "tool": "fetch", "action": "head" }
        }))
    }

    async fn download(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let output = args.output.as_deref().ok_or_else(|| anyhow!("output path required"))?;
        let timeout = args.timeout.unwrap_or(60000);
        let client = self.build_client(timeout)?;

        let resp = client.get(url).send().await?;
        if !resp.status().is_success() {
            return Ok(json!({
                "ok": false, "data": null,
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

        tokio::process::Command::new(cmd).arg(url).output().await?;

        Ok(json!({
            "ok": true,
            "data": { "url": url, "opened": true },
            "error": null,
            "meta": { "tool": "fetch", "action": "open" }
        }))
    }

    async fn search(&self, args: &FetchToolArgs) -> Result<Value> {
        let query = args.query.as_deref().ok_or_else(|| anyhow!("query required"))?;
        let timeout = args.timeout.unwrap_or(15000);
        let client = self.build_client(timeout)?;

        // Manual URL encoding for the query
        let encoded_query: String = query.chars().map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                c.to_string()
            } else if c == ' ' {
                "+".to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        }).collect();
        let url = format!("https://html.duckduckgo.com/html/?q={}", encoded_query);
        let resp = client.get(&url).send().await?;
        let html = resp.text().await?;

        // Simple regex extraction of search results
        let re = regex::Regex::new(r#"class="result__title"[\s\S]*?href="([^"]*)"[^>]*>([\s\S]*?)</a>"#).unwrap();
        let limit = args.limit.unwrap_or(10);
        let mut results = Vec::new();

        for cap in re.captures_iter(&html) {
            if results.len() >= limit { break; }
            let href = cap.get(1).map(|m| m.as_str()).unwrap_or("").replace("&amp;", "&");
            let title = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            // Strip HTML tags from title
            let tag_re = regex::Regex::new(r"<[^>]+>").unwrap();
            let clean_title = tag_re.replace_all(title, "").trim().to_string();
            results.push(json!({ "url": href, "title": clean_title }));
        }

        Ok(json!({
            "ok": true,
            "data": { "query": query, "results": results, "count": results.len() },
            "error": null,
            "meta": { "tool": "fetch", "action": "search" }
        }))
    }

    async fn crawl(&self, args: &FetchToolArgs) -> Result<Value> {
        let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?;
        let output = args.output.as_deref().ok_or_else(|| anyhow!("output directory required"))?;
        let max_depth = args.depth.unwrap_or(2);
        let max_pages = args.limit.unwrap_or(100);
        let timeout = args.timeout.unwrap_or(10000);
        let client = self.build_client(timeout)?;

        let start_host = reqwest::Url::parse(url)?.host_str().unwrap_or("").to_string();
        let mut visited = std::collections::HashSet::new();
        let mut pages = Vec::new();
        let mut queue = vec![(url.to_string(), 0usize)];

        tokio::fs::create_dir_all(output).await?;

        while let Some((current_url, depth)) = queue.first().cloned() {
            queue.remove(0);
            if visited.contains(&current_url) || depth > max_depth || pages.len() >= max_pages {
                continue;
            }
            if let Ok(parsed) = reqwest::Url::parse(&current_url) {
                if parsed.host_str().unwrap_or("") != start_host { continue; }
            } else { continue; }

            visited.insert(current_url.clone());

            let resp = match client.get(&current_url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            let body = match resp.text().await {
                Ok(b) => b,
                Err(_) => continue,
            };

            // Determine filename
            if let Ok(parsed) = reqwest::Url::parse(&current_url) {
                let path = parsed.path().trim_start_matches('/');
                let file_name = if path.is_empty() || path.ends_with('/') {
                    format!("{}index.html", path)
                } else if !path.contains('.') {
                    format!("{}.html", path)
                } else {
                    path.to_string()
                };
                let full_path = std::path::Path::new(output).join(&file_name);
                if let Some(parent) = full_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&full_path, &body).await;
                pages.push(full_path.display().to_string());
            }

            // Extract links for further crawling
            let link_re = regex::Regex::new(r#"href=["']([^"']+)["']"#).unwrap();
            for cap in link_re.captures_iter(&body) {
                if let Some(href) = cap.get(1) {
                    if let Ok(abs) = reqwest::Url::parse(&current_url).and_then(|base| base.join(href.as_str())) {
                        let abs_str = abs.to_string();
                        if !visited.contains(&abs_str) {
                            queue.push((abs_str, depth + 1));
                        }
                    }
                }
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "pages": pages, "count": pages.len(), "dest": output, "depth": max_depth },
            "error": null,
            "meta": { "tool": "fetch", "action": "crawl" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "fetch",
                "actions": {
                    "request": "Full HTTP request (requires url, optional method/headers/body)",
                    "fetch": "Simplified GET returning text (requires url)",
                    "head": "HEAD request for headers only (requires url)",
                    "download": "Save URL to file (requires url, output)",
                    "open": "Open URL in browser (requires url)",
                    "search": "Web search (requires query)",
                    "crawl": "Recursive site mirror (requires url, output)"
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
        assert_eq!("fetch".parse::<NetAction>().unwrap(), NetAction::Fetch);
        assert_eq!("head".parse::<NetAction>().unwrap(), NetAction::Head);
        assert_eq!("download".parse::<NetAction>().unwrap(), NetAction::Download);
        assert_eq!("search".parse::<NetAction>().unwrap(), NetAction::Search);
        assert_eq!("crawl".parse::<NetAction>().unwrap(), NetAction::Crawl);
    }
}
