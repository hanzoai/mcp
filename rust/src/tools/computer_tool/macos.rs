/// macOS native control using Quartz/CoreGraphics
///
/// Performance: 10-50x faster than cross-platform alternatives
/// - Click: <5ms
/// - Keypress: <2ms
/// - Screenshot: <50ms

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use super::{NativeControl, PlatformInfo, WindowInfo};

static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn unique_tmp_png(prefix: &str) -> String {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}/hanzo_{}_{}_{}.png",
        std::env::temp_dir().display(),
        prefix,
        std::process::id(),
        seq
    )
}

/// Execute AppleScript safely by streaming script source on stdin (`osascript -`)
/// and passing all untrusted inputs as positional `argv` parameters (`on run argv`).
/// Zero string interpolation into AppleScript source.
pub(crate) fn run_osascript(script: &str, args: &[&str]) -> Result<Output> {
    let mut child = Command::new("osascript")
        .arg("-")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes())?;
    }
    Ok(child.wait_with_output()?)
}

/// Check macOS Accessibility and Screen Recording permissions natively via Quartz / AX.
pub fn macos_permissions() -> (bool, bool) {
    unsafe {
        let ax = cg::AXIsProcessTrusted();
        let screen = cg::CGPreflightScreenCaptureAccess();
        (ax, screen)
    }
}

/// Returns true if `target` looks like a reverse-DNS bundle identifier (e.g. `com.apple.Safari`).
fn looks_like_bundle_id(target: &str) -> bool {
    let t = target.trim();
    t.split('.').count() >= 3
        && !t.contains('/')
        && !t.contains(char::is_whitespace)
        && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

// CoreGraphics types and functions
mod cg {
    use std::ffi::c_void;

    pub const kCGEventLeftMouseDown: u32 = 1;
    pub const kCGEventLeftMouseUp: u32 = 2;
    pub const kCGEventRightMouseDown: u32 = 3;
    pub const kCGEventRightMouseUp: u32 = 4;
    pub const kCGEventMouseMoved: u32 = 5;
    pub const kCGEventLeftMouseDragged: u32 = 6;
    pub const kCGEventRightMouseDragged: u32 = 7;
    pub const kCGEventOtherMouseDown: u32 = 25;
    pub const kCGEventOtherMouseUp: u32 = 26;
    pub const kCGEventOtherMouseDragged: u32 = 27;

    pub const kCGMouseButtonLeft: u32 = 0;
    pub const kCGMouseButtonRight: u32 = 1;
    pub const kCGMouseButtonCenter: u32 = 2;

    pub const kCGHIDEventTap: u32 = 0;
    pub const kCGScrollEventUnitLine: u32 = 1;

    // Use opaque type for CGEventRef
    pub type CGEventRef = *mut c_void;

    #[repr(C)]
    #[derive(Copy, Clone, Debug)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventCreate(source: *const c_void) -> CGEventRef;
        pub fn CGEventGetLocation(event: CGEventRef) -> CGPoint;

        pub fn CGEventCreateMouseEvent(
            source: *const c_void,
            mouseType: u32,
            mouseCursorPosition: CGPoint,
            mouseButton: u32,
        ) -> CGEventRef;

        pub fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            virtualKey: u16,
            keyDown: bool,
        ) -> CGEventRef;

        pub fn CGEventCreateScrollWheelEvent(
            source: *const c_void,
            units: u32,
            wheelCount: u32,
            wheel1: i32,
        ) -> CGEventRef;

        pub fn CGEventPost(tap: u32, event: CGEventRef);

        pub fn CGDisplayPixelsWide(display: u32) -> usize;
        pub fn CGDisplayPixelsHigh(display: u32) -> usize;
        pub fn CGMainDisplayID() -> u32;
        pub fn CGPreflightScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }

    // CFRelease is in CoreFoundation, not CoreGraphics
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRelease(cf: *mut c_void);
    }
}

// macOS key codes
fn get_key_code(key: &str) -> Option<u16> {
    let code = match key.to_lowercase().as_str() {
        "a" => 0x00, "s" => 0x01, "d" => 0x02, "f" => 0x03, "h" => 0x04, "g" => 0x05,
        "z" => 0x06, "x" => 0x07, "c" => 0x08, "v" => 0x09, "b" => 0x0b, "q" => 0x0c,
        "w" => 0x0d, "e" => 0x0e, "r" => 0x0f, "y" => 0x10, "t" => 0x11,
        "1" => 0x12, "2" => 0x13, "3" => 0x14, "4" => 0x15, "5" => 0x17, "6" => 0x16,
        "7" => 0x1a, "8" => 0x1c, "9" => 0x19, "0" => 0x1d,
        "-" => 0x1b, "=" => 0x18, "[" => 0x21, "]" => 0x1e, "\\" => 0x2a,
        ";" => 0x29, "'" => 0x27, "`" => 0x32, "," => 0x2b, "." => 0x2f, "/" => 0x2c,
        "o" => 0x1f, "u" => 0x20, "i" => 0x22, "p" => 0x23, "l" => 0x25, "j" => 0x26,
        "k" => 0x28, "n" => 0x2d, "m" => 0x2e,
        " " | "space" => 0x31,
        "return" | "enter" | "\n" | "\r" => 0x24,
        "tab" | "\t" => 0x30,
        "backspace" | "\x08" => 0x33,
        "escape" | "esc" => 0x35,
        "command" | "cmd" => 0x37,
        "shift" | "shiftleft" => 0x38,
        "shiftright" => 0x3c,
        "capslock" => 0x39,
        "option" | "alt" | "optionleft" | "altleft" => 0x3a,
        "optionright" | "altright" => 0x3d,
        "control" | "ctrl" | "ctrlleft" => 0x3b,
        "ctrlright" => 0x3e,
        "fn" => 0x3f,
        "f1" => 0x7a, "f2" => 0x78, "f3" => 0x63, "f4" => 0x76, "f5" => 0x60,
        "f6" => 0x61, "f7" => 0x62, "f8" => 0x64, "f9" => 0x65, "f10" => 0x6d,
        "f11" => 0x67, "f12" => 0x6f,
        "home" => 0x73, "end" => 0x77, "pageup" => 0x74, "pagedown" => 0x79,
        "delete" | "del" => 0x75,
        "left" => 0x7b, "right" => 0x7c, "down" => 0x7d, "up" => 0x7e,
        _ => return None,
    };
    Some(code)
}

const SHIFT_CHARS: &str = "~!@#$%^&*()_+{}|:\"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ";

pub struct MacOSControl;

impl MacOSControl {
    pub fn new() -> Self {
        Self
    }

    fn send_mouse_event(&self, event_type: u32, x: i32, y: i32, button: u32) {
        unsafe {
            let point = cg::CGPoint {
                x: x as f64,
                y: y as f64,
            };
            let event = cg::CGEventCreateMouseEvent(
                std::ptr::null(),
                event_type,
                point,
                button,
            );
            if !event.is_null() {
                cg::CGEventPost(cg::kCGHIDEventTap, event);
                cg::CFRelease(event as *mut std::ffi::c_void);
            }
        }
    }

    fn send_key_event(&self, key_code: u16, down: bool) {
        unsafe {
            let event = cg::CGEventCreateKeyboardEvent(std::ptr::null(), key_code, down);
            if !event.is_null() {
                cg::CGEventPost(cg::kCGHIDEventTap, event);
                cg::CFRelease(event as *mut std::ffi::c_void);
            }
        }
    }
}

impl NativeControl for MacOSControl {
    fn platform_info(&self) -> PlatformInfo {
        let (ax_trusted, screen_recording) = macos_permissions();
        let mut backends = HashMap::new();
        backends.insert("quartz".to_string(), true);
        backends.insert("accessibility".to_string(), ax_trusted);
        backends.insert("screen_recording".to_string(), screen_recording);
        backends.insert("xdotool".to_string(), false);
        backends.insert("scrot".to_string(), false);
        backends.insert("win32".to_string(), false);

        PlatformInfo {
            platform: "darwin".to_string(),
            native_available: true,
            backends,
        }
    }

    fn get_pixel(&self, x: i32, y: i32) -> Result<(u8, u8, u8)> {
        let tmp_path = unique_tmp_png("pixel");
        let capture = Command::new("screencapture")
            .arg("-x")
            .arg("-t")
            .arg("png")
            .arg("-R")
            .arg(format!("{x},{y},1,1"))
            .arg(&tmp_path)
            .output()?;
        if !capture.status.success() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(anyhow!("screencapture failed for pixel ({x}, {y})"));
        }

        let script = r#"
on run argv
    use framework "AppKit"
    set filePath to item 1 of argv
    set img to current application's NSImage's alloc()'s initWithContentsOfFile:filePath
    if img is missing value then return "0,0,0"
    set bitmapRep to current application's NSBitmapImageRep's imageRepWithData:(img's TIFFRepresentation())
    if bitmapRep is missing value then return "0,0,0"
    set pixelColor to bitmapRep's colorAtX:0 y:0
    if pixelColor is missing value then return "0,0,0"
    set rgbColor to pixelColor's colorUsingColorSpace:(current application's NSColorSpace's sRGBColorSpace())
    if rgbColor is missing value then set rgbColor to pixelColor
    set r to (rgbColor's redComponent()) * 255 as integer
    set g to (rgbColor's greenComponent()) * 255 as integer
    set b to (rgbColor's blueComponent()) * 255 as integer
    return (r as text) & "," & (g as text) & "," & (b as text)
end run
"#;
        let output = run_osascript(script, &[&tmp_path]);
        let _ = std::fs::remove_file(&tmp_path);
        let output = output?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = stdout.trim().split(',').collect();
        if parts.len() == 3 {
            let r: u8 = parts[0].parse().unwrap_or(0);
            let g: u8 = parts[1].parse().unwrap_or(0);
            let b: u8 = parts[2].parse().unwrap_or(0);
            return Ok((r, g, b));
        }

        Ok((0, 0, 0))
    }

    fn minimize_window(&self, title: &str) -> Result<bool> {
        let script = r#"
on run argv
    set needle to item 1 of argv
    tell application "System Events"
        set targetApp to first application process whose name contains needle
        tell targetApp
            set frontmost to true
            try
                click button 2 of window 1
                return "true"
            on error
                try
                    set value of attribute "AXMinimized" of window 1 to true
                    return "true"
                end try
            end try
        end tell
    end tell
    return "false"
end run
"#;
        let output = run_osascript(script, &[title])?;
        Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    fn maximize_window(&self, title: &str) -> Result<bool> {
        let script = r#"
on run argv
    set needle to item 1 of argv
    tell application "System Events"
        set targetApp to first application process whose name contains needle
        tell targetApp
            set frontmost to true
            try
                set value of attribute "AXFullScreen" of window 1 to true
                return "true"
            on error
                try
                    click button 2 of window 1
                    return "true"
                end try
            end try
        end tell
    end tell
    return "false"
end run
"#;
        let output = run_osascript(script, &[title])?;
        Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    fn resize_window(&self, title: &str, width: i32, height: i32) -> Result<bool> {
        let w = width.to_string();
        let h = height.to_string();
        let script = r#"
on run argv
    set needle to item 1 of argv
    set w to (item 2 of argv) as integer
    set h to (item 3 of argv) as integer
    tell application "System Events"
        set targetApp to first application process whose name contains needle
        tell targetApp
            try
                set size of window 1 to {w, h}
                return "true"
            end try
        end tell
    end tell
    return "false"
end run
"#;
        let output = run_osascript(script, &[title, &w, &h])?;
        Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    fn move_window(&self, title: &str, x: i32, y: i32) -> Result<bool> {
        let xs = x.to_string();
        let ys = y.to_string();
        let script = r#"
on run argv
    set needle to item 1 of argv
    set px to (item 2 of argv) as integer
    set py to (item 3 of argv) as integer
    tell application "System Events"
        set targetApp to first application process whose name contains needle
        tell targetApp
            try
                set position of window 1 to {px, py}
                return "true"
            end try
        end tell
    end tell
    return "false"
end run
"#;
        let output = run_osascript(script, &[title, &xs, &ys])?;
        Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    fn close_window(&self, title: &str) -> Result<bool> {
        let script = r#"
on run argv
    set needle to item 1 of argv
    tell application "System Events"
        set targetApp to first application process whose name contains needle
        tell targetApp
            set frontmost to true
            try
                click button 1 of window 1
                return "true"
            on error
                try
                    keystroke "w" using command down
                    return "true"
                end try
            end try
        end tell
    end tell
    return "false"
end run
"#;
        let output = run_osascript(script, &[title])?;
        Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
    }

    fn mouse_position(&self) -> Result<(i32, i32)> {
        // Native CoreGraphics cursor query (<0.1ms, no subprocess).
        unsafe {
            let ev = cg::CGEventCreate(std::ptr::null());
            if !ev.is_null() {
                let pt = cg::CGEventGetLocation(ev);
                cg::CFRelease(ev);
                return Ok((pt.x.round() as i32, pt.y.round() as i32));
            }
        }
        Err(anyhow!("CGEventCreate returned null while reading mouse position"))
    }

    fn screen_size(&self) -> Result<(i32, i32)> {
        unsafe {
            let display = cg::CGMainDisplayID();
            let w = cg::CGDisplayPixelsWide(display) as i32;
            let h = cg::CGDisplayPixelsHigh(display) as i32;
            Ok((w, h))
        }
    }

    fn click(&self, x: i32, y: i32, button: &str) -> Result<()> {
        let (down_type, up_type, btn) = match button {
            "right" => (
                cg::kCGEventRightMouseDown,
                cg::kCGEventRightMouseUp,
                cg::kCGMouseButtonRight,
            ),
            "middle" => (
                cg::kCGEventOtherMouseDown,
                cg::kCGEventOtherMouseUp,
                cg::kCGMouseButtonCenter,
            ),
            _ => (
                cg::kCGEventLeftMouseDown,
                cg::kCGEventLeftMouseUp,
                cg::kCGMouseButtonLeft,
            ),
        };

        self.send_mouse_event(down_type, x, y, btn);
        self.send_mouse_event(up_type, x, y, btn);
        Ok(())
    }

    fn double_click(&self, x: i32, y: i32) -> Result<()> {
        self.click(x, y, "left")?;
        thread::sleep(Duration::from_millis(10));
        self.click(x, y, "left")?;
        Ok(())
    }

    fn move_to(&self, x: i32, y: i32) -> Result<()> {
        self.send_mouse_event(cg::kCGEventMouseMoved, x, y, 0);
        Ok(())
    }

    fn drag(&self, start_x: i32, start_y: i32, end_x: i32, end_y: i32, button: &str) -> Result<()> {
        let (down_type, drag_type, up_type, btn) = match button {
            "right" => (
                cg::kCGEventRightMouseDown,
                cg::kCGEventRightMouseDragged,
                cg::kCGEventRightMouseUp,
                cg::kCGMouseButtonRight,
            ),
            "middle" => (
                cg::kCGEventOtherMouseDown,
                cg::kCGEventOtherMouseDragged,
                cg::kCGEventOtherMouseUp,
                cg::kCGMouseButtonCenter,
            ),
            _ => (
                cg::kCGEventLeftMouseDown,
                cg::kCGEventLeftMouseDragged,
                cg::kCGEventLeftMouseUp,
                cg::kCGMouseButtonLeft,
            ),
        };

        // Always guarantee mouse-up on exit so the pointer button never sticks down.
        struct ReleaseGuard<'a> {
            ctrl: &'a MacOSControl,
            up_type: u32,
            btn: u32,
            x: i32,
            y: i32,
        }
        impl Drop for ReleaseGuard<'_> {
            fn drop(&mut self) {
                self.ctrl.send_mouse_event(self.up_type, self.x, self.y, self.btn);
            }
        }

        // Mouse down
        self.send_mouse_event(down_type, start_x, start_y, btn);
        let mut guard = ReleaseGuard {
            ctrl: self,
            up_type,
            btn,
            x: start_x,
            y: start_y,
        };

        // Drag in steps
        let steps = ((end_x - start_x).abs().max((end_y - start_y).abs()) / 10).clamp(1, 100);
        for i in 1..=steps {
            let cx = start_x + (end_x - start_x) * i / steps;
            let cy = start_y + (end_y - start_y) * i / steps;
            guard.x = cx;
            guard.y = cy;
            self.send_mouse_event(drag_type, cx, cy, btn);
            thread::sleep(Duration::from_millis(2));
        }

        guard.x = end_x;
        guard.y = end_y;
        drop(guard);
        Ok(())
    }

    fn scroll(&self, amount: i32, x: Option<i32>, y: Option<i32>) -> Result<()> {
        if let (Some(x), Some(y)) = (x, y) {
            self.move_to(x, y)?;
        }

        unsafe {
            let event = cg::CGEventCreateScrollWheelEvent(
                std::ptr::null(),
                cg::kCGScrollEventUnitLine,
                1,
                amount,
            );
            if !event.is_null() {
                cg::CGEventPost(cg::kCGHIDEventTap, event);
                cg::CFRelease(event as *mut std::ffi::c_void);
            }
        }
        Ok(())
    }

    fn key_down(&self, key: &str) -> Result<()> {
        if let Some(code) = get_key_code(key) {
            self.send_key_event(code, true);
            Ok(())
        } else {
            Err(anyhow!("Unknown key: {}", key))
        }
    }

    fn key_up(&self, key: &str) -> Result<()> {
        if let Some(code) = get_key_code(key) {
            self.send_key_event(code, false);
            Ok(())
        } else {
            Err(anyhow!("Unknown key: {}", key))
        }
    }

    fn press(&self, key: &str) -> Result<()> {
        self.key_down(key)?;
        self.key_up(key)?;
        Ok(())
    }

    fn hotkey(&self, keys: &[String]) -> Result<()> {
        // Press all keys down
        for key in keys {
            self.key_down(key)?;
        }
        // Release in reverse order
        for key in keys.iter().rev() {
            self.key_up(key)?;
        }
        Ok(())
    }

    fn type_char(&self, c: char) -> Result<()> {
        let s = c.to_string();
        let key = s.as_str();

        if SHIFT_CHARS.contains(c) {
            self.key_down("shift")?;
            let lower = c.to_lowercase().to_string();
            if get_key_code(&lower).is_some() {
                self.press(&lower)?;
            }
            self.key_up("shift")?;
        } else if get_key_code(key).is_some() {
            self.press(key)?;
        }

        Ok(())
    }

    fn type_text(&self, text: &str, interval: f64) -> Result<()> {
        for c in text.chars() {
            self.type_char(c)?;
            if interval > 0.0 {
                thread::sleep(Duration::from_secs_f64(interval));
            }
        }
        Ok(())
    }

    fn screenshot(&self, region: Option<&[i32]>) -> Result<Vec<u8>> {
        let tmp_path = unique_tmp_png("screenshot");

        let mut cmd = Command::new("screencapture");
        cmd.arg("-x").arg("-t").arg("png");

        if let Some(r) = region {
            if r.len() == 4 {
                cmd.arg("-R").arg(format!("{},{},{},{}", r[0], r[1], r[2], r[3]));
            }
        }

        cmd.arg(&tmp_path);
        let out = cmd.output()?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&tmp_path);
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(anyhow!("screencapture failed (check Screen Recording permission): {err}"));
        }

        let data = std::fs::read(&tmp_path)?;
        let _ = std::fs::remove_file(&tmp_path);

        Ok(data)
    }

    fn get_active_window(&self) -> Result<WindowInfo> {
        let script = r#"
            tell application "System Events"
                set frontApp to first application process whose frontmost is true
                set appName to name of frontApp
                try
                    set frontWindow to front window of frontApp
                    set winName to name of frontWindow
                    set winPos to position of frontWindow
                    set winSize to size of frontWindow
                    return appName & "|" & winName & "|" & (item 1 of winPos) & "|" & (item 2 of winPos) & "|" & (item 1 of winSize) & "|" & (item 2 of winSize)
                on error
                    return appName & "|" & "" & "|0|0|0|0"
                end try
            end tell
        "#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<&str> = stdout.trim().split('|').collect();

        if parts.len() >= 6 {
            Ok(WindowInfo {
                app: Some(parts[0].to_string()),
                title: parts[1].to_string(),
                x: parts[2].parse().unwrap_or(0),
                y: parts[3].parse().unwrap_or(0),
                width: parts[4].parse().unwrap_or(0),
                height: parts[5].parse().unwrap_or(0),
            })
        } else {
            Err(anyhow!("Could not get active window"))
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let script = r#"
            set windowList to ""
            set delim to ASCII character 31
            tell application "System Events"
                set allProcesses to application processes whose visible is true
                repeat with proc in allProcesses
                    set procName to name of proc
                    try
                        set procWindows to windows of proc
                        repeat with win in procWindows
                            set winName to name of win
                            set winPos to position of win
                            set winSize to size of win
                            set windowList to windowList & procName & delim & winName & delim & (item 1 of winPos) & delim & (item 2 of winPos) & delim & (item 1 of winSize) & delim & (item 2 of winSize) & "\n"
                        end repeat
                    end try
                end repeat
            end tell
            return windowList
        "#;

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut windows = Vec::new();

        for line in stdout.lines() {
            if line.contains('\x1f') {
                let parts: Vec<&str> = line.split('\x1f').collect();
                if parts.len() >= 6 {
                    windows.push(WindowInfo {
                        app: Some(parts[0].to_string()),
                        title: parts[1].to_string(),
                        x: parts[2].parse().unwrap_or(0),
                        y: parts[3].parse().unwrap_or(0),
                        width: parts[4].parse().unwrap_or(0),
                        height: parts[5].parse().unwrap_or(0),
                    });
                }
            }
        }

        Ok(windows)
    }

    fn focus_window(&self, title: &str) -> Result<bool> {
        let activate_script = r#"
on run argv
    set appName to item 1 of argv
    try
        tell application appName to activate
        return "true"
    on error
        return "false"
    end try
end run
"#;
        if let Ok(output) = run_osascript(activate_script, &[title]) {
            if output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true" {
                return Ok(true);
            }
        }

        // Partial process-name match via System Events (still zero string interpolation).
        let search_script = r#"
on run argv
    set needle to item 1 of argv
    tell application "System Events"
        set matchingApps to (application processes whose name contains needle)
        if (count of matchingApps) > 0 then
            set frontApp to item 1 of matchingApps
            set frontmost of frontApp to true
            return name of frontApp
        end if
    end tell
    return ""
end run
"#;
        let output = run_osascript(search_script, &[title])?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(!stdout.trim().is_empty())
    }

    fn open_app(&self, app: &str) -> Result<bool> {
        let target = app.trim();
        if target.is_empty() {
            return Err(anyhow!("app name or bundle ID required"));
        }
        let flag = if looks_like_bundle_id(target) { "-b" } else { "-a" };
        let output = Command::new("open").arg(flag).arg(target).output()?;
        if output.status.success() {
            Ok(true)
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(anyhow!("open {flag} {target:?} failed: {err}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_id_classifier_works() {
        assert!(looks_like_bundle_id("com.apple.Safari"));
        assert!(looks_like_bundle_id("com.google.Chrome"));
        assert!(!looks_like_bundle_id("Google Chrome"));
        assert!(!looks_like_bundle_id("/Applications/Safari.app"));
        assert!(!looks_like_bundle_id("Safari"));
    }

    #[test]
    fn run_osascript_passes_untrusted_quotes_as_argv() {
        let tricky = r#"hello "quoted" & \ slash"#;
        let out = run_osascript("on run argv\nreturn item 1 of argv\nend run\n", &[tricky]).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), tricky);
    }
}
