/// Linux native control using xdotool/scrot
///
/// Requires: xdotool, scrot, xdpyinfo

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::process::Command;
use std::thread;
use std::time::Duration;

use super::{NativeControl, PlatformInfo, WindowInfo};

fn check_command(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub struct LinuxControl {
    has_xdotool: bool,
    has_scrot: bool,
}

impl LinuxControl {
    pub fn new() -> Self {
        Self {
            has_xdotool: check_command("xdotool"),
            has_scrot: check_command("scrot"),
        }
    }

    fn run_xdotool(&self, args: &[&str]) -> Result<String> {
        if !self.has_xdotool {
            return Err(anyhow!("xdotool not available"));
        }

        let output = Command::new("xdotool")
            .args(args)
            .output()?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(anyhow!("xdotool error: {}", stderr))
        }
    }
}

impl NativeControl for LinuxControl {
    fn platform_info(&self) -> PlatformInfo {
        let mut backends = HashMap::new();
        backends.insert("quartz".to_string(), false);
        backends.insert("xdotool".to_string(), self.has_xdotool);
        backends.insert("scrot".to_string(), self.has_scrot);
        backends.insert("win32".to_string(), false);

        PlatformInfo {
            platform: "linux".to_string(),
            native_available: self.has_xdotool,
            backends,
        }
    }

    fn get_pixel(&self, x: i32, y: i32) -> Result<(u8, u8, u8)> {
        if !self.has_scrot {
            return Err(anyhow!("scrot not available for pixel reading"));
        }

        let tmp_path = format!("/tmp/hanzo_pixel_{}.png", std::process::id());

        // Capture 1x1 pixel region
        Command::new("scrot")
            .arg("-o")
            .arg("-a").arg(format!("{},{},1,1", x, y))
            .arg(&tmp_path)
            .output()?;

        // Use ImageMagick identify to get pixel color
        let output = Command::new("convert")
            .arg(&tmp_path)
            .arg("-format").arg("%[pixel:p{0,0}]")
            .arg("info:")
            .output();

        let _ = std::fs::remove_file(&tmp_path);

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Parse format like "srgb(255,128,64)" or "rgb(255,128,64)"
            if let Some(start) = stdout.find('(') {
                if let Some(end) = stdout.find(')') {
                    let rgb_str = &stdout[start + 1..end];
                    let parts: Vec<&str> = rgb_str.split(',').collect();
                    if parts.len() >= 3 {
                        let r: u8 = parts[0].trim().parse().unwrap_or(0);
                        let g: u8 = parts[1].trim().parse().unwrap_or(0);
                        let b: u8 = parts[2].trim().parse().unwrap_or(0);
                        return Ok((r, g, b));
                    }
                }
            }
        }

        Ok((0, 0, 0))
    }

    fn minimize_window(&self, title: &str) -> Result<bool> {
        let result = self.run_xdotool(&["search", "--name", title, "windowminimize"]);
        Ok(result.is_ok())
    }

    fn maximize_window(&self, title: &str) -> Result<bool> {
        // First get window ID, then maximize
        let search = self.run_xdotool(&["search", "--name", title])?;
        let window_id = search.lines().next().unwrap_or("").trim();
        if window_id.is_empty() {
            return Ok(false);
        }

        // Use wmctrl if available, otherwise use xdotool key combo
        let wmctrl_result = Command::new("wmctrl")
            .arg("-i")
            .arg("-r").arg(window_id)
            .arg("-b").arg("add,maximized_vert,maximized_horz")
            .output();

        if wmctrl_result.map(|r| r.status.success()).unwrap_or(false) {
            return Ok(true);
        }

        // Fallback: use keyboard shortcut
        self.run_xdotool(&["windowactivate", window_id])?;
        self.run_xdotool(&["key", "super+Up"])?;
        Ok(true)
    }

    fn resize_window(&self, title: &str, width: i32, height: i32) -> Result<bool> {
        let result = self.run_xdotool(&[
            "search", "--name", title,
            "windowsize", &width.to_string(), &height.to_string()
        ]);
        Ok(result.is_ok())
    }

    fn move_window(&self, title: &str, x: i32, y: i32) -> Result<bool> {
        let result = self.run_xdotool(&[
            "search", "--name", title,
            "windowmove", &x.to_string(), &y.to_string()
        ]);
        Ok(result.is_ok())
    }

    fn close_window(&self, title: &str) -> Result<bool> {
        // Try wmctrl first
        let wmctrl_result = Command::new("wmctrl")
            .arg("-c").arg(title)
            .output();

        if wmctrl_result.map(|r| r.status.success()).unwrap_or(false) {
            return Ok(true);
        }

        // Fallback: use xdotool
        let search = self.run_xdotool(&["search", "--name", title])?;
        let window_id = search.lines().next().unwrap_or("").trim();
        if window_id.is_empty() {
            return Ok(false);
        }

        self.run_xdotool(&["windowactivate", window_id])?;
        self.run_xdotool(&["key", "alt+F4"])?;
        Ok(true)
    }

    fn mouse_position(&self) -> Result<(i32, i32)> {
        let output = self.run_xdotool(&["getmouselocation", "--shell"])?;

        let mut x = 0;
        let mut y = 0;

        for line in output.lines() {
            if let Some(val) = line.strip_prefix("X=") {
                x = val.parse().unwrap_or(0);
            } else if let Some(val) = line.strip_prefix("Y=") {
                y = val.parse().unwrap_or(0);
            }
        }

        Ok((x, y))
    }

    fn screen_size(&self) -> Result<(i32, i32)> {
        let output = Command::new("xdpyinfo")
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);

        for line in stdout.lines() {
            if line.contains("dimensions:") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let dims: Vec<&str> = parts[1].split('x').collect();
                    if dims.len() == 2 {
                        let w: i32 = dims[0].parse().unwrap_or(1920);
                        let h: i32 = dims[1].parse().unwrap_or(1080);
                        return Ok((w, h));
                    }
                }
            }
        }

        Ok((1920, 1080))
    }

    fn click(&self, x: i32, y: i32, button: &str) -> Result<()> {
        let btn = match button {
            "right" => "3",
            "middle" => "2",
            _ => "1",
        };

        self.run_xdotool(&[
            "mousemove", &x.to_string(), &y.to_string(),
            "click", btn
        ])?;

        Ok(())
    }

    fn double_click(&self, x: i32, y: i32) -> Result<()> {
        self.run_xdotool(&[
            "mousemove", &x.to_string(), &y.to_string(),
            "click", "--repeat", "2", "1"
        ])?;

        Ok(())
    }

    fn move_to(&self, x: i32, y: i32) -> Result<()> {
        self.run_xdotool(&["mousemove", &x.to_string(), &y.to_string()])?;
        Ok(())
    }

    fn drag(&self, start_x: i32, start_y: i32, end_x: i32, end_y: i32, button: &str) -> Result<()> {
        let btn = match button {
            "right" => "3",
            "middle" => "2",
            _ => "1",
        };

        self.run_xdotool(&[
            "mousemove", &start_x.to_string(), &start_y.to_string(),
            "mousedown", btn,
            "mousemove", &end_x.to_string(), &end_y.to_string(),
            "mouseup", btn
        ])?;

        Ok(())
    }

    fn scroll(&self, amount: i32, x: Option<i32>, y: Option<i32>) -> Result<()> {
        if let (Some(x), Some(y)) = (x, y) {
            self.move_to(x, y)?;
        }

        let btn = if amount > 0 { "4" } else { "5" };

        for _ in 0..amount.abs() {
            self.run_xdotool(&["click", btn])?;
        }

        Ok(())
    }

    fn key_down(&self, key: &str) -> Result<()> {
        self.run_xdotool(&["keydown", &key.to_lowercase()])?;
        Ok(())
    }

    fn key_up(&self, key: &str) -> Result<()> {
        self.run_xdotool(&["keyup", &key.to_lowercase()])?;
        Ok(())
    }

    fn press(&self, key: &str) -> Result<()> {
        self.run_xdotool(&["key", &key.to_lowercase()])?;
        Ok(())
    }

    fn hotkey(&self, keys: &[String]) -> Result<()> {
        let combo = keys.join("+");
        self.run_xdotool(&["key", &combo])?;
        Ok(())
    }

    fn type_char(&self, c: char) -> Result<()> {
        self.run_xdotool(&["type", "--", &c.to_string()])?;
        Ok(())
    }

    fn type_text(&self, text: &str, interval: f64) -> Result<()> {
        if interval > 0.0 {
            let delay_ms = (interval * 1000.0) as u32;
            self.run_xdotool(&["type", "--delay", &delay_ms.to_string(), "--", text])?;
        } else {
            self.run_xdotool(&["type", "--", text])?;
        }
        Ok(())
    }

    fn screenshot(&self, region: Option<&[i32]>) -> Result<Vec<u8>> {
        if !self.has_scrot {
            return Err(anyhow!("scrot not available"));
        }

        let tmp_path = format!("/tmp/hanzo_screenshot_{}.png", std::process::id());

        let mut cmd = Command::new("scrot");
        cmd.arg("-o");

        if let Some(r) = region {
            if r.len() == 4 {
                cmd.arg("-a").arg(format!("{},{},{},{}", r[0], r[1], r[2], r[3]));
            }
        }

        cmd.arg(&tmp_path);
        cmd.output()?;

        let data = std::fs::read(&tmp_path)?;
        let _ = std::fs::remove_file(&tmp_path);

        Ok(data)
    }

    fn get_active_window(&self) -> Result<WindowInfo> {
        let output = self.run_xdotool(&["getactivewindow", "getwindowname"])?;

        Ok(WindowInfo {
            app: None,
            title: output.trim().to_string(),
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        })
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let output = self.run_xdotool(&["search", "--name", ""])?;

        let mut windows = Vec::new();

        for line in output.lines() {
            if let Ok(window_id) = line.trim().parse::<u64>() {
                if let Ok(name_output) = self.run_xdotool(&["getwindowname", &window_id.to_string()]) {
                    windows.push(WindowInfo {
                        app: None,
                        title: name_output.trim().to_string(),
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    });
                }
            }
        }

        Ok(windows)
    }

    fn focus_window(&self, title: &str) -> Result<bool> {
        let result = self.run_xdotool(&["search", "--name", title, "windowactivate"]);
        Ok(result.is_ok())
    }
}
