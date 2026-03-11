/// Workspace context tool (HIP-0300)
///
/// Actions: detect, capabilities, help

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use which::which;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WsAction {
    Detect,
    Capabilities,
    Schema,
    Help,
}

impl Default for WsAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for WsAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "detect" | "scan" => Ok(Self::Detect),
            "capabilities" | "caps" => Ok(Self::Capabilities),
            "schema" => Ok(Self::Schema),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceToolArgs {
    pub action: Option<String>,
    pub path: Option<String>,
}

pub struct WorkspaceToolDefinition;

impl WorkspaceToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "workspace",
            "description": "Workspace context: detect, capabilities, schema, help",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["detect", "capabilities", "schema", "help"],
                        "description": "Workspace action"
                    },
                    "path": { "type": "string", "description": "Project root", "default": "." }
                },
                "required": ["action"]
            }
        })
    }
}

pub struct WorkspaceTool;

impl WorkspaceTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: WorkspaceToolArgs) -> Result<Value> {
        let action: WsAction = args.action.as_deref().unwrap_or("help").parse()?;

        match action {
            WsAction::Detect => self.detect(&args).await,
            WsAction::Capabilities => self.capabilities().await,
            WsAction::Schema => self.schema(&args).await,
            WsAction::Help => Ok(self.help()),
        }
    }

    async fn detect(&self, args: &WorkspaceToolArgs) -> Result<Value> {
        let root = args.path.as_deref().unwrap_or(".");
        let root = Path::new(root);

        let mut languages = Vec::new();
        let mut build = Vec::new();
        let mut test = Vec::new();
        let mut vcs: Option<&str> = None;

        if root.join(".git").exists() { vcs = Some("git"); }

        if root.join("package.json").exists() {
            languages.extend(["typescript", "javascript"]);
            build.push("npm");
        }
        if root.join("tsconfig.json").exists() && !languages.contains(&"typescript") {
            languages.push("typescript");
        }
        if root.join("pyproject.toml").exists() {
            languages.push("python");
            build.push("uv");
        }
        if root.join("Cargo.toml").exists() {
            languages.push("rust");
            build.push("cargo");
        }
        if root.join("go.mod").exists() {
            languages.push("go");
            build.push("go");
        }
        if root.join("Makefile").exists() { build.push("make"); }
        if root.join("compose.yml").exists() { build.push("docker-compose"); }
        if root.join("Dockerfile").exists() { build.push("docker"); }

        if root.join("jest.config.ts").exists() || root.join("jest.config.js").exists() {
            test.push("jest");
        }
        if root.join("vitest.config.ts").exists() { test.push("vitest"); }
        if root.join("pytest.ini").exists() || root.join("conftest.py").exists() {
            test.push("pytest");
        }

        // Dedupe
        languages.dedup();

        Ok(json!({
            "ok": true,
            "data": {
                "root": root.to_string_lossy(),
                "languages": languages,
                "build": build,
                "test": test,
                "vcs": vcs
            },
            "error": null,
            "meta": { "tool": "workspace", "action": "detect" }
        }))
    }

    async fn capabilities(&self) -> Result<Value> {
        Ok(json!({
            "ok": true,
            "data": {
                "search": if which("rg").is_ok() { "ripgrep" } else { "grep" },
                "vcs": if which("git").is_ok() { json!("git") } else { json!(null) },
                "runtimes": {
                    "node": which("node").is_ok(),
                    "python": which("python3").is_ok(),
                    "rust": which("cargo").is_ok(),
                },
                "tools": ["fs", "exec", "code", "git", "fetch", "computer", "workspace", "browser", "think", "llm", "memory", "hanzo", "plan", "tasks", "mode"]
            },
            "error": null,
            "meta": { "tool": "workspace", "action": "capabilities" }
        }))
    }

    async fn schema(&self, args: &WorkspaceToolArgs) -> Result<Value> {
        let root = args.path.as_deref().unwrap_or(".");
        let root = Path::new(root);
        let mut schema = Vec::new();

        // Detect project manifest files and extract key metadata
        if root.join("package.json").exists() {
            if let Ok(content) = tokio::fs::read_to_string(root.join("package.json")).await {
                if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
                    schema.push(json!({
                        "file": "package.json",
                        "name": pkg.get("name"),
                        "version": pkg.get("version"),
                        "type": "node"
                    }));
                }
            }
        }
        if root.join("Cargo.toml").exists() {
            if let Ok(content) = tokio::fs::read_to_string(root.join("Cargo.toml")).await {
                schema.push(json!({
                    "file": "Cargo.toml",
                    "content_lines": content.lines().count(),
                    "type": "rust"
                }));
            }
        }
        if root.join("pyproject.toml").exists() {
            if let Ok(content) = tokio::fs::read_to_string(root.join("pyproject.toml")).await {
                schema.push(json!({
                    "file": "pyproject.toml",
                    "content_lines": content.lines().count(),
                    "type": "python"
                }));
            }
        }
        if root.join("go.mod").exists() {
            if let Ok(content) = tokio::fs::read_to_string(root.join("go.mod")).await {
                let module = content.lines().next().unwrap_or("").trim_start_matches("module ").to_string();
                schema.push(json!({
                    "file": "go.mod",
                    "module": module,
                    "type": "go"
                }));
            }
        }

        Ok(json!({
            "ok": true,
            "data": { "root": root.to_string_lossy(), "manifests": schema, "count": schema.len() },
            "error": null,
            "meta": { "tool": "workspace", "action": "schema" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "workspace",
                "actions": {
                    "detect": "Detect project languages, build systems, VCS, test frameworks",
                    "capabilities": "List available system tools and runtimes",
                    "schema": "Extract project manifest schemas (package.json, Cargo.toml, etc.)",
                    "help": "Show tool help"
                }
            },
            "error": null,
            "meta": { "tool": "workspace", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ws_action_parse() {
        assert_eq!("detect".parse::<WsAction>().unwrap(), WsAction::Detect);
        assert_eq!("capabilities".parse::<WsAction>().unwrap(), WsAction::Capabilities);
    }
}
