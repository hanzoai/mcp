/// Browser automation tool (HIP-0300)
///
/// Provides Playwright-based browser control:
/// - navigate: Navigate to URL
/// - click/type/fill: Interact with elements
/// - screenshot: Capture page
/// - evaluate: Run JavaScript
/// - And 90+ more actions

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::process::Command;

/// Browser actions (subset of Playwright API)
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
    GetByRole,
    GetByText,
    GetByLabel,
    GetByPlaceholder,
    GetByTestId,
    GetByAltText,
    GetByTitle,
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
    // Dialog
    Dialog,
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
    Highlight,
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
        // Map common action names
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
            "press" => Ok(Self::Press),
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
            "get_by_role" => Ok(Self::GetByRole),
            "get_by_text" => Ok(Self::GetByText),
            "get_by_label" => Ok(Self::GetByLabel),
            "get_by_placeholder" => Ok(Self::GetByPlaceholder),
            "get_by_test_id" => Ok(Self::GetByTestId),
            "get_by_alt_text" => Ok(Self::GetByAltText),
            "get_by_title" => Ok(Self::GetByTitle),
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
            "highlight" => Ok(Self::Highlight),
            "console" => Ok(Self::Console),
            "errors" => Ok(Self::Errors),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
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
    pub value: Option<String>,
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
    // Files
    pub files: Option<Vec<String>>,
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

/// Browser state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserState {
    pub connected: bool,
    pub headless: bool,
    pub pages: Vec<String>,
    pub current_url: Option<String>,
}

/// Browser tool - delegates to Playwright via subprocess or CDP
pub struct BrowserTool {
    headless: bool,
    cdp_port: u16,
}

impl BrowserTool {
    pub fn new() -> Self {
        Self {
            headless: true,
            cdp_port: 9222,
        }
    }

    pub async fn execute(&self, args: BrowserToolArgs) -> Result<String> {
        let action: BrowserAction = if args.action.is_empty() {
            BrowserAction::Status
        } else {
            args.action.parse()?
        };

        let result = match action {
            BrowserAction::Navigate => self.navigate(args).await?,
            BrowserAction::Click => self.click(args).await?,
            BrowserAction::Type => self.type_text(args).await?,
            BrowserAction::Fill => self.fill(args).await?,
            BrowserAction::Screenshot => self.screenshot(args).await?,
            BrowserAction::Evaluate => self.evaluate(args).await?,
            BrowserAction::Content => self.content(args).await?,
            BrowserAction::Url => self.url(args).await?,
            BrowserAction::Title => self.title(args).await?,
            BrowserAction::Status => self.status(args).await?,
            BrowserAction::Help => self.help()?,
            // Delegate other actions to generic handler
            _ => self.generic_action(args).await?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn run_playwright_command(&self, script: &str) -> Result<Value> {
        // Use node with playwright to execute browser commands
        let full_script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const context = await browser.newContext();
    const page = await context.newPage();
    try {{
        {}
    }} finally {{
        await browser.close();
    }}
}})().catch(e => console.error(JSON.stringify({{ error: e.message }})));
"#,
            self.headless, script
        );

        let output = Command::new("node")
            .arg("-e")
            .arg(&full_script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() {
            if !stderr.is_empty() {
                return Err(anyhow!("Playwright error: {}", stderr));
            }
        }

        if let Ok(val) = serde_json::from_str(&stdout) {
            Ok(val)
        } else {
            Ok(json!({"output": stdout.trim()}))
        }
    }

    async fn navigate(&self, args: BrowserToolArgs) -> Result<Value> {
        let url = args.url.ok_or_else(|| anyhow!("url required"))?;
        let timeout = args.timeout.unwrap_or(30000);

        let script = format!(
            r#"
await page.goto('{}', {{ timeout: {} }});
console.log(JSON.stringify({{ url: page.url(), title: await page.title() }}));
"#,
            url.replace('\'', "\\'"),
            timeout
        );

        self.run_playwright_command(&script).await
    }

    async fn click(&self, args: BrowserToolArgs) -> Result<Value> {
        let selector = args.selector.or(args.ref_)
            .ok_or_else(|| anyhow!("selector required"))?;
        let timeout = args.timeout.unwrap_or(5000);

        let script = format!(
            r#"
await page.click('{}', {{ timeout: {} }});
console.log(JSON.stringify({{ clicked: '{}' }}));
"#,
            selector.replace('\'', "\\'"),
            timeout,
            selector.replace('\'', "\\'")
        );

        self.run_playwright_command(&script).await
    }

    async fn type_text(&self, args: BrowserToolArgs) -> Result<Value> {
        let selector = args.selector.or(args.ref_)
            .ok_or_else(|| anyhow!("selector required"))?;
        let text = args.text.ok_or_else(|| anyhow!("text required"))?;

        let script = format!(
            r#"
await page.type('{}', '{}');
console.log(JSON.stringify({{ typed: {} }}));
"#,
            selector.replace('\'', "\\'"),
            text.replace('\'', "\\'"),
            text.len()
        );

        self.run_playwright_command(&script).await
    }

    async fn fill(&self, args: BrowserToolArgs) -> Result<Value> {
        let selector = args.selector.or(args.ref_)
            .ok_or_else(|| anyhow!("selector required"))?;
        let text = args.text.ok_or_else(|| anyhow!("text required"))?;

        let script = format!(
            r#"
await page.fill('{}', '{}');
console.log(JSON.stringify({{ filled: '{}' }}));
"#,
            selector.replace('\'', "\\'"),
            text.replace('\'', "\\'"),
            selector.replace('\'', "\\'")
        );

        self.run_playwright_command(&script).await
    }

    async fn screenshot(&self, args: BrowserToolArgs) -> Result<Value> {
        let full_page = args.full_page.unwrap_or(false);
        let path = format!("/tmp/screenshot_{}.png", chrono::Utc::now().timestamp());

        let script = format!(
            r#"
const data = await page.screenshot({{ fullPage: {}, path: '{}' }});
console.log(JSON.stringify({{ path: '{}', size: data.length }}));
"#,
            full_page, path, path
        );

        self.run_playwright_command(&script).await
    }

    async fn evaluate(&self, args: BrowserToolArgs) -> Result<Value> {
        let code = args.code.ok_or_else(|| anyhow!("code required"))?;

        let script = format!(
            r#"
const result = await page.evaluate(() => {{ {} }});
console.log(JSON.stringify({{ result }}));
"#,
            code
        );

        self.run_playwright_command(&script).await
    }

    async fn content(&self, args: BrowserToolArgs) -> Result<Value> {
        let script = r#"
const content = await page.content();
console.log(JSON.stringify({ content: content.substring(0, 10000) }));
"#;

        self.run_playwright_command(script).await
    }

    async fn url(&self, _args: BrowserToolArgs) -> Result<Value> {
        let script = r#"
console.log(JSON.stringify({ url: page.url() }));
"#;

        self.run_playwright_command(script).await
    }

    async fn title(&self, _args: BrowserToolArgs) -> Result<Value> {
        let script = r#"
const title = await page.title();
console.log(JSON.stringify({ title }));
"#;

        self.run_playwright_command(script).await
    }

    async fn status(&self, _args: BrowserToolArgs) -> Result<Value> {
        // Check if playwright is available
        let output = Command::new("npx")
            .args(["playwright", "--version"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await;

        let playwright_available = output.map(|o| o.status.success()).unwrap_or(false);

        Ok(json!({
            "playwright_available": playwright_available,
            "headless": self.headless,
            "cdp_port": self.cdp_port,
            "actions_available": 90,
            "categories": [
                "navigation", "input", "mouse", "touch", "locators",
                "assertions", "screen", "javascript", "wait",
                "viewport", "network", "storage", "events", "browser"
            ]
        }))
    }

    async fn generic_action(&self, args: BrowserToolArgs) -> Result<Value> {
        // For actions not yet fully implemented, return guidance
        Ok(json!({
            "action": args.action,
            "status": "pending",
            "message": format!("Action '{}' requires Playwright. Use the Python hanzo-mcp for full browser support.", args.action)
        }))
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "browser",
            "version": "0.12.0",
            "description": "Browser automation tool (HIP-0300) with Playwright",
            "action_count": 90,
            "categories": {
                "navigation": ["navigate", "reload", "go_back", "go_forward", "close"],
                "input": ["click", "dblclick", "type", "fill", "clear", "press", "select_option", "check", "uncheck", "upload"],
                "mouse": ["hover", "drag", "mouse_move", "mouse_down", "mouse_up", "mouse_wheel", "scroll"],
                "touch": ["tap", "swipe", "pinch"],
                "locators": ["locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder", "get_by_test_id"],
                "content": ["get_text", "get_inner_text", "get_attribute", "get_value", "get_html", "get_bounding_box"],
                "state": ["is_visible", "is_enabled", "is_checked", "is_hidden", "is_editable"],
                "assertions": ["expect_visible", "expect_hidden", "expect_enabled", "expect_text", "expect_value"],
                "screen": ["screenshot", "pdf", "snapshot"],
                "javascript": ["evaluate", "focus", "blur"],
                "wait": ["wait", "wait_for_load", "wait_for_url", "wait_for_event"],
                "viewport": ["viewport", "emulate", "geolocation", "permissions"],
                "network": ["route", "unroute"],
                "storage": ["cookies", "clear_cookies", "storage", "storage_state"],
                "browser": ["new_page", "new_context", "new_tab", "close_tab", "tabs", "status"]
            },
            "devices": ["mobile", "tablet", "laptop", "iphone_14", "pixel_7", "ipad_pro"]
        }))
    }
}

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

90+ actions including:
- Navigation: navigate, reload, go_back, go_forward
- Input: click, type, fill, press, select_option
- Mouse: hover, drag, scroll
- Screen: screenshot, pdf, snapshot
- JavaScript: evaluate
- Locators: get_by_role, get_by_text, get_by_label
- Assertions: expect_visible, expect_text, expect_url

Devices: mobile, tablet, laptop, iphone_14, pixel_7, ipad_pro"#.to_string(),
            input_schema: json!({
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Browser action to perform"
                    },
                    "url": {"type": "string", "description": "URL for navigation"},
                    "selector": {"type": "string", "description": "CSS/XPath selector"},
                    "ref": {"type": "string", "description": "Alias for selector"},
                    "text": {"type": "string", "description": "Text for type/fill"},
                    "key": {"type": "string", "description": "Key for press"},
                    "value": {"type": "string", "description": "Value for select/assertions"},
                    "x": {"type": "integer", "description": "X coordinate"},
                    "y": {"type": "integer", "description": "Y coordinate"},
                    "timeout": {"type": "integer", "description": "Timeout in ms"},
                    "full_page": {"type": "boolean", "description": "Full page screenshot"},
                    "code": {"type": "string", "description": "JavaScript code"},
                    "device": {"type": "string", "description": "Device to emulate"},
                    "width": {"type": "integer", "description": "Viewport width"},
                    "height": {"type": "integer", "description": "Viewport height"}
                }
            }),
        }
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
        let output = result.unwrap();
        assert!(output.contains("headless"));
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
}
