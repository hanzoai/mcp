//! Hanzo Cloud Tracker work-item tools (HIP-0300).
//!
//! Work items — the Hanzo Cloud /v1/tracker surface as MCP tools.
//! This is how an agent reports on its own work. Hanzo has exactly ONE work-item
//! primitive — the cloud tracker Issue — and these tools are a thin, named projection of it:
//!
//!   tracker_boards  GET   /v1/tracker/projects                    the org's boards
//!   tracker_issues  GET   /v1/tracker/projects/{key}/issues       ?status&kind&source&repo
//!   tracker_create  POST  /v1/tracker/projects/{key}/issues       open a work item
//!   tracker_update  PATCH /v1/tracker/projects/{key}/issues/{num} move / assign / link

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::{HanzoApi, NO_KEY};
use crate::{MCPTool, ToolResult};

fn require_key(api: &HanzoApi, tool: &'static str, action: &'static str) -> Option<Result<ToolResult>> {
    if api.has_key() {
        None
    } else {
        Some(Ok(ToolResult::ok(envelope_err(
            tool,
            action,
            "NO_API_KEY",
            NO_KEY,
        ))))
    }
}

fn respond(tool: &'static str, action: &'static str, result: Result<Value>) -> Result<ToolResult> {
    Ok(match result {
        Ok(body) => ToolResult::ok(envelope_ok(tool, action, body)),
        Err(e) => ToolResult::ok(envelope_err(tool, action, "UPSTREAM", e.to_string())),
    })
}

fn issues_path(key: &str) -> String {
    format!("/v1/tracker/projects/{}/issues", key.trim().to_uppercase())
}

fn anchor(session: Option<&str>, ext_ref: Option<&str>) -> Option<String> {
    if let Some(s) = session.filter(|s| !s.trim().is_empty()) {
        Some(format!("session:{}", s.trim()))
    } else {
        ext_ref.filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string())
    }
}

// ---------------------------------------------------------------------------
// tracker_boards → GET /v1/tracker/projects
// ---------------------------------------------------------------------------

pub struct TrackerBoardsTool {
    api: HanzoApi,
}

impl TrackerBoardsTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "tracker_boards",
            "description": "List the work-item boards in your org. Returns [{id,org,key,name,description,createdAt,updatedAt}]. The `key` is what every other tracker tool takes — call this first when you do not know it. A board's issues are identified KEY-1, KEY-2, …",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        })
    }
}

impl Default for TrackerBoardsTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for TrackerBoardsTool {
    fn name(&self) -> &str {
        "tracker_boards"
    }
    fn description(&self) -> &str {
        "List the work-item boards in your org."
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, _params: Value) -> Result<ToolResult> {
        if let Some(err) = require_key(&self.api, "tracker_boards", "list") {
            return err;
        }
        let res = self.api.get("/v1/tracker/projects", &[]).await;
        respond("tracker_boards", "list", res)
    }
}

// ---------------------------------------------------------------------------
// tracker_issues → GET /v1/tracker/projects/{key}/issues
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct TrackerIssuesArgs {
    key: Option<String>,
    status: Option<String>,
    kind: Option<String>,
    source: Option<String>,
    repo: Option<String>,
}

pub struct TrackerIssuesTool {
    api: HanzoApi,
}

impl TrackerIssuesTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "tracker_issues",
            "description": "List a board's work items. Returns [{id,identifier,projectKey,number,kind,source,repo,extRef,title,description,status,priority,assignee,labels,createdAt,updatedAt}]. Filters are AND-ed and each is a closed set — an unknown value is refused rather than silently returning an empty board. Use source=agent to see only work agents opened; an item's extRef `session:<id>` names the agent session behind it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key, e.g. ENG (from tracker_boards)" },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "done", "canceled"], "description": "Board column" },
                    "kind": { "type": "string", "enum": ["issue", "pr", "epic"], "description": "What the item is" },
                    "source": { "type": "string", "enum": ["team", "git", "crm", "helpdesk", "cms", "agent"], "description": "Which surface opened it" },
                    "repo": { "type": "string", "description": "Only items bound to this git repository" }
                },
                "required": ["key"]
            }
        })
    }
}

impl Default for TrackerIssuesTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for TrackerIssuesTool {
    fn name(&self) -> &str {
        "tracker_issues"
    }
    fn description(&self) -> &str {
        "List a board's work items."
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: TrackerIssuesArgs = serde_json::from_value(params)?;
        let key = match args.key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(k) => k,
            None => return Ok(ToolResult::ok(envelope_err("tracker_issues", "list", "INVALID_ARGS", "key required"))),
        };

        if let Some(err) = require_key(&self.api, "tracker_issues", "list") {
            return err;
        }

        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(s) = args.status { query.push(("status", s)); }
        if let Some(k) = args.kind { query.push(("kind", k)); }
        if let Some(s) = args.source { query.push(("source", s)); }
        if let Some(r) = args.repo { query.push(("repo", r)); }

        let path = issues_path(key);
        let res = self.api.get(&path, &query).await;
        respond("tracker_issues", "list", res)
    }
}

// ---------------------------------------------------------------------------
// tracker_create → POST /v1/tracker/projects/{key}/issues
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct TrackerCreateArgs {
    key: Option<String>,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    assignee: Option<String>,
    labels: Option<Vec<String>>,
    kind: Option<String>,
    source: Option<String>,
    repo: Option<String>,
    session: Option<String>,
    #[serde(alias = "extRef")]
    ext_ref: Option<String>,
}

pub struct TrackerCreateTool {
    api: HanzoApi,
}

impl TrackerCreateTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "tracker_create",
            "description": "Open a work item on a board — this is how you put your work somewhere a human can see it. Returns the created issue including its identifier (KEY-N). `source` defaults to agent, because a work item opened through this tool WAS opened by an agent and the board filters on that. Pass `session` with your agent-session id to link the item to the run doing it; its live status then shows on the board.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key, e.g. ENG (from tracker_boards)" },
                    "title": { "type": "string", "description": "One line saying what needs doing" },
                    "description": { "type": "string", "description": "The detail behind the title" },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "done", "canceled"], "description": "Board column (default backlog)" },
                    "priority": { "type": "string", "enum": ["none", "urgent", "high", "medium", "low"], "description": "Default none" },
                    "assignee": { "type": "string", "description": "Who holds it" },
                    "labels": { "type": "array", "items": { "type": "string" }, "description": "Free-form tags" },
                    "kind": { "type": "string", "enum": ["issue", "pr", "epic"], "description": "What it is (default issue)" },
                    "source": { "type": "string", "enum": ["team", "git", "crm", "helpdesk", "cms", "agent"], "description": "Which surface opened it (default agent)" },
                    "repo": { "type": "string", "description": "Git repository this work belongs to" },
                    "session": { "type": "string", "description": "Agent-session id to link — stored as extRef `session:<id>`" },
                    "extRef": { "type": "string", "description": "Raw external anchor, when it is not a session (e.g. a PR branch)" }
                },
                "required": ["key", "title"]
            }
        })
    }
}

impl Default for TrackerCreateTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for TrackerCreateTool {
    fn name(&self) -> &str {
        "tracker_create"
    }
    fn description(&self) -> &str {
        "Open a work item on a board."
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: TrackerCreateArgs = serde_json::from_value(params)?;
        let key = match args.key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(k) => k,
            None => return Ok(ToolResult::ok(envelope_err("tracker_create", "create", "INVALID_ARGS", "key required"))),
        };
        let title = match args.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(t) => t,
            None => return Ok(ToolResult::ok(envelope_err("tracker_create", "create", "INVALID_ARGS", "title required"))),
        };

        if let Some(err) = require_key(&self.api, "tracker_create", "create") {
            return err;
        }

        let mut body = Map::new();
        body.insert("title".into(), json!(title));
        if let Some(d) = args.description { body.insert("description".into(), json!(d)); }
        if let Some(s) = args.status { body.insert("status".into(), json!(s)); }
        if let Some(p) = args.priority { body.insert("priority".into(), json!(p)); }
        if let Some(a) = args.assignee { body.insert("assignee".into(), json!(a)); }
        if let Some(l) = args.labels { body.insert("labels".into(), json!(l)); }
        body.insert("kind".into(), json!(args.kind.unwrap_or_else(|| "issue".into())));
        body.insert("source".into(), json!(args.source.unwrap_or_else(|| "agent".into())));
        if let Some(r) = args.repo { body.insert("repo".into(), json!(r)); }
        if let Some(anc) = anchor(args.session.as_deref(), args.ext_ref.as_deref()) {
            body.insert("extRef".into(), json!(anc));
        }

        let path = issues_path(key);
        let res = self.api.post(&path, Value::Object(body)).await;
        respond("tracker_create", "create", res)
    }
}

// ---------------------------------------------------------------------------
// tracker_update → PATCH /v1/tracker/projects/{key}/issues/{number}
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct TrackerUpdateArgs {
    key: Option<String>,
    number: Option<i64>,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    assignee: Option<String>,
    labels: Option<Vec<String>>,
    session: Option<String>,
    #[serde(alias = "extRef")]
    ext_ref: Option<String>,
}

pub struct TrackerUpdateTool {
    api: HanzoApi,
}

impl TrackerUpdateTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }
    pub fn schema() -> Value {
        json!({
            "name": "tracker_update",
            "description": "Update one work item by its board key and number (ENG-14 → key ENG, number 14). Only the fields you pass change. This is how an agent reports progress: move to in_progress when you start and done when you finish. Pass `session` to link (or relink) the item to the agent session doing the work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Board key, e.g. ENG" },
                    "number": { "type": "number", "description": "Issue number within the board — the 14 of ENG-14" },
                    "title": { "type": "string", "description": "New title" },
                    "description": { "type": "string", "description": "New description" },
                    "status": { "type": "string", "enum": ["backlog", "todo", "in_progress", "done", "canceled"], "description": "Move to this column" },
                    "priority": { "type": "string", "enum": ["none", "urgent", "high", "medium", "low"] },
                    "assignee": { "type": "string", "description": "Hand it to someone" },
                    "labels": { "type": "array", "items": { "type": "string" } },
                    "session": { "type": "string", "description": "Agent-session id to link — stored as extRef `session:<id>`" },
                    "extRef": { "type": "string", "description": "Raw external anchor, when it is not a session" }
                },
                "required": ["key", "number"]
            }
        })
    }
}

impl Default for TrackerUpdateTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for TrackerUpdateTool {
    fn name(&self) -> &str {
        "tracker_update"
    }
    fn description(&self) -> &str {
        "Update one work item by its board key and number."
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: TrackerUpdateArgs = serde_json::from_value(params)?;
        let key = match args.key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(k) => k,
            None => return Ok(ToolResult::ok(envelope_err("tracker_update", "update", "INVALID_ARGS", "key required"))),
        };
        let number = match args.number {
            Some(n) => n,
            None => return Ok(ToolResult::ok(envelope_err("tracker_update", "update", "INVALID_ARGS", "number required"))),
        };

        if let Some(err) = require_key(&self.api, "tracker_update", "update") {
            return err;
        }

        let mut body = Map::new();
        if let Some(t) = args.title { body.insert("title".into(), json!(t)); }
        if let Some(d) = args.description { body.insert("description".into(), json!(d)); }
        if let Some(s) = args.status { body.insert("status".into(), json!(s)); }
        if let Some(p) = args.priority { body.insert("priority".into(), json!(p)); }
        if let Some(a) = args.assignee { body.insert("assignee".into(), json!(a)); }
        if let Some(l) = args.labels { body.insert("labels".into(), json!(l)); }
        if let Some(anc) = anchor(args.session.as_deref(), args.ext_ref.as_deref()) {
            body.insert("extRef".into(), json!(anc));
        }

        if body.is_empty() {
            return Ok(ToolResult::ok(envelope_err(
                "tracker_update",
                "update",
                "INVALID_ARGS",
                "nothing to update — pass at least one field",
            )));
        }

        let path = format!("{}/{}", issues_path(key), number);
        let res = self.api.patch(&path, Value::Object(body)).await;
        respond("tracker_update", "update", res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tracker_schemas() {
        let boards = TrackerBoardsTool::schema();
        assert_eq!(boards["name"], "tracker_boards");

        let issues = TrackerIssuesTool::schema();
        assert_eq!(issues["name"], "tracker_issues");
        assert!(issues["inputSchema"]["required"].as_array().unwrap().contains(&json!("key")));

        let create = TrackerCreateTool::schema();
        assert_eq!(create["name"], "tracker_create");
        assert!(create["inputSchema"]["required"].as_array().unwrap().contains(&json!("title")));

        let update = TrackerUpdateTool::schema();
        assert_eq!(update["name"], "tracker_update");
        assert!(update["inputSchema"]["required"].as_array().unwrap().contains(&json!("number")));
    }

    #[test]
    fn test_anchor_formatting() {
        assert_eq!(anchor(Some("sess-123"), None), Some("session:sess-123".to_string()));
        assert_eq!(anchor(Some("sess-123"), Some("pr-456")), Some("session:sess-123".to_string()));
        assert_eq!(anchor(None, Some("pr-456")), Some("pr-456".to_string()));
        assert_eq!(anchor(None, None), None);
    }
}
