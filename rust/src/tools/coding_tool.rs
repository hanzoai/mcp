//! Coding runs — the Hanzo Cloud autonomous coding surface as one MCP tool.
//!
//! A run is a SESSION: give it a repository and a task, it works in its own
//! sandbox and pushes its own branch; a pull request is a step after, taken when
//! the work is ready. These are the
//! operations the API publishes for it, named by the verb a caller uses:
//!
//!   start      POST /v1/agent/coding                       → {sessionId, branch, repo}
//!   progress   GET  /v1/agent/sessions/{id}/progress       → {phase, pct, activity}
//!   changes    GET  /v1/agent/coding/{session}/changes     → commits, files, pull request
//!   artifacts  GET  /v1/agent/coding/{session}/artifacts   → what the run saved
//!   tree       GET  /v1/agent/coding/{session}/tree        → one directory of its repository
//!   blob       GET  /v1/agent/coding/{session}/blob        → one file of its repository
//!   steer      POST /v1/agent/coding/{session}/steer       → redirect it with new words
//!   merge      POST /v1/agent/coding/{session}/merge       → merge its pull request
//!   stop       POST /v1/agent/sessions/{id}/stop           → end it
//!
//! `api.hanzo.ai/v1/mcp` offers the same operations as `op`s of its `agent`
//! tool, under generated names. This is the same seam under the names a bot
//! reaches for: nothing here is a second API, and nothing is decided here —
//! every refusal is the server's own sentence.

use anyhow::Result;
use async_trait::async_trait;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{envelope_err, envelope_ok, refused};
use crate::hanzo_api::{HanzoApi, NO_KEY};
use crate::{MCPTool, ToolResult};

const TOOL: &str = "coding";

const ACTIONS: &[&str] = &[
    "start",
    "progress",
    "changes",
    "artifacts",
    "tree",
    "blob",
    "steer",
    "pull",
    "merge",
    "extend",
    "stop",
];

const DESCRIPTION: &str = "Autonomous coding runs on Hanzo Cloud: a repo and a task in, a pushed branch out; no pull request unless asked. \
start {repo, prompt} returns at once with {session, branch}; a run may take up to 4 hours. \
Then poll progress {session} until phase is done, error or stopped (queued = waiting for a sandbox; running = working). \
Read changes {session} for the commits and the files with patches. \
To keep going, start again with after=<session>: it adds to the SAME branch, and a task longer than one run is a chain of these. \
A run that runs out of time keeps its work; continue it with after. A task longer than one run is a chain of these. \
Review, then pull {session} when the work is ready: it opens the pull request for the pushed branch with no agent run (optional title, body, base, draft) and answers {number, url}; asking twice answers the same one. \
(start with pull=true opens it when that run finishes.) merge {session} merges the pull request. \
branch names the branch (agent/<name>); a name that exists is built on. \
steer {session, text} redirects a live run; extend {session, seconds} gives a working run more time before it is ended for time (a run is held to its timeoutSeconds); stop {session} ends it; artifacts, tree, blob read what it left. \
mode build (default) edits and pushes, plan only reads and answers with a plan.";

/// One request, decided before anything is sent: the same value the tests read
/// and `execute` sends, so what is pinned is what goes on the wire.
#[derive(Debug, PartialEq)]
struct Request {
    method: Method,
    path: String,
    query: Vec<(&'static str, String)>,
    body: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
struct CodingArgs {
    action: Option<String>,

    // The run.
    #[serde(alias = "id", alias = "sessionId", alias = "session_id")]
    session: Option<String>,

    // start
    repo: Option<String>,
    #[serde(alias = "task")]
    prompt: Option<String>,
    base: Option<String>,
    after: Option<String>,
    branch: Option<String>,
    pull: Option<bool>,
    // pull
    title: Option<String>,
    body: Option<String>,
    draft: Option<bool>,
    // extend
    seconds: Option<i64>,
    mode: Option<String>,
    tool: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    #[serde(alias = "timeout_seconds")]
    #[serde(rename = "timeoutSeconds")]
    timeout_seconds: Option<u64>,
    issue: Option<u64>,
    project: Option<String>,
    desktop: Option<bool>,
    #[serde(alias = "agent_ref")]
    #[serde(rename = "agentRef")]
    agent_ref: Option<String>,
    #[serde(alias = "target_id")]
    #[serde(rename = "targetId")]
    target_id: Option<String>,

    // steer, stop
    #[serde(alias = "message")]
    text: Option<String>,

    // tree, blob
    path: Option<String>,
}

fn said(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// A session id as one path segment. Ids are opaque to a caller, so anything
/// that could leave the segment — a slash, a dot-dot, a space — is refused here
/// rather than quoted: a run is named by what the server minted, nothing else.
fn session_of(args: &CodingArgs) -> std::result::Result<&str, String> {
    let s = said(&args.session).ok_or("session required: the id start returned")?;
    let clean = s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        && !s.chars().all(|c| c == '.');
    if clean {
        Ok(s)
    } else {
        Err(format!("session {s:?} is not a session id"))
    }
}

fn plan(args: &CodingArgs) -> std::result::Result<(String, Request), String> {
    let action = args.action.as_deref().unwrap_or("").trim().to_lowercase();
    let request = match action.as_str() {
        "start" => {
            let prompt = said(&args.prompt)
                .ok_or("prompt required: the task, in the words you would use with a colleague")?;
            let mut body = Map::new();
            body.insert("prompt".into(), json!(prompt));
            for (key, v) in [
                ("repo", said(&args.repo)),
                ("base", said(&args.base)),
                ("after", said(&args.after)),
                ("branch", said(&args.branch)),
                ("mode", said(&args.mode)),
                ("tool", said(&args.tool)),
                ("model", said(&args.model)),
                ("effort", said(&args.effort)),
                ("project", said(&args.project)),
                ("agentRef", said(&args.agent_ref)),
                ("targetId", said(&args.target_id)),
            ] {
                if let Some(v) = v {
                    body.insert(key.into(), json!(v));
                }
            }
            if let Some(n) = args.timeout_seconds {
                body.insert("timeoutSeconds".into(), json!(n));
            }
            if let Some(n) = args.issue {
                body.insert("issue".into(), json!(n));
            }
            if let Some(d) = args.desktop {
                body.insert("desktop".into(), json!(d));
            }
            if let Some(p) = args.pull {
                body.insert("pull".into(), json!(p));
            }
            Request {
                method: Method::POST,
                path: "/v1/agent/coding".into(),
                query: vec![],
                body: Some(Value::Object(body)),
            }
        }
        "progress" => Request {
            method: Method::GET,
            path: format!("/v1/agent/sessions/{}/progress", session_of(args)?),
            query: vec![],
            body: None,
        },
        "stop" => {
            let mut body = Map::new();
            if let Some(m) = said(&args.text) {
                body.insert("message".into(), json!(m));
            }
            Request {
                method: Method::POST,
                path: format!("/v1/agent/sessions/{}/stop", session_of(args)?),
                query: vec![],
                body: Some(Value::Object(body)),
            }
        }
        "changes" | "artifacts" => Request {
            method: Method::GET,
            path: format!("/v1/agent/coding/{}/{}", session_of(args)?, action),
            query: vec![],
            body: None,
        },
        "tree" | "blob" => {
            let mut query = Vec::new();
            if let Some(p) = said(&args.path) {
                query.push(("path", p.to_string()));
            }
            Request {
                method: Method::GET,
                path: format!("/v1/agent/coding/{}/{}", session_of(args)?, action),
                query,
                body: None,
            }
        }
        "steer" => {
            let text = said(&args.text).ok_or("text required: the new instruction for the run")?;
            Request {
                method: Method::POST,
                path: format!("/v1/agent/coding/{}/steer", session_of(args)?),
                query: vec![],
                body: Some(json!({ "text": text })),
            }
        }
        "pull" => {
            let mut body = Map::new();
            for (key, v) in [
                ("title", said(&args.title)),
                ("body", said(&args.body)),
                ("base", said(&args.base)),
            ] {
                if let Some(v) = v {
                    body.insert(key.into(), json!(v));
                }
            }
            if let Some(d) = args.draft {
                body.insert("draft".into(), json!(d));
            }
            Request {
                method: Method::POST,
                path: format!("/v1/agent/coding/{}/pull", session_of(args)?),
                query: vec![],
                body: Some(Value::Object(body)),
            }
        }
        "extend" => {
            let seconds = args
                .seconds
                .filter(|s| *s > 0)
                .ok_or("seconds required: how much longer the run may work, above zero")?;
            Request {
                method: Method::POST,
                path: format!("/v1/agent/coding/{}/extend", session_of(args)?),
                query: vec![],
                body: Some(json!({ "seconds": seconds })),
            }
        }
        "merge" => Request {
            method: Method::POST,
            path: format!("/v1/agent/coding/{}/merge", session_of(args)?),
            query: vec![],
            body: None,
        },
        "" => return Err(format!("action required: one of {}", ACTIONS.join(", "))),
        other => {
            return Err(format!(
                "unknown action {other:?}: one of {}",
                ACTIONS.join(", ")
            ))
        }
    };
    Ok((action, request))
}

pub struct CodingTool {
    api: HanzoApi,
}

impl CodingTool {
    pub fn new() -> Self {
        Self {
            api: HanzoApi::from_env(),
        }
    }

    pub fn schema() -> Value {
        json!({
            "name": TOOL,
            "description": DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ACTIONS, "description": "What to do with a run" },
                    "session": { "type": "string", "description": "The run's id: the session start returned. Every action but start takes it" },
                    "repo": { "type": "string", "description": "start: what to work on — a repository name, owner/name, or the site it serves" },
                    "prompt": { "type": "string", "description": "start: the task. Name the files and the outcome you want; this is the whole instruction" },
                    "after": { "type": "string", "description": "start: continue the run with this session id: the new run adds to the same branch" },
                    "branch": { "type": "string", "description": "start: the branch to write, as a plain name; it lives under agent/. A name that already exists is built on, not replaced" },
                    "pull": { "type": "boolean", "description": "start: open a pull request for what the run pushed. Default false: push the branch and stop, then set this on the run that finishes the work" },
                    "base": { "type": "string", "description": "start: the branch to start from. The run never writes it; it writes its own branch" },
                    "mode": { "type": "string", "enum": ["build", "plan", "setup"], "description": "start: build edits, commits and pushes (default); plan only reads and answers with a plan; setup works out how to run the codebase" },
                    "tool": { "type": "string", "enum": ["dev", "claude", "codex", "python", "node"], "description": "start: the harness that runs the prompt (default dev)" },
                    "model": { "type": "string", "description": "start: the model, by id from GET /v1/models. Empty takes the platform's coding model" },
                    "effort": { "type": "string", "enum": ["low", "medium", "high"], "description": "start: how hard the model reasons" },
                    "timeoutSeconds": { "type": "integer", "description": "start: bounds the whole run. Default and most is 14400 (4 hours, as long as the run's model credential lasts); at the bound the run keeps its work, and after=<session> carries on" },
                    "title": { "type": "string", "description": "pull: the pull request's title. Empty takes one from the run's task" },
                    "body": { "type": "string", "description": "pull: its description. Empty says who it is for, the task and the branch" },
                    "draft": { "type": "boolean", "description": "pull: open it as a draft" },
                    "seconds": { "type": "integer", "description": "extend: how much to add to the time the run has left, up to the longest a run may be given; the answer says when it is up now" },
                    "issue": { "type": "integer", "description": "start: the issue number on repo this run resolves; its pull request (when pull is set) closes it" },
                    "project": { "type": "string", "description": "start: the board's project, when the org keeps more than one" },
                    "desktop": { "type": "boolean", "description": "start: give the run a screen, for a task that drives a browser" },
                    "agentRef": { "type": "string", "description": "start: a configured agent to run as" },
                    "targetId": { "type": "string", "description": "start: a machine the org registered, instead of a cloud sandbox" },
                    "text": { "type": "string", "description": "steer: the new instruction. stop: why (recorded as the reason)" },
                    "path": { "type": "string", "description": "tree: the directory (empty is the root). blob: the file" }
                },
                "required": ["action"]
            }
        })
    }
}

impl Default for CodingTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for CodingTool {
    fn name(&self) -> &str {
        TOOL
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: CodingArgs = serde_json::from_value(params).unwrap_or_default();
        let (action, request) = match plan(&args) {
            Ok(planned) => planned,
            Err(message) => {
                let action = args.action.as_deref().unwrap_or("").trim().to_lowercase();
                return Ok(ToolResult::ok(envelope_err(
                    TOOL,
                    &action,
                    "INVALID_ARGS",
                    message,
                )));
            }
        };
        if !self.api.has_key() {
            return Ok(ToolResult::ok(envelope_err(
                TOOL,
                &action,
                "NO_API_KEY",
                NO_KEY,
            )));
        }

        // `call`, not `get`: a refusal — a 402 for money, a 404 for a run that is
        // not yours, a 503 for a full pool — must read as an error, never as an
        // empty success a bot would poll for ever.
        let query: Vec<String> = request
            .query
            .iter()
            .map(|(k, v)| format!("{k}={}", encode(v)))
            .collect();
        let path = if query.is_empty() {
            request.path
        } else {
            format!("{}?{}", request.path, query.join("&"))
        };
        Ok(
            match self
                .api
                .call(request.method, &path, request.body, &[])
                .await
            {
                Ok(answer) => {
                    let mut data = answer.body;
                    // The handle every later action takes is called `session` here; the
                    // server's start answer calls it `sessionId`. Say it under both.
                    if action == "start" {
                        if let Some(id) = data.get("sessionId").cloned() {
                            data["session"] = id;
                        }
                    }
                    ToolResult::ok(envelope_ok(TOOL, &action, data))
                }
                Err(e) => refused(TOOL, &action, &e).unwrap_or_else(|| {
                    ToolResult::ok(envelope_err(TOOL, &action, "UPSTREAM", e.to_string()))
                }),
            },
        )
    }
}

/// A query value, percent-encoded: a path in a repository holds slashes, spaces
/// and whatever else a file is called.
fn encode(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> CodingArgs {
        serde_json::from_value(v).unwrap()
    }

    fn planned(v: Value) -> std::result::Result<Request, String> {
        plan(&args(v)).map(|(_, r)| r)
    }

    #[test]
    fn every_action_the_schema_names_plans_a_request() {
        let schema = CodingTool::schema();
        let named: Vec<&str> = schema["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        assert_eq!(named, ACTIONS);
        for action in ACTIONS {
            let got = planned(
                json!({ "action": action, "session": "ses-1", "prompt": "x", "text": "x", "seconds": 60 }),
            );
            assert!(got.is_ok(), "{action}: {got:?}");
        }
    }

    #[test]
    fn start_sends_only_what_was_said() {
        let r = planned(json!({
            "action": "start", "repo": "hanzoai/social", "task": "fix the footer", "after": "ses-0",
            "timeout_seconds": 3600, "mode": "plan", "base": "  "
        }))
        .unwrap();
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::POST, "/v1/agent/coding")
        );
        assert_eq!(
            r.body.unwrap(),
            json!({ "prompt": "fix the footer", "repo": "hanzoai/social", "after": "ses-0", "mode": "plan", "timeoutSeconds": 3600 })
        );
    }

    #[test]
    fn extend_gives_a_working_run_more_seconds_and_needs_them() {
        let r = planned(json!({ "action": "extend", "session": "ses-1", "seconds": 300 })).unwrap();
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::POST, "/v1/agent/coding/ses-1/extend")
        );
        assert_eq!(r.body.unwrap(), json!({ "seconds": 300 }));
        for bad in [json!({ "action": "extend", "session": "ses-1" }), json!({ "action": "extend", "session": "ses-1", "seconds": 0 })] {
            assert!(planned(bad).is_err(), "an extension of nothing was sent");
        }
    }

    #[test]
    fn a_pull_request_and_a_branch_are_asked_for_by_name_and_never_by_default() {
        let r =
            planned(json!({ "action": "start", "repo": "hanzoai/social", "prompt": "x" })).unwrap();
        assert!(
            r.body.unwrap().get("pull").is_none(),
            "a start that did not ask for a pull request sent one"
        );
        let r = planned(json!({
            "action": "start", "repo": "hanzoai/social", "prompt": "x", "after": "ses-0",
            "branch": " fix-header ", "pull": true
        }))
        .unwrap();
        let body = r.body.unwrap();
        assert_eq!(body["branch"], "fix-header");
        assert_eq!(body["pull"], true);
        assert_eq!(body["after"], "ses-0");
        let r = planned(json!({ "action": "start", "repo": "a", "prompt": "x", "pull": false }))
            .unwrap();
        assert_eq!(r.body.unwrap()["pull"], false);
    }

    #[test]
    fn a_pull_request_is_opened_with_only_what_was_said() {
        let r = planned(json!({ "action": "pull", "session": "ses-3" })).unwrap();
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::POST, "/v1/agent/coding/ses-3/pull")
        );
        assert_eq!(r.body.unwrap(), json!({}));
        let r = planned(json!({
            "action": "pull", "session": "ses-3", "title": " Header ", "body": "Ready.", "base": "develop", "draft": true
        }))
        .unwrap();
        assert_eq!(
            r.body.unwrap(),
            json!({ "title": "Header", "body": "Ready.", "base": "develop", "draft": true })
        );
        assert!(planned(json!({ "action": "pull", "session": "../x" })).is_err());
        assert!(planned(json!({ "action": "pull" })).is_err());
    }

    #[test]
    fn a_run_is_read_and_ended_at_its_own_paths() {
        let at = |action: &str| planned(json!({ "action": action, "id": "ses-9" })).unwrap();
        assert_eq!(at("progress").path, "/v1/agent/sessions/ses-9/progress");
        assert_eq!(at("stop").path, "/v1/agent/sessions/ses-9/stop");
        assert_eq!(at("changes").path, "/v1/agent/coding/ses-9/changes");
        assert_eq!(at("artifacts").path, "/v1/agent/coding/ses-9/artifacts");
        let merge = at("merge");
        assert_eq!(
            (merge.method, merge.path.as_str(), merge.body),
            (Method::POST, "/v1/agent/coding/ses-9/merge", None)
        );
    }

    #[test]
    fn steer_and_stop_carry_their_words() {
        let steer =
            planned(json!({ "action": "steer", "session": "s", "message": "also add tests" }))
                .unwrap();
        assert_eq!(steer.body.unwrap(), json!({ "text": "also add tests" }));
        let stop =
            planned(json!({ "action": "stop", "session": "s", "text": "wrong repo" })).unwrap();
        assert_eq!(stop.body.unwrap(), json!({ "message": "wrong repo" }));
    }

    #[test]
    fn a_missing_word_is_named_not_guessed() {
        assert!(planned(json!({ "action": "start", "repo": "a/b" }))
            .unwrap_err()
            .starts_with("prompt required"));
        assert!(planned(json!({ "action": "progress" }))
            .unwrap_err()
            .starts_with("session required"));
        assert!(planned(json!({ "action": "steer", "session": "s" }))
            .unwrap_err()
            .starts_with("text required"));
        assert!(planned(json!({}))
            .unwrap_err()
            .starts_with("action required"));
        assert!(planned(json!({ "action": "delete", "session": "s" }))
            .unwrap_err()
            .starts_with("unknown action"));
    }

    #[test]
    fn a_session_cannot_leave_its_path_segment() {
        for bad in ["../x", "a/b", "..", ".", "a b", "a?b", "a#b"] {
            let got = planned(json!({ "action": "changes", "session": bad }));
            assert!(got.is_err(), "{bad:?} planned {got:?}");
        }
        assert!(planned(json!({ "action": "changes", "session": "coding_01.ab:c-d" })).is_ok());
    }

    #[test]
    fn a_repository_path_is_encoded_in_the_query() {
        assert_eq!(encode("src/a b&c.rs"), "src/a%20b%26c.rs");
    }
}
