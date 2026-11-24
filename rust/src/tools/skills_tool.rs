//! `skills` — First-class Hanzo Skills MCP tool (HIP-0300).
//!
//! Actions: `search`, `detect`, `get`, `install`, `list`.
//! Queries `https://hanzoskills.com/search.json` (1,470+ skills, Tier-1 index) and
//! `https://hanzoskills.com/skills/<slug>/SKILL.md` (Tier-2 full markdown), overrideable via
//! `HANZOSKILLS_API_URL`, plus `/v1/tool/skills` on `api.hanzo.ai`. Installs `SKILL.md` into
//! `~/.agents/skills/<slug>/SKILL.md` with strict slug sanitization (`^[a-z0-9][a-z0-9_-]{0,63}$`).

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

pub const DEFAULT_SKILLS_BASE_URL: &str = "https://hanzoskills.com";

static SLUG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").unwrap());

/// Validate a skill slug strictly against `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn valid_slug(slug: &str) -> bool {
    SLUG_RE.is_match(slug)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSummary {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub description: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

fn skills_root() -> Result<PathBuf> {
    if let Ok(custom) = std::env::var("HANZO_SKILLS_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory for ~/.agents/skills"))?;
    Ok(home.join(".agents").join("skills"))
}

fn frontmatter_description(md: &str) -> String {
    let normalized = md.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return String::new();
    };
    let Some((block, _)) = rest.split_once("\n---") else {
        return String::new();
    };
    for line in block.lines() {
        if let Some(v) = line.strip_prefix("description:") {
            let v = v.trim();
            if v.starts_with('"') {
                if let Ok(s) = serde_json::from_str::<String>(v) {
                    return s;
                }
            }
            return v.trim_matches('\'').to_string();
        }
    }
    String::new()
}

pub struct SkillsTool {
    client: reqwest::Client,
}

impl SkillsTool {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }

    pub fn schema() -> Value {
        json!({
            "name": "skills",
            "description": "Discover, inspect, detect, list, and install agent skills from hanzoskills.com (/search.json & /skills/<slug>/SKILL.md) and Hanzo Cloud (/v1/tool/skills) into ~/.agents/skills/<slug>/SKILL.md.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["search", "detect", "get", "install", "list"],
                        "description": "Skill operation: search | detect | get | install | list"
                    },
                    "query": {
                        "type": "string",
                        "description": "Search words for action=search (e.g. 'kai decisions' or 'kubernetes deploy')"
                    },
                    "category": {
                        "type": "string",
                        "description": "Optional category filter for action=search (e.g. 'hanzo')"
                    },
                    "slug": {
                        "type": "string",
                        "description": "Skill slug (^[a-z0-9][a-z0-9_-]{0,63}$) for get or install (alias: name)"
                    },
                    "name": {
                        "type": "string",
                        "description": "Alias for slug"
                    },
                    "path": {
                        "type": "string",
                        "description": "Workspace directory for action=detect (default: current directory)"
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "default": 10,
                        "description": "Maximum results to return (default 10)"
                    },
                    "remote": {
                        "type": "boolean",
                        "description": "For action=list: also include remote catalog and org /v1/tool/skills entries"
                    }
                },
                "required": ["action"]
            }
        })
    }

    fn base_url() -> String {
        std::env::var("HANZOSKILLS_API_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_SKILLS_BASE_URL.to_string())
    }

    fn parse_skill_entries(val: &Value, default_source: &str, origin: &str) -> Vec<SkillSummary> {
        let arr = val
            .get("s")
            .and_then(Value::as_array)
            .or_else(|| val.get("skills").and_then(Value::as_array))
            .or_else(|| val.get("tools").and_then(Value::as_array))
            .or_else(|| val.get("items").and_then(Value::as_array))
            .or_else(|| val.as_array());
        let Some(items) = arr else {
            return Vec::new();
        };
        let base = origin.trim_end_matches('/').trim_end_matches("/api/skills");
        let mut out = Vec::new();
        for item in items {
            let slug = item
                .get("i")
                .or_else(|| item.get("slug"))
                .or_else(|| item.get("name"))
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if !valid_slug(slug) {
                continue;
            }
            let category = item
                .get("c")
                .or_else(|| item.get("category"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let desc = item
                .get("d")
                .or_else(|| item.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tags: Vec<String> = match item.get("g").or_else(|| item.get("tags")) {
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                Some(Value::String(s)) => s.split(|c: char| c == ',' || c.is_whitespace()).filter(|x| !x.is_empty()).map(str::to_string).collect(),
                _ => Vec::new(),
            };
            let url = item
                .get("url")
                .and_then(Value::as_str)
                .map(|u| {
                    if u.starts_with("http://") || u.starts_with("https://") {
                        u.to_string()
                    } else {
                        format!("{base}/{}", u.trim_start_matches('/'))
                    }
                })
                .or_else(|| Some(format!("{base}/skills/{slug}/SKILL.md")));
            out.push(SkillSummary {
                slug: slug.to_string(),
                category,
                description: desc,
                tags,
                url,
                source: Some(default_source.to_string()),
            });
        }
        out
    }

    async fn fetch_catalog(&self, include_org: bool) -> Result<Vec<SkillSummary>> {
        let mut merged: BTreeMap<String, SkillSummary> = BTreeMap::new();
        let base = Self::base_url();

        let candidates = if base.ends_with("/api/skills") || base.ends_with(".json") {
            vec![base.clone()]
        } else {
            vec![format!("{base}/search.json"), format!("{base}/.well-known/agent-skills/index.json")]
        };

        let mut last_err = None;
        for url in candidates {
            match self.client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let text = resp.text().await?;
                    let val: Value = serde_json::from_str(&text)?;
                    for s in Self::parse_skill_entries(&val, "hanzoskills", &base) {
                        merged.insert(s.slug.clone(), s);
                    }
                    if !merged.is_empty() {
                        break;
                    }
                }
                Ok(resp) => {
                    last_err = Some(anyhow!("{url}: HTTP {}", resp.status().as_u16()));
                }
                Err(e) => {
                    last_err = Some(anyhow!("{url}: {e}"));
                }
            }
        }

        if merged.is_empty() {
            if let Some(err) = last_err {
                return Err(err);
            }
        }

        if include_org {
            let api = HanzoApi::from_env();
            if api.has_key() {
                if let Ok(org_val) = api.get("/v1/tool/skills", &[]).await {
                    for s in Self::parse_skill_entries(&org_val, "hanzo_cloud", api.base_url()) {
                        merged.entry(s.slug.clone()).or_insert(s);
                    }
                }
            }
        }

        Ok(merged.into_values().collect())
    }

    async fn fetch_skill_markdown(&self, slug: &str) -> Result<(String, String)> {
        if !valid_slug(slug) {
            return Err(anyhow!(
                "invalid skill slug {slug:?}: must match ^[a-z0-9][a-z0-9_-]{{0,63}}$"
            ));
        }
        let base = Self::base_url();
        let urls = if base.ends_with("/api/skills") {
            vec![format!("{base}/{slug}")]
        } else {
            vec![
                format!("{base}/skills/{slug}/SKILL.md"),
                format!("{base}/{slug}.md"),
            ]
        };

        for url in &urls {
            if let Ok(resp) = self.client.get(url).send().await {
                if resp.status().is_success() {
                    let ct = resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_lowercase();
                    let body = resp.text().await?;
                    if ct.contains("json") || body.trim_start().starts_with('{') {
                        if let Ok(v) = serde_json::from_str::<Value>(&body) {
                            if let Some(md) = v
                                .get("content")
                                .or_else(|| v.get("markdown"))
                                .or_else(|| v.get("skill_md"))
                                .and_then(Value::as_str)
                            {
                                return Ok((md.to_string(), url.clone()));
                            }
                        }
                    } else if !body.trim().is_empty() {
                        return Ok((body, url.clone()));
                    }
                }
            }
        }

        // Check org authored skills on /v1/tool/skills/authored if authenticated.
        let api = HanzoApi::from_env();
        if api.has_key() {
            if let Ok(authored) = api.get("/v1/tool/skills/authored", &[]).await {
                if let Some(arr) = authored.get("skills").and_then(Value::as_array) {
                    if let Some(hit) = arr.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(slug)) {
                        if let Some(content) = hit.get("content").and_then(Value::as_str) {
                            return Ok((content.to_string(), format!("{}/v1/tool/skills/authored", api.base_url())));
                        }
                    }
                }
            }
        }

        Err(anyhow!("skill {slug:?} not found on {base}"))
    }

    fn list_local(root: &Path) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(root) else {
            return Vec::new();
        };
        let mut items = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !valid_slug(slug) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if let Ok(content) = std::fs::read_to_string(&skill_md) {
                items.push(json!({
                    "slug": slug,
                    "description": frontmatter_description(&content),
                    "path": skill_md.display().to_string(),
                    "bytes": content.len(),
                }));
            }
        }
        items.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
        items
    }

    fn detect_signals(ws: &Path) -> Vec<&'static str> {
        let mut signals = vec!["hanzo"];
        if ws.join("Cargo.toml").exists() {
            signals.extend(["rust", "hanzo-mcp"]);
        }
        if ws.join("go.mod").exists() {
            signals.extend(["go-sdk", "hanzo-base", "hanzo-cloud"]);
        }
        if ws.join("package.json").exists() || ws.join("tsconfig.json").exists() {
            signals.extend(["hanzo-node", "frontend", "mcp-builder"]);
        }
        if ws.join("pyproject.toml").exists() {
            signals.extend(["hanzo-sdk", "kai"]);
        }
        if ws.join("compose.yml").exists() || ws.join("Dockerfile").exists() {
            signals.extend(["hanzo-deploy", "hanzo-platform"]);
        }
        if ws.join("kustomization.yaml").exists() || ws.join("charts").exists() {
            signals.extend(["hanzo-k8s", "hanzo-deploy"]);
        }
        signals.sort_unstable();
        signals.dedup();
        signals
    }
}

impl Default for SkillsTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for SkillsTool {
    fn name(&self) -> &str {
        "skills"
    }

    fn description(&self) -> &str {
        "Discover, detect, read, list, and install skills from hanzoskills.com (/search.json & /skills/<slug>/SKILL.md) and /v1/tool/skills into ~/.agents/skills/<slug>/SKILL.md"
    }

    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(10)
            .clamp(1, 100) as usize;
        let slug_param = params
            .get("slug")
            .or_else(|| params.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        match action.as_str() {
            "search" => {
                let query = params
                    .get("query")
                    .or_else(|| params.get("q"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if query.is_empty() {
                    return Ok(ToolResult::ok(envelope_err("skills", "search", "INVALID_ARGS", "query required")));
                }
                let cat_filter = params
                    .get("category")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_lowercase())
                    .filter(|s| !s.is_empty());
                let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
                let catalog = match self.fetch_catalog(true).await {
                    Ok(c) => c,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("skills", "search", "UPSTREAM", e.to_string()))),
                };
                let joined = words.join("-");
                let mut hits: Vec<(i64, &SkillSummary)> = Vec::new();
                for s in &catalog {
                    if let Some(ref cf) = cat_filter {
                        if s.category.as_deref().map(|c| c.to_lowercase()).as_deref() != Some(cf.as_str()) {
                            continue;
                        }
                    }
                    let name_lc = s.slug.to_lowercase();
                    let desc_lc = s.description.to_lowercase();
                    let tags_lc: Vec<String> = s.tags.iter().map(|t| t.to_lowercase()).collect();
                    let mut score: i64 = if name_lc == joined { 25 } else { 0 };
                    let mut matched_any = false;
                    for w in &words {
                        if name_lc.contains(w) {
                            score += 5;
                            matched_any = true;
                        } else if tags_lc.iter().any(|t| t.contains(w)) {
                            score += 3;
                            matched_any = true;
                        } else if desc_lc.contains(w) {
                            score += 1;
                            matched_any = true;
                        }
                    }
                    if matched_any {
                        hits.push((score, s));
                    }
                }
                hits.sort_by(|a, b| {
                    b.0.cmp(&a.0)
                        .then_with(|| a.1.slug.len().cmp(&b.1.slug.len()))
                        .then_with(|| a.1.slug.cmp(&b.1.slug))
                });
                let total = hits.len();
                let skills: Vec<&SkillSummary> = hits.into_iter().take(limit).map(|(_, s)| s).collect();
                Ok(ToolResult::ok(envelope_ok(
                    "skills",
                    "search",
                    json!({
                        "query": query,
                        "total": total,
                        "skills": skills,
                    }),
                )))
            }

            "detect" => {
                let ws = params
                    .get("path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .or_else(|| std::env::current_dir().ok())
                    .unwrap_or_else(|| PathBuf::from("."));
                let signals = Self::detect_signals(&ws);
                let catalog = self.fetch_catalog(true).await.unwrap_or_default();
                let mut recommended: Vec<Value> = Vec::new();
                for sig in &signals {
                    if let Some(found) = catalog.iter().find(|s| s.slug == *sig) {
                        recommended.push(json!(found));
                    }
                }
                if recommended.is_empty() {
                    for s in catalog.iter().filter(|s| signals.iter().any(|k| s.slug.contains(k))).take(limit) {
                        recommended.push(json!(s));
                    }
                }
                Ok(ToolResult::ok(envelope_ok(
                    "skills",
                    "detect",
                    json!({
                        "path": ws.display().to_string(),
                        "signals": signals,
                        "recommended": recommended,
                    }),
                )))
            }

            "get" => {
                let Some(slug) = slug_param else {
                    return Ok(ToolResult::ok(envelope_err("skills", "get", "INVALID_ARGS", "slug required")));
                };
                if !valid_slug(slug) {
                    return Ok(ToolResult::ok(envelope_err(
                        "skills",
                        "get",
                        "INVALID_SLUG",
                        format!("invalid skill slug {slug:?}: must match ^[a-z0-9][a-z0-9_-]{{0,63}}$"),
                    )));
                }
                match self.fetch_skill_markdown(slug).await {
                    Ok((content, url)) => Ok(ToolResult::ok(envelope_ok(
                        "skills",
                        "get",
                        json!({
                            "slug": slug,
                            "description": frontmatter_description(&content),
                            "url": url,
                            "content": content,
                        }),
                    ))),
                    Err(e) => Ok(ToolResult::ok(envelope_err("skills", "get", "NOT_FOUND", e.to_string()))),
                }
            }

            "install" => {
                let Some(slug) = slug_param else {
                    return Ok(ToolResult::ok(envelope_err("skills", "install", "INVALID_ARGS", "slug required")));
                };
                if !valid_slug(slug) {
                    return Ok(ToolResult::ok(envelope_err(
                        "skills",
                        "install",
                        "INVALID_SLUG",
                        format!("invalid skill slug {slug:?}: must match ^[a-z0-9][a-z0-9_-]{{0,63}}$"),
                    )));
                }
                let (content, url) = match self.fetch_skill_markdown(slug).await {
                    Ok(pair) => pair,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("skills", "install", "UPSTREAM", e.to_string()))),
                };
                let root = skills_root()?;
                let dir = root.join(slug);
                std::fs::create_dir_all(&dir)?;
                let dest = dir.join("SKILL.md");
                let tmp = dir.join(format!(".SKILL.md.tmp.{}", std::process::id()));
                std::fs::write(&tmp, content.as_bytes())?;
                std::fs::rename(&tmp, &dest)?;
                Ok(ToolResult::ok(envelope_ok(
                    "skills",
                    "install",
                    json!({
                        "installed": true,
                        "slug": slug,
                        "path": dest.display().to_string(),
                        "bytes": content.len(),
                        "source_url": url,
                    }),
                )))
            }

            "list" => {
                let root = skills_root()?;
                let installed = Self::list_local(&root);
                let include_remote = params.get("remote").and_then(Value::as_bool).unwrap_or(false);
                let remote = if include_remote {
                    self.fetch_catalog(true)
                        .await
                        .ok()
                        .map(|c| c.into_iter().take(limit).collect::<Vec<_>>())
                } else {
                    None
                };
                Ok(ToolResult::ok(envelope_ok(
                    "skills",
                    "list",
                    json!({
                        "skills_dir": root.display().to_string(),
                        "installed_count": installed.len(),
                        "installed": installed,
                        "remote": remote,
                    }),
                )))
            }

            _ => Ok(ToolResult::ok(envelope_err(
                "skills",
                &action,
                "INVALID_ARGS",
                "action must be one of: search, detect, get, install, list",
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_sanitization_strictly_enforces_pattern() {
        for ok in ["kai", "hanzo", "hanzo-mcp", "hip-0300", "a", "skill_1-test", &"a".repeat(64)] {
            assert!(valid_slug(ok), "expected valid slug: {ok}");
        }
        for bad in ["", "-kai", "_kai", "Kai", "../evil", "a/b", "a\\b", "a.b", "a b", &"a".repeat(65)] {
            assert!(!valid_slug(bad), "expected invalid slug: {bad:?}");
        }
    }

    #[tokio::test]
    async fn install_search_get_and_list_roundtrip_against_search_json_and_skill_md() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let (ct, body) = if first.contains("GET /skills/kai/SKILL.md ") {
                    (
                        "text/markdown",
                        "---\nname: kai\ndescription: \"Kai decisions skill\"\n---\n# Kai\nUse calibrated decisions.\n".to_string(),
                    )
                } else {
                    (
                        "application/json",
                        json!({
                            "v": 1,
                            "t": 2,
                            "s": [
                                { "i": "kai", "c": "hanzo", "d": "Kai decisions skill", "g": ["hanzo", "decisions"] },
                                { "i": "hanzo-mcp", "c": "hanzo", "d": "Hanzo MCP server skill", "g": ["mcp"] }
                            ]
                        })
                        .to_string(),
                    )
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HANZO_API_URL", "http://127.0.0.1:1");
        std::env::set_var("HANZOSKILLS_API_URL", format!("http://{addr}"));
        std::env::set_var("HANZO_SKILLS_DIR", tmp.path());

        let tool = SkillsTool::new();

        // Reject path traversal before network
        let bad = tool.execute(json!({ "action": "install", "slug": "../pwn" })).await.unwrap();
        assert_eq!(bad.content["ok"], false);
        assert_eq!(bad.content["error"]["code"], "INVALID_SLUG");

        // Search
        let searched = tool.execute(json!({ "action": "search", "query": "decisions" })).await.unwrap();
        assert_eq!(searched.content["ok"], true, "{}", searched.content);
        assert_eq!(searched.content["data"]["skills"][0]["slug"], "kai");

        // Get
        let got = tool.execute(json!({ "action": "get", "slug": "kai" })).await.unwrap();
        assert_eq!(got.content["ok"], true);
        assert!(got.content["data"]["content"].as_str().unwrap().contains("# Kai"));

        // Install
        let installed = tool.execute(json!({ "action": "install", "slug": "kai" })).await.unwrap();
        assert_eq!(installed.content["ok"], true, "{}", installed.content);
        assert!(tmp.path().join("kai").join("SKILL.md").is_file());

        // List
        let listed = tool.execute(json!({ "action": "list" })).await.unwrap();
        assert_eq!(listed.content["data"]["installed_count"], 1);
        assert_eq!(listed.content["data"]["installed"][0]["slug"], "kai");

        std::env::remove_var("HANZOSKILLS_API_URL");
        std::env::remove_var("HANZO_SKILLS_DIR");
        server.abort();
    }
}
