//! Git-style configuration tool (HIP-0300).
//!
//! Actions: `get` (default), `set`, `list`, `toggle` over three planes that
//! mirror the Python `hanzo-tools-config` tool:
//!
//! - `index.scope`                → indexing scope (project | global | auto),
//!   persisted in `~/.hanzo/mcp/index_config.json`.
//! - `tools.<name>.enabled` /
//!   `enabled_tools.<name>`       → tool execution flags in the
//!   `enabled_tools` map of `~/.hanzo/settings.json`.
//! - `<tool>.enabled`             → legacy per-indexer enable flag in the
//!   `index_settings` block of the index config.
//!
//! Key resolution and output strings match the Python implementation so the
//! two tools are interchangeable.

use std::path::{Path, PathBuf};

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{envelope_err, envelope_ok};
use crate::{MCPTool, ToolResult};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// The `~/.hanzo` config home, overridable via `HANZO_CONFIG_HOME`.
fn config_home() -> PathBuf {
    std::env::var_os("HANZO_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".hanzo")))
        .unwrap_or_else(|| PathBuf::from(".hanzo"))
}

/// Canonical user settings document: `~/.hanzo/settings.json`.
fn settings_path() -> PathBuf {
    config_home().join("settings.json")
}

/// Index configuration document: `~/.hanzo/mcp/index_config.json`.
fn index_path() -> PathBuf {
    // Matches the Python IndexConfig, which anchors on the home directory.
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hanzo")
        .join("mcp")
        .join("index_config.json")
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Indexing scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Project,
    Global,
    Auto,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Project => "project",
            Scope::Global => "global",
            Scope::Auto => "auto",
        }
    }

    fn parse(s: &str) -> Option<Scope> {
        match s {
            "project" => Some(Scope::Project),
            "global" => Some(Scope::Global),
            "auto" => Some(Scope::Auto),
            _ => None,
        }
    }
}

/// File-backed index configuration, mirroring the Python `IndexConfig`.
struct IndexConfig {
    doc: Value,
}

impl IndexConfig {
    fn load() -> Self {
        let doc = read_json(&index_path()).unwrap_or_else(Self::defaults);
        Self { doc }
    }

    fn defaults() -> Value {
        json!({
            "default_scope": "auto",
            "project_configs": {},
            "global_index_paths": [],
            "index_settings": {
                "vector": { "enabled": true, "auto_index": true, "include_git_history": true },
                "symbols": { "enabled": true, "auto_index": false },
                "sql": { "enabled": true, "per_project": true },
                "graph": { "enabled": true, "per_project": true },
            },
        })
    }

    fn save(&self) -> Result<()> {
        write_json(&index_path(), &self.doc)
    }

    fn default_scope(&self) -> Scope {
        self.doc
            .get("default_scope")
            .and_then(Value::as_str)
            .and_then(Scope::parse)
            .unwrap_or(Scope::Auto)
    }

    /// Walk up from `path` looking for a project marker (git root or similar).
    fn project_root(path: &str) -> Option<PathBuf> {
        const MARKERS: &[&str] = &[".git", ".hg", "pyproject.toml", "package.json", "Cargo.toml"];
        let mut current = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        loop {
            for marker in MARKERS {
                if current.join(marker).exists() {
                    return Some(current);
                }
            }
            match current.parent() {
                Some(parent) if parent != current => current = parent.to_path_buf(),
                _ => return None,
            }
        }
    }

    fn scope(&self, path: Option<&str>) -> Scope {
        let path = match path {
            Some(p) if !p.is_empty() => p,
            _ => return self.default_scope(),
        };

        let root = Self::project_root(path);
        if let Some(root) = &root {
            if let Some(s) = self
                .doc
                .get("project_configs")
                .and_then(|m| m.get(root.to_string_lossy().as_ref()))
                .and_then(|c| c.get("scope"))
                .and_then(Value::as_str)
                .and_then(Scope::parse)
            {
                return s;
            }
        }

        match self.default_scope() {
            Scope::Auto if root.is_some() => Scope::Project,
            Scope::Auto => Scope::Global,
            other => other,
        }
    }

    fn set_scope(&mut self, scope: Scope, path: Option<&str>) -> Result<()> {
        match path.filter(|p| !p.is_empty()).and_then(Self::project_root) {
            Some(root) => {
                let configs = self
                    .doc
                    .as_object_mut()
                    .and_then(|o| o.entry("project_configs").or_insert_with(|| json!({})).as_object_mut());
                if let Some(configs) = configs {
                    let entry = configs
                        .entry(root.to_string_lossy().into_owned())
                        .or_insert_with(|| json!({}));
                    if let Some(entry) = entry.as_object_mut() {
                        entry.insert("scope".into(), json!(scope.as_str()));
                    }
                }
            }
            None => {
                if let Some(o) = self.doc.as_object_mut() {
                    o.insert("default_scope".into(), json!(scope.as_str()));
                }
            }
        }
        self.save()
    }

    fn toggle_scope(&mut self, path: Option<&str>) -> Result<Scope> {
        let next = match self.scope(path) {
            Scope::Project => Scope::Global,
            Scope::Global => Scope::Project,
            Scope::Auto if path.filter(|p| !p.is_empty()).and_then(Self::project_root).is_some() => {
                Scope::Global
            }
            Scope::Auto => Scope::Project,
        };
        self.set_scope(next, path)?;
        Ok(next)
    }

    fn indexing_enabled(&self, tool: &str) -> bool {
        self.doc
            .get("index_settings")
            .and_then(|m| m.get(tool))
            .and_then(|s| s.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    fn set_indexing_enabled(&mut self, tool: &str, enabled: bool) -> Result<()> {
        if let Some(settings) = self
            .doc
            .as_object_mut()
            .and_then(|o| o.entry("index_settings").or_insert_with(|| json!({})).as_object_mut())
        {
            let entry = settings.entry(tool.to_string()).or_insert_with(|| json!({}));
            if let Some(entry) = entry.as_object_mut() {
                entry.insert("enabled".into(), json!(enabled));
            }
        }
        self.save()
    }

    fn status(&self) -> Value {
        let tools: Map<String, Value> = self
            .doc
            .get("index_settings")
            .and_then(Value::as_object)
            .map(|settings| {
                settings
                    .iter()
                    .map(|(tool, s)| {
                        (
                            tool.clone(),
                            json!({
                                "enabled": s.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                                "per_project": s.get("per_project").and_then(Value::as_bool).unwrap_or(true),
                            }),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        json!({
            "default_scope": self.default_scope().as_str(),
            "project_count": self.doc.get("project_configs").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0),
            "tools": Value::Object(tools),
        })
    }
}

// ---------------------------------------------------------------------------
// Tool-execution settings (enabled_tools map)
// ---------------------------------------------------------------------------

/// The `~/.hanzo/settings.json` document (or a project overlay).
struct Settings {
    doc: Value,
}

impl Settings {
    /// Load global settings, overlaying a project `.hanzo-mcp.json` when a
    /// local scope + path are given.
    fn load(project_dir: Option<&str>) -> Self {
        let mut doc = read_json(&settings_path()).unwrap_or_else(|| json!({}));
        if let Some(dir) = project_dir {
            if let Some(project) = read_json(&Path::new(dir).join(".hanzo-mcp.json")) {
                if let (Some(base), Some(over)) =
                    (doc.get("enabled_tools").and_then(Value::as_object).cloned(), project.get("enabled_tools").and_then(Value::as_object))
                {
                    let mut merged = base;
                    for (k, v) in over {
                        merged.insert(k.clone(), v.clone());
                    }
                    if let Some(o) = doc.as_object_mut() {
                        o.insert("enabled_tools".into(), Value::Object(merged));
                    }
                }
            }
        }
        Self { doc }
    }

    fn enabled_tools(&self) -> Option<&Map<String, Value>> {
        self.doc.get("enabled_tools").and_then(Value::as_object)
    }

    /// Whether a tool is enabled; unset tools default to enabled.
    fn is_tool_enabled(&self, name: &str) -> bool {
        self.enabled_tools()
            .and_then(|m| m.get(name))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    fn get(&self, name: &str) -> Option<bool> {
        self.enabled_tools().and_then(|m| m.get(name)).and_then(Value::as_bool)
    }

    fn set(&mut self, name: &str, enabled: bool) {
        let map = self
            .doc
            .as_object_mut()
            .and_then(|o| o.entry("enabled_tools").or_insert_with(|| json!({})).as_object_mut());
        if let Some(map) = map {
            map.insert(name.to_string(), json!(enabled));
        }
    }

    /// Persist: to a project `.hanzo-mcp.json` when local+path, else to the
    /// global settings file. Returns the written path.
    fn save(&self, scope: &str, path: Option<&str>) -> Result<PathBuf> {
        let target = match (scope, path) {
            ("local", Some(dir)) => Path::new(dir).join(".hanzo-mcp.json"),
            _ => settings_path(),
        };
        write_json(&target, &self.doc)?;
        Ok(target)
    }
}

// ---------------------------------------------------------------------------
// config tool
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ConfigArgs {
    #[serde(default = "default_action")]
    action: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default = "default_scope")]
    scope: String,
    #[serde(default)]
    path: Option<String>,
}

fn default_action() -> String {
    "get".into()
}

fn default_scope() -> String {
    "local".into()
}

impl Default for ConfigArgs {
    fn default() -> Self {
        Self {
            action: default_action(),
            key: None,
            value: None,
            scope: default_scope(),
            path: None,
        }
    }
}

pub struct ConfigTool;

impl ConfigTool {
    pub fn new() -> Self {
        Self
    }

    pub fn schema() -> Value {
        json!({
            "name": "config",
            "description": "Git-style configuration. Actions: get (default), set, list, toggle.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["get", "set", "list", "toggle"], "description": "Action: get (default), set, list, toggle", "default": "get" },
                    "key": { "type": "string", "description": "Configuration key (e.g., tools.write.enabled, enabled_tools.write, index.scope)" },
                    "value": { "type": "string", "description": "Configuration value" },
                    "scope": { "type": "string", "enum": ["local", "global"], "description": "Config scope: local (project) or global", "default": "local" },
                    "path": { "type": "string", "description": "Path for project-specific config" }
                }
            }
        })
    }

    fn project_label(path: Option<&str>) -> &'static str {
        if path.is_some() {
            "project"
        } else {
            "global"
        }
    }

    fn handle_get(key: Option<&str>, scope: &str, path: Option<&str>) -> String {
        let key = match key {
            Some(k) if !k.is_empty() => k,
            _ => return "Error: key required for get action".into(),
        };
        let local = path.filter(|_| scope == "local");

        if key == "index.scope" {
            return format!("index.scope={}", IndexConfig::load().scope(local).as_str());
        }

        if let Some(tool) = tool_enabled_key(key) {
            return format!("{}={}", key, Settings::load(local).is_tool_enabled(tool));
        }

        if let Some(tool) = key.strip_prefix("enabled_tools.") {
            let settings = Settings::load(local);
            return match settings.get(tool) {
                Some(v) => format!("{}={}", key, v),
                None => format!("{}=unset", key),
            };
        }

        if let Some((tool, "enabled")) = split_once(key) {
            return format!("{}={}", key, IndexConfig::load().indexing_enabled(tool));
        }

        format!("Unknown key: {}", key)
    }

    fn handle_set(key: Option<&str>, value: Option<&str>, scope: &str, path: Option<&str>) -> String {
        let key = match key {
            Some(k) if !k.is_empty() => k,
            _ => return "Error: key required for set action".into(),
        };
        let value = match value {
            Some(v) => v,
            None => return "Error: value required for set action".into(),
        };
        let local = path.filter(|_| scope == "local");

        if key == "index.scope" {
            let new_scope = match Scope::parse(value) {
                Some(s) => s,
                None => return format!("Error: Invalid scope value '{}'. Valid: project, global, auto", value),
            };
            let mut index = IndexConfig::load();
            return match index.set_scope(new_scope, local) {
                Ok(()) => format!("Set {}={} ({})", key, value, Self::project_label(local)),
                Err(e) => format!("Error: {}", e),
            };
        }

        if let Some(tool) = tool_enabled_key(key).or_else(|| key.strip_prefix("enabled_tools.")) {
            let parsed = match parse_bool(value) {
                Some(b) => b,
                None => return "Error: value must be boolean (true/false)".into(),
            };
            let mut settings = Settings::load(local);
            settings.set(tool, parsed);
            return match settings.save(scope, local) {
                Ok(out) => format!("Set {}={} ({}: {})", key, parsed, Self::project_label(local), out.display()),
                Err(e) => format!("Error: {}", e),
            };
        }

        if let Some((tool, "enabled")) = split_once(key) {
            let parsed = match parse_bool(value) {
                Some(b) => b,
                None => return "Error: value must be boolean (true/false)".into(),
            };
            let mut index = IndexConfig::load();
            return match index.set_indexing_enabled(tool, parsed) {
                Ok(()) => format!("Set {}={}", key, parsed),
                Err(e) => format!("Error: {}", e),
            };
        }

        format!("Unknown key: {}", key)
    }

    fn handle_list(scope: &str, path: Option<&str>) -> String {
        let index = IndexConfig::load();
        let status = index.status();
        let local = path.filter(|_| scope == "local");

        let mut out = vec!["=== Configuration ===".to_string()];
        out.push(format!("\nDefault scope: {}", status["default_scope"].as_str().unwrap_or("auto")));

        if let Some(p) = path {
            out.push(format!("Current path scope: {}", index.scope(Some(p)).as_str()));
        }

        out.push(format!("\nProjects with custom config: {}", status["project_count"].as_u64().unwrap_or(0)));

        out.push("\nTool settings (indexing):".into());
        if let Some(tools) = status["tools"].as_object() {
            let mut names: Vec<&String> = tools.keys().collect();
            names.sort();
            for tool in names {
                let s = &tools[tool];
                out.push(format!("  {}:", tool));
                out.push(format!("    enabled: {}", s["enabled"].as_bool().unwrap_or(true)));
                out.push(format!("    per_project: {}", s["per_project"].as_bool().unwrap_or(true)));
            }
        }

        out.push("\nEnabled tools (execution):".into());
        let settings = Settings::load(local);
        if let Some(map) = settings.enabled_tools() {
            let mut names: Vec<&String> = map.keys().collect();
            names.sort();
            for name in names {
                out.push(format!("  {}: {}", name, map[name].as_bool().unwrap_or(true)));
            }
        }

        out.join("\n")
    }

    fn handle_toggle(key: Option<&str>, scope: &str, path: Option<&str>) -> String {
        let key = match key {
            Some(k) if !k.is_empty() => k,
            _ => return "Error: key required for toggle action".into(),
        };
        let local = path.filter(|_| scope == "local");

        if key == "index.scope" {
            let mut index = IndexConfig::load();
            return match index.toggle_scope(local) {
                Ok(s) => format!("Toggled index.scope to {}", s.as_str()),
                Err(e) => format!("Error: {}", e),
            };
        }

        if let Some(tool) = tool_enabled_key(key).or_else(|| key.strip_prefix("enabled_tools.")) {
            let mut settings = Settings::load(local);
            let next = !settings.is_tool_enabled(tool);
            settings.set(tool, next);
            return match settings.save(scope, local) {
                Ok(out) => format!("Toggled {} to {} ({}: {})", key, next, Self::project_label(local), out.display()),
                Err(e) => format!("Error: {}", e),
            };
        }

        if let Some((tool, "enabled")) = split_once(key) {
            let mut index = IndexConfig::load();
            let next = !index.indexing_enabled(tool);
            return match index.set_indexing_enabled(tool, next) {
                Ok(()) => format!("Toggled {} to {}", key, next),
                Err(e) => format!("Error: {}", e),
            };
        }

        format!("Cannot toggle key: {}", key)
    }
}

/// `tools.<name>.enabled` → `<name>`; anything else → None.
fn tool_enabled_key(key: &str) -> Option<&str> {
    let inner = key.strip_prefix("tools.")?.strip_suffix(".enabled")?;
    if inner.is_empty() || inner.contains('.') {
        None
    } else {
        Some(inner)
    }
}

/// Split a `<a>.<rest>` key on the first dot.
fn split_once(key: &str) -> Option<(&str, &str)> {
    key.split_once('.')
}

impl Default for ConfigTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for ConfigTool {
    fn name(&self) -> &str {
        "config"
    }
    fn description(&self) -> &str {
        "Git-style configuration. Actions: get (default), set, list, toggle."
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: ConfigArgs = serde_json::from_value(params).unwrap_or_default();
        let key = args.key.as_deref();
        let value = args.value.as_deref();
        let path = args.path.as_deref();
        let scope = args.scope.as_str();

        let message = match args.action.as_str() {
            "get" => Self::handle_get(key, scope, path),
            "set" => Self::handle_set(key, value, scope, path),
            "list" => Self::handle_list(scope, path),
            "toggle" => Self::handle_toggle(key, scope, path),
            other => {
                return Ok(ToolResult::ok(envelope_err(
                    "config",
                    other,
                    "INVALID_ACTION",
                    format!("Unknown action '{}'. Valid actions: get, set, list, toggle", other),
                )));
            }
        };

        Ok(ToolResult::ok(envelope_ok("config", &args.action, json!({ "message": message }))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_shape() {
        let s = ConfigTool::schema();
        assert_eq!(s["name"], "config");
        let props = &s["inputSchema"]["properties"];
        assert!(props.get("action").is_some());
        assert!(props.get("key").is_some());
        assert!(props.get("value").is_some());
        assert!(props.get("scope").is_some());
        assert!(props.get("path").is_some());
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(ConfigTool::new().name(), "config");
    }

    #[test]
    fn tool_enabled_key_parses() {
        assert_eq!(tool_enabled_key("tools.write.enabled"), Some("write"));
        assert_eq!(tool_enabled_key("tools..enabled"), None);
        assert_eq!(tool_enabled_key("tools.a.b.enabled"), None);
        assert_eq!(tool_enabled_key("enabled_tools.write"), None);
        assert_eq!(tool_enabled_key("index.scope"), None);
    }

    #[test]
    fn parse_bool_variants() {
        for t in ["true", "1", "YES", " on "] {
            assert_eq!(parse_bool(t), Some(true), "{t}");
        }
        for f in ["false", "0", "no", "OFF"] {
            assert_eq!(parse_bool(f), Some(false), "{f}");
        }
        assert_eq!(parse_bool("maybe"), None);
    }

    #[test]
    fn scope_roundtrip() {
        for s in [Scope::Project, Scope::Global, Scope::Auto] {
            assert_eq!(Scope::parse(s.as_str()), Some(s));
        }
        assert_eq!(Scope::parse("nope"), None);
    }

    #[test]
    fn index_defaults_scope_is_auto() {
        let doc = IndexConfig::defaults();
        let index = IndexConfig { doc };
        assert_eq!(index.default_scope(), Scope::Auto);
        assert!(index.indexing_enabled("vector"));
        assert!(index.indexing_enabled("unknown-tool"));
    }

    #[test]
    fn settings_default_enabled_is_true() {
        let settings = Settings { doc: json!({}) };
        assert!(settings.is_tool_enabled("write"));
        assert_eq!(settings.get("write"), None);
    }

    #[test]
    fn settings_set_and_get() {
        let mut settings = Settings { doc: json!({}) };
        settings.set("write", false);
        assert_eq!(settings.get("write"), Some(false));
        assert!(!settings.is_tool_enabled("write"));
    }

    #[test]
    fn get_requires_key() {
        assert!(ConfigTool::handle_get(None, "local", None).starts_with("Error: key required"));
    }

    #[test]
    fn set_rejects_bad_scope_value() {
        let out = ConfigTool::handle_set(Some("index.scope"), Some("bogus"), "local", None);
        assert!(out.contains("Invalid scope value"));
    }

    #[test]
    fn set_rejects_non_boolean_tool_flag() {
        let out = ConfigTool::handle_set(Some("tools.write.enabled"), Some("maybe"), "local", None);
        assert!(out.contains("must be boolean"));
    }

    #[tokio::test]
    async fn execute_unknown_action_errs() {
        let out = ConfigTool::new()
            .execute(json!({ "action": "frobnicate" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "INVALID_ACTION");
    }

    #[tokio::test]
    async fn execute_get_index_scope_envelope() {
        let out = ConfigTool::new()
            .execute(json!({ "action": "get", "key": "index.scope" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true);
        assert!(out.content["data"]["message"].as_str().unwrap().starts_with("index.scope="));
    }
}
