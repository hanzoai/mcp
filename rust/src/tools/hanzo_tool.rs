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

const SERVICES: &[&str] = &[
    "api", "auth", "billing", "commerce", "iam", "ingress", "kms", "mpc", "paas", "team",
];

/// Aliases accepted for `service` — one canonical name, several ergonomic spellings.
fn resolve_service(raw: &str) -> String {
    let key = raw.trim().to_lowercase().replace('-', "_");
    match key.as_str() {
        "platform" => "paas",
        "identity" => "iam",
        "payments" => "billing",
        "store" => "commerce",
        other => other,
    }
    .to_string()
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
                        "enum": SERVICES,
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
fn base_url(service: &str) -> String {
    fn env(var: &str, default: &str) -> String {
        std::env::var(var)
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default.to_string())
    }
    match service {
        "iam" | "auth" => env("IAM_URL", "https://hanzo.id"),
        "kms" => env("HANZO_KMS_URL", "https://kms.hanzo.ai"),
        "paas" | "ingress" | "mpc" => env("HANZO_PAAS_URL", "https://platform.hanzo.ai"),
        "billing" => env("HANZO_BILLING_API_URL", "https://api.hanzo.ai/v1/billing"),
        "commerce" => env("HANZO_COMMERCE_API_URL", "https://api.hanzo.ai/api/v1"),
        "team" => env("HANZO_TEAM_URL", "https://api.hanzo.ai/team"),
        _ => env("HANZO_API_BASE", "https://api.hanzo.ai"),
    }
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

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

    /// One HTTP request to `service`'s base, path appended, bearer attached.
    async fn call(
        &self,
        service: &str,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<Value> {
        let url = join(&base_url(service), path);
        let verb = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut req = self.client.request(verb, url);
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        if let Some(k) = &self.key {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        let parsed = serde_json::from_str::<Value>(&text).ok();
        if !status.is_success() {
            // RFC 9457 `detail`, else the envelope `msg`, else `title`, else the body.
            let why = parsed
                .as_ref()
                .and_then(|v| {
                    ["detail", "msg", "title"]
                        .iter()
                        .find_map(|k| v.get(*k).and_then(Value::as_str))
                        .filter(|s| !s.is_empty())
                })
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(300).collect());
            anyhow::bail!("{} {}: {}", status.as_u16(), path, why);
        }
        Ok(parsed.unwrap_or_else(|| json!({ "status": status.as_u16(), "body": text })))
    }

    pub async fn execute(&self, args: HanzoToolArgs) -> Result<Value> {
        let service = match &args.resource {
            None => {
                return Ok(json!({
                    "ok": true,
                    "data": {
                        "services": SERVICES,
                        "aliases": { "platform": "paas", "identity": "iam", "payments": "billing", "store": "commerce" },
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
                "data": { "services": SERVICES },
                "error": null,
                "meta": { "tool": "hanzo", "action": "list" }
            }));
        }

        if !SERVICES.contains(&service.as_str()) {
            return Ok(envelope_err(
                "hanzo",
                "route",
                "UNKNOWN_SERVICE",
                format!("Unknown service: {}. Available: {}", service, SERVICES.join(", ")),
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

        let routed = match service.as_str() {
            "iam" => self.iam(&action, &p).await,
            "kms" => self.kms(&action, &p).await,
            "paas" => self.paas(&action, &p).await,
            "ingress" => self.ingress(&action, &p).await,
            "mpc" => self.mpc(&action, &p).await,
            "billing" => self.billing(&action, &p).await,
            "commerce" => self.commerce(&action, &p).await,
            "team" => self.team(&action, &p).await,
            "api" => self.api(&action, &p).await,
            _ => unreachable!(),
        };

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

    // -- iam (hanzo.id /v1/iam) ---------------------------------------------

    async fn iam(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let id = pstr(p, "id");
        // Scope follows the caller: name an owner only when the caller names one,
        // and the server resolves the rest from the credential.
        let owner = pstr(p, "owner");
        let scope: Vec<(String, String)> =
            owner.iter().map(|o| ("owner".to_string(), o.clone())).collect();
        let with = |keys: &[&str]| {
            let mut q = scope.clone();
            for k in keys {
                if let Some(v) = pstr(p, k) {
                    q.push(((*k).to_string(), v));
                }
            }
            q
        };
        match action {
            "users" => ok(self
                .call("iam", "GET", "/v1/iam/users", &with(&["email", "limit", "offset"]), None)
                .await?),
            "user" => match row("users", id.as_deref()) {
                Some(path) => ok(self.call("iam", "GET", &path, &[], None).await?),
                None => Ok(need(action, "id as owner/name")),
            },
            "create_user" => {
                let (Some(owner), Some(name), Some(email)) =
                    (owner.clone(), pstr(p, "name"), pstr(p, "email"))
                else {
                    return Ok(need(action, "owner, name, email"));
                };
                let display = pstr(p, "display_name").unwrap_or_else(|| name.clone());
                let mut body = json!({
                    "user": { "owner": owner, "name": name, "email": email, "displayName": display }
                });
                if let Some(pw) = pstr(p, "password") {
                    body["password"] = json!(pw);
                }
                ok(self.call("iam", "POST", "/v1/iam/users", &[], Some(body)).await?)
            }
            "update_user" => {
                let Some(path) = row("users", id.as_deref()) else {
                    return Ok(need(action, "id as owner/name"));
                };
                let Value::Object(mut user) = self.call("iam", "GET", &path, &[], None).await? else {
                    return Ok(envelope_err("hanzo", action, "UPSTREAM", "user record is not an object"));
                };
                for k in ["name", "email", "display_name"] {
                    if let Some(v) = pstr(p, k) {
                        let field = if k == "display_name" { "displayName" } else { k };
                        user.insert(field.into(), json!(v));
                    }
                }
                ok(self.call("iam", "PUT", &path, &[], Some(json!({ "user": user }))).await?)
            }
            "delete_user" => match row("users", id.as_deref()) {
                Some(path) => ok(self.call("iam", "DELETE", &path, &[], None).await?),
                None => Ok(need(action, "id as owner/name")),
            },
            "orgs" => {
                let mut q = Vec::new();
                if let Some(v) = pstr(p, "q").or_else(|| pstr(p, "query")) {
                    q.push(("q".to_string(), v));
                }
                for k in ["limit", "cursor"] {
                    if let Some(v) = pstr(p, k) {
                        q.push((k.to_string(), v));
                    }
                }
                ok(self.call("iam", "GET", "/v1/iam/organizations", &q, None).await?)
            }
            "org" => match row("organizations", id.as_deref()) {
                Some(path) => ok(self.call("iam", "GET", &path, &[], None).await?),
                None => Ok(need(action, "id as owner/name")),
            },
            "roles" => ok(self.call("iam", "GET", "/v1/iam/roles", &scope, None).await?),
            "role" => match row("roles", id.as_deref()) {
                Some(path) => ok(self.call("iam", "GET", &path, &[], None).await?),
                None => Ok(need(action, "id as owner/name")),
            },
            "permissions" => ok(self.call("iam", "GET", "/v1/iam/permissions", &scope, None).await?),
            "providers" => ok(self.call("iam", "GET", "/v1/iam/providers", &scope, None).await?),
            // Applications are listed one owner at a time; ask rather than guess.
            "apps" => {
                if owner.is_none() {
                    return Ok(need(action, "owner"));
                }
                ok(self.call("iam", "GET", "/v1/iam/applications", &scope, None).await?)
            }
            "tokens" => ok(self
                .call("iam", "GET", "/v1/iam/tokens", &with(&["organization"]), None)
                .await?),
            "sessions" => ok(self
                .call("iam", "GET", "/v1/iam/sessions", &with(&["name", "application"]), None)
                .await?),
            "invitations" => ok(self.call("iam", "GET", "/v1/iam/invitations", &scope, None).await?),
            "invite" => {
                let (Some(owner), Some(email)) = (owner.clone(), pstr(p, "email")) else {
                    return Ok(need(action, "owner, email"));
                };
                let mut invitation = json!({
                    "owner": owner,
                    "name": email.replace('@', "-at-").replace('.', "-"),
                    "email": email,
                });
                if let Some(org) = pstr(p, "org").or_else(|| pstr(p, "organization")) {
                    invitation["organization"] = json!(org);
                }
                ok(self.call("iam", "POST", "/v1/iam/invitations", &[], Some(invitation)).await?)
            }
            "records" => ok(self.call("iam", "GET", "/v1/iam/audit-logs", &scope, None).await?),
            _ => Ok(unknown(action, IAM_ACTIONS)),
        }
    }

    // -- kms (kms.hanzo.ai /v1/secrets) -------------------------------------

    async fn kms(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let (project, env) = (pstr(p, "project"), pstr(p, "environment"));
        let path = pstr(p, "path").unwrap_or_else(|| "/".to_string());
        let scope = |extra: Vec<(String, String)>| {
            let mut q = vec![("path".into(), path.clone())];
            if let Some(pr) = &project {
                q.push(("project".into(), pr.clone()));
            }
            if let Some(e) = &env {
                q.push(("environment".into(), e.clone()));
            }
            q.extend(extra);
            q
        };
        match action {
            "list" | "inject" => {
                if project.is_none() || env.is_none() {
                    return Ok(need(action, "project, environment"));
                }
                ok(self.call("kms", "GET", "/v1/secrets", &scope(vec![]), None).await?)
            }
            "get" => {
                let Some(name) = pstr(p, "secret_name") else {
                    return Ok(need(action, "project, environment, secret_name"));
                };
                if project.is_none() || env.is_none() {
                    return Ok(need(action, "project, environment, secret_name"));
                }
                ok(self.call("kms", "GET", &format!("/v1/secrets/{}", name), &scope(vec![]), None).await?)
            }
            "set" => {
                let (name, value) = (pstr(p, "secret_name"), pstr(p, "secret_value"));
                let (Some(name), Some(value)) = (name, value) else {
                    return Ok(need(action, "project, environment, secret_name, secret_value"));
                };
                if project.is_none() || env.is_none() {
                    return Ok(need(action, "project, environment, secret_name, secret_value"));
                }
                let body = json!({
                    "project": project.clone(), "environment": env.clone(), "path": path.clone(),
                    "secretName": name, "secretValue": value,
                });
                ok(self.call("kms", "POST", "/v1/secrets", &[], Some(body)).await?)
            }
            "delete" => {
                let Some(name) = pstr(p, "secret_name") else {
                    return Ok(need(action, "project, environment, secret_name"));
                };
                if project.is_none() || env.is_none() {
                    return Ok(need(action, "project, environment, secret_name"));
                }
                ok(self.call("kms", "DELETE", &format!("/v1/secrets/{}", name), &scope(vec![]), None).await?)
            }
            _ => Ok(unknown(action, &["list", "get", "set", "delete", "inject"])),
        }
    }

    // -- paas (platform.hanzo.ai /v1) ---------------------------------------

    async fn paas(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let (org, project, env, container) = (
            pstr(p, "org"),
            pstr(p, "project"),
            pstr(p, "environment"),
            pstr(p, "container"),
        );
        match action {
            "whoami" => Ok(self.auth("whoami")),
            "projects" => match org {
                Some(org) => ok(self.call("paas", "GET", &format!("/v1/org/{}/project", org), &[], None).await?),
                None => Ok(need(action, "org")),
            },
            "env" => match (org, project) {
                (Some(org), Some(project)) => ok(self
                    .call("paas", "GET", &format!("/v1/org/{}/project/{}/env", org, project), &[], None)
                    .await?),
                _ => Ok(need(action, "org, project")),
            },
            "deployments" => match (org, project, env) {
                (Some(org), Some(project), Some(env)) => ok(self
                    .call("paas", "GET", &format!("/v1/org/{}/project/{}/env/{}/container", org, project, env), &[], None)
                    .await?),
                _ => Ok(need(action, "org, project, environment")),
            },
            "deploy" | "logs" => match (org, project, env, container) {
                (Some(org), Some(project), Some(env), Some(container)) => {
                    let mut path = format!("/v1/org/{}/project/{}/env/{}/container/{}", org, project, env, container);
                    if action == "logs" {
                        path.push_str("/logs");
                    }
                    ok(self.call("paas", "GET", &path, &[], None).await?)
                }
                _ => Ok(need(action, "org, project, environment, container")),
            },
            "redeploy" => match (org, project, env, container) {
                (Some(org), Some(project), Some(env), Some(container)) => {
                    let path = format!("/v1/org/{}/project/{}/env/{}/container/{}", org, project, env, container);
                    let current = self.call("paas", "GET", &path, &[], None).await?;
                    ok(self.call("paas", "PUT", &path, &[], Some(current)).await?)
                }
                _ => Ok(need(action, "org, project, environment, container")),
            },
            "services" => {
                let info = self.call("paas", "GET", "/v1/cluster/info", &[], None).await?;
                let templates = self.call("paas", "GET", "/v1/cluster/templates", &[], None).await?;
                ok(json!({ "cluster": info, "templates": templates }))
            }
            _ => Ok(unknown(action, PAAS_ACTIONS)),
        }
    }

    // -- ingress (platform.hanzo.ai /v1/ingress + domains) ------------------

    async fn ingress(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let (project, domain) = (pstr(p, "project_id"), pstr(p, "domain"));
        match action {
            "routers" => ok(self.call("ingress", "GET", "/v1/ingress/http/routers", &[], None).await?),
            "services" => ok(self.call("ingress", "GET", "/v1/ingress/http/services", &[], None).await?),
            "middlewares" => ok(self.call("ingress", "GET", "/v1/ingress/http/middlewares", &[], None).await?),
            "entrypoints" => ok(self.call("ingress", "GET", "/v1/ingress/entrypoints", &[], None).await?),
            "overview" => ok(self.call("ingress", "GET", "/v1/ingress/overview", &[], None).await?),
            "tcp_routers" => ok(self.call("ingress", "GET", "/v1/ingress/tcp/routers", &[], None).await?),
            "domains" => match project {
                Some(project) => ok(self.call("ingress", "GET", &format!("/v1/project/{}/domain", project), &[], None).await?),
                None => Ok(need(action, "project_id")),
            },
            "add_domain" => match (project, domain) {
                (Some(project), Some(domain)) => ok(self
                    .call("ingress", "POST", &format!("/v1/project/{}/domain", project), &[], Some(json!({ "domain": domain })))
                    .await?),
                _ => Ok(need(action, "project_id, domain")),
            },
            "remove_domain" => match (project, domain) {
                (Some(project), Some(domain)) => ok(self
                    .call("ingress", "DELETE", &format!("/v1/project/{}/domain/{}", project, domain), &[], None)
                    .await?),
                _ => Ok(need(action, "project_id, domain")),
            },
            "verify_domain" => match (project, domain) {
                (Some(project), Some(domain)) => ok(self
                    .call("ingress", "POST", &format!("/v1/project/{}/domain/{}/verify", project, domain), &[], None)
                    .await?),
                _ => Ok(need(action, "project_id, domain")),
            },
            "tls_status" => match domain {
                Some(domain) => ok(self.call("ingress", "GET", &format!("/v1/domain/{}/tls", domain), &[], None).await?),
                None => Ok(need(action, "domain")),
            },
            _ => Ok(unknown(action, &[
                "routers", "services", "middlewares", "entrypoints", "overview", "tcp_routers",
                "domains", "add_domain", "remove_domain", "verify_domain", "tls_status",
            ])),
        }
    }

    // -- mpc (platform.hanzo.ai /v1/mpc) ------------------------------------

    async fn mpc_get(&self, path: &str) -> Result<Value> {
        self.call("mpc", "GET", &format!("/v1/mpc{}", path), &[], None).await
    }

    async fn mpc_post(&self, path: &str, body: Value) -> Result<Value> {
        self.call("mpc", "POST", &format!("/v1/mpc{}", path), &[], Some(body)).await
    }

    async fn mpc(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        match action {
            "status" => ok(self.mpc_get("/status").await?),
            "vaults" => ok(self.mpc_get("/vaults").await?),
            "vault" => match pstr(p, "vault_id") {
                Some(id) => ok(self.mpc_get(&format!("/vaults/{}", id)).await?),
                None => Ok(need(action, "vault_id")),
            },
            "create_vault" => match pstr(p, "name") {
                Some(name) => {
                    let mut body = json!({ "name": name });
                    if let Some(d) = pstr(p, "description") {
                        body["description"] = json!(d);
                    }
                    ok(self.mpc_post("/vaults", body).await?)
                }
                None => Ok(need(action, "name")),
            },
            "wallets" => match pstr(p, "vault_id") {
                Some(id) => ok(self.mpc_get(&format!("/vaults/{}/wallets", id)).await?),
                None => Ok(need(action, "vault_id")),
            },
            "wallet" => match pstr(p, "wallet_id") {
                Some(id) => ok(self.mpc_get(&format!("/wallets/{}", id)).await?),
                None => Ok(need(action, "wallet_id")),
            },
            "create_wallet" => {
                let (vault, name) = (pstr(p, "vault_id"), pstr(p, "name"));
                let (Some(vault), Some(name)) = (vault, name) else {
                    return Ok(need(action, "vault_id, name"));
                };
                let mut body = json!({ "name": name });
                if let Some(c) = pstr(p, "curve") {
                    body["curve"] = json!(c);
                }
                if let Some(t) = p.get("threshold") {
                    body["threshold"] = t.clone();
                }
                if let Some(pt) = p.get("parties") {
                    body["parties"] = pt.clone();
                }
                ok(self.mpc_post(&format!("/vaults/{}/wallets", vault), body).await?)
            }
            "transactions" => ok(self.mpc_get("/transactions").await?),
            "transaction" => match pstr(p, "transaction_id") {
                Some(id) => ok(self.mpc_get(&format!("/transactions/{}", id)).await?),
                None => Ok(need(action, "transaction_id")),
            },
            "create_transaction" => match pstr(p, "wallet_id") {
                Some(wallet) => {
                    let mut body = json!({ "walletId": wallet });
                    for k in ["type", "chain", "to", "amount"] {
                        if let Some(v) = pstr(p, k) {
                            body[k] = json!(v);
                        }
                    }
                    ok(self.mpc_post("/transactions", body).await?)
                }
                None => Ok(need(action, "wallet_id")),
            },
            "approve" | "reject" | "broadcast" => match pstr(p, "transaction_id") {
                Some(id) => ok(self.mpc_post(&format!("/transactions/{}/{}", id, action), json!({})).await?),
                None => Ok(need(action, "transaction_id")),
            },
            "policies" => ok(self.mpc_get("/policies").await?),
            "smart_wallets" => ok(self.mpc_get("/smart-wallets").await?),
            "whitelist" => ok(self.mpc_get("/whitelist").await?),
            "bridge_sign" => {
                let (wallet, src, dst) = (pstr(p, "wallet_id"), pstr(p, "source_chain"), pstr(p, "dest_chain"));
                let (Some(wallet), Some(src), Some(dst)) = (wallet, src, dst) else {
                    return Ok(need(action, "wallet_id, source_chain, dest_chain"));
                };
                let mut body = json!({ "walletId": wallet, "sourceChain": src, "destChain": dst });
                for k in ["token", "amount", "recipient"] {
                    if let Some(v) = pstr(p, k) {
                        body[k] = json!(v);
                    }
                }
                ok(self.mpc_post("/bridge/sign", body).await?)
            }
            _ => Ok(unknown(action, &[
                "status", "vaults", "vault", "create_vault", "wallets", "wallet", "create_wallet",
                "transactions", "transaction", "create_transaction", "approve", "reject",
                "broadcast", "policies", "smart_wallets", "whitelist", "bridge_sign",
            ])),
        }
    }

    // -- billing (api.hanzo.ai /v1/billing) ---------------------------------

    async fn billing(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let user = pstr(p, "user");
        let user_q = || user.clone().map(|u| vec![("user".into(), u)]).unwrap_or_default();
        match action {
            "balance" => ok(self.call("billing", "GET", "/balance", &user_q(), None).await?),
            "usage" => {
                let mut q = user_q();
                if let Some(period) = pstr(p, "period") {
                    q.push(("period".into(), period));
                }
                ok(self.call("billing", "GET", "/usage", &q, None).await?)
            }
            "plans" => ok(self.call("billing", "GET", "/plans", &[], None).await?),
            "subscriptions" => ok(self.call("billing", "GET", "/subscriptions", &user_q(), None).await?),
            "subscription" => match pstr(p, "subscription_id") {
                Some(id) => ok(self.call("billing", "GET", &format!("/subscriptions/{}", id), &[], None).await?),
                None => Ok(need(action, "subscription_id")),
            },
            "invoices" => ok(self.call("billing", "GET", "/invoices", &user_q(), None).await?),
            "invoice" => match pstr(p, "invoice_id") {
                Some(id) => ok(self.call("billing", "GET", &format!("/invoices/{}", id), &[], None).await?),
                None => Ok(need(action, "invoice_id")),
            },
            "payment_methods" => ok(self.call("billing", "GET", "/payment-methods", &user_q(), None).await?),
            "spend_alerts" => ok(self.call("billing", "GET", "/spend-alerts", &user_q(), None).await?),
            "credit_balance" => ok(self.call("billing", "GET", "/credits", &user_q(), None).await?),
            "meters" => ok(self.call("billing", "GET", "/meters", &user_q(), None).await?),
            "deposit" => match p.get("amount").and_then(|v| v.as_f64()).filter(|a| *a > 0.0) {
                Some(amount) => {
                    let mut body = json!({ "amount": amount });
                    if let Some(u) = &user {
                        body["user"] = json!(u);
                    }
                    ok(self.call("billing", "POST", "/deposit", &[], Some(body)).await?)
                }
                None => Ok(need(action, "amount (positive number)")),
            },
            "credit" => {
                let mut body = json!({});
                if let Some(u) = &user {
                    body["user"] = json!(u);
                }
                ok(self.call("billing", "POST", "/credit", &[], Some(body)).await?)
            }
            _ => Ok(unknown(action, &[
                "balance", "usage", "plans", "subscriptions", "subscription", "invoices",
                "invoice", "payment_methods", "spend_alerts", "credit_balance", "meters",
                "deposit", "credit",
            ])),
        }
    }

    // -- commerce (api.hanzo.ai /api/v1) ------------------------------------

    async fn commerce(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let query = pstr(p, "query");
        let q = || query.clone().map(|q| vec![("q".into(), q)]).unwrap_or_default();
        match action {
            "orders" => ok(self.call("commerce", "GET", "/orders", &q(), None).await?),
            "order" => match pstr(p, "order_id") {
                Some(id) => ok(self.call("commerce", "GET", &format!("/orders/{}", id), &[], None).await?),
                None => Ok(need(action, "order_id")),
            },
            "products" => ok(self.call("commerce", "GET", "/products", &q(), None).await?),
            "product" => match pstr(p, "product_id") {
                Some(id) => ok(self.call("commerce", "GET", &format!("/products/{}", id), &[], None).await?),
                None => Ok(need(action, "product_id")),
            },
            "collections" => ok(self.call("commerce", "GET", "/collections", &[], None).await?),
            "search_users" => match &query {
                Some(query) => ok(self.call("commerce", "GET", "/users", &[("q".into(), query.clone())], None).await?),
                None => Ok(need(action, "query")),
            },
            "search_orders" => match &query {
                Some(query) => ok(self.call("commerce", "GET", "/orders", &[("q".into(), query.clone())], None).await?),
                None => Ok(need(action, "query")),
            },
            "stores" => ok(self.call("commerce", "GET", "/stores", &[], None).await?),
            "discounts" => ok(self.call("commerce", "GET", "/discounts", &[], None).await?),
            "webhooks" => ok(self.call("commerce", "GET", "/webhooks", &[], None).await?),
            _ => Ok(unknown(action, &[
                "orders", "order", "products", "product", "collections", "search_users",
                "search_orders", "stores", "discounts", "webhooks",
            ])),
        }
    }

    // -- team (api.hanzo.ai /team) ------------------------------------------

    async fn team(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        let ok = |d| Ok(envelope_ok("hanzo", action, d));
        let ws = pstr(p, "workspace_id");
        match action {
            "workspaces" => ok(self.call("team", "GET", "/workspaces", &[], None).await?),
            "workspace" => match ws {
                Some(id) => ok(self.call("team", "GET", &format!("/workspaces/{}", id), &[], None).await?),
                None => Ok(need(action, "workspace_id")),
            },
            "create_workspace" => match pstr(p, "name") {
                Some(name) => ok(self.call("team", "POST", "/workspaces", &[], Some(json!({ "name": name }))).await?),
                None => Ok(need(action, "name")),
            },
            "delete_workspace" => match ws {
                Some(id) => ok(self.call("team", "DELETE", &format!("/workspaces/{}", id), &[], None).await?),
                None => Ok(need(action, "workspace_id")),
            },
            "members" => match ws {
                Some(id) => ok(self.call("team", "GET", &format!("/workspaces/{}/members", id), &[], None).await?),
                None => Ok(need(action, "workspace_id")),
            },
            "invite" => {
                let (ws, email) = (ws, pstr(p, "email"));
                let (Some(ws), Some(email)) = (ws, email) else {
                    return Ok(need(action, "workspace_id, email"));
                };
                let mut body = json!({ "email": email });
                if let Some(role) = pstr(p, "role") {
                    body["role"] = json!(role);
                }
                ok(self.call("team", "POST", &format!("/workspaces/{}/invitations", ws), &[], Some(body)).await?)
            }
            "account" => ok(self.call("team", "GET", "/account", &[], None).await?),
            _ => Ok(unknown(action, &[
                "workspaces", "workspace", "create_workspace", "delete_workspace", "members",
                "invite", "account",
            ])),
        }
    }

    // -- api (generic api.hanzo.ai bridge) ----------------------------------

    async fn api(&self, action: &str, p: &Map<String, Value>) -> Result<Value> {
        match action {
            "list" => Ok(envelope_ok(
                "hanzo",
                action,
                json!({ "services": SERVICES, "hint": "hanzo(resource=\"api\", action=\"call\", method=\"GET\", path=\"/v1/...\")" }),
            )),
            "call" | "raw" | "request" => {
                let Some(path) = pstr(p, "path") else {
                    return Ok(need(action, "path"));
                };
                let method = pstr(p, "method").unwrap_or_else(|| "GET".to_string()).to_uppercase();
                let body = p.get("body").filter(|b| !b.is_null()).cloned();
                Ok(envelope_ok("hanzo", action, self.call("api", &method, &path, &[], body).await?))
            }
            _ => Ok(unknown(action, &["list", "call"])),
        }
    }
}

const IAM_ACTIONS: &[&str] = &[
    "users", "user", "create_user", "update_user", "delete_user", "orgs", "org", "roles",
    "role", "permissions", "providers", "apps", "tokens", "sessions", "invitations",
    "invite", "records",
];

const PAAS_ACTIONS: &[&str] = &[
    "whoami", "projects", "env", "deployments", "deploy", "logs", "redeploy", "services",
];

/// Address of one typed IAM record. `id` is spelled `owner/name`.
fn row(kind: &str, id: Option<&str>) -> Option<String> {
    let (owner, name) = id?.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("/v1/iam/{}/{}/{}", kind, owner, name))
}

/// Actions advertised for a service when called with no action (progressive reveal).
fn actions_for(service: &str) -> Vec<&'static str> {
    match service {
        "iam" => IAM_ACTIONS.to_vec(),
        "auth" => vec!["status", "whoami", "logout", "refresh"],
        "kms" => vec!["list", "get", "set", "delete", "inject"],
        "paas" => PAAS_ACTIONS.to_vec(),
        "ingress" => vec![
            "routers", "services", "middlewares", "entrypoints", "overview", "tcp_routers",
            "domains", "add_domain", "remove_domain", "verify_domain", "tls_status",
        ],
        "mpc" => vec![
            "status", "vaults", "vault", "create_vault", "wallets", "wallet", "create_wallet",
            "transactions", "transaction", "create_transaction", "approve", "reject",
            "broadcast", "policies", "smart_wallets", "whitelist", "bridge_sign",
        ],
        "billing" => vec![
            "balance", "usage", "plans", "subscriptions", "subscription", "invoices", "invoice",
            "payment_methods", "spend_alerts", "credit_balance", "meters", "deposit", "credit",
        ],
        "commerce" => vec![
            "orders", "order", "products", "product", "collections", "search_users",
            "search_orders", "stores", "discounts", "webhooks",
        ],
        "team" => vec![
            "workspaces", "workspace", "create_workspace", "delete_workspace", "members",
            "invite", "account",
        ],
        "api" => vec!["list", "call"],
        _ => vec![],
    }
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

    /// Serialises the tests that read or write the process environment.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A listener that answers one request, and reports what it was asked.
    fn one_shot(status: &str, body: &str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let (status, body) = (status.to_string(), body.to_string());
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let resp = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
        });
        (format!("http://{addr}"), rx)
    }

    async fn iam_call(status: &str, body: &str, args: HanzoToolArgs) -> (Value, String) {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let (base, rx) = one_shot(status, body);
        std::env::set_var("IAM_URL", &base);
        std::env::set_var("HANZO_API_KEY", "sk-test");
        let out = HanzoTool::new().execute(args).await.unwrap();
        let req = rx.recv().unwrap();
        std::env::remove_var("IAM_URL");
        (out, req)
    }

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
    async fn test_service_alias_resolves() {
        let tool = HanzoTool::new();
        let result = tool
            .execute(HanzoToolArgs {
                resource: Some("identity".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result["data"]["service"], "iam");
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
    fn test_base_urls_match_python_defaults() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("IAM_URL");
        std::env::remove_var("HANZO_KMS_URL");
        std::env::remove_var("HANZO_PAAS_URL");
        assert_eq!(base_url("iam"), "https://hanzo.id");
        assert_eq!(base_url("kms"), "https://kms.hanzo.ai");
        assert_eq!(base_url("paas"), "https://platform.hanzo.ai");
        assert_eq!(base_url("ingress"), "https://platform.hanzo.ai");
        assert_eq!(base_url("billing"), "https://api.hanzo.ai/v1/billing");
        assert_eq!(base_url("commerce"), "https://api.hanzo.ai/api/v1");
        assert_eq!(base_url("team"), "https://api.hanzo.ai/team");
        assert_eq!(base_url("api"), "https://api.hanzo.ai");
    }

    #[test]
    fn test_join_normalizes_slashes() {
        assert_eq!(join("https://hanzo.id", "/v1/iam/users"), "https://hanzo.id/v1/iam/users");
        assert_eq!(join("https://api.hanzo.ai/team", "/workspaces"), "https://api.hanzo.ai/team/workspaces");
    }

    #[test]
    fn test_row_needs_owner_and_name() {
        assert_eq!(row("users", Some("hanzo/z")).unwrap(), "/v1/iam/users/hanzo/z");
        assert_eq!(row("roles", Some("admin/ops")).unwrap(), "/v1/iam/roles/admin/ops");
        for bad in ["z", "/z", "hanzo/", "a/b/c", ""] {
            assert!(row("users", Some(bad)).is_none(), "accepted {bad}");
        }
        assert!(row("users", None).is_none());
    }

    #[tokio::test]
    async fn test_iam_reads_a_row_by_owner_and_name() {
        let (out, req) = iam_call(
            "200 OK",
            r#"{"owner":"hanzo","name":"z"}"#,
            HanzoToolArgs {
                resource: Some("iam".into()),
                action: Some("user".into()),
                id: Some("hanzo/z".into()),
                ..Default::default()
            },
        )
        .await;
        assert!(req.starts_with("GET /v1/iam/users/hanzo/z "), "{req}");
        assert_eq!(out["ok"], true);
        assert_eq!(out["data"]["name"], "z");
    }

    #[tokio::test]
    async fn test_refusal_carries_its_reason() {
        let (out, _) = iam_call(
            "404 Not Found",
            r#"{"type":"about:blank","title":"Not Found","status":404,"detail":"no such user"}"#,
            HanzoToolArgs {
                resource: Some("iam".into()),
                action: Some("user".into()),
                id: Some("hanzo/nobody".into()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"]["code"], "UPSTREAM");
        let msg = out["error"]["message"].as_str().unwrap();
        assert!(msg.contains("404") && msg.contains("no such user"), "{msg}");
    }

    #[test]
    fn test_iam_owns_the_identity_actions() {
        let iam = actions_for("iam");
        assert!(iam.contains(&"users") && iam.contains(&"orgs") && iam.contains(&"roles"));
        let paas = actions_for("paas");
        for identity in ["users", "orgs", "roles"] {
            assert!(!paas.contains(&identity), "paas still answers {identity}");
        }
    }
}
