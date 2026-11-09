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

//! - team             -> api.hanzo.ai        (/team/*)
//! - api              -> api.hanzo.ai        (generic method/path/body bridge)
//!
//! Mirrors the Python `hanzo` surface (hanzo-tools-api) and the ten service
//! HTTP clients (hanzo-tools-{iam,kms,paas,billing,commerce,ingress,mpc,team}).
//! Credential is `HanzoApi`'s: `HANZO_API_KEY`, else the `hanzo` login's token,
//! else `~/.hanzo/config.json` field `apiKey`. A call may name the identity it
//! acts as (`as`) and the org it acts in (`org`, sent as `X-Org-Id`); the `auth`
//! actions say who is acting and choose among the logins the CLI holds.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::{self, Credential, HanzoApi, Source};

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
    /// Act as this login identity (`owner` or `owner/name`) for this call.
    #[serde(rename = "as")]
    pub who: Option<String>,
    /// Act in this org: sent as `X-Org-Id`. An operation's own `org` parameter
    /// goes inside `args`.
    pub org: Option<String>,
    /// The identity `auth use` and `auth switch` take.
    pub identity: Option<String>,
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
            "description": "Hanzo platform router: api, auth, billing, commerce, iam, ingress, kms, mpc, paas, team. Call with no service to list; with service and no action to list its actions. auth: whoami, list, use (this process), switch (the CLI, everywhere).",
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
                    "as": { "type": "string", "description": "Act as this login identity for this call: owner or owner/name (see auth list)" },
                    "org": { "type": "string", "description": "Act in this org for this call (sent as X-Org-Id; the gateway honours it for members)" },
                    "identity": { "type": "string", "description": "auth use / switch: the identity, owner or owner/name" },
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

pub struct HanzoTool {
    client: reqwest::Client,
    api: HanzoApi,
    /// Where `/v1/mcp` is: `HANZO_API_URL`, else api.hanzo.ai.
    base: String,
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
            api: HanzoApi::from_env(),
            base: std::env::var("HANZO_API_URL").unwrap_or_else(|_| "https://api.hanzo.ai".into()),
        }
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
            return Ok(self.auth(&action, &args));
        }

        let org = args.org.as_deref().map(str::trim).filter(|o| !o.is_empty());
        if let Some(o) = org {
            if !org_ok(o) {
                return Ok(need(&action, "org: a slug (letters, digits, . _ -)"));
            }
        }

        // Every networked service needs the bearer; fail fast and clearly.
        let cred = match self.api.credential(args.who.as_deref()) {
            Ok(c) => c,
            Err(why) => return Ok(envelope_err("hanzo", &action, "NOT_AUTHENTICATED", why)),
        };

        let routed = self.ask(&service, &action, &p, &cred, org).await;

        Ok(match routed {
            Ok(v) => v,
            Err(e) => envelope_err("hanzo", &action, "UPSTREAM", e.to_string()),
        })
    }

    // -- auth (local) --------------------------------------------------------

    fn auth(&self, action: &str, args: &HanzoToolArgs) -> Value {
        let named = args.identity.as_deref().map(str::trim).filter(|i| !i.is_empty());
        match action {
            "status" | "whoami" => envelope_ok("hanzo", action, self.whoami(args.who.as_deref())),
            "list" => match self.api.identities() {
                Ok(rows) => envelope_ok(
                    "hanzo",
                    action,
                    json!({
                        "identities": rows,
                        "active": rows.iter().find(|r| r["active"] == true).map(|r| r["key"].clone()),
                        "using": hanzo_api::using(),
                    }),
                ),
                Err(why) => envelope_err("hanzo", action, "NOT_AUTHENTICATED", why),
            },
            "use" => {
                let Some(id) = named else {
                    hanzo_api::set_using(None);
                    return envelope_ok(
                        "hanzo",
                        action,
                        json!({ "using": null, "scope": "this MCP process only", "message": "This process acts as the hanzo CLI's active identity again." }),
                    );
                };
                // Held, or the CLI's sentence: never an identity this process cannot speak as.
                if let Err(why) = self.api.credential(Some(id)) {
                    return envelope_err("hanzo", action, "NOT_AUTHENTICATED", why);
                }
                hanzo_api::set_using(Some(id.to_string()));
                let mut who = self.whoami(None);
                who["scope"] = json!("this MCP process only");
                who["message"] = json!(format!("This MCP process now acts as {id}. The hanzo CLI's active identity is unchanged."));
                envelope_ok("hanzo", action, who)
            }
            "switch" => {
                let Some(id) = named else {
                    return need(action, "identity (owner or owner/name)");
                };
                match self.api.switch(id) {
                    Ok(said) => {
                        let mut who = self.whoami(None);
                        who["scope"] = json!("global");
                        who["message"] = json!(format!(
                            "The hanzo CLI's active identity is now {id}. This is global: every Hanzo tool and session on this machine acts as {id} from now on.{}",
                            hanzo_api::using().filter(|u| u != id).map(|u| format!(" This MCP process still acts as {u} (auth use with no identity clears that).")).unwrap_or_default()
                        ));
                        who["cli"] = json!(said);
                        envelope_ok("hanzo", action, who)
                    }
                    Err(why) => envelope_err("hanzo", action, "NOT_AUTHENTICATED", why),
                }
            }
            "logout" | "refresh" => envelope_ok(
                "hanzo",
                action,
                json!({ "message": "Manage credentials with the `hanzo` CLI (`hanzo login` / `hanzo logout`)." }),
            ),
            _ => envelope_err(
                "hanzo",
                action,
                "UNKNOWN_ACTION",
                "auth actions: whoami, status, list, use, switch, logout, refresh",
            ),
        }
    }

    /// Who is acting, and how that was decided. Never a token: a key is its prefix.
    fn whoami(&self, who: Option<&str>) -> Value {
        let using = hanzo_api::using();
        let Credential { source, token, named, skipped } = match self.api.credential(who) {
            Ok(c) => c,
            Err(why) => {
                return json!({ "authenticated": false, "source": null, "using": using, "message": why });
            }
        };
        let mut out = json!({ "authenticated": true, "source": source.name(), "using": using });
        if source != Source::Login {
            out["key"] = json!(hanzo_api::key_prefix(&token));
            if let Some(why) = skipped {
                out["login"] = json!(why);
            }
            return out;
        }
        let claims = hanzo_api::claims(&token).unwrap_or(Value::Null);
        let claim = |k: &str| claims[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        // The key the CLI files it under: the one named, else its active row, else the claims'.
        let identity = named.clone().or_else(|| {
            let rows = self.api.identities().ok()?;
            rows.iter().find(|r| r["active"] == true).and_then(|r| r["key"].as_str().map(str::to_string))
        });
        let identity = identity.or_else(|| Some(format!("{}/{}", claim("owner")?, claim("name")?)));
        out["identity"] = json!(identity);
        out["email"] = json!(claim("email"));
        out["name"] = json!(claim("displayName").or_else(|| claim("name")));
        out["org"] = json!(claim("owner"));
        out["orgs"] = claims.get("orgs").cloned().unwrap_or_else(|| json!([]));
        out
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
    async fn ask(&self, service: &str, action: &str, p: &Map<String, Value>, cred: &Credential, org: Option<&str>) -> Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": service, "arguments": { "op": action, "input": Value::Object(p.clone()) } },
        });
        let mut req = self.client.post(format!("{}/v1/mcp", self.base)).json(&body).bearer_auth(&cred.token);
        if let Some(org) = org {
            req = req.header("X-Org-Id", org);
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

/// An org slug, as it is sent in a header.
fn org_ok(org: &str) -> bool {
    org.len() <= 64 && org.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
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


    // -- who is acting ----------------------------------------------------------

    /// `auth use` is the process's, so the tests that read or set it take turns.
    static TURNS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn jwt(claims: &Value) -> String {
        use base64::Engine;
        let enc = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        format!("{}.{}.signature", enc(&json!({"alg": "RS256"})), enc(claims))
    }

    /// A `hanzo` beside the binary that holds two identities, the active one being hanzo/z.
    #[cfg(unix)]
    fn cli(dir: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let token = |name: &str| jwt(&json!({"owner": "hanzo", "name": name, "email": format!("{name}@hanzo.ai"), "displayName": name.to_uppercase(),
            "orgs": [{"org": "hanzo", "role": "admin"}, {"org": "lux", "role": "member"}]}));
        let body = format!(
            r#"#!/bin/sh
case "$*" in
  "auth token") echo {z} ;;
  "auth token --as hanzo/a") echo {a} ;;
  "auth token --as hanzo/z") echo {z} ;;
  "auth token --as "*) echo "no stored identity for $4" >&2; exit 1 ;;
  "auth list -o json") echo '[{{"key":"hanzo/a","owner":"hanzo","active":false}},{{"key":"hanzo/z","owner":"hanzo","active":true}}]' ;;
  "auth switch hanzo/"[az]) echo "Switched to $3" ;;
  *) echo "unknown" >&2; exit 2 ;;
esac
"#,
            z = token("z"),
            a = token("a")
        );
        let path = dir.join("hanzo");
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn tool(base: &str, env: Option<&str>, home: &std::path::Path, beside: &std::path::Path) -> HanzoTool {
        HanzoTool {
            client: reqwest::Client::new(),
            api: HanzoApi::with("https://api.hanzo.ai".into(), env.map(str::to_string), Some(home), Some(beside)),
            base: base.to_string(),
        }
    }

    async fn auth(t: &HanzoTool, action: &str, identity: Option<&str>) -> Value {
        t.execute(HanzoToolArgs {
            resource: Some("auth".into()),
            action: Some(action.into()),
            identity: identity.map(str::to_string),
            ..Default::default()
        })
        .await
        .unwrap()
    }

    /// The first request a local server receives, answered with an empty success.
    async fn serve() -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if body.len() >= len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = r#"{"result":{"content":[]}}"#;
            sock.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
            String::from_utf8_lossy(&raw).to_string()
        });
        (base, seen)
    }

    fn call(args: Value) -> HanzoToolArgs {
        serde_json::from_value(args).unwrap()
    }

    /// `as` picks the identity whose token rides as the bearer, and `org` rides as
    /// `X-Org-Id` without entering the operation's input.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_call_may_name_its_identity_and_its_org() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let (base, seen) = serve().await;
        let t = tool(&base, Some("sk-env"), home.path(), bin.path());
        let r = t.execute(call(json!({"resource": "iam", "action": "get_iam_users", "as": "hanzo/a", "org": "lux"}))).await.unwrap();
        assert_eq!(r["ok"], true, "{r}");
        let raw = seen.await.unwrap().to_lowercase();
        let a = jwt(&json!({"owner": "hanzo", "name": "a", "email": "a@hanzo.ai", "displayName": "A",
            "orgs": [{"org": "hanzo", "role": "admin"}, {"org": "lux", "role": "member"}]}));
        assert!(raw.contains(&format!("authorization: bearer {}", a.to_lowercase())), "the named identity's token is the bearer, not the env key");
        assert!(raw.contains("x-org-id: lux"), "{raw}");
        assert!(!raw.contains("\"org\""), "org is the header, not input: {raw}");
        assert!(raw.contains("\"op\":\"get_iam_users\""), "{raw}");
    }

    /// Without `as` or `org`, the env key rides and no org header is sent.
    #[cfg(unix)]
    #[tokio::test]
    async fn without_them_the_key_rides_alone() {
        let _turn = TURNS.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let (base, seen) = serve().await;
        let t = tool(&base, Some("sk-env"), home.path(), bin.path());
        let r = t.execute(call(json!({"resource": "iam", "action": "get_iam_users"}))).await.unwrap();
        assert_eq!(r["ok"], true, "{r}");
        let raw = seen.await.unwrap().to_lowercase();
        assert!(raw.contains("authorization: bearer sk-env"), "{raw}");
        assert!(!raw.contains("x-org-id"), "{raw}");
    }

    /// An identity the CLI does not hold, or an org that is not a slug, is refused before any request.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_bad_identity_or_org_is_refused_before_the_network() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let t = tool("http://127.0.0.1:1", Some("sk-env"), home.path(), bin.path());
        let r = t.execute(call(json!({"resource": "iam", "action": "x", "as": "nobody"}))).await.unwrap();
        assert_eq!((r["ok"].as_bool(), r["error"]["code"].as_str()), (Some(false), Some("NOT_AUTHENTICATED")));
        assert!(r["error"]["message"].as_str().unwrap().contains("no stored identity for nobody"), "{r}");
        let r = t.execute(call(json!({"resource": "iam", "action": "x", "org": "a b\r\nx: y"}))).await.unwrap();
        assert_eq!(r["error"]["code"], "INVALID_ARGS");
    }

    /// whoami names the source, the identity, the person and the orgs, and holds no token.
    #[cfg(unix)]
    #[tokio::test]
    async fn whoami_says_who_and_never_the_token() {
        let _turn = TURNS.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());

        let r = auth(&tool("http://127.0.0.1:1", None, home.path(), bin.path()), "whoami", None).await;
        let d = &r["data"];
        assert_eq!((d["source"].as_str(), d["identity"].as_str(), d["email"].as_str(), d["name"].as_str(), d["org"].as_str()), (Some("login"), Some("hanzo/z"), Some("z@hanzo.ai"), Some("Z"), Some("hanzo")));
        assert_eq!(d["orgs"], json!([{"org": "hanzo", "role": "admin"}, {"org": "lux", "role": "member"}]));
        assert!(d["using"].is_null());
        let wrote = r.to_string();
        assert!(!wrote.contains("eyJ") && !wrote.contains("signature"), "no token in {wrote}");

        // An env key: its prefix and nothing of the rest.
        let r = auth(&tool("http://127.0.0.1:1", Some("sk-secretvalue"), home.path(), bin.path()), "whoami", None).await;
        assert_eq!((r["data"]["source"].as_str(), r["data"]["key"].as_str()), (Some("env"), Some("sk-…")));
        assert!(!r.to_string().contains("secretvalue"));

        // A stored key, and why the login did not answer.
        let bare = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(bare.path().join(".hanzo")).unwrap();
        std::fs::write(bare.path().join(".hanzo").join("config.json"), r#"{"apiKey":"sk-legacyvalue"}"#).unwrap();
        let none = tempfile::tempdir().unwrap();
        let r = auth(&tool("http://127.0.0.1:1", None, bare.path(), none.path()), "whoami", None).await;
        assert_eq!((r["data"]["source"].as_str(), r["data"]["key"].as_str()), (Some("stored"), Some("sk-…")));
        assert!(r["data"]["login"].as_str().unwrap().contains("no `hanzo` CLI"));
        assert!(!r.to_string().contains("legacyvalue"));

        // Nothing at all.
        let r = auth(&tool("http://127.0.0.1:1", None, none.path(), none.path()), "whoami", None).await;
        assert_eq!((r["ok"].as_bool(), r["data"]["authenticated"].as_bool()), (Some(true), Some(false)));
    }

    /// list is the CLI's rows; use is this process's; switch is the CLI's, and says it is global.
    #[cfg(unix)]
    #[tokio::test]
    async fn list_use_and_switch() {
        let _turn = TURNS.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let t = tool("http://127.0.0.1:1", None, home.path(), bin.path());

        let r = auth(&t, "list", None).await;
        assert_eq!(r["data"]["active"], "hanzo/z");
        assert_eq!(r["data"]["identities"].as_array().unwrap().len(), 2);

        let r = auth(&t, "use", Some("hanzo/a")).await;
        assert_eq!((r["data"]["identity"].as_str(), r["data"]["name"].as_str(), r["data"]["using"].as_str()), (Some("hanzo/a"), Some("A"), Some("hanzo/a")));
        assert_eq!(r["data"]["scope"], "this MCP process only");
        assert!(r["data"]["message"].as_str().unwrap().contains("CLI's active identity is unchanged"));
        // Every later call in this process now acts as it, without saying so.
        assert_eq!(auth(&t, "whoami", None).await["data"]["identity"], "hanzo/a");

        let r = auth(&t, "use", Some("nobody")).await;
        assert_eq!(r["error"]["code"], "NOT_AUTHENTICATED");
        assert_eq!(auth(&t, "whoami", None).await["data"]["identity"], "hanzo/a", "a refused use changes nothing");

        let r = auth(&t, "switch", Some("hanzo/z")).await;
        assert_eq!(r["data"]["scope"], "global");
        let said = r["data"]["message"].as_str().unwrap();
        assert!(said.contains("global") && said.contains("every Hanzo tool and session on this machine"), "{said}");
        assert!(said.contains("still acts as hanzo/a"), "this process kept its own choice: {said}");
        let said = auth(&t, "switch", Some("hanzo/a")).await["data"]["message"].as_str().unwrap().to_string();
        assert!(!said.contains("still acts"), "nothing to add when they agree: {said}");
        assert_eq!(auth(&t, "switch", None).await["error"]["code"], "INVALID_ARGS");

        let r = auth(&t, "use", None).await;
        assert!(r["data"]["using"].is_null());
        assert!(hanzo_api::using().is_none());
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
