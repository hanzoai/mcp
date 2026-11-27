/// Unified UI control tool for HIP-0300 architecture
///
/// Cross-platform native API support:
/// - macOS: Quartz/CoreGraphics (fastest)
/// - Linux: X11
/// - Windows: winapi
///
/// Performance targets (native mode):
/// - Click: <5ms
/// - Keypress: <2ms
/// - Screenshot: <50ms

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

pub mod health;
pub mod mac_apps;

#[cfg(target_os = "macos")]
pub(crate) mod macos;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "windows")]
mod windows;

const DEFAULT_OP_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_SLOW_OP_TIMEOUT_MS: u64 = 30_000;

/// Platform-independent action types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum UiAction {
    // Mouse
    Click,
    DoubleClick,
    RightClick,
    MiddleClick,
    Move,
    MoveRelative,
    Drag,
    DragRelative,
    Scroll,
    // Keyboard
    Type,
    Write,
    Press,
    KeyDown,
    KeyUp,
    Hotkey,
    // Screen
    Screenshot,
    ScreenshotRegion,
    GetPixel,
    // Window & App
    GetActiveWindow,
    ListWindows,
    FocusWindow,
    MinimizeWindow,
    MaximizeWindow,
    ResizeWindow,
    MoveWindow,
    CloseWindow,
    OpenApp,
    // Screen info
    GetScreens,
    ScreenSize,
    Position,
    // Health & macOS native apps
    Health,
    MacCalendar,
    MacReminders,
    MacNotes,
    MacMailDraft,
    MacContacts,
    MacShortcuts,
    // Settings
    Sleep,
    SetPause,
    SetFailsafe,
    // Batch
    Batch,
    // Info
    Info,
}

impl Default for UiAction {
    fn default() -> Self {
        Self::Info
    }
}

impl std::str::FromStr for UiAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "click" => Ok(Self::Click),
            "double_click" | "doubleclick" => Ok(Self::DoubleClick),
            "right_click" | "rightclick" => Ok(Self::RightClick),
            "middle_click" | "middleclick" => Ok(Self::MiddleClick),
            "move" => Ok(Self::Move),
            "move_relative" | "moverelative" => Ok(Self::MoveRelative),
            "drag" => Ok(Self::Drag),
            "drag_relative" | "dragrelative" => Ok(Self::DragRelative),
            "scroll" => Ok(Self::Scroll),
            "type" => Ok(Self::Type),
            "write" => Ok(Self::Write),
            "press" => Ok(Self::Press),
            "key_down" | "keydown" => Ok(Self::KeyDown),
            "key_up" | "keyup" => Ok(Self::KeyUp),
            "hotkey" => Ok(Self::Hotkey),
            "screenshot" => Ok(Self::Screenshot),
            "screenshot_region" | "screenshotregion" => Ok(Self::ScreenshotRegion),
            "get_pixel" | "getpixel" | "pixel" => Ok(Self::GetPixel),
            "get_active_window" | "getactivewindow" => Ok(Self::GetActiveWindow),
            "list_windows" | "listwindows" => Ok(Self::ListWindows),
            "focus_window" | "focuswindow" => Ok(Self::FocusWindow),
            "minimize_window" | "minimizewindow" => Ok(Self::MinimizeWindow),
            "maximize_window" | "maximizewindow" => Ok(Self::MaximizeWindow),
            "resize_window" | "resizewindow" => Ok(Self::ResizeWindow),
            "move_window" | "movewindow" => Ok(Self::MoveWindow),
            "close_window" | "closewindow" => Ok(Self::CloseWindow),
            "open_app" | "openapp" | "launch_app" => Ok(Self::OpenApp),
            "get_screens" | "getscreens" => Ok(Self::GetScreens),
            "screen_size" | "screensize" => Ok(Self::ScreenSize),
            "position" => Ok(Self::Position),
            "health" => Ok(Self::Health),
            "mac_calendar" | "calendar" => Ok(Self::MacCalendar),
            "mac_reminders" | "reminders" => Ok(Self::MacReminders),
            "mac_notes" | "notes" => Ok(Self::MacNotes),
            "mac_mail_draft" | "mail_draft" => Ok(Self::MacMailDraft),
            "mac_contacts" | "contacts" => Ok(Self::MacContacts),
            "mac_shortcuts" | "shortcuts" => Ok(Self::MacShortcuts),
            "sleep" => Ok(Self::Sleep),
            "set_pause" | "setpause" => Ok(Self::SetPause),
            "set_failsafe" | "setfailsafe" => Ok(Self::SetFailsafe),
            "batch" => Ok(Self::Batch),
            "info" => Ok(Self::Info),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Arguments for UI tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ComputerToolArgs {
    #[serde(default)]
    pub action: String,
    // Coordinates
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub start_x: Option<i32>,
    pub start_y: Option<i32>,
    pub dx: Option<i32>,
    pub dy: Option<i32>,
    pub end_x: Option<i32>,
    pub end_y: Option<i32>,
    // Text/keys
    pub text: Option<String>,
    pub key: Option<String>,
    pub keys: Option<Vec<String>>,
    // Options
    #[serde(default = "default_button")]
    pub button: String,
    pub amount: Option<i32>,
    #[serde(default = "default_duration")]
    pub duration: f64,
    #[serde(default = "default_interval")]
    pub interval: f64,
    pub region: Option<Vec<i32>>,
    #[serde(default)]
    pub clear: bool,
    // Window / App
    pub title: Option<String>,
    pub app: Option<String>,
    // Name (for screenshot file or shortcut)
    pub name: Option<String>,
    // Width/height
    pub width: Option<i32>,
    pub height: Option<i32>,
    // Value for settings
    pub value: Option<f64>,
    // macOS native app connector fields
    pub op: Option<String>,
    pub query: Option<String>,
    pub calendar: Option<String>,
    pub list: Option<String>,
    pub folder: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub to: Option<String>,
    pub cc: Option<String>,
    pub days: Option<i32>,
    pub limit: Option<usize>,
    // Bounded execution timeout (ms)
    pub timeout_ms: Option<u64>,
    // Batch
    pub actions: Option<Vec<Value>>,
}

fn default_button() -> String {
    "left".to_string()
}

fn default_duration() -> f64 {
    0.25
}

fn default_interval() -> f64 {
    0.02
}

/// Window information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub app: Option<String>,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Platform capabilities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    pub platform: String,
    pub native_available: bool,
    pub backends: HashMap<String, bool>,
}

/// Native control trait - implemented per platform
/// Aligned with TypeScript AutoGUIAdapter interface
pub trait NativeControl: Send + Sync {
    // Configuration
    /// Get platform info
    fn platform_info(&self) -> PlatformInfo;

    // Screen Information
    /// Get mouse position
    fn mouse_position(&self) -> Result<(i32, i32)>;

    /// Get screen size
    fn screen_size(&self) -> Result<(i32, i32)>;

    // Mouse Control
    /// Click at position
    fn click(&self, x: i32, y: i32, button: &str) -> Result<()>;

    /// Double click
    fn double_click(&self, x: i32, y: i32) -> Result<()>;

    /// Move mouse
    fn move_to(&self, x: i32, y: i32) -> Result<()>;

    /// Drag from current to target
    fn drag(&self, start_x: i32, start_y: i32, end_x: i32, end_y: i32, button: &str) -> Result<()>;

    /// Scroll
    fn scroll(&self, amount: i32, x: Option<i32>, y: Option<i32>) -> Result<()>;

    // Keyboard Control
    /// Press key down
    fn key_down(&self, key: &str) -> Result<()>;

    /// Release key
    fn key_up(&self, key: &str) -> Result<()>;

    /// Press and release key
    fn press(&self, key: &str) -> Result<()>;

    /// Press key combination
    fn hotkey(&self, keys: &[String]) -> Result<()>;

    /// Type character
    fn type_char(&self, c: char) -> Result<()>;

    /// Type text
    fn type_text(&self, text: &str, interval: f64) -> Result<()>;

    // Screen Capture
    /// Take screenshot
    fn screenshot(&self, region: Option<&[i32]>) -> Result<Vec<u8>>;

    /// Get pixel color at position
    fn get_pixel(&self, x: i32, y: i32) -> Result<(u8, u8, u8)>;

    // Window Management
    /// Get active window
    fn get_active_window(&self) -> Result<WindowInfo>;

    /// List all windows
    fn list_windows(&self) -> Result<Vec<WindowInfo>>;

    /// Focus/activate window by title
    fn focus_window(&self, title: &str) -> Result<bool>;

    /// Minimize window by title
    fn minimize_window(&self, title: &str) -> Result<bool>;

    /// Maximize window by title
    fn maximize_window(&self, title: &str) -> Result<bool>;

    /// Resize window by title
    fn resize_window(&self, title: &str, width: i32, height: i32) -> Result<bool>;

    /// Move window by title
    fn move_window(&self, title: &str, x: i32, y: i32) -> Result<bool>;

    /// Close window by title
    fn close_window(&self, title: &str) -> Result<bool>;

    /// Launch or activate an application by name or bundle ID
    fn open_app(&self, app: &str) -> Result<bool>;
}

/// Probe native computer control platform capabilities for diagnostics (`hanzo-mcp doctor`).
pub fn probe_capabilities() -> (PlatformInfo, Option<(i32, i32)>) {
    let ctrl = get_native_control();
    let info = ctrl.platform_info();
    let size = ctrl.screen_size().ok();
    (info, size)
}

/// Resolve drag start and end coordinates cleanly:
/// - If `start_x/start_y` + `end_x/end_y` are set: explicit start -> end.
/// - If `x/y` + `end_x/end_y` are set: explicit `(x, y)` -> `(end_x, end_y)`.
/// - Otherwise: current cursor position -> `(end_x/x, end_y/y)`.
pub(crate) fn resolve_drag_coords(
    x: Option<i32>,
    y: Option<i32>,
    start_x: Option<i32>,
    start_y: Option<i32>,
    end_x: Option<i32>,
    end_y: Option<i32>,
    current: (i32, i32),
) -> Result<((i32, i32), (i32, i32))> {
    if let (Some(sx), Some(sy), Some(ex), Some(ey)) = (start_x, start_y, end_x, end_y) {
        return Ok(((sx, sy), (ex, ey)));
    }
    if let (Some(sx), Some(sy), Some(ex), Some(ey)) = (x, y, end_x, end_y) {
        return Ok(((sx, sy), (ex, ey)));
    }
    let ex = end_x.or(x).ok_or_else(|| anyhow!("end_x or x required for drag"))?;
    let ey = end_y.or(y).ok_or_else(|| anyhow!("end_y or y required for drag"))?;
    let sx = start_x.unwrap_or(current.0);
    let sy = start_y.unwrap_or(current.1);
    Ok(((sx, sy), (ex, ey)))
}

async fn run_blocking<T, F>(timeout_ms: u64, f: F) -> Result<Option<T>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms.clamp(500, 120_000)),
        tokio::task::spawn_blocking(f),
    )
    .await
    {
        Ok(joined) => Ok(Some(joined??)),
        Err(_) => Ok(None),
    }
}

/// Get the native control implementation for current platform
fn get_native_control() -> Box<dyn NativeControl> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOSControl::new())
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxControl::new())
    }

    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsControl::new())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        panic!("Unsupported platform");
    }
}

/// UI Tool implementation
pub struct ComputerTool {
    control: Arc<dyn NativeControl>,
    defined_regions: HashMap<String, (i32, i32, i32, i32)>,
    pause: f64,
    failsafe: bool,
}

impl ComputerTool {
    pub fn new() -> Self {
        Self {
            control: Arc::from(get_native_control()),
            defined_regions: HashMap::new(),
            pause: 0.1,
            failsafe: true,
        }
    }

    pub async fn execute(&mut self, args: ComputerToolArgs) -> Result<String> {
        let action: UiAction = if args.action.is_empty() {
            UiAction::Info
        } else {
            args.action.parse()?
        };

        // Clone Arc for use in spawn_blocking closures
        let ctrl = Arc::clone(&self.control);

        let result = match action {
            // Fast native operations - no spawn_blocking needed
            UiAction::Click => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                let button = args.button.clone();
                tokio::task::spawn_blocking(move || ctrl.click(x, y, &button)).await??;
                json!({"success": true, "clicked": [x, y], "button": args.button})
            }

            UiAction::DoubleClick => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                // Double click has internal sleep - must use spawn_blocking
                tokio::task::spawn_blocking(move || ctrl.double_click(x, y)).await??;
                json!({"success": true, "double_clicked": [x, y]})
            }

            UiAction::RightClick => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                tokio::task::spawn_blocking(move || ctrl.click(x, y, "right")).await??;
                json!({"success": true, "right_clicked": [x, y]})
            }

            UiAction::MiddleClick => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                tokio::task::spawn_blocking(move || ctrl.click(x, y, "middle")).await??;
                json!({"success": true, "middle_clicked": [x, y]})
            }

            UiAction::Move => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                tokio::task::spawn_blocking(move || ctrl.move_to(x, y)).await??;
                json!({"success": true, "moved_to": [x, y]})
            }

            UiAction::MoveRelative => {
                let dx = args.dx.ok_or_else(|| anyhow!("dx required"))?;
                let dy = args.dy.ok_or_else(|| anyhow!("dy required"))?;
                // mouse_position uses osascript on macOS - blocking
                let (cx, cy) = tokio::task::spawn_blocking({
                    let ctrl = Arc::clone(&ctrl);
                    move || ctrl.mouse_position()
                }).await??;
                tokio::task::spawn_blocking(move || ctrl.move_to(cx + dx, cy + dy)).await??;
                json!({"success": true, "moved_by": [dx, dy]})
            }

            UiAction::Drag => {
                let current = if (args.start_x.is_some() && args.start_y.is_some() && args.end_x.is_some() && args.end_y.is_some())
                    || (args.x.is_some() && args.y.is_some() && args.end_x.is_some() && args.end_y.is_some())
                {
                    (0, 0)
                } else {
                    tokio::task::spawn_blocking({
                        let ctrl = Arc::clone(&ctrl);
                        move || ctrl.mouse_position()
                    })
                    .await??
                };
                let ((start_x, start_y), (end_x, end_y)) = resolve_drag_coords(
                    args.x,
                    args.y,
                    args.start_x,
                    args.start_y,
                    args.end_x,
                    args.end_y,
                    current,
                )?;
                let button = args.button.clone();
                let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_OP_TIMEOUT_MS);
                match run_blocking(timeout_ms, move || {
                    ctrl.drag(start_x, start_y, end_x, end_y, &button)
                })
                .await?
                {
                    Some(()) => json!({
                        "success": true,
                        "dragged_from": [start_x, start_y],
                        "dragged_to": [end_x, end_y],
                        "button": args.button
                    }),
                    None => json!({
                        "success": false,
                        "outcome_unknown": true,
                        "timed_out": true,
                        "error": format!("drag timed out after {timeout_ms}ms")
                    }),
                }
            }

            UiAction::DragRelative => {
                let dx = args.dx.ok_or_else(|| anyhow!("dx required"))?;
                let dy = args.dy.ok_or_else(|| anyhow!("dy required"))?;
                let (cx, cy) = tokio::task::spawn_blocking({
                    let ctrl = Arc::clone(&ctrl);
                    move || ctrl.mouse_position()
                }).await??;
                let button = args.button.clone();
                tokio::task::spawn_blocking(move || {
                    ctrl.drag(cx, cy, cx + dx, cy + dy, &button)
                }).await??;
                json!({"success": true, "dragged_by": [dx, dy]})
            }

            UiAction::Scroll => {
                let amount = args.amount.ok_or_else(|| anyhow!("amount required"))?;
                let x = args.x;
                let y = args.y;
                tokio::task::spawn_blocking(move || ctrl.scroll(amount, x, y)).await??;
                json!({"success": true, "scrolled": amount})
            }

            UiAction::Type => {
                let text = args.text.ok_or_else(|| anyhow!("text required"))?;
                let len = text.len();
                let interval = args.interval;
                // type_text has internal sleeps - must use spawn_blocking
                tokio::task::spawn_blocking(move || ctrl.type_text(&text, interval)).await??;
                json!({"success": true, "typed": len})
            }

            UiAction::Write => {
                let text = args.text.ok_or_else(|| anyhow!("text required"))?;
                let len = text.len();
                if args.clear {
                    // Select all and clear
                    #[cfg(target_os = "macos")]
                    let keys = vec!["command".to_string(), "a".to_string()];
                    #[cfg(not(target_os = "macos"))]
                    let keys = vec!["ctrl".to_string(), "a".to_string()];
                    tokio::task::spawn_blocking({
                        let ctrl = Arc::clone(&ctrl);
                        move || ctrl.hotkey(&keys)
                    }).await??;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                let interval = args.interval;
                tokio::task::spawn_blocking(move || ctrl.type_text(&text, interval)).await??;
                json!({"success": true, "wrote": len, "cleared": args.clear})
            }

            UiAction::Press => {
                let key = args.key.ok_or_else(|| anyhow!("key required"))?;
                let key_clone = key.clone();
                tokio::task::spawn_blocking(move || ctrl.press(&key_clone)).await??;
                json!({"success": true, "pressed": key})
            }

            UiAction::KeyDown => {
                let key = args.key.ok_or_else(|| anyhow!("key required"))?;
                let key_clone = key.clone();
                tokio::task::spawn_blocking(move || ctrl.key_down(&key_clone)).await??;
                json!({"success": true, "key_down": key})
            }

            UiAction::KeyUp => {
                let key = args.key.ok_or_else(|| anyhow!("key required"))?;
                let key_clone = key.clone();
                tokio::task::spawn_blocking(move || ctrl.key_up(&key_clone)).await??;
                json!({"success": true, "key_up": key})
            }

            UiAction::Hotkey => {
                let keys = args.keys.ok_or_else(|| anyhow!("keys required"))?;
                let combo = keys.join("+");
                tokio::task::spawn_blocking(move || ctrl.hotkey(&keys)).await??;
                json!({"success": true, "hotkey": combo})
            }

            UiAction::Screenshot | UiAction::ScreenshotRegion => {
                let region: Option<Vec<i32>> = args.region.clone();
                // Screenshot uses subprocess - must use spawn_blocking
                let data = tokio::task::spawn_blocking(move || {
                    ctrl.screenshot(region.as_deref())
                }).await??;

                // If name provided, save to file
                if let Some(name) = args.name {
                    let path = if name.starts_with('/') || name.starts_with('~') {
                        shellexpand::tilde(&name).to_string()
                    } else {
                        format!("{}/{}", std::env::temp_dir().display(), name)
                    };
                    let path = if !path.ends_with(".png") {
                        format!("{}.png", path)
                    } else {
                        path
                    };
                    // Async file write
                    tokio::fs::write(&path, &data).await?;
                    json!({
                        "success": true,
                        "format": "png",
                        "size": data.len(),
                        "path": path
                    })
                } else {
                    use base64::{Engine, engine::general_purpose::STANDARD};
                    let b64 = STANDARD.encode(&data);
                    json!({
                        "success": true,
                        "format": "png",
                        "size": data.len(),
                        "base64": b64
                    })
                }
            }

            UiAction::GetActiveWindow => {
                // Uses osascript/xdotool - must use spawn_blocking
                let info = tokio::task::spawn_blocking(move || {
                    ctrl.get_active_window()
                }).await??;
                json!(info)
            }

            UiAction::ListWindows => {
                // Uses osascript/xdotool - must use spawn_blocking
                let windows = tokio::task::spawn_blocking(move || {
                    ctrl.list_windows()
                }).await??;
                json!({"windows": windows, "count": windows.len()})
            }

            UiAction::FocusWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let title_clone = title.clone();
                let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_OP_TIMEOUT_MS);
                match run_blocking(timeout_ms, move || ctrl.focus_window(&title_clone)).await? {
                    Some(success) => json!({"success": success, "focused": title}),
                    None => json!({"success": false, "outcome_unknown": true, "timed_out": true, "error": format!("focus_window timed out after {timeout_ms}ms")}),
                }
            }

            UiAction::MinimizeWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let title_clone = title.clone();
                let success = tokio::task::spawn_blocking(move || ctrl.minimize_window(&title_clone)).await??;
                json!({"success": success, "minimized": title})
            }

            UiAction::MaximizeWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let title_clone = title.clone();
                let success = tokio::task::spawn_blocking(move || ctrl.maximize_window(&title_clone)).await??;
                json!({"success": success, "maximized": title})
            }

            UiAction::ResizeWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let width = args.width.ok_or_else(|| anyhow!("width required"))?;
                let height = args.height.ok_or_else(|| anyhow!("height required"))?;
                let title_clone = title.clone();
                let success = tokio::task::spawn_blocking(move || ctrl.resize_window(&title_clone, width, height)).await??;
                json!({"success": success, "resized": title, "width": width, "height": height})
            }

            UiAction::MoveWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                let title_clone = title.clone();
                let success = tokio::task::spawn_blocking(move || ctrl.move_window(&title_clone, x, y)).await??;
                json!({"success": success, "moved": title, "x": x, "y": y})
            }

            UiAction::CloseWindow => {
                let title = args.title.or(args.app).or(args.text).ok_or_else(|| anyhow!("title required"))?;
                let title_clone = title.clone();
                let success = tokio::task::spawn_blocking(move || ctrl.close_window(&title_clone)).await??;
                json!({"success": success, "closed": title})
            }

            UiAction::OpenApp => {
                let app = args.app.or(args.title).or(args.name).or(args.text)
                    .ok_or_else(|| anyhow!("app (name or bundle ID) required"))?;
                let app_clone = app.clone();
                let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_OP_TIMEOUT_MS);
                match run_blocking(timeout_ms, move || ctrl.open_app(&app_clone)).await? {
                    Some(success) => json!({"success": success, "opened": app}),
                    None => json!({"success": false, "outcome_unknown": true, "timed_out": true, "error": format!("open_app timed out after {timeout_ms}ms")}),
                }
            }

            UiAction::GetPixel => {
                let x = args.x.ok_or_else(|| anyhow!("x required"))?;
                let y = args.y.ok_or_else(|| anyhow!("y required"))?;
                let (r, g, b) = tokio::task::spawn_blocking(move || ctrl.get_pixel(x, y)).await??;
                json!({"success": true, "x": x, "y": y, "rgb": [r, g, b], "hex": format!("#{:02x}{:02x}{:02x}", r, g, b)})
            }

            UiAction::Health => {
                let reap = args.clear;
                let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_OP_TIMEOUT_MS);
                match run_blocking(timeout_ms, move || {
                    let front = ctrl.get_active_window().ok().and_then(|w| w.app);
                    Ok(health::run_health(front.as_deref(), reap))
                })
                .await?
                {
                    Some(v) => v,
                    None => json!({"success": false, "outcome_unknown": true, "timed_out": true, "error": format!("health probe timed out after {timeout_ms}ms")}),
                }
            }

            UiAction::MacCalendar
            | UiAction::MacReminders
            | UiAction::MacNotes
            | UiAction::MacMailDraft
            | UiAction::MacContacts
            | UiAction::MacShortcuts => {
                let kind = match action {
                    UiAction::MacCalendar => "mac_calendar",
                    UiAction::MacReminders => "mac_reminders",
                    UiAction::MacNotes => "mac_notes",
                    UiAction::MacMailDraft => "mac_mail_draft",
                    UiAction::MacContacts => "mac_contacts",
                    UiAction::MacShortcuts => "mac_shortcuts",
                    _ => unreachable!(),
                };
                let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_SLOW_OP_TIMEOUT_MS);
                let op = args.op.unwrap_or_default();
                let title = args.title;
                let text = args.text;
                let name = args.name;
                let query = args.query;
                let calendar = args.calendar;
                let list = args.list;
                let folder = args.folder;
                let start = args.start;
                let end = args.end;
                let to = args.to;
                let cc = args.cc;
                let days = args.days.unwrap_or(7);
                let limit = args.limit.unwrap_or(50);
                match run_blocking(timeout_ms, move || {
                    let req = mac_apps::MacAppRequest {
                        op: &op,
                        title: title.as_deref(),
                        text: text.as_deref(),
                        name: name.as_deref(),
                        query: query.as_deref(),
                        calendar: calendar.as_deref(),
                        list: list.as_deref(),
                        folder: folder.as_deref(),
                        start: start.as_deref(),
                        end: end.as_deref(),
                        to: to.as_deref(),
                        cc: cc.as_deref(),
                        days,
                        limit,
                    };
                    mac_apps::dispatch(kind, &req)
                })
                .await?
                {
                    Some(v) => v,
                    None => json!({
                        "success": false,
                        "outcome_unknown": true,
                        "timed_out": true,
                        "error": format!("{kind} timed out after {timeout_ms}ms (check macOS Automation permission)")
                    }),
                }
            }

            UiAction::GetScreens => {
                // screen_size is fast native call, but wrap for consistency
                let (w, h) = tokio::task::spawn_blocking(move || {
                    ctrl.screen_size()
                }).await??;
                json!([{"name": "Primary", "resolution": format!("{}x{}", w, h), "main": true}])
            }

            UiAction::ScreenSize => {
                let (w, h) = tokio::task::spawn_blocking(move || {
                    ctrl.screen_size()
                }).await??;
                json!({"width": w, "height": h})
            }

            UiAction::Position => {
                // mouse_position uses osascript on macOS - must use spawn_blocking
                let (x, y) = tokio::task::spawn_blocking(move || {
                    ctrl.mouse_position()
                }).await??;
                json!({"x": x, "y": y})
            }

            UiAction::Sleep => {
                let secs = args.value.ok_or_else(|| anyhow!("value required"))?;
                // Use async sleep - does not block runtime
                tokio::time::sleep(std::time::Duration::from_secs_f64(secs)).await;
                json!({"success": true, "slept": secs})
            }

            UiAction::SetPause => {
                let val = args.value.ok_or_else(|| anyhow!("value required"))?;
                self.pause = val;
                json!({"success": true, "pause": self.pause})
            }

            UiAction::SetFailsafe => {
                let val = args.value.ok_or_else(|| anyhow!("value required"))?;
                self.failsafe = val != 0.0;
                json!({"success": true, "failsafe": self.failsafe})
            }

            UiAction::Batch => {
                let actions = args.actions.ok_or_else(|| anyhow!("actions required"))?;
                let start = std::time::Instant::now();
                let mut results = Vec::new();

                for (i, action_val) in actions.iter().enumerate() {
                    let action_args: ComputerToolArgs = serde_json::from_value(action_val.clone())
                        .unwrap_or_default();

                    match Box::pin(self.execute(action_args)).await {
                        Ok(_) => {
                            results.push(json!({"index": i, "success": true}));
                        }
                        Err(e) => {
                            results.push(json!({"index": i, "error": e.to_string()}));
                        }
                    }
                }

                let elapsed = start.elapsed().as_millis();
                json!({
                    "success": true,
                    "count": results.len(),
                    "elapsed_ms": elapsed,
                    "results": results
                })
            }

            UiAction::Info => {
                // Clone for multiple spawn_blocking calls
                let ctrl2 = Arc::clone(&ctrl);
                let (mx, my) = tokio::task::spawn_blocking(move || {
                    ctrl.mouse_position()
                }).await?.unwrap_or((0, 0));
                let ctrl3 = Arc::clone(&ctrl2);
                let (sw, sh) = tokio::task::spawn_blocking(move || {
                    ctrl2.screen_size()
                }).await?.unwrap_or((0, 0));
                let platform_info = ctrl3.platform_info();

                json!({
                    "screen": {"width": sw, "height": sh},
                    "mouse": {"x": mx, "y": my},
                    "platform": platform_info,
                    "pause": self.pause,
                    "failsafe": self.failsafe,
                    "regions": self.defined_regions.keys().collect::<Vec<_>>()
                })
            }
        };

        Ok(serde_json::to_string(&result)?)
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct ComputerToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl ComputerToolDefinition {
    pub fn new() -> Self {
        let platform = std::env::consts::OS;
        let backend = match platform {
            "macos" => "quartz",
            "linux" => "x11",
            "windows" => "win32",
            _ => "unknown",
        };

        Self {
            name: "computer".to_string(),
            description: format!(
                r#"Control local computer with native API acceleration.

PLATFORM: {}
BACKENDS: {}

MOUSE (< 5ms native):
- click(x, y) / double_click / right_click / middle_click
- move(x, y) / move_relative(dx, dy)
- drag(x, y) / drag_relative(dx, dy)
- scroll(amount, x, y)

KEYBOARD (< 2ms native):
- type(text, interval): Type text
- write(text, clear): Type with optional clear
- press(key): Press and release key
- key_down(key) / key_up(key): Hold/release
- hotkey(keys): Key combination ["command", "c"]

SCREEN (< 50ms native):
- screenshot() / screenshot_region(region) / get_pixel(x, y)
- get_screens() / screen_size() / position()

WINDOWS & APPS:
- open_app(app): Launch/activate app by name or bundle ID
- get_active_window() / list_windows() / focus_window(title)
- minimize_window / maximize_window / resize_window / move_window / close_window

HEALTH & MACOS NATIVE APPS:
- health(clear=false): Memory pressure, local model RAM, leaked headless browsers (clear=true safely reaps leaked headless browsers only)
- mac_calendar(op=list|create) / mac_reminders(op=list|create) / mac_notes(op=list|read|create)
- mac_mail_draft(to, title, text) [draft-only, never sends] / mac_contacts(query) / mac_shortcuts(op=list|run)

BATCH & INFO:
- batch(actions) / info()"#,
                platform, backend
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Action: click, double_click, right_click, middle_click, move, move_relative, drag, drag_relative, scroll, type, write, press, key_down, key_up, hotkey, screenshot, screenshot_region, get_pixel, get_active_window, list_windows, focus_window, minimize_window, maximize_window, resize_window, move_window, close_window, open_app, get_screens, screen_size, position, health, mac_calendar, mac_reminders, mac_notes, mac_mail_draft, mac_contacts, mac_shortcuts, sleep, batch, info",
                        "default": "info"
                    },
                    "x": {"type": "integer", "description": "X coordinate (or drag start X when end_x is set)"},
                    "y": {"type": "integer", "description": "Y coordinate (or drag start Y when end_y is set)"},
                    "start_x": {"type": "integer", "description": "Explicit drag start X"},
                    "start_y": {"type": "integer", "description": "Explicit drag start Y"},
                    "dx": {"type": "integer", "description": "Delta X"},
                    "dy": {"type": "integer", "description": "Delta Y"},
                    "end_x": {"type": "integer", "description": "End X for drag"},
                    "end_y": {"type": "integer", "description": "End Y for drag"},
                    "text": {"type": "string", "description": "Text to type, note/email body, or shortcut input"},
                    "key": {"type": "string", "description": "Key to press"},
                    "keys": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Keys for hotkey"
                    },
                    "button": {
                        "type": "string",
                        "description": "Mouse button",
                        "default": "left"
                    },
                    "amount": {"type": "integer", "description": "Scroll amount"},
                    "duration": {"type": "number", "description": "Duration", "default": 0.25},
                    "interval": {"type": "number", "description": "Type interval", "default": 0.02},
                    "region": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Region [x,y,w,h]"
                    },
                    "clear": {"type": "boolean", "description": "write: clear first; health: safely reap leaked headless browsers", "default": false},
                    "title": {"type": "string", "description": "Window title, event/note/reminder title, or mail subject"},
                    "app": {"type": "string", "description": "Application name or bundle ID (e.g. 'Safari' or 'com.apple.Safari')"},
                    "name": {"type": "string", "description": "Screenshot filename or macOS Shortcut name"},
                    "width": {"type": "integer", "description": "Window width"},
                    "height": {"type": "integer", "description": "Window height"},
                    "value": {"type": "number", "description": "Value for settings/sleep"},
                    "op": {"type": "string", "description": "Sub-operation for mac_* actions (list, create, read, run)"},
                    "query": {"type": "string", "description": "Search query for mac_contacts or mac_notes"},
                    "calendar": {"type": "string", "description": "Calendar name for mac_calendar"},
                    "list": {"type": "string", "description": "List name for mac_reminders"},
                    "folder": {"type": "string", "description": "Folder name for mac_notes"},
                    "start": {"type": "string", "description": "Start date/time string for mac_calendar create"},
                    "end": {"type": "string", "description": "End date/time string for mac_calendar create"},
                    "to": {"type": "string", "description": "Recipient email for mac_mail_draft"},
                    "cc": {"type": "string", "description": "CC email for mac_mail_draft"},
                    "days": {"type": "integer", "description": "Days ahead for mac_calendar list (default 7)"},
                    "limit": {"type": "integer", "description": "Max items for mac_* list/search"},
                    "timeout_ms": {"type": "integer", "description": "Per-action timeout in milliseconds"},
                    "actions": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "Batch actions"
                    }
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_info_action() {
        let mut tool = ComputerTool::new();
        let args = ComputerToolArgs {
            action: "info".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("screen"));
        assert!(output.contains("mouse"));
    }

    #[tokio::test]
    async fn test_position_action() {
        let mut tool = ComputerTool::new();
        let args = ComputerToolArgs {
            action: "position".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("x"));
        assert!(output.contains("y"));
    }

    #[tokio::test]
    async fn test_screen_size_action() {
        let mut tool = ComputerTool::new();
        let args = ComputerToolArgs {
            action: "screen_size".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("width"));
        assert!(output.contains("height"));
    }

    #[tokio::test]
    async fn test_health_action_is_readonly_by_default() {
        let mut tool = ComputerTool::new();
        let args = ComputerToolArgs {
            action: "health".to_string(),
            ..Default::default()
        };
        let out: Value = serde_json::from_str(&tool.execute(args).await.unwrap()).unwrap();
        assert_eq!(out["success"], true);
        assert!(out["memory"]["total_mb"].is_number());
        assert_eq!(out["leaked_browsers"]["reaped_pids"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_drag_coord_resolution() {
        assert_eq!(
            resolve_drag_coords(Some(10), Some(20), None, None, Some(100), Some(200), (5, 5)).unwrap(),
            ((10, 20), (100, 200))
        );
        assert_eq!(
            resolve_drag_coords(None, None, Some(1), Some(2), Some(3), Some(4), (9, 9)).unwrap(),
            ((1, 2), (3, 4))
        );
        assert_eq!(
            resolve_drag_coords(Some(80), Some(90), None, None, None, None, (12, 34)).unwrap(),
            ((12, 34), (80, 90))
        );
    }

    #[test]
    fn test_new_actions_parse() {
        for name in [
            "open_app", "minimize_window", "maximize_window", "resize_window",
            "move_window", "close_window", "get_pixel", "health",
            "mac_calendar", "mac_reminders", "mac_notes", "mac_mail_draft",
            "mac_contacts", "mac_shortcuts",
        ] {
            assert!(name.parse::<UiAction>().is_ok(), "failed to parse {name}");
        }
    }
}
