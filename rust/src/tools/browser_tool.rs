/// Browser automation tool (HIP-0300)
///
/// Full Playwright surface driven by ONE long-lived Node driver process.
///
/// Design (matches python-sdk/pkg/hanzo-tools-browser):
/// - A single persistent `node` + `playwright` driver is spawned once and kept
///   alive across MCP calls. It holds one browser + context + page, so
///   multi-step flows keep their page state (navigate -> fill -> click -> read).
/// - Each action is a newline-delimited JSON command on the driver's stdin; the
///   driver replies with one newline-delimited JSON result on stdout.
/// - When `cdp_endpoint`/`cdp_port` is set, the driver attaches to the existing
///   browser over CDP (Chrome DevTools Protocol / the Hanzo extension bridge)
///   instead of launching a fresh Chromium.
/// - The full ~90-action surface is dispatched inside the driver, mirroring the
///   Python `BrowserTool.execute` one-to-one. There is no Python fallback.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Browser actions — the full Playwright surface.
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
    Help,
}

impl Default for BrowserAction {
    fn default() -> Self {
        Self::Status
    }
}

impl std::str::FromStr for BrowserAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "navigate" | "goto" | "go" => Ok(Self::Navigate),
            "reload" | "refresh" => Ok(Self::Reload),
            "go_back" | "back" => Ok(Self::GoBack),
            "go_forward" | "forward" => Ok(Self::GoForward),
            "close" => Ok(Self::Close),
            "content" | "html" => Ok(Self::Content),
            "url" => Ok(Self::Url),
            "title" => Ok(Self::Title),
            "set_content" => Ok(Self::SetContent),
            "click" => Ok(Self::Click),
            "dblclick" | "double_click" => Ok(Self::Dblclick),
            "type" => Ok(Self::Type),
            "fill" => Ok(Self::Fill),
            "clear" => Ok(Self::Clear),
            "press" | "press_key" => Ok(Self::Press),
            "select_option" | "select" => Ok(Self::SelectOption),
            "check" => Ok(Self::Check),
            "uncheck" => Ok(Self::Uncheck),
            "upload" => Ok(Self::Upload),
            "hover" => Ok(Self::Hover),
            "drag" => Ok(Self::Drag),
            "mouse_move" => Ok(Self::MouseMove),
            "mouse_down" => Ok(Self::MouseDown),
            "mouse_up" => Ok(Self::MouseUp),
            "mouse_wheel" => Ok(Self::MouseWheel),
            "scroll" => Ok(Self::Scroll),
            "tap" => Ok(Self::Tap),
            "swipe" => Ok(Self::Swipe),
            "pinch" => Ok(Self::Pinch),
            "locator" => Ok(Self::Locator),
            "frame_locator" => Ok(Self::FrameLocator),
            "get_by_role" => Ok(Self::GetByRole),
            "get_by_text" => Ok(Self::GetByText),
            "get_by_label" => Ok(Self::GetByLabel),
            "get_by_placeholder" => Ok(Self::GetByPlaceholder),
            "get_by_test_id" => Ok(Self::GetByTestId),
            "get_by_alt_text" => Ok(Self::GetByAltText),
            "get_by_title" => Ok(Self::GetByTitle),
            "first" => Ok(Self::First),
            "last" => Ok(Self::Last),
            "nth" => Ok(Self::Nth),
            "filter" => Ok(Self::Filter),
            "all" => Ok(Self::All),
            "count" => Ok(Self::Count),
            "get_text" => Ok(Self::GetText),
            "get_inner_text" | "inner_text" => Ok(Self::GetInnerText),
            "get_attribute" | "attribute" => Ok(Self::GetAttribute),
            "get_value" | "value" => Ok(Self::GetValue),
            "get_html" | "inner_html" => Ok(Self::GetHtml),
            "get_bounding_box" | "bounding_box" => Ok(Self::GetBoundingBox),
            "is_visible" => Ok(Self::IsVisible),
            "is_enabled" => Ok(Self::IsEnabled),
            "is_checked" => Ok(Self::IsChecked),
            "is_hidden" => Ok(Self::IsHidden),
            "is_editable" => Ok(Self::IsEditable),
            "expect_visible" => Ok(Self::ExpectVisible),
            "expect_hidden" => Ok(Self::ExpectHidden),
            "expect_enabled" => Ok(Self::ExpectEnabled),
            "expect_text" => Ok(Self::ExpectText),
            "expect_value" => Ok(Self::ExpectValue),
            "expect_checked" => Ok(Self::ExpectChecked),
            "expect_url" => Ok(Self::ExpectUrl),
            "expect_title" => Ok(Self::ExpectTitle),
            "expect_count" => Ok(Self::ExpectCount),
            "expect_attribute" => Ok(Self::ExpectAttribute),
            "screenshot" | "capture" => Ok(Self::Screenshot),
            "pdf" => Ok(Self::Pdf),
            "snapshot" => Ok(Self::Snapshot),
            "evaluate" | "eval" | "js" => Ok(Self::Evaluate),
            "focus" => Ok(Self::Focus),
            "blur" => Ok(Self::Blur),
            "highlight" => Ok(Self::Highlight),
            "wait" => Ok(Self::Wait),
            "wait_for_load" | "wait_load" => Ok(Self::WaitForLoad),
            "wait_for_url" => Ok(Self::WaitForUrl),
            "wait_for_event" => Ok(Self::WaitForEvent),
            "wait_for_request" => Ok(Self::WaitForRequest),
            "wait_for_response" => Ok(Self::WaitForResponse),
            "wait_for_function" => Ok(Self::WaitForFunction),
            "viewport" => Ok(Self::Viewport),
            "emulate" => Ok(Self::Emulate),
            "geolocation" | "geo" => Ok(Self::Geolocation),
            "permissions" => Ok(Self::Permissions),
            "route" => Ok(Self::Route),
            "unroute" => Ok(Self::Unroute),
            "cookies" => Ok(Self::Cookies),
            "clear_cookies" => Ok(Self::ClearCookies),
            "storage" => Ok(Self::Storage),
            "storage_state" => Ok(Self::StorageState),
            "on" | "listen" => Ok(Self::On),
            "off" | "unlisten" => Ok(Self::Off),
            "dialog" => Ok(Self::Dialog),
            "frame" => Ok(Self::Frame),
            "main_frame" => Ok(Self::MainFrame),
            "file_chooser" => Ok(Self::FileChooser),
            "download" => Ok(Self::Download),
            "new_page" => Ok(Self::NewPage),
            "new_context" => Ok(Self::NewContext),
            "new_tab" => Ok(Self::NewTab),
            "close_tab" => Ok(Self::CloseTab),
            "tabs" => Ok(Self::Tabs),
            "connect" => Ok(Self::Connect),
            "set_headless" => Ok(Self::SetHeadless),
            "status" | "info" => Ok(Self::Status),
            "trace_start" => Ok(Self::TraceStart),
            "trace_stop" => Ok(Self::TraceStop),
            "console" => Ok(Self::Console),
            "errors" => Ok(Self::Errors),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

impl BrowserAction {
    /// Canonical wire name the driver dispatches on (matches the Python action
    /// strings one-to-one via serde snake_case).
    fn wire(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "status".to_string())
    }
}

/// Arguments for browser tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrowserToolArgs {
    #[serde(default)]
    pub action: String,
    // URL/Navigation
    pub url: Option<String>,
    pub html: Option<String>,
    // Selectors
    pub selector: Option<String>,
    #[serde(rename = "ref")]
    pub ref_: Option<String>,
    // Text/Input
    pub text: Option<String>,
    pub key: Option<String>,
    pub value: Option<Value>,
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
    // Capture output path
    pub path: Option<String>,
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
}

fn default_true() -> bool {
    true
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

/// Browser tool — drives Playwright through a persistent Node driver.
pub struct BrowserTool {
    headless: bool,
    cdp_port: u16,
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
            cdp_port: 9222,
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

    pub async fn execute(&self, args: BrowserToolArgs) -> Result<String> {
        let action: BrowserAction = if args.action.is_empty() {
            BrowserAction::Status
        } else {
            args.action.parse()?
        };

        // Local, browser-less actions.
        let result = match action {
            BrowserAction::Help => self.help(),
            BrowserAction::Status => self.status().await,
            _ => self.dispatch(action, args).await?,
        };

        Ok(serde_json::to_string(&result)?)
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

    async fn status(&self) -> Value {
        let guard = self.driver.lock().await;
        let running = guard.is_some();
        json!({
            "success": true,
            "driver_running": running,
            "headless": self.headless,
            "cdp_port": self.cdp_port,
            "cdp_endpoint": self.default_endpoint,
            "actions_available": 90,
            "categories": [
                "navigation", "input", "mouse", "touch", "locators",
                "assertions", "screen", "javascript", "wait",
                "viewport", "network", "storage", "events", "browser"
            ]
        })
    }

    fn help(&self) -> Value {
        json!({
            "name": "browser",
            "version": "0.13.0",
            "description": "Browser automation tool (HIP-0300) with a persistent Playwright driver",
            "action_count": 90,
            "categories": {
                "navigation": ["navigate", "reload", "go_back", "go_forward", "close", "set_content", "content", "url", "title"],
                "input": ["click", "dblclick", "type", "fill", "clear", "press", "select_option", "check", "uncheck", "upload"],
                "mouse": ["hover", "drag", "mouse_move", "mouse_down", "mouse_up", "mouse_wheel", "scroll"],
                "touch": ["tap", "swipe", "pinch"],
                "locators": ["locator", "frame_locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder", "get_by_test_id", "get_by_alt_text", "get_by_title"],
                "composition": ["first", "last", "nth", "filter", "all", "count"],
                "content": ["get_text", "get_inner_text", "get_attribute", "get_value", "get_html", "get_bounding_box"],
                "state": ["is_visible", "is_enabled", "is_checked", "is_hidden", "is_editable"],
                "assertions": ["expect_visible", "expect_hidden", "expect_enabled", "expect_text", "expect_value", "expect_checked", "expect_url", "expect_title", "expect_count", "expect_attribute"],
                "screen": ["screenshot", "pdf", "snapshot"],
                "javascript": ["evaluate", "focus", "blur", "highlight"],
                "wait": ["wait", "wait_for_load", "wait_for_url", "wait_for_event", "wait_for_request", "wait_for_response", "wait_for_function"],
                "viewport": ["viewport", "emulate", "geolocation", "permissions"],
                "network": ["route", "unroute"],
                "storage": ["cookies", "clear_cookies", "storage", "storage_state"],
                "events": ["on", "off", "dialog", "file_chooser", "download", "console", "errors"],
                "browser": ["new_page", "new_context", "new_tab", "close_tab", "tabs", "connect", "set_headless", "status", "trace_start", "trace_stop"]
            },
            "devices": ["mobile", "tablet", "laptop", "desktop", "iphone_14", "iphone_15_pro", "pixel_7", "ipad_pro", "galaxy_s23"]
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
  const sel = c.selector || c.ref || null;
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

/// MCP Tool Definition
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
            description: r#"Browser automation with Playwright (HIP-0300).

A persistent browser + page is kept alive across calls, so multi-step flows
(navigate -> fill -> click -> read) keep their state. Set cdp_endpoint/cdp_port
to attach to an existing browser (or the Hanzo extension CDP bridge).

90+ actions including:
- Navigation: navigate, reload, go_back, go_forward, set_content, content, url, title
- Input: click, dblclick, type, fill, clear, press, select_option, check, uncheck, upload
- Mouse: hover, drag, mouse_move/down/up, mouse_wheel, scroll
- Touch: tap, swipe, pinch
- Locators: get_by_role, get_by_text, get_by_label, get_by_placeholder, get_by_test_id
- Composition: first, last, nth, filter, all, count
- Content: get_text, get_inner_text, get_attribute, get_value, get_html, get_bounding_box
- State: is_visible/hidden/enabled/editable/checked
- Assertions: expect_visible/hidden/enabled/text/value/checked/url/title/count/attribute
- Wait: wait, wait_for_load/url/event/request/response/function
- Screen: screenshot, pdf, snapshot; JS: evaluate, focus, blur, highlight
- Device: viewport, emulate, geolocation, permissions
- Network: route (mock/block), unroute
- Storage: cookies, clear_cookies, storage, storage_state
- Events: on, off, dialog, file_chooser, download, console, errors
- Browser: new_page, new_context, new_tab, close_tab, tabs, connect, set_headless, status

Devices: mobile, tablet, laptop, desktop, iphone_14, iphone_15_pro, pixel_7, ipad_pro, galaxy_s23"#.to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {"type": "string", "description": "Browser action to perform"},
                    "url": {"type": "string", "description": "URL for navigation"},
                    "html": {"type": "string", "description": "HTML for set_content"},
                    "selector": {"type": "string", "description": "CSS/XPath selector"},
                    "ref": {"type": "string", "description": "Alias for selector"},
                    "target_selector": {"type": "string", "description": "Target selector for drag"},
                    "text": {"type": "string", "description": "Text for type/fill/get_by_*"},
                    "key": {"type": "string", "description": "Key for press"},
                    "value": {"description": "Value for select_option/assertions"},
                    "code": {"type": "string", "description": "JavaScript code for evaluate/wait_for_function"},
                    "attribute": {"type": "string", "description": "Attribute name"},
                    "expected": {"type": "string", "description": "Expected value for assertions"},
                    "role": {"type": "string", "description": "ARIA role for get_by_role"},
                    "name": {"type": "string", "description": "Accessible name for get_by_role"},
                    "exact": {"type": "boolean", "description": "Exact match for locators"},
                    "not_": {"type": "boolean", "description": "Negate an assertion"},
                    "has_text": {"type": "string", "description": "Filter: contains text"},
                    "has_not_text": {"type": "string", "description": "Filter: excludes text"},
                    "has": {"type": "string", "description": "Filter: contains nested selector"},
                    "index": {"type": "integer", "description": "Index for nth / expected count"},
                    "tab_index": {"type": "integer", "description": "Tab index for tabs/close_tab"},
                    "x": {"type": "integer", "description": "X coordinate"},
                    "y": {"type": "integer", "description": "Y coordinate"},
                    "delta_x": {"type": "integer", "description": "Scroll delta X"},
                    "delta_y": {"type": "integer", "description": "Scroll delta Y"},
                    "button": {"type": "string", "description": "Mouse button (left/right/middle)"},
                    "direction": {"type": "string", "description": "Swipe direction (up/down/left/right)"},
                    "distance": {"type": "integer", "description": "Swipe distance"},
                    "scale": {"type": "number", "description": "Pinch scale"},
                    "timeout": {"type": "integer", "description": "Timeout in ms"},
                    "full_page": {"type": "boolean", "description": "Full page screenshot"},
                    "path": {"type": "string", "description": "Output path for screenshot/pdf"},
                    "device": {"type": "string", "description": "Device to emulate"},
                    "width": {"type": "integer", "description": "Viewport width"},
                    "height": {"type": "integer", "description": "Viewport height"},
                    "latitude": {"type": "number", "description": "Geolocation latitude"},
                    "longitude": {"type": "number", "description": "Geolocation longitude"},
                    "accuracy": {"type": "number", "description": "Geolocation accuracy"},
                    "permission": {"type": "string", "description": "Permission to grant"},
                    "files": {"type": "array", "items": {"type": "string"}, "description": "Files for upload"},
                    "pattern": {"type": "string", "description": "URL/route pattern"},
                    "response": {"description": "Mock response body for route"},
                    "status_code": {"type": "integer", "description": "Mock response status"},
                    "block": {"type": "boolean", "description": "Block matching requests in route"},
                    "state": {"type": "string", "description": "Wait state / navigation wait_until"},
                    "event": {"type": "string", "description": "Event name for wait_for_event/on"},
                    "cookies": {"type": "array", "description": "Cookies to add"},
                    "storage_type": {"type": "string", "description": "local or session"},
                    "storage_data": {"type": "object", "description": "Key/value data to set"},
                    "auth_file": {"type": "string", "description": "Path for storage_state save/load"},
                    "accept": {"type": "boolean", "description": "Accept a dialog"},
                    "prompt_text": {"type": "string", "description": "Text for a prompt dialog"},
                    "level": {"type": "string", "description": "Console level filter"},
                    "frame": {"type": "string", "description": "Frame selector for scoped actions"},
                    "trace_path": {"type": "string", "description": "Output path for trace_stop"},
                    "cdp_endpoint": {"type": "string", "description": "CDP endpoint to attach to"},
                    "cdp_port": {"type": "integer", "description": "CDP port on localhost to attach to"},
                    "headless": {"type": "boolean", "description": "Headless mode"}
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

    #[tokio::test]
    async fn test_status() {
        let tool = BrowserTool::new();
        let args = BrowserToolArgs {
            action: "status".to_string(),
            ..Default::default()
        };
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        assert!(result.unwrap().contains("headless"));
    }

    #[tokio::test]
    async fn test_help() {
        let tool = BrowserTool::new();
        let args = BrowserToolArgs {
            action: "help".to_string(),
            ..Default::default()
        };
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("browser"));
        assert!(output.contains("navigation"));
    }

    #[test]
    fn test_action_wire_names() {
        assert_eq!(BrowserAction::GoBack.wire(), "go_back");
        assert_eq!(BrowserAction::GetByTestId.wire(), "get_by_test_id");
        assert_eq!(BrowserAction::ExpectVisible.wire(), "expect_visible");
        assert_eq!(BrowserAction::MouseWheel.wire(), "mouse_wheel");
        assert_eq!(BrowserAction::SelectOption.wire(), "select_option");
    }

    #[test]
    fn test_action_aliases() {
        assert_eq!("goto".parse::<BrowserAction>().unwrap(), BrowserAction::Navigate);
        assert_eq!("double_click".parse::<BrowserAction>().unwrap(), BrowserAction::Dblclick);
        assert_eq!("press_key".parse::<BrowserAction>().unwrap(), BrowserAction::Press);
        assert_eq!("all".parse::<BrowserAction>().unwrap(), BrowserAction::All);
        assert!("bogus_action".parse::<BrowserAction>().is_err());
    }
}
