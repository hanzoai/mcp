//! Native Rust Cloud Node Bridge (`hanzo-mcp connect` / `hanzo mcp connect`).
//!
//! Holds an outbound TLS WebSocket to Hanzo Cloud (`wss://api.hanzo.ai/v1/node/connect`)
//! speaking `hanzoai/cloud/apps/node` Protocol v3, so mobile apps, Hanzo Cloud
//! Agents, and third-party MCP clients (e.g. Muse, Claude, Codex, Gemini via
//! `POST https://api.hanzo.ai/v1/mcp` or `POST /v1/node/{id}/call`) can invoke
//! this machine's native `computer`, `browser` (ZAP), and MCP tools securely
//! under the user's IAM-validated organization — with zero open inbound ports.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, RwLock};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

use crate::context::Ctx;
use crate::ToolRegistry;

pub const DEFAULT_CLOUD_NODE_URL: &str = "wss://api.hanzo.ai/v1/node/connect";
const PROTOCOL_VERSION: u32 = 3;

/// Desktop commands advertised to Hanzo Cloud when their backing tools are enabled.
const COMPUTER_COMMANDS: &[&str] = &[
    "device.info",
    "device.status",
    "computer.info",
    "computer.health",
    "computer.screenshot",
    "computer.screenshot_region",
    "computer.get_pixel",
    "computer.screen_size",
    "computer.get_screens",
    "computer.position",
    "computer.click",
    "computer.double_click",
    "computer.right_click",
    "computer.middle_click",
    "computer.move",
    "computer.move_relative",
    "computer.drag",
    "computer.drag_relative",
    "computer.scroll",
    "computer.type",
    "computer.write",
    "computer.press",
    "computer.key_down",
    "computer.key_up",
    "computer.hotkey",
    "computer.get_active_window",
    "computer.list_windows",
    "computer.focus_window",
    "computer.minimize_window",
    "computer.maximize_window",
    "computer.resize_window",
    "computer.move_window",
    "computer.close_window",
    "computer.open_app",
    "computer.batch",
    "computer.mac_calendar",
    "computer.mac_reminders",
    "computer.mac_notes",
    "computer.mac_mail_draft",
    "computer.mac_contacts",
    "computer.mac_shortcuts",
];

#[cfg(target_os = "macos")]
const MAC_ALIAS_COMMANDS: &[&str] = &["calendar.events", "reminders.list", "contacts.search"];

#[derive(Debug, Clone)]
pub struct BridgeOptions {
    pub url: String,
    pub node_id: String,
    pub display_name: String,
    pub token: Option<String>,
    pub once: bool,
}

impl BridgeOptions {
    pub fn default_url() -> String {
        if let Ok(u) = std::env::var("HANZO_NODE_URL") {
            let trimmed = u.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Ok(api) = std::env::var("HANZO_API_URL") {
            let base = api.trim().trim_end_matches('/');
            if let Some(rest) = base.strip_prefix("https://") {
                return format!("wss://{rest}/v1/node/connect");
            }
            if let Some(rest) = base.strip_prefix("http://") {
                return format!("ws://{rest}/v1/node/connect");
            }
        }
        DEFAULT_CLOUD_NODE_URL.to_string()
    }

    pub fn default_node_id() -> String {
        let host = hostname_short();
        format!("{host}-mcp")
    }

    pub fn default_display_name() -> String {
        format!("{} (Hanzo Native MCP)", hostname_short())
    }
}

fn hostname_short() -> String {
    let raw = std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "machine".to_string());
    let clean: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    if clean.is_empty() {
        "machine".to_string()
    } else {
        clean.to_lowercase()
    }
}

/// Resolve a Hanzo IAM bearer token: explicit flag, env var, or `hanzo auth token`.
pub fn resolve_token(explicit: Option<&str>) -> Result<String> {
    if let Some(t) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(t.to_string());
    }
    for var in ["HANZO_TOKEN", "HANZO_API_KEY"] {
        if let Ok(v) = std::env::var(var) {
            let t = v.trim();
            if !t.is_empty() {
                return Ok(t.to_string());
            }
        }
    }
    let hanzo_bin = which::which("hanzo").ok().or_else(|| {
        dirs::home_dir().and_then(|h| {
            [".local/bin/hanzo", ".hanzo/bin/hanzo"]
                .into_iter()
                .map(|rel| h.join(rel))
                .find(|p| p.exists())
        })
    });
    if let Some(bin) = hanzo_bin {
        let out = std::process::Command::new(&bin)
            .args(["auth", "token"])
            .output()
            .with_context(|| format!("running {} auth token", bin.display()))?;
        if out.status.success() {
            let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !tok.is_empty() {
                return Ok(tok);
            }
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(
            "hanzo auth token failed ({err}); run `hanzo auth login` or pass --token"
        ));
    }
    Err(anyhow!(
        "no Hanzo IAM token found: set HANZO_TOKEN, pass --token, or sign in with `hanzo auth login`"
    ))
}

/// Build the advertised command list strictly from the tools enabled on this server.
pub fn declared_commands(served_tools: &[String]) -> (Vec<String>, Vec<String>) {
    let has = |name: &str| served_tools.iter().any(|t| t == name);
    let mut caps = vec!["mcp".to_string(), "system".to_string()];
    let mut cmds = vec!["mcp.tools".to_string(), "mcp.call".to_string()];

    if has("computer") {
        caps.push("computer".to_string());
        for c in COMPUTER_COMMANDS {
            cmds.push((*c).to_string());
        }
        #[cfg(target_os = "macos")]
        {
            caps.push("mac_apps".to_string());
            for c in MAC_ALIAS_COMMANDS {
                cmds.push((*c).to_string());
            }
        }
    }
    if has("browser") || has("browser_read") {
        caps.push("browser".to_string());
        cmds.push("browser.proxy".to_string());
    }
    (caps, cmds)
}

/// Dispatch one incoming `node.invoke.request` command against the local native ToolRegistry.
pub async fn dispatch_command(
    tools: &Arc<RwLock<ToolRegistry>>,
    command: &str,
    params: Value,
) -> (bool, Value, Option<(&'static str, String)>) {
    let cmd = command.trim();
    if cmd == "mcp.tools" {
        let reg = tools.read().await;
        let defs = reg.get_definitions();
        return (true, json!({ "tools": defs }), None);
    }

    if cmd == "mcp.call" {
        let Some(name) = params
            .get("name")
            .or_else(|| params.get("tool"))
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return (
                false,
                Value::Null,
                Some(("INVALID_PARAMS", "mcp.call requires `name`".into())),
            );
        };
        let tool_args = params
            .get("arguments")
            .or_else(|| params.get("args"))
            .or_else(|| params.get("params"))
            .cloned()
            .unwrap_or_else(|| match params {
                Value::Object(mut map) => {
                    map.remove("name");
                    map.remove("tool");
                    Value::Object(map)
                }
                _ => json!({}),
            });
        return run_local_tool(tools, &name, tool_args).await;
    }

    if cmd == "browser.proxy" {
        let read_only = params
            .get("read_only")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target = if read_only { "browser_read" } else { "browser" };
        let mut tool_args = match params {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        tool_args.remove("read_only");
        return run_local_tool(tools, target, Value::Object(tool_args)).await;
    }

    if let Some(action) = map_computer_command(cmd) {
        let mut obj = match params {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        obj.insert("action".into(), json!(action));
        if cmd == "calendar.events" || cmd == "reminders.list" {
            obj.entry("op".to_string()).or_insert_with(|| json!("list"));
        }
        return run_local_tool(tools, "computer", Value::Object(obj)).await;
    }

    (
        false,
        Value::Null,
        Some(("UNSUPPORTED_COMMAND", format!("unsupported command: {cmd}"))),
    )
}

fn map_computer_command(cmd: &str) -> Option<&str> {
    match cmd {
        "device.info" => Some("info"),
        "device.status" => Some("health"),
        "calendar.events" => Some("mac_calendar"),
        "reminders.list" => Some("mac_reminders"),
        "contacts.search" => Some("mac_contacts"),
        other => other.strip_prefix("computer."),
    }
}

async fn run_local_tool(
    tools: &Arc<RwLock<ToolRegistry>>,
    tool_name: &str,
    params: Value,
) -> (bool, Value, Option<(&'static str, String)>) {
    let reg = tools.read().await;
    let served = reg.list();
    if !served.iter().any(|n| n == tool_name) {
        return (
            false,
            Value::Null,
            Some((
                "TOOL_NOT_ENABLED",
                format!(
                    "tool {tool_name:?} is not enabled on this node (enabled: {})",
                    served.join(", ")
                ),
            )),
        );
    }
    match reg.execute_with(tool_name, params, &Ctx::default()).await {
        Ok(res) if res.success => (true, res.content, None),
        Ok(res) => (
            false,
            res.content,
            Some((
                "TOOL_ERROR",
                res.error.unwrap_or_else(|| format!("{tool_name} failed")),
            )),
        ),
        Err(e) => (false, Value::Null, Some(("EXECUTION_ERROR", e.to_string()))),
    }
}

/// Unified plain TCP / rustls TLS stream so `bridge` supports both `wss://` (cloud)
/// and `ws://` (local dev / unit tests) with zero OpenSSL dependency.
enum WsStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for WsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            WsStream::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            WsStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            WsStream::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => Pin::new(s).poll_flush(cx),
            WsStream::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            WsStream::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

fn tls_connector() -> TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_trust_anchors(webpki_roots::TLS_SERVER_ROOTS.iter().map(|ta| {
        rustls::OwnedTrustAnchor::from_subject_spki_name_constraints(
            ta.subject,
            ta.spki,
            ta.name_constraints,
        )
    }));
    let cfg = rustls::ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(cfg))
}

async fn dial_ws(
    url_str: &str,
    token: &str,
) -> Result<tokio_tungstenite::WebSocketStream<WsStream>> {
    let parsed = reqwest::Url::parse(url_str).with_context(|| format!("invalid URL {url_str:?}"))?;
    let tls = match parsed.scheme() {
        "wss" => true,
        "ws" => false,
        other => return Err(anyhow!("unsupported WebSocket scheme {other:?}; use wss:// or ws://")),
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("missing host in {url_str:?}"))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(if tls { 443 } else { 80 });

    let tcp = tokio::time::timeout(
        Duration::from_secs(15),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .context("TCP connect timed out")?
    .with_context(|| format!("TCP connect to {host}:{port} failed"))?;

    let stream = if tls {
        let server_name = rustls::ServerName::try_from(host.as_str())
            .map_err(|_| anyhow!("invalid TLS server name {host:?}"))?;
        let tls_stream = tokio::time::timeout(
            Duration::from_secs(15),
            tls_connector().connect(server_name, tcp),
        )
        .await
        .context("TLS handshake timed out")?
        .context("TLS handshake failed")?;
        WsStream::Tls(Box::new(tls_stream))
    } else {
        WsStream::Plain(tcp)
    };

    let mut req = url_str
        .into_client_request()
        .context("failed to build WebSocket handshake request")?;
    req.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).context("invalid bearer token header")?,
    );

    let (ws, _resp) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::client_async(req, stream),
    )
    .await
    .context("WebSocket upgrade timed out")?
    .context("WebSocket upgrade failed (check IAM token / network)")?;
    Ok(ws)
}

/// Run one connected session against `/v1/node/connect`. Returns `Ok(hello)` if
/// `opts.once` is set, or runs until disconnect / Ctrl-C.
pub async fn connect_once(
    tools: Arc<RwLock<ToolRegistry>>,
    opts: &BridgeOptions,
    token: &str,
) -> Result<Value> {
    let mut ws = dial_ws(&opts.url, token).await?;

    // 1. Wait for `connect.challenge` event from cloud.
    let challenge_msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .context("timed out waiting for connect.challenge")?
        .ok_or_else(|| anyhow!("connection closed before connect.challenge"))?
        .context("WebSocket read error waiting for connect.challenge")?;
    let challenge_text = challenge_msg
        .into_text()
        .map_err(|_| anyhow!("expected text connect.challenge frame"))?;
    let challenge: Value =
        serde_json::from_str(&challenge_text).context("invalid JSON in connect.challenge")?;
    if challenge.get("event").and_then(Value::as_str) != Some("connect.challenge") {
        return Err(anyhow!("unexpected first frame from cloud: {challenge_text}"));
    }

    // 2. Send Protocol v3 `connect` request advertising our live native capabilities.
    let served = tools.read().await.list();
    let (caps, commands) = declared_commands(&served);
    let seq = Arc::new(AtomicU64::new(1));
    let connect_req_id = seq.fetch_add(1, Ordering::Relaxed).to_string();
    let connect_frame = json!({
        "type": "req",
        "id": connect_req_id,
        "method": "connect",
        "params": {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "role": "node",
            "client": {
                "id": opts.node_id,
                "displayName": opts.display_name,
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "deviceFamily": "desktop",
                "mode": "node",
                "instanceId": opts.node_id,
            },
            "device": { "id": opts.node_id },
            "caps": caps,
            "commands": commands,
            "permissions": {},
        }
    });
    ws.send(Message::Text(connect_frame.to_string().into()))
        .await
        .context("failed to send connect frame")?;

    // 3. Await `hello-ok` response.
    let hello_msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .context("timed out waiting for hello-ok")?
        .ok_or_else(|| anyhow!("connection closed during handshake"))?
        .context("WebSocket read error during handshake")?;
    let hello_text = hello_msg
        .into_text()
        .map_err(|_| anyhow!("expected text hello-ok frame"))?;
    let hello: Value = serde_json::from_str(&hello_text).context("invalid JSON in hello-ok")?;
    if hello.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(anyhow!("cloud rejected node connect: {hello}"));
    }

    let tick_ms = hello
        .pointer("/payload/policy/tickIntervalMs")
        .and_then(Value::as_u64)
        .unwrap_or(30_000);
    let conn_id = hello
        .pointer("/payload/server/connId")
        .and_then(Value::as_str)
        .unwrap_or("-");
    info!(
        "[bridge] connected node={} conn={} commands={} url={}",
        opts.node_id,
        conn_id,
        commands.len(),
        opts.url
    );

    if opts.once {
        let _ = ws.close(None).await;
        return Ok(json!({
            "connected": true,
            "node_id": opts.node_id,
            "display_name": opts.display_name,
            "conn_id": conn_id,
            "url": opts.url,
            "caps": caps,
            "command_count": commands.len(),
        }));
    }

    // 4. Full-duplex frame loop: invoke requests spawn concurrently; responses serialize through tx.
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let watchdog = Duration::from_millis((tick_ms * 3).max(90_000));
    let mut result = Ok(hello);

    loop {
        let next_frame = tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("[bridge] shutting down on Ctrl-C");
                break;
            }
            item = tokio::time::timeout(watchdog, stream.next()) => item,
        };

        let msg = match next_frame {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(e))) => {
                result = Err(anyhow!("WebSocket error: {e}"));
                break;
            }
            Ok(None) => {
                result = Err(anyhow!("cloud closed node WebSocket"));
                break;
            }
            Err(_) => {
                result = Err(anyhow!("cloud tick watchdog expired after {}s", watchdog.as_secs()));
                break;
            }
        };

        match msg {
            Message::Ping(payload) => {
                let _ = tx.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => {
                result = Err(anyhow!("cloud sent WebSocket close frame"));
                break;
            }
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) != Some("event") {
                    continue;
                }
                let ev = frame.get("event").and_then(Value::as_str).unwrap_or("");
                if ev == "tick" {
                    continue;
                }
                if ev == "node.invoke.request" {
                    let Some(payload) = frame.get("payload") else { continue };
                    let corr_id = payload
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let command = payload
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let params: Value = payload
                        .get("paramsJSON")
                        .and_then(Value::as_str)
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or_else(|| json!({}));
                    let timeout_ms = payload
                        .get("timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(30_000)
                        .clamp(1_000, 300_000);

                    let tools = Arc::clone(&tools);
                    let tx = tx.clone();
                    let seq = Arc::clone(&seq);
                    let node_id = opts.node_id.clone();

                    tokio::spawn(async move {
                        let (ok, out_val, err_pair) = match tokio::time::timeout(
                            Duration::from_millis(timeout_ms),
                            dispatch_command(&tools, &command, params),
                        )
                        .await
                        {
                            Ok(res) => res,
                            Err(_) => (
                                false,
                                json!({ "outcome_unknown": true, "timed_out": true }),
                                Some(("TIMEOUT", format!("{command} timed out after {timeout_ms}ms"))),
                            ),
                        };

                        let payload_json = serde_json::to_string(&out_val).unwrap_or_else(|_| "{}".into());
                        let mut params_obj = json!({
                            "id": corr_id,
                            "nodeId": node_id,
                            "ok": ok,
                            "payloadJSON": payload_json,
                        });
                        if let Some((code, message)) = err_pair {
                            params_obj["error"] = json!({ "code": code, "message": message });
                        }
                        let req_id = seq.fetch_add(1, Ordering::Relaxed).to_string();
                        let reply = json!({
                            "type": "req",
                            "id": req_id,
                            "method": "node.invoke.result",
                            "params": params_obj,
                        });
                        let _ = tx.send(Message::Text(reply.to_string().into())).await;
                    });
                }
            }
            _ => {}
        }
    }

    drop(tx);
    let _ = writer.await;
    result
}

/// Persistent reconnect loop for `hanzo-mcp connect`.
pub async fn run_bridge(tools: Arc<RwLock<ToolRegistry>>, opts: BridgeOptions) -> Result<()> {
    if opts.once {
        let token = resolve_token(opts.token.as_deref())?;
        let summary = connect_once(tools, &opts, &token).await?;
        println!("{}", serde_json::to_string_pretty(&summary)?);
        return Ok(());
    }

    let mut backoff = Duration::from_secs(1);
    loop {
        match resolve_token(opts.token.as_deref()) {
            Ok(token) => {
                let started = std::time::Instant::now();
                match connect_once(Arc::clone(&tools), &opts, &token).await {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        if started.elapsed() > Duration::from_secs(30) {
                            backoff = Duration::from_secs(1);
                        }
                        warn!(
                            "[bridge] disconnected ({e}); reconnecting in {}s...",
                            backoff.as_secs()
                        );
                    }
                }
            }
            Err(e) => {
                error!("[bridge] {e}; retrying in {}s...", backoff.as_secs());
            }
        }
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn full_protocol_v3_handshake_and_invoke_roundtrip() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                tcp,
                |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    assert_eq!(
                        req.headers().get("authorization").and_then(|v| v.to_str().ok()),
                        Some("Bearer test-iam-jwt")
                    );
                    assert!(req.headers().get("origin").is_none());
                    Ok(resp)
                },
            )
            .await
            .unwrap();

            // Send challenge
            ws.send(Message::Text(
                json!({"type":"event","event":"connect.challenge","payload":{"nonce":"n1","ts":1}}).to_string().into(),
            ))
            .await
            .unwrap();

            // Read connect frame
            let connect_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let connect: Value = serde_json::from_str(&connect_raw).unwrap();
            assert_eq!(connect["method"], "connect");
            assert_eq!(connect["params"]["role"], "node");
            let cmds = connect["params"]["commands"].as_array().unwrap();
            assert!(cmds.iter().any(|v| v == "computer.health"));
            assert!(cmds.iter().any(|v| v == "mcp.tools"));
            assert!(cmds.iter().any(|v| v == "browser.proxy"));

            // Reply hello-ok
            ws.send(Message::Text(
                json!({
                    "type": "res",
                    "id": connect["id"],
                    "ok": true,
                    "payload": {
                        "type": "hello-ok",
                        "protocol": 3,
                        "server": {"version": "test", "connId": "c-1"},
                        "policy": {"tickIntervalMs": 30000}
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            // Dispatch mcp.tools and computer.health invocations
            ws.send(Message::Text(
                json!({
                    "type": "event",
                    "event": "node.invoke.request",
                    "payload": {
                        "id": "corr-1",
                        "nodeId": "test-node",
                        "command": "mcp.tools",
                        "paramsJSON": "{}"
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let res_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let res: Value = serde_json::from_str(&res_raw).unwrap();
            assert_eq!(res["method"], "node.invoke.result");
            assert_eq!(res["params"]["id"], "corr-1");
            assert_eq!(res["params"]["ok"], true);
            let payload: Value =
                serde_json::from_str(res["params"]["payloadJSON"].as_str().unwrap()).unwrap();
            assert!(payload["tools"].as_array().unwrap().len() >= 19);

            // Dispatch computer.health
            ws.send(Message::Text(
                json!({
                    "type": "event",
                    "event": "node.invoke.request",
                    "payload": {
                        "id": "corr-2",
                        "nodeId": "test-node",
                        "command": "computer.health",
                        "paramsJSON": "{}"
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let res2_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let res2: Value = serde_json::from_str(&res2_raw).unwrap();
            assert_eq!(res2["params"]["id"], "corr-2");
            assert_eq!(res2["params"]["ok"], true);
            let payload2: Value =
                serde_json::from_str(res2["params"]["payloadJSON"].as_str().unwrap()).unwrap();
            assert_eq!(payload2["success"], true);

            // Dispatch mcp.call exec via `args` without explicit `action`
            ws.send(Message::Text(
                json!({
                    "type": "event",
                    "event": "node.invoke.request",
                    "payload": {
                        "id": "corr-3",
                        "nodeId": "test-node",
                        "command": "mcp.call",
                        "paramsJSON": "{\"tool\":\"exec\",\"args\":{\"command\":\"echo bridge-ok\"}}"
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let res3_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let res3: Value = serde_json::from_str(&res3_raw).unwrap();
            assert_eq!(res3["params"]["id"], "corr-3");
            assert_eq!(res3["params"]["ok"], true);
            let payload3: Value =
                serde_json::from_str(res3["params"]["payloadJSON"].as_str().unwrap()).unwrap();
            assert_eq!(payload3["exit_code"], 0);
            assert!(payload3["stdout"].as_str().unwrap().contains("bridge-ok"));

            // Dispatch mcp.call exec with flat params (no nested arguments/args wrapper)
            ws.send(Message::Text(
                json!({
                    "type": "event",
                    "event": "node.invoke.request",
                    "payload": {
                        "id": "corr-4",
                        "nodeId": "test-node",
                        "command": "mcp.call",
                        "paramsJSON": "{\"name\":\"exec\",\"command\":\"echo flat-ok\"}"
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

            let res4_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let res4: Value = serde_json::from_str(&res4_raw).unwrap();
            assert_eq!(res4["params"]["id"], "corr-4");
            assert_eq!(res4["params"]["ok"], true);
            let payload4: Value =
                serde_json::from_str(res4["params"]["payloadJSON"].as_str().unwrap()).unwrap();
            assert_eq!(payload4["exit_code"], 0);
            assert!(payload4["stdout"].as_str().unwrap().contains("flat-ok"));

            let _ = ws.close(None).await;
        });

        let tools = Arc::new(RwLock::new(ToolRegistry::new()));
        let opts = BridgeOptions {
            url: format!("ws://{addr}/v1/node/connect"),
            node_id: "test-node".into(),
            display_name: "Test Node".into(),
            token: Some("test-iam-jwt".into()),
            once: false,
        };
        // Exits cleanly when server closes the socket after validating both invokes
        let _ = connect_once(tools, &opts, "test-iam-jwt").await;
        server_task.await.unwrap();
    }
}
