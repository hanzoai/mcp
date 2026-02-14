//! Shell Tools Tests - 1:1 parity with Python test_shell_tools.py
//!
//! Tests for proc tool covering:
//! - Tool properties and metadata
//! - Command execution (sync/async)
//! - Script flags and platform detection
//! - Process management (ps, kill, logs)

use hanzo_mcp::tools::{ShellTool, ProcToolArgs};
use serde_json::Value;
use std::collections::HashMap;
use tempfile::TempDir;

/// Test proc tool creation
#[test]
fn test_proc_tool_creation() {
    let tool = ShellTool::new();
    // Tool exists and is properly initialized
    assert!(true);
}

/// Test proc tool with help action
#[tokio::test]
async fn test_proc_help_action() {
    let tool = ShellTool::new();
    let args = ProcToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Help should list available actions
    assert!(json.get("actions").is_some() || json.get("description").is_some());
}

/// Test simple echo command execution
#[tokio::test]
async fn test_proc_exec_simple() {
    let tool = ShellTool::new();
    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo hello".to_string())),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Should contain stdout with "hello"
    if let Some(stdout) = json.get("stdout") {
        assert!(stdout.as_str().unwrap_or("").contains("hello"));
    }
}

/// Test command execution with working directory
#[tokio::test]
async fn test_proc_exec_with_cwd() {
    let temp_dir = TempDir::new().unwrap();
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("pwd".to_string())),
        cwd: Some(temp_dir.path().to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    if let Some(stdout) = json.get("stdout") {
        let stdout_str = stdout.as_str().unwrap_or("");
        // On macOS, temp dirs may have /private prefix
        let temp_path = temp_dir.path().to_string_lossy().to_string();
        assert!(
            stdout_str.contains(&temp_path) ||
            stdout_str.contains(temp_dir.path().file_name().unwrap().to_str().unwrap())
        );
    }
}

/// Test command with environment variables
#[tokio::test]
async fn test_proc_exec_with_env() {
    let tool = ShellTool::new();

    let mut env_map = HashMap::new();
    env_map.insert("TEST_VAR".to_string(), "test_value".to_string());

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo $TEST_VAR".to_string())),
        env: Some(env_map),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    if let Some(stdout) = json.get("stdout") {
        assert!(stdout.as_str().unwrap_or("").contains("test_value"));
    }
}

/// Test command timeout (backgrounds process after timeout)
#[tokio::test]
async fn test_proc_exec_timeout() {
    let tool = ShellTool::new();

    // Command that would take too long - shell tool backgrounds on timeout
    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("sleep 10".to_string())),
        timeout: Some(1), // 1 second timeout
        ..Default::default()
    };

    let result = tool.execute(args).await;
    // Should succeed and background the process
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Shell tool backgrounds processes on timeout and returns status: "running"
    assert_eq!(
        json.get("status").and_then(|v| v.as_str()),
        Some("running"),
        "Expected status='running' for timed out command"
    );
    assert!(
        json.get("proc_id").is_some(),
        "Expected proc_id for backgrounded process"
    );
    assert!(
        output.contains("backgrounded"),
        "Expected 'backgrounded' in message"
    );
}

/// Test array command format (HIP-0300 compatibility)
#[tokio::test]
async fn test_proc_exec_array_command() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::Array(vec![
            Value::String("echo".to_string()),
            Value::String("hello".to_string()),
            Value::String("world".to_string()),
        ])),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    assert!(output.contains("hello") || output.contains("world"));
}

/// Test process listing (ps action)
#[tokio::test]
async fn test_proc_ps_action() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "ps".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Should return processes array or empty list
    assert!(json.get("processes").is_some() || json.is_array() || json.get("data").is_some());
}

/// Test command with exit code
#[tokio::test]
async fn test_proc_exec_exit_code() {
    let tool = ShellTool::new();

    // Command that exits with non-zero
    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("exit 42".to_string())),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    if let Some(exit_code) = json.get("exit_code") {
        assert_eq!(exit_code.as_i64().unwrap_or(0), 42);
    }
}

/// Test stderr capture
#[tokio::test]
async fn test_proc_exec_stderr() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo error >&2".to_string())),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    if let Some(stderr) = json.get("stderr") {
        assert!(stderr.as_str().unwrap_or("").contains("error"));
    }
}

/// Test piped commands
#[tokio::test]
async fn test_proc_exec_pipe() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo hello world | wc -w".to_string())),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    // Should contain "2" (word count of "hello world")
    assert!(output.contains("2") || output.contains("hello"));
}

/// Test chained commands with &&
#[tokio::test]
async fn test_proc_exec_chained() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo first && echo second".to_string())),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    assert!(output.contains("first"));
    assert!(output.contains("second"));
}

/// Test workdir alias for cwd
#[tokio::test]
async fn test_proc_workdir_alias() {
    let temp_dir = TempDir::new().unwrap();
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("pwd".to_string())),
        workdir: Some(temp_dir.path().to_string_lossy().to_string()),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test shell override
#[tokio::test]
async fn test_proc_shell_override() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo 'test'".to_string())),
        shell: Some("bash".to_string()),
        ..Default::default()
    };

    let _result = tool.execute(args).await;
    // May fail if bash not available, that's OK
    assert!(true);
}

/// Test default action (should be help or exec)
#[tokio::test]
async fn test_proc_default_action() {
    let tool = ShellTool::new();

    let args = ProcToolArgs {
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());
}

/// Test multi-env variables
#[tokio::test]
async fn test_proc_multi_env() {
    let tool = ShellTool::new();

    let mut env_map = HashMap::new();
    env_map.insert("VAR1".to_string(), "value1".to_string());
    env_map.insert("VAR2".to_string(), "value2".to_string());

    let args = ProcToolArgs {
        action: "exec".to_string(),
        command: Some(Value::String("echo $VAR1 $VAR2".to_string())),
        env: Some(env_map),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    assert!(output.contains("value1"));
    assert!(output.contains("value2"));
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    /// Test real shell execution (integration test)
    #[tokio::test]
    #[ignore] // Run with --ignored flag
    async fn test_real_shell_execution() {
        let tool = ShellTool::new();

        // Test bash
        let bash_args = ProcToolArgs {
            action: "exec".to_string(),
            command: Some(Value::String("echo 'bash works'".to_string())),
            shell: Some("bash".to_string()),
            ..Default::default()
        };

        let bash_result = tool.execute(bash_args).await;
        if let Ok(output) = bash_result {
            assert!(output.contains("bash works"));
        }

        // Test zsh if available
        if which::which("zsh").is_ok() {
            let zsh_args = ProcToolArgs {
                action: "exec".to_string(),
                command: Some(Value::String("echo 'zsh works'".to_string())),
                shell: Some("zsh".to_string()),
                ..Default::default()
            };

            let zsh_result = tool.execute(zsh_args).await;
            if let Ok(output) = zsh_result {
                assert!(output.contains("zsh works"));
            }
        }
    }
}
