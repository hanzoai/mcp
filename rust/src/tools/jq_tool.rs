//! `jq` — JSON through jq with no shell in between, as python-sdk's `jq`
//! tool: the filter is one argv word, so `!`, `|` and quotes need no escaping.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::{MCPTool, ToolResult};

const DESCRIPTION: &str = r#"JSON processor - jq without shell escaping issues.

Examples:
  jq --filter ".result.data" --input '{"result": {"data": [1,2,3]}}'
  jq --filter ".[] | select(.active)" --file data.json
  jq --filter "keys" --input '{"a": 1, "b": 2}'
  jq --filter '.checks | to_entries[] | select(.value.error != null)' --file health.json

Parameters:
  filter: jq filter expression (required)
  input: JSON input as string
  file: Path to JSON file (alternative to input)
  raw: Output raw strings without quotes (default: false)
  compact: Compact output (default: false)
  slurp: Read entire input as single array (default: false)
  sort_keys: Sort object keys (default: false)

The filter is passed directly to jq without shell interpretation,
so you don't need to escape special characters like ! or |
"#;

pub struct JqTool;

impl JqTool {
    pub fn new() -> Self {
        Self
    }

    /// jq's output, or why there is none.
    pub async fn run(&self, p: &Value) -> std::result::Result<String, String> {
        let s = |k: &str| p.get(k).and_then(Value::as_str);
        let on = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
        let filter = s("filter").ok_or("Error: 'filter' is required")?;
        let (input, file) = (s("input").filter(|i| !i.is_empty()), s("file").filter(|f| !f.is_empty()));
        if input.is_none() && file.is_none() {
            return Err("Error: Either 'input' or 'file' is required".into());
        }
        if let Some(i) = input {
            serde_json::from_str::<Value>(i).map_err(|e| format!("Error: Invalid JSON input: {e}"))?;
        }
        let mut cmd = tokio::process::Command::new("jq");
        for (flag, key) in [("-r", "raw"), ("-c", "compact"), ("-s", "slurp"), ("-S", "sort_keys")] {
            if on(key) {
                cmd.arg(flag);
            }
        }
        cmd.arg(filter);
        if let Some(f) = file {
            cmd.arg(f);
        }
        cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "Error: jq not found. Install jq: brew install jq".to_string(),
            _ => format!("Error: {e}"),
        })?;
        if let (Some(i), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin.write_all(i.as_bytes()).await.map_err(|e| format!("Error: {e}"))?;
        }
        let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
            .await
            .map_err(|_| "jq timed out after 30s".to_string())?
            .map_err(|e| format!("Error: {e}"))?;
        let errors = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            return Err(if errors.to_lowercase().contains("syntax error") {
                format!("jq syntax error in filter:\n  {filter}\n\nError: {errors}")
            } else {
                format!("jq failed (exit {}):\n{errors}", out.status.code().unwrap_or(-1))
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    }
}

impl Default for JqTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for JqTool {
    fn name(&self) -> &str {
        "jq"
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filter": {"type": "string", "description": "jq filter expression"},
                "input": {"type": "string", "description": "JSON input string"},
                "file": {"type": "string", "description": "Path to JSON file"},
                "raw": {"type": "boolean", "default": false, "description": "Output raw strings"},
                "compact": {"type": "boolean", "default": false, "description": "Compact output"},
                "slurp": {"type": "boolean", "default": false, "description": "Read as single array"},
                "sort_keys": {"type": "boolean", "default": false, "description": "Sort object keys"}
            },
            "required": ["filter"]
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        Ok(match self.run(&params).await {
            Ok(out) => ToolResult::ok(Value::String(out)),
            Err(e) => ToolResult::err(&e),
        })
    }
}
