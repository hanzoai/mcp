/// Unified Hanzo platform tool (HIP-0300)
///
/// One tool for the Platform axis.
/// resource + action two-level routing: iam, kms, paas, commerce, auth, api, billing

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const RESOURCES: &[&str] = &["iam", "kms", "paas", "commerce", "storage", "auth", "api", "billing", "ingress", "mpc", "team"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HanzoToolArgs {
    pub resource: Option<String>,
    pub action: Option<String>,
    pub id: Option<String>,
    pub data: Option<Value>,
    pub query: Option<String>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub body: Option<Value>,
}

pub struct HanzoToolDefinition;

impl HanzoToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "hanzo",
            "description": "Hanzo platform: iam, kms, paas, commerce, storage, auth, api — specify resource to see actions",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "resource": {
                        "type": "string",
                        "enum": RESOURCES,
                        "description": "Platform resource"
                    },
                    "action": { "type": "string", "description": "Resource action" },
                    "id": { "type": "string" },
                    "data": { "type": "object" },
                    "query": { "type": "string" },
                    "method": { "type": "string" },
                    "path": { "type": "string" },
                    "body": { "type": "object" }
                },
                "required": []
            }
        })
    }
}

pub struct HanzoTool;

impl HanzoTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: HanzoToolArgs) -> Result<Value> {
        match &args.resource {
            None => {
                // No resource — show available resources (progressive reveal)
                Ok(json!({
                    "ok": true,
                    "data": {
                        "resources": RESOURCES,
                        "hint": "Call hanzo(resource=\"iam\") to see available actions for that resource"
                    },
                    "error": null,
                    "meta": { "tool": "hanzo", "action": "list" }
                }))
            }
            Some(resource) => {
                if !RESOURCES.contains(&resource.as_str()) {
                    return Ok(json!({
                        "ok": false,
                        "data": null,
                        "error": {
                            "code": "NOT_FOUND",
                            "message": format!("Unknown resource: {}. Available: {}", resource, RESOURCES.join(", "))
                        },
                        "meta": { "tool": "hanzo" }
                    }));
                }

                // Show resource help or delegate (in full implementation, delegates to cloud tools)
                let actions = match resource.as_str() {
                    "iam" => vec!["list_users", "get_user", "create_user", "update_user", "delete_user", "list_roles", "assign_role"],
                    "kms" => vec!["list_secrets", "get_secret", "create_secret", "update_secret", "delete_secret"],
                    "paas" => vec!["list_apps", "get_app", "deploy", "scale", "logs", "env"],
                    "commerce" => vec!["list_products", "get_product", "create_order", "list_orders"],
                    "storage" => vec!["list", "get", "put", "delete", "presign"],
                    "auth" => vec!["login", "logout", "token", "verify", "refresh"],
                    "api" => vec!["call", "list_endpoints"],
                    "billing" => vec!["list_plans", "get_usage", "create_subscription"],
                    "ingress" => vec!["list_routes", "add_route", "remove_route"],
                    "mpc" => vec!["keygen", "sign", "verify"],
                    "team" => vec!["list_members", "invite", "remove"],
                    _ => vec![],
                };

                match &args.action {
                    None => Ok(json!({
                        "ok": true,
                        "data": {
                            "resource": resource,
                            "actions": actions,
                            "hint": format!("Call hanzo(resource=\"{}\", action=\"<action>\") to execute", resource)
                        },
                        "error": null,
                        "meta": { "tool": "hanzo", "action": "help" }
                    })),
                    Some(action) => {
                        // Placeholder — in production, delegates to actual service clients
                        Ok(json!({
                            "ok": false,
                            "data": null,
                            "error": {
                                "code": "NOT_IMPLEMENTED",
                                "message": format!("Action {}.{} requires service client configuration", resource, action)
                            },
                            "meta": { "tool": "hanzo", "action": action }
                        }))
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_hanzo_list_resources() {
        let tool = HanzoTool::new();
        let result = tool.execute(HanzoToolArgs::default()).await.unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["data"]["resources"].is_array());
    }

    #[tokio::test]
    async fn test_hanzo_resource_help() {
        let tool = HanzoTool::new();
        let result = tool.execute(HanzoToolArgs {
            resource: Some("iam".to_string()),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(result["ok"], true);
        assert!(result["data"]["actions"].is_array());
    }
}
