//! UI component registry tool (HIP-0300).
//!
//! One action-routed `ui` tool for browsing, searching, installing, and
//! managing UI components across framework registries (Hanzo, shadcn/ui, Vue,
//! Svelte, React Native). Ports `python-sdk/pkg/hanzo-tools-ui`.
//!
//! Backend: GitHub API (contents + raw) with a 15-minute in-memory cache for
//! component listing/source, subprocess install via the framework CLI, and
//! semantic search over the api.hanzo.ai search plane.
//!
//! Actions: list_components, get_component, search, install, set_framework,
//! get_framework, semantic_search.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_RAW_BASE: &str = "https://raw.githubusercontent.com";
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_FRAMEWORK: &str = "hanzo";
const SEARCH_INDEX_ENV: &str = "HANZO_UI_SEARCH_INDEX";
const DEFAULT_SEARCH_INDEX: &str = "app-ui-hanzo-ai";

/// Configuration for a UI framework's source repository.
struct Framework {
    label: &'static str,
    owner: &'static str,
    repo: &'static str,
    branch: &'static str,
    components_path: &'static str,
    extension: &'static str,
}

/// The framework registry table (mirrors FRAMEWORK_CONFIGS/FRAMEWORK_NAMES).
fn frameworks() -> HashMap<&'static str, Framework> {
    let mut m = HashMap::new();
    m.insert("hanzo", Framework {
        label: "Hanzo UI (React)", owner: "hanzoai", repo: "ui", branch: "main",
        components_path: "pkg/ui/primitives", extension: ".tsx",
    });
    m.insert("hanzo-native", Framework {
        label: "Hanzo UI Native (React Native)", owner: "hanzoai", repo: "ui-native", branch: "main",
        components_path: "packages/native/src/components", extension: ".tsx",
    });
    m.insert("hanzo-vue", Framework {
        label: "Hanzo UI Vue", owner: "hanzoai", repo: "ui-vue", branch: "main",
        components_path: "packages/vue/src/components", extension: ".vue",
    });
    m.insert("hanzo-svelte", Framework {
        label: "Hanzo UI Svelte", owner: "hanzoai", repo: "ui-svelte", branch: "main",
        components_path: "packages/svelte/src/components", extension: ".svelte",
    });
    m.insert("shadcn", Framework {
        label: "shadcn/ui", owner: "shadcn-ui", repo: "ui", branch: "main",
        components_path: "apps/v4/registry/new-york-v4/ui", extension: ".tsx",
    });
    m.insert("react", Framework {
        label: "shadcn/ui (React)", owner: "shadcn-ui", repo: "ui", branch: "main",
        components_path: "apps/v4/registry/new-york-v4/ui", extension: ".tsx",
    });
    m.insert("svelte", Framework {
        label: "Svelte (shadcn)", owner: "huntabyte", repo: "shadcn-svelte", branch: "main",
        components_path: "apps/www/src/lib/registry/new-york/ui", extension: ".svelte",
    });
    m.insert("vue", Framework {
        label: "Vue (shadcn)", owner: "unovue", repo: "shadcn-vue", branch: "main",
        components_path: "apps/www/src/lib/registry/new-york/ui", extension: ".vue",
    });
    m.insert("react-native", Framework {
        label: "React Native Reusables", owner: "founded-labs", repo: "react-native-reusables", branch: "main",
        components_path: "packages/reusables/src", extension: ".tsx",
    });
    m
}

#[derive(Debug, Default, Deserialize)]
struct UiArgs {
    action: Option<String>,
    framework: Option<String>,
    category: Option<String>,
    #[serde(alias = "component")]
    name: Option<String>,
    #[serde(alias = "search")]
    query: Option<String>,
    #[serde(default)]
    overwrite: bool,
    limit: Option<u32>,
    tags: Option<Vec<String>>,
}

pub struct UiTool {
    api: HanzoApi,
    http: reqwest::Client,
    github_token: Option<String>,
    cache: Mutex<HashMap<String, (Value, Instant)>>,
    current: Mutex<String>,
}

impl UiTool {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Hanzo-MCP-UI-Tool")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let github_token = std::env::var("GITHUB_TOKEN")
            .or_else(|_| std::env::var("GITHUB_PERSONAL_ACCESS_TOKEN"))
            .ok()
            .filter(|s| !s.trim().is_empty());
        Self {
            api: HanzoApi::from_env(),
            http,
            github_token,
            cache: Mutex::new(HashMap::new()),
            current: Mutex::new(DEFAULT_FRAMEWORK.to_string()),
        }
    }

    pub fn schema() -> Value {
        json!({
            "name": "ui",
            "description": "UI component registry (HIP-0300): browse, search, install, and manage UI components across Hanzo, shadcn/ui, Vue, Svelte, and React Native registries via the GitHub API.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list_components", "get_component", "search", "install", "set_framework", "get_framework", "semantic_search"],
                        "description": "Registry action to run"
                    },
                    "framework": {
                        "type": "string",
                        "enum": ["hanzo", "hanzo-native", "hanzo-vue", "hanzo-svelte", "shadcn", "react", "svelte", "vue", "react-native"],
                        "description": "Target framework (defaults to the active framework)"
                    },
                    "name": { "type": "string", "description": "Component name (get_component, install)" },
                    "category": { "type": "string", "description": "Filter listed components by category" },
                    "query": { "type": "string", "description": "Search query (search, semantic_search)" },
                    "overwrite": { "type": "boolean", "default": false, "description": "Overwrite existing files on install" },
                    "limit": { "type": "number", "default": 10, "description": "Max results (semantic_search)" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Tag filter (semantic_search)" }
                },
                "required": ["action"]
            }
        })
    }

    fn framework_or_current(&self, arg: &Option<String>) -> String {
        arg.clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.current.lock().map(|g| g.clone()).unwrap_or_else(|_| DEFAULT_FRAMEWORK.to_string()))
    }

    fn cache_get(&self, key: &str) -> Option<Value> {
        let mut cache = self.cache.lock().ok()?;
        if let Some((data, ts)) = cache.get(key) {
            if ts.elapsed() <= CACHE_TTL {
                return Some(data.clone());
            }
            cache.remove(key);
        }
        None
    }

    fn cache_set(&self, key: &str, data: Value) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key.to_string(), (data, Instant::now()));
        }
    }

    /// GET a GitHub JSON API resource, cached. 404 → NotFound-style error.
    async fn api_get(&self, url: &str) -> Result<Value> {
        if let Some(cached) = self.cache_get(url) {
            return Ok(cached);
        }
        let mut req = self.http.get(url).header("Accept", "application/vnd.github.v3+json");
        if let Some(tok) = &self.github_token {
            req = req.header("Authorization", format!("token {}", tok));
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        match status {
            200 => {
                let data: Value = resp.json().await?;
                self.cache_set(url, data.clone());
                Ok(data)
            }
            403 => Err(anyhow!("GitHub API rate limit exceeded or authentication required")),
            404 => Err(anyhow!("Resource not found")),
            _ => Err(anyhow!("GitHub API error: {}", status)),
        }
    }

    /// GET raw file content from GitHub, cached. 404 → NotFound-style error.
    async fn raw_get(&self, url: &str) -> Result<String> {
        if let Some(cached) = self.cache_get(url) {
            if let Some(s) = cached.as_str() {
                return Ok(s.to_string());
            }
        }
        let resp = self.http.get(url).send().await?;
        let status = resp.status().as_u16();
        match status {
            200 => {
                let text = resp.text().await?;
                self.cache_set(url, Value::String(text.clone()));
                Ok(text)
            }
            404 => Err(anyhow!("File not found")),
            _ => Err(anyhow!("Failed to fetch: {}", status)),
        }
    }

    /// List components: directories or files matching the framework extension.
    async fn list_components(&self, fw: &Framework) -> Result<Vec<Value>> {
        let url = format!(
            "{}/repos/{}/{}/contents/{}?ref={}",
            GITHUB_API_BASE, fw.owner, fw.repo, fw.components_path, fw.branch
        );
        let contents = self.api_get(&url).await?;
        let items = contents.as_array().cloned().unwrap_or_default();
        Ok(items
            .into_iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?;
                let kind = item.get("type")?.as_str()?;
                let is_dir = kind == "dir";
                let is_match = kind == "file" && name.ends_with(fw.extension);
                if is_dir || is_match {
                    Some(json!({ "name": name.replace(fw.extension, ""), "type": kind }))
                } else {
                    None
                }
            })
            .collect())
    }

    /// Fetch a component's source, falling back to `<name>/index<ext>`.
    async fn fetch_component(&self, fw: &Framework, name: &str) -> Result<String> {
        let base = format!("{}/{}/{}/{}", GITHUB_RAW_BASE, fw.owner, fw.repo, fw.branch);
        let direct = format!("{}/{}/{}{}", base, fw.components_path, name, fw.extension);
        match self.raw_get(&direct).await {
            Ok(src) => Ok(src),
            Err(_) => {
                let index = format!("{}/{}/{}/index{}", base, fw.components_path, name, fw.extension);
                self.raw_get(&index)
                    .await
                    .map_err(|_| anyhow!("Component '{}' not found in {} repository", name, fw.repo))
            }
        }
    }
}

impl Default for UiTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for UiTool {
    fn name(&self) -> &str {
        "ui"
    }
    fn description(&self) -> &str {
        "UI component registry (HIP-0300): browse, search, install UI components across Hanzo, shadcn/ui, Vue, Svelte, React Native registries"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: UiArgs = serde_json::from_value(params).unwrap_or_default();
        let action = args.action.clone().unwrap_or_default();
        let configs = frameworks();

        match action.as_str() {
            "list_components" => {
                let key = self.framework_or_current(&args.framework);
                let fw = match configs.get(key.as_str()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "list_components", "UNKNOWN_FRAMEWORK",
                        format!("Unknown framework: {}", key)))),
                };
                match self.list_components(fw).await {
                    Ok(mut components) => {
                        if let Some(cat) = args.category.filter(|c| !c.is_empty()) {
                            components.retain(|c| c.get("category").and_then(Value::as_str) == Some(cat.as_str()));
                        }
                        Ok(ToolResult::ok(envelope_ok("ui", "list_components", json!({
                            "framework": fw.label,
                            "source": "github",
                            "total": components.len(),
                            "components": components,
                        }))))
                    }
                    Err(e) => Ok(ToolResult::ok(envelope_err("ui", "list_components", "UPSTREAM", e.to_string()))),
                }
            }
            "get_component" => {
                let name = match args.name.filter(|n| !n.trim().is_empty()) {
                    Some(n) => n,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "get_component", "INVALID_ARGS", "Component name is required"))),
                };
                let key = self.framework_or_current(&args.framework);
                let fw = match configs.get(key.as_str()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "get_component", "UNKNOWN_FRAMEWORK",
                        format!("Unknown framework: {}", key)))),
                };
                match self.fetch_component(fw, &name).await {
                    Ok(source) => Ok(ToolResult::ok(envelope_ok("ui", "get_component", json!({
                        "framework": fw.label,
                        "component": name,
                        "source": source,
                        "backend": "github",
                    })))),
                    Err(e) => Ok(ToolResult::ok(envelope_err("ui", "get_component", "NOT_FOUND", e.to_string()))),
                }
            }
            "search" => {
                let q = match args.query.filter(|q| !q.trim().is_empty()) {
                    Some(q) => q,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "search", "INVALID_ARGS", "Search query is required"))),
                };
                let key = self.framework_or_current(&args.framework);
                let fw = match configs.get(key.as_str()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "search", "UNKNOWN_FRAMEWORK",
                        format!("Unknown framework: {}", key)))),
                };
                match self.list_components(fw).await {
                    Ok(components) => {
                        let needle = q.to_lowercase();
                        let results: Vec<Value> = components
                            .into_iter()
                            .filter(|c| c.get("name").and_then(Value::as_str)
                                .map_or(false, |n| n.to_lowercase().contains(&needle)))
                            .collect();
                        Ok(ToolResult::ok(envelope_ok("ui", "search", json!({
                            "framework": fw.label,
                            "query": q,
                            "source": "github",
                            "results": results,
                        }))))
                    }
                    Err(e) => Ok(ToolResult::ok(envelope_err("ui", "search", "UPSTREAM", e.to_string()))),
                }
            }
            "install" => {
                let name = match args.name.filter(|n| !n.trim().is_empty()) {
                    Some(n) => n,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "install", "INVALID_ARGS", "Component name is required"))),
                };
                let key = self.framework_or_current(&args.framework);
                let fw = match configs.get(key.as_str()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "install", "UNKNOWN_FRAMEWORK",
                        format!("Unknown framework: {}", key)))),
                };
                let mut cmd = if key.starts_with("hanzo") {
                    format!("npx @hanzo/ui add {}", name)
                } else if key == "shadcn" || key == "react" {
                    format!("npx shadcn@latest add {}", name)
                } else {
                    return Ok(ToolResult::ok(envelope_err("ui", "install", "UNSUPPORTED",
                        format!("Installation not supported for framework: {}", key))));
                };
                if args.overwrite {
                    cmd.push_str(" --overwrite");
                }
                let mut proc = tokio::process::Command::new("sh");
                proc.arg("-c").arg(&cmd);
                proc.stdout(std::process::Stdio::piped());
                proc.stderr(std::process::Stdio::piped());
                let child = match proc.spawn() {
                    Ok(c) => c,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("ui", "install", "SPAWN", e.to_string()))),
                };
                match tokio::time::timeout(INSTALL_TIMEOUT, child.wait_with_output()).await {
                    Ok(Ok(out)) => Ok(ToolResult::ok(envelope_ok("ui", "install", json!({
                        "framework": fw.label,
                        "component": name,
                        "command": cmd,
                        "output": String::from_utf8_lossy(&out.stdout),
                        "warnings": String::from_utf8_lossy(&out.stderr),
                    })))),
                    Ok(Err(e)) => Ok(ToolResult::ok(envelope_err("ui", "install", "EXEC", e.to_string()))),
                    Err(_) => Ok(ToolResult::ok(envelope_err("ui", "install", "TIMEOUT",
                        format!("install timed out after {}s", INSTALL_TIMEOUT.as_secs())))),
                }
            }
            "set_framework" => {
                let key = match args.framework.filter(|f| !f.trim().is_empty()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "set_framework", "INVALID_ARGS", "Framework is required"))),
                };
                let fw = match configs.get(key.as_str()) {
                    Some(f) => f,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "set_framework", "UNKNOWN_FRAMEWORK",
                        format!("Unknown framework: {}", key)))),
                };
                if let Ok(mut cur) = self.current.lock() {
                    *cur = key.clone();
                }
                Ok(ToolResult::ok(envelope_ok("ui", "set_framework", json!({
                    "success": true,
                    "framework": fw.label,
                    "message": format!("Switched to {}", fw.label),
                }))))
            }
            "get_framework" => {
                let current = self.current.lock().map(|g| g.clone()).unwrap_or_else(|_| DEFAULT_FRAMEWORK.to_string());
                let label = configs.get(current.as_str()).map(|f| f.label).unwrap_or(current.as_str());
                let mut available: Vec<Value> = configs
                    .iter()
                    .map(|(k, f)| json!({ "key": k, "name": f.label, "has_registry": k.starts_with("hanzo") }))
                    .collect();
                available.sort_by(|a, b| a["key"].as_str().unwrap_or("").cmp(b["key"].as_str().unwrap_or("")));
                Ok(ToolResult::ok(envelope_ok("ui", "get_framework", json!({
                    "current": label,
                    "framework": current,
                    "available": available,
                }))))
            }
            "semantic_search" => {
                if !self.api.has_key() {
                    return Ok(ToolResult::ok(envelope_err("ui", "semantic_search", "NO_API_KEY",
                        crate::hanzo_api::NO_KEY)));
                }
                let q = match args.query.filter(|q| !q.trim().is_empty()) {
                    Some(q) => q,
                    None => return Ok(ToolResult::ok(envelope_err("ui", "semantic_search", "INVALID_ARGS", "Query is required"))),
                };
                let index = std::env::var(SEARCH_INDEX_ENV)
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_SEARCH_INDEX.to_string());
                let mut payload = json!({
                    "query": q,
                    "index": index,
                    "limit": args.limit.unwrap_or(10),
                });
                if let Some(tags) = args.tags.filter(|t| !t.is_empty()) {
                    payload["tags"] = json!(tags);
                }
                Ok(match self.api.post("/v1/search-docs", payload).await {
                    Ok(results) => ToolResult::ok(envelope_ok("ui", "semantic_search", json!({
                        "query": q,
                        "results": results,
                    }))),
                    Err(e) => ToolResult::ok(envelope_err("ui", "semantic_search", "UPSTREAM", e.to_string())),
                })
            }
            "" => Ok(ToolResult::ok(envelope_err("ui", "unknown", "INVALID_ARGS", "action is required"))),
            other => Ok(ToolResult::ok(envelope_err("ui", other, "UNKNOWN_ACTION",
                format!("Unknown action: {}. Valid: list_components, get_component, search, install, set_framework, get_framework, semantic_search", other)))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_shape() {
        let s = UiTool::schema();
        assert_eq!(s["name"], "ui");
        assert_eq!(s["inputSchema"]["required"][0], "action");
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(UiTool::new().name(), "ui");
    }

    #[test]
    fn framework_table_is_complete() {
        let f = frameworks();
        for k in ["hanzo", "hanzo-native", "hanzo-vue", "hanzo-svelte", "shadcn", "react", "svelte", "vue", "react-native"] {
            assert!(f.contains_key(k), "missing framework {}", k);
        }
    }

    #[test]
    fn name_aliases_component() {
        let a: UiArgs = serde_json::from_value(json!({ "action": "get_component", "component": "button" })).unwrap();
        assert_eq!(a.name.as_deref(), Some("button"));
    }

    #[tokio::test]
    async fn set_framework_switches_current() {
        let tool = UiTool::new();
        let out = tool.execute(json!({ "action": "set_framework", "framework": "vue" })).await.unwrap();
        assert_eq!(out.content["ok"], true);
        assert_eq!(out.content["data"]["framework"], "Vue (shadcn)");
        assert_eq!(*tool.current.lock().unwrap(), "vue");
    }

    #[tokio::test]
    async fn unknown_framework_is_rejected() {
        let tool = UiTool::new();
        let out = tool.execute(json!({ "action": "set_framework", "framework": "nope" })).await.unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "UNKNOWN_FRAMEWORK");
    }

    #[tokio::test]
    async fn unknown_action_is_reported() {
        let tool = UiTool::new();
        let out = tool.execute(json!({ "action": "frobnicate" })).await.unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "UNKNOWN_ACTION");
    }

    #[tokio::test]
    async fn get_component_requires_name() {
        let tool = UiTool::new();
        let out = tool.execute(json!({ "action": "get_component" })).await.unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "INVALID_ARGS");
    }
}
