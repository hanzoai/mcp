//! `connectors` — Cloud OAuth, Business App & Social Connectors (HIP-0300).
//!
//! Mirrors `src/tools/connectors.ts` (absorbed into `hanzo` resource=`connectors`,
//! and callable directly via legacy `tools/call` alias `connectors`).
//! Secrets live in Hanzo KMS and NEVER appear in tool output.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

use super::vault_tool::{kms_get_secret, kms_list_secret_groups, kms_set_secret, slugify_app};
use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const ACTIONS: &[&str] = &["list", "request", "view", "act", "configure"];

#[derive(Clone, Copy)]
pub struct ConnectorDef {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub compatible_app: bool,
    pub api_base: &'static str,
    pub kms_path: &'static str,
    pub setup_url: &'static str,
    pub web_url: &'static str,
}

pub const CONNECTORS: &[ConnectorDef] = &[
    ConnectorDef { id: "lastpass", name: "LastPass", category: "vault", compatible_app: false, api_base: "https://lastpass.com/enterpriseapi.php", kms_path: "credentials/lastpass", setup_url: "https://admin.lastpass.com/advanced/enterprise-api", web_url: "https://lastpass.com/?ac=1" },
    ConnectorDef { id: "gmail", name: "Gmail", category: "productivity", compatible_app: true, api_base: "https://gmail.googleapis.com/gmail/v1/users/me", kms_path: "credentials/gmail", setup_url: "https://console.cloud.google.com/apis/library/gmail.googleapis.com", web_url: "https://mail.google.com/mail/u/0/" },
    ConnectorDef { id: "google_calendar", name: "Google Calendar", category: "productivity", compatible_app: true, api_base: "https://www.googleapis.com/calendar/v3", kms_path: "credentials/google_calendar", setup_url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com", web_url: "https://calendar.google.com/" },
    ConnectorDef { id: "google_drive", name: "Google Drive", category: "productivity", compatible_app: true, api_base: "https://www.googleapis.com/drive/v3", kms_path: "credentials/google_drive", setup_url: "https://console.cloud.google.com/apis/library/drive.googleapis.com", web_url: "https://drive.google.com/drive/my-drive" },
    ConnectorDef { id: "google_forms", name: "Google Forms", category: "productivity", compatible_app: true, api_base: "https://forms.googleapis.com/v1", kms_path: "credentials/google_forms", setup_url: "https://console.cloud.google.com/apis/library/forms.googleapis.com", web_url: "https://docs.google.com/forms/" },
    ConnectorDef { id: "salesforce", name: "Salesforce", category: "crm", compatible_app: true, api_base: "https://login.salesforce.com/services/data/v60.0", kms_path: "credentials/salesforce", setup_url: "https://login.salesforce.com/lightning/setup/NavigationMenus/home", web_url: "https://login.salesforce.com/" },
    ConnectorDef { id: "microsoft_teams", name: "Microsoft Teams", category: "productivity", compatible_app: true, api_base: "https://graph.microsoft.com/v1.0", kms_path: "credentials/microsoft_teams", setup_url: "https://portal.azure.com/", web_url: "https://teams.microsoft.com/" },
    ConnectorDef { id: "github", name: "GitHub", category: "developer", compatible_app: true, api_base: "https://api.github.com", kms_path: "credentials/github", setup_url: "https://github.com/settings/tokens", web_url: "https://github.com/" },
    ConnectorDef { id: "woocommerce", name: "WooCommerce", category: "commerce", compatible_app: true, api_base: "https://example.com/wp-json/wc/v3", kms_path: "credentials/woocommerce", setup_url: "https://woocommerce.com/document/woocommerce-rest-api/", web_url: "https://woocommerce.com/" },
    ConnectorDef { id: "intercom", name: "Intercom", category: "crm", compatible_app: true, api_base: "https://api.intercom.io", kms_path: "credentials/intercom", setup_url: "https://app.intercom.com/a/apps/_/developer-hub", web_url: "https://app.intercom.com/" },
    ConnectorDef { id: "facebook_lead_ads", name: "Facebook Lead Ads", category: "marketing", compatible_app: true, api_base: "https://graph.facebook.com/v20.0", kms_path: "credentials/facebook_lead_ads", setup_url: "https://developers.facebook.com/apps/", web_url: "https://business.facebook.com/" },
    ConnectorDef { id: "docusign", name: "DocuSign", category: "productivity", compatible_app: true, api_base: "https://na4.docusign.net/restapi/v2.1", kms_path: "credentials/docusign", setup_url: "https://admindemo.docusign.com/apps-and-keys", web_url: "https://app.docusign.com/" },
    ConnectorDef { id: "google_ads", name: "Google Ads", category: "marketing", compatible_app: true, api_base: "https://googleads.googleapis.com/v17", kms_path: "credentials/google_ads", setup_url: "https://ads.google.com/aw/apicenter", web_url: "https://ads.google.com/" },
    ConnectorDef { id: "klaviyo", name: "Klaviyo", category: "marketing", compatible_app: true, api_base: "https://a.klaviyo.com/api", kms_path: "credentials/klaviyo", setup_url: "https://www.klaviyo.com/settings/account/api-keys", web_url: "https://www.klaviyo.com/" },
    ConnectorDef { id: "linkedin", name: "LinkedIn", category: "social", compatible_app: true, api_base: "https://api.linkedin.com/v2", kms_path: "credentials/linkedin", setup_url: "https://www.linkedin.com/developers/apps", web_url: "https://www.linkedin.com/" },
    ConnectorDef { id: "quickbooks", name: "QuickBooks", category: "finance", compatible_app: true, api_base: "https://quickbooks.api.intuit.com/v3", kms_path: "credentials/quickbooks", setup_url: "https://developer.intuit.com/app/developer/dashboard", web_url: "https://app.qbo.intuit.com/" },
    ConnectorDef { id: "google_analytics", name: "Google Analytics", category: "analytics", compatible_app: true, api_base: "https://analyticsdata.googleapis.com/v1beta", kms_path: "credentials/google_analytics", setup_url: "https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com", web_url: "https://analytics.google.com/" },
    ConnectorDef { id: "hanzo_post", name: "Hanzo Post", category: "publishing", compatible_app: false, api_base: "https://post.hanzo.ai/api/public/v1", kms_path: "channels/postiz", setup_url: "https://post.hanzo.ai/launches", web_url: "https://post.hanzo.ai/" },
    ConnectorDef { id: "x", name: "X (Twitter)", category: "social", compatible_app: false, api_base: "https://api.x.com/2", kms_path: "credentials/x", setup_url: "https://developer.x.com/en/portal/dashboard", web_url: "https://x.com/" },
    ConnectorDef { id: "discord", name: "Discord", category: "social", compatible_app: false, api_base: "https://discord.com/api/v10", kms_path: "credentials/discord", setup_url: "https://discord.com/developers/applications", web_url: "https://discord.com/app" },
    ConnectorDef { id: "slack", name: "Slack", category: "productivity", compatible_app: false, api_base: "https://slack.com/api", kms_path: "credentials/slack", setup_url: "https://api.slack.com/apps", web_url: "https://app.slack.com/" },
    ConnectorDef { id: "telegram", name: "Telegram", category: "social", compatible_app: false, api_base: "https://api.telegram.org", kms_path: "credentials/telegram", setup_url: "https://core.telegram.org/bots", web_url: "https://web.telegram.org/" },
    ConnectorDef { id: "youtube", name: "YouTube", category: "social", compatible_app: false, api_base: "https://www.googleapis.com/youtube/v3", kms_path: "credentials/youtube", setup_url: "https://console.cloud.google.com/apis/library/youtube.googleapis.com", web_url: "https://studio.youtube.com/" },
    ConnectorDef { id: "reddit", name: "Reddit", category: "social", compatible_app: false, api_base: "https://oauth.reddit.com", kms_path: "credentials/reddit", setup_url: "https://www.reddit.com/prefs/apps", web_url: "https://www.reddit.com/" },
    ConnectorDef { id: "bluesky", name: "Bluesky", category: "social", compatible_app: false, api_base: "https://bsky.social/xrpc", kms_path: "credentials/bluesky", setup_url: "https://bsky.app/settings/app-passwords", web_url: "https://bsky.app/" },
    ConnectorDef { id: "mastodon", name: "Mastodon", category: "social", compatible_app: false, api_base: "https://mastodon.social/api/v1", kms_path: "credentials/mastodon", setup_url: "https://mastodon.social/settings/applications", web_url: "https://mastodon.social/" },
    ConnectorDef { id: "threads", name: "Threads", category: "social", compatible_app: false, api_base: "https://graph.threads.net/v1.0", kms_path: "credentials/threads", setup_url: "https://developers.facebook.com/apps/", web_url: "https://www.threads.net/" },
    ConnectorDef { id: "instagram", name: "Instagram", category: "social", compatible_app: false, api_base: "https://graph.facebook.com/v20.0", kms_path: "credentials/instagram", setup_url: "https://developers.facebook.com/apps/", web_url: "https://www.instagram.com/" },
    ConnectorDef { id: "tiktok", name: "TikTok", category: "social", compatible_app: false, api_base: "https://open.tiktokapis.com/v2", kms_path: "credentials/tiktok", setup_url: "https://developers.tiktok.com/apps/", web_url: "https://www.tiktok.com/" },
    ConnectorDef { id: "pinterest", name: "Pinterest", category: "social", compatible_app: false, api_base: "https://api.pinterest.com/v5", kms_path: "credentials/pinterest", setup_url: "https://developers.pinterest.com/apps/", web_url: "https://www.pinterest.com/" },
    ConnectorDef { id: "medium", name: "Medium", category: "publishing", compatible_app: false, api_base: "https://api.medium.com/v1", kms_path: "credentials/medium", setup_url: "https://medium.com/me/settings/security", web_url: "https://medium.com/" },
    ConnectorDef { id: "devto", name: "DEV.to", category: "publishing", compatible_app: false, api_base: "https://dev.to/api", kms_path: "credentials/devto", setup_url: "https://dev.to/settings/extensions", web_url: "https://dev.to/" },
    ConnectorDef { id: "hashnode", name: "Hashnode", category: "publishing", compatible_app: false, api_base: "https://gql.hashnode.com", kms_path: "credentials/hashnode", setup_url: "https://hashnode.com/settings/developer", web_url: "https://hashnode.com/" },
];

fn find_connector(id: &str) -> Option<&'static ConnectorDef> {
    let norm = slugify_app(id);
    let alias = match norm.as_str() {
        "twitter" => "x",
        "postiz" | "post" => "hanzo_post",
        "gcal" | "calendar" => "google_calendar",
        "gdrive" | "drive" => "google_drive",
        "ga" | "analytics" => "google_analytics",
        "teams" => "microsoft_teams",
        other => other,
    };
    CONNECTORS.iter().find(|c| c.id == alias)
}

pub struct ConnectorsTool {
    api: HanzoApi,
    client: reqwest::Client,
}

impl ConnectorsTool {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { api: HanzoApi::from_env(), client }
    }

    pub fn schema() -> Value {
        let ids: Vec<&str> = CONNECTORS.iter().map(|c| c.id).collect();
        json!({
            "name": "connectors",
            "description": "Unified Cloud OAuth, Business App & Social Connectors across 16 compatible business apps, LastPass, Hanzo Post (`post.hanzo.ai/mcp`), and 15 social/publishing networks. Actions: list | request | view | act | configure.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ACTIONS,
                        "description": "Connector operation: list | request | view | act | configure"
                    },
                    "connector": {
                        "type": "string",
                        "description": format!("Connector ID ({})", ids.join(", "))
                    },
                    "category": { "type": "string", "description": "list: category filter" },
                    "compatibleOnly": { "type": "boolean", "description": "list: only the 16 compatible business apps" },
                    "method": { "type": "string", "description": "request: HTTP method (default GET)" },
                    "path": { "type": "string", "description": "request: API path appended to connector apiBase" },
                    "query": { "type": "object", "description": "request: URL query parameters" },
                    "body": { "type": ["object", "string"], "description": "request: JSON or text request body" },
                    "headers": { "type": "object", "description": "request: extra non-secret HTTP headers" },
                    "url": { "type": "string", "description": "view: specific web URL" },
                    "op": { "type": "string", "enum": ["click", "fill", "press", "snapshot", "evaluate"], "description": "act: ZAP browser verb" },
                    "selector": { "type": "string", "description": "act: snapshot ref (@eN) or CSS selector" },
                    "text": { "type": "string", "description": "act (fill): text to enter" },
                    "key": { "type": "string", "description": "act (press): key name" },
                    "token": { "type": "string", "description": "configure: OAuth bearer token or API key to seal into Hanzo KMS" },
                    "secret": { "type": "string", "description": "configure: API secret to seal into Hanzo KMS" },
                    "username": { "type": "string", "description": "configure: username/email to seal into Hanzo KMS" },
                    "password": { "type": "string", "description": "configure: password to seal into Hanzo KMS" },
                    "totp_secret": { "type": "string", "description": "configure: TOTP secret to seal into Hanzo KMS" },
                    "mcpServerUrl": { "type": "string", "description": "configure: remote MCP server URL for /v1/tool/mcp/servers" },
                    "registerMcpServer": { "type": "boolean", "description": "configure: register on https://api.hanzo.ai/v1/tool/mcp/servers" },
                    "env": { "type": "string", "description": "Hanzo KMS environment (default: prod)" }
                },
                "required": ["action"]
            }
        })
    }
}

impl Default for ConnectorsTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for ConnectorsTool {
    fn name(&self) -> &str {
        "connectors"
    }

    fn description(&self) -> &str {
        "Cloud OAuth, Business App & Social Connectors (KMS + /v1/tool/mcp/servers + ZAP browser)"
    }

    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params.get("action").and_then(Value::as_str).unwrap_or("list");
        let env = params.get("env").and_then(Value::as_str).unwrap_or("prod");

        match action {
            "list" => {
                let groups = kms_list_secret_groups(&self.api, env).await;
                let compat_only = params.get("compatibleOnly").and_then(Value::as_bool).unwrap_or(false);
                let cat_filter = params.get("category").and_then(Value::as_str).map(|s| s.to_lowercase());
                let conn_filter = params.get("connector").and_then(Value::as_str).and_then(find_connector);

                let items: Vec<Value> = CONNECTORS
                    .iter()
                    .filter(|c| !compat_only || c.compatible_app)
                    .filter(|c| cat_filter.as_deref().is_none_or(|cf| c.category == cf))
                    .filter(|c| conn_filter.is_none_or(|one| one.id == c.id))
                    .map(|c| {
                        let configured = groups.iter().any(|g| g["path"].as_str() == Some(c.kms_path));
                        json!({
                            "id": c.id,
                            "name": c.name,
                            "category": c.category,
                            "compatibleApp": c.compatible_app,
                            "kmsPath": c.kms_path,
                            "kmsConfigured": configured,
                            "setupUrl": c.setup_url,
                            "webUrl": c.web_url,
                        })
                    })
                    .collect();

                Ok(ToolResult::ok(envelope_ok(
                    "connectors",
                    "list",
                    json!({
                        "count": items.len(),
                        "connectors": items,
                    }),
                )))
            }

            "request" => {
                let Some(conn_id) = params.get("connector").and_then(Value::as_str) else {
                    return Ok(ToolResult::ok(envelope_err("connectors", "request", "INVALID_ARGS", "connector required")));
                };
                let Some(spec) = find_connector(conn_id) else {
                    return Ok(ToolResult::ok(envelope_err(
                        "connectors",
                        "request",
                        "UNKNOWN_CONNECTOR",
                        format!("unknown connector {conn_id:?}"),
                    )));
                };
                let mut token = None;
                for key_name in ["OAUTH_TOKEN", "API_KEY", "POSTIZ_API_KEY"] {
                    if let Some(v) = kms_get_secret(&self.api, &format!("{}/{key_name}", spec.kms_path), env).await {
                        token = Some(v);
                        break;
                    }
                }
                let Some(bearer) = token else {
                    return Ok(ToolResult::ok(envelope_err(
                        "connectors",
                        "request",
                        "NOT_CONFIGURED",
                        format!("no token sealed in KMS at {}; call configure first", spec.kms_path),
                    )));
                };
                let method_str = params.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
                let method = reqwest::Method::from_bytes(method_str.as_bytes()).unwrap_or(reqwest::Method::GET);
                let rel = params.get("path").and_then(Value::as_str).unwrap_or("");
                let url = format!("{}/{}", spec.api_base.trim_end_matches('/'), rel.trim_start_matches('/'));
                let mut req = self.client.request(method, &url);
                if spec.id == "klaviyo" {
                    req = req
                        .header("Authorization", format!("Klaviyo-API-Key {bearer}"))
                        .header("revision", "2024-10-15");
                } else if spec.id == "devto" {
                    req = req.header("api-key", bearer);
                } else {
                    req = req.bearer_auth(bearer);
                }
                if let Some(qobj) = params.get("query").and_then(Value::as_object) {
                    let pairs: Vec<(String, String)> = qobj
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
                        .collect();
                    req = req.query(&pairs);
                }
                if let Some(b) = params.get("body") {
                    if let Some(s) = b.as_str() {
                        req = req.body(s.to_string());
                    } else {
                        req = req.json(b);
                    }
                }
                match req.send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let text = resp.text().await.unwrap_or_default();
                        let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
                        Ok(ToolResult::ok(envelope_ok(
                            "connectors",
                            "request",
                            json!({ "connector": spec.id, "status": status, "data": body }),
                        )))
                    }
                    Err(e) => Ok(ToolResult::ok(envelope_err("connectors", "request", "UPSTREAM", e.to_string()))),
                }
            }

            "view" => {
                let Some(conn_id) = params.get("connector").and_then(Value::as_str) else {
                    return Ok(ToolResult::ok(envelope_err("connectors", "view", "INVALID_ARGS", "connector required")));
                };
                let Some(spec) = find_connector(conn_id) else {
                    return Ok(ToolResult::ok(envelope_err(
                        "connectors",
                        "view",
                        "UNKNOWN_CONNECTOR",
                        format!("unknown connector {conn_id:?}"),
                    )));
                };
                let url = params.get("url").and_then(Value::as_str).unwrap_or(spec.web_url);
                let provider = match crate::zap::resolve(None, None).await {
                    Ok(Some(p)) => p,
                    Ok(None) => return Ok(ToolResult::ok(envelope_err("connectors", "view", "NO_BROWSER", crate::zap::UNPAIRED))),
                    Err(e) => return Ok(ToolResult::ok(envelope_err("connectors", "view", "NO_BROWSER", e.to_string()))),
                };
                match crate::zap::route(
                    &provider,
                    "hanzo.read",
                    &[("url".into(), url.to_string())],
                    std::time::Duration::from_secs(15),
                )
                .await
                {
                    Ok(res) => Ok(ToolResult::ok(envelope_ok("connectors", "view", json!({ "connector": spec.id, "url": url, "page": res })))),
                    Err(e) => Ok(ToolResult::ok(envelope_err("connectors", "view", "BROWSER_ERROR", e.to_string()))),
                }
            }

            "act" => {
                let Some(op) = params.get("op").and_then(Value::as_str) else {
                    return Ok(ToolResult::ok(envelope_err("connectors", "act", "INVALID_ARGS", "op required")));
                };
                let provider = match crate::zap::resolve(None, None).await {
                    Ok(Some(p)) => p,
                    Ok(None) => return Ok(ToolResult::ok(envelope_err("connectors", "act", "NO_BROWSER", crate::zap::UNPAIRED))),
                    Err(e) => return Ok(ToolResult::ok(envelope_err("connectors", "act", "NO_BROWSER", e.to_string()))),
                };
                let method = match op {
                    "snapshot" => "hanzo.snapshot",
                    "click" => "hanzo.click",
                    "fill" => "hanzo.fill",
                    "press" => "hanzo.press",
                    "evaluate" => "Runtime.evaluate",
                    _ => return Ok(ToolResult::ok(envelope_err("connectors", "act", "INVALID_ARGS", "invalid op"))),
                };
                let mut p: Vec<(String, String)> = Vec::new();
                if let Some(sel) = params.get("selector").and_then(Value::as_str) { p.push(("selector".into(), sel.to_string())); }
                if let Some(txt) = params.get("text").and_then(Value::as_str) { p.push(("value".into(), txt.to_string())); }
                if let Some(k) = params.get("key").and_then(Value::as_str) { p.push(("key".into(), k.to_string())); }
                match crate::zap::route(&provider, method, &p, std::time::Duration::from_secs(15)).await {
                    Ok(res) => Ok(ToolResult::ok(envelope_ok("connectors", "act", json!({ "op": op, "result": res })))),
                    Err(e) => Ok(ToolResult::ok(envelope_err("connectors", "act", "BROWSER_ERROR", e.to_string()))),
                }
            }

            "configure" => {
                let Some(conn_id) = params.get("connector").and_then(Value::as_str) else {
                    return Ok(ToolResult::ok(envelope_err("connectors", "configure", "INVALID_ARGS", "connector required")));
                };
                let Some(spec) = find_connector(conn_id) else {
                    return Ok(ToolResult::ok(envelope_err(
                        "connectors",
                        "configure",
                        "UNKNOWN_CONNECTOR",
                        format!("unknown connector {conn_id:?}"),
                    )));
                };
                let mut sealed: Vec<String> = Vec::new();
                for (arg_k, kms_k) in [
                    ("token", if spec.id == "hanzo_post" { "POSTIZ_API_KEY" } else { "OAUTH_TOKEN" }),
                    ("secret", "API_KEY"),
                    ("username", "USERNAME"),
                    ("password", "PASSWORD"),
                    ("totp_secret", "TOTP_SECRET"),
                ] {
                    if let Some(v) = params.get(arg_k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        if let Err(e) = kms_set_secret(&self.api, spec.kms_path, kms_k, v, env).await {
                            return Ok(ToolResult::ok(envelope_err("connectors", "configure", "KMS_ERROR", e.to_string())));
                        }
                        sealed.push(kms_k.to_string());
                    }
                }

                let mut mcp_reg = Value::Null;
                let mcp_url = params
                    .get("mcpServerUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        (params.get("registerMcpServer").and_then(Value::as_bool) == Some(true))
                            .then(|| "https://post.hanzo.ai/mcp".to_string())
                    });
                if let Some(target_url) = mcp_url {
                    if self.api.has_key() {
                        let res = self
                            .api
                            .post(
                                "/v1/tool/mcp/servers",
                                json!({
                                    "name": format!("{}-mcp", spec.id),
                                    "connector": spec.id,
                                    "url": target_url,
                                    "transport": "streamable-http",
                                }),
                            )
                            .await;
                        mcp_reg = match res {
                            Ok(v) => json!({ "registered": true, "mcpServerUrl": target_url, "server": v }),
                            Err(e) => json!({ "registered": false, "mcpServerUrl": target_url, "error": e.to_string() }),
                        };
                    }
                }

                Ok(ToolResult::ok(envelope_ok(
                    "connectors",
                    "configure",
                    json!({
                        "connector": spec.id,
                        "kmsPath": spec.kms_path,
                        "kmsSealed": !sealed.is_empty(),
                        "keysSealed": sealed,
                        "setupUrl": spec.setup_url,
                        "mcpRegistration": mcp_reg,
                    }),
                )))
            }

            _ => Ok(ToolResult::ok(envelope_err(
                "connectors",
                action,
                "INVALID_ARGS",
                format!("Unknown connectors action {action:?}. Valid: {}", ACTIONS.join(", ")),
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_all_16_compatible_apps_and_33_total_connectors() {
        assert_eq!(CONNECTORS.len(), 33);
        assert_eq!(CONNECTORS.iter().filter(|c| c.compatible_app).count(), 16);
        assert_eq!(find_connector("twitter").unwrap().id, "x");
        assert_eq!(find_connector("postiz").unwrap().id, "hanzo_post");
    }
}
