//! The browser's way onto this machine's ZAP router: native messaging.
//!
//! An extension cannot open a unix socket or a named pipe, so the browser starts
//! a helper for it (host `ai.hanzo.zap`, allowed for the Hanzo extension only)
//! and talks to it over stdio. The helper relays router envelopes both ways
//! between that stdio and the router's door: the Unix socket, or on Windows the
//! named pipe, whose server it checks is the router lock holder. No port and no
//! pairing: the browser's origin check and the door's owner are the trust. Peer of python-sdk
//! `hanzo_tools.browser.native_host`; either runtime's helper serves the same
//! extension.
//!
//! The helper is this binary run as `hanzo-zap-host` (a symlink the manifest
//! names; on Windows a hard link, `hanzo-zap-host.exe`, and the manifest is found
//! through the browser's registry key). It stands for the router like every ZAP process, so a browser with
//! no other Hanzo process running still has one.
//!
//! Native messaging frames are a u32 native-endian length and UTF-8 JSON; each
//! envelope rides base64 in `{"z": ...}`. Envelopes on the socket carry their
//! own little-endian u32 length.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The host's name, as manifests and the extension know it.
pub const NAME: &str = "ai.hanzo.zap";
/// The name this binary answers to as the host.
pub const BIN: &str = "hanzo-zap-host";
pub const ORIGINS: &[&str] = &["chrome-extension://biingenefmanpecedoafkfajbnlgdmbl/"];
/// Firefox names an extension by its gecko id, not an origin.
pub const GECKO: &[&str] = &["hanzo-ai@hanzo.ai"];

/// Diagnostic state for one browser's native messaging registration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeHostStatus {
    pub browser: String,
    pub manifest_path: String,
    /// One of: `ok`, `missing`, `invalid_manifest`, `missing_origin`, `broken_target`, `not_executable`
    pub status: String,
    pub host_path: Option<String>,
    pub detail: String,
}

/// Summary returned by [`repair`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepairReport {
    pub repaired: Vec<PathBuf>,
    pub already_ok: Vec<PathBuf>,
    pub skipped_not_installed: usize,
    pub errors: Vec<String>,
}

/// The router's door as this process reads and writes it.
#[cfg(unix)]
type Door = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Door = std::fs::File;

/// Where each Chromium-family browser keeps a user's host manifests, and
/// Firefox's host directory (present once Firefox has a profile).
#[cfg(target_os = "macos")]
const CHROMIUM: &[(&str, &str)] = &[
    ("Chrome", "Library/Application Support/Google/Chrome"),
    ("Chrome Beta", "Library/Application Support/Google/Chrome Beta"),
    ("Chrome Dev", "Library/Application Support/Google/Chrome Dev"),
    ("Chrome Canary", "Library/Application Support/Google/Chrome Canary"),
    ("Chromium", "Library/Application Support/Chromium"),
    ("Brave", "Library/Application Support/BraveSoftware/Brave-Browser"),
    ("Edge", "Library/Application Support/Microsoft Edge"),
    ("Vivaldi", "Library/Application Support/Vivaldi"),
];
#[cfg(target_os = "macos")]
const FIREFOX: &str = "Library/Application Support/Mozilla/NativeMessagingHosts";
#[cfg(all(unix, not(target_os = "macos")))]
const CHROMIUM: &[(&str, &str)] = &[
    ("Chrome", ".config/google-chrome"),
    ("Chrome Beta", ".config/google-chrome-beta"),
    ("Chrome Unstable", ".config/google-chrome-unstable"),
    ("Chromium", ".config/chromium"),
    ("Brave", ".config/BraveSoftware/Brave-Browser"),
    ("Edge", ".config/microsoft-edge"),
    ("Vivaldi", ".config/vivaldi"),
];
#[cfg(all(unix, not(target_os = "macos")))]
const FIREFOX: &str = ".mozilla/native-messaging-hosts";

/// On Windows each browser finds a host through a registry key under
/// `HKEY_CURRENT_USER` whose default value is the manifest's path: the key, and
/// the user-data directory under `%LOCALAPPDATA%` that shows the browser is there.
#[cfg(windows)]
const CHROMIUM: &[(&str, &str)] = &[
    (r"Software\Google\Chrome\NativeMessagingHosts", r"Google\Chrome\User Data"),
    (r"Software\Chromium\NativeMessagingHosts", r"Chromium\User Data"),
    (r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts", r"BraveSoftware\Brave-Browser\User Data"),
    (r"Software\Microsoft\Edge\NativeMessagingHosts", r"Microsoft\Edge\User Data"),
];
/// Firefox's key, and its profiles directory under `%APPDATA%`.
#[cfg(windows)]
const FIREFOX: (&str, &str) = (r"Software\Mozilla\NativeMessagingHosts", r"Mozilla\Firefox");

/// Inspect a single native messaging manifest file on disk.
pub fn inspect_manifest(browser: &str, manifest: &Path, is_firefox: bool) -> NativeHostStatus {
    let manifest_path = manifest.display().to_string();
    let raw = match std::fs::read_to_string(manifest) {
        Ok(s) => s,
        Err(_) => {
            return NativeHostStatus {
                browser: browser.to_string(),
                manifest_path,
                status: "missing".into(),
                host_path: None,
                detail: "native messaging manifest not found".into(),
            };
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return NativeHostStatus {
                browser: browser.to_string(),
                manifest_path,
                status: "invalid_manifest".into(),
                host_path: None,
                detail: format!("invalid JSON: {e}"),
            };
        }
    };

    let host_path = parsed.get("path").and_then(Value::as_str).map(String::from);
    let Some(ref path_str) = host_path else {
        return NativeHostStatus {
            browser: browser.to_string(),
            manifest_path,
            status: "invalid_manifest".into(),
            host_path: None,
            detail: "manifest missing \"path\" field".into(),
        };
    };

    let target = Path::new(path_str);
    if !target.exists() {
        let detail = format!("host binary does not exist: {path_str}");
        return NativeHostStatus {
            browser: browser.to_string(),
            manifest_path,
            status: "broken_target".into(),
            host_path,
            detail,
        };
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(target) {
            if meta.permissions().mode() & 0o111 == 0 {
                let detail = format!("host binary is not executable: {path_str}");
                return NativeHostStatus {
                    browser: browser.to_string(),
                    manifest_path,
                    status: "not_executable".into(),
                    host_path,
                    detail,
                };
            }
        }
    }

    let (field, expected) = if is_firefox {
        ("allowed_extensions", GECKO[0])
    } else {
        ("allowed_origins", ORIGINS[0])
    };
    let has_origin = parsed
        .get(field)
        .and_then(Value::as_array)
        .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(expected)));
    if !has_origin {
        return NativeHostStatus {
            browser: browser.to_string(),
            manifest_path,
            status: "missing_origin".into(),
            host_path,
            detail: format!("manifest {field} missing {expected}"),
        };
    }

    NativeHostStatus {
        browser: browser.to_string(),
        manifest_path,
        status: "ok".into(),
        host_path,
        detail: "registered and executable".into(),
    }
}

/// Diagnose native messaging host registration for every installed browser under `home`.
#[cfg(unix)]
pub fn diagnose_in(home: &Path) -> Vec<NativeHostStatus> {
    let mut out = Vec::new();
    for (label, rel) in CHROMIUM {
        let base = home.join(rel);
        if !base.is_dir() {
            continue;
        }
        let target = base.join("NativeMessagingHosts").join(format!("{NAME}.json"));
        out.push(inspect_manifest(label, &target, false));
    }
    let firefox_dir = home.join(FIREFOX);
    if firefox_dir.parent().is_some_and(Path::is_dir) {
        let target = firefox_dir.join(format!("{NAME}.json"));
        out.push(inspect_manifest("Firefox", &target, true));
    }
    out
}

/// Diagnose native messaging host registration for every installed browser for the current user.
#[cfg(unix)]
pub fn diagnose() -> Result<Vec<NativeHostStatus>> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    Ok(diagnose_in(&home))
}

#[cfg(windows)]
pub fn diagnose() -> Result<Vec<NativeHostStatus>> {
    let local = dirs::data_local_dir().ok_or_else(|| anyhow!("no local app data"))?;
    let roaming = dirs::data_dir().ok_or_else(|| anyhow!("no app data"))?;
    let mut out = Vec::new();
    for (key, data) in CHROMIUM {
        if !local.join(data).is_dir() {
            continue;
        }
        let reg_key = format!(r"HKCU\{key}\{NAME}");
        match registered(&reg_key) {
            Some(p) => out.push(inspect_manifest(data, &p, false)),
            None => out.push(NativeHostStatus {
                browser: (*data).into(),
                manifest_path: reg_key,
                status: "missing".into(),
                host_path: None,
                detail: "registry key not found".into(),
            }),
        }
    }
    if roaming.join(FIREFOX.1).is_dir() {
        let reg_key = format!(r"HKCU\{}\{NAME}", FIREFOX.0);
        match registered(&reg_key) {
            Some(p) => out.push(inspect_manifest("Firefox", &p, true)),
            None => out.push(NativeHostStatus {
                browser: "Firefox".into(),
                manifest_path: reg_key,
                status: "missing".into(),
                host_path: None,
                detail: "registry key not found".into(),
            }),
        }
    }
    Ok(out)
}

/// Self-repair missing, corrupt, stale, or broken native messaging registrations under `home`,
/// linking `~/.hanzo/zap/hanzo-zap-host` to `host_exe`.
#[cfg(unix)]
pub fn repair_in(home: &Path, host_exe: &Path) -> Result<RepairReport> {
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
    let targets: Vec<(&str, PathBuf, PathBuf, &str, bool)> = CHROMIUM
        .iter()
        .map(|(label, b)| (*label, home.join(b), home.join(b).join("NativeMessagingHosts"), chromium.as_str(), false))
        .chain([(
            "Firefox",
            firefox_dir.parent().unwrap_or(home).to_path_buf(),
            firefox_dir.clone(),
            firefox.as_str(),
            true,
        )])
        .collect();

    let mut report = RepairReport::default();
    for (label, base, hosts, body, is_firefox) in targets {
        if !base.is_dir() {
            report.skipped_not_installed += 1;
            continue;
        }
        let target = hosts.join(format!("{NAME}.json"));
        let check = inspect_manifest(label, &target, is_firefox);
        if check.status == "ok" {
            report.already_ok.push(target);
            continue;
        }
        match link_to(&exe, host_exe)
            .and_then(|()| Ok(std::fs::create_dir_all(&hosts)?))
            .and_then(|()| Ok(std::fs::write(&target, body)?))
        {
            Ok(()) => report.repaired.push(target),
            Err(e) => report.errors.push(format!("{label} ({}): {e}", target.display())),
        }
    }
    Ok(report)
}

/// Self-repair missing or broken native messaging registrations for the current user.
#[cfg(unix)]
pub fn repair() -> Result<RepairReport> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let exe = std::env::current_exe()?;
    repair_in(&home, &exe)
}

/// Register the host with every browser installed for this user, repairing any
/// missing, corrupt, or broken manifest while preserving healthy manifests.
#[cfg(unix)]
pub fn install() -> Result<Vec<PathBuf>> {
    Ok(repair()?.repaired)
}

/// Register the host with every browser installed for this user: a manifest
/// per family in `~/.hanzo/zap`, named by each browser's registry key. A key
/// whose manifest names a program that exists is left as it is, as on Unix.
#[cfg(windows)]
pub fn repair() -> Result<RepairReport> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let local = dirs::data_local_dir().ok_or_else(|| anyhow!("no local app data"))?;
    let roaming = dirs::data_dir().ok_or_else(|| anyhow!("no app data"))?;
    let dir = home.join(".hanzo").join("zap");
    let exe = dir.join(format!("{BIN}.exe"));
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
    let chromium = (dir.join(format!("{NAME}.json")), manifest(("allowed_origins", json!(ORIGINS)))?);
    let firefox = (dir.join(format!("{NAME}.firefox.json")), manifest(("allowed_extensions", json!(GECKO)))?);
    let targets = CHROMIUM
        .iter()
        .map(|(key, data)| (local.join(data), *key, &chromium, false))
        .chain([(roaming.join(FIREFOX.1), FIREFOX.0, &firefox, true)]);

    let mut report = RepairReport::default();
    for (installed, key, (file, body), is_firefox) in targets {
        let key = format!(r"HKCU\{key}\{NAME}");
        if !installed.is_dir() {
            report.skipped_not_installed += 1;
            continue;
        }
        if registered(&key).is_some_and(|m| inspect_manifest(&key, &m, is_firefox).status == "ok") {
            report.already_ok.push(PathBuf::from(&key));
            continue;
        }
        link(&exe)?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(file, body)?;
        let status = std::process::Command::new("reg")
            .args(["add", &key, "/ve", "/t", "REG_SZ", "/d"])
            .arg(file)
            .arg("/f")
            .stdout(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            return Err(anyhow!("reg add {key} failed ({status})"));
        }
        report.repaired.push(PathBuf::from(key));
    }
    Ok(report)
}

#[cfg(windows)]
pub fn install() -> Result<Vec<PathBuf>> {
    Ok(repair()?.repaired)
}

/// The manifest path a host key names, read with `reg query`.
#[cfg(windows)]
fn registered(key: &str) -> Option<PathBuf> {
    let out = std::process::Command::new("reg").args(["query", key, "/ve"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("REG_SZ"))?;
    Some(PathBuf::from(line.split("REG_SZ").nth(1)?.trim()))
}

/// `~/.hanzo/zap/hanzo-zap-host` -> `exe`.
#[cfg(unix)]
fn link_to(at: &Path, exe: &Path) -> Result<()> {
    if std::fs::read_link(at).ok().as_deref() == Some(exe) && at.exists() {
        return Ok(());
    }
    if let Some(dir) = at.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(at);
    std::os::unix::fs::symlink(exe, at)?;
    Ok(())
}

/// `~\.hanzo\zap\hanzo-zap-host.exe`, this binary: a hard link, since a
/// symlink needs a privilege a user may not hold, or a copy across volumes.
#[cfg(windows)]
fn link(at: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    if let Some(dir) = at.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let same = std::fs::metadata(at).ok().zip(std::fs::metadata(&exe).ok()).is_some_and(|(a, b)| a.len() == b.len() && a.modified().ok() == b.modified().ok());
    if same {
        return Ok(());
    }
    let _ = std::fs::remove_file(at);
    if std::fs::hard_link(&exe, at).is_err() {
        std::fs::copy(&exe, at)?;
    }
    Ok(())
}

/// This process was started as the host.
pub fn invoked() -> bool {
    std::env::args_os()
        .next()
        .and_then(|a| Path::new(&a).file_stem().map(|n| n == BIN))
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
fn to_browser(mut sock: Door, mut out: impl Write) {
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
fn to_router(mut input: impl Read, mut sock: Door) -> Result<()> {
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

/// The router's door, waiting out an election in progress.
fn dial(deadline: Instant) -> Result<Door> {
    loop {
        match open() {
            Ok(s) => return Ok(s),
            Err(e) if Instant::now() > deadline => return Err(anyhow!("zap: no router door: {e}")),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(unix)]
fn open() -> std::io::Result<Door> {
    std::os::unix::net::UnixStream::connect(zapd::socket_path())
}

/// The router's pipe, opened as a file, and only if its server is the process
/// holding the router lock: a pipe name is not private to a user, so another
/// process could make one before the router does.
#[cfg(windows)]
fn open() -> std::io::Result<Door> {
    use std::os::windows::io::AsRawHandle;
    let pipe = std::fs::OpenOptions::new().read(true).write(true).open(zapd::socket_path())?;
    let mut pid = 0u32;
    // SAFETY: the handle is the open client end of a named pipe.
    let ok = unsafe { windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } != 0;
    if !ok || zapd::holder() != Some(pid) {
        return Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "the pipe is not served by the router lock holder"));
    }
    Ok(pipe)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn diagnose_and_repair_fixes_missing_and_broken_manifests() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let chrome_dir = home.join(CHROMIUM[0].1);
        std::fs::create_dir_all(&chrome_dir).unwrap();

        // 1. Missing manifest detected
        let d1 = diagnose_in(home);
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].status, "missing");

        // 2. Repair creates manifest + symlink to current executable
        let exe = std::env::current_exe().unwrap();
        let rep = repair_in(home, &exe).unwrap();
        assert_eq!(rep.repaired.len(), 1);
        assert!(rep.errors.is_empty());

        let d2 = diagnose_in(home);
        assert_eq!(d2[0].status, "ok");

        // 3. Corrupt / broken target manifest is detected and self-repaired
        let manifest_path = chrome_dir.join("NativeMessagingHosts").join(format!("{NAME}.json"));
        std::fs::write(&manifest_path, r#"{"name":"ai.hanzo.zap","path":"/nonexistent/host","allowed_origins":[]}"#).unwrap();
        let d3 = diagnose_in(home);
        assert_eq!(d3[0].status, "broken_target");

        let rep2 = repair_in(home, &exe).unwrap();
        assert_eq!(rep2.repaired.len(), 1);
        assert_eq!(diagnose_in(home)[0].status, "ok");
    }
}
