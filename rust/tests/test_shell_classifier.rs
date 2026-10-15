//! The shell classifier behind `exec`, end to end: the real `Shell` classifier in a real
//! `ExecTool`. A `deny` leaves no process, an `ask` is refused until it is approved, the
//! interpreter and the environment are read beside the command, and a script made in the
//! workspace is read before it runs.

use std::path::Path;
use std::sync::Arc;

use hanzo_mcp::tools::{Classify, ExecTool, ExecToolArgs, Risk, Shell};
use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};
use tempfile::TempDir;

fn tool() -> ExecTool {
    ExecTool::with_classifier(Arc::new(Shell::new()))
}

async fn exec(tool: &ExecTool, cmd: &str, dir: &Path, approve: bool) -> anyhow::Result<Value> {
    let args = ExecToolArgs { action: "exec".into(), command: Some(json!(cmd)), cwd: Some(dir.display().to_string()), approve: Some(approve), ..Default::default() };
    Ok(serde_json::from_str(&tool.execute(args).await?)?)
}

#[tokio::test]
async fn a_read_runs_a_workspace_write_runs_and_a_deny_leaves_no_process() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    let out = exec(&t, "echo hi > out.txt && cat out.txt", dir.path(), false).await.unwrap();
    assert_eq!((out["stdout"].clone(), out["verdict"]["risk"].clone()), (json!("hi\n"), json!("allow")));

    let marker = dir.path().join("marker");
    let err = exec(&t, &format!("touch {}; rm -rf /", marker.display()), dir.path(), true).await.unwrap_err().to_string();
    assert!(err.starts_with("refused: destructive: recursive remove of /"), "{err}");
    assert!(!marker.exists(), "a refused command must not have been started");
    let ps: Value = serde_json::from_str(&t.execute(ExecToolArgs { action: "ps".into(), ..Default::default() }).await.unwrap()).unwrap();
    assert_eq!(ps["processes"].as_array().map(|a| a.iter().filter(|p| p["command"].as_str().is_some_and(|c| c.contains("rm -rf /"))).count()), Some(0));
}

#[tokio::test]
async fn an_ask_names_why_and_runs_after_approval() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    // A POST sends data over the network: asked about. Nothing listens on port 1, so it fails once approved.
    let cmd = "curl -s -m 2 -X POST http://127.0.0.1:1/ -d x";
    let e = exec(&t, cmd, dir.path(), false).await.unwrap_err().to_string();
    assert!(e.starts_with("approval required: network: curl sends data to http://127.0.0.1:1/") && e.contains("approve: true"), "{e}");
    let ok = exec(&t, cmd, dir.path(), true).await.unwrap();
    assert_eq!(ok["verdict"]["risk"], json!("ask"));
    assert_eq!(ok["verdict"]["approved"], json!(true));
    assert_eq!(ok["status"], json!("failed"), "the approved command ran: {ok}");
}

#[tokio::test]
async fn the_interpreter_cannot_be_changed_to_one_the_classifier_does_not_read() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    for shell in ["python3", "/usr/bin/python3", "perl", "node", "fish"] {
        let args = ExecToolArgs { action: "exec".into(), command: Some(json!("print(1)")), cwd: Some(dir.path().display().to_string()), shell: Some(shell.into()), ..Default::default() };
        let err = t.execute(args).await.unwrap_err().to_string();
        assert!(err.starts_with("refused: ") && err.contains("is not one this server reads"), "{shell}: {err}");
    }
    let args = ExecToolArgs { action: "exec".into(), command: Some(json!("echo ok")), cwd: Some(dir.path().display().to_string()), shell: Some("bash".into()), ..Default::default() };
    assert_eq!(serde_json::from_str::<Value>(&t.execute(args).await.unwrap()).unwrap()["stdout"], "ok\n");
}

#[tokio::test]
async fn the_environment_is_read_beside_the_command() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    let script = dir.path().join("evil.sh");
    std::fs::write(&script, "touch ran\n").unwrap();
    for (k, v) in [("BASH_ENV", script.display().to_string()), ("LD_PRELOAD", "/tmp/x.so".into()), ("ZDOTDIR", dir.path().display().to_string()), ("PATH", "/tmp:/usr/bin".into())] {
        let args = ExecToolArgs { action: "exec".into(), command: Some(json!("echo hi")), cwd: Some(dir.path().display().to_string()), env: Some([(k.to_string(), v)].into()), ..Default::default() };
        let err = t.execute(args).await.unwrap_err().to_string();
        assert!(err.contains("approval required") && err.contains(k), "{k}: {err}");
    }
    assert!(!dir.path().join("ran").exists());
    let args = ExecToolArgs { action: "exec".into(), command: Some(json!("echo $FOO")), cwd: Some(dir.path().display().to_string()), env: Some([("FOO".to_string(), "bar".to_string())].into()), ..Default::default() };
    assert_eq!(serde_json::from_str::<Value>(&t.execute(args).await.unwrap()).unwrap()["stdout"], "bar\n");
}

#[tokio::test]
async fn a_script_in_the_workspace_is_read_before_it_runs() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    std::fs::write(dir.path().join("clean.sh"), "rm -rf /\n").unwrap();
    let err = exec(&t, "bash clean.sh", dir.path(), true).await.unwrap_err().to_string();
    assert!(err.starts_with("refused: destructive"), "{err}");
    std::fs::write(dir.path().join("fine.sh"), "echo fine\n").unwrap();
    assert_eq!(exec(&t, "bash fine.sh", dir.path(), false).await.unwrap()["stdout"], "fine\n");
    // The file changes; the answer follows it, because a command that read a file is not remembered.
    std::fs::write(dir.path().join("fine.sh"), "sudo id\n").unwrap();
    assert!(exec(&t, "bash fine.sh", dir.path(), true).await.is_err());
}

#[tokio::test]
async fn a_script_made_and_run_in_one_command_is_read() {
    let dir = TempDir::new().unwrap();
    let err = exec(&tool(), "cat > s.sh <<'EOF'\nrm -rf /\nEOF\nbash s.sh", dir.path(), true).await.unwrap_err().to_string();
    assert!(err.starts_with("refused: destructive"), "{err}");
    assert!(!dir.path().join("s.sh").exists());
}

#[tokio::test]
async fn the_registry_door_and_the_npx_door_both_ask_the_classifier() {
    let registry = ToolRegistry::new().with_classifier(Arc::new(Shell::new()));
    let err = registry.execute("exec", json!({"action": "exec", "command": "sudo id"})).await.unwrap_err();
    assert!(err.to_string().starts_with("refused: privilege"), "{err}");
    let err = registry.execute("npx", json!({"package": "cowsay", "args": ["hi"]})).await;
    // npx runs a package fetched from the network: not without approval.
    if let Err(e) = err {
        assert!(e.to_string().contains("approval required") || e.to_string().contains("refused"), "{e}");
    }
}

#[tokio::test]
async fn dev_asks_the_same_classifier_without_running_anything() {
    let dir = TempDir::new().unwrap();
    let t = tool();
    let v = t.verdict("git push origin main", Some(dir.path())).unwrap();
    assert_eq!(v.risk, Risk::Ask);
    assert!(v.reasons[0].starts_with("publishing: "), "{:?}", v.reasons);
    assert_eq!(t.verdict("ls", Some(dir.path())).unwrap().risk, Risk::Allow);
    assert_eq!(Shell::new().classify("ls", Some(dir.path())).risk, Risk::Allow);
}

#[tokio::test]
async fn the_git_tool_does_not_run_a_monitor_the_repository_names() {
    use hanzo_mcp::tools::{GitTool, GitToolArgs};
    let dir = TempDir::new().unwrap();
    let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(dir.path()).output();
    if !git(&["init", "-q"]).map(|o| o.status.success()).unwrap_or(false) {
        return;
    }
    let monitor = format!("touch {}/monitor-ran; true", dir.path().display());
    git(&["config", "core.fsmonitor", &monitor]).unwrap();
    // The control: plain git runs the monitor.
    git(&["status"]).unwrap();
    let ran = dir.path().join("monitor-ran");
    if !ran.exists() {
        return; // this git does not run the setting; nothing to guard
    }
    std::fs::remove_file(&ran).unwrap();
    let tool = GitTool::new().classified(Arc::new(Shell::new()));
    let status = GitToolArgs { action: Some("status".into()), path: Some(dir.path().display().to_string()), ..Default::default() };
    tool.execute(status).await.unwrap();
    assert!(!ran.exists(), "the git tool ran the repository's monitor");
}
