//! Hanzo API client — the shared conduit to the live api.hanzo.ai backend.
//!
//! One value owns credentials, base URL, and the HTTP client so every
//! cloud-backed tool composes over the same seam (HIP-0300).
//!
//! Auth, in this order: a `pk-`/`sk-` bearer key from `HANZO_API_KEY` (explicit);
//! else the person's `hanzo` login, the short-lived token `hanzo auth token`
//! prints, asked again before it lapses; else `~/.hanzo/config.json` field
//! `apiKey`, the legacy stored key, last, so a key left behind for another
//! account never speaks for a person who has signed in. So a desktop app that
//! starts `hanzo-mcp` with no environment of its own reaches Kai and Enso as the
//! signed-in person.
//!
//! A login holds several identities. The CLI's active one answers by default;
//! naming one (`as` on a call, `use` for this process) asks the CLI for that
//! identity's token (`hanzo auth token --as`), whatever key is set. Base URL:
//! `HANZO_API_BASE`, else `https://api.hanzo.ai`.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default base URL for the Hanzo cloud API.
pub const DEFAULT_BASE_URL: &str = "https://api.hanzo.ai";

/// What every cloud-backed tool says when no key resolved — one sentence in one
/// place, so the shapes cannot drift apart tool by tool.
///
/// Cloud admits two: `pk-` is the publishable key you may ship in a browser
/// bundle, `sk-` is the one you may not. `APIKeyPrefixes` in cloud's
/// `auth_identity.go` is the authority; anything else resolves to no principal.
pub const NO_KEY: &str = "no API key: run `hanzo login` or set HANZO_API_KEY (pk-/sk-)";

/// How long a token from `hanzo auth token` is used before it is asked for
/// again: well inside its lifetime, and the CLI refreshes it when asked.
const LOGIN_TTL: Duration = Duration::from_secs(300);

/// What a call says when it names a login and there is no `hanzo` CLI to ask.
const NO_CLI: &str = "no `hanzo` CLI beside this binary or at ~/.local/bin/hanzo: install it from hanzo.sh";

/// The identity this process acts as, chosen with `auth use`. One per process,
/// whatever tool asks: every `HanzoApi` reads it.
static USING: Mutex<Option<String>> = Mutex::new(None);

/// Tokens the CLI printed, by (CLI, identity), each with when it was asked.
static TOKENS: Mutex<BTreeMap<String, (Instant, String)>> = Mutex::new(BTreeMap::new());

/// The identity this process was told to act as, if any.
pub fn using() -> Option<String> {
    USING.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Act as `identity` in this process (`None`: back to the CLI's active one).
pub fn set_using(identity: Option<String>) {
    *USING.lock().unwrap_or_else(|e| e.into_inner()) = identity;
}

/// The key a token is held under: the CLI asked and the identity named, if any.
fn slot(cli: &Path, who: Option<&str>) -> String {
    format!("{}\n{}", cli.display(), who.unwrap_or_default())
}

/// Drop the token held for `cli`'s active identity, so the next request asks
/// again. After a switch it is the previous identity's; a named identity's token
/// is its own and stays.
fn forget(cli: &Path) {
    TOKENS.lock().unwrap_or_else(|e| e.into_inner()).remove(&slot(cli, None));
}

/// Whether `s` names an identity: an owner or `owner/name`, as the CLI spells
/// them. It reaches argv, so it cannot begin with `-` or hold anything else.
pub fn identity_ok(s: &str) -> bool {
    let mut parts = s.split('/');
    let (owner, name) = (parts.next().unwrap_or_default(), parts.next());
    let word = |w: &str| {
        w.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && w.chars().all(|c| c.is_ascii_alphanumeric() || "._@+-".contains(c))
    };
    s.len() <= 128 && parts.next().is_none() && word(owner) && name.is_none_or(word)
}

/// Where a credential came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// `HANZO_API_KEY`.
    Env,
    /// The person's `hanzo` login.
    Login,
    /// `~/.hanzo/config.json` `apiKey`.
    Stored,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Login => "login",
            Source::Stored => "stored",
        }
    }
}

/// The bearer a request carries and how it was found.
#[derive(Clone, Debug)]
pub struct Credential {
    pub source: Source,
    pub token: String,
    /// The identity asked for by name (`as`, or `use` in this process).
    pub named: Option<String>,
    /// Why the login did not answer, when another source did.
    pub skipped: Option<String>,
}

/// Client for the Hanzo cloud API (code knowledge, web, vision).
#[derive(Clone)]
pub struct HanzoApi {
    base_url: String,
    /// `HANZO_API_KEY`.
    env_key: Option<String>,
    /// `~/.hanzo/config.json` `apiKey`: the legacy key, consulted last.
    stored_key: Option<String>,
    /// The `hanzo` CLI whose login answers.
    login: Option<PathBuf>,
    client: reqwest::Client,
}

impl HanzoApi {
    /// Build a client from the environment: `HANZO_API_BASE` / `HANZO_API_KEY`,
    /// the `hanzo` CLI beside this binary, `~/.hanzo/config.json`, and the
    /// default base URL.
    pub fn from_env() -> Self {
        let base_url = std::env::var("HANZO_API_BASE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let env_key = std::env::var("HANZO_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        let beside = std::env::current_exe()
            .ok()
            .and_then(|e| e.canonicalize().ok().or(Some(e)))
            .and_then(|e| e.parent().map(Path::to_path_buf));
        Self::with(base_url, env_key, dirs::home_dir().as_deref(), beside.as_deref())
    }

    /// The same, from what `from_env` reads: the environment's key, the home
    /// directory and the directory of this binary.
    pub(crate) fn with(base_url: String, env_key: Option<String>, home: Option<&Path>, beside: Option<&Path>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("hanzo-mcp/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let stored_key = home
            .and_then(|h| std::fs::read_to_string(h.join(".hanzo").join("config.json")).ok())
            .and_then(|c| api_key_from_config_json(&c));
        Self { base_url, env_key, stored_key, login: hanzo_cli(beside, home), client }
    }

    /// The credential a request carries, with how it was found. `who` names a
    /// login identity for this call; without it the one `auth use` chose applies.
    /// A named identity is always the login's, whatever key is set: asking for it
    /// is the more specific word. Unnamed, the order is the env key, the login's
    /// active identity, the stored key.
    pub fn credential(&self, who: Option<&str>) -> Result<Credential, String> {
        self.resolve(using().as_deref(), who)
    }

    fn resolve(&self, using: Option<&str>, who: Option<&str>) -> Result<Credential, String> {
        fn named(s: Option<&str>) -> Option<&str> {
            s.map(str::trim).filter(|s| !s.is_empty())
        }
        if let Some(id) = named(who).or(named(using)) {
            if !identity_ok(id) {
                return Err(format!("{id:?} is not an identity: say an owner or owner/name"));
            }
            let cli = self.login.as_deref().ok_or(NO_CLI)?;
            let token = login_token(cli, Some(id))?;
            return Ok(Credential { source: Source::Login, token, named: Some(id.to_string()), skipped: None });
        }
        if let Some(key) = &self.env_key {
            return Ok(Credential { source: Source::Env, token: key.clone(), named: None, skipped: None });
        }
        let skipped = match self.login.as_deref().map(|cli| login_token(cli, None)).unwrap_or_else(|| Err(NO_CLI.into())) {
            Ok(token) => return Ok(Credential { source: Source::Login, token, named: None, skipped: None }),
            Err(why) => why,
        };
        match &self.stored_key {
            Some(key) => Ok(Credential { source: Source::Stored, token: key.clone(), named: None, skipped: Some(skipped) }),
            None => Err(format!("{NO_KEY} ({skipped})")),
        }
    }

    /// The credential a request carries: the key, else the login's current token.
    pub fn key(&self) -> Option<String> {
        self.credential(None).ok().map(|c| c.token)
    }

    /// The CLI's identities, as `hanzo auth list -o json` prints them.
    pub fn identities(&self) -> Result<Vec<Value>, String> {
        let out = run_cli(self.login.as_deref().ok_or(NO_CLI)?, &["auth", "list", "-o", "json"])?;
        serde_json::from_str(&out).map_err(|e| format!("`hanzo auth list -o json` did not print JSON: {e}"))
    }

    /// Make `identity` the CLI's active one, for every tool on this machine.
    pub fn switch(&self, identity: &str) -> Result<String, String> {
        if !identity_ok(identity) {
            return Err(format!("{identity:?} is not an identity: say an owner or owner/name"));
        }
        let cli = self.login.as_deref().ok_or(NO_CLI)?;
        let said = run_cli(cli, &["auth", "switch", identity])?;
        forget(cli);
        Ok(said)
    }

    /// Whether an API key was resolved. Tools surface a clear error when false.
    pub fn has_key(&self) -> bool {
        self.key().is_some()
    }

    /// The resolved base URL (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// GET `path` with query params, returning the parsed JSON body.
    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        let mut req = self.client.get(join_url(&self.base_url, path));
        if !query.is_empty() {
            req = req.query(query);
        }
        self.send(req).await
    }

    /// POST `path` with a JSON body, returning the parsed JSON body.
    pub async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let req = self.client.post(join_url(&self.base_url, path)).json(&body);
        self.send(req).await
    }

    /// PATCH `path` with a JSON body, returning the parsed JSON body.
    pub async fn patch(&self, path: &str, body: Value) -> Result<Value> {
        let req = self.client.patch(join_url(&self.base_url, path)).json(&body);
        self.send(req).await
    }

    /// POST `path` with a JSON body over `text/event-stream`, returning the
    /// stream's decoded `data:` frames in order.
    ///
    /// The body arrives complete before it is decoded: a tool answers its caller
    /// once, so nothing downstream can consume a partial stream, and the whole
    /// response is exactly what [`frames`] already parses. An HTTP failure is an
    /// `Err` carrying the status and body — a stream that never started is not
    /// an empty stream.
    pub async fn events(&self, path: &str, body: Value) -> Result<Vec<Value>> {
        let req = self
            .client
            .post(join_url(&self.base_url, path))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&body);
        let resp = self.auth(req).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("{} {}", status.as_u16(), text.trim()));
        }
        Ok(frames(&text))
    }

    /// Send one JSON request and hold the answer to its status. A non-2xx, or a
    /// 2xx whose `/v1` envelope says `status: "error"`, is an `Err` carrying the
    /// status and the server's own sentence, so a refusal (a 402, a 429 plan cap)
    /// can never read as an empty success. `headers` ride beside the bearer —
    /// Enso's routing bounds, for one — and the answer keeps the response headers
    /// a caller reads back, such as `X-Routed-Model`.
    pub async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, String)],
    ) -> Result<Answer> {
        let mut req = self.client.request(method, join_url(&self.base_url, path));
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = self.auth(req).send().await?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let text = resp.text().await?;
        let parsed = serde_json::from_str::<Value>(&text).ok();
        if let Some(r) = refusal(status, parsed.as_ref()) {
            return Err(r.into());
        }
        let refused = parsed.as_ref().is_some_and(refused);
        if !(200..300).contains(&status) || refused {
            return Err(anyhow!("{}: {}", status, reason(parsed.as_ref(), &text)));
        }
        let body = parsed.ok_or_else(|| anyhow!("{}: not JSON: {}", status, text.chars().take(200).collect::<String>()))?;
        Ok(Answer { body, headers })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value> {
        // A transport error (DNS/refused/timeout) becomes Err so callers may
        // fall back to a local path; an HTTP error body is still JSON we pass on.
        let resp = self.auth(req).send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        Ok(serde_json::from_str::<Value>(&text)
            .unwrap_or_else(|_| json!({ "status": status, "body": text })))
    }

    /// Attach the bearer key. The one place credentials meet a request.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.key() {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}

/// The codes a plan refusal carries. Clients switch on these, never on the
/// message (hanzoai/ai `object.LimitHit`, `object.CodeInsufficientBalance`).
pub const REFUSAL_CODES: &[&str] = &[
    "plan_allowance_used",
    "paid_plan_required",
    "free_plan_cap",
    "model_cap",
    "usage_cap_exceeded",
    "insufficient_balance",
];

/// A plan refusal: a 402 or 429 whose code says the plan, a cap or the balance
/// declined the request. `error` is what a tool result carries — the status,
/// the code, the server's own sentence (which names no figure), the class, the
/// capped model and its fallback, the spent window, when it resets, and the
/// actions with their links — and nothing else from the body, so no amount,
/// count or cap reaches a result.
#[derive(Debug)]
pub struct Refusal {
    pub error: Value,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.error["status"], self.error["code"].as_str().unwrap_or_default())
    }
}

impl std::error::Error for Refusal {}

/// Read a non-2xx answer as a plan refusal, or `None` when it is any other error.
/// The gate answers `{error: {message, code, ...}}`; a controller answers the
/// `/v1` envelope `{status: "error", msg, code}`. Both read the same.
pub fn refusal(status: u16, body: Option<&Value>) -> Option<Refusal> {
    if status != 402 && status != 429 {
        return None;
    }
    let body = body?;
    let e = if body["error"].is_object() {
        body["error"].clone()
    } else if body["status"] == "error" {
        json!({ "code": body["code"], "message": body["msg"] })
    } else {
        return None;
    };
    let code = e["code"].as_str().filter(|c| REFUSAL_CODES.contains(c))?.to_string();
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let mut actions: Vec<Value> = e["actions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|x| text(&x["kind"]).is_some())
                .map(|x| {
                    let kept: serde_json::Map<String, Value> = ["kind", "label", "url", "plan", "model"]
                        .iter()
                        .filter_map(|k| text(&x[*k]).map(|v| (k.to_string(), json!(v))))
                        .collect();
                    Value::Object(kept)
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(up) = text(&e["upgrade_url"]) {
        if !actions.iter().any(|a| a["url"] == up.as_str()) {
            actions.insert(0, json!({ "kind": "upgrade", "url": up }));
        }
    }
    let mut error = serde_json::Map::new();
    error.insert("status".into(), json!(status));
    error.insert("code".into(), json!(code));
    // `limit` names the window that is spent (session or day), never its size.
    for (from, to) in [("message", "message"), ("class", "class"), ("model", "model"), ("fallback", "fallback"), ("limit", "window"), ("resets_at", "resets_at")] {
        if let Some(v) = text(&e[from]) {
            error.insert(to.into(), json!(v));
        }
    }
    error.insert("actions".into(), Value::Array(actions));
    Some(Refusal { error: Value::Object(error) })
}

/// A 2xx answer: the parsed body and the response headers.
pub struct Answer {
    pub body: Value,
    pub headers: reqwest::header::HeaderMap,
}

/// The sentence in a refusal: the gateway's `error.message` or `msg`, else the
/// body itself.
/// The keys a `/v1` envelope carries: `{status,msg,data}`, IAM's `sub`, `name` and
/// `data2`, and the bare `error`/`code` form.
const ENVELOPE: &[&str] = &["status", "msg", "data", "data2", "sub", "name", "error", "code"];

/// A 2xx that is a refusal: an envelope whose `status` is `error`. Only a body made
/// of envelope keys is an envelope. A body with any other key is a resource, and its
/// `status` is its own state: a failed coding run is `{"id":…,"status":"error",…}`,
/// an answer to return, not a refusal.
fn refused(body: &Value) -> bool {
    body.as_object().is_some_and(|o| o.keys().all(|k| ENVELOPE.contains(&k.as_str())))
        && body["status"] == "error"
}

fn reason(body: Option<&Value>, text: &str) -> String {
    let said = body.and_then(|b| {
        [&b["error"]["message"], &b["msg"], &b["message"], &b["error"]]
            .into_iter()
            .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_string))
    });
    said.unwrap_or_else(|| text.trim().chars().take(200).collect())
}

impl Default for HanzoApi {
    fn default() -> Self {
        Self::from_env()
    }
}

/// Decode an SSE body into its `data:` payloads, in order.
///
/// Hanzo's streams are data-only JSON that self-describes via `type`, so an
/// `event:` line carries nothing and is skipped. Per the SSE rule, repeated
/// `data:` lines within one frame join with a newline. The terminal `[DONE]`
/// sentinel mirrors the OpenAI convention and is a marker, not an event, so it
/// is dropped along with any payload that is not JSON.
pub fn frames(body: &str) -> Vec<Value> {
    fn flush(data: &mut String, out: &mut Vec<Value>) {
        let payload = std::mem::take(data);
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(payload) {
            out.push(v);
        }
    }

    let mut out = Vec::new();
    let mut data = String::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            flush(&mut data, &mut out);
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush(&mut data, &mut out);
    out
}

/// The `hanzo` CLI: the one beside this binary (hanzo.sh and `hanzo upgrade`
/// install them together), else at hanzo.sh's install path under `home`. Never a
/// `hanzo` found on PATH: the Hanzo IDE package installs `/usr/bin/hanzo`, which
/// opens its window on any arguments, `auth token` included.
fn hanzo_cli(beside: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "hanzo.exe" } else { "hanzo" };
    let installed = home.map(|h| h.join(".local").join("bin"));
    beside.into_iter().map(Path::to_path_buf).chain(installed).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Run the CLI and return what it printed, or the sentence it failed with.
fn run_cli(cli: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(cli)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("cannot run {}: {e}", cli.display()))?;
    if out.status.success() {
        return Ok(plain(&out.stdout).trim().to_string());
    }
    Err(said(&out.stderr, args))
}

/// `bytes` as text without terminal colour codes.
fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        for n in chars.by_ref() {
            if n.is_ascii_alphabetic() {
                break;
            }
        }
    }
    out
}

/// The last line a failed CLI wrote, without colour codes and with anything
/// shaped like a token dropped: it goes into results a model reads.
fn said(stderr: &[u8], args: &[&str]) -> String {
    let text = plain(stderr);
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let words: Vec<&str> = line.split_whitespace().map(|w| if w.starts_with("eyJ") { "…" } else { w }).collect();
    let line: String = words.join(" ").chars().take(200).collect();
    if line.is_empty() {
        format!("`hanzo {}` failed", args.join(" "))
    } else {
        line
    }
}

/// The login's access token, as `hanzo auth token` prints it (for `who`, the
/// identity named: `--as`), kept for `LOGIN_TTL`. An `Err` is the CLI's own
/// sentence: not signed in, a session that ended, an identity not held.
fn login_token(cli: &Path, who: Option<&str>) -> Result<String, String> {
    let slot = slot(cli, who);
    let mut held = TOKENS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, token)) = held.get(&slot) {
        if at.elapsed() < LOGIN_TTL {
            return Ok(token.clone());
        }
    }
    held.remove(&slot);
    let mut args = vec!["auth", "token"];
    args.extend(who.iter().flat_map(|id| ["--as", *id]));
    let out = run_cli(cli, &args)?;
    let token = out.lines().last().unwrap_or_default().trim().to_string();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err("`hanzo auth token` printed no token".into());
    }
    held.insert(slot, (Instant::now(), token.clone()));
    Ok(token)
}

/// The claims of a JWT, unverified: for saying who a token is, never for
/// trusting it. `None` when `token` is not one.
pub fn claims(token: &str) -> Option<Value> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What may be said of a key: its prefix, `sk-…` or `pk-…`, and no more.
pub fn key_prefix(key: &str) -> &'static str {
    match key.get(..3) {
        Some("sk-") => "sk-…",
        Some("pk-") => "pk-…",
        _ => "…",
    }
}

/// Extract the `apiKey` field from a `~/.hanzo/config.json` document.
pub fn api_key_from_config_json(content: &str) -> Option<String> {
    let v: Value = serde_json::from_str(content).ok()?;
    v.get("apiKey")
        .and_then(|k| k.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Join a base URL and a path with exactly one separating slash.
fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `hanzo` stand-in in `dir` that logs its arguments to `dir/asked` and answers
    /// like the CLI: the active token, a named identity's token, the list, a switch.
    #[cfg(unix)]
    fn cli(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("hanzo");
        let body = format!(
            r#"#!/bin/sh
echo "$@" >> {log}
case "$*" in
  "auth token") echo tok-active ;;
  "auth token --as "*) case "$4" in nobody) echo "no stored identity for nobody (see hanzo auth list)" >&2; exit 1 ;; *) echo "tok-$4" ;; esac ;;
  "auth list -o json") echo '[{{"key":"hanzo/a","owner":"hanzo","active":false}},{{"key":"hanzo/z","owner":"hanzo","active":true}}]' ;;
  "auth switch "*) echo "Switched to $3" ;;
  *) echo "unknown" >&2; exit 2 ;;
esac
"#,
            log = dir.join("asked").display()
        );
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn asked(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("asked")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn api(env: Option<&str>, home: &Path, beside: &Path) -> HanzoApi {
        HanzoApi::with(DEFAULT_BASE_URL.into(), env.map(str::to_string), Some(home), Some(beside))
    }

    /// A fresh machine: an empty home, no config, a `hanzo` beside the binary. The
    /// login answers, and is asked once, then kept.
    #[cfg(unix)]
    #[test]
    fn on_a_fresh_machine_the_login_is_the_credential() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let api = api(None, home.path(), bin.path());
        let c = api.resolve(None, None).unwrap();
        assert_eq!((c.source, c.token.as_str(), c.named), (Source::Login, "tok-active", None));
        assert_eq!(api.resolve(None, None).unwrap().token, "tok-active");
        assert_eq!(asked(bin.path()), ["auth token"], "asked once, then kept");
        assert!(api.has_key());
    }

    /// The CLI at hanzo.sh's install path answers when none sits beside the binary.
    #[cfg(unix)]
    #[test]
    fn the_cli_is_found_at_the_install_path() {
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&installed).unwrap();
        cli(&installed);
        let bin = tempfile::tempdir().unwrap();
        assert_eq!(api(None, home.path(), bin.path()).resolve(None, None).unwrap().token, "tok-active");
    }

    /// Env key, then login, then the stored key; each falls through to the next.
    #[cfg(unix)]
    #[test]
    fn the_order_is_the_env_key_then_the_login_then_the_stored_key() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".hanzo")).unwrap();
        std::fs::write(home.path().join(".hanzo").join("config.json"), r#"{"apiKey":"sk-stored"}"#).unwrap();

        // A stored key alone answers, last.
        let c = api(None, home.path(), bin.path()).resolve(None, None).unwrap();
        assert_eq!((c.source, c.token.as_str()), (Source::Stored, "sk-stored"));
        assert!(c.skipped.unwrap().contains("no `hanzo` CLI"), "says why the login did not answer");

        // With a login, the login beats the stored key.
        cli(bin.path());
        let c = api(None, home.path(), bin.path()).resolve(None, None).unwrap();
        assert_eq!((c.source, c.token.as_str()), (Source::Login, "tok-active"));

        // The env key beats both, and the login is not asked.
        let before = asked(bin.path()).len();
        let c = api(Some("sk-env"), home.path(), bin.path()).resolve(None, None).unwrap();
        assert_eq!((c.source, c.token.as_str()), (Source::Env, "sk-env"));
        assert_eq!(asked(bin.path()).len(), before);
    }

    /// A login that fails with a stored key falls to it and says why; with none, it is an error.
    #[cfg(unix)]
    #[test]
    fn a_login_that_cannot_answer_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let path = bin.path().join("hanzo");
        std::fs::write(&path, "#!/bin/sh\necho 'not signed in \x1b[31m— run hanzo auth login eyJhbGciOi.x.y' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = api(None, home.path(), bin.path()).resolve(None, None).unwrap_err();
        assert!(err.starts_with(NO_KEY), "{err}");
        assert!(err.contains("not signed in") && !err.contains("eyJ") && !err.contains('\u{1b}'), "{err}");
        std::fs::create_dir_all(home.path().join(".hanzo")).unwrap();
        std::fs::write(home.path().join(".hanzo").join("config.json"), r#"{"apiKey":"sk-stored"}"#).unwrap();
        let c = api(None, home.path(), bin.path()).resolve(None, None).unwrap();
        assert_eq!(c.source, Source::Stored);
        assert!(c.skipped.unwrap().contains("not signed in"));
    }

    /// A named identity is the login's token for it (`--as`), whatever key is set, and
    /// the call's word beats the process's.
    #[cfg(unix)]
    #[test]
    fn a_named_identity_asks_the_login_for_it() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let api = api(Some("sk-env"), home.path(), bin.path());

        let c = api.resolve(None, Some("hanzo/a")).unwrap();
        assert_eq!((c.source, c.token.as_str(), c.named.as_deref()), (Source::Login, "tok-hanzo/a", Some("hanzo/a")));
        assert_eq!(asked(bin.path()), ["auth token --as hanzo/a"]);

        // The process chose one; a call that names another gets the other.
        assert_eq!(api.resolve(Some("admin"), None).unwrap().token, "tok-admin");
        assert_eq!(api.resolve(Some("admin"), Some("hanzo/z")).unwrap().token, "tok-hanzo/z");
        // An empty `as` names nothing, so the process's choice stands.
        assert_eq!(api.resolve(Some("admin"), Some(" ")).unwrap().token, "tok-admin");
        // Nothing named: the env key again.
        assert_eq!(api.resolve(None, None).unwrap().source, Source::Env);

        // An identity the CLI does not hold is the CLI's sentence, never another account's key.
        let err = api.resolve(None, Some("nobody")).unwrap_err();
        assert!(err.contains("no stored identity for nobody"), "{err}");
    }

    /// The identity reaches argv: it is an owner or owner/name, and nothing else.
    #[test]
    fn an_identity_is_an_owner_or_owner_slash_name() {
        for ok in ["hanzo", "hanzo/z", "admin/z", "hanzo/aworring98@gmail.com", "lux/a.b-c_d+e"] {
            assert!(identity_ok(ok), "{ok}");
        }
        for bad in ["", "--help", "-x", "a b", "../x", "a/b/c", "/z", "hanzo/", "a;b", "$(id)", "a\nb"] {
            assert!(!identity_ok(bad), "{bad:?}");
        }
        let api = HanzoApi::with(DEFAULT_BASE_URL.into(), Some("sk-env".into()), None, None);
        assert!(api.resolve(None, Some("--help")).unwrap_err().contains("not an identity"));
    }

    /// The CLI's list and switch ride through; a switch drops the token held for the old identity.
    #[cfg(unix)]
    #[test]
    fn identities_are_the_clis_and_a_switch_is_its_word() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        cli(bin.path());
        let api = api(None, home.path(), bin.path());
        let rows = api.identities().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().find(|r| r["active"] == true).unwrap()["key"], "hanzo/z");
        api.resolve(None, None).unwrap();
        assert_eq!(api.switch("hanzo/a").unwrap(), "Switched to hanzo/a");
        api.resolve(None, None).unwrap();
        assert_eq!(asked(bin.path()), ["auth list -o json", "auth token", "auth switch hanzo/a", "auth token"], "asked again after a switch");
        assert!(api.switch("--help").unwrap_err().contains("not an identity"));
    }

    /// A token is read for who it is, and a key for its prefix only.
    #[test]
    fn claims_say_who_and_a_key_says_its_prefix() {
        use base64::Engine;
        let enc = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        let jwt = format!("{}.{}.sig", enc(&json!({"alg": "RS256"})), enc(&json!({"owner": "hanzo", "name": "z", "orgs": [{"org": "hanzo", "role": "admin"}]})));
        let c = claims(&jwt).unwrap();
        assert_eq!((c["owner"].as_str(), c["name"].as_str(), c["orgs"][0]["org"].as_str()), (Some("hanzo"), Some("z"), Some("hanzo")));
        assert!(claims("sk-not-a-jwt").is_none());
        assert_eq!((key_prefix("sk-abc123"), key_prefix("pk-abc"), key_prefix("hk-abc"), key_prefix("")), ("sk-…", "pk-…", "…", "…"));
    }

    /// A failed run is an answer; IAM's error envelope is a refusal.
    #[test]
    fn a_failed_resource_is_not_a_refusal() {
        let run = json!({"id": "sess_1", "kind": "coding", "status": "error", "error": "coding: clone: exit 128"});
        assert!(!refused(&run));
        assert!(!refused(&json!({"id": "b1", "status": "failed"})));
        assert!(!refused(&json!({"status": "ok", "data": {"id": 1}})));
        assert!(refused(&json!({"status": "error", "msg": "Unauthorized operation"})));
        assert!(refused(&json!({"status": "error", "msg": "nope", "sub": "", "name": "", "data": null, "data2": null})));
    }

    #[test]
    fn extracts_api_key() {
        let doc = r#"{"apiKey":"sk-abc123","accessToken":"x","user":{}}"#;
        assert_eq!(api_key_from_config_json(doc).as_deref(), Some("sk-abc123"));
    }

    #[test]
    fn missing_or_blank_api_key_is_none() {
        assert!(api_key_from_config_json(r#"{"user":{}}"#).is_none());
        assert!(api_key_from_config_json(r#"{"apiKey":""}"#).is_none());
        assert!(api_key_from_config_json(r#"{"apiKey":"   "}"#).is_none());
        assert!(api_key_from_config_json("not json").is_none());
    }

    #[test]
    fn join_url_normalizes_slashes() {
        assert_eq!(join_url("https://api.hanzo.ai", "/v1/code/search"), "https://api.hanzo.ai/v1/code/search");
        assert_eq!(join_url("https://api.hanzo.ai/", "v1/code/search"), "https://api.hanzo.ai/v1/code/search");
        assert_eq!(join_url("https://api.hanzo.ai/", "/v1/code/search"), "https://api.hanzo.ai/v1/code/search");
    }

    #[test]
    fn default_base_url_is_wired() {
        assert_eq!(DEFAULT_BASE_URL, "https://api.hanzo.ai");
    }

    #[test]
    fn a_plan_refusal_keeps_the_code_the_sentence_and_the_actions_only() {
        let body = json!({ "error": {
            "message": "Free plan: today's Kai requests are used. Upgrade for more: https://hanzo.ai/pay",
            "type": "rate_limit_error", "code": "free_plan_cap", "class": "ours", "resets_at": "2026-10-05T00:00:00Z",
            "upgrade_url": "https://hanzo.ai/pay/cart?plan=dev",
            "actions": [
                { "kind": "upgrade", "label": "Upgrade your plan", "url": "https://hanzo.ai/pay/cart?plan=dev", "plan": "dev", "price_cents": 2000 },
                { "kind": "topup", "label": "Add prepaid credit", "url": "https://hanzo.ai/pay" }
            ],
            "used": 50, "cap": 50
        } });
        let r = refusal(429, Some(&body)).expect("a refusal");
        assert_eq!(r.error, json!({
            "status": 429, "code": "free_plan_cap",
            "message": "Free plan: today's Kai requests are used. Upgrade for more: https://hanzo.ai/pay",
            "class": "ours", "resets_at": "2026-10-05T00:00:00Z",
            "actions": [
                { "kind": "upgrade", "label": "Upgrade your plan", "url": "https://hanzo.ai/pay/cart?plan=dev", "plan": "dev" },
                { "kind": "topup", "label": "Add prepaid credit", "url": "https://hanzo.ai/pay" }
            ]
        }));
    }

    #[test]
    fn a_window_and_an_envelope_refusal_read_the_same_way() {
        let w = refusal(429, Some(&json!({ "error": { "message": "m", "code": "usage_cap_exceeded", "limit": "day" } }))).unwrap();
        assert_eq!(w.error["window"], "day");
        let e = refusal(402, Some(&json!({ "status": "error", "msg": "Insufficient balance.", "code": "insufficient_balance" }))).unwrap();
        assert_eq!(e.error, json!({ "status": 402, "code": "insufficient_balance", "message": "Insufficient balance.", "actions": [] }));
    }

    #[test]
    fn other_answers_are_not_refusals() {
        let pool = json!({ "error": { "message": "busy", "code": "pool_busy" } });
        assert!(refusal(429, Some(&pool)).is_none());
        let cap = json!({ "error": { "code": "free_plan_cap" } });
        assert!(refusal(400, Some(&cap)).is_none());
        assert!(refusal(402, None).is_none());
    }

    #[test]
    fn frames_decode_in_order_and_drop_the_done_sentinel() {
        let body = concat!(
            "data: {\"type\":\"status\",\"stage\":\"searching\"}\n\n",
            "data: {\"type\":\"text\",\"delta\":\"a\"}\n\n",
            "data: [DONE]\n\n",
        );
        let f = frames(body);
        assert_eq!(f.len(), 2, "[DONE] is a marker, not an event");
        assert_eq!(f[0]["stage"], "searching");
        assert_eq!(f[1]["delta"], "a");
    }

    #[test]
    fn frames_join_multiline_data_and_skip_non_events() {
        let body = ": keep-alive\nevent: ignored\ndata: {\"type\":\"text\",\n\
                    data: \"delta\":\"x\"}\n\nretry: 100\ndata: not json\n\n";
        let f = frames(body);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["delta"], "x");
    }

    #[test]
    fn frames_read_crlf_and_an_unterminated_last_frame() {
        let f = frames("data: {\"type\":\"done\",\"answer\":\"ok\"}\r\n");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["answer"], "ok");
    }
}
