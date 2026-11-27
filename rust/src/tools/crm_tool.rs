//! Native Hanzo Cloud CRM MCP tool (`crm`, HIP-0300).
//!
//! Exposes the Hanzo Cloud `/v1/crm` surface (and `/v1/marketing/mail` for
//! outbound CRM email) as a single action-routed MCP tool, with graceful
//! fallback to Hanzo Base (`/v1/base/collections/{object}/records`) when a
//! server has not yet deployed `/v1/crm/records/{object}` (HTTP 404).
//!
//! Actions:
//!   objects      GET    /v1/crm/objects
//!   search       GET    /v1/crm/search?q=...&objects=...&limit=...
//!   list         GET    /v1/crm/records/{object}          (404 -> /v1/base/collections/{object}/records)
//!   get          GET    /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
//!   create       POST   /v1/crm/records/{object}          (404 -> /v1/base/collections/{object}/records)
//!   update       PATCH  /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
//!   delete       DELETE /v1/crm/records/{object}/{id}     (404 -> /v1/base/collections/{object}/records/{id})
//!   merge        POST   /v1/crm/records/{object}/merge
//!   move_stage   POST   /v1/crm/deals/{id}/stage
//!   log_activity POST   /v1/crm/timeline
//!   analytics    GET    /v1/crm/analytics
//!   ai_assist    POST   /v1/crm/ai/assist
//!   send_email   POST   /v1/marketing/mail

use anyhow::Result;
use async_trait::async_trait;
use reqwest::Method;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::{self, HanzoApi, NO_KEY};
use crate::{MCPTool, ToolResult};

/// Closed allowlist of canonical CRM object names.
pub const CRM_OBJECTS: &[&str] = &[
    "people",
    "companies",
    "opportunities",
    "tasks",
    "notes",
    "activities",
    "lists",
    "list_members",
    "candidates",
    "views",
    "segments",
    "attachments",
    "applications",
];

/// All supported `crm` actions.
pub const CRM_ACTIONS: &[&str] = &[
    "objects",
    "search",
    "list",
    "get",
    "create",
    "update",
    "delete",
    "merge",
    "move_stage",
    "log_activity",
    "analytics",
    "ai_assist",
    "send_email",
];

const AI_ASSIST_MODES: &[&str] = &["ask", "enrich", "draft_email", "summarize"];
const ANALYTICS_PIPELINES: &[&str] = &["sales", "fundraising"];

/// Validate and normalize a CRM object name against the closed allowlist.
/// Maps the friendly alias `deals` -> `opportunities`.
pub fn normalize_crm_object(raw: &str) -> std::result::Result<&'static str, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "people" => Ok("people"),
        "companies" => Ok("companies"),
        "opportunities" | "deals" => Ok("opportunities"),
        "tasks" => Ok("tasks"),
        "notes" => Ok("notes"),
        "activities" => Ok("activities"),
        "lists" => Ok("lists"),
        "list_members" => Ok("list_members"),
        "candidates" => Ok("candidates"),
        "views" => Ok("views"),
        "segments" => Ok("segments"),
        "attachments" => Ok("attachments"),
        "applications" => Ok("applications"),
        _ => Err(format!(
            "invalid CRM object {:?}; allowed: people, companies, opportunities (alias: deals), tasks, notes, activities, lists, list_members, candidates, views, segments, attachments, applications",
            raw
        )),
    }
}

fn normalize_direction(raw: &str) -> std::result::Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "in" | "inbound" => Ok("in"),
        "out" | "outbound" => Ok("out"),
        _ => Err(format!("invalid direction {:?}; allowed: in (inbound), out (outbound)", raw)),
    }
}

fn validate_record_id(raw: &str) -> std::result::Result<String, String> {
    let id = raw.trim();
    if id.is_empty() {
        return Err("id required".into());
    }
    if id.len() > 256
        || id.contains('/')
        || id.contains('\\')
        || id.contains('?')
        || id.contains('#')
        || id.contains("..")
        || id.chars().any(char::is_whitespace)
    {
        return Err(format!("invalid record id {:?}", raw));
    }
    Ok(id.to_string())
}

fn validate_org(raw: &str) -> std::result::Result<String, String> {
    let org = raw.trim();
    if org.is_empty() {
        return Err("org cannot be empty".into());
    }
    if org.len() > 128 || !org.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(format!("invalid org slug {:?}: use letters, digits, '.', '_', or '-'", raw));
    }
    Ok(org.to_string())
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Extract a bearer token from `~/.hanzo/credentials.json` if present.
pub fn token_from_credentials_json(content: &str) -> Option<String> {
    let v: Value = serde_json::from_str(content).ok()?;
    let pick = |obj: &Value| -> Option<String> {
        for k in ["token", "access_token", "accessToken", "apiKey", "api_key"] {
            if let Some(s) = obj.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                return Some(s.to_string());
            }
        }
        None
    };
    if let Some(t) = pick(&v) {
        return Some(t);
    }
    if let Some(active) = v.get("active").and_then(Value::as_str) {
        for container in ["profiles", "identities", "accounts"] {
            if let Some(entry) = v.get(container).and_then(|c| c.get(active)) {
                if let Some(t) = pick(entry) {
                    return Some(t);
                }
            }
        }
    }
    None
}

fn read_credentials_file(home: Option<&Path>) -> Option<String> {
    let path = home?.join(".hanzo").join("credentials.json");
    let content = std::fs::read_to_string(path).ok()?;
    token_from_credentials_json(&content)
}

fn str_param<'a>(params: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = params.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            return Some(s);
        }
    }
    None
}

fn u64_param(params: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(v) = params.get(*k) {
            if let Some(n) = v.as_u64() {
                return Some(n);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.trim().parse::<u64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn obj_param<'a>(params: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    for k in keys {
        if let Some(o) = params.get(*k).and_then(Value::as_object) {
            return Some(o);
        }
    }
    None
}

fn parse_objects_filter(params: &Value) -> std::result::Result<Option<String>, String> {
    let Some(val) = params.get("objects") else {
        return Ok(None);
    };
    if val.is_null() {
        return Ok(None);
    }
    let raw_items: Vec<String> = match val {
        Value::String(s) => s
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let s = item
                    .as_str()
                    .ok_or_else(|| "objects array entries must be strings".to_string())?
                    .trim();
                if !s.is_empty() {
                    out.push(s.to_string());
                }
            }
            out
        }
        _ => return Err("objects must be a comma-separated string or array of object names".into()),
    };
    if raw_items.is_empty() {
        return Ok(None);
    }
    let mut normalized = Vec::with_capacity(raw_items.len());
    for item in raw_items {
        let obj = normalize_crm_object(&item)?;
        if !normalized.contains(&obj) {
            normalized.push(obj);
        }
    }
    Ok(Some(normalized.join(",")))
}

fn extract_error_message(body: &Value, raw_text: &str) -> String {
    for candidate in [
        &body["error"]["message"],
        &body["message"],
        &body["msg"],
        &body["error"],
    ] {
        if let Some(s) = candidate.as_str().filter(|s| !s.is_empty()) {
            return s.to_string();
        }
    }
    let trimmed = raw_text.trim();
    if trimmed.is_empty() {
        "request failed".into()
    } else {
        trimmed.chars().take(240).collect()
    }
}

#[derive(Clone, Debug)]
struct CrmOverride {
    base_url: String,
    token: Option<String>,
    default_org: Option<String>,
}

/// First-class native Hanzo Cloud CRM MCP tool.
pub struct CrmTool {
    client: reqwest::Client,
    override_cfg: Option<CrmOverride>,
}

impl CrmTool {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            override_cfg: None,
        }
    }

    /// Construct a `CrmTool` pinned to a specific endpoint/token/org (for deterministic tests).
    pub fn with_endpoint(
        base_url: impl Into<String>,
        token: Option<String>,
        default_org: Option<String>,
    ) -> Self {
        let mut tool = Self::new();
        let cleaned = base_url
            .into()
            .trim()
            .trim_end_matches('/')
            .to_string();
        let cleaned = cleaned.strip_suffix("/v1").map(str::to_string).unwrap_or(cleaned);
        tool.override_cfg = Some(CrmOverride {
            base_url: cleaned,
            token,
            default_org,
        });
        tool
    }

    pub fn schema() -> Value {
        json!({
            "name": "crm",
            "description": "Hanzo Cloud CRM (/v1/crm) with graceful Base fallback (/v1/base/collections/{object}/records): objects, search, list, get, create, update, delete, merge, move_stage, log_activity, analytics, ai_assist, send_email. Valid objects: people, companies, opportunities (alias: deals), tasks, notes, activities, lists, list_members, candidates, views, segments, attachments, applications.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": CRM_ACTIONS,
                        "description": "CRM action: objects | search | list | get | create | update | delete | merge | move_stage | log_activity | analytics | ai_assist | send_email"
                    },
                    "org": {
                        "type": "string",
                        "description": "Optional organization slug sent as X-Org-Id header (overrides HANZO_ORG)"
                    },
                    "object": {
                        "type": "string",
                        "enum": [
                            "people", "companies", "opportunities", "deals", "tasks", "notes",
                            "activities", "lists", "list_members", "candidates", "views",
                            "segments", "attachments", "applications"
                        ],
                        "description": "CRM object collection (`deals` normalizes to `opportunities`)"
                    },
                    "id": {
                        "type": "string",
                        "description": "Record ID (get, update, delete, move_stage, ai_assist)"
                    },
                    "record_id": {
                        "type": "string",
                        "description": "Alias for id (ai_assist, get, update, delete)"
                    },
                    "data": {
                        "type": "object",
                        "description": "Record fields payload (create, update) or activity metadata (log_activity)"
                    },
                    "record": {
                        "type": "object",
                        "description": "Alias for data (create, update)"
                    },
                    "key": {
                        "type": "string",
                        "description": "Optional unique field name for idempotent upsert (create)"
                    },
                    "q": {
                        "type": "string",
                        "description": "Search query (search)"
                    },
                    "objects": {
                        "oneOf": [
                            { "type": "string" },
                            { "type": "array", "items": { "type": "string" } }
                        ],
                        "description": "Optional comma-separated or array list of CRM objects to scope search"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum results (search)"
                    },
                    "filter": {
                        "type": "string",
                        "description": "Filter expression (list, analytics)"
                    },
                    "sort": {
                        "type": "string",
                        "description": "Sort expression, e.g. -created (list)"
                    },
                    "search": {
                        "type": "string",
                        "description": "Full-text search term within collection (list)"
                    },
                    "page": {
                        "type": "integer",
                        "description": "1-based page number (list)"
                    },
                    "per_page": {
                        "type": "integer",
                        "description": "Records per page (list)"
                    },
                    "expand": {
                        "type": "string",
                        "description": "Comma-separated relation fields to expand (list, get)"
                    },
                    "include": {
                        "type": "string",
                        "description": "Comma-separated related summaries to attach: timeline, notes, tasks, attachments, or all (get)"
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Source record ID to merge from (merge) or idempotency key (log_activity)"
                    },
                    "target_id": {
                        "type": "string",
                        "description": "Target record ID to merge into (merge)"
                    },
                    "fields": {
                        "type": "object",
                        "description": "Winning field overrides for merge"
                    },
                    "stage": {
                        "type": "string",
                        "description": "Target deal pipeline stage (move_stage)"
                    },
                    "next_step": {
                        "type": "string",
                        "description": "Optional updated next_step for the opportunity (move_stage)"
                    },
                    "note": {
                        "type": "string",
                        "description": "Optional stage-change note (move_stage)"
                    },
                    "kind": {
                        "type": "string",
                        "description": "Activity kind, e.g. call, email, meeting, note, task (log_activity)"
                    },
                    "subject": {
                        "type": "string",
                        "description": "Activity or email subject (log_activity, send_email)"
                    },
                    "snippet": {
                        "type": "string",
                        "description": "Short activity summary (log_activity)"
                    },
                    "body": {
                        "type": "string",
                        "description": "Activity or email body (log_activity, send_email)"
                    },
                    "at": {
                        "type": "string",
                        "description": "Optional RFC3339 activity timestamp (log_activity)"
                    },
                    "person_id": {
                        "type": "string",
                        "description": "Linked person record ID (log_activity)"
                    },
                    "company_id": {
                        "type": "string",
                        "description": "Linked company record ID (log_activity)"
                    },
                    "opportunity_id": {
                        "type": "string",
                        "description": "Linked opportunity/deal record ID (log_activity)"
                    },
                    "candidate_id": {
                        "type": "string",
                        "description": "Linked candidate record ID (log_activity)"
                    },
                    "person": {
                        "type": "string",
                        "description": "Linked person record ID (send_email; alias for person_id in log_activity)"
                    },
                    "company": {
                        "type": "string",
                        "description": "Alias for company_id (log_activity)"
                    },
                    "opportunity": {
                        "type": "string",
                        "description": "Alias for opportunity_id (log_activity)"
                    },
                    "candidate": {
                        "type": "string",
                        "description": "Alias for candidate_id (log_activity)"
                    },
                    "direction": {
                        "type": "string",
                        "description": "Activity direction: in | out (aliases: inbound | outbound) (log_activity)"
                    },
                    "channel": {
                        "type": "string",
                        "description": "Activity channel, e.g. email | phone | slack | linkedin (log_activity)"
                    },
                    "mode": {
                        "type": "string",
                        "enum": AI_ASSIST_MODES,
                        "description": "AI assist mode: ask | enrich | draft_email | summarize (ai_assist)"
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Instruction or question for AI assist (ai_assist; required for mode=ask)"
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional inference model override (ai_assist)"
                    },
                    "to": {
                        "type": "string",
                        "description": "Recipient email address (send_email)"
                    },
                    "in_reply_to": {
                        "type": "string",
                        "description": "Optional Message-ID header <id@host> being replied to (send_email)"
                    },
                    "references": {
                        "type": "string",
                        "description": "Optional space-separated Message-ID thread references (send_email)"
                    },
                    "pipeline": {
                        "type": "string",
                        "enum": ANALYTICS_PIPELINES,
                        "description": "Optional pipeline filter: sales | fundraising (analytics)"
                    },
                    "period": {
                        "type": "string",
                        "description": "Optional analytics window, e.g. 7d, 30d, 90d (analytics)"
                    },
                    "from": {
                        "type": "string",
                        "description": "Optional analytics start date (analytics)"
                    }
                },
                "required": ["action"]
            }
        })
    }

    fn resolve_runtime(&self, org_param: Option<&str>) -> std::result::Result<(String, String, Option<String>), (&'static str, String)> {
        let org = match org_param {
            Some(o) => Some(validate_org(o).map_err(|e| ("INVALID_ARGS", e))?),
            None => {
                let fallback = self
                    .override_cfg
                    .as_ref()
                    .and_then(|c| c.default_org.clone())
                    .or_else(|| std::env::var("HANZO_ORG").ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                match fallback {
                    Some(o) => Some(validate_org(&o).map_err(|e| ("INVALID_ARGS", e))?),
                    None => None,
                }
            }
        };

        if let Some(cfg) = &self.override_cfg {
            let token = cfg
                .token
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or(("NO_API_KEY", NO_KEY.to_string()))?;
            return Ok((cfg.base_url.clone(), token, org));
        }

        let api = HanzoApi::from_env();
        let base_url = api.base_url().to_string();
        let token = api
            .key()
            .or_else(|| read_credentials_file(dirs::home_dir().as_deref()))
            .ok_or(("NO_API_KEY", NO_KEY.to_string()))?;

        Ok((base_url, token, org))
    }

    async fn send_request(
        &self,
        method: Method,
        base_url: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        token: &str,
        org: Option<&str>,
    ) -> Result<(u16, Value, String)> {
        let mut req = self
            .client
            .request(method, join_url(base_url, path))
            .header(reqwest::header::ACCEPT, "application/json")
            .bearer_auth(token);

        if let Some(o) = org {
            req = req.header("X-Org-Id", o);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        let parsed = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str::<Value>(&text)
                .unwrap_or_else(|_| json!({ "status": status, "body": text }))
        };
        Ok((status, parsed, text))
    }

    async fn call_crm(
        &self,
        action: &str,
        method: Method,
        base_url: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        token: &str,
        org: Option<&str>,
        empty_ok: Option<Value>,
    ) -> Result<ToolResult> {
        let (status, parsed, text) = match self
            .send_request(method, base_url, path, query, body, token, org)
            .await
        {
            Ok(v) => v,
            Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "UPSTREAM", e.to_string()))),
        };

        if let Some(r) = hanzo_api::refusal(status, Some(&parsed)) {
            return Ok(ToolResult {
                success: false,
                content: json!({ "ok": false, "data": null, "error": r.error, "meta": { "tool": "crm", "action": action } }),
                error: Some(serde_json::to_string_pretty(&json!({ "error": r.error })).unwrap_or_default()),
            });
        }

        if (200..300).contains(&status) {
            let data = if parsed.is_null() {
                empty_ok.unwrap_or(Value::Null)
            } else {
                parsed
            };
            return Ok(ToolResult::ok(envelope_ok("crm", action, data)));
        }

        let msg = extract_error_message(&parsed, &text);
        Ok(ToolResult::ok(envelope_err(
            "crm",
            action,
            "UPSTREAM",
            format!("{status}: {msg}"),
        )))
    }

    async fn call_with_base_fallback(
        &self,
        action: &str,
        method: Method,
        base_url: &str,
        crm_path: &str,
        base_path: &str,
        crm_query: &[(&str, String)],
        base_query: &[(&str, String)],
        crm_body: Option<Value>,
        base_body: Option<Value>,
        token: &str,
        org: Option<&str>,
        empty_ok: Option<Value>,
    ) -> Result<ToolResult> {
        let (status, parsed, text) = match self
            .send_request(method.clone(), base_url, crm_path, crm_query, crm_body, token, org)
            .await
        {
            Ok(v) => v,
            Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "UPSTREAM", e.to_string()))),
        };

        if status == 404 {
            let (fb_status, fb_parsed, fb_text) = match self
                .send_request(method, base_url, base_path, base_query, base_body, token, org)
                .await
            {
                Ok(v) => v,
                Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "UPSTREAM", e.to_string()))),
            };

            if let Some(r) = hanzo_api::refusal(fb_status, Some(&fb_parsed)) {
                return Ok(ToolResult {
                    success: false,
                    content: json!({ "ok": false, "data": null, "error": r.error, "meta": { "tool": "crm", "action": action, "fallback": "base" } }),
                    error: Some(serde_json::to_string_pretty(&json!({ "error": r.error })).unwrap_or_default()),
                });
            }

            if (200..300).contains(&fb_status) {
                let data = if fb_parsed.is_null() {
                    empty_ok.unwrap_or(Value::Null)
                } else {
                    fb_parsed
                };
                let mut env = envelope_ok("crm", action, data);
                env["meta"]["fallback"] = json!("base");
                return Ok(ToolResult::ok(env));
            }

            let msg = extract_error_message(&fb_parsed, &fb_text);
            return Ok(ToolResult::ok(envelope_err(
                "crm",
                action,
                "UPSTREAM",
                format!("{fb_status}: {msg}"),
            )));
        }

        if let Some(r) = hanzo_api::refusal(status, Some(&parsed)) {
            return Ok(ToolResult {
                success: false,
                content: json!({ "ok": false, "data": null, "error": r.error, "meta": { "tool": "crm", "action": action } }),
                error: Some(serde_json::to_string_pretty(&json!({ "error": r.error })).unwrap_or_default()),
            });
        }

        if (200..300).contains(&status) {
            let data = if parsed.is_null() {
                empty_ok.unwrap_or(Value::Null)
            } else {
                parsed
            };
            return Ok(ToolResult::ok(envelope_ok("crm", action, data)));
        }

        let msg = extract_error_message(&parsed, &text);
        Ok(ToolResult::ok(envelope_err(
            "crm",
            action,
            "UPSTREAM",
            format!("{status}: {msg}"),
        )))
    }
}

impl Default for CrmTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CrmTool {
    fn name(&self) -> &str {
        "crm"
    }

    fn description(&self) -> &str {
        "Hanzo Cloud CRM (/v1/crm): objects, search, list, get, create, update, delete, merge, move_stage, log_activity, analytics, ai_assist, send_email."
    }

    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");

        if !CRM_ACTIONS.contains(&action) {
            return Ok(ToolResult::ok(envelope_err(
                "crm",
                action,
                "INVALID_ARGS",
                format!("action must be one of: {}", CRM_ACTIONS.join(", ")),
            )));
        }

        // Validate arguments before auth/network where possible so callers get immediate feedback.
        let org_param = str_param(&params, &["org"]);

        match action {
            "objects" => {
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };
                self.call_crm(action, Method::GET, &base_url, "/v1/crm/objects", &[], None, &token, org.as_deref(), None).await
            }

            "search" => {
                let Some(q) = str_param(&params, &["q", "query"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "q required")));
                };
                let objects = match parse_objects_filter(&params) {
                    Ok(v) => v,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let limit = u64_param(&params, &["limit"]);
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };
                let mut query: Vec<(&str, String)> = vec![("q", q.to_string())];
                if let Some(o) = objects {
                    query.push(("objects", o));
                }
                if let Some(l) = limit {
                    query.push(("limit", l.to_string()));
                }
                self.call_crm(action, Method::GET, &base_url, "/v1/crm/search", &query, None, &token, org.as_deref(), None).await
            }

            "list" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut crm_query: Vec<(&str, String)> = Vec::new();
                let mut base_query: Vec<(&str, String)> = Vec::new();
                if let Some(f) = str_param(&params, &["filter"]) {
                    crm_query.push(("filter", f.to_string()));
                    base_query.push(("filter", f.to_string()));
                }
                if let Some(s) = str_param(&params, &["sort"]) {
                    crm_query.push(("sort", s.to_string()));
                    base_query.push(("sort", s.to_string()));
                }
                if let Some(sr) = str_param(&params, &["search", "q"]) {
                    crm_query.push(("search", sr.to_string()));
                    base_query.push(("search", sr.to_string()));
                }
                if let Some(p) = u64_param(&params, &["page"]) {
                    crm_query.push(("page", p.to_string()));
                    base_query.push(("page", p.to_string()));
                }
                if let Some(pp) = u64_param(&params, &["per_page", "perPage", "limit"]) {
                    crm_query.push(("per_page", pp.to_string()));
                    base_query.push(("perPage", pp.to_string()));
                }
                if let Some(ex) = str_param(&params, &["expand"]) {
                    crm_query.push(("expand", ex.to_string()));
                    base_query.push(("expand", ex.to_string()));
                }

                let crm_path = format!("/v1/crm/records/{obj}");
                let base_path = format!("/v1/base/collections/{obj}/records");
                self.call_with_base_fallback(
                    action,
                    Method::GET,
                    &base_url,
                    &crm_path,
                    &base_path,
                    &crm_query,
                    &base_query,
                    None,
                    None,
                    &token,
                    org.as_deref(),
                    None,
                )
                .await
            }

            "get" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(raw_id) = str_param(&params, &["id", "record_id"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "id required")));
                };
                let id = match validate_record_id(raw_id) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut crm_query: Vec<(&str, String)> = Vec::new();
                let mut base_query: Vec<(&str, String)> = Vec::new();
                if let Some(ex) = str_param(&params, &["expand"]) {
                    crm_query.push(("expand", ex.to_string()));
                    base_query.push(("expand", ex.to_string()));
                }
                if let Some(inc) = str_param(&params, &["include"]) {
                    crm_query.push(("include", inc.to_string()));
                }
                let crm_path = format!("/v1/crm/records/{obj}/{id}");
                let base_path = format!("/v1/base/collections/{obj}/records/{id}");
                self.call_with_base_fallback(
                    action,
                    Method::GET,
                    &base_url,
                    &crm_path,
                    &base_path,
                    &crm_query,
                    &base_query,
                    None,
                    None,
                    &token,
                    org.as_deref(),
                    None,
                )
                .await
            }

            "create" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(data) = obj_param(&params, &["data", "record", "fields", "body"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "data object required")));
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let base_body = Value::Object(data.clone());
                let mut crm_envelope = Map::new();
                crm_envelope.insert("record".into(), base_body.clone());
                if let Some(key) = str_param(&params, &["key"]) {
                    crm_envelope.insert("key".into(), json!(key));
                }

                let crm_path = format!("/v1/crm/records/{obj}");
                let base_path = format!("/v1/base/collections/{obj}/records");
                self.call_with_base_fallback(
                    action,
                    Method::POST,
                    &base_url,
                    &crm_path,
                    &base_path,
                    &[],
                    &[],
                    Some(Value::Object(crm_envelope)),
                    Some(base_body),
                    &token,
                    org.as_deref(),
                    None,
                )
                .await
            }

            "update" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(raw_id) = str_param(&params, &["id", "record_id"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "id required")));
                };
                let id = match validate_record_id(raw_id) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(data) = obj_param(&params, &["data", "record", "fields", "body"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "data object required")));
                };
                if data.is_empty() {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "data cannot be empty")));
                }
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let base_body = Value::Object(data.clone());
                let crm_body = json!({ "record": base_body });

                let crm_path = format!("/v1/crm/records/{obj}/{id}");
                let base_path = format!("/v1/base/collections/{obj}/records/{id}");
                self.call_with_base_fallback(
                    action,
                    Method::PATCH,
                    &base_url,
                    &crm_path,
                    &base_path,
                    &[],
                    &[],
                    Some(crm_body),
                    Some(base_body),
                    &token,
                    org.as_deref(),
                    None,
                )
                .await
            }

            "delete" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(raw_id) = str_param(&params, &["id", "record_id"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "id required")));
                };
                let id = match validate_record_id(raw_id) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let crm_path = format!("/v1/crm/records/{obj}/{id}");
                let base_path = format!("/v1/base/collections/{obj}/records/{id}");
                self.call_with_base_fallback(
                    action,
                    Method::DELETE,
                    &base_url,
                    &crm_path,
                    &base_path,
                    &[],
                    &[],
                    None,
                    None,
                    &token,
                    org.as_deref(),
                    Some(json!({ "deleted": true, "object": obj, "id": id })),
                )
                .await
            }

            "merge" => {
                let Some(raw_obj) = str_param(&params, &["object"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "object required")));
                };
                let obj = match normalize_crm_object(raw_obj) {
                    Ok(o) => o,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(raw_src) = str_param(&params, &["source_id", "sourceId"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "source_id required")));
                };
                let source_id = match validate_record_id(raw_src) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(raw_tgt) = str_param(&params, &["target_id", "targetId"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "target_id required")));
                };
                let target_id = match validate_record_id(raw_tgt) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                if source_id == target_id {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "source_id and target_id must differ")));
                }
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut body = Map::new();
                body.insert("source_id".into(), json!(source_id));
                body.insert("target_id".into(), json!(target_id));
                if let Some(fields) = obj_param(&params, &["fields", "data"]) {
                    body.insert("fields".into(), Value::Object(fields.clone()));
                }
                let path = format!("/v1/crm/records/{obj}/merge");
                self.call_crm(action, Method::POST, &base_url, &path, &[], Some(Value::Object(body)), &token, org.as_deref(), None).await
            }

            "move_stage" => {
                let Some(raw_id) = str_param(&params, &["id", "deal_id", "opportunity_id", "record_id"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "id required")));
                };
                let id = match validate_record_id(raw_id) {
                    Ok(i) => i,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                };
                let Some(stage) = str_param(&params, &["stage"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "stage required")));
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut body = Map::new();
                body.insert("stage".into(), json!(stage));
                if let Some(next_step) = str_param(&params, &["next_step"]) {
                    body.insert("next_step".into(), json!(next_step));
                }
                if let Some(note) = str_param(&params, &["note"]) {
                    body.insert("note".into(), json!(note));
                }
                let path = format!("/v1/crm/deals/{id}/stage");
                self.call_crm(action, Method::POST, &base_url, &path, &[], Some(Value::Object(body)), &token, org.as_deref(), None).await
            }

            "log_activity" => {
                let Some(kind) = str_param(&params, &["kind", "type"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "kind required")));
                };
                let person_id = str_param(&params, &["person_id", "person"]);
                let company_id = str_param(&params, &["company_id", "company"]);
                let opportunity_id = str_param(&params, &["opportunity_id", "opportunity"]);
                let candidate_id = str_param(&params, &["candidate_id", "candidate"]);
                if person_id.is_none()
                    && company_id.is_none()
                    && opportunity_id.is_none()
                    && candidate_id.is_none()
                {
                    return Ok(ToolResult::ok(envelope_err(
                        "crm",
                        action,
                        "INVALID_ARGS",
                        "at least one of person_id, company_id, opportunity_id, or candidate_id required",
                    )));
                }
                let direction = match str_param(&params, &["direction"]) {
                    Some(raw_dir) => match normalize_direction(raw_dir) {
                        Ok(d) => Some(d),
                        Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                    },
                    None => None,
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut body = Map::new();
                body.insert("kind".into(), json!(kind));
                if let Some(d) = direction {
                    body.insert("direction".into(), json!(d));
                }
                if let Some(pid) = person_id {
                    body.insert("person_id".into(), json!(pid));
                }
                if let Some(cid) = company_id {
                    body.insert("company_id".into(), json!(cid));
                }
                if let Some(oid) = opportunity_id {
                    body.insert("opportunity_id".into(), json!(oid));
                }
                if let Some(caid) = candidate_id {
                    body.insert("candidate_id".into(), json!(caid));
                }
                for key in ["subject", "snippet", "body", "channel", "at", "source_id"] {
                    if let Some(val) = str_param(&params, &[key]) {
                        body.insert(key.into(), json!(val));
                    }
                }
                if let Some(meta) = obj_param(&params, &["data"]) {
                    body.insert("data".into(), Value::Object(meta.clone()));
                }
                self.call_crm(action, Method::POST, &base_url, "/v1/crm/timeline", &[], Some(Value::Object(body)), &token, org.as_deref(), None).await
            }

            "analytics" => {
                let mut query: Vec<(&str, String)> = Vec::new();
                if let Some(raw_pipe) = str_param(&params, &["pipeline"]) {
                    let pipe = raw_pipe.to_ascii_lowercase();
                    if !ANALYTICS_PIPELINES.contains(&pipe.as_str()) {
                        return Ok(ToolResult::ok(envelope_err(
                            "crm",
                            action,
                            "INVALID_ARGS",
                            format!("invalid pipeline {:?}; allowed: sales, fundraising", raw_pipe),
                        )));
                    }
                    query.push(("pipeline", pipe));
                }
                if let Some(raw_obj) = str_param(&params, &["object"]) {
                    let obj = match normalize_crm_object(raw_obj) {
                        Ok(o) => o,
                        Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                    };
                    query.push(("object", obj.to_string()));
                }
                for key in ["period", "from", "to", "filter"] {
                    if let Some(val) = str_param(&params, &[key]) {
                        query.push((key, val.to_string()));
                    }
                }
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };
                self.call_crm(action, Method::GET, &base_url, "/v1/crm/analytics", &query, None, &token, org.as_deref(), None).await
            }

            "ai_assist" => {
                let Some(mode) = str_param(&params, &["mode"]) else {
                    return Ok(ToolResult::ok(envelope_err(
                        "crm",
                        action,
                        "INVALID_ARGS",
                        format!("mode required ({})", AI_ASSIST_MODES.join(" | ")),
                    )));
                };
                if !AI_ASSIST_MODES.contains(&mode) {
                    return Ok(ToolResult::ok(envelope_err(
                        "crm",
                        action,
                        "INVALID_ARGS",
                        format!("invalid mode {:?}; allowed: {}", mode, AI_ASSIST_MODES.join(", ")),
                    )));
                }
                let prompt = str_param(&params, &["prompt"]);
                if mode == "ask" && prompt.is_none() {
                    return Ok(ToolResult::ok(envelope_err(
                        "crm",
                        action,
                        "INVALID_ARGS",
                        "prompt required when mode is ask",
                    )));
                }
                let normalized_obj = if let Some(raw_obj) = str_param(&params, &["object"]) {
                    match normalize_crm_object(raw_obj) {
                        Ok(o) => Some(o),
                        Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                    }
                } else {
                    None
                };
                let record_id = if let Some(raw_id) = str_param(&params, &["record_id", "id"]) {
                    match validate_record_id(raw_id) {
                        Ok(i) => Some(i),
                        Err(e) => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", e))),
                    }
                } else {
                    None
                };
                if normalized_obj.is_some() != record_id.is_some() {
                    return Ok(ToolResult::ok(envelope_err(
                        "crm",
                        action,
                        "INVALID_ARGS",
                        "object and record_id must be provided together",
                    )));
                }
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut body = Map::new();
                body.insert("mode".into(), json!(mode));
                if let Some(p) = prompt {
                    body.insert("prompt".into(), json!(p));
                }
                if let Some(obj) = normalized_obj {
                    body.insert("object".into(), json!(obj));
                }
                if let Some(rid) = record_id {
                    body.insert("record_id".into(), json!(rid));
                }
                if let Some(model) = str_param(&params, &["model"]) {
                    body.insert("model".into(), json!(model));
                }
                self.call_crm(action, Method::POST, &base_url, "/v1/crm/ai/assist", &[], Some(Value::Object(body)), &token, org.as_deref(), None).await
            }

            "send_email" => {
                let to_str = match params.get("to") {
                    Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
                    Some(Value::Array(arr)) => {
                        let cleaned: Vec<&str> = arr
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .collect();
                        if cleaned.len() > 1 {
                            return Ok(ToolResult::ok(envelope_err(
                                "crm",
                                action,
                                "INVALID_ARGS",
                                "invalid to: /v1/marketing/mail accepts one email address per request",
                            )));
                        }
                        match cleaned.first() {
                            Some(addr) => (*addr).to_string(),
                            None => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "to required"))),
                        }
                    }
                    _ => return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "to required"))),
                };
                let Some(subject) = str_param(&params, &["subject"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "subject required")));
                };
                let Some(email_body) = str_param(&params, &["body"]) else {
                    return Ok(ToolResult::ok(envelope_err("crm", action, "INVALID_ARGS", "body required")));
                };
                let (base_url, token, org) = match self.resolve_runtime(org_param) {
                    Ok(v) => v,
                    Err((code, msg)) => return Ok(ToolResult::ok(envelope_err("crm", action, code, msg))),
                };

                let mut body = Map::new();
                body.insert("to".into(), json!(to_str));
                body.insert("subject".into(), json!(subject));
                body.insert("body".into(), json!(email_body));
                if let Some(person) = str_param(&params, &["person", "person_id"]) {
                    body.insert("person".into(), json!(person));
                }
                if let Some(in_reply_to) = str_param(&params, &["in_reply_to"]) {
                    body.insert("in_reply_to".into(), json!(in_reply_to));
                }
                if let Some(references) = str_param(&params, &["references"]) {
                    body.insert("references".into(), json!(references));
                }
                self.call_crm(action, Method::POST, &base_url, "/v1/marketing/mail", &[], Some(Value::Object(body)), &token, org.as_deref(), None).await
            }

            _ => unreachable!("checked against CRM_ACTIONS"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_crm_object_allowlist_and_alias() {
        for obj in CRM_OBJECTS {
            assert_eq!(normalize_crm_object(obj).unwrap(), *obj);
        }
        assert_eq!(normalize_crm_object("deals").unwrap(), "opportunities");
        assert_eq!(normalize_crm_object("  DEALS  ").unwrap(), "opportunities");
        assert_eq!(normalize_crm_object("People").unwrap(), "people");

        for bad in ["", "users", "invoices", "../people", "people/1", "admin"] {
            assert!(normalize_crm_object(bad).is_err(), "expected {bad:?} to be rejected");
        }
    }

    #[test]
    fn test_token_from_credentials_json() {
        assert_eq!(
            token_from_credentials_json(r#"{"token":"tok-1"}"#).as_deref(),
            Some("tok-1")
        );
        assert_eq!(
            token_from_credentials_json(r#"{"access_token":"tok-2"}"#).as_deref(),
            Some("tok-2")
        );
        assert_eq!(
            token_from_credentials_json(r#"{"active":"hanzo","profiles":{"hanzo":{"accessToken":"tok-3"}}}"#).as_deref(),
            Some("tok-3")
        );
        assert_eq!(token_from_credentials_json(r#"{}"#), None);
    }

    #[test]
    fn test_crm_schema_shape() {
        let s = CrmTool::schema();
        assert_eq!(s["name"], "crm");
        assert_eq!(s["inputSchema"]["required"], json!(["action"]));
        let actions = s["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        assert_eq!(actions.len(), 13);
    }
}
