//! Cross-platform local computer health census & safe Tier-1 browser cleanup.
//!
//! Reports memory pressure, top RSS processes, local AI model engine RAM usage,
//! and leaked headless/automation browser instances. Cleanup (`reap_leaked_browsers`)
//! is strictly opt-in (defaults to false) and enforces an immutable never-touch set
//! covering interactive user browsers, calls/video apps, AI desktop apps, terminals,
//! system UI, and the current frontmost application.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEntry {
    pub pid: u32,
    pub rss_mb: u64,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySummary {
    pub total_mb: u64,
    pub available_mb: u64,
    pub used_pct: f64,
    pub pressure: String,
}

/// Processes and apps that automated cleanup must NEVER terminate.
const NEVER_TOUCH_NAMES: &[&str] = &[
    "zoom",
    "facetime",
    "microsoft teams",
    "webex",
    "slack",
    "discord",
    "claude",
    "hanzo",
    "cursor",
    "antigravity",
    "code",
    "terminal",
    "iterm",
    "ghostty",
    "warp",
    "finder",
    "windowserver",
    "loginwindow",
    "dock",
    "systemuiserver",
    "system settings",
    "system preferences",
    "sshd",
    "launchd",
    "systemd",
];

/// Local model runtime process signatures.
const MODEL_RUNTIME_MARKERS: &[&str] = &[
    "ollama",
    "llama-server",
    "llama-cli",
    "mlx_lm",
    "vllm",
    "hanzo-engine",
    "hanzo-node",
    "lmstudio",
    "koboldcpp",
];

/// Automation / headless browser command-line markers.
const HEADLESS_BROWSER_MARKERS: &[&str] = &[
    "--headless",
    "chromium_headless",
    "chrome-headless-shell",
    "playwright",
    "puppeteer",
    "selenium",
];

/// Temp profile markers that distinguish ephemeral automation browsers from a user's browser.
const EPHEMERAL_PROFILE_MARKERS: &[&str] = &[
    "--user-data-dir=/tmp/",
    "--user-data-dir=/var/folders/",
    "--user-data-dir=/private/tmp/",
    "--user-data-dir=/private/var/folders/",
];

pub fn is_never_touch(proc_name: &str, command: &str, frontmost_app: Option<&str>) -> bool {
    let lower_name = proc_name.to_lowercase();
    let lower_cmd = command.to_lowercase();
    if let Some(front) = frontmost_app {
        let f = front.trim().to_lowercase();
        if !f.is_empty() && (lower_name.contains(&f) || lower_cmd.contains(&f)) {
            return true;
        }
    }
    NEVER_TOUCH_NAMES
        .iter()
        .any(|needle| lower_name.contains(needle) || lower_cmd.contains(needle))
}

/// Returns true ONLY for headless / ephemeral-profile automation browser processes,
/// never for visible user browsers or protected apps.
pub fn is_leaked_headless_browser(
    pid: u32,
    self_pid: u32,
    proc_name: &str,
    command: &str,
    frontmost_app: Option<&str>,
) -> bool {
    if pid == self_pid || pid <= 1 {
        return false;
    }
    if is_never_touch(proc_name, command, frontmost_app) {
        return false;
    }
    let lower = command.to_lowercase();
    let looks_like_browser = lower.contains("chrom")
        || lower.contains("firefox")
        || lower.contains("webkit")
        || lower.contains("edge");
    if !looks_like_browser {
        return false;
    }
    let has_headless = HEADLESS_BROWSER_MARKERS.iter().any(|m| lower.contains(m));
    let has_remote_debug_and_ephemeral = lower.contains("--remote-debugging-port")
        && EPHEMERAL_PROFILE_MARKERS.iter().any(|m| lower.contains(m));
    has_headless || has_remote_debug_and_ephemeral
}

pub fn is_model_runtime(command: &str) -> bool {
    let lower = command.to_lowercase();
    MODEL_RUNTIME_MARKERS.iter().any(|m| lower.contains(m))
}

fn memory_summary() -> MemorySummary {
    #[cfg(target_os = "macos")]
    {
        let total_bytes: u64 = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(0);
        let total_mb = total_bytes / (1024 * 1024);

        let vm = Command::new("vm_stat")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let page_size: u64 = vm
            .lines()
            .next()
            .and_then(|line| {
                line.split("page size of ")
                    .nth(1)
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|n| n.parse().ok())
            })
            .unwrap_or(16384);

        let parse_pages = |label: &str| -> u64 {
            vm.lines()
                .find(|l| l.starts_with(label))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
                .unwrap_or(0)
        };
        let free = parse_pages("Pages free");
        let inactive = parse_pages("Pages inactive");
        let speculative = parse_pages("Pages speculative");
        let purgeable = parse_pages("Pages purgeable");
        let available_mb = (free + inactive + speculative + purgeable)
            .saturating_mul(page_size)
            / (1024 * 1024);

        build_memory_summary(total_mb, available_mb)
    }

    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let parse_kb = |key: &str| -> u64 {
            raw.lines()
                .find(|l| l.starts_with(key))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        let total_mb = parse_kb("MemTotal:") / 1024;
        let available_mb = parse_kb("MemAvailable:") / 1024;
        build_memory_summary(total_mb, available_mb)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        MemorySummary {
            total_mb: 0,
            available_mb: 0,
            used_pct: 0.0,
            pressure: "unknown".into(),
        }
    }
}

fn build_memory_summary(total_mb: u64, available_mb: u64) -> MemorySummary {
    if total_mb == 0 {
        return MemorySummary {
            total_mb: 0,
            available_mb: 0,
            used_pct: 0.0,
            pressure: "unknown".into(),
        };
    }
    let avail = available_mb.min(total_mb);
    let used_pct = ((total_mb - avail) as f64 / total_mb as f64) * 100.0;
    let pressure = if used_pct >= 90.0 {
        "critical"
    } else if used_pct >= 78.0 {
        "elevated"
    } else {
        "normal"
    };
    MemorySummary {
        total_mb,
        available_mb: avail,
        used_pct: (used_pct * 10.0).round() / 10.0,
        pressure: pressure.into(),
    }
}

fn sample_processes() -> Vec<ProcessEntry> {
    #[cfg(unix)]
    {
        let Ok(out) = Command::new("ps")
            .args(["-axo", "pid=,rss=,comm=,args="])
            .output()
        else {
            return Vec::new();
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut procs = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut parts = trimmed.split_whitespace();
            let Some(pid_s) = parts.next() else { continue };
            let Some(rss_s) = parts.next() else { continue };
            let Some(comm) = parts.next() else { continue };
            let Ok(pid) = pid_s.parse::<u32>() else { continue };
            let Ok(rss_kb) = rss_s.parse::<u64>() else { continue };
            let args: String = parts.collect::<Vec<_>>().join(" ");
            let cmd = if args.is_empty() {
                comm.to_string()
            } else {
                args
            };
            let name = std::path::Path::new(comm)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(comm)
                .to_string();
            procs.push(ProcessEntry {
                pid,
                rss_mb: rss_kb / 1024,
                name,
                command: cmd,
            });
        }
        procs.sort_by(|a, b| b.rss_mb.cmp(&a.rss_mb));
        procs
    }

    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

/// Run the local computer health census. Optionally terminate leaked headless
/// automation browsers (`reap_leaked_browsers = true`) while preserving all
/// interactive browsers, calls, AI desktop apps, and the frontmost app.
pub fn run_health(frontmost_app: Option<&str>, reap_leaked_browsers: bool) -> Value {
    let mem = memory_summary();
    let procs = sample_processes();
    let self_pid = std::process::id();

    let top_processes: Vec<Value> = procs
        .iter()
        .take(10)
        .map(|p| {
            json!({
                "pid": p.pid,
                "name": p.name,
                "rss_mb": p.rss_mb,
            })
        })
        .collect();

    let model_procs: Vec<&ProcessEntry> = procs
        .iter()
        .filter(|p| is_model_runtime(&p.command))
        .collect();
    let model_rss_mb: u64 = model_procs.iter().map(|p| p.rss_mb).sum();
    let model_ram_pct = if mem.total_mb > 0 {
        ((model_rss_mb as f64 / mem.total_mb as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    let leaked_browsers: Vec<&ProcessEntry> = procs
        .iter()
        .filter(|p| is_leaked_headless_browser(p.pid, self_pid, &p.name, &p.command, frontmost_app))
        .collect();

    let mut reaped_pids: Vec<u32> = Vec::new();
    let mut reaped_mb: u64 = 0;

    #[cfg(unix)]
    if reap_leaked_browsers {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        for p in &leaked_browsers {
            if kill(Pid::from_raw(p.pid as i32), Signal::SIGTERM).is_ok() {
                reaped_pids.push(p.pid);
                reaped_mb += p.rss_mb;
            }
        }
    }

    let leaked_list: Vec<Value> = leaked_browsers
        .iter()
        .take(25)
        .map(|p| {
            let preview: String = p.command.chars().take(160).collect();
            json!({
                "pid": p.pid,
                "name": p.name,
                "rss_mb": p.rss_mb,
                "command": preview,
            })
        })
        .collect();

    let mut recommendations: Vec<String> = Vec::new();
    if mem.pressure == "critical" {
        recommendations.push("Memory pressure is critical (>=90% used); close heavy unused processes or unload large local models.".into());
    }
    if !leaked_browsers.is_empty() && !reap_leaked_browsers {
        let leaked_mb: u64 = leaked_browsers.iter().map(|p| p.rss_mb).sum();
        recommendations.push(format!(
            "Detected {} leaked headless browser process(es) (~{} MB). Re-run computer(action=\"health\", clear=true) to safely reap them.",
            leaked_browsers.len(),
            leaked_mb
        ));
    }

    json!({
        "success": true,
        "platform": std::env::consts::OS,
        "frontmost_app": frontmost_app,
        "memory": mem,
        "top_processes": top_processes,
        "local_models": {
            "count": model_procs.len(),
            "rss_mb": model_rss_mb,
            "ram_pct": model_ram_pct,
            "processes": model_procs.iter().take(10).map(|p| json!({
                "pid": p.pid,
                "name": p.name,
                "rss_mb": p.rss_mb,
            })).collect::<Vec<_>>(),
        },
        "leaked_browsers": {
            "count": leaked_browsers.len(),
            "rss_mb": leaked_browsers.iter().map(|p| p.rss_mb).sum::<u64>(),
            "processes": leaked_list,
            "reaped_pids": reaped_pids,
            "reaped_mb": reaped_mb,
        },
        "recommendations": recommendations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_touches_interactive_browser_or_protected_apps() {
        assert!(!is_leaked_headless_browser(
            4200,
            100,
            "Google Chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default",
            Some("Terminal"),
        ));
        assert!(!is_leaked_headless_browser(
            4201,
            100,
            "zoom.us",
            "/Applications/zoom.us.app/Contents/MacOS/zoom.us --headless",
            Some("Terminal"),
        ));
        assert!(!is_leaked_headless_browser(
            4202,
            100,
            "Chromium",
            "/tmp/chromium --headless",
            Some("Chromium"),
        ));
    }

    #[test]
    fn detects_leaked_headless_and_ephemeral_automation_browsers() {
        assert!(is_leaked_headless_browser(
            5100,
            100,
            "chrome-headless-shell",
            "/Users/z/Library/Caches/ms-playwright/chromium/chrome-headless-shell --headless=new",
            Some("Cursor"),
        ));
        assert!(is_leaked_headless_browser(
            5101,
            100,
            "Chromium",
            "/usr/bin/chromium --remote-debugging-port=9222 --user-data-dir=/tmp/pw-profile-123",
            Some("Cursor"),
        ));
        // Must never target self or PID 1
        assert!(!is_leaked_headless_browser(100, 100, "chromium", "chromium --headless", None));
        assert!(!is_leaked_headless_browser(1, 100, "chromium", "chromium --headless", None));
    }

    #[test]
    fn memory_pressure_thresholds() {
        assert_eq!(build_memory_summary(1000, 500).pressure, "normal");
        assert_eq!(build_memory_summary(1000, 180).pressure, "elevated");
        assert_eq!(build_memory_summary(1000, 50).pressure, "critical");
    }
}
