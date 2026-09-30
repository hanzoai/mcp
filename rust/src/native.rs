//! The browser's way onto this machine's ZAP router: native messaging.
//!
//! An extension cannot open a unix socket, so the browser starts a helper for
//! it (host `ai.hanzo.zap`, allowed for the Hanzo extension only) and talks to
//! it over stdio. The helper relays router envelopes both ways between that
//! stdio and the router's socket. No port and no pairing: the browser's origin
//! check and the socket's 0600 owner are the trust. Peer of python-sdk
//! `hanzo_tools.browser.native_host`; either runtime's helper serves the same
//! extension.
//!
//! The helper is this binary run as `hanzo-zap-host` (a symlink the manifest
//! names). It stands for the router like every ZAP process, so a browser with
//! no other Hanzo process running still has one.
//!
//! Native messaging frames are a u32 native-endian length and UTF-8 JSON; each
//! envelope rides base64 in `{"z": ...}`. Envelopes on the socket carry their
//! own little-endian u32 length.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde_json::{json, Value};

/// The host's name, as manifests and the extension know it.
pub const NAME: &str = "ai.hanzo.zap";
/// The name this binary answers to as the host.
pub const BIN: &str = "hanzo-zap-host";
const ORIGINS: &[&str] = &["chrome-extension://biingenefmanpecedoafkfajbnlgdmbl/"];
/// Firefox names an extension by its gecko id, not an origin.
const GECKO: &[&str] = &["hanzo-ai@hanzo.ai"];

/// Where each Chromium-family browser keeps a user's host manifests, and
/// Firefox's host directory (present once Firefox has a profile).
#[cfg(target_os = "macos")]
const CHROMIUM: &[&str] = &[
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome Beta",
    "Library/Application Support/Chromium",
    "Library/Application Support/BraveSoftware/Brave-Browser",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Vivaldi",
];
#[cfg(target_os = "macos")]
const FIREFOX: &str = "Library/Application Support/Mozilla/NativeMessagingHosts";
#[cfg(not(target_os = "macos"))]
const CHROMIUM: &[&str] = &[
    ".config/google-chrome",
    ".config/google-chrome-beta",
    ".config/google-chrome-unstable",
    ".config/chromium",
    ".config/BraveSoftware/Brave-Browser",
    ".config/microsoft-edge",
    ".config/vivaldi",
];
#[cfg(not(target_os = "macos"))]
const FIREFOX: &str = ".mozilla/native-messaging-hosts";

/// Register the host with every browser installed for this user. A browser
/// that is not installed is skipped, and a manifest whose program exists is
/// left as it is: another runtime's helper (Python hanzo-mcp's) serves the same
/// extension, and two runtimes rewriting one file would trade it forever.
pub fn install() -> Result<Vec<PathBuf>> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let exe = home.join(".hanzo/zap").join(BIN);
    let manifest = |allowed: (&str, Value)| {
        let mut m = json!({
            "name": NAME,
            "description": "Hanzo ZAP: the browser's seat on this machine's router",
            "path": exe.display().to_string(),
            "type": "stdio",
        });
        m[allowed.0] = allowed.1;
        serde_json::to_string_pretty(&m).map(|s| s + "\n")
    };
    let chromium = manifest(("allowed_origins", json!(ORIGINS)))?;
    let firefox = manifest(("allowed_extensions", json!(GECKO)))?;
    let firefox_dir = home.join(FIREFOX);
    let targets = CHROMIUM
        .iter()
        .map(|b| (home.join(b), home.join(b).join("NativeMessagingHosts"), &chromium))
        .chain([(firefox_dir.parent().unwrap_or(&home).to_path_buf(), firefox_dir.clone(), &firefox)]);

    let mut written = Vec::new();
    for (base, hosts, body) in targets {
        let target = hosts.join(format!("{NAME}.json"));
        if !base.is_dir() || serves(&target) {
            continue;
        }
        link(&exe)?;
        std::fs::create_dir_all(&hosts)?;
        std::fs::write(&target, body)?;
        written.push(target);
    }
    Ok(written)
}

/// A manifest is there and the program it names exists.
fn serves(manifest: &Path) -> bool {
    std::fs::read_to_string(manifest)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|m| m.get("path").and_then(Value::as_str).map(|p| Path::new(p).exists()))
        .unwrap_or(false)
}

/// `~/.hanzo/zap/hanzo-zap-host` -> this binary.
fn link(at: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    if std::fs::read_link(at).ok().as_deref() == Some(exe.as_path()) {
        return Ok(());
    }
    if let Some(dir) = at.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(at);
    std::os::unix::fs::symlink(&exe, at)?;
    Ok(())
}

/// This process was started as the host.
pub fn invoked() -> bool {
    std::env::args_os()
        .next()
        .and_then(|a| Path::new(&a).file_name().map(|n| n == BIN))
        .unwrap_or(false)
}

/// Relay native messages on `input`/`output` to the router until either side
/// closes. The browser starts the host again when it wants the router back.
pub fn relay(input: impl Read + Send + 'static, output: impl Write + Send + 'static) -> Result<()> {
    zapd::embed();
    let sock = dial(Instant::now() + Duration::from_secs(10))?;
    let (up, down) = (sock.try_clone()?, sock);
    let (done, over) = std::sync::mpsc::channel::<()>();
    let done2 = done.clone();
    std::thread::spawn(move || {
        to_browser(up, output);
        let _ = done.send(());
    });
    std::thread::spawn(move || {
        let _ = to_router(input, down);
        let _ = done2.send(());
    });
    let _ = over.recv();
    Ok(())
}

/// Router -> browser: split the socket into envelopes, one message each.
fn to_browser(mut sock: UnixStream, mut out: impl Write) {
    let mut len = [0u8; 4];
    while sock.read_exact(&mut len).is_ok() {
        let mut frame = len.to_vec();
        frame.resize(4 + u32::from_le_bytes(len) as usize, 0);
        if sock.read_exact(&mut frame[4..]).is_err() {
            return;
        }
        let msg = json!({ "z": base64::engine::general_purpose::STANDARD.encode(&frame) }).to_string();
        let sent = out
            .write_all(&(msg.len() as u32).to_ne_bytes())
            .and_then(|_| out.write_all(msg.as_bytes()))
            .and_then(|_| out.flush());
        if sent.is_err() {
            return;
        }
    }
}

/// Browser -> router: each message's envelope, written whole.
fn to_router(mut input: impl Read, mut sock: UnixStream) -> Result<()> {
    let mut len = [0u8; 4];
    while input.read_exact(&mut len).is_ok() {
        let mut msg = vec![0u8; u32::from_ne_bytes(len) as usize];
        input.read_exact(&mut msg)?;
        if let Some(z) = serde_json::from_slice::<Value>(&msg)?.get("z").and_then(Value::as_str) {
            sock.write_all(&base64::engine::general_purpose::STANDARD.decode(z)?)?;
        }
    }
    Ok(())
}

/// The router's socket, waiting out an election in progress.
fn dial(deadline: Instant) -> Result<UnixStream> {
    loop {
        match UnixStream::connect(zapd::socket_path()) {
            Ok(s) => return Ok(s),
            Err(e) if Instant::now() > deadline => return Err(anyhow!("zap: no router socket: {e}")),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
