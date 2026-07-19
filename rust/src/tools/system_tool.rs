//! System tools (HIP-0300).
//!
//! One action-routed tool for the built-in system surface that the Python SDK
//! registers via `_register_system_tools`:
//!
//! - `version` → hanzo-mcp version + runtime/platform info
//! - `stats`   → system resources (cpu, memory, load) + Hanzo directories
//! - `tool`    → unified tool management (list/status/enable/disable)
//!
//! The three Python tools (`version_tool`, `stats`, unified `tool`) collapse to
//! ONE `system` tool keyed on `action`, matching the action-routed shape of the
//! rest of the Rust surface.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{envelope_err, envelope_ok, list_tools};
use crate::{MCPTool, ToolResult};

/// Tools that may never be disabled (mirrors the Python critical set).
const CRITICAL: &[&str] = &["system", "tool", "version", "stats", "config", "mode"];

/// Cloud-backed tool names exposed alongside the local HIP-0300 surface.
const CLOUD_TOOLS: &[&str] =
    &["code_search", "code_context", "code_ask", "code_index", "web_search", "web_read", "vision"];

#[derive(Debug, Default, Deserialize)]
struct SystemArgs {
    action: Option<String>,
    /// Tool name for status/enable/disable.
    name: Option<String>,
    /// Persist enable/disable changes to disk (default true).
    persist: Option<bool>,
    /// Filter `tool list` by category.
    category: Option<String>,
    /// `tool list`: show only disabled tools.
    #[serde(default)]
    disabled: bool,
    /// `tool list`: show only enabled tools.
    #[serde(default)]
    enabled: bool,
}

pub struct SystemTool;

impl SystemTool {
    pub fn new() -> Self {
        Self
    }

    pub fn schema() -> Value {
        json!({
            "name": "system",
            "description": "System tools: version (runtime + platform), stats (cpu/memory/load usage), tool (unified tool management: list/status/enable/disable).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["version", "stats", "tool"],
                        "description": "version | stats | tool"
                    },
                    "name": { "type": "string", "description": "Tool name (tool status/enable/disable)" },
                    "persist": { "type": "boolean", "description": "Persist enable/disable to ~/.hanzo/mcp/tool_states.json (default true)" },
                    "category": { "type": "string", "description": "Filter tool list by category" },
                    "disabled": { "type": "boolean", "description": "tool list: show only disabled" },
                    "enabled": { "type": "boolean", "description": "tool list: show only enabled" },
                    "tool_action": {
                        "type": "string",
                        "enum": ["list", "status", "enable", "disable"],
                        "description": "Sub-action when action=tool (default list)"
                    }
                },
                "required": ["action"]
            }
        })
    }

    // --- version -----------------------------------------------------------

    fn version(&self) -> Value {
        let data = json!({
            "hanzo_mcp": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
            "async": "tokio",
        });
        envelope_ok("system", "version", data)
    }

    // --- stats -------------------------------------------------------------

    fn stats(&self) -> Value {
        let mut warnings: Vec<String> = Vec::new();

        let cpu_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
        let load = load_average();
        if let Some(one) = load.as_ref().and_then(|l| l.first().copied()) {
            if cpu_cores > 0 && one > cpu_cores as f64 {
                warnings.push(format!("high load: {:.2} over {} cores", one, cpu_cores));
            }
        }

        let mem = memory_info();
        if let Some(m) = &mem {
            if m.percent > 90.0 {
                warnings.push(format!("high memory usage: {:.0}%", m.percent));
            }
        }

        let hanzo_dir = home().map(|h| h.join(".hanzo"));
        let logs_mb = hanzo_dir.as_ref().map(|d| dir_size_mb(&d.join("logs")));
        let db_mb = hanzo_dir.as_ref().map(|d| dir_size_mb(&d.join("db")));
        if let Some(mb) = logs_mb {
            if mb > 100.0 {
                warnings.push(format!("large log directory: {:.1} MB", mb));
            }
        }

        let data = json!({
            "time": chrono::Local::now().to_rfc3339(),
            "system": {
                "cpu_cores": cpu_cores,
                "load_average": load,
                "memory": mem.as_ref().map(MemoryInfo::to_json),
            },
            "hanzo": {
                "dir": hanzo_dir.as_ref().map(|d| d.display().to_string()),
                "logs_mb": logs_mb,
                "db_mb": db_mb,
            },
            "tools": {
                "local": list_tools().len(),
                "cloud": CLOUD_TOOLS.len(),
            },
            "warnings": warnings,
            "healthy": warnings.is_empty(),
        });
        envelope_ok("system", "stats", data)
    }

    // --- tool (unified management) ----------------------------------------

    fn states_path() -> Option<PathBuf> {
        home().map(|h| h.join(".hanzo").join("mcp").join("tool_states.json"))
    }

    fn load_states() -> BTreeMap<String, bool> {
        Self::states_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_states(states: &BTreeMap<String, bool>) -> Result<()> {
        let path = Self::states_path()
            .ok_or_else(|| anyhow::anyhow!("cannot resolve home directory"))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(states)?)?;
        Ok(())
    }

    fn is_enabled(states: &BTreeMap<String, bool>, name: &str) -> bool {
        *states.get(name).unwrap_or(&true)
    }

    /// The full tool surface: local HIP-0300 tools + cloud-backed tools.
    fn surface() -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = list_tools()
            .into_iter()
            .map(|t| (t.name, format!("{:?}", t.category)))
            .collect();
        for c in CLOUD_TOOLS {
            out.push((c.to_string(), "Cloud".to_string()));
        }
        out
    }

    fn tool(&self, args: &SystemArgs, tool_action: &str) -> Value {
        match tool_action {
            "list" => self.tool_list(args),
            "status" => self.tool_status(args),
            "enable" => self.tool_enable(args),
            "disable" => self.tool_disable(args),
            other => envelope_err(
                "system",
                "tool",
                "INVALID_ARGS",
                format!("unknown tool action: {}. Use list|status|enable|disable", other),
            ),
        }
    }

    fn tool_list(&self, args: &SystemArgs) -> Value {
        let states = Self::load_states();
        let mut items: Vec<Value> = Vec::new();
        let (mut total, mut enabled_count) = (0usize, 0usize);

        for (name, category) in Self::surface() {
            if let Some(filter) = &args.category {
                if !category.eq_ignore_ascii_case(filter) {
                    continue;
                }
            }
            let is_enabled = Self::is_enabled(&states, &name);
            if args.disabled && is_enabled {
                continue;
            }
            if args.enabled && !is_enabled {
                continue;
            }
            total += 1;
            if is_enabled {
                enabled_count += 1;
            }
            items.push(json!({ "name": name, "category": category, "enabled": is_enabled }));
        }

        envelope_ok(
            "system",
            "tool",
            json!({
                "action": "list",
                "tools": items,
                "total": total,
                "enabled": enabled_count,
                "disabled": total - enabled_count,
            }),
        )
    }

    fn tool_status(&self, args: &SystemArgs) -> Value {
        let name = match &args.name {
            Some(n) if !n.trim().is_empty() => n,
            _ => return envelope_err("system", "tool", "INVALID_ARGS", "name required for status"),
        };
        let found = Self::surface().into_iter().find(|(n, _)| n == name);
        match found {
            None => envelope_err("system", "tool", "NOT_FOUND", format!("tool '{}' not found", name)),
            Some((_, category)) => {
                let states = Self::load_states();
                envelope_ok(
                    "system",
                    "tool",
                    json!({
                        "action": "status",
                        "name": name,
                        "category": category,
                        "enabled": Self::is_enabled(&states, name),
                        "critical": CRITICAL.contains(&name.as_str()),
                    }),
                )
            }
        }
    }

    fn tool_enable(&self, args: &SystemArgs) -> Value {
        let name = match &args.name {
            Some(n) if !n.trim().is_empty() => n.clone(),
            _ => return envelope_err("system", "tool", "INVALID_ARGS", "name required for enable"),
        };
        let persist = args.persist.unwrap_or(true);
        let mut states = Self::load_states();
        if Self::is_enabled(&states, &name) {
            return envelope_ok("system", "tool", json!({ "action": "enable", "name": name, "changed": false, "enabled": true }));
        }
        states.insert(name.clone(), true);
        if persist {
            if let Err(e) = Self::save_states(&states) {
                return envelope_err("system", "tool", "PERSIST", e.to_string());
            }
        }
        envelope_ok("system", "tool", json!({ "action": "enable", "name": name, "changed": true, "enabled": true, "persisted": persist }))
    }

    fn tool_disable(&self, args: &SystemArgs) -> Value {
        let name = match &args.name {
            Some(n) if !n.trim().is_empty() => n.clone(),
            _ => return envelope_err("system", "tool", "INVALID_ARGS", "name required for disable"),
        };
        if CRITICAL.contains(&name.as_str()) {
            return envelope_err("system", "tool", "FORBIDDEN", format!("cannot disable critical tool '{}'", name));
        }
        let persist = args.persist.unwrap_or(true);
        let mut states = Self::load_states();
        if !Self::is_enabled(&states, &name) {
            return envelope_ok("system", "tool", json!({ "action": "disable", "name": name, "changed": false, "enabled": false }));
        }
        states.insert(name.clone(), false);
        if persist {
            if let Err(e) = Self::save_states(&states) {
                return envelope_err("system", "tool", "PERSIST", e.to_string());
            }
        }
        envelope_ok("system", "tool", json!({ "action": "disable", "name": name, "changed": true, "enabled": false, "persisted": persist }))
    }
}

impl Default for SystemTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for SystemTool {
    fn name(&self) -> &str {
        "system"
    }
    fn description(&self) -> &str {
        "System tools: version, stats (usage), tool (unified tool management)"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let tool_action = params
            .get("tool_action")
            .and_then(|v| v.as_str())
            .unwrap_or("list")
            .to_string();
        let args: SystemArgs = serde_json::from_value(params).unwrap_or_default();
        let action = args.action.clone().unwrap_or_else(|| "version".to_string());
        let out = match action.as_str() {
            "version" => self.version(),
            "stats" => self.stats(),
            "tool" => self.tool(&args, &tool_action),
            other => envelope_err(
                "system",
                "unknown",
                "INVALID_ARGS",
                format!("unknown action: {}. Use version|stats|tool", other),
            ),
        };
        Ok(ToolResult::ok(out))
    }
}

// ---------------------------------------------------------------------------
// Portable system probes (std + /proc on Linux, graceful fallback elsewhere)
// ---------------------------------------------------------------------------

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// 1/5/15-minute load average from /proc/loadavg (Linux); None elsewhere.
fn load_average() -> Option<Vec<f64>> {
    let text = fs::read_to_string("/proc/loadavg").ok()?;
    let nums: Vec<f64> = text
        .split_whitespace()
        .take(3)
        .filter_map(|s| s.parse().ok())
        .collect();
    if nums.len() == 3 {
        Some(nums)
    } else {
        None
    }
}

struct MemoryInfo {
    total_gb: f64,
    used_gb: f64,
    percent: f64,
}

impl MemoryInfo {
    fn to_json(&self) -> Value {
        json!({
            "total_gb": round1(self.total_gb),
            "used_gb": round1(self.used_gb),
            "percent": round1(self.percent),
        })
    }
}

/// Memory usage parsed from /proc/meminfo (Linux); None elsewhere.
fn memory_info() -> Option<MemoryInfo> {
    let text = fs::read_to_string("/proc/meminfo").ok()?;
    let mut total_kb = 0f64;
    let mut avail_kb = 0f64;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("");
        let val: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        match key {
            "MemTotal:" => total_kb = val,
            "MemAvailable:" => avail_kb = val,
            _ => {}
        }
    }
    if total_kb <= 0.0 {
        return None;
    }
    let used_kb = (total_kb - avail_kb).max(0.0);
    Some(MemoryInfo {
        total_gb: total_kb / (1024.0 * 1024.0),
        used_gb: used_kb / (1024.0 * 1024.0),
        percent: used_kb / total_kb * 100.0,
    })
}

/// Recursive directory size in MB; 0.0 when the path is absent.
fn dir_size_mb(path: &std::path::Path) -> f64 {
    if !path.exists() {
        return 0.0;
    }
    let bytes: u64 = walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum();
    bytes as f64 / (1024.0 * 1024.0)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_shape() {
        let s = SystemTool::schema();
        assert_eq!(s["name"], "system");
        assert_eq!(s["inputSchema"]["required"][0], "action");
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(SystemTool::new().name(), "system");
    }

    #[tokio::test]
    async fn version_reports_platform() {
        let out = SystemTool::new().execute(json!({ "action": "version" })).await.unwrap();
        assert_eq!(out.content["ok"], true);
        assert_eq!(out.content["data"]["hanzo_mcp"], env!("CARGO_PKG_VERSION"));
        assert_eq!(out.content["data"]["arch"], std::env::consts::ARCH);
    }

    #[tokio::test]
    async fn stats_reports_cpu_and_tools() {
        let out = SystemTool::new().execute(json!({ "action": "stats" })).await.unwrap();
        assert_eq!(out.content["ok"], true);
        assert!(out.content["data"]["system"]["cpu_cores"].as_u64().unwrap() >= 1);
        assert_eq!(out.content["data"]["tools"]["local"], list_tools().len());
    }

    #[tokio::test]
    async fn tool_list_returns_surface() {
        let out = SystemTool::new()
            .execute(json!({ "action": "tool", "tool_action": "list" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true);
        let total = out.content["data"]["total"].as_u64().unwrap();
        assert_eq!(total as usize, list_tools().len() + CLOUD_TOOLS.len());
    }

    #[tokio::test]
    async fn cannot_disable_critical_tool() {
        let out = SystemTool::new()
            .execute(json!({ "action": "tool", "tool_action": "disable", "name": "system", "persist": false }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "FORBIDDEN");
    }

    #[tokio::test]
    async fn status_requires_name() {
        let out = SystemTool::new()
            .execute(json!({ "action": "tool", "tool_action": "status" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "INVALID_ARGS");
    }

    #[tokio::test]
    async fn status_of_known_tool() {
        let out = SystemTool::new()
            .execute(json!({ "action": "tool", "tool_action": "status", "name": "fs" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true);
        assert_eq!(out.content["data"]["name"], "fs");
        assert_eq!(out.content["data"]["enabled"], true);
    }
}
