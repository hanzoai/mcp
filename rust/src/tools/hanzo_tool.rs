//! Unified Hanzo platform tool (HIP-0300).
//!
//! One tool for the Platform axis. `service` + `action` two-level routing
//! dispatches to the live platform services over plain HTTP (reqwest):
//!
//! - iam, auth        -> hanzo.id            (/v1/iam/*)
//! - kms              -> kms.hanzo.ai        (/v1/secrets/*)
//! - paas, ingress,   -> platform.hanzo.ai   (/v1/*)
//!   mpc
//! - billing          -> api.hanzo.ai        (/v1/billing/*)
//! - commerce         -> api.hanzo.ai        (/api/v1/*)
//! - team             -> api.hanzo.ai        (/team/*)
//! - api              -> api.hanzo.ai        (generic method/path/body bridge)
//!
//! Mirrors the Python `hanzo` surface (hanzo-tools-api) and the ten service
//! HTTP clients (hanzo-tools-{iam,kms,paas,billing,commerce,ingress,mpc,team}).
//! Credential is the shared `pk-`/`sk-` bearer resolved the same way as
//! `HanzoApi` (`HANZO_API_KEY`, else `~/.hanzo/config.json` field `apiKey`).

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::api_key_from_config_json;

/// `auth` is answered locally from credential state; every other name comes from
/// the generated catalog, so this list cannot describe an API that has moved.
fn services() -> Vec<&'static str> {
    let mut v = vec!["auth"];
    v.extend(crate::catalog::services());
    v.sort_unstable();
    v
}

fn serves(service: &str) -> bool {
    service == "auth" || crate::catalog::serves(service)
}

/// resolve_service normalises spelling only. It no longer renames: the aliases it
/// carried pointed at the OLD names (platform -> paas, store -> commerce), so
/// they mapped a caller off the surface the fleet actually serves.
fn resolve_service(raw: &str) -> String {
    raw.trim().to_lowercase().replace('-', "_")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HanzoToolArgs {
    /// Target service (aliases: `service`). Empty lists services.
    #[serde(alias = "service")]
    pub resource: Option<String>,
    /// Service-specific action.
    pub action: Option<String>,
    /// Service-specific parameter bag (alias: `data`). Merged with any
    /// top-level params, matching the Python `args` JSON object.
    #[serde(alias = "data")]
    pub args: Option<Value>,
    // Common typed conveniences so direct calls need no nested object.
    pub id: Option<String>,
    pub query: Option<String>,
    /// Generic `api` bridge: HTTP method / path / body.
    pub method: Option<String>,
    pub path: Option<String>,
    pub body: Option<Value>,
    /// Any other top-level params (owner, project, environment, ...).
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl HanzoToolArgs {
    /// Collapse the parameter bag: extra top-level keys, then the `args`
    /// object, then the explicit typed conveniences (last wins).
    fn params(&self) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in &self.extra {
            m.insert(k.clone(), v.clone());
        }
        if let Some(Value::Object(o)) = &self.args {
            for (k, v) in o {
                m.insert(k.clone(), v.clone());
            }
        }
        if let Some(v) = &self.id {
            m.insert("id".into(), json!(v));
        }
        if let Some(v) = &self.query {
            m.insert("query".into(), json!(v));
        }
        if let Some(v) = &self.path {
            m.insert("path".into(), json!(v));
        }
        if let Some(v) = &self.method {
            m.insert("method".into(), json!(v));
        }
        if let Some(v) = &self.body {
            m.insert("body".into(), v.clone());
        }
        m
    }
}

fn pstr(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Null => None,
        Value::String(_) => None,
        other => Some(other.to_string()),
    })
}

pub struct HanzoToolDefinition;

impl HanzoToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "hanzo",
            "description": "Hanzo platform router: api, auth, billing, commerce, iam, ingress, kms, mpc, paas, team. Call with no service to list; with service and no action to list its actions.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "resource": {
                        "type": "string",
                        "enum": services(),
                        "description": "Target platform service (alias: service)"
                    },
                    "action": { "type": "string", "description": "Service action" },
                    "args": { "type": "object", "description": "Service-specific parameters (alias: data)" },
                    "id": { "type": "string" },
                    "query": { "type": "string" },
                    "method": { "type": "string", "description": "HTTP method for the generic api bridge" },
                    "path": { "type": "string", "description": "Path for the generic api bridge" },
                    "body": { "type": "object" }
                },
                "required": []
            }
        })
    }
}

/// Per-service base URL, honoring the same env overrides as the Python clients.

/// Resolve the shared bearer: `HANZO_API_KEY`, else `~/.hanzo/config.json`.
fn resolve_key() -> Option<String> {
    if let Ok(k) = std::env::var("HANZO_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    let path = dirs::home_dir()?.join(".hanzo").join("config.json");
    let content = std::fs::read_to_string(path).ok()?;
    api_key_from_config_json(&content)
}

pub struct HanzoTool {
    client: reqwest::Client,
    key: Option<String>,
}

impl Default for HanzoTool {
    fn default() -> Self {
        Self::new()
    }
}

impl HanzoTool {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            key: resolve_key(),
        }
    }

    fn has_key(&self) -> bool {
        self.key.as_deref().map_or(false, |k| !k.is_empty())
    }

    pub async fn execute(&self, args: HanzoToolArgs) -> Result<Value> {
        let service = match &args.resource {
            None => {
                return Ok(json!({
                    "ok": true,
                    "data": {
                        "services": services(),
                        "hint": "Call hanzo(resource=\"iam\") to see that service's actions"
                    },
                    "error": null,
                    "meta": { "tool": "hanzo", "action": "list" }
                }));
            }
            Some(r) => resolve_service(r),
        };

        if service == "services" || service == "list" {
            return Ok(json!({
                "ok": true,
                "data": { "services": services() },
                "error": null,
                "meta": { "tool": "hanzo", "action": "list" }
            }));
        }

        if !serves(&service) {
            return Ok(envelope_err(
                "hanzo",
                "route",
                "UNKNOWN_SERVICE",
                format!("Unknown service: {}. Available: {}", service, services().join(", ")),
            ));
        }

        let action = match &args.action {
            Some(a) if !a.trim().is_empty() => a.clone(),
            _ => {
                return Ok(json!({
                    "ok": true,
                    "data": {
                        "service": service,
                        "actions": actions_for(&service),
                        "hint": format!("Call hanzo(resource=\"{}\", action=\"<action>\")", service)
                    },
                    "error": null,
                    "meta": { "tool": "hanzo", "action": "help" }
                }));
            }
        };

        let p = args.params();

        // `auth` is answered locally from credential state (no network).
        if service == "auth" {
            return Ok(self.auth(&action));
        }

        // Every networked service needs the bearer; fail fast and clearly.
        if !self.has_key() {
            return Ok(envelope_err(
                "hanzo",
                &action,
                "NOT_AUTHENTICATED",
                crate::hanzo_api::NO_KEY,
            ));
        }

        let routed = self.ask(&service, &action, &p).await;

        Ok(match routed {
            Ok(v) => v,
            Err(e) => envelope_err("hanzo", &action, "UPSTREAM", e.to_string()),
        })
    }

    // -- auth (local) --------------------------------------------------------

    fn auth(&self, action: &str) -> Value {
        match action {
            "status" | "whoami" => envelope_ok(
                "hanzo",
                action,
                json!({
                    "authenticated": self.has_key(),
                    "credential": if self.has_key() { "pk-/sk- bearer" } else { "none" },
                    "message": if self.has_key() {
                        "Authenticated via an API key."
                    } else {
                        "Not authenticated. Run `hanzo login` or set HANZO_API_KEY."
                    }
                }),
            ),
            "logout" | "refresh" => envelope_ok(
                "hanzo",
                action,
                json!({ "message": "Manage credentials with the `hanzo` CLI (`hanzo login` / `hanzo logout`)." }),
            ),
            _ => envelope_err(
                "hanzo",
                action,
                "UNKNOWN_ACTION",
                "auth actions: status, whoami, logout, refresh",
            ),
        }
    }

    // -- the fleet ------------------------------------------------------------

    /// call hands one operation to the fleet and returns what it answered.
    ///
    /// There is one address and one request shape, because the fleet already
    /// routes: naming a subsystem and an operation is the whole of what a caller
    /// decides. What this replaced was nine hand-written routers over four hosts,
    /// which had drifted from the API they described — `paas` had become
    /// `platform`, `storage` had become `s3`, and `iam` carried 97 operations
    /// against the handful reachable here.
    async fn ask(&self, service: &str, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": service, "arguments": { "op": action, "input": Value::Object(p.clone()) } },
        });
        let base = std::env::var("HANZO_API_URL").unwrap_or_else(|_| "https://api.hanzo.ai".into());
        let mut req = self.client.post(format!("{base}/v1/mcp")).json(&body);
        if let Some(k) = &self.key {
            req = req.bearer_auth(k);
        }
        let text = req.send().await?.text().await?;
        let answer: Value = serde_json::from_str(&text)
            .unwrap_or_else(|_| json!({ "error": { "message": text } }));

        // A refusal is the fleet declining, and it is reported as one. Folding it
        // into a success whose body happens to say it failed is a refusal the
        // caller cannot see, which is worse than no answer because it is acted on.
        if let Some(e) = answer.get("error") {
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("refused").to_string();
            return Ok(envelope_err("hanzo", action, "REFUSED", msg));
        }
        let result = answer.get("result").cloned().unwrap_or(answer);
        if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
            let msg = result
                .get("content")
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|f| f.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("refused")
                .to_string();
            return Ok(envelope_err("hanzo", action, "REFUSED", msg));
        }
        Ok(envelope_ok("hanzo", action, result))
    }

}

/// actions_for names a subsystem's operations, read from the generated catalog
/// rather than listed here — a subsystem that gains an operation gains it the
/// day the catalog is regenerated.
fn actions_for(service: &str) -> Vec<&'static str> {
    crate::catalog::actions(service)
}

fn need(action: &str, required: &str) -> Value {
    envelope_err("hanzo", action, "INVALID_ARGS", format!("Required: {}", required))
}

fn unknown(action: &str, available: &[&str]) -> Value {
    envelope_err(
        "hanzo",
        action,
        "UNKNOWN_ACTION",
        format!("Unknown action: {}. Available: {}", action, available.join(", ")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_hanzo_list_resources() {
        let tool = HanzoTool::new();
        let result = tool.execute(HanzoToolArgs::default()).await.unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["data"]["services"].is_array());
    }

    #[tokio::test]
    async fn test_hanzo_resource_help() {
        let tool = HanzoTool::new();
        let result = tool
            .execute(HanzoToolArgs {
                resource: Some("iam".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["data"]["actions"].is_array());
    }

    #[tokio::test]
    async fn a_subsystem_is_named_as_the_fleet_names_it() {
        // The fleet's name is `iam`; `identity` was a second name for it. One
        // name, so an alias is not offered and does not resolve.
        let tool = HanzoTool::new();
        let named = tool
            .execute(HanzoToolArgs { resource: Some("iam".to_string()), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(named["data"]["service"], "iam");

        let aliased = tool
            .execute(HanzoToolArgs { resource: Some("identity".to_string()), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(aliased["ok"], false);
        assert_eq!(aliased["error"]["code"], "UNKNOWN_SERVICE");
    }

    #[tokio::test]
    async fn test_unknown_service() {
        let tool = HanzoTool::new();
        let result = tool
            .execute(HanzoToolArgs {
                resource: Some("nope".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], "UNKNOWN_SERVICE");
    }

    #[tokio::test]
    async fn test_auth_status_is_local() {
        let tool = HanzoTool::new();
        let result = tool
            .execute(HanzoToolArgs {
                resource: Some("auth".to_string()),
                action: Some("status".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["data"]["authenticated"].is_boolean());
    }


    #[test]
    fn the_services_are_the_fleets() {
        // What this tool offers is what cloud generated, not a list kept here.
        let s = services();
        assert!(s.contains(&"iam"), "iam is served");
        assert!(s.contains(&"platform"), "platform is the name paas became");
        assert!(!s.contains(&"paas"), "paas is the name the fleet left behind");
        assert!(s.contains(&"auth"), "auth is answered locally and stays");
        assert!(s.len() > 100, "expected the fleet, got {}", s.len());
    }

    #[test]
    fn an_action_is_the_fleets_operation() {
        assert!(actions_for("iam").contains(&"get_iam_users"));
        // Withheld once, in cloud, and absent here because of it.
        assert!(!actions_for("iam").contains(&"post_iam_users"));
    }

    #[test]
    fn a_retired_alias_no_longer_redirects() {
        // These aliases pointed at the OLD names, so they mapped a caller off the
        // surface the fleet serves. Spelling is normalised; nothing is renamed.
        assert_eq!(resolve_service(" Platform "), "platform");
        assert_eq!(resolve_service("zero-trust"), "zero_trust");
    }
}
