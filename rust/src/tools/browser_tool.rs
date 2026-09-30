//! The `browser` tool: the user's own browser through the Hanzo extension, or a
//! headless Playwright Chromium when none is connected.
//!
//! The same surface as python-sdk `hanzo_tools.browser.browser_tool`: the same
//! action names, the core parameters typed and the rest in `args`, the same
//! extension methods. [`ACTIONS`] is the one table that names, routes and
//! documents every action. An action with a `wire` method goes to the browser
//! node on this user's ZAP router ([`crate::zap`]); with no browser registered
//! it runs on one long-lived Node + Playwright driver, which keeps its page
//! across calls. Refs (`@e2`) and annotated screenshots exist only in the
//! extension, and an explicit backend (`BROWSER_BACKEND=chrome|firefox|extension`)
//! means that browser: neither falls back.

use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::zap;

/// One browser action: its help topic, one-line usage, the extension method
/// that serves it (`None`: headless Playwright only), and the page-engine op
/// for actions the extension answers with `hanzo.act`.
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

const fn pw(name: &'static str, topic: &'static str, usage: &'static str) -> Op {
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
    ext("screenshot", "core", "[annotate] [args.full_page] [args.full_res] [args.path]: the viewport, downscaled unless full_res; annotate boxes each ref, label [N] = @eN, and returns the legend", "hanzo.screenshot"),
    ext("evaluate", "core", "code: run JavaScript in the page and return its value", "Runtime.evaluate"),
    ext("wait", "core", "selector | text [args.state=hidden] | timeout: until it shows (or goes), or for ms", "hanzo.wait"),
    ext("tabs", "core", "open tabs; tab_id targets one in any action", "Target.getTargets"),
    pw("help", "core", "[topic]: every other action, with how to call it"),
    // interact: more ways to act on a ref or CSS selector
    act("dblclick", "interact", "selector", "dblclick"),
    act("hover", "interact", "selector", "hover"),
    act("focus", "interact", "selector", "focus"),
    act("select", "interact", "selector, args.value: choose a <select> option by value or label", "select"),
    act("check", "interact", "selector: check a checkbox or radio (no-op when already checked)", "check"),
    act("uncheck", "interact", "selector", "uncheck"),
    act("scroll", "interact", "args.delta_x, args.delta_y [selector]: scroll the page, or an element, by pixels", "scroll"),
    act("scroll_into_view", "interact", "selector", "scrollIntoView"),
    act("get_text", "interact", "selector: rendered text; a field's value", "text"),
    act("get_attribute", "interact", "selector, args.attribute", "attribute"),
    act("count", "interact", "selector: how many elements a CSS selector matches", "count"),
    pw("upload", "interact", "selector, args.files: set a file input's files"),
    pw("drag", "interact", "selector, args.target_selector"),
    pw("blur", "interact", "selector"),
    pw("tap", "interact", "selector: a touch tap"),
    pw("swipe", "interact", "selector, args.direction [args.distance]"),
    pw("pinch", "interact", "selector [args.scale]"),
    pw("mouse_move", "interact", "args.x, args.y"),
    pw("mouse_down", "interact", "[args.button]"),
    pw("mouse_up", "interact", "[args.button]"),
    // navigation
    ext("go_back", "navigation", "back one page", "Page.goBack"),
    ext("go_forward", "navigation", "forward one page", "Page.goForward"),
    ext("reload", "navigation", "reload the page", "Page.reload"),
    ext("url", "navigation", "the tab's URL", "hanzo.url"),
    ext("title", "navigation", "the tab's title", "hanzo.title"),
    pw("set_content", "navigation", "args.html: replace the page's HTML"),
    // tabs and browsers
    ext("new_tab", "tabs", "[url]: open a tab", "Target.createTarget"),
    ext("close_tab", "tabs", "tab_id (Playwright: args.tab_index)", "Target.closeTarget"),
    ext("select_tab", "tabs", "tab_id (Playwright: args.tab_index): bring a tab to the front", "Target.activateTarget"),
    pw("browsers", "tabs", "connected browsers; target_browser picks one"),
    ext("status", "tabs", "the browser behind this tool", "Browser.getVersion"),
    pw("close", "tabs", "close the Playwright browser"),
    pw("new_context", "tabs", "[url] [args.device]: an isolated Playwright session (own cookies and storage)"),
    pw("connect", "tabs", "args.cdp_endpoint: attach Playwright to a running Chrome"),
    pw("set_headless", "tabs", "[args.headless]: relaunch Playwright headed or headless"),
    // page: content and state
    ext("get_html", "page", "[selector]: an element's HTML, or the page's", "hanzo.getHTML"),
    pw("get_bounding_box", "page", "selector"),
    pw("pdf", "page", "[args.path]: print the page to PDF"),
    pw("is_visible", "page", "selector"),
    pw("is_enabled", "page", "selector"),
    pw("is_editable", "page", "selector"),
    pw("is_checked", "page", "selector"),
    pw("highlight", "page", "selector: outline an element on screen"),
    // assert: fail unless the page matches (args.not_ negates)
    pw("expect_visible", "assert", "selector"),
    pw("expect_hidden", "assert", "selector"),
    pw("expect_enabled", "assert", "selector"),
    pw("expect_checked", "assert", "selector"),
    pw("expect_text", "assert", "selector, args.expected"),
    pw("expect_value", "assert", "selector, args.expected"),
    pw("expect_attribute", "assert", "selector, args.attribute, args.expected"),
    pw("expect_count", "assert", "selector, args.index (the count)"),
    pw("expect_url", "assert", "args.expected (glob with *)"),
    pw("expect_title", "assert", "args.expected (glob with *)"),
    // storage
    ext("cookies", "storage", "the page's cookies (Playwright: args.cookies sets them)", "hanzo.getCookies"),
    pw("clear_cookies", "storage", "delete every cookie"),
    pw("storage", "storage", "[args.storage_type=local|session] [args.storage_data]: read or write web storage"),
    pw("storage_state", "storage", "args.auth_file: save cookies and storage there, or load them when it exists"),
    // network
    pw("route", "network", "args.pattern [args.block] [args.response] [args.status_code]: block or mock requests"),
    pw("unroute", "network", "args.pattern"),
    pw("wait_for_request", "network", "args.pattern"),
    pw("wait_for_response", "network", "args.pattern"),
    // emulation
    pw("viewport", "emulation", "[args.width, args.height]: read or set the viewport"),
    pw("emulate", "emulation", "args.device: mobile, tablet, laptop, iphone_14, pixel_7, ipad_pro …"),
    pw("geolocation", "emulation", "args.latitude, args.longitude"),
    pw("permissions", "emulation", "args.permission: grant it"),
    // debug and events
    pw("console", "debug", "[args.level]: the page's console messages"),
    pw("errors", "debug", "uncaught page errors"),
    pw("dialog", "debug", "[args.accept] [args.prompt_text]: answer a pending alert/confirm/prompt"),
    pw("file_chooser", "debug", "[args.files]: answer a pending file chooser"),
    pw("download", "debug", "[selector]: the pending download, or click selector and take its download"),
    pw("wait_for_load", "debug", "[args.state=load|domcontentloaded|networkidle]"),
    pw("wait_for_url", "debug", "args.pattern"),
    pw("wait_for_function", "debug", "code: until the JavaScript returns truthy"),
    pw("wait_for_event", "debug", "args.event: request, response, download, filechooser, popup"),
    pw("trace_start", "debug", "record a Playwright trace"),
    pw("trace_stop", "debug", "[args.trace_path]"),
];

/// The extension's page engine answers these as JSON the tool unpacks.
const ENGINE: &[&str] = &["hanzo.navigate", "hanzo.snapshot", "hanzo.read", "hanzo.act", "hanzo.wait"];

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
selector takes a ref (@e2) or a CSS selector. Parameters outside the core
schema go in args, e.g. browser(action="select", selector="@e4", args={"value": "Weekly"})."#;

const DESCRIPTION: &str = r#"Drive a browser: the user's own, signed in, through the Hanzo extension (headless Playwright when none is connected).

Loop: snapshot, act on a ref, snapshot again when the page changes.
  snapshot interactive=true        - button "Sign in" [ref=e2]
  click selector="@e2"   fill selector="@e3" text="me@x.com"   press key="Enter"
  read                             the page as markdown (outline=true, filter="…")
  screenshot annotate=true         every ref boxed, label [N] = @eN
selector takes a ref (@e2) or a CSS selector. A stale ref, or a click on an
element under a banner or modal, is refused with what to do next.

action="help" lists everything else (hover, select, check, scroll, back, cookies,
network, emulation, assertions …); their parameters go in args."#;

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
            let only = if o.wire.is_some() || matches!(o.name, "help" | "browsers") { "" } else { "  (Playwright)" };
            lines.push(format!("  {:<18}{}{}", o.name, o.usage, only).trim_end().to_string());
        }
    }
    lines.push(String::new());
    lines.push("(Playwright): headless Playwright only, not the connected browser.".into());
    lines.push(format!("browser(action=\"help\", topic=\"…\") shows one of: {}.", topics.join(", ")));
    lines.join("\n")
}

/// `BROWSER_BACKEND`, else `~/.hanzo/extension/config.json` `.backend`, else
/// `auto`: one of firefox | chrome | extension | playwright | auto.
pub fn backend() -> String {
    const OK: &[&str] = &["firefox", "chrome", "extension", "playwright", "auto"];
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

/// Playwright actions outside the shared table: locators, frames, events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAction {
    // Navigation
    Navigate,
    Reload,
    GoBack,
    GoForward,
    Close,
    // Content
    Content,
    Url,
    Title,
    SetContent,
    // Input
    Click,
    Dblclick,
    Type,
    Fill,
    Clear,
    Press,
    SelectOption,
    Check,
    Uncheck,
    Upload,
    // Mouse
    Hover,
    Drag,
    MouseMove,
    MouseDown,
    MouseUp,
    MouseWheel,
    Scroll,
    // Touch
    Tap,
    Swipe,
    Pinch,
    // Locators
    Locator,
    FrameLocator,
    GetByRole,
    GetByText,
    GetByLabel,
    GetByPlaceholder,
    GetByTestId,
    GetByAltText,
    GetByTitle,
    // Locator composition
    First,
    Last,
    Nth,
    Filter,
    All,
    Count,
    // Element state
    GetText,
    GetInnerText,
    GetAttribute,
    GetValue,
    GetHtml,
    GetBoundingBox,
    // Assertions
    IsVisible,
    IsEnabled,
    IsChecked,
    IsHidden,
    IsEditable,
    ExpectVisible,
    ExpectHidden,
    ExpectEnabled,
    ExpectText,
    ExpectValue,
    ExpectChecked,
    ExpectUrl,
    ExpectTitle,
    ExpectCount,
    ExpectAttribute,
    // Screen
    Screenshot,
    Pdf,
    Snapshot,
    // JavaScript
    Evaluate,
    Focus,
    Blur,
    Highlight,
    // Wait
    Wait,
    WaitForLoad,
    WaitForUrl,
    WaitForEvent,
    WaitForRequest,
    WaitForResponse,
    WaitForFunction,
    // Viewport
    Viewport,
    Emulate,
    Geolocation,
    Permissions,
    // Network
    Route,
    Unroute,
    // Storage
    Cookies,
    ClearCookies,
    Storage,
    StorageState,
    // Events
    On,
    Off,
    // Dialog / files
    Dialog,
    Frame,
    MainFrame,
    FileChooser,
    Download,
    // Browser management
    NewPage,
    NewContext,
    NewTab,
    CloseTab,
    Tabs,
    Connect,
    SetHeadless,
    Status,
    // Debug
    TraceStart,
    TraceStop,
    Console,
    Errors,
}

impl std::str::FromStr for BrowserAction {
    type Err = anyhow::Error;

    /// One name per action; `select` is the shared table's name for `select_option`.
    fn from_str(s: &str) -> Result<Self> {
        let name = if s == "select" { "select_option" } else { s };
        serde_json::from_value(Value::String(name.to_string())).map_err(|_| anyhow!("Unknown action: {s}"))
    }
}

impl BrowserAction {
    /// The name the driver dispatches on.
    fn wire(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "status".to_string())
    }
}

/// Arguments for the browser tool: the typed core, plus `args` for the rest.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrowserToolArgs {
    #[serde(default)]
    pub action: String,
    // URL/Navigation
    pub url: Option<String>,
    pub html: Option<String>,
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
    // Coordinates
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
    // Options
    pub timeout: Option<i32>,
    pub full_page: Option<bool>,
    pub exact: Option<bool>,
    #[serde(default)]
    pub not_: bool,
    pub expected: Option<String>,
    pub attribute: Option<String>,
    // Locator options
    pub role: Option<String>,
    pub name: Option<String>,
    pub has_text: Option<String>,
    pub has_not_text: Option<String>,
    pub has: Option<String>,
    // Index
    pub index: Option<i32>,
    pub tab_index: Option<i32>,
    // Which browser, which tab
    pub tab_id: Option<Value>,
    pub target_browser: Option<String>,
    pub client_id: Option<String>,
    // Target
    pub target_selector: Option<String>,
    // Device/Viewport
    pub device: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    // Geolocation
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub accuracy: Option<f64>,
    // Files
    pub files: Option<Vec<String>>,
    // Capture output path and detail
    pub path: Option<String>,
    pub max_width: Option<i32>,
    pub quality: Option<i32>,
    #[serde(default)]
    pub full_res: bool,
    // JavaScript
    pub code: Option<String>,
    // Network
    pub pattern: Option<String>,
    pub response: Option<Value>,
    pub status_code: Option<i32>,
    #[serde(default)]
    pub block: bool,
    // Storage
    pub cookies: Option<Vec<Value>>,
    pub storage_type: Option<String>,
    pub storage_data: Option<Value>,
    // Events
    pub event: Option<String>,
    // Wait state
    pub state: Option<String>,
    // Dialog
    #[serde(default = "default_true")]
    pub accept: bool,
    pub prompt_text: Option<String>,
    // Console
    pub level: Option<String>,
    // Permission
    pub permission: Option<String>,
    // Frame
    pub frame: Option<String>,
    // Connection
    pub cdp_endpoint: Option<String>,
    pub cdp_port: Option<u16>,
    pub auth_file: Option<String>,
    // Settings
    pub headless: Option<bool>,
    // Trace
    pub trace_path: Option<String>,
    // Touch
    pub direction: Option<String>,
    pub distance: Option<i32>,
    pub scale: Option<f64>,
    pub button: Option<String>,
    /// Parameters of non-core actions, as `help` names them.
    pub args: Option<Map<String, Value>>,
}

fn default_true() -> bool {
    true
}

impl BrowserToolArgs {
    /// Fold `args` into the typed fields. A key the schema types, or one no
    /// action reads, is refused rather than ignored.
    fn merged(mut self) -> std::result::Result<Self, String> {
        let Some(extra) = self.args.take() else { return Ok(self) };
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
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// The wire params for `action` (`annotate`: a labelled screenshot), peer of
    /// python-sdk `_zap_params`.
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
        ] {
            if let Some(v) = v {
                put(k, v);
            }
        }
        p
    }
}

/// The extension's reply as the tool's: a refusal is an error, a tree or a page
/// is plain text, an engine result is its fields.
fn answer(action: &str, method: &str, provider: &str, text: String) -> Value {
    if let Some(e) = text.strip_prefix("ERR:") {
        return json!({ "error": e, "action": action });
    }
    if ENGINE.contains(&method) {
        if let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&text) {
            let s = |k: &str| match data.get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };
            return match action {
                "snapshot" => Value::String(format!("{} — {} ({} refs)\n{}", s("title"), s("url"), s("refs"), s("tree"))),
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

/// The persistent Node + Playwright driver process. One browser + page lives
/// here for the whole server lifetime, so page state survives across calls.
struct Driver {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    headless: bool,
    endpoint: Option<String>,
}

impl Driver {
    /// Spawn the driver and wait for its readiness handshake.
    async fn spawn(headless: bool, endpoint: Option<String>) -> Result<Self> {
        let conf = json!({ "headless": headless, "cdpEndpoint": endpoint });

        let mut child = Command::new("node")
            .arg("-e")
            .arg(DRIVER_JS)
            .arg(conf.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("failed to spawn browser driver (node): {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("driver stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("driver stdout unavailable"))?;
        let mut lines = BufReader::new(stdout).lines();

        // First line is the handshake: {"ready":true} or {"fatal": "..."}.
        match lines.next_line().await? {
            Some(line) => {
                let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({}));
                if v.get("ready").and_then(Value::as_bool) == Some(true) {
                    Ok(Self {
                        child,
                        stdin,
                        stdout: lines,
                        headless,
                        endpoint,
                    })
                } else {
                    let msg = v
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    Err(anyhow!(
                        "browser driver failed to start: {msg}. Install Playwright: \
                         npm i -g playwright && npx playwright install chromium"
                    ))
                }
            }
            None => Err(anyhow!(
                "browser driver exited before ready. Ensure Node.js and Playwright \
                 are installed: npm i -g playwright && npx playwright install chromium"
            )),
        }
    }

    /// Send one command, read one result line back.
    async fn send(&mut self, cmd: Value) -> Result<Value> {
        let mut line = serde_json::to_string(&cmd)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;

        loop {
            match self.stdout.next_line().await? {
                Some(l) => {
                    let l = l.trim();
                    if l.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(l) {
                        if v.get("id").is_some() {
                            return Ok(v.get("result").cloned().unwrap_or(v));
                        }
                    }
                    // Non-protocol chatter — ignore and keep reading.
                }
                None => return Err(anyhow!("browser driver exited during action")),
            }
        }
    }

    async fn shutdown(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// Browser tool — the connected browser over ZAP, else the Playwright driver.
pub struct BrowserTool {
    headless: bool,
    default_endpoint: Option<String>,
    driver: Arc<Mutex<Option<Driver>>>,
}

impl BrowserTool {
    pub fn new() -> Self {
        let default_endpoint = std::env::var("BROWSER_CDP_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty());
        Self {
            headless: true,
            default_endpoint,
            driver: Arc::new(Mutex::new(None)),
        }
    }

    /// Resolve the CDP endpoint for a call: explicit endpoint > port > env/default.
    fn resolve_endpoint(&self, args: &BrowserToolArgs) -> Option<String> {
        args.cdp_endpoint
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| args.cdp_port.map(|p| format!("http://localhost:{p}")))
            .or_else(|| self.default_endpoint.clone())
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
            return match name.parse::<BrowserAction>() {
                Ok(action) => self.dispatch(action, a).await,
                Err(_) => Ok(json!({
                    "error": format!("Unknown action {name:?}. Core: {}. action=\"help\" lists the rest.", core().join(", "))
                })),
            };
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

        let by_ref = a.selector.as_deref().is_some_and(is_ref);
        let backend = backend();
        let filter = a
            .target_browser
            .clone()
            .or_else(|| matches!(backend.as_str(), "firefox" | "chrome").then(|| backend.clone()));
        let annotate = name == "screenshot" && a.annotate;
        if name == "scroll" && a.delta_x.is_none() && a.delta_y.is_none() {
            a.delta_y = Some(300);
        }

        if let (true, Some(method)) = (backend != "playwright", spec.wire) {
            match self.extension(&name, method, spec.act, &a, filter.as_deref(), annotate).await {
                Ok(v) => return Ok(v),
                // Refs and labels exist only in the extension, and an explicit
                // backend means that browser: no Playwright stand-in for either.
                Err(e) if by_ref || annotate || matches!(backend.as_str(), "firefox" | "chrome" | "extension") => {
                    return Ok(json!({ "error": e, "action": name, "backend": backend }))
                }
                Err(_) => {}
            }
        }
        if by_ref {
            return Ok(json!({
                "error": format!("{} is a snapshot ref, and refs come from the Hanzo extension; on headless Playwright pass a CSS selector.", a.selector.unwrap_or_default()),
                "action": name,
            }));
        }
        if annotate {
            return Ok(json!({ "error": "annotate labels refs, which come from the Hanzo extension.", "action": name }));
        }
        match name.parse::<BrowserAction>() {
            Ok(BrowserAction::Status) => Ok(self.status().await),
            Ok(action) => self.dispatch(action, a).await,
            Err(_) => Ok(json!({ "error": format!("{name} needs the Hanzo extension: {}", zap::UNPAIRED), "action": name })),
        }
    }

    /// Route one action to the browser on this user's ZAP router. `Err` is a
    /// transport failure (no browser, no answer), which may fall back; the
    /// browser's own refusal comes back `Ok` as an error.
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

    /// Forward an action to the persistent driver, (re)spawning it if the
    /// requested headless/endpoint config differs from the running one.
    async fn dispatch(&self, action: BrowserAction, args: BrowserToolArgs) -> Result<Value> {
        let want_headless = args.headless.unwrap_or(self.headless);
        let want_endpoint = self.resolve_endpoint(&args);

        let mut cmd = serde_json::to_value(&args).unwrap_or_else(|_| json!({}));
        if let Value::Object(ref mut map) = cmd {
            map.insert("action".to_string(), Value::String(action.wire()));
            map.insert("id".to_string(), json!(next_id()));
        }

        let mut guard = self.driver.lock().await;

        let need_respawn = match guard.as_ref() {
            None => true,
            Some(d) => d.headless != want_headless || d.endpoint != want_endpoint,
        };
        if need_respawn {
            if let Some(mut old) = guard.take() {
                old.shutdown().await;
            }
            *guard = Some(Driver::spawn(want_headless, want_endpoint).await?);
        }

        let driver = guard.as_mut().expect("driver present after spawn");
        let outcome = driver.send(cmd).await;
        match outcome {
            Ok(v) => Ok(v),
            Err(e) => {
                // Driver died mid-flight — drop it so the next call respawns.
                *guard = None;
                Err(e)
            }
        }
    }

    /// The Playwright side's status, when no browser answers for it.
    async fn status(&self) -> Value {
        let running = self.driver.lock().await.is_some();
        json!({
            "success": true,
            "source": "playwright",
            "driver_running": running,
            "headless": self.headless,
            "cdp_endpoint": self.default_endpoint,
        })
    }
}

impl Default for BrowserTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Monotonic command id for request/response pairing.
fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// The Node driver program. Kept resident: holds one browser + context + page,
/// reads newline-JSON commands on stdin, writes newline-JSON results on stdout.
/// Attaches over CDP when `cdpEndpoint` is set, else launches Chromium.
const DRIVER_JS: &str = r###"
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  process.stdout.write(JSON.stringify({ fatal: true, error: String(e && e.message || e) }) + '\n');
  process.exit(1);
}

const CONF = JSON.parse(process.argv[1] || '{}');
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEVICES = {
  mobile: { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 1024, height: 1366 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1440, height: 900 }, userAgent: DEFAULT_UA, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  desktop: { viewport: { width: 1920, height: 1080 }, userAgent: DEFAULT_UA, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  iphone_14: { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphone_15_pro: { viewport: { width: 393, height: 852 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  pixel_7: { viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  ipad_pro: { viewport: { width: 1024, height: 1366 }, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  galaxy_s23: { viewport: { width: 360, height: 780 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser = null, context = null, page = null;
let pages = [], contexts = [];
let curDevice = null, initialized = false;
const state = { console: [], errors: [], routes: {}, tracing: false, dialog: null, download: null, fileChooser: null };

function setupListeners(p) {
  p.on('console', (m) => { try { state.console.push({ type: m.type(), text: m.text(), location: m.location() }); } catch (e) {} });
  p.on('pageerror', (e) => { state.errors.push(String(e)); });
  p.on('dialog', (d) => { state.dialog = d; });
  p.on('download', (d) => { state.download = d; });
  p.on('filechooser', (fc) => { state.fileChooser = fc; });
}

async function closeAll() {
  if (state.tracing && context) { try { await context.tracing.stop(); } catch (e) {} }
  if (browser) { try { await browser.close(); } catch (e) {} }
  browser = context = page = null; pages = []; contexts = [];
  initialized = false; state.console = []; state.errors = []; state.routes = {};
  state.tracing = false; state.dialog = null; state.download = null; state.fileChooser = null;
}

async function ensure(device) {
  const dev = (device === undefined) ? null : device;
  const needInit = !initialized || !page || !browser || dev !== curDevice;
  if (needInit) {
    if (initialized) await closeAll();
    const settings = dev ? DEVICES[dev] : null;
    if (CONF.cdpEndpoint) {
      browser = await chromium.connectOverCDP(CONF.cdpEndpoint);
      const cs = browser.contexts();
      if (cs.length) {
        context = cs[0];
        const ps = context.pages();
        if (ps.length) { page = ps[0]; pages = ps.slice(); }
        else { page = await context.newPage(); pages = [page]; }
      } else {
        const opts = { viewport: { width: 1280, height: 720 } };
        if (settings) Object.assign(opts, settings);
        context = await browser.newContext(opts);
        page = await context.newPage(); pages = [page];
      }
    } else {
      browser = await chromium.launch({ headless: CONF.headless !== false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
      const opts = { viewport: { width: 1440, height: 900 }, userAgent: DEFAULT_UA };
      if (settings) Object.assign(opts, settings);
      context = await browser.newContext(opts); contexts = [context];
      page = await context.newPage(); pages = [page];
    }
    curDevice = dev;
    setupListeners(page);
    initialized = true;
  }
  return page;
}

function loc(sel, frame) {
  return frame ? page.frameLocator(frame).locator(sel) : page.locator(sel);
}

function saveCapture(buf, fmt, outPath) {
  let target;
  try {
    if (outPath) {
      target = outPath.replace(/^~(?=$|\/)/, os.homedir());
      const dir = path.dirname(target);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } else {
      const d = path.join(os.homedir(), '.hanzo', 'screenshots');
      fs.mkdirSync(d, { recursive: true });
      target = path.join(d, 'capture-' + crypto.randomBytes(6).toString('hex') + '.' + fmt);
    }
    fs.writeFileSync(target, buf);
  } catch (e) {
    return { success: true, format: fmt, size: buf.length, base64: buf.toString('base64') };
  }
  const out = { success: true, format: fmt, size: buf.length, path: target };
  if (fmt === 'png' && buf.length <= 40000) out.base64 = buf.toString('base64');
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function poll(fn, timeout) {
  const end = Date.now() + (timeout || 5000);
  do {
    try { if (await fn()) return true; } catch (e) {}
    await sleep(100);
  } while (Date.now() < end);
  return false;
}

function isRegex(p) { return typeof p === 'string' && p.indexOf('*') >= 0; }
function toMatcher(p) { return isRegex(p) ? new RegExp(p.replace(/\*/g, '.*')) : p; }

async function dispatch(c) {
  const action = c.action;
  const sel = c.selector || null;
  const timeout = c.timeout || 30000;
  const neg = c.not_ === true || c.not === true;
  const frame = c.frame || null;

  // Lifecycle that does not need a live page first.
  if (action === 'connect') {
    if (!CONF.cdpEndpoint) return { error: 'cdp_endpoint required' };
    await ensure(c.device);
    return { success: true, connected: true, endpoint: CONF.cdpEndpoint, url: page.url() };
  }
  if (action === 'emulate') {
    if (!c.device) return { error: 'device required. Available: ' + Object.keys(DEVICES).join(', ') };
    if (!DEVICES[c.device]) return { error: 'Unknown device. Available: ' + Object.keys(DEVICES).join(', ') };
    await ensure(c.device);
    return Object.assign({ success: true, device: c.device }, DEVICES[c.device]);
  }
  if (action === 'close') { await closeAll(); return { success: true, closed: true }; }
  if (action === 'status') {
    return {
      success: true, initialized, headless: CONF.headless !== false, device: curDevice,
      pages: pages.length, contexts: contexts.length, current_url: page ? page.url() : null,
      console_messages: state.console.length, errors: state.errors.length,
      routes: Object.keys(state.routes), tracing: state.tracing,
    };
  }

  await ensure(c.device);

  switch (action) {
    // ── Navigation ──────────────────────────────────────────────
    case 'navigate': {
      if (!c.url) return { error: 'url required' };
      const resp = await page.goto(c.url, { timeout, waitUntil: c.state || 'domcontentloaded' });
      return { success: true, url: page.url(), title: await page.title(), status: resp ? resp.status() : null };
    }
    case 'set_content':
      if (!c.html) return { error: 'html required' };
      await page.setContent(c.html, { timeout });
      return { success: true, set_content: true };
    case 'content':
      return { success: true, html: await page.content() };
    case 'url':
      return { success: true, url: page.url() };
    case 'title':
      return { success: true, title: await page.title() };
    case 'reload': {
      const resp = await page.reload({ timeout });
      return { success: true, url: page.url(), status: resp ? resp.status() : null };
    }
    case 'go_back': {
      const resp = await page.goBack({ timeout });
      return { success: true, url: page.url(), navigated: resp !== null };
    }
    case 'go_forward': {
      const resp = await page.goForward({ timeout });
      return { success: true, url: page.url(), navigated: resp !== null };
    }

    // ── Input ───────────────────────────────────────────────────
    case 'click':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).click({ timeout, button: c.button || 'left' });
      return { success: true, clicked: sel };
    case 'dblclick':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).dblclick({ timeout });
      return { success: true, double_clicked: sel };
    case 'type':
      if (!sel || c.text == null) return { error: 'selector and text required' };
      await loc(sel, frame).type(c.text, { timeout });
      return { success: true, typed: c.text.length, selector: sel };
    case 'fill':
      if (!sel || c.text == null) return { error: 'selector and text required' };
      await loc(sel, frame).fill(c.text, { timeout });
      return { success: true, filled: sel };
    case 'clear':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).clear({ timeout });
      return { success: true, cleared: sel };
    case 'press':
      if (!c.key) return { error: 'key required' };
      if (sel) await loc(sel, frame).press(c.key, { timeout });
      else await page.keyboard.press(c.key);
      return { success: true, pressed: c.key };

    // ── Forms ───────────────────────────────────────────────────
    case 'select_option': {
      if (!sel || c.value == null) return { error: 'selector and value required' };
      const v = Array.isArray(c.value) ? c.value : [c.value];
      const selected = await loc(sel, frame).selectOption(v, { timeout });
      return { success: true, selected };
    }
    case 'check':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).check({ timeout });
      return { success: true, checked: sel };
    case 'uncheck':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).uncheck({ timeout });
      return { success: true, unchecked: sel };
    case 'upload':
      if (!sel || !c.files) return { error: 'selector and files required' };
      await loc(sel, frame).setInputFiles(c.files, { timeout });
      return { success: true, uploaded: c.files.length };

    // ── Mouse ───────────────────────────────────────────────────
    case 'hover':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).hover({ timeout });
      return { success: true, hovered: sel };
    case 'drag':
      if (!sel || !c.target_selector) return { error: 'selector and target_selector required' };
      await page.dragAndDrop(sel, c.target_selector, { timeout });
      return { success: true, dragged: sel, to: c.target_selector };
    case 'mouse_move':
      if (c.x == null || c.y == null) return { error: 'x and y required' };
      await page.mouse.move(c.x, c.y);
      return { success: true, moved_to: { x: c.x, y: c.y } };
    case 'mouse_down':
      await page.mouse.down({ button: c.button || 'left' });
      return { success: true, button_down: c.button || 'left' };
    case 'mouse_up':
      await page.mouse.up({ button: c.button || 'left' });
      return { success: true, button_up: c.button || 'left' };
    case 'mouse_wheel':
      await page.mouse.wheel(c.delta_x || 0, c.delta_y || 0);
      return { success: true, scrolled: { delta_x: c.delta_x || 0, delta_y: c.delta_y || 0 } };
    case 'scroll':
      if (sel) {
        await loc(sel, frame).scrollIntoViewIfNeeded({ timeout });
        return { success: true, scrolled_to: sel };
      }
      await page.evaluate('window.scrollBy(' + (c.delta_x || 0) + ', ' + (c.delta_y || 300) + ')');
      return { success: true, scrolled: { delta_x: c.delta_x || 0, delta_y: c.delta_y || 300 } };

    // ── Touch ───────────────────────────────────────────────────
    case 'tap':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).tap({ timeout });
      return { success: true, tapped: sel };
    case 'swipe': {
      if (!sel || !c.direction) return { error: 'selector and direction required' };
      const box = await loc(sel, frame).boundingBox();
      if (!box) return { error: 'Element not visible' };
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const dist = c.distance || 200;
      const off = { left: [-dist, 0], right: [dist, 0], up: [0, -dist], down: [0, dist] }[c.direction] || [0, 0];
      try { await page.touchscreen.tap(cx, cy); } catch (e) {}
      await page.mouse.move(cx, cy); await page.mouse.down();
      await page.mouse.move(cx + off[0], cy + off[1], { steps: 10 }); await page.mouse.up();
      return { success: true, swiped: sel, direction: c.direction };
    }
    case 'pinch': {
      if (!sel) return { error: 'selector required' };
      const zoom = c.scale || 0.5;
      const dy = zoom > 1 ? -100 : 100;
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, bubbles: true }));
      }, sel);
      return { success: true, pinched: sel, scale: zoom };
    }

    // ── Locators ────────────────────────────────────────────────
    case 'locator': {
      if (!sel) return { error: 'selector required' };
      const l = loc(sel, frame); const cnt = await l.count();
      return { success: true, selector: sel, count: cnt, visible: cnt > 0 ? await l.first.isVisible() : false };
    }
    case 'frame_locator':
      if (!sel) return { error: 'selector required' };
      page.frameLocator(sel);
      return { success: true, frame: sel, note: 'Use frame parameter in subsequent actions' };
    case 'get_by_role': {
      if (!c.role) return { error: 'role required' };
      const l = page.getByRole(c.role, { name: c.name || undefined, exact: !!c.exact });
      return { success: true, role: c.role, name: c.name || null, count: await l.count() };
    }
    case 'get_by_text':
      if (!c.text) return { error: 'text required' };
      return { success: true, text: c.text, count: await page.getByText(c.text, { exact: !!c.exact }).count() };
    case 'get_by_label':
      if (!c.text) return { error: 'text required' };
      return { success: true, label: c.text, count: await page.getByLabel(c.text, { exact: !!c.exact }).count() };
    case 'get_by_placeholder':
      if (!c.text) return { error: 'text required' };
      return { success: true, placeholder: c.text, count: await page.getByPlaceholder(c.text, { exact: !!c.exact }).count() };
    case 'get_by_test_id':
      if (!c.text) return { error: 'text required' };
      return { success: true, test_id: c.text, count: await page.getByTestId(c.text).count() };
    case 'get_by_alt_text':
      if (!c.text) return { error: 'text required' };
      return { success: true, alt_text: c.text, count: await page.getByAltText(c.text, { exact: !!c.exact }).count() };
    case 'get_by_title':
      if (!c.text) return { error: 'text required' };
      return { success: true, title: c.text, count: await page.getByTitle(c.text, { exact: !!c.exact }).count() };

    // ── Composition ─────────────────────────────────────────────
    case 'first':
      if (!sel) return { error: 'selector required' };
      return { success: true, first: true, visible: await loc(sel, frame).first.isVisible() };
    case 'last':
      if (!sel) return { error: 'selector required' };
      return { success: true, last: true, visible: await loc(sel, frame).last.isVisible() };
    case 'nth':
      if (!sel || c.index == null) return { error: 'selector and index required' };
      return { success: true, nth: c.index, visible: await loc(sel, frame).nth(c.index).isVisible() };
    case 'filter': {
      if (!sel) return { error: 'selector required' };
      let l = loc(sel, frame); const opts = {};
      if (c.has_text) opts.hasText = c.has_text;
      if (c.has_not_text) opts.hasNotText = c.has_not_text;
      if (c.has) opts.has = page.locator(c.has);
      if (Object.keys(opts).length) l = l.filter(opts);
      return { success: true, filtered: true, count: await l.count() };
    }
    case 'all': {
      if (!sel) return { error: 'selector required' };
      const els = await loc(sel, frame).all(); const out = [];
      for (let i = 0; i < els.length && i < 20; i++)
        out.push({ index: i, visible: await els[i].isVisible(), text: await els[i].textContent() });
      return { success: true, count: els.length, elements: out };
    }
    case 'count':
      if (!sel) return { error: 'selector required' };
      return { success: true, count: await loc(sel, frame).count() };

    // ── Content ─────────────────────────────────────────────────
    case 'get_text':
      if (!sel) return { error: 'selector required' };
      return { success: true, text: await loc(sel, frame).textContent({ timeout }) };
    case 'get_inner_text':
      if (!sel) return { error: 'selector required' };
      return { success: true, inner_text: await loc(sel, frame).innerText({ timeout }) };
    case 'get_attribute':
      if (!sel || !c.attribute) return { error: 'selector and attribute required' };
      return { success: true, attribute: c.attribute, value: await loc(sel, frame).getAttribute(c.attribute, { timeout }) };
    case 'get_value':
      if (!sel) return { error: 'selector required' };
      return { success: true, value: await loc(sel, frame).inputValue({ timeout }) };
    case 'get_html':
      if (sel) return { success: true, html: await loc(sel, frame).innerHTML({ timeout }) };
      return { success: true, html: await page.content() };
    case 'get_bounding_box': {
      if (!sel) return { error: 'selector required' };
      const box = await loc(sel, frame).boundingBox({ timeout });
      return box ? { success: true, bounding_box: box } : { error: 'Element not visible' };
    }

    // ── State ───────────────────────────────────────────────────
    case 'is_visible':
      if (!sel) return { error: 'selector required' };
      return { success: true, visible: await loc(sel, frame).isVisible({ timeout }) };
    case 'is_hidden':
      if (!sel) return { error: 'selector required' };
      return { success: true, hidden: await loc(sel, frame).isHidden({ timeout }) };
    case 'is_enabled':
      if (!sel) return { error: 'selector required' };
      return { success: true, enabled: await loc(sel, frame).isEnabled({ timeout }) };
    case 'is_editable':
      if (!sel) return { error: 'selector required' };
      return { success: true, editable: await loc(sel, frame).isEditable({ timeout }) };
    case 'is_checked':
      if (!sel) return { error: 'selector required' };
      return { success: true, checked: await loc(sel, frame).isChecked({ timeout }) };

    // ── Assertions ──────────────────────────────────────────────
    case 'expect_url': {
      const pat = c.expected || c.url || c.pattern;
      if (!pat) return { error: 'expected URL pattern required' };
      const m = toMatcher(pat);
      const ok = await poll(() => (m instanceof RegExp ? m.test(page.url()) : page.url() === m), timeout);
      return { success: ok, assertion: 'url', passed: ok };
    }
    case 'expect_title': {
      const pat = c.expected || c.text;
      if (!pat) return { error: 'expected title required' };
      const m = toMatcher(pat);
      const ok = await poll(async () => { const t = await page.title(); return m instanceof RegExp ? m.test(t) : t === m; }, timeout);
      return { success: ok, assertion: 'title', passed: ok };
    }
    case 'expect_visible': case 'expect_hidden': case 'expect_enabled':
    case 'expect_text': case 'expect_value': case 'expect_checked':
    case 'expect_count': case 'expect_attribute': {
      if (!sel) return { error: 'selector required for element assertions' };
      const l = loc(sel, frame); const kind = action.replace('expect_', '');
      let check;
      if (kind === 'visible') check = () => l.isVisible();
      else if (kind === 'hidden') check = () => l.isHidden();
      else if (kind === 'enabled') check = () => l.isEnabled();
      else if (kind === 'checked') check = () => l.isChecked();
      else if (kind === 'text') { const exp = c.expected != null ? c.expected : c.text; if (exp == null) return { error: 'expected text required' }; check = async () => ((await l.innerText()) || '').trim() === String(exp).trim(); }
      else if (kind === 'value') { const exp = c.expected != null ? c.expected : c.value; if (exp == null) return { error: 'expected value required' }; check = async () => (await l.inputValue()) === exp; }
      else if (kind === 'count') { if (c.index == null) return { error: 'index (expected count) required' }; check = async () => (await l.count()) === c.index; }
      else if (kind === 'attribute') { if (!c.attribute || c.expected == null) return { error: 'attribute and expected required' }; check = async () => (await l.getAttribute(c.attribute)) === c.expected; }
      else return { error: 'Unknown assertion: ' + kind };
      let ok = await poll(check, timeout);
      if (neg && kind !== 'count') ok = !ok;
      return { success: ok, assertion: kind, passed: ok, selector: sel };
    }

    // ── Screen ──────────────────────────────────────────────────
    case 'screenshot': {
      const opts = { fullPage: !!c.full_page, type: 'png' };
      const buf = sel ? await loc(sel, frame).screenshot(opts) : await page.screenshot(opts);
      return saveCapture(buf, 'png', c.path);
    }
    case 'pdf': {
      const buf = await page.pdf();
      return saveCapture(buf, 'pdf', c.path);
    }
    case 'snapshot':
      return { success: true, url: page.url(), title: await page.title(), snapshot: await page.accessibility.snapshot() };

    // ── JavaScript ──────────────────────────────────────────────
    case 'evaluate':
      if (!c.code) return { error: 'code required' };
      return { success: true, result: await page.evaluate(c.code) };
    case 'focus':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).focus({ timeout });
      return { success: true, focused: sel };
    case 'blur':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).blur({ timeout });
      return { success: true, blurred: sel };
    case 'highlight':
      if (!sel) return { error: 'selector required' };
      await loc(sel, frame).highlight();
      return { success: true, highlighted: sel };

    // ── Wait ────────────────────────────────────────────────────
    case 'wait':
      if (sel) { await loc(sel, frame).waitFor({ timeout, state: c.state || 'visible' }); return { success: true, found: sel }; }
      if (c.timeout) { await sleep(c.timeout); return { success: true, waited_ms: c.timeout }; }
      return { error: 'selector or timeout required' };
    case 'wait_for_load':
      await page.waitForLoadState(c.state || 'load', { timeout });
      return { success: true, state: c.state || 'load' };
    case 'wait_for_url':
      if (!c.pattern && !c.url) return { error: 'pattern or url required' };
      await page.waitForURL(toMatcher(c.pattern || c.url), { timeout });
      return { success: true, url: page.url() };
    case 'wait_for_event': {
      if (!c.event) return { error: 'event required (request, response, download, filechooser, popup)' };
      const r = await page.waitForEvent(c.event, { timeout });
      if (c.event === 'request') return { success: true, event: c.event, url: r.url(), method: r.method() };
      if (c.event === 'response') return { success: true, event: c.event, url: r.url(), status: r.status() };
      if (c.event === 'download') return { success: true, event: c.event, filename: r.suggestedFilename() };
      return { success: true, event: c.event };
    }
    case 'wait_for_request': {
      if (!c.pattern) return { error: 'pattern required' };
      const r = await page.waitForRequest(toMatcher(c.pattern), { timeout });
      return { success: true, url: r.url(), method: r.method() };
    }
    case 'wait_for_response': {
      if (!c.pattern) return { error: 'pattern required' };
      const r = await page.waitForResponse(toMatcher(c.pattern), { timeout });
      return { success: true, url: r.url(), status: r.status() };
    }
    case 'wait_for_function':
      if (!c.code) return { error: 'code (JavaScript function) required' };
      await page.waitForFunction(c.code, { timeout });
      return { success: true, function_returned_truthy: true };

    // ── Viewport / device ───────────────────────────────────────
    case 'viewport':
      if (c.width == null || c.height == null) return { success: true, viewport: page.viewportSize() };
      await page.setViewportSize({ width: c.width, height: c.height });
      return { success: true, viewport: { width: c.width, height: c.height } };
    case 'geolocation':
      if (c.latitude == null || c.longitude == null) return { error: 'latitude and longitude required' };
      await context.setGeolocation({ latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy || 100 });
      return { success: true, geolocation: { lat: c.latitude, lon: c.longitude } };
    case 'permissions':
      if (!c.permission) return { error: 'permission required' };
      await context.grantPermissions([c.permission]);
      return { success: true, granted: c.permission };

    // ── Network ─────────────────────────────────────────────────
    case 'route': {
      if (!c.pattern) return { error: 'pattern required' };
      await page.route(c.pattern, async (route) => {
        if (c.block) return route.abort();
        if (c.response != null) {
          const body = typeof c.response === 'object' ? JSON.stringify(c.response) : String(c.response);
          return route.fulfill({ status: c.status_code || 200, contentType: 'application/json', body });
        }
        return route.continue();
      });
      state.routes[c.pattern] = { block: !!c.block, mock: c.response != null };
      return { success: true, route: c.pattern };
    }
    case 'unroute':
      if (!c.pattern) return { error: 'pattern required' };
      await page.unroute(c.pattern);
      delete state.routes[c.pattern];
      return { success: true, unrouted: c.pattern };

    // ── Storage ─────────────────────────────────────────────────
    case 'cookies':
      if (c.cookies) { await context.addCookies(c.cookies); return { success: true, set_cookies: c.cookies.length }; }
      return { success: true, cookies: await context.cookies() };
    case 'clear_cookies':
      await context.clearCookies();
      return { success: true, cleared_cookies: true };
    case 'storage': {
      const store = (c.storage_type || 'local') === 'local' ? 'localStorage' : 'sessionStorage';
      if (c.storage_data) {
        for (const [k, v] of Object.entries(c.storage_data))
          await page.evaluate((a) => window[a.store].setItem(a.k, a.v), { store, k, v: typeof v === 'object' ? JSON.stringify(v) : String(v) });
        return { success: true, set_keys: Object.keys(c.storage_data) };
      }
      return { success: true, data: await page.evaluate((s) => Object.fromEntries(Object.entries(window[s])), store) };
    }
    case 'storage_state': {
      if (!c.auth_file) return { error: 'auth_file required' };
      const p = c.auth_file.replace(/^~(?=$|\/)/, os.homedir());
      if (fs.existsSync(p)) {
        const st = JSON.parse(fs.readFileSync(p, 'utf8'));
        await context.addCookies(st.cookies || []);
        return { success: true, loaded: c.auth_file };
      }
      const st = await context.storageState();
      fs.writeFileSync(p, JSON.stringify(st, null, 2));
      return { success: true, saved: c.auth_file };
    }

    // ── Events ──────────────────────────────────────────────────
    case 'on':
      if (!c.event) return { error: 'event required' };
      return { success: true, listening: c.event, note: 'Use console/errors/dialog actions to retrieve captured events' };
    case 'off':
      return { success: true, note: 'Event listeners managed automatically' };
    case 'dialog': {
      if (!state.dialog) return { error: 'No pending dialog' };
      const d = state.dialog;
      if (c.accept !== false) await d.accept(c.prompt_text || ''); else await d.dismiss();
      state.dialog = null;
      return { success: true, type: d.type(), message: d.message(), accepted: c.accept !== false };
    }
    case 'frame':
      if (!sel) return { error: 'selector required for frame' };
      return { success: true, frame: sel, note: 'Use frame parameter in subsequent actions' };
    case 'main_frame':
      return { success: true, frame: 'main' };
    case 'file_chooser': {
      if (!state.fileChooser) return { error: 'No pending file chooser. Trigger an upload first.' };
      const fc = state.fileChooser;
      if (c.files) { await fc.setFiles(c.files); state.fileChooser = null; return { success: true, uploaded: c.files.length }; }
      return { success: true, file_chooser_pending: true, multiple: fc.isMultiple() };
    }
    case 'download': {
      if (state.download) {
        const d = state.download; const p = await d.path(); state.download = null;
        return { success: true, filename: d.suggestedFilename(), path: p || null, url: d.url() };
      }
      if (sel) {
        const [d] = await Promise.all([page.waitForEvent('download', { timeout }), page.click(sel)]);
        return { success: true, filename: d.suggestedFilename(), url: d.url() };
      }
      return { error: 'No pending download and no selector to click' };
    }
    case 'console': {
      let msgs = state.console;
      if (c.level) msgs = msgs.filter((m) => m.type === c.level);
      return { success: true, messages: msgs.slice(-50), count: msgs.length };
    }
    case 'errors':
      return { success: true, errors: state.errors.slice(-20), count: state.errors.length };

    // ── Browser / tabs ──────────────────────────────────────────
    case 'new_page': case 'new_tab': {
      const p = await context.newPage(); setupListeners(p); pages.push(p); page = p;
      if (c.url) await p.goto(c.url);
      return { success: true, page_index: pages.length - 1, url: p.url() };
    }
    case 'new_context': {
      const opts = {};
      if (c.device && DEVICES[c.device]) Object.assign(opts, DEVICES[c.device]);
      const ctx = await browser.newContext(opts); contexts.push(ctx);
      const p = await ctx.newPage(); setupListeners(p); pages.push(p); page = p;
      if (c.url) await p.goto(c.url);
      return { success: true, context: 'new', device: c.device || null, isolated: true, url: p.url() };
    }
    case 'close_tab': {
      const idx = c.tab_index != null ? c.tab_index : pages.indexOf(page);
      if (idx >= 0 && idx < pages.length) {
        const p = pages.splice(idx, 1)[0]; await p.close();
        page = pages.length ? pages[Math.min(idx, pages.length - 1)] : null;
      }
      return { success: true, remaining_pages: pages.length };
    }
    case 'tabs':
      if (c.tab_index != null) {
        if (c.tab_index < 0 || c.tab_index >= pages.length) return { error: 'Invalid page index: ' + c.tab_index };
        page = pages[c.tab_index]; await page.bringToFront();
        return { success: true, switched_to: c.tab_index, url: page.url() };
      }
      return { success: true, count: pages.length, tabs: pages.map((p, i) => ({ index: i, url: p.url() })) };
    case 'set_headless': {
      const cur = page ? page.url() : null;
      const newHeadless = c.headless != null ? c.headless : !(CONF.headless !== false);
      const old = (CONF.headless !== false) ? 'headless' : 'headed';
      await closeAll();
      CONF.headless = newHeadless;
      await ensure(c.device);
      if (cur && cur !== 'about:blank') await page.goto(cur);
      return { success: true, previous_mode: old, current_mode: newHeadless ? 'headless' : 'headed' };
    }

    // ── Debug ───────────────────────────────────────────────────
    case 'trace_start':
      if (state.tracing) return { error: 'Tracing already active' };
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      state.tracing = true;
      return { success: true, tracing: true };
    case 'trace_stop': {
      if (!state.tracing) return { error: 'Tracing not active' };
      const p = (c.trace_path || ('trace-' + Date.now() + '.zip')).replace(/^~(?=$|\/)/, os.homedir());
      await context.tracing.stop({ path: p });
      state.tracing = false;
      return { success: true, trace_path: p };
    }

    default:
      return { error: 'Unknown action: ' + action };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let cmd;
  try { cmd = JSON.parse(line); } catch (e) { return; }
  let result;
  try { result = await dispatch(cmd); }
  catch (e) { result = { error: String(e && e.message || e), action: cmd.action }; }
  process.stdout.write(JSON.stringify({ id: cmd.id, result }) + '\n');
});
rl.on('close', () => process.exit(0));
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
"###;

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
                    "selector": {"type": "string", "description": "Element: a snapshot ref (@e2) or a CSS selector"},
                    "url": {"type": "string", "description": "navigate: the URL"},
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
                    "args": {"type": "object", "description": "Parameters of non-core actions, as help names them"}
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
    }

    #[test]
    fn help_lists_topics_and_marks_playwright() {
        let all = help(None);
        assert!(all.starts_with("The loop"));
        assert!(all.contains("  pdf               [args.path]: print the page to PDF  (Playwright)"));
        assert!(help(Some("core")).contains("navigate"));
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

        for bad in [json!({"bogus": 1}), json!({"selector": "#x"})] {
            let a = BrowserToolArgs { args: Some(serde_json::from_value(bad).unwrap()), ..Default::default() };
            assert!(a.merged().unwrap_err().starts_with("Unknown args"));
        }
    }

    fn map(p: Vec<(String, String)>) -> Value {
        Value::Object(p.into_iter().map(|(k, v)| (k, Value::String(v))).collect())
    }

    #[test]
    fn wire_params_match_python() {
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
    }

    #[test]
    fn refs_and_names() {
        assert!(is_ref("@e2") && is_ref("e10") && !is_ref("#e2") && !is_ref("@e") && !is_ref("button"));
        assert_eq!("select".parse::<BrowserAction>().unwrap(), BrowserAction::SelectOption);
        assert_eq!(BrowserAction::GetByTestId.wire(), "get_by_test_id");
        assert!("goto".parse::<BrowserAction>().is_err());
    }

    #[test]
    fn engine_answers_unpack() {
        let tree = json!({"title": "T", "url": "U", "refs": 2, "tree": "- button [ref=e2]"}).to_string();
        assert_eq!(answer("snapshot", "hanzo.snapshot", "p", tree), Value::String("T — U (2 refs)\n- button [ref=e2]".into()));
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

