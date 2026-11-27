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
use crate::tools::computer_tool;
use crate::zap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRegistration {
    pub client: String,
    pub config_path: String,
    pub registered: bool,
    pub computer_enabled: bool,
    pub command: Option<String>,
    pub browser_backend: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerDiagnostic {
    pub platform: String,
    pub native_available: bool,
    pub screen_size: Option<(i32, i32)>,
    pub accessibility_granted: Option<bool>,
    pub screen_recording_granted: Option<bool>,
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
    pub computer: ComputerDiagnostic,
    pub clients: Vec<ClientRegistration>,
    pub native_hosts: Vec<NativeHostStatus>,
    pub zap: ZapDiagnostic,
    pub extension: ExtensionProbe,
    pub repaired_manifests: Vec<String>,
    pub recommendations: Vec<String>,
}

/// Platform-specific Claude Desktop MCP config path under `home`.
fn claude_desktop_path(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Claude/claude_desktop_config.json")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home.join(".config/Claude/claude_desktop_config.json")
    }
}

/// Returns true if a client's MCP server command + args expose the native `computer` tool.
fn args_allow_computer(command: Option<&str>, args: &[String]) -> (bool, Option<&'static str>) {
    let cmd = command.unwrap_or("");
    let base = Path::new(cmd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd);
    if base == "uvx" {
        return (
            false,
            Some("uses legacy uvx wrapper (run `hanzo mcp install all` to pin native hanzo-mcp with computer control)"),
        );
    }
    // Check for `--tools=...` or `--tools <list>` excluding `computer`.
    for (idx, a) in args.iter().enumerate() {
        let list = if let Some(rest) = a.strip_prefix("--tools=") {
            Some(rest)
        } else if a == "--tools" {
            args.get(idx + 1).map(String::as_str)
        } else {
            None
        };
        if let Some(csv) = list {
            let has_computer = csv
                .split(',')
                .any(|t| matches!(t.trim(), "computer" | "all" | "*"));
            if !has_computer {
                return (
                    false,
                    Some("`--tools` filter omits `computer` (remove filter or include `computer`)"),
                );
            }
        }
    }
    if base == "npx" {
        return (
            true,
            Some("configured via npx (run `hanzo mcp install all` to pin local native binary)"),
        );
    }
    (true, None)
}

/// Probe native local computer control readiness and OS permissions.
pub fn inspect_computer() -> ComputerDiagnostic {
    let (info, size) = computer_tool::probe_capabilities();
    let ax = info.backends.get("accessibility").copied();
    let screen = info.backends.get("screen_recording").copied();
    let detail = match (info.native_available, ax, screen) {
        (false, _, _) => format!("native backend unavailable on {}", info.platform),
        (true, Some(false), Some(false)) => {
            "native Quartz ready, but Accessibility & Screen Recording permissions are not granted".into()
        }
        (true, Some(false), _) => {
            "native Quartz ready, but Accessibility permission is not granted (needed for input/windows)".into()
        }
        (true, _, Some(false)) => {
            "native Quartz ready, but Screen Recording permission is not granted (needed for screenshots)".into()
        }
        (true, Some(true), Some(true)) => "native Quartz ready (Accessibility + Screen Recording granted)".into(),
        (true, _, _) => format!("native backend ready ({})", info.platform),
    };
    ComputerDiagnostic {
        platform: info.platform,
        native_available: info.native_available,
        screen_size: size,
        accessibility_granted: ax,
        screen_recording_granted: screen,
        detail,
    }
}

/// Inspect MCP client configs under `home`.
pub fn inspect_clients(home: &Path) -> Vec<ClientRegistration> {
    let mut clients = vec![
        inspect_toml_client("hanzo", home.join(".hanzo/config.toml")),
        inspect_toml_client("codex", home.join(".codex/config.toml")),
        inspect_json_client(
            "claude",
            home.join(".claude.json"),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "claude-desktop",
            claude_desktop_path(home),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "cursor",
            home.join(".cursor/mcp.json"),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "gemini",
            home.join(".gemini/settings.json"),
            &["mcpServers", "hanzo"],
        ),
        inspect_json_client(
            "antigravity",
            home.join(".gemini/antigravity/mcp_config.json"),
            &["mcpServers", "hanzo"],
        ),
    ];
    let agy_legacy = home.join(".gemini/config/mcp_config.json");
    if agy_legacy.exists() {
        clients.push(inspect_json_client(
            "antigravity-config",
            agy_legacy,
            &["mcpServers", "hanzo"],
        ));
    }
    clients
}

fn inspect_toml_client(client: &str, path: PathBuf) -> ClientRegistration {
    let path_str = path.display().to_string();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            computer_enabled: false,
            command: None,
            browser_backend: None,
            detail: format!("config.toml not found (run `hanzo mcp install {client}`)"),
        };
    };
    let parsed: Result<toml::Value, _> = toml::from_str(&raw);
    let Ok(doc) = parsed else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            computer_enabled: false,
            command: None,
            browser_backend: None,
            detail: "config.toml failed to parse".into(),
        };
    };
    let hanzo = doc.get("mcp_servers").and_then(|s| s.get("hanzo"));
    let Some(h) = hanzo else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            computer_enabled: false,
            command: None,
            browser_backend: None,
            detail: format!("[mcp_servers.hanzo] not configured (run `hanzo mcp install {client}`)"),
        };
    };
    let command = h.get("command").and_then(toml::Value::as_str).map(String::from);
    let args: Vec<String> = h
        .get("args")
        .and_then(toml::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(toml::Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let backend = h
        .get("env")
        .and_then(|e| e.get("BROWSER_BACKEND"))
        .and_then(toml::Value::as_str)
        .map(String::from);
    let enabled = h.get("enabled").and_then(toml::Value::as_bool).unwrap_or(true);
    let missing_bin = command
        .as_deref()
        .is_some_and(|c| c.starts_with('/') && !Path::new(c).exists());
    let (computer_ok, note) = args_allow_computer(command.as_deref(), &args);
    let detail = if !enabled {
        "configured but disabled".into()
    } else if missing_bin {
        "configured binary does not exist".into()
    } else if let Some(msg) = note {
        msg.into()
    } else {
        "configured".into()
    };
    let registered = enabled && !missing_bin;
    ClientRegistration {
        client: client.into(),
        config_path: path_str,
        registered,
        computer_enabled: registered && computer_ok,
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
            computer_enabled: false,
            command: None,
            browser_backend: None,
            detail: format!("config not found (run `hanzo mcp install {client}`)"),
        };
    };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else {
        return ClientRegistration {
            client: client.into(),
            config_path: path_str,
            registered: false,
            computer_enabled: false,
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
                    computer_enabled: false,
                    command: None,
                    browser_backend: None,
                    detail: format!("hanzo MCP server not registered (run `hanzo mcp install {client}`)"),
                };
            }
        }
    }
    let command = cur
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| cur.get("serverUrl").and_then(Value::as_str))
        .map(String::from);
    let args: Vec<String> = cur
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let backend = cur
        .get("env")
        .and_then(|e| e.get("BROWSER_BACKEND"))
        .and_then(Value::as_str)
        .map(String::from);
    let missing_bin = command
        .as_deref()
        .is_some_and(|c| c.starts_with('/') && !Path::new(c).exists());
    let (computer_ok, note) = args_allow_computer(command.as_deref(), &args);
    let registered = !missing_bin;
    ClientRegistration {
        client: client.into(),
        config_path: path_str,
        registered,
        computer_enabled: registered && computer_ok,
        command,
        browser_backend: backend,
        detail: if missing_bin {
            "configured binary does not exist".into()
        } else if let Some(msg) = note {
            msg.into()
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

    let computer = inspect_computer();
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
        recommendations.push("No MCP client configured yet — run `hanzo mcp install all` to configure all local AI clients.".into());
    } else if clients.iter().any(|c| c.registered && !c.computer_enabled) {
        recommendations.push("One or more MCP clients use legacy `uvx` or omit `computer` in `--tools` — run `hanzo mcp install all` to enable native computer control everywhere.".into());
    }
    if computer.accessibility_granted == Some(false) {
        recommendations.push("macOS Accessibility permission is not granted for this host process — enable it in System Settings → Privacy & Security → Accessibility for mouse/keyboard/window control.".into());
    }
    if computer.screen_recording_granted == Some(false) {
        recommendations.push("macOS Screen Recording permission is not granted for this host process — enable it in System Settings → Privacy & Security → Screen Recording for screenshots.".into());
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
        computer,
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

    out.push("Computer Control:".into());
    let cmark = if r.computer.native_available
        && r.computer.accessibility_granted != Some(false)
        && r.computer.screen_recording_granted != Some(false)
    {
        "✓"
    } else if r.computer.native_available {
        "!"
    } else {
        "✗"
    };
    let screen_str = r
        .computer
        .screen_size
        .map(|(w, h)| format!("{w}x{h}"))
        .unwrap_or_else(|| "unknown".into());
    out.push(format!(
        "  {cmark} platform={} screen={} — {}",
        r.computer.platform, screen_str, r.computer.detail
    ));
    out.push(String::new());

    out.push("MCP Clients:".into());
    for c in &r.clients {
        let mark = if c.registered && c.computer_enabled {
            "✓"
        } else if c.registered {
            "!"
        } else {
            "·"
        };
        let cmd = c.command.as_deref().unwrap_or("-");
        out.push(format!("  {mark} {:<16} {}  ({}) [{}]", c.client, c.detail, cmd, c.config_path));
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

/// Configure one or all supported MCP clients (`hanzo`, `codex`, `claude`,
/// `claude-desktop`, `cursor`, `gemini`, `antigravity`, or `all`) and
/// self-repair browser native messaging registration.
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
        "all" => {
            let mut installed = vec![
                install_toml_client_in("hanzo", home.join(".hanzo/config.toml"), exe, dry_run)?,
                install_toml_client_in("codex", home.join(".codex/config.toml"), exe, dry_run)?,
                install_json_client_in("claude", home.join(".claude.json"), exe, dry_run)?,
                install_json_client_in("claude-desktop", claude_desktop_path(home), exe, dry_run)?,
                install_json_client_in("cursor", home.join(".cursor/mcp.json"), exe, dry_run)?,
                install_json_client_in("gemini", home.join(".gemini/settings.json"), exe, dry_run)?,
                install_json_client_in(
                    "antigravity",
                    home.join(".gemini/antigravity/mcp_config.json"),
                    exe,
                    dry_run,
                )?,
            ];
            let agy_legacy = home.join(".gemini/config/mcp_config.json");
            if agy_legacy.exists() {
                installed.push(install_json_client_in(
                    "antigravity-config",
                    agy_legacy,
                    exe,
                    dry_run,
                )?);
            }
            json!({
                "success": true,
                "client": "all",
                "command": exe.display().to_string(),
                "dry_run": dry_run,
                "installed": installed,
            })
        }
        "hanzo" => install_toml_client_in("hanzo", home.join(".hanzo/config.toml"), exe, dry_run)?,
        "codex" => install_toml_client_in("codex", home.join(".codex/config.toml"), exe, dry_run)?,
        "antigravity" => {
            let primary = install_json_client_in(
                "antigravity",
                home.join(".gemini/antigravity/mcp_config.json"),
                exe,
                dry_run,
            )?;
            let legacy = home.join(".gemini/config/mcp_config.json");
            if legacy.exists() {
                let _ = install_json_client_in("antigravity-config", legacy, exe, dry_run);
            }
            primary
        }
        "gemini" => install_json_client_in(
            "gemini",
            home.join(".gemini/settings.json"),
            exe,
            dry_run,
        )?,
        "cursor" => install_json_client_in("cursor", home.join(".cursor/mcp.json"), exe, dry_run)?,
        "claude" | "claude-code" => {
            install_json_client_in("claude", home.join(".claude.json"), exe, dry_run)?
        }
        "claude-desktop" => {
            install_json_client_in("claude-desktop", claude_desktop_path(home), exe, dry_run)?
        }
        other => {
            return Err(anyhow!(
                "Unknown install target {other:?}. Supported targets: all, hanzo, codex, claude, claude-desktop, cursor, gemini, antigravity"
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
    install_toml_client_in("codex", home.join(".codex/config.toml"), exe, dry_run)
}

fn install_toml_client_in(client: &str, path: PathBuf, exe: &Path, dry_run: bool) -> Result<Value> {
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
        "client": client,
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
        assert!(codex.computer_enabled);
        assert_eq!(codex.browser_backend.as_deref(), Some("extension"));
    }

    #[test]
    fn install_all_configures_every_client_and_flags_uvx_or_filtered_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let exe = std::env::current_exe().unwrap();

        // Install all clients cleanly
        let res = install_in(home, "all", &exe, false).unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["client"], "all");
        let clients = inspect_clients(home);
        for name in ["hanzo", "codex", "claude", "claude-desktop", "cursor", "gemini", "antigravity"] {
            let c = clients.iter().find(|c| c.client == name).expect(name);
            assert!(c.registered, "{name} should be registered");
            assert!(c.computer_enabled, "{name} should have computer enabled");
        }

        // Legacy uvx wrapper and restricted --tools should flag computer_enabled = false
        assert!(!args_allow_computer(Some("uvx"), &["hanzo-mcp".into()]).0);
        assert!(!args_allow_computer(Some("/usr/local/bin/hanzo-mcp"), &["--tools".into(), "fs,exec".into()]).0);
        assert!(args_allow_computer(Some("/usr/local/bin/hanzo-mcp"), &["--tools=fs,computer".into()]).0);
    }
}
