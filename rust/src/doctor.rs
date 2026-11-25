//! `hanzo-mcp doctor` and `hanzo-mcp install <client>` — setup, self-repair,
//! and end-to-end diagnostics for MCP registration, ZAP router, native
//! messaging, and live Chrome extension connectivity.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::native::{self, NativeHostStatus};
use crate::tools::browser_tool::{diagnose_error, BrowserDiagnostic};
use crate::zap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRegistration {
    pub client: String,
    pub config_path: String,
    pub registered: bool,
    pub command: Option<String>,
    pub browser_backend: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZapDiagnostic {
    pub socket_path: String,
    pub socket_exists: bool,
    pub lock_holder_pid: Option<u32>,
    pub reachable: bool,
    pub total_nodes: usize,
    pub browser_nodes: Vec<Value>,
    pub error: Option<String>,
    pub diagnostic: Option<BrowserDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionProbe {
    pub connected: bool,
    pub provider: Option<String>,
    pub product: Option<String>,
    pub tab_count: Option<usize>,
    pub error: Option<String>,
    pub diagnostic: Option<BrowserDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorReport {
    pub healthy: bool,
    pub version: String,
    pub binary: String,
    pub clients: Vec<ClientRegistration>,
    pub native_hosts: Vec<NativeHostStatus>,
    pub zap: ZapDiagnostic,
    pub extension: ExtensionProbe,
    pub repaired_manifests: Vec<String>,
    pub recommendations: Vec<String>,
}

/// Inspect MCP client configs under `home`.
pub fn inspect_clients(home: &Path) -> Vec<ClientRegistration> {
    vec![
        inspect_codex(home),
        inspect_json_client(
            "antigravity",
            home.join(".gemini/config/mcp_config.json"),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "claude",
            home.join(".claude.json"),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "cursor",
            home.join(".cursor/mcp.json"),
            &["mcpServers", "hanzo"],
        ),
    ]
}

fn inspect_codex(home: &Path) -> ClientRegistration {
    let path = home.join(".codex/config.toml");
    let path_str = path.display().to_string();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ClientRegistration {
            client: "codex".into(),
            config_path: path_str,
            registered: false,
            command: None,
            browser_backend: None,
            detail: "config.toml not found (run `hanzo mcp install codex`)".into(),
        };
    };
    let parsed: Result<toml::Value, _> = toml::from_str(&raw);
    let Ok(doc) = parsed else {
        return ClientRegistration {
            client: "codex".into(),
            config_path: path_str,
            registered: false,
            command: None,
            browser_backend: None,
            detail: "config.toml failed to parse".into(),
        };
    };
    let hanzo = doc.get("mcp_servers").and_then(|s| s.get("hanzo"));
    let Some(h) = hanzo else {
        return ClientRegistration {
            client: "codex".into(),
            config_path: path_str,
            registered: false,
            command: None,
            browser_backend: None,
            detail: "[mcp_servers.hanzo] not configured (run `hanzo mcp install codex`)".into(),
        };
    };
    let command = h.get("command").and_then(toml::Value::as_str).map(String::from);
    let backend = h
        .get("env")
        .and_then(|e| e.get("BROWSER_BACKEND"))
        .and_then(toml::Value::as_str)
        .map(String::from);
    let enabled = h.get("enabled").and_then(toml::Value::as_bool).unwrap_or(true);
    let detail = if !enabled {
        "configured but disabled".into()
    } else if command.as_deref() == Some("npx") {
        "configured via npx (run `hanzo mcp install codex` to pin local native binary)".into()
    } else {
        "configured".into()
    };
    ClientRegistration {
        client: "codex".into(),
        config_path: path_str,
        registered: enabled,
        command,
        browser_backend: backend,
        detail,
    }
}

fn inspect_json_client(client: &str, path: PathBuf, keys: &[&str]) -> ClientRegistration {
    let path_str = path.display().to_string();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            command: None,
            browser_backend: None,
            detail: "config not found".into(),
        };
    };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            command: None,
            browser_backend: None,
            detail: "invalid JSON".into(),
        };
    };
    let mut cur = &doc;
    for k in keys {
        match cur.get(*k) {
            Some(v) => cur = v,
            None => {
                return ClientRegistration {
                    client: client.into(),
                    config_path: path_str,
                    registered: false,
                    command: None,
                    browser_backend: None,
                    detail: "hanzo MCP server not registered".into(),
                };
            }
        }
    }
    let command = cur
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| cur.get("serverUrl").and_then(Value::as_str))
        .map(String::from);
    let backend = cur
        .get("env")
        .and_then(|e| e.get("BROWSER_BACKEND"))
        .and_then(Value::as_str)
        .map(String::from);
    let missing_bin = command
        .as_deref()
        .is_some_and(|c| c.starts_with('/') && !Path::new(c).exists());
    ClientRegistration {
        client: client.into(),
        config_path: path_str,
        registered: !missing_bin,
        command,
        browser_backend: backend,
        detail: if missing_bin {
            "configured binary does not exist".into()
        } else {
            "configured".into()
        },
    }
}

/// Run full doctor diagnostics (MCP registration, ZAP router, native messaging,
/// and live Chrome extension connectivity + tab discovery).
pub async fn run_doctor(fix: bool) -> Result<DoctorReport> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "hanzo-mcp".into());

    let mut repaired_manifests = Vec::new();
    if fix {
        if let Ok(rep) = native::repair() {
            repaired_manifests = rep.repaired.into_iter().map(|p| p.display().to_string()).collect();
        }
    }

    let clients = inspect_clients(&home);
    let native_hosts = native::diagnose().unwrap_or_default();

    // Stand for/join the ZAP router so we can inspect active nodes and probe Chrome.
    let sock_path = zapd::socket_path();
    let node = zap::seat();
    let (zap_diag, ext_probe) = match node.nodes(Duration::from_secs(3)).await {
        Ok(nodes) => {
            let browsers: Vec<Value> = nodes
                .iter()
                .filter(|n| n.id.starts_with(zap::BROWSER))
                .map(zap::describe)
                .collect();
            let first_provider = browsers
                .first()
                .and_then(|b| b.get("id").and_then(Value::as_str))
                .map(String::from);
            let zap_diag = ZapDiagnostic {
                socket_path: sock_path.display().to_string(),
                socket_exists: sock_path.exists(),
                lock_holder_pid: zapd::holder(),
                reachable: true,
                total_nodes: nodes.len(),
                browser_nodes: browsers,
                error: None,
                diagnostic: None,
            };
            let ext_probe = if let Some(provider) = first_provider {
                probe_extension(&provider).await
            } else {
                let err = zap::UNPAIRED.to_string();
                let diag = diagnose_error(&err);
                ExtensionProbe {
                    connected: false,
                    provider: None,
                    product: None,
                    tab_count: None,
                    error: Some(err),
                    diagnostic: Some(diag),
                }
            };
            (zap_diag, ext_probe)
        }
        Err(e) => {
            let err = e.to_string();
            let diag = diagnose_error(&err);
            let zap_diag = ZapDiagnostic {
                socket_path: sock_path.display().to_string(),
                socket_exists: sock_path.exists(),
                lock_holder_pid: zapd::holder(),
                reachable: false,
                total_nodes: 0,
                browser_nodes: vec![],
                error: Some(err.clone()),
                diagnostic: Some(diag.clone()),
            };
            let ext_probe = ExtensionProbe {
                connected: false,
                provider: None,
                product: None,
                tab_count: None,
                error: Some(err),
                diagnostic: Some(diag),
            };
            (zap_diag, ext_probe)
        }
    };

    let mut recommendations = Vec::new();
    let bad_hosts = native_hosts.iter().filter(|h| h.status != "ok").count();
    if bad_hosts > 0 {
        recommendations.push("Run `hanzo mcp doctor --fix` to self-repair missing or broken browser native messaging manifests.".into());
    }
    if clients.iter().all(|c| !c.registered) {
        recommendations.push("No MCP client configured yet — run `hanzo mcp install codex` (or configure your client).".into());
    }
    if !ext_probe.connected {
        if let Some(d) = &ext_probe.diagnostic {
            recommendations.push(format!("[{}] {}", d.category, d.hint));
        }
    }

    let healthy = zap_diag.reachable && bad_hosts == 0 && ext_probe.connected;
    Ok(DoctorReport {
        healthy,
        version: env!("CARGO_PKG_VERSION").into(),
        binary: exe,
        clients,
        native_hosts,
        zap: zap_diag,
        extension: ext_probe,
        repaired_manifests,
        recommendations,
    })
}

async fn probe_extension(provider: &str) -> ExtensionProbe {
    let product = match zap::route(provider, "Browser.getVersion", &[], Duration::from_secs(3)).await {
        Ok(raw) if !raw.starts_with("ERR:") => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.get("product").and_then(Value::as_str).map(String::from))
            .or(Some(raw)),
        Ok(err) => {
            let clean = err.trim_start_matches("ERR:").to_string();
            let diag = diagnose_error(&clean);
            return ExtensionProbe {
                connected: false,
                provider: Some(provider.to_string()),
                product: None,
                tab_count: None,
                error: Some(clean),
                diagnostic: Some(diag),
            };
        }
        Err(e) => {
            let err = e.to_string();
            let diag = diagnose_error(&err);
            return ExtensionProbe {
                connected: false,
                provider: Some(provider.to_string()),
                product: None,
                tab_count: None,
                error: Some(err),
                diagnostic: Some(diag),
            };
        }
    };

    match zap::route(provider, "Target.getTargets", &[], Duration::from_secs(3)).await {
        Ok(raw) if !raw.starts_with("ERR:") => {
            let tab_count = serde_json::from_str::<Value>(&raw).ok().and_then(|v| {
                v.get("targetInfos")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .or_else(|| v.as_array().map(Vec::len))
            });
            ExtensionProbe {
                connected: true,
                provider: Some(provider.to_string()),
                product,
                tab_count,
                error: None,
                diagnostic: None,
            }
        }
        Ok(err) => {
            let clean = err.trim_start_matches("ERR:").to_string();
            let diag = diagnose_error(&clean);
            ExtensionProbe {
                connected: false,
                provider: Some(provider.to_string()),
                product,
                tab_count: None,
                error: Some(clean),
                diagnostic: Some(diag),
            }
        }
        Err(e) => {
            let err = e.to_string();
            let diag = diagnose_error(&err);
            ExtensionProbe {
                connected: false,
                provider: Some(provider.to_string()),
                product,
                tab_count: None,
                error: Some(err),
                diagnostic: Some(diag),
            }
        }
    }
}

/// Format a human-readable doctor summary.
pub fn format_doctor(r: &DoctorReport) -> String {
    let mut out = Vec::new();
    let status = if r.healthy { "OK" } else { "ISSUES FOUND" };
    out.push(format!("Hanzo MCP Doctor — {status} (hanzo-mcp v{})", r.version));
    out.push(format!("  Binary: {}", r.binary));
    out.push(String::new());

    out.push("MCP Clients:".into());
    for c in &r.clients {
        let mark = if c.registered { "✓" } else { "·" };
        let cmd = c.command.as_deref().unwrap_or("-");
        out.push(format!("  {mark} {:<12} {}  ({}) [{}]", c.client, c.detail, cmd, c.config_path));
    }
    out.push(String::new());

    out.push("Native Messaging Hosts (ai.hanzo.zap):".into());
    if r.native_hosts.is_empty() {
        out.push("  · no supported browser profile directories found".into());
    } else {
        for h in &r.native_hosts {
            let mark = if h.status == "ok" { "✓" } else { "✗" };
            out.push(format!("  {mark} {:<14} {:<16} {} ({})", h.browser, h.status, h.detail, h.manifest_path));
        }
    }
    if !r.repaired_manifests.is_empty() {
        out.push(format!("  Repaired {} manifest(s): {}", r.repaired_manifests.len(), r.repaired_manifests.join(", ")));
    }
    out.push(String::new());

    out.push("ZAP Router:".into());
    let zmark = if r.zap.reachable { "✓" } else { "✗" };
    out.push(format!(
        "  {zmark} socket={} exists={} pid={:?} nodes={} browsers={}",
        r.zap.socket_path,
        r.zap.socket_exists,
        r.zap.lock_holder_pid,
        r.zap.total_nodes,
        r.zap.browser_nodes.len()
    ));
    if let Some(err) = &r.zap.error {
        let cat = r.zap.diagnostic.as_ref().map_or("unknown", |d| d.category.as_str());
        out.push(format!("    error [{cat}]: {err}"));
    }
    out.push(String::new());

    out.push("Browser Extension:".into());
    if r.extension.connected {
        out.push(format!(
            "  ✓ connected provider={} product={} tabs={}",
            r.extension.provider.as_deref().unwrap_or("-"),
            r.extension.product.as_deref().unwrap_or("unknown"),
            r.extension.tab_count.map_or("?".into(), |n| n.to_string()),
        ));
    } else {
        let cat = r.extension.diagnostic.as_ref().map_or("unknown", |d| d.category.as_str());
        out.push(format!(
            "  ✗ not connected [{cat}]: {}",
            r.extension.error.as_deref().unwrap_or("no browser connected")
        ));
    }

    if !r.recommendations.is_empty() {
        out.push(String::new());
        out.push("Next steps:".into());
        for rec in &r.recommendations {
            out.push(format!("  - {rec}"));
        }
    }

    out.join("\n")
}

/// Configure a supported MCP client (`codex`, `antigravity`, `cursor`, `claude`)
/// and self-repair browser native messaging registration.
pub fn run_install(target: &str, binary: Option<PathBuf>, dry_run: bool) -> Result<Value> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let exe = match binary {
        Some(p) => p,
        None => std::env::current_exe()?,
    };
    install_in(&home, target, &exe, dry_run)
}

pub fn install_in(home: &Path, target: &str, exe: &Path, dry_run: bool) -> Result<Value> {
    let client = target.trim().to_lowercase();
    let result = match client.as_str() {
        "codex" => install_codex_in(home, exe, dry_run)?,
        "antigravity" | "gemini" => install_json_client_in(
            "antigravity",
            home.join(".gemini/config/mcp_config.json"),
            exe,
            dry_run,
        )?,
        "cursor" => install_json_client_in("cursor", home.join(".cursor/mcp.json"), exe, dry_run)?,
        "claude" | "claude-code" => {
            install_json_client_in("claude", home.join(".claude.json"), exe, dry_run)?
        }
        other => {
            return Err(anyhow!(
                "Unknown install target {other:?}. Supported targets: codex, antigravity, cursor, claude"
            ));
        }
    };

    let repaired = if dry_run {
        Vec::new()
    } else {
        #[cfg(unix)]
        {
            native::repair_in(home, exe)
                .map(|r| r.repaired.into_iter().map(|p| p.display().to_string()).collect())
                .unwrap_or_default()
        }
        #[cfg(windows)]
        {
            native::repair()
                .map(|r| r.repaired.into_iter().map(|p| p.display().to_string()).collect())
                .unwrap_or_default()
        }
    };

    let mut out = result;
    out["native_hosts_repaired"] = json!(repaired);
    Ok(out)
}

/// Idempotently configure `~/.codex/config.toml` with `[mcp_servers.hanzo]`,
/// preserving all other user tables and settings.
pub fn install_codex_in(home: &Path, exe: &Path, dry_run: bool) -> Result<Value> {
    let path = home.join(".codex/config.toml");
    let mut doc: toml::Table = if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        toml::from_str(&raw).map_err(|e| anyhow!("failed to parse {}: {e}", path.display()))?
    } else {
        toml::Table::new()
    };

    let servers = doc
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| anyhow!("`mcp_servers` in {} is not a table", path.display()))?;

    let mut hanzo = toml::Table::new();
    hanzo.insert("command".into(), toml::Value::String(exe.display().to_string()));
    hanzo.insert(
        "args".into(),
        toml::Value::Array(vec![
            toml::Value::String("--transport".into()),
            toml::Value::String("stdio".into()),
        ]),
    );
    hanzo.insert("enabled".into(), toml::Value::Boolean(true));
    hanzo.insert("startup_timeout_sec".into(), toml::Value::Integer(30));
    hanzo.insert("tool_timeout_sec".into(), toml::Value::Integer(120));

    let mut env = toml::Table::new();
    env.insert("BROWSER_BACKEND".into(), toml::Value::String("extension".into()));
    hanzo.insert("env".into(), toml::Value::Table(env));

    servers.insert("hanzo".into(), toml::Value::Table(hanzo));

    let rendered = toml::to_string_pretty(&doc)?;
    if !dry_run {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &rendered)?;
    }

    Ok(json!({
        "success": true,
        "client": "codex",
        "config_path": path.display().to_string(),
        "command": exe.display().to_string(),
        "args": ["--transport", "stdio"],
        "browser_backend": "extension",
        "dry_run": dry_run,
    }))
}

fn install_json_client_in(client: &str, path: PathBuf, exe: &Path, dry_run: bool) -> Result<Value> {
    let mut doc: Value = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&path)?)
            .map_err(|e| anyhow!("failed to parse {}: {e}", path.display()))?
    } else {
        json!({})
    };

    let root = doc
        .as_object_mut()
        .ok_or_else(|| anyhow!("{} root is not a JSON object", path.display()))?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow!("`mcpServers` in {} is not an object", path.display()))?;

    servers.insert(
        "hanzo".into(),
        json!({
            "command": exe.display().to_string(),
            "args": ["--transport", "stdio"],
            "env": {
                "BROWSER_BACKEND": "extension"
            }
        }),
    );

    if !dry_run {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(&doc)? + "\n")?;
    }

    Ok(json!({
        "success": true,
        "client": client,
        "config_path": path.display().to_string(),
        "command": exe.display().to_string(),
        "args": ["--transport", "stdio"],
        "browser_backend": "extension",
        "dry_run": dry_run,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_codex_creates_and_preserves_other_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let codex_dir = home.join(".codex");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(
            codex_dir.join("config.toml"),
            "[tui]\nscreen_reader_detection_done = true\n\n[mcp_servers.other]\ncommand = \"other-mcp\"\n",
        )
        .unwrap();

        let exe = std::env::current_exe().unwrap();
        let res = install_in(home, "codex", &exe, false).unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["client"], "codex");

        let raw = std::fs::read_to_string(codex_dir.join("config.toml")).unwrap();
        let doc: toml::Value = toml::from_str(&raw).unwrap();
        assert_eq!(doc["tui"]["screen_reader_detection_done"].as_bool(), Some(true));
        assert_eq!(doc["mcp_servers"]["other"]["command"].as_str(), Some("other-mcp"));
        assert_eq!(
            doc["mcp_servers"]["hanzo"]["command"].as_str(),
            Some(exe.to_str().unwrap())
        );
        assert_eq!(
            doc["mcp_servers"]["hanzo"]["env"]["BROWSER_BACKEND"].as_str(),
            Some("extension")
        );

        let clients = inspect_clients(home);
        let codex = clients.iter().find(|c| c.client == "codex").unwrap();
        assert!(codex.registered);
        assert_eq!(codex.browser_backend.as_deref(), Some("extension"));
    }
}
