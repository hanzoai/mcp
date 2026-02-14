/// Unified process execution tool (HIP-0300)
///
/// Handles all process operations:
/// - exec: Execute commands (the ONE execution primitive)
/// - wait: Wait for background process
/// - ps: List processes
/// - kill: Kill process
/// - logs: Get process logs

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::RwLock;

/// Auto-background timeout in seconds
const AUTO_BACKGROUND_TIMEOUT: u64 = 45;

/// Process info tracked by the manager
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub proc_id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub started: String,
    pub log_file: Option<PathBuf>,
}

/// Process manager singleton
pub struct ProcessManager {
    processes: Arc<RwLock<HashMap<String, ProcessInfo>>>,
    counter: Arc<RwLock<u64>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(RwLock::new(0)),
        }
    }

    async fn next_id(&self) -> String {
        let mut counter = self.counter.write().await;
        *counter += 1;
        format!("proc_{}", *counter)
    }

    async fn register(&self, info: ProcessInfo) {
        let mut procs = self.processes.write().await;
        procs.insert(info.proc_id.clone(), info);
    }

    async fn update(&self, proc_id: &str, exit_code: i32) {
        let mut procs = self.processes.write().await;
        if let Some(info) = procs.get_mut(proc_id) {
            info.running = false;
            info.exit_code = Some(exit_code);
        }
    }

    pub async fn list(&self) -> HashMap<String, ProcessInfo> {
        self.processes.read().await.clone()
    }

    pub async fn get(&self, proc_id: &str) -> Option<ProcessInfo> {
        self.processes.read().await.get(proc_id).cloned()
    }
}

/// Actions for the proc tool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProcAction {
    Exec,
    Wait,
    Ps,
    Kill,
    Logs,
    Help,
}

impl Default for ProcAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for ProcAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "exec" => Ok(Self::Exec),
            "wait" => Ok(Self::Wait),
            "ps" | "list" => Ok(Self::Ps),
            "kill" => Ok(Self::Kill),
            "logs" | "log" => Ok(Self::Logs),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Arguments for proc tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProcToolArgs {
    #[serde(default)]
    pub action: String,
    /// Command to execute (string or array for Rust parity)
    pub command: Option<Value>,
    /// Working directory
    pub cwd: Option<String>,
    /// Alias for cwd (Rust parity)
    pub workdir: Option<String>,
    /// Environment variables
    pub env: Option<HashMap<String, String>>,
    /// Timeout in seconds
    pub timeout: Option<u64>,
    /// Shell to use
    pub shell: Option<String>,
    /// Process ID for wait/kill/logs
    pub proc_id: Option<String>,
    /// Timeout in milliseconds for wait
    pub timeout_ms: Option<u64>,
    /// Signal for kill
    pub signal: Option<String>,
    /// Number of lines for logs
    pub tail: Option<usize>,
    /// Filter for ps
    pub filter: Option<String>,
}

/// Shell execution tool
pub struct ShellTool {
    manager: Arc<ProcessManager>,
    shell: String,
}

impl ShellTool {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(ProcessManager::new()),
            shell: Self::resolve_shell(),
        }
    }

    fn resolve_shell() -> String {
        // Check environment override
        if let Ok(shell) = std::env::var("HANZO_MCP_FORCE_SHELL") {
            return shell;
        }

        // Prefer zsh, fallback to others
        for shell in ["zsh", "bash", "fish", "dash", "sh"] {
            for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/bin", "/usr/bin"] {
                let path = format!("{}/{}", prefix, shell);
                if std::path::Path::new(&path).exists() {
                    return path;
                }
            }
            if let Ok(found) = which::which(shell) {
                return found.to_string_lossy().to_string();
            }
        }

        "sh".to_string()
    }

    pub async fn execute(&self, args: ProcToolArgs) -> Result<String> {
        let action: ProcAction = if args.action.is_empty() {
            ProcAction::Help
        } else {
            args.action.parse()?
        };

        let result = match action {
            ProcAction::Exec => self.exec(args).await?,
            ProcAction::Wait => self.wait(args).await?,
            ProcAction::Ps => self.ps(args).await?,
            ProcAction::Kill => self.kill(args).await?,
            ProcAction::Logs => self.logs(args).await?,
            ProcAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn exec(&self, args: ProcToolArgs) -> Result<Value> {
        let command = args.command.ok_or_else(|| anyhow!("command required"))?;

        // Support both string and array format
        let cmd_str = match command {
            Value::String(s) => s,
            Value::Array(arr) => {
                // Join array into shell command
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| shell_escape::escape(s.into()).to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            }
            _ => return Err(anyhow!("command must be string or array")),
        };

        let cwd = args.workdir.or(args.cwd);
        let timeout = args.timeout.unwrap_or(AUTO_BACKGROUND_TIMEOUT);
        let shell = args.shell.unwrap_or_else(|| self.shell.clone());

        let proc_id = self.manager.next_id().await;
        let started = chrono::Utc::now().to_rfc3339();

        // Build command
        let mut cmd = Command::new(&shell);
        cmd.arg("-c").arg(&cmd_str);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(ref dir) = cwd {
            cmd.current_dir(dir);
        }

        if let Some(ref env_vars) = args.env {
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

        let start = Instant::now();
        let mut child = cmd.spawn()?;
        let pid = child.id();

        // Register process
        self.manager.register(ProcessInfo {
            proc_id: proc_id.clone(),
            pid,
            command: cmd_str.clone(),
            running: true,
            exit_code: None,
            started: started.clone(),
            log_file: None,
        }).await;

        // Wait with timeout
        let timeout_duration = Duration::from_secs(timeout);
        let result = tokio::time::timeout(timeout_duration, child.wait_with_output()).await;

        match result {
            Ok(Ok(output)) => {
                let exit_code = output.status.code().unwrap_or(-1);
                let duration_ms = start.elapsed().as_millis() as u64;

                self.manager.update(&proc_id, exit_code).await;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();

                Ok(json!({
                    "proc_id": proc_id,
                    "exit_code": exit_code,
                    "stdout": stdout,
                    "stderr": stderr,
                    "duration_ms": duration_ms,
                    "status": if exit_code == 0 { "success" } else { "failed" }
                }))
            }
            Ok(Err(e)) => Err(anyhow!("Process failed: {}", e)),
            Err(_) => {
                // Timeout - process is backgrounded
                Ok(json!({
                    "proc_id": proc_id,
                    "exit_code": null,
                    "stdout_ref": format!("proc:{}:stdout", proc_id),
                    "stderr_ref": format!("proc:{}:stderr", proc_id),
                    "status": "running",
                    "message": format!("Command backgrounded after {}s. Use proc(action='logs', proc_id='{}') to view output.", timeout, proc_id)
                }))
            }
        }
    }

    async fn wait(&self, args: ProcToolArgs) -> Result<Value> {
        let proc_id = args.proc_id.ok_or_else(|| anyhow!("proc_id required"))?;

        let max_timeout_ms = 3_600_000u64; // 1 hour
        let default_timeout_ms = 600_000u64; // 10 minutes
        let timeout_ms = args.timeout_ms.unwrap_or(default_timeout_ms).min(max_timeout_ms);
        let timeout_sec = timeout_ms as f64 / 1000.0;

        let info = self.manager.get(&proc_id).await
            .ok_or_else(|| anyhow!("Process not found: {}", proc_id))?;

        // If already completed, return immediately
        if !info.running {
            return Ok(json!({
                "proc_id": proc_id,
                "exit_code": info.exit_code,
                "output": "",
                "status": "completed"
            }));
        }

        // Poll until complete or timeout
        let start = Instant::now();
        let poll_interval = Duration::from_millis(500);

        loop {
            if start.elapsed().as_secs_f64() >= timeout_sec {
                return Ok(json!({
                    "proc_id": proc_id,
                    "exit_code": null,
                    "output": "",
                    "status": "timeout",
                    "message": format!("Timed out after {}ms", timeout_ms)
                }));
            }

            if let Some(info) = self.manager.get(&proc_id).await {
                if !info.running {
                    return Ok(json!({
                        "proc_id": proc_id,
                        "exit_code": info.exit_code,
                        "output": "",
                        "status": "completed",
                        "duration_ms": start.elapsed().as_millis() as u64
                    }));
                }
            } else {
                return Err(anyhow!("Process disappeared: {}", proc_id));
            }

            tokio::time::sleep(poll_interval).await;
        }
    }

    async fn ps(&self, args: ProcToolArgs) -> Result<Value> {
        let processes = self.manager.list().await;
        let mut results = Vec::new();

        for (id, info) in processes {
            // Filter by proc_id
            if let Some(ref filter_id) = args.proc_id {
                if id != *filter_id {
                    continue;
                }
            }

            // Filter by command pattern
            if let Some(ref filter) = args.filter {
                if !info.command.to_lowercase().contains(&filter.to_lowercase()) {
                    continue;
                }
            }

            results.push(json!({
                "proc_id": info.proc_id,
                "pid": info.pid,
                "command": info.command,
                "running": info.running,
                "exit_code": info.exit_code,
                "started": info.started
            }));
        }

        Ok(json!({
            "processes": results,
            "total": results.len()
        }))
    }

    async fn kill(&self, args: ProcToolArgs) -> Result<Value> {
        let proc_id = args.proc_id.ok_or_else(|| anyhow!("proc_id required"))?;

        let info = self.manager.get(&proc_id).await
            .ok_or_else(|| anyhow!("Process not found: {}", proc_id))?;

        let pid = info.pid.ok_or_else(|| anyhow!("Process has no PID"))?;

        // Resolve signal
        let sig = match args.signal.as_deref() {
            Some("KILL") | Some("9") => 9,
            Some("INT") | Some("2") => 2,
            Some("HUP") | Some("1") => 1,
            Some("QUIT") | Some("3") => 3,
            _ => 15, // TERM
        };

        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;

            let signal = Signal::try_from(sig).unwrap_or(Signal::SIGTERM);
            match kill(Pid::from_raw(pid as i32), signal) {
                Ok(_) => Ok(json!({
                    "proc_id": proc_id,
                    "pid": pid,
                    "signal": sig,
                    "killed": true
                })),
                Err(nix::errno::Errno::ESRCH) => Ok(json!({
                    "proc_id": proc_id,
                    "pid": pid,
                    "signal": sig,
                    "killed": false,
                    "message": "Process already terminated"
                })),
                Err(e) => Err(anyhow!("Cannot kill process: {}", e)),
            }
        }

        #[cfg(not(unix))]
        {
            Err(anyhow!("kill not supported on this platform"))
        }
    }

    async fn logs(&self, args: ProcToolArgs) -> Result<Value> {
        let proc_id = args.proc_id.ok_or_else(|| anyhow!("proc_id required"))?;

        let info = self.manager.get(&proc_id).await
            .ok_or_else(|| anyhow!("Process not found: {}", proc_id))?;

        // If log file exists, read it
        if let Some(ref log_file) = info.log_file {
            if log_file.exists() {
                let content = tokio::fs::read_to_string(log_file).await?;
                let lines: Vec<&str> = content.lines().collect();
                let total_lines = lines.len();
                let tail = args.tail.unwrap_or(100);
                let output = if total_lines > tail {
                    lines[total_lines - tail..].join("\n")
                } else {
                    content
                };

                return Ok(json!({
                    "proc_id": proc_id,
                    "output": output,
                    "running": info.running,
                    "exit_code": info.exit_code,
                    "total_lines": total_lines
                }));
            }
        }

        Ok(json!({
            "proc_id": proc_id,
            "stdout": "",
            "stderr": "",
            "message": "No log file available"
        }))
    }

    fn help(&self) -> Result<Value> {
        let shell_name = std::path::Path::new(&self.shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sh");

        Ok(json!({
            "name": "proc",
            "version": "0.12.0",
            "description": format!("Unified process execution tool (HIP-0300). Shell: {}", shell_name),
            "actions": {
                "exec": "Execute command (the ONE execution primitive)",
                "wait": "Wait for background process to complete",
                "ps": "List processes",
                "kill": "Kill process",
                "logs": "Get process logs"
            },
            "returns": "proc_id, exit_code, stdout, stderr",
            "auto_background": format!("{}s", AUTO_BACKGROUND_TIMEOUT)
        }))
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct ShellToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl ShellToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "proc".to_string(),
            description: format!(
                r#"Unified process execution tool (HIP-0300).

Actions:
- exec: Execute command (the ONE primitive)
- wait: Wait for background process
- ps: List processes
- kill: Kill process
- logs: Get process logs

Returns: {{proc_id, exit_code, stdout, stderr}}
Auto-backgrounds commands after {}s."#,
                AUTO_BACKGROUND_TIMEOUT
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["exec", "wait", "ps", "kill", "logs", "help"],
                        "default": "help",
                        "description": "Action to perform"
                    },
                    "command": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}}
                        ],
                        "description": "Command to execute (string or array)"
                    },
                    "cwd": {"type": "string", "description": "Working directory"},
                    "workdir": {"type": "string", "description": "Alias for cwd (Rust parity)"},
                    "env": {
                        "type": "object",
                        "additionalProperties": {"type": "string"},
                        "description": "Environment variables"
                    },
                    "timeout": {"type": "integer", "description": "Timeout in seconds"},
                    "shell": {"type": "string", "description": "Shell to use"},
                    "proc_id": {"type": "string", "description": "Process ID"},
                    "timeout_ms": {"type": "integer", "description": "Wait timeout in milliseconds"},
                    "signal": {"type": "string", "description": "Kill signal"},
                    "tail": {"type": "integer", "description": "Number of log lines"},
                    "filter": {"type": "string", "description": "Filter for ps"}
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_exec_simple() {
        let tool = ShellTool::new();
        let args = ProcToolArgs {
            action: "exec".to_string(),
            command: Some(Value::String("echo hello".to_string())),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("hello"));
    }

    #[tokio::test]
    async fn test_exec_array_command() {
        let tool = ShellTool::new();
        let args = ProcToolArgs {
            action: "exec".to_string(),
            command: Some(Value::Array(vec![
                Value::String("echo".to_string()),
                Value::String("hello world".to_string()),
            ])),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_ps() {
        let tool = ShellTool::new();
        let args = ProcToolArgs {
            action: "ps".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("processes"));
    }

    #[tokio::test]
    async fn test_help() {
        let tool = ShellTool::new();
        let args = ProcToolArgs {
            action: "help".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("proc"));
        assert!(output.contains("exec"));
    }
}
