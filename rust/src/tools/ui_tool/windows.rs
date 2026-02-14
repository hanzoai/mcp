/// Windows native control using winapi
///
/// Uses ctypes/winapi for direct Win32 API access

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::thread;
use std::time::Duration;
use winapi::shared::minwindef::{BOOL, LPARAM, TRUE, UINT};
use winapi::shared::windef::{HWND, POINT, RECT, HDC};
use winapi::um::winuser::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW,
    GetWindowTextLengthW, SetCursorPos, SetForegroundWindow, EnumWindows, IsWindowVisible,
    keybd_event, mouse_event, FindWindowW, ShowWindow, MoveWindow, PostMessageW,
    SM_CXSCREEN, SM_CYSCREEN, SW_MINIMIZE, SW_MAXIMIZE, SW_RESTORE, WM_CLOSE,
    KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_WHEEL, WHEEL_DELTA,
};
use winapi::um::wingdi::{GetPixel, GetDC, ReleaseDC};

use super::{NativeControl, PlatformInfo, WindowInfo};

// Virtual key codes
fn get_vk_code(key: &str) -> Option<u8> {
    let code = match key.to_lowercase().as_str() {
        "a" => 0x41, "b" => 0x42, "c" => 0x43, "d" => 0x44, "e" => 0x45, "f" => 0x46,
        "g" => 0x47, "h" => 0x48, "i" => 0x49, "j" => 0x4A, "k" => 0x4B, "l" => 0x4C,
        "m" => 0x4D, "n" => 0x4E, "o" => 0x4F, "p" => 0x50, "q" => 0x51, "r" => 0x52,
        "s" => 0x53, "t" => 0x54, "u" => 0x55, "v" => 0x56, "w" => 0x57, "x" => 0x58,
        "y" => 0x59, "z" => 0x5A,
        "0" => 0x30, "1" => 0x31, "2" => 0x32, "3" => 0x33, "4" => 0x34,
        "5" => 0x35, "6" => 0x36, "7" => 0x37, "8" => 0x38, "9" => 0x39,
        "return" | "enter" => 0x0D,
        "tab" => 0x09,
        "space" => 0x20,
        "backspace" => 0x08,
        "escape" | "esc" => 0x1B,
        "shift" | "shiftleft" => 0x10,
        "ctrl" | "control" | "ctrlleft" => 0x11,
        "alt" | "altleft" => 0x12,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "delete" | "del" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "f1" => 0x70, "f2" => 0x71, "f3" => 0x72, "f4" => 0x73, "f5" => 0x74,
        "f6" => 0x75, "f7" => 0x76, "f8" => 0x77, "f9" => 0x78, "f10" => 0x79,
        "f11" => 0x7A, "f12" => 0x7B,
        _ => return None,
    };
    Some(code)
}

pub struct WindowsControl;

impl WindowsControl {
    pub fn new() -> Self {
        Self
    }
}

impl NativeControl for WindowsControl {
    fn platform_info(&self) -> PlatformInfo {
        let mut backends = HashMap::new();
        backends.insert("quartz".to_string(), false);
        backends.insert("xdotool".to_string(), false);
        backends.insert("scrot".to_string(), false);
        backends.insert("win32".to_string(), true);

        PlatformInfo {
            platform: "win32".to_string(),
            native_available: true,
            backends,
        }
    }

    fn mouse_position(&self) -> Result<(i32, i32)> {
        unsafe {
            let mut pt = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut pt) != 0 {
                Ok((pt.x, pt.y))
            } else {
                Err(anyhow!("Failed to get cursor position"))
            }
        }
    }

    fn screen_size(&self) -> Result<(i32, i32)> {
        unsafe {
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            Ok((w, h))
        }
    }

    fn click(&self, x: i32, y: i32, button: &str) -> Result<()> {
        unsafe {
            SetCursorPos(x, y);

            let (down, up) = match button {
                "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            };

            mouse_event(down, 0, 0, 0, 0);
            mouse_event(up, 0, 0, 0, 0);
        }
        Ok(())
    }

    fn double_click(&self, x: i32, y: i32) -> Result<()> {
        self.click(x, y, "left")?;
        thread::sleep(Duration::from_millis(10));
        self.click(x, y, "left")?;
        Ok(())
    }

    fn move_to(&self, x: i32, y: i32) -> Result<()> {
        unsafe {
            SetCursorPos(x, y);
        }
        Ok(())
    }

    fn drag(&self, start_x: i32, start_y: i32, end_x: i32, end_y: i32, button: &str) -> Result<()> {
        unsafe {
            SetCursorPos(start_x, start_y);

            let (down, up) = match button {
                "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            };

            mouse_event(down, 0, 0, 0, 0);

            // Drag in steps
            let steps = ((end_x - start_x).abs().max((end_y - start_y).abs()) / 10).max(1);
            for i in 1..=steps {
                let cx = start_x + (end_x - start_x) * i / steps;
                let cy = start_y + (end_y - start_y) * i / steps;
                SetCursorPos(cx, cy);
                thread::sleep(Duration::from_millis(1));
            }

            mouse_event(up, 0, 0, 0, 0);
        }
        Ok(())
    }

    fn scroll(&self, amount: i32, x: Option<i32>, y: Option<i32>) -> Result<()> {
        if let (Some(x), Some(y)) = (x, y) {
            self.move_to(x, y)?;
        }

        unsafe {
            mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (amount * WHEEL_DELTA as i32) as u32, 0);
        }
        Ok(())
    }

    fn key_down(&self, key: &str) -> Result<()> {
        if let Some(vk) = get_vk_code(key) {
            unsafe {
                keybd_event(vk, 0, 0, 0);
            }
            Ok(())
        } else {
            Err(anyhow!("Unknown key: {}", key))
        }
    }

    fn key_up(&self, key: &str) -> Result<()> {
        if let Some(vk) = get_vk_code(key) {
            unsafe {
                keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
            }
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
        for key in keys {
            self.key_down(key)?;
        }
        for key in keys.iter().rev() {
            self.key_up(key)?;
        }
        Ok(())
    }

    fn type_char(&self, c: char) -> Result<()> {
        let s = c.to_string();
        if get_vk_code(&s).is_some() {
            self.press(&s)?;
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
        // Use PowerShell for screenshot on Windows
        let tmp_path = format!("{}\\hanzo_screenshot_{}.png",
            std::env::temp_dir().display(),
            std::process::id()
        );

        let script = if let Some(r) = region {
            if r.len() == 4 {
                format!(
                    r#"
                    Add-Type -AssemblyName System.Windows.Forms
                    $bounds = New-Object Drawing.Rectangle({}, {}, {}, {})
                    $bitmap = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height)
                    $graphics = [Drawing.Graphics]::FromImage($bitmap)
                    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                    $bitmap.Save("{}")
                    "#,
                    r[0], r[1], r[2], r[3], tmp_path
                )
            } else {
                return Err(anyhow!("Invalid region"));
            }
        } else {
            format!(
                r#"
                Add-Type -AssemblyName System.Windows.Forms
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen
                $bounds = $screen.Bounds
                $bitmap = New-Object Drawing.Bitmap($bounds.Width, $bounds.Height)
                $graphics = [Drawing.Graphics]::FromImage($bitmap)
                $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                $bitmap.Save("{}")
                "#,
                tmp_path
            )
        };

        std::process::Command::new("powershell")
            .arg("-Command")
            .arg(&script)
            .output()?;

        let data = std::fs::read(&tmp_path)?;
        let _ = std::fs::remove_file(&tmp_path);

        Ok(data)
    }

    fn get_active_window(&self) -> Result<WindowInfo> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return Err(anyhow!("No active window"));
            }

            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; (len + 1) as usize];
            GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);

            let title = String::from_utf16_lossy(&buf[..len as usize]);

            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(hwnd, &mut rect);

            Ok(WindowInfo {
                app: None,
                title,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            })
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let mut windows: Vec<WindowInfo> = Vec::new();

        unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let windows = &mut *(lparam as *mut Vec<WindowInfo>);

            if IsWindowVisible(hwnd) != 0 {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
                    let title = String::from_utf16_lossy(&buf[..len as usize]);

                    let mut rect = RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    };
                    GetWindowRect(hwnd, &mut rect);

                    windows.push(WindowInfo {
                        app: None,
                        title,
                        x: rect.left,
                        y: rect.top,
                        width: rect.right - rect.left,
                        height: rect.bottom - rect.top,
                    });
                }
            }

            TRUE
        }

        unsafe {
            EnumWindows(Some(enum_callback), &mut windows as *mut _ as LPARAM);
        }

        Ok(windows)
    }

    fn focus_window(&self, title: &str) -> Result<bool> {
        // Convert title to wide string
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                SetForegroundWindow(hwnd);
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn get_pixel(&self, x: i32, y: i32) -> Result<(u8, u8, u8)> {
        unsafe {
            let hdc: HDC = GetDC(std::ptr::null_mut());
            if hdc.is_null() {
                return Err(anyhow!("Failed to get device context"));
            }

            let color = GetPixel(hdc, x, y);
            ReleaseDC(std::ptr::null_mut(), hdc);

            if color == 0xFFFFFFFF {
                return Err(anyhow!("Failed to get pixel color"));
            }

            // COLORREF is 0x00BBGGRR
            let r = (color & 0xFF) as u8;
            let g = ((color >> 8) & 0xFF) as u8;
            let b = ((color >> 16) & 0xFF) as u8;

            Ok((r, g, b))
        }
    }

    fn minimize_window(&self, title: &str) -> Result<bool> {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_MINIMIZE);
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn maximize_window(&self, title: &str) -> Result<bool> {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_MAXIMIZE);
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn resize_window(&self, title: &str, width: i32, height: i32) -> Result<bool> {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                GetWindowRect(hwnd, &mut rect);
                MoveWindow(hwnd, rect.left, rect.top, width, height, TRUE as BOOL);
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn move_window(&self, title: &str, x: i32, y: i32) -> Result<bool> {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                GetWindowRect(hwnd, &mut rect);
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                MoveWindow(hwnd, x, y, width, height, TRUE as BOOL);
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn close_window(&self, title: &str) -> Result<bool> {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let hwnd = FindWindowW(std::ptr::null(), wide.as_ptr());
            if !hwnd.is_null() {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
                return Ok(true);
            }
        }

        Ok(false)
    }
}
