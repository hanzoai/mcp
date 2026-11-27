//! The `browser` tool: drives the user's own browser through the Hanzo Browser
//! Extension over this user's native ZAP router ([`crate::zap`]).
//!
//! [`ACTIONS`] is the one table that names, routes and documents every action.
//! Every browser action routes over native ZAP directly to a connected browser
//! running the Hanzo Browser Extension — there is no Playwright dependency or
//! fallback.

use anyhow::Result;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;

use crate::zap;

/// One browser action: its help topic, one-line usage, the extension method
/// that serves it (`None` for local actions like `help` and `browsers`), and
/// the page-engine op for actions the extension answers with `hanzo.act`.
pub struct Op {
    pub name: &'static str,
    pub topic: &'static str,
    pub usage: &'static str,
    pub wire: Option<&'static str>,
    pub act: Option<&'static str>,
}

const fn ext(name: &'static str, topic: &'static str, usage: &'static str, wire: &'static str) -> Op {
    Op { name, topic, usage, wire: Some(wire), act: None }
}

const fn act(name: &'static str, topic: &'static str, usage: &'static str, op: &'static str) -> Op {
    Op { name, topic, usage, wire: Some("hanzo.act"), act: Some(op) }
}

const fn local(name: &'static str, topic: &'static str, usage: &'static str) -> Op {
    Op { name, topic, usage, wire: None, act: None }
}

/// Every action, once. The schema, the routing, the wire method and `help` are
/// all read from here, so an action cannot exist in one and not the others.
pub const ACTIONS: &[Op] = &[
    // core: the default surface, and the loop an agent drives a page with
    ext("navigate", "core", "url: open a URL; returns once it has loaded", "hanzo.navigate"),
    ext("snapshot", "core", "[interactive] [compact] [depth] [selector] [args.urls]: the accessibility tree, [ref=eN] on every node you can act on", "hanzo.snapshot"),
    act("click", "core", "selector: click a ref (@e2) or CSS selector; refused when another element covers it", "click"),
    act("fill", "core", "selector, text: replace a field's value", "fill"),
    act("type", "core", "text [selector]: type key by key into the element, or the focused one", "type"),
    act("press", "core", "key [selector]: Enter, Tab, Escape, ArrowDown, Control+a", "press"),
    ext("read", "core", "[outline] [filter]: the page as markdown, as the signed-in user sees it", "hanzo.read"),
    ext("inspected", "core", "the element the person last picked with the extension's Inspect tool (\"what I clicked\"): selector, HTML, styles, components, and its source file:line to edit", "hanzo.inspected"),
    ext("screenshot", "core", "[annotate] [args.full_page] [args.full_res] [args.path]: the viewport, downscaled unless full_res; annotate boxes each ref, label [N] = @eN, and returns the legend", "hanzo.screenshot"),
    ext("evaluate", "core", "code: run JavaScript in the page and return its value", "Runtime.evaluate"),
    ext("wait", "core", "selector | text [args.state=hidden] | timeout: until it shows (or goes), or for ms", "hanzo.wait"),
    ext("tabs", "core", "open tabs; tab_id targets one in any action", "Target.getTargets"),
    local("help", "core", "[topic]: every other action, with how to call it"),
    // interact: more ways to act on a ref or CSS selector
    act("dblclick", "interact", "selector", "dblclick"),
    act("hover", "interact", "selector", "hover"),
    act("drag", "interact", "selector + args.target_selector, or args.start_x/start_y + args.end_x/end_y [args.steps]: drag element or coordinates", "drag"),
    act("focus", "interact", "selector", "focus"),
    act("select", "interact", "selector, args.value: choose a <select> option by value or label", "select"),
    act("check", "interact", "selector: check a checkbox or radio (no-op when already checked)", "check"),
    act("uncheck", "interact", "selector", "uncheck"),
    act("scroll", "interact", "args.delta_x, args.delta_y [selector]: scroll the page, or an element, by pixels", "scroll"),
    act("scroll_into_view", "interact", "selector", "scrollIntoView"),
    act("get_text", "interact", "selector: rendered text; a field's value", "text"),
    act("get_attribute", "interact", "selector, args.attribute", "attribute"),
    act("count", "interact", "selector: how many elements a CSS selector matches", "count"),
    // webmcp: Chrome WebMCP standard (navigator.modelContext + declarative forms)
    ext("webmcp_list", "webmcp", "[args.tool] [args.frame_id]: list WebMCP tool summaries, or full JSON schema for one tool", "hanzo.webmcp.list"),
    ext("webmcp_call", "webmcp", "args.tool [args.args] [args.frame_id]: call a WebMCP tool on the page", "hanzo.webmcp.call"),
    // lastpass: native in-browser LastPass vault & icon automation (zero secret over ZAP)
    ext("lastpass_status", "lastpass", "check LastPass extension presence, signed-in vault tab, and session cookie names", "lastpass.status"),
    ext("lastpass_accounts", "lastpass", "[url] [args.domain] [args.username] [args.name] [args.query] [args.open_vault]: list matching vault site metadata (never passwords)", "lastpass.accounts"),
    ext("lastpass_open_icon", "lastpass", "[selector]: click visible [data-lastpass-icon-root] shadow icon on tab", "lastpass.openIcon"),
    ext("lastpass_fill", "lastpass", "[url] [args.domain] [args.username] [args.name] [args.query] [args.open_vault]: fill credentials from signed-in vault tab inside browser worker", "lastpass.fill"),
    // navigation
    ext("go_back", "navigation", "back one page", "Page.goBack"),
    ext("go_forward", "navigation", "forward one page", "Page.goForward"),
    ext("reload", "navigation", "reload the page", "Page.reload"),
    ext("url", "navigation", "the tab's URL", "hanzo.url"),
    ext("title", "navigation", "the tab's title", "hanzo.title"),
    // tabs and browsers
    ext("new_tab", "tabs", "[url]: open a tab", "Target.createTarget"),
    ext("close_tab", "tabs", "tab_id: close a tab", "Target.closeTarget"),
    ext("select_tab", "tabs", "tab_id: bring a tab to the front", "Target.activateTarget"),
    local("browsers", "tabs", "connected browsers; target_browser picks one"),
    ext("status", "tabs", "the browser behind this tool", "Browser.getVersion"),
    // page: content and state
    ext("get_html", "page", "[selector]: an element's HTML, or the page's", "hanzo.getHTML"),
    // storage
    ext("cookies", "storage", "the page's cookies", "hanzo.getCookies"),
];

/// The extension's page/background engine answers these as JSON the tool unpacks.
const ENGINE: &[&str] = &[
    "hanzo.navigate",
    "hanzo.snapshot",
    "hanzo.read",
    "hanzo.act",
    "hanzo.wait",
    "hanzo.inspected",
    "hanzo.webmcp.list",
    "hanzo.webmcp.call",
    "lastpass.status",
    "lastpass.accounts",
    "lastpass.openIcon",
    "lastpass.fill",
];

/// The parameters the schema types; everything else rides in `args`.
const TYPED: &[&str] = &[
    "action", "selector", "url", "text", "key", "code", "interactive", "compact", "depth", "outline",
    "filter", "annotate", "timeout", "tab_id", "target_browser", "topic", "args",
];

const LOOP: &str = r#"The loop: snapshot, act on refs, snapshot again when the page changes.
  browser(action="navigate", url="https://example.com")
  browser(action="snapshot", interactive=true)     - button "Sign in" [ref=e2]
  browser(action="click", selector="@e2")
  browser(action="fill", selector="@e3", text="me@example.com")
  browser(action="press", key="Enter")
  browser(action="read", filter="pricing")         the page as markdown
  browser(action="screenshot", annotate=true)      labels [N] on the image = @eN
A ref stays valid while its element is on the page, across snapshots. After a
navigation, or when an element was removed, the ref is refused: snapshot again.
A click on an element covered by a consent banner, modal or overlay is refused
and names the cover: act on the cover, then snapshot again.
selector takes a ref (@e2) or a CSS selector (including >>> for shadow roots).
Parameters outside the core schema go in args, e.g. browser(action="select", selector="@e4", args={"value": "Weekly"})."#;

const DESCRIPTION: &str = r#"Drive the user's browser through the Hanzo Browser Extension over native ZAP.

Loop: snapshot, act on a ref, snapshot again when the page changes.
  snapshot interactive=true        - button "Sign in" [ref=e2]
  click selector="@e2"   fill selector="@e3" text="me@x.com"   press key="Enter"
  read                             the page as markdown (outline=true, filter="…")
  screenshot annotate=true         every ref boxed, label [N] = @eN
selector takes a ref (@e2) or a CSS selector (including >>> for shadow roots). A stale ref,
or a click on an element under a banner or modal, is refused with what to do next.

Supports WebMCP (webmcp_list, webmcp_call) and LastPass vault automation
(lastpass_status, lastpass_accounts, lastpass_open_icon, lastpass_fill).
action="help" lists everything else (hover, select, check, scroll, back, tabs,
cookies …); their parameters go in args."#;

/// The action named `name`.
pub fn op(name: &str) -> Option<&'static Op> {
    ACTIONS.iter().find(|o| o.name == name)
}

fn topics() -> Vec<&'static str> {
    let mut t: Vec<&str> = Vec::new();
    for o in ACTIONS {
        if !t.contains(&o.topic) {
            t.push(o.topic);
        }
    }
    t
}

fn core() -> Vec<&'static str> {
    ACTIONS.iter().filter(|o| o.topic == "core").map(|o| o.name).collect()
}

/// The progressive half of the surface: the loop, then every action past the
/// core by topic; `topic` narrows it to one (`core` included).
pub fn help(topic: Option<&str>) -> String {
    let topics = topics();
    if let Some(t) = topic {
        if !topics.contains(&t) {
            return format!("No topic {t:?}. Topics: {}.", topics.join(", "));
        }
    }
    let mut lines: Vec<String> = match topic {
        Some(_) => Vec::new(),
        None => vec![LOOP.to_string(), String::new()],
    };
    let shown: Vec<&str> = match topic {
        Some(t) => vec![t],
        None => topics[1..].to_vec(),
    };
    for t in shown {
        lines.push(t.to_string());
        for o in ACTIONS.iter().filter(|o| o.topic == t) {
            lines.push(format!("  {:<18}{}", o.name, o.usage).trim_end().to_string());
        }
    }
    lines.push(String::new());
    lines.push("All browser actions route through the Hanzo Browser Extension over native ZAP.".into());
    lines.push(format!("browser(action=\"help\", topic=\"…\") shows one of: {}.", topics.join(", ")));
    lines.join("\n")
}

/// `BROWSER_BACKEND`, else `~/.hanzo/extension/config.json` `.backend`, else
/// `auto`: one of firefox | chrome | extension | auto.
pub fn backend() -> String {
    const OK: &[&str] = &["firefox", "chrome", "extension", "auto"];
    let pick = |s: &str| {
        let s = s.trim().to_lowercase();
        OK.contains(&s.as_str()).then_some(s)
    };
    if let Some(b) = std::env::var("BROWSER_BACKEND").ok().and_then(|s| pick(&s)) {
        return b;
    }
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".hanzo/extension/config.json")).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("backend").and_then(Value::as_str).and_then(pick))
        .unwrap_or_else(|| "auto".into())
}

/// A snapshot ref: `@e2` (or `e2`).
#[cfg(test)]
fn is_ref(s: &str) -> bool {
    let s = s.trim();
    let s = s.strip_prefix('@').unwrap_or(s);
    s.strip_prefix('e').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `tab-12` or `12` as the wire's tab id.
fn tab(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.as_str(),
        other => return other.to_string(),
    };
    s.strip_prefix("tab-").unwrap_or(s).to_string()
}

/// A param value as the wire carries it: every value is a string, a flag reads
/// "true", structure travels as JSON.
pub(crate) fn wire_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Pull the base64 payload out of a screenshot answer: raw base64, a data: URL,
/// or JSON under data/base64/screenshot (incl. a nested CDP `{"result": {"data"}}`).
pub(crate) fn extract_b64(text: &str) -> Option<String> {
    let t = text.trim();
    let strip = |v: &str| v.split_once(',').filter(|_| v.starts_with("data:")).map_or(v, |(_, b)| b).to_string();
    if t.starts_with('{') {
        let obj: Value = serde_json::from_str(t).ok()?;
        for o in [Some(&obj), obj.get("result")].into_iter().flatten() {
            for k in ["data", "base64", "screenshot"] {
                if let Some(v) = o.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    return Some(strip(v));
                }
            }
        }
        return None;
    }
    if t.starts_with("data:image") {
        return Some(strip(t));
    }
    let b64 = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=' | b'\n' | b'\r');
    (t.len() > 100 && t.bytes().take(256).all(b64)).then(|| t.to_string())
}

/// Persist a capture and hand it back: the bytes go to `path` (default
/// `~/.hanzo/screenshots/capture-<hex>.<fmt>`) and inline as `image`, which the
/// server sends as a native MCP image block rather than base64 in the text.
pub(crate) fn capture(raw: &[u8], path: Option<&str>) -> Value {
    let fmt = if raw.starts_with(&[0xff, 0xd8, 0xff]) { "jpeg" } else { "png" };
    let target = match path {
        Some(p) => std::path::PathBuf::from(shellexpand::tilde(p).into_owned()),
        None => {
            let name = format!("capture-{:012x}.{fmt}", rand_id());
            dirs::home_dir().unwrap_or_default().join(".hanzo/screenshots").join(name)
        }
    };
    let mut out = json!({ "success": true, "format": fmt, "size": raw.len() });
    let saved = target
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::write(&target, raw));
    match saved {
        Ok(()) => out["path"] = json!(target.display().to_string()),
        Err(e) => out["note"] = json!(format!("not saved: {e}")),
    }
    out["image"] = json!({
        "data": base64::engine::general_purpose::STANDARD.encode(raw),
        "mimeType": format!("image/{fmt}"),
    });
    out
}

fn rand_id() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.finish() & 0xffff_ffff_ffff
}

/// Arguments for the browser tool: the typed core, plus `args` for the rest.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrowserToolArgs {
    #[serde(default)]
    pub action: String,
    // URL/Navigation
    pub url: Option<String>,
    // Selectors
    pub selector: Option<String>,
    // Text/Input
    pub text: Option<String>,
    pub key: Option<String>,
    pub value: Option<Value>,
    // snapshot / read / screenshot / help
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub compact: bool,
    pub depth: Option<i32>,
    #[serde(default)]
    pub urls: bool,
    #[serde(default)]
    pub outline: bool,
    pub filter: Option<String>,
    #[serde(default)]
    pub annotate: bool,
    pub topic: Option<String>,
    // Scroll / drag coordinates
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
    pub target_selector: Option<String>,
    pub start_x: Option<i32>,
    pub start_y: Option<i32>,
    pub end_x: Option<i32>,
    pub end_y: Option<i32>,
    pub steps: Option<i32>,
    // Options
    pub timeout: Option<i32>,
    pub full_page: Option<bool>,
    pub attribute: Option<String>,
    // Index
    pub index: Option<i32>,
    pub tab_index: Option<i32>,
    // Which browser, which tab
    pub tab_id: Option<Value>,
    pub target_browser: Option<String>,
    pub client_id: Option<String>,
    // Capture output path and detail
    pub path: Option<String>,
    pub max_width: Option<i32>,
    pub quality: Option<i32>,
    #[serde(default)]
    pub full_res: bool,
    // JavaScript
    pub code: Option<String>,
    // Wait / console / frame
    pub state: Option<String>,
    pub level: Option<String>,
    pub frame: Option<String>,
    // WebMCP
    pub tool: Option<String>,
    pub tool_args: Option<Value>,
    pub params: Option<Value>,
    pub frame_id: Option<Value>,
    #[serde(rename = "frameId")]
    pub frame_id_camel: Option<Value>,
    #[serde(default)]
    pub no_webmcp: bool,
    // LastPass
    pub id: Option<String>,
    pub domain: Option<String>,
    pub username: Option<String>,
    pub name: Option<String>,
    pub query: Option<String>,
    #[serde(default)]
    pub open_vault: bool,
    #[serde(default, rename = "openVaultIfNeeded")]
    pub open_vault_camel: bool,
    pub username_selector: Option<String>,
    pub password_selector: Option<String>,
    /// Parameters of non-core actions, as `help` names them.
    pub args: Option<Map<String, Value>>,
}

impl BrowserToolArgs {
    /// Fold `args` into the typed fields. A key the schema types, or one no
    /// action reads, is refused rather than ignored.
    fn merged(mut self) -> std::result::Result<Self, String> {
        let Some(mut extra) = self.args.take() else { return Ok(self) };
        // `webmcp_call` accepts nested `args` inside `args` (tool parameters).
        let nested_webmcp_args = extra.remove("args");
        let mut v = serde_json::to_value(&self).map_err(|e| e.to_string())?;
        let obj = v.as_object_mut().expect("args serialize as an object");
        let mut unknown: Vec<&String> =
            extra.keys().filter(|k| TYPED.contains(&k.as_str()) || !obj.contains_key(*k)).collect();
        if !unknown.is_empty() {
            unknown.sort();
            return Err(format!(
                "Unknown args {unknown:?}. Typed parameters go outside args; action=\"help\" names each action's args."
            ));
        }
        obj.extend(extra);
        if let Some(webmcp_args) = nested_webmcp_args {
            obj.insert("tool_args".to_string(), webmcp_args);
        }
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// The wire params for `action` (`annotate`: a labelled screenshot), peer of
    /// `src/tools/browser.ts` `wireParams`.
    fn wire(&self, action: &str, selector: Option<&str>, act: Option<&str>) -> Vec<(String, String)> {
        let mut p: Vec<(String, String)> = Vec::new();
        let mut put = |k: &str, v: String| p.push((k.to_string(), v));
        if matches!(action, "screenshot" | "annotate") {
            // Shrink where the pixels are: ask the browser for a 1280px JPEG
            // and that payload is never built, let alone carried.
            put("format", if self.full_res { "png" } else { "jpeg" }.into());
            put("quality", self.quality.unwrap_or(70).to_string());
            if !self.full_res {
                put("maxWidth", self.max_width.unwrap_or(1280).to_string());
            }
        }
        if let Some(u) = &self.url {
            put("url", u.clone());
        }
        if let Some(s) = selector {
            put("selector", s.to_string());
        }
        if let Some(v) = &self.value {
            put("value", wire_value(v));
        }
        if let Some(t) = &self.text {
            put("text", t.clone());
        }
        if let Some(c) = &self.code {
            put("expression", c.clone());
        }
        if self.full_page == Some(true) {
            put("fullPage", "true".into());
        }
        if let Some(t) = &self.tab_id {
            put("tabId", tab(t));
        }
        if let Some(op) = act {
            put("op", op.to_string());
        }

        // WebMCP wire params
        if let Some(t) = &self.tool {
            put("tool", t.clone());
        }
        if let Some(f) = self.frame_id.as_ref().or(self.frame_id_camel.as_ref()) {
            put("frameId", wire_value(f));
        } else if let Some(f) = &self.frame {
            put("frameId", f.clone());
        }
        if let Some(wa) = self.tool_args.as_ref().or(self.params.as_ref()) {
            put("args", wire_value(wa));
        }
        if self.no_webmcp {
            put("noWebmcp", "true".into());
        }

        // LastPass wire params
        if let Some(v) = &self.id {
            put("id", v.clone());
        }
        if let Some(v) = &self.domain {
            put("domain", v.clone());
        }
        if let Some(v) = &self.username {
            put("username", v.clone());
        }
        if let Some(v) = &self.name {
            put("name", v.clone());
        }
        if let Some(v) = &self.query {
            put("query", v.clone());
        }
        if self.open_vault || self.open_vault_camel {
            put("openVaultIfNeeded", "true".into());
        }
        if let Some(v) = &self.username_selector {
            put("usernameSelector", v.clone());
        }
        if let Some(v) = &self.password_selector {
            put("passwordSelector", v.clone());
        }

        // The action-specific fields the extension reads, under its names.
        let flag = |b: bool| b.then(|| "true".to_string());
        for (k, v) in [
            ("key", self.key.clone()),
            ("index", self.index.map(|i| i.to_string())),
            ("tab_index", self.tab_index.map(|i| i.to_string())),
            ("timeout", self.timeout.map(|i| i.to_string())),
            ("state", self.state.clone()),
            ("level", self.level.clone()),
            ("attribute", self.attribute.clone()),
            ("interactive", flag(self.interactive)),
            ("compact", flag(self.compact)),
            ("depth", self.depth.map(|i| i.to_string())),
            ("urls", flag(self.urls)),
            ("outline", flag(self.outline)),
            ("filter", self.filter.clone()),
            ("dx", self.delta_x.map(|i| i.to_string())),
            ("dy", self.delta_y.map(|i| i.to_string())),
            ("targetSelector", self.target_selector.clone()),
            ("startX", self.start_x.map(|i| i.to_string())),
            ("startY", self.start_y.map(|i| i.to_string())),
            ("endX", self.end_x.map(|i| i.to_string())),
            ("endY", self.end_y.map(|i| i.to_string())),
            ("steps", self.steps.map(|i| i.to_string())),
        ] {
            if let Some(v) = v {
                put(k, v);
            }
        }
        p
    }
}

/// Structured diagnostic separating permission failures from transport,
/// native-host, unpaired-extension, and in-page failures.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserDiagnostic {
    /// One of: `permission`, `native_host`, `extension_unpaired`, `transport`, `page`
    pub category: String,
    pub hint: String,
}

/// Classify a browser/ZAP error so callers can distinguish permission denials
/// from transport or native-messaging failures.
pub fn diagnose_error(err: &str) -> BrowserDiagnostic {
    let lower = err.to_lowercase();
    if lower.contains("read-only")
        || lower.contains("permission")
        || lower.contains("not allowed")
        || lower.contains("cannot access a chrome://")
        || lower.contains("cannot access contents of url")
        || lower.contains("activetab")
        || lower.contains("approval required")
        || lower.contains("user declined")
        || lower.contains("denied")
        || lower.contains("forbidden")
    {
        return BrowserDiagnostic {
            category: "permission".into(),
            hint: "Permission or scope restriction: use `browser_read` for read-only inspection, or approve/grant host permission in Chrome.".into(),
        };
    }
    if lower.contains("native messaging")
        || lower.contains("native host")
        || lower.contains("ai.hanzo.zap")
        || lower.contains("hanzo-zap-host")
    {
        return BrowserDiagnostic {
            category: "native_host".into(),
            hint: "Browser native messaging host is missing or broken: run `hanzo mcp doctor --fix` to self-repair registration.".into(),
        };
    }
    if lower.contains("no browser on the zap router")
        || lower.contains("unpaired")
        || lower.contains("no browser connected")
    {
        return BrowserDiagnostic {
            category: "extension_unpaired".into(),
            hint: "ZAP router is running, but no browser extension is connected: open Chrome with the Hanzo Browser Extension enabled, or run `hanzo mcp doctor --fix`.".into(),
        };
    }
    if lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection refused")
        || lower.contains("broken pipe")
        || lower.contains("no router door")
        || lower.contains("socket")
        || lower.contains("zapd")
        || lower.contains("eof")
        || lower.contains("closed")
    {
        return BrowserDiagnostic {
            category: "transport".into(),
            hint: "Local ZAP transport error: check the router and extension status with `hanzo mcp doctor`.".into(),
        };
    }
    BrowserDiagnostic {
        category: "page".into(),
        hint: "Browser extension returned a page-level error (e.g., stale ref or covered element): run `snapshot` again and retry.".into(),
    }
}

/// The extension's reply as the tool's: a refusal is an error, a tree or a page
/// is plain text, an engine result is its fields.
fn answer(action: &str, method: &str, provider: &str, text: String) -> Value {
    if let Some(e) = text.strip_prefix("ERR:") {
        let diag = diagnose_error(e);
        return json!({ "error": e, "action": action, "diagnostic": diag });
    }
    if ENGINE.contains(&method) {
        if let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&text) {
            let s = |k: &str| match data.get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };
            return match action {
                "snapshot" => {
                    let suffix = match data.get("webmcp") {
                        Some(w) if !w.is_null() => format!("\n\n[webmcp: {w}]"),
                        _ => String::new(),
                    };
                    Value::String(format!(
                        "{} — {} ({} refs)\n{}{}",
                        s("title"),
                        s("url"),
                        s("refs"),
                        s("tree"),
                        suffix
                    ))
                }
                "read" => Value::String(format!("{} — {}\n\n{}", s("title"), s("url"), s("markdown"))),
                _ => {
                    let mut out = Map::from_iter([("success".to_string(), json!(true))]);
                    out.extend(data);
                    Value::Object(out)
                }
            };
        }
    }
    json!({ "success": true, "source": "extension", "transport": "native-zap", "provider": provider, "result": text })
}

/// Browser tool — controls the user's connected browser through the Hanzo
/// Browser Extension over native ZAP.
pub struct BrowserTool;

impl BrowserTool {
    pub fn new() -> Self {
        Self
    }

    /// Run one action. snapshot, read and help answer text; everything else JSON.
    pub async fn execute(&self, args: BrowserToolArgs) -> Result<String> {
        let out = match args.merged() {
            Ok(a) => self.run(a).await?,
            Err(e) => json!({ "error": e }),
        };
        Ok(match out {
            Value::String(s) => s,
            v => v.to_string(),
        })
    }

    async fn run(&self, mut a: BrowserToolArgs) -> Result<Value> {
        let name = if a.action.is_empty() { "status".to_string() } else { a.action.clone() };
        let Some(spec) = op(&name) else {
            return Ok(json!({
                "error": format!("Unknown action {name:?}. Core: {}. action=\"help\" lists the rest.", core().join(", "))
            }));
        };
        match name.as_str() {
            "help" => return Ok(Value::String(help(a.topic.as_deref()))),
            "browsers" => {
                return Ok(match zap::browsers().await {
                    Ok(b) => json!({
                        "success": true, "transport": "native-zap", "count": b.len(),
                        "browsers": b.iter().map(zap::describe).collect::<Vec<_>>(),
                    }),
                    Err(e) => json!({ "error": e.to_string(), "transport": "native-zap" }),
                })
            }
            // A wait with nothing to wait for is a pause; no browser needs asking.
            "wait" if a.selector.is_none() && a.text.is_none() && a.timeout.is_some() => {
                let ms = a.timeout.unwrap_or(0).max(0);
                tokio::time::sleep(Duration::from_millis(ms as u64)).await;
                return Ok(json!({ "success": true, "waited_ms": ms }));
            }
            _ => {}
        }

        let backend = backend();
        let filter = a
            .target_browser
            .clone()
            .or_else(|| matches!(backend.as_str(), "firefox" | "chrome").then(|| backend.clone()));
        let annotate = name == "screenshot" && a.annotate;
        if name == "scroll" && a.delta_x.is_none() && a.delta_y.is_none() {
            a.delta_y = Some(300);
        }

        let Some(method) = spec.wire else {
            return Ok(json!({
                "error": format!("{name} requires the Hanzo Browser Extension: {}", zap::UNPAIRED),
                "action": name,
                "transport": "native-zap",
            }));
        };

        match self.extension(&name, method, spec.act, &a, filter.as_deref(), annotate).await {
            Ok(v) => Ok(v),
            Err(e) if name == "status" => {
                let diag = diagnose_error(&e);
                Ok(json!({
                    "success": false,
                    "connected": false,
                    "source": "extension",
                    "transport": "native-zap",
                    "backend": backend,
                    "error": e,
                    "diagnostic": diag,
                }))
            }
            Err(e) => {
                let diag = diagnose_error(&e);
                let outcome_unknown = diag.category == "transport" && !READ_ONLY_ACTIONS.contains(&name.as_str());
                let mut err_obj = json!({
                    "error": e,
                    "action": name,
                    "backend": backend,
                    "transport": "native-zap",
                    "diagnostic": diag,
                });
                if outcome_unknown {
                    err_obj["outcome_unknown"] = json!(true);
                }
                Ok(err_obj)
            }
        }
    }

    /// Route one action to the browser on this user's ZAP router.
    async fn extension(
        &self,
        name: &str,
        method: &str,
        act: Option<&str>,
        a: &BrowserToolArgs,
        filter: Option<&str>,
        annotate: bool,
    ) -> std::result::Result<Value, String> {
        let provider = zap::resolve(filter, a.client_id.as_deref())
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| zap::UNPAIRED.to_string())?;
        let (wire, method) = if annotate { ("annotate", "hanzo.annotate") } else { (name, method) };
        let selector = a.selector.as_deref().or((name == "get_html").then_some("html"));
        let params = a.wire(wire, selector, act);
        let text = zap::route(&provider, method, &params, Duration::from_secs(30))
            .await
            .map_err(|e| e.to_string())?;

        // A capture goes to a file and comes back as pixels, never as base64 in
        // the JSON text, which is charged to the agent's context by the character.
        if name == "screenshot" && !text.starts_with("ERR:") {
            if let Some(raw) = extract_b64(&text).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()) {
                let mut out = capture(&raw, a.path.as_deref());
                out["transport"] = json!("native-zap");
                out["provider"] = json!(provider);
                if annotate {
                    let legend = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("legend").cloned());
                    out["legend"] = legend.unwrap_or_else(|| json!([]));
                }
                return Ok(out);
            }
        }
        Ok(answer(name, method, &provider, text))
    }
}

impl Default for BrowserTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Strictly read-only actions allowed through `browser_read`.
pub const READ_ONLY_ACTIONS: &[&str] = &[
    "tabs",
    "browsers",
    "status",
    "url",
    "title",
    "read",
    "inspected",
    "snapshot",
    "get_text",
    "get_attribute",
    "get_html",
    "count",
    "screenshot",
    "webmcp_list",
    "help",
];

const READ_DESCRIPTION: &str = r#"Read-only browser inspection through the Hanzo Browser Extension over native ZAP.

Enumerates tabs, inspects page text/markdown/DOM/accessibility snapshots, captures screenshots,
and checks browser connection status without modifying browser state, navigating, clicking,
typing, or executing arbitrary page scripts. Safe to auto-approve in read-only clients.

Actions: tabs (default), browsers, status, url, title, read, inspected, snapshot, get_text,
get_attribute, get_html, count, screenshot, webmcp_list, help."#;

/// Dedicated read-only browser tool — exposes tab discovery and inspection
/// without granting arbitrary browser modification capabilities.
pub struct BrowserReadTool {
    inner: BrowserTool,
}

impl BrowserReadTool {
    pub fn new() -> Self {
        Self { inner: BrowserTool::new() }
    }

    pub async fn execute(&self, mut args: BrowserToolArgs) -> Result<String> {
        if args.action.is_empty() {
            args.action = "tabs".to_string();
        }
        let action = args.action.clone();
        if action == "help" {
            return Ok(format!(
                "browser_read — strictly read-only browser inspection over native ZAP.\nAllowed actions: {}.\nUse the `browser` tool for mutating actions (navigate, click, fill, evaluate, etc.).",
                READ_ONLY_ACTIONS.join(", ")
            ));
        }
        if !READ_ONLY_ACTIONS.contains(&action.as_str()) {
            let msg = format!(
                "Action {action:?} is not permitted on read-only tool `browser_read` (allowed: {}).",
                READ_ONLY_ACTIONS.join(", ")
            );
            let diag = diagnose_error(&msg);
            return Ok(json!({
                "error": msg,
                "action": action,
                "read_only": true,
                "diagnostic": diag,
            })
            .to_string());
        }
        self.inner.execute(args).await
    }
}

impl Default for BrowserReadTool {
    fn default() -> Self {
        Self::new()
    }
}

/// MCP Tool Definition for the dedicated read-only `browser_read` tool.
#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserReadToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl BrowserReadToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "browser_read".to_string(),
            description: READ_DESCRIPTION.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": READ_ONLY_ACTIONS,
                        "default": "tabs",
                        "description": "Read-only action (default: tabs)"
                    },
                    "selector": {"type": "string", "description": "Optional snapshot ref (@e2) or CSS selector for get_text/get_attribute/get_html/count/snapshot"},
                    "interactive": {"type": "boolean", "description": "snapshot: interactive elements only, flat"},
                    "compact": {"type": "boolean", "description": "snapshot: drop empty structure"},
                    "depth": {"type": "integer", "description": "snapshot: tree depth limit"},
                    "outline": {"type": "boolean", "description": "read: headings only"},
                    "filter": {"type": "string", "description": "read: only sections that mention this"},
                    "annotate": {"type": "boolean", "description": "screenshot: box every ref, label [N] = @eN"},
                    "tab_id": {"type": "string", "description": "Tab from tabs; default the active tab"},
                    "target_browser": {"type": "string", "description": "chrome | firefox, when several are connected"},
                    "args": {"type": "object", "description": "Optional read-only parameters (attribute, full_page, full_res, path, urls, tool, frame_id)"}
                }
            }),
        }
    }
}

impl Default for BrowserReadToolDefinition {
    fn default() -> Self {
        Self::new()
    }
}

/// MCP Tool Definition: the core parameters typed, the rest in `args`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl BrowserToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "browser".to_string(),
            description: DESCRIPTION.to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {"type": "string", "description": format!("{}; help lists the rest", core().join(", "))},
                    "selector": {"type": "string", "description": "Element: a snapshot ref (@e2) or a CSS selector (including >>>)"},
                    "url": {"type": "string", "description": "navigate / lastpass_*: the URL"},
                    "text": {"type": "string", "description": "fill/type: the text; wait: text to appear"},
                    "key": {"type": "string", "description": "press: Enter, Tab, Escape, ArrowDown, Control+a"},
                    "code": {"type": "string", "description": "evaluate: JavaScript"},
                    "interactive": {"type": "boolean", "description": "snapshot: interactive elements only, flat"},
                    "compact": {"type": "boolean", "description": "snapshot: drop empty structure"},
                    "depth": {"type": "integer", "description": "snapshot: tree depth limit"},
                    "outline": {"type": "boolean", "description": "read: headings only"},
                    "filter": {"type": "string", "description": "read: only sections that mention this"},
                    "annotate": {"type": "boolean", "description": "screenshot: box every ref, label [N] = @eN"},
                    "timeout": {"type": "integer", "description": "wait: milliseconds"},
                    "tab_id": {"type": "string", "description": "Tab from tabs; default the active tab"},
                    "target_browser": {"type": "string", "description": "chrome | firefox, when several are connected"},
                    "topic": {"type": "string", "description": "help: one topic"},
                    "args": {"type": "object", "description": "Parameters of non-core actions (webmcp_*, lastpass_*, etc.), as help names them"}
                }
            }),
        }
    }
}

impl Default for BrowserToolDefinition {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_core_action_is_routed() {
        for name in core() {
            assert!(op(name).unwrap().wire.is_some() || name == "help", "{name}");
        }
        assert_eq!(op("click").unwrap().act, Some("click"));
        assert_eq!(op("scroll_into_view").unwrap().act, Some("scrollIntoView"));
        assert_eq!(op("tabs").unwrap().wire, Some("Target.getTargets"));
        assert_eq!(op("webmcp_list").unwrap().wire, Some("hanzo.webmcp.list"));
        assert_eq!(op("lastpass_status").unwrap().wire, Some("lastpass.status"));
    }

    #[test]
    fn help_and_description_contain_no_playwright() {
        let all = help(None);
        assert!(all.starts_with("The loop"));
        assert!(!all.to_lowercase().contains("playwright"), "{all}");
        assert!(!DESCRIPTION.to_lowercase().contains("playwright"), "{DESCRIPTION}");
        assert!(help(Some("core")).contains("navigate"));
        assert!(help(Some("webmcp")).contains("webmcp_list"));
        assert!(help(Some("lastpass")).contains("lastpass_status"));
        assert!(help(Some("nope")).starts_with("No topic"));
    }

    #[test]
    fn args_fold_in_and_unknown_are_refused() {
        let a = BrowserToolArgs {
            action: "select".into(),
            args: Some(serde_json::from_value(json!({"value": "Weekly", "delta_y": 50})).unwrap()),
            ..Default::default()
        };
        let m = a.merged().unwrap();
        assert_eq!(m.value, Some(json!("Weekly")));
        assert_eq!(m.delta_y, Some(50));

        // webmcp_call accepts nested `args` inside `args`
        let wm = BrowserToolArgs {
            action: "webmcp_call".into(),
            args: Some(serde_json::from_value(json!({"tool": "search", "args": {"q": "hanzo"}})).unwrap()),
            ..Default::default()
        };
        let wm_m = wm.merged().unwrap();
        assert_eq!(wm_m.tool.as_deref(), Some("search"));
        assert_eq!(wm_m.tool_args, Some(json!({"q": "hanzo"})));

        for bad in [json!({"bogus": 1}), json!({"selector": "#x"})] {
            let a = BrowserToolArgs { args: Some(serde_json::from_value(bad).unwrap()), ..Default::default() };
            assert!(a.merged().unwrap_err().starts_with("Unknown args"));
        }
    }

    fn map(p: Vec<(String, String)>) -> Value {
        Value::Object(p.into_iter().map(|(k, v)| (k, Value::String(v))).collect())
    }

    #[test]
    fn wire_params_match_extension_contract() {
        let a = BrowserToolArgs {
            tab_id: Some(json!("tab-12")),
            interactive: true,
            delta_y: Some(300),
            ..Default::default()
        };
        assert_eq!(
            map(a.wire("scroll", Some("@e2"), Some("scroll"))),
            json!({"selector": "@e2", "tabId": "12", "op": "scroll", "interactive": "true", "dy": "300"})
        );
        assert_eq!(
            map(BrowserToolArgs::default().wire("screenshot", None, None)),
            json!({"format": "jpeg", "quality": "70", "maxWidth": "1280"})
        );
        let drag_args = BrowserToolArgs {
            target_selector: Some("@e9".into()),
            steps: Some(8),
            ..Default::default()
        };
        assert_eq!(
            map(drag_args.wire("drag", Some("@e3"), Some("drag"))),
            json!({"selector": "@e3", "op": "drag", "targetSelector": "@e9", "steps": "8"})
        );
    }

    #[test]
    fn refs_match_expected_format() {
        assert!(is_ref("@e2") && is_ref("e10") && !is_ref("#e2") && !is_ref("@e") && !is_ref("button"));
    }

    #[test]
    fn engine_answers_unpack() {
        let tree = json!({"title": "T", "url": "U", "refs": 2, "tree": "- button [ref=e2]"}).to_string();
        assert_eq!(answer("snapshot", "hanzo.snapshot", "p", tree), Value::String("T — U (2 refs)\n- button [ref=e2]".into()));
        let picked = answer("inspected", "hanzo.inspected", "p", r#"{"picked":true,"selector":"button.cta","source":{"at":"src/Hero.tsx:42:7","via":"react"}}"#.into());
        assert_eq!(picked["source"]["at"], "src/Hero.tsx:42:7");
        assert_eq!(picked["selector"], "button.cta");
        assert_eq!(answer("click", "hanzo.act", "p", "ERR:covered by #banner".into())["error"], "covered by #banner");
        assert_eq!(answer("click", "hanzo.act", "p", r#"{"clicked":true}"#.into())["clicked"], true);
    }

    #[test]
    fn b64_is_found_wherever_it_rides() {
        let b = "A".repeat(120);
        assert_eq!(extract_b64(&json!({"data": b}).to_string()).as_deref(), Some(b.as_str()));
        let nested = json!({"result": {"data": format!("data:image/png;base64,{b}")}}).to_string();
        assert_eq!(extract_b64(&nested).as_deref(), Some(b.as_str()));
        assert_eq!(extract_b64(&b).as_deref(), Some(b.as_str()));
        assert_eq!(extract_b64("short"), None);
    }
}
