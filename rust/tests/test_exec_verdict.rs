//! `exec` and the classifier seam: a `deny` runs nothing, an `ask` runs only with `approve: true`
//! and says so, and with no classifier installed `exec` answers as it always has.

use std::path::Path;
use std::sync::{Arc, Mutex};

use hanzo_mcp::tools::{Classify, ExecTool, ExecToolArgs, Risk, Verdict};
use hanzo_mcp::ToolRegistry;
use serde_json::{json, Value};
use tempfile::TempDir;

/// Classifies by the first word, and remembers what it was asked.
struct ByWord {
    asked: Mutex<Vec<(String, Option<String>)>>,
}

impl ByWord {
    fn new() -> Arc<ByWord> {
        Arc::new(ByWord { asked: Mutex::new(Vec::new()) })
    }
}

impl Classify for ByWord {
    fn classify(&self, command: &str, cwd: Option<&Path>) -> Verdict {
        self.asked.lock().unwrap().push((command.to_string(), cwd.map(|c| c.display().to_string())));
        match command.split_whitespace().next() {
            Some("rm") => Verdict::new(Risk::Deny, ["rm is never run from here"]),
            Some("git") => Verdict::new(Risk::Ask, ["reaches a remote"]),
            _ => Verdict::allow(),
        }
    }
}

async fn run(tool: &ExecTool, command: Value, cwd: Option<&Path>) -> anyhow::Result<Value> {
    run_with(tool, command, cwd, None).await
}

async fn run_with(tool: &ExecTool, command: Value, cwd: Option<&Path>, approve: Option<bool>) -> anyhow::Result<Value> {
    let args = ExecToolArgs {
        action: "exec".into(),
        command: Some(command),
        cwd: cwd.map(|c| c.display().to_string()),
        approve,
        ..Default::default()
    };
    Ok(serde_json::from_str(&tool.execute(args).await?)?)
}

#[tokio::test]
async fn a_deny_runs_nothing_and_registers_no_process() {
    let dir = TempDir::new().unwrap();
    let marker = dir.path().join("marker");
    let tool = ExecTool::with_classifier(ByWord::new());
    let err = run(&tool, json!(format!("rm -f x; touch {}", marker.display())), Some(dir.path())).await.unwrap_err();
    assert_eq!(err.to_string(), "refused: rm is never run from here");
    assert!(!marker.exists(), "a refused command must not have been started");

    let ps: Value = serde_json::from_str(&tool.execute(ExecToolArgs { action: "ps".into(), ..Default::default() }).await.unwrap()).unwrap();
    assert_eq!(ps["total"], 0);
}

#[tokio::test]
async fn an_allow_runs_and_an_ask_runs_only_when_approved() {
    let dir = TempDir::new().unwrap();
    let tool = ExecTool::with_classifier(ByWord::new());

    let allow = run(&tool, json!("echo hello"), Some(dir.path())).await.unwrap();
    assert_eq!((allow["status"].clone(), allow["stdout"].clone()), (json!("success"), json!("hello\n")));
    assert_eq!(allow["verdict"], json!({"risk": "allow", "reasons": []}));

    // `git --version` runs offline; the verdict is what the classifier said of the word.
    let refused = run(&tool, json!("git --version"), Some(dir.path())).await.unwrap_err().to_string();
    assert!(refused.starts_with("approval required: reaches a remote") && refused.contains("approve: true"), "{refused}");
    let no = run_with(&tool, json!("git --version"), Some(dir.path()), Some(false)).await.unwrap_err().to_string();
    assert!(no.starts_with("approval required"), "{no}");

    let ask = run_with(&tool, json!("git --version"), Some(dir.path()), Some(true)).await.unwrap();
    assert_eq!(ask["verdict"], json!({"risk": "ask", "reasons": ["reaches a remote"], "approved": true}));
    assert!(ask["exit_code"].is_number(), "an approved ask runs: {ask}");
    // An approval buys an ask and nothing else.
    let deny = run_with(&tool, json!("rm x"), Some(dir.path()), Some(true)).await.unwrap_err().to_string();
    assert_eq!(deny, "refused: rm is never run from here");
}

#[tokio::test]
async fn the_classifier_sees_the_command_as_it_would_run() {
    let dir = TempDir::new().unwrap();
    let c = ByWord::new();
    let tool = ExecTool::with_classifier(c.clone());
    // An argv array is joined, quoted, as exec runs it.
    run(&tool, json!(["echo", "a b", "c"]), Some(dir.path())).await.unwrap();
    let asked = c.asked.lock().unwrap().clone();
    assert_eq!(asked, vec![("echo 'a b' c".to_string(), Some(dir.path().display().to_string()))]);
}

#[tokio::test]
async fn a_backgrounded_run_carries_its_verdict_too() {
    let tool = ExecTool::with_classifier(ByWord::new());
    let args = ExecToolArgs { action: "exec".into(), command: Some(json!("sleep 5")), timeout: Some(0), ..Default::default() };
    let out: Value = serde_json::from_str(&tool.execute(args).await.unwrap()).unwrap();
    assert_eq!(out["status"], "running");
    assert_eq!(out["verdict"]["risk"], "allow");
    let pid = out["proc_id"].as_str().unwrap().to_string();
    let _ = tool.execute(ExecToolArgs { action: "kill".into(), proc_id: Some(pid), ..Default::default() }).await;
}

#[tokio::test]
async fn with_no_classifier_exec_answers_as_before() {
    let tool = ExecTool::new();
    let out = run(&tool, json!("echo hi"), None).await.unwrap();
    assert_eq!(out["stdout"], "hi\n");
    assert!(out.get("verdict").is_none());
    assert_eq!(tool.verdict("rm -rf /", None), None);
    let out = run(&tool, json!("true"), None).await.unwrap();
    assert!(out.get("verdict").is_none());
}

#[tokio::test]
async fn dev_asks_the_same_classifier_without_running_anything() {
    let tool = ExecTool::with_classifier(ByWord::new());
    assert_eq!(tool.verdict("rm a", None), Some(Verdict::new(Risk::Deny, ["rm is never run from here"])));
    assert_eq!(tool.verdict("ls", None).unwrap().risk, Risk::Allow);
}

#[tokio::test]
async fn the_registry_door_refuses_a_deny_as_a_tool_error() {
    let registry = ToolRegistry::new().with_classifier(ByWord::new());
    let err = registry.execute("exec", json!({"action": "exec", "command": "rm x", "approve": true})).await.unwrap_err();
    assert_eq!(err.to_string(), "refused: rm is never run from here");
    let err = registry.execute("exec", json!({"action": "exec", "command": "git --version"})).await.unwrap_err();
    assert!(err.to_string().starts_with("approval required"), "{err}");
    let ok = registry.execute("exec", json!({"action": "exec", "command": "echo hi"})).await.unwrap();
    assert!(ok.success);
    assert_eq!(ok.content["verdict"]["risk"], "allow");
}
