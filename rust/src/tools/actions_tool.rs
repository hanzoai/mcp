//! `kai` — Kai Actions: run a request as a saved, typed, verified action.
//!
//! One tool, action-routed. The executor is the `actions` module of this crate: it matches the
//! request to an action or workflow by trigger, binds its inputs from the request and from values
//! read out of the repository (asking Kai only when several remain, and Kai may abstain), checks the
//! preconditions again just before it runs, and leaves a ledger record with the verifier's verdict.
//! Kai never writes a command. A request nothing fits is declined: the caller's own agent takes it.
//!
//! Authorization is not a match. An action that writes outside the workspace, reaches a remote or
//! stops a process runs only when the call says `approve: true`; without it the result is a
//! `declined` outcome that names the reason, and the caller asks the user, then calls again.
//!
//! The schema is `schema/kai.json` of the repository, the same file the TypeScript runtime loads.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;

use super::{envelope_err, envelope_ok};
use crate::actions::bind::Config;
use crate::actions::run::{plan_report, Grant, Refuse};
use crate::actions::{catalog, perform, workflow, Approver, Chooser, Engine, Kai, Store};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const SCHEMA: &str = include_str!("../../schema/kai.json");
const ACTIONS: &[&str] = &["run", "plan", "list", "triggers"];

pub struct ActionsTool {
    api: HanzoApi,
}

impl ActionsTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }

    /// The tool as MCP lists it: `{name, description, inputSchema}`.
    pub fn schema() -> Value {
        serde_json::from_str(SCHEMA).unwrap_or(Value::Null)
    }
}

impl Default for ActionsTool {
    fn default() -> Self {
        Self::new()
    }
}

fn text<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn number(p: &Value, k: &str) -> Option<f64> {
    p.get(k).and_then(Value::as_f64)
}

/// Runs one action of the tool. Blocking: called from `spawn_blocking`.
fn call(api: &HanzoApi, action: &str, p: &Value) -> Result<Value, String> {
    match action {
        "list" => {
            let actions: Vec<Value> = catalog::all()
                .iter()
                .map(|a| {
                    let s = a.spec();
                    json!({ "id": s.id, "version": s.version, "summary": s.summary, "effect": s.effect, "inputs": s.inputs.iter().map(|i| i.name).collect::<Vec<_>>() })
                })
                .collect();
            let workflows: Vec<Value> = workflow::all()
                .iter()
                .map(|w| json!({ "id": w.id, "version": w.version, "summary": w.summary, "steps": w.parts.iter().map(|x| x.action).collect::<Vec<_>>() }))
                .collect();
            Ok(json!({ "actions": actions, "workflows": workflows }))
        }
        "triggers" => {
            let request = text(p, "request").ok_or("request required")?;
            let ids: Vec<&str> = crate::actions::triggered(request).iter().map(crate::actions::bind::Target::id).collect();
            Ok(json!({ "triggered": ids }))
        }
        _ => {
            let request = text(p, "request").ok_or("request required")?;
            let cwd = text(p, "cwd").map(PathBuf::from).or_else(|| std::env::current_dir().ok()).ok_or("cwd required")?;
            // The key goes to the configured API alone: a call never names where it is sent.
            let url = format!("{}/v1", api.base_url().trim_end_matches('/'));
            let kai = (p.get("ask").and_then(Value::as_bool) != Some(false)).then(|| Kai::new(&url, text(p, "model").unwrap_or("kai"), api.key()));
            let store = text(p, "cache").map(PathBuf::from).map(|d| Store::open(&d)).transpose()?;
            let mut cfg = Config::default();
            if let Some(v) = number(p, "min_margin") {
                cfg.min_margin = v;
            }
            if let Some(v) = number(p, "min_p") {
                cfg.min_p = v;
            }
            if let Some(v) = number(p, "max_abstain") {
                cfg.max_abstain = v;
            }
            let approver: &dyn Approver = if p.get("approve").and_then(Value::as_bool) == Some(true) { &Grant } else { &Refuse };
            let engine = Engine {
                chooser: kai.as_ref().map(|k| k as &dyn Chooser),
                cache: store.as_ref(),
                approver,
                cfg,
                prove: p.get("prove").and_then(Value::as_bool) == Some(true),
            };
            if action == "plan" {
                return Ok(plan_report(&engine, &cwd, request));
            }
            serde_json::to_value(perform(&engine, &cwd, request)).map_err(|e| e.to_string())
        }
    }
}

#[async_trait]
impl MCPTool for ActionsTool {
    fn name(&self) -> &str {
        "kai"
    }
    fn description(&self) -> &str {
        "Kai Actions: run a request as a saved, typed, verified action, with no model call when one fits"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params.get("action").and_then(Value::as_str).unwrap_or("run").to_string();
        if !ACTIONS.contains(&action.as_str()) {
            return Ok(ToolResult::ok(envelope_err("kai", &action, "INVALID_ARGS", format!("action must be one of {}", ACTIONS.join(", ")))));
        }
        let api = self.api.clone();
        let p = params.clone();
        let a = action.clone();
        let out = tokio::task::spawn_blocking(move || call(&api, &a, &p)).await?;
        Ok(match out {
            Ok(data) => ToolResult::ok(envelope_ok("kai", &action, data)),
            Err(e) => ToolResult::ok(envelope_err("kai", &action, "INVALID_ARGS", e)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_is_the_one_in_the_repository_and_names_every_action() {
        let s = ActionsTool::schema();
        assert_eq!(s["name"], "kai");
        let actions: Vec<&str> = s["inputSchema"]["properties"]["action"]["enum"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        assert_eq!(actions, ACTIONS);
        // The canonical copy sits one level above the crate in a checkout; the TypeScript runtime loads it.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../schema/kai.json");
        if let Ok(canonical) = std::fs::read_to_string(root) {
            assert_eq!(serde_json::from_str::<Value>(&canonical).ok(), Some(s));
        }
    }

    #[tokio::test]
    async fn a_request_that_needs_approval_is_declined_until_the_call_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("ws");
        let run = |args: &[&str]| {
            let ok = std::process::Command::new(args[0]).args(&args[1..]).current_dir(dir.path()).output().map(|o| o.status.success()).unwrap_or(false);
            assert!(ok, "{args:?}");
        };
        std::fs::create_dir_all(&ws).unwrap();
        run(&["git", "init", "-q", "--bare", "remote.git"]);
        run(&["git", "init", "-q", "-b", "main", "ws"]);
        let sh = |args: &[&str]| {
            let ok = std::process::Command::new(args[0]).args(&args[1..]).current_dir(&ws).output().map(|o| o.status.success()).unwrap_or(false);
            assert!(ok, "{args:?}");
        };
        sh(&["git", "config", "user.email", "a@b"]);
        sh(&["git", "config", "user.name", "a"]);
        std::fs::write(ws.join("a.txt"), "1\n").unwrap();
        sh(&["git", "add", "-A"]);
        sh(&["git", "commit", "-q", "-m", "first"]);
        sh(&["git", "remote", "add", "origin", "../remote.git"]);
        sh(&["git", "push", "-q", "origin", "main"]);
        std::fs::write(ws.join("a.txt"), "2\n").unwrap();
        let tool = ActionsTool::new();
        // A proving workspace, so the only thing between the request and the push is the approval.
        let ask = json!({ "request": "Commit `a.txt` with the message \"Two\" and push to origin `main`", "cwd": ws, "ask": false, "prove": true });
        let refused = tool.execute(ask.clone()).await.unwrap();
        assert_eq!(refused.content["data"]["outcome"]["kind"], "declined", "{}", refused.content);
        let why = refused.content["data"]["outcome"]["why"].as_str().unwrap_or_default();
        assert!(why.contains("approval") || why.contains("remote"), "declined for another reason: {why}");
        let head = |repo: &std::path::Path| String::from_utf8(std::process::Command::new("git").args(["rev-parse", "main"]).current_dir(repo).output().unwrap().stdout).unwrap();
        let before = head(&dir.path().join("remote.git"));
        let mut granted = ask;
        granted["approve"] = json!(true);
        let done = tool.execute(granted).await.unwrap();
        assert_eq!(done.content["data"]["outcome"]["kind"], "done", "{}", done.content);
        assert_eq!(done.content["data"]["records"][0]["authorization"]["granted"], true);
        assert_ne!(head(&dir.path().join("remote.git")), before, "the push reached the remote only with the approval");
        assert_eq!(head(&ws), head(&dir.path().join("remote.git")));
    }

    #[tokio::test]
    async fn an_unknown_action_is_named() {
        let r = ActionsTool::new().execute(json!({ "action": "fly" })).await.unwrap();
        assert_eq!(r.content["error"]["code"], "INVALID_ARGS");
    }
}
