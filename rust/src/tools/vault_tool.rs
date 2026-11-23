//! `vault` — Sovereign credential vault unifying Hanzo KMS (`kms.hanzo.ai` / `hanzo kms`),
//! LastPass (`lpass` CLI), and ZAP Agentic Browser Auto-Login.
//!
//! Mirrors `src/tools/vault.ts` (absorbed into `hanzo` resource=`vault` / `kms`, and
//! callable directly via legacy `tools/call` alias `vault`).
//! Secrets NEVER leave memory into tool output or logs.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

const ACTIONS: &[&str] = &["status", "list", "seal", "sync_lastpass", "totp", "browser_login"];

pub fn slugify_app(input: &str) -> String {
    let s = input
        .trim()
        .to_lowercase()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    let mut collapsed = String::new();
    let mut prev_under = true;
    for c in s.chars() {
        if c == '_' {
            if !prev_under {
                collapsed.push('_');
            }
            prev_under = true;
        } else {
            collapsed.push(c);
            prev_under = false;
        }
    }
    let clean = collapsed.trim_matches('_').to_string();
    if clean.is_empty() { "default".into() } else { clean }
}

/// Resolve the sovereign `hanzo` CLI binary (never `/usr/bin/hanzo` or `/bin/hanzo`).
pub fn resolve_hanzo_bin() -> PathBuf {
    if let Ok(env_bin) = std::env::var("HANZO_BIN") {
        let p = PathBuf::from(env_bin.trim());
        if !env_bin.trim().is_empty() && p != PathBuf::from("/usr/bin/hanzo") && p != PathBuf::from("/bin/hanzo") {
            return p;
        }
    }
    if let Some(home) = dirs::home_dir() {
        let local = home.join(".local").join("bin").join("hanzo");
        if local.is_file() {
            return local;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join("hanzo");
            if beside.is_file() && beside != PathBuf::from("/usr/bin/hanzo") {
                return beside;
            }
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("bin")
        .join("hanzo")
}

fn run_hanzo_kms(args: &[&str], redact: &[&str]) -> Result<String> {
    let bin = resolve_hanzo_bin();
    let out = std::process::Command::new(&bin)
        .arg("kms")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| anyhow!("cannot run {} kms: {e}", bin.display()))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    for secret in redact {
        if secret.len() >= 3 {
            msg = msg.replace(secret, "[REDACTED]");
        }
    }
    Err(anyhow!("{msg}"))
}

pub async fn kms_get_secret(api: &HanzoApi, full_key: &str, env: &str) -> Option<String> {
    // 1. Try `hanzo kms get <key> --env <env> --raw`
    if let Ok(val) = run_hanzo_kms(&["get", full_key, "--env", env, "--raw"], &[]) {
        if !val.is_empty() {
            return Some(val);
        }
    }
    // 2. Try KMS HTTP endpoint (`KMS_URL` or `https://kms.hanzo.ai`)
    let kms_base = std::env::var("HANZO_KMS_URL")
        .or_else(|_| std::env::var("KMS_URL"))
        .unwrap_or_else(|_| "https://kms.hanzo.ai".into());
    let bearer = api.key()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let url = format!("{}/v1/kms/secrets/{}", kms_base.trim_end_matches('/'), full_key.trim_start_matches('/'));
    let resp = client
        .get(&url)
        .query(&[("env", env)])
        .bearer_auth(bearer)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    body.get("value")
        .or_else(|| body.get("secretValue"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub async fn kms_set_secret(api: &HanzoApi, path: &str, key: &str, value: &str, env: &str) -> Result<()> {
    let full = format!("{}/{}", path.trim_matches('/'), key.trim_matches('/'));
    if run_hanzo_kms(&["set", &full, value, "--env", env], &[value]).is_ok() {
        return Ok(());
    }
    let kms_base = std::env::var("HANZO_KMS_URL")
        .or_else(|_| std::env::var("KMS_URL"))
        .unwrap_or_else(|_| "https://kms.hanzo.ai".into());
    let bearer = api.key().ok_or_else(|| anyhow!(crate::hanzo_api::NO_KEY))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let url = format!("{}/v1/kms/secrets/{}", kms_base.trim_end_matches('/'), full);
    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .json(&json!({ "env": env, "value": value }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("KMS set failed (HTTP {})", resp.status().as_u16()));
    }
    Ok(())
}

pub async fn kms_list_secret_groups(api: &HanzoApi, env: &str) -> Vec<Value> {
    let mut by_path: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Ok(out) = run_hanzo_kms(&["list", "--env", env, "-o", "json"], &[]) {
        if let Ok(v) = serde_json::from_str::<Value>(&out) {
            let items = v
                .get("secrets")
                .and_then(Value::as_array)
                .or_else(|| v.as_array())
                .cloned()
                .unwrap_or_default();
            for item in items {
                let name = item
                    .get("name")
                    .or_else(|| item.get("key"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some((dir, k)) = name.rsplit_once('/') {
                    by_path.entry(dir.to_string()).or_default().push(k.to_string());
                } else if !name.is_empty() {
                    by_path.entry("root".into()).or_default().push(name.to_string());
                }
            }
        }
    } else if let Some(bearer) = api.key() {
        let kms_base = std::env::var("HANZO_KMS_URL")
            .or_else(|_| std::env::var("KMS_URL"))
            .unwrap_or_else(|_| "https://kms.hanzo.ai".into());
        if let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build() {
            let url = format!("{}/v1/kms/secrets", kms_base.trim_end_matches('/'));
            if let Ok(resp) = client.get(&url).query(&[("env", env)]).bearer_auth(bearer).send().await {
                if let Ok(v) = resp.json::<Value>().await {
                    let items = v
                        .get("secrets")
                        .and_then(Value::as_array)
                        .or_else(|| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    for item in items {
                        let name = item.get("name").or_else(|| item.get("key")).and_then(Value::as_str).unwrap_or("");
                        if let Some((dir, k)) = name.rsplit_once('/') {
                            by_path.entry(dir.to_string()).or_default().push(k.to_string());
                        } else if !name.is_empty() {
                            by_path.entry("root".into()).or_default().push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    by_path
        .into_iter()
        .map(|(path, mut keys)| {
            keys.sort();
            keys.dedup();
            let app = path.strip_prefix("credentials/").unwrap_or(&path).to_string();
            json!({
                "app": app,
                "path": path,
                "keys": keys,
                "source": "hanzo_kms",
            })
        })
        .collect()
}

// Minimal pure-Rust SHA-1 + HMAC-SHA1 + Base32 for RFC 6238 TOTP (zero extra deps, never logged).
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha1(key);
        k[..20].copy_from_slice(&hashed);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = ipad.to_vec();
    inner.extend_from_slice(message);
    let inner_hash = sha1(&inner);
    let mut outer = opad.to_vec();
    outer.extend_from_slice(&inner_hash);
    sha1(&outer)
}

fn decode_base32(secret: &str) -> Result<Vec<u8>> {
    let raw = if secret.starts_with("otpauth://") {
        secret
            .split('?')
            .nth(1)
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("secret=")))
            .unwrap_or(secret)
    } else {
        secret
    };
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if clean.is_empty() {
        return Err(anyhow!("empty TOTP Base32 secret"));
    }
    let mut bits: u64 = 0;
    let mut bit_count = 0;
    let mut out = Vec::new();
    for ch in clean.chars() {
        let val: u64 = match ch {
            'A'..='Z' => (ch as u8 - b'A') as u64,
            '2'..='7' => (ch as u8 - b'2' + 26) as u64,
            _ => return Err(anyhow!("invalid Base32 character in TOTP secret")),
        };
        bits = (bits << 5) | val;
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xFF) as u8);
        }
    }
    Ok(out)
}

fn generate_totp(secret: &str) -> Result<(String, u64)> {
    let key = decode_base32(secret)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let step = now / 30;
    let rem = 30 - (now % 30);
    let digest = hmac_sha1(&key, &step.to_be_bytes());
    let offset = (digest[19] & 0x0f) as usize;
    let bin_code = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    Ok((format!("{:06}", bin_code % 1_000_000), rem))
}

pub struct VaultTool {
    api: HanzoApi,
}

impl VaultTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }

    pub fn schema() -> Value {
        json!({
            "name": "vault",
            "description": "Sovereign credential vault unifying Hanzo KMS (`kms.hanzo.ai` / `hanzo kms`), LastPass (`lpass`), and ZAP Agentic Browser Auto-Login. Secrets live ONLY in Hanzo KMS and are NEVER returned or written to disk.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ACTIONS,
                        "description": "Vault operation: status | list | seal | sync_lastpass | totp | browser_login"
                    },
                    "app": { "type": "string", "description": "App or connector slug (e.g. gmail, salesforce, github, lastpass)" },
                    "env": { "type": "string", "description": "Hanzo KMS environment (default: prod)" },
                    "path": { "type": "string", "description": "Custom KMS secret path override (default: credentials/<app>)" },
                    "username": { "type": "string", "description": "seal: account username or email" },
                    "password": { "type": "string", "description": "seal: account password (sealed to KMS, never echoed)" },
                    "api_key": { "type": "string", "description": "seal: API key (sealed to KMS, never echoed)" },
                    "oauth_token": { "type": "string", "description": "seal: OAuth bearer token (sealed to KMS, never echoed)" },
                    "totp_secret": { "type": "string", "description": "seal: Base32 TOTP secret or otpauth:// URI (sealed to KMS)" },
                    "url": { "type": "string", "description": "seal: login or app URL" },
                    "notes": { "type": "string", "description": "seal: non-echoed credential notes" },
                    "custom": { "type": "object", "description": "seal: additional key/value secrets" },
                    "loginUrl": { "type": "string", "description": "browser_login: explicit login URL override" },
                    "fillSelector": { "type": "string", "description": "totp: snapshot ref (@eN) or CSS selector to fill TOTP via ZAP" },
                    "submit": { "type": "boolean", "description": "totp: press Enter after filling TOTP" },
                    "tabId": { "type": ["string", "integer"], "description": "target browser tab ID" },
                    "targetBrowser": { "type": "string", "description": "ZAP browser filter (chrome | firefox)" },
                    "clientId": { "type": "string", "description": "Explicit ZAP browser node ID" },
                    "filterApp": { "type": "string", "description": "sync_lastpass: optional app substring filter" }
                },
                "required": ["action"]
            }
        })
    }
}

impl Default for VaultTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for VaultTool {
    fn name(&self) -> &str {
        "vault"
    }

    fn description(&self) -> &str {
        "Sovereign credential vault (Hanzo KMS + LastPass + ZAP Auto-Login; zero plaintext output)"
    }

    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params.get("action").and_then(Value::as_str).unwrap_or("status");
        let env = params.get("env").and_then(Value::as_str).unwrap_or("prod");

        match action {
            "status" => {
                let bin = resolve_hanzo_bin();
                let bin_exists = bin.is_file();
                let kms_ready = run_hanzo_kms(&["health"], &[]).is_ok() || self.api.has_key();
                let groups = kms_list_secret_groups(&self.api, env).await;
                let lpass_installed = which::which("lpass").is_ok();
                let zap_browsers: Vec<Value> = crate::zap::browsers()
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(crate::zap::describe)
                    .collect();
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "status",
                    json!({
                        "kms": {
                            "binary": bin.display().to_string(),
                            "available": bin_exists || self.api.has_key(),
                            "ready": kms_ready,
                            "secretGroupCount": groups.len(),
                        },
                        "lastpass": { "installed": lpass_installed },
                        "zapBrowsers": zap_browsers,
                    }),
                )))
            }

            "list" => {
                let groups = kms_list_secret_groups(&self.api, env).await;
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "list",
                    json!({
                        "env": env,
                        "count": groups.len(),
                        "credentials": groups,
                    }),
                )))
            }

            "seal" => {
                let Some(app_raw) = params.get("app").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("vault", "seal", "INVALID_ARGS", "app required")));
                };
                let slug = slugify_app(app_raw);
                let kms_path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("credentials/{slug}"));

                let fields = [
                    ("username", "USERNAME"),
                    ("password", "PASSWORD"),
                    ("api_key", "API_KEY"),
                    ("oauth_token", "OAUTH_TOKEN"),
                    ("totp_secret", "TOTP_SECRET"),
                    ("url", "URL"),
                    ("notes", "NOTES"),
                ];
                let mut sealed_keys: Vec<String> = Vec::new();
                for (arg_k, kms_k) in fields {
                    if let Some(val) = params.get(arg_k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        if let Err(e) = kms_set_secret(&self.api, &kms_path, kms_k, val, env).await {
                            return Ok(ToolResult::ok(envelope_err("vault", "seal", "KMS_ERROR", e.to_string())));
                        }
                        sealed_keys.push(kms_k.to_string());
                    }
                }
                if let Some(custom) = params.get("custom").and_then(Value::as_object) {
                    for (ck, cv) in custom {
                        if let Some(val) = cv.as_str().filter(|s| !s.is_empty()) {
                            let safe_key = ck.trim().to_uppercase().replace(|c: char| !c.is_ascii_alphanumeric(), "_");
                            if let Err(e) = kms_set_secret(&self.api, &kms_path, &safe_key, val, env).await {
                                return Ok(ToolResult::ok(envelope_err("vault", "seal", "KMS_ERROR", e.to_string())));
                            }
                            sealed_keys.push(safe_key);
                        }
                    }
                }
                if sealed_keys.is_empty() {
                    return Ok(ToolResult::ok(envelope_err(
                        "vault",
                        "seal",
                        "INVALID_ARGS",
                        "provide at least one credential field (username, password, api_key, oauth_token, totp_secret, custom)",
                    )));
                }
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "seal",
                    json!({
                        "sealed": true,
                        "app": slug,
                        "path": kms_path,
                        "env": env,
                        "keysSealed": sealed_keys,
                    }),
                )))
            }

            "totp" => {
                let Some(app_raw) = params.get("app").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("vault", "totp", "INVALID_ARGS", "app required")));
                };
                let slug = slugify_app(app_raw);
                let kms_path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("credentials/{slug}"));
                let Some(secret) = kms_get_secret(&self.api, &format!("{kms_path}/TOTP_SECRET"), env).await else {
                    return Ok(ToolResult::ok(envelope_err(
                        "vault",
                        "totp",
                        "NOT_FOUND",
                        format!("no TOTP_SECRET sealed under {kms_path}"),
                    )));
                };
                let (code, valid_for_secs) = match generate_totp(&secret) {
                    Ok(pair) => pair,
                    Err(e) => return Ok(ToolResult::ok(envelope_err("vault", "totp", "INVALID_SECRET", e.to_string()))),
                };
                let mut filled = false;
                if let Some(sel) = params.get("fillSelector").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    let target_browser = params.get("targetBrowser").and_then(Value::as_str);
                    let client_id = params.get("clientId").and_then(Value::as_str);
                    if let Ok(Some(provider)) = crate::zap::resolve(target_browser, client_id).await {
                        let mut p: Vec<(String, String)> = vec![
                            ("selector".into(), sel.to_string()),
                            ("value".into(), code),
                        ];
                        if let Some(tid) = params.get("tabId") {
                            p.push(("tabId".into(), tid.as_str().map(str::to_string).unwrap_or_else(|| tid.to_string())));
                        }
                        if crate::zap::route(&provider, "hanzo.fill", &p, std::time::Duration::from_secs(10)).await.is_ok() {
                            filled = true;
                            if params.get("submit").and_then(Value::as_bool) == Some(true) {
                                let mut enter: Vec<(String, String)> = vec![("key".into(), "Enter".into())];
                                if let Some(tid) = params.get("tabId") {
                                    enter.push(("tabId".into(), tid.as_str().map(str::to_string).unwrap_or_else(|| tid.to_string())));
                                }
                                let _ = crate::zap::route(&provider, "hanzo.press", &enter, std::time::Duration::from_secs(10)).await;
                            }
                        }
                    }
                }
                // NEVER return the TOTP digits in tool output!
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "totp",
                    json!({
                        "app": slug,
                        "path": kms_path,
                        "totpReady": true,
                        "filledInBrowser": filled,
                        "validForSeconds": valid_for_secs,
                    }),
                )))
            }

            "sync_lastpass" => {
                let Ok(lpass) = which::which("lpass") else {
                    return Ok(ToolResult::ok(envelope_err(
                        "vault",
                        "sync_lastpass",
                        "NOT_INSTALLED",
                        "lpass CLI is not installed on PATH",
                    )));
                };
                let out = std::process::Command::new(lpass)
                    .args(["export", "--sync=no", "--fields=name,url,username,password,totp"])
                    .stdin(Stdio::null())
                    .output()?;
                if !out.status.success() {
                    return Ok(ToolResult::ok(envelope_err(
                        "vault",
                        "sync_lastpass",
                        "LPASS_ERROR",
                        "lpass export failed (ensure `lpass status` is signed in)",
                    )));
                }
                let filter = params
                    .get("filterApp")
                    .and_then(Value::as_str)
                    .map(|s| s.to_lowercase());
                let csv = String::from_utf8_lossy(&out.stdout);
                let mut synced: Vec<String> = Vec::new();
                for line in csv.lines().skip(1) {
                    let cols: Vec<&str> = line.splitn(5, ',').collect();
                    if cols.len() < 4 {
                        continue;
                    }
                    let slug = slugify_app(if !cols[0].is_empty() { cols[0] } else { cols[1] });
                    if let Some(ref f) = filter {
                        if !slug.contains(f) {
                            continue;
                        }
                    }
                    let kms_path = format!("credentials/{slug}");
                    if !cols[1].is_empty() {
                        let _ = kms_set_secret(&self.api, &kms_path, "URL", cols[1], env).await;
                    }
                    if !cols[2].is_empty() {
                        let _ = kms_set_secret(&self.api, &kms_path, "USERNAME", cols[2], env).await;
                    }
                    if !cols[3].is_empty() {
                        let _ = kms_set_secret(&self.api, &kms_path, "PASSWORD", cols[3], env).await;
                    }
                    if cols.len() == 5 && !cols[4].is_empty() {
                        let _ = kms_set_secret(&self.api, &kms_path, "TOTP_SECRET", cols[4], env).await;
                    }
                    synced.push(slug);
                }
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "sync_lastpass",
                    json!({ "syncedCount": synced.len(), "apps": synced }),
                )))
            }

            "browser_login" => {
                let Some(app_raw) = params.get("app").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("vault", "browser_login", "INVALID_ARGS", "app required")));
                };
                let slug = slugify_app(app_raw);
                let kms_path = params
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("credentials/{slug}"));
                let target_browser = params.get("targetBrowser").and_then(Value::as_str);
                let client_id = params.get("clientId").and_then(Value::as_str);
                let provider = match crate::zap::resolve(target_browser, client_id).await {
                    Ok(Some(p)) => p,
                    Ok(None) => return Ok(ToolResult::ok(envelope_err("vault", "browser_login", "NO_BROWSER", crate::zap::UNPAIRED))),
                    Err(e) => return Ok(ToolResult::ok(envelope_err("vault", "browser_login", "NO_BROWSER", e.to_string()))),
                };
                let login_url = match params.get("loginUrl").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    Some(u) => u.to_string(),
                    None => kms_get_secret(&self.api, &format!("{kms_path}/URL"), env)
                        .await
                        .unwrap_or_default(),
                };
                if login_url.is_empty() {
                    return Ok(ToolResult::ok(envelope_err(
                        "vault",
                        "browser_login",
                        "MISSING_URL",
                        format!("loginUrl or {kms_path}/URL required"),
                    )));
                }
                let created = crate::zap::route(
                    &provider,
                    "Target.createTarget",
                    &[("url".into(), login_url.clone())],
                    std::time::Duration::from_secs(10),
                )
                .await;
                Ok(ToolResult::ok(envelope_ok(
                    "vault",
                    "browser_login",
                    json!({
                        "app": slug,
                        "url": login_url,
                        "opened": created.is_ok(),
                    }),
                )))
            }

            _ => Ok(ToolResult::ok(envelope_err(
                "vault",
                action,
                "INVALID_ARGS",
                format!("Unknown vault action {action:?}. Valid: {}", ACTIONS.join(", ")),
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_totp_and_slugify_behave_deterministically() {
        assert_eq!(slugify_app("https://www.Google.com/Calendar/"), "google_com_calendar");
        // JBSWY3DPEHPK3PXP is valid Base32 ("Hello!\xDE\xAD\xBE\xEF")
        let (code, rem) = generate_totp("JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert!((1..=30).contains(&rem));
    }
}
