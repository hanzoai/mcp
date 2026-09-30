//! `npx` and `uvx` — run a package as python-sdk's tools of those names do:
//! `package`, whitespace-split `args`, `cwd`, npx's `yes` and uvx's
//! `python`. Each is an `exec` of the argv it builds, with no shell and a
//! two-minute auto-background, so a long-running one shows up in `exec ps`
//! and its output in `exec logs`.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

/// Seconds before a package run keeps going in the background.
pub const BACKGROUND: u64 = 120;

/// The tools this module serves.
pub const TOOLS: &[&str] = &["npx", "uvx"];

/// The argv `tool` runs for these parameters.
pub fn argv(tool: &str, p: &Value) -> Result<Vec<String>> {
    let package = p.get("package").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("package required"))?;
    let mut argv = vec![tool.to_string()];
    match tool {
        "npx" if p.get("yes").and_then(Value::as_bool).unwrap_or(true) => argv.push("-y".into()),
        "uvx" => {
            if let Some(py) = p.get("python").and_then(Value::as_str) {
                argv.extend(["--python".to_string(), py.to_string()]);
            }
        }
        _ => {}
    }
    argv.push(package.to_string());
    argv.extend(p.get("args").and_then(Value::as_str).unwrap_or("").split_whitespace().map(String::from));
    Ok(argv)
}

/// The MCP definition of `tool`.
pub fn definition(tool: &str) -> Value {
    let (description, extra) = match tool {
        "npx" => (
            "Run npx packages with automatic backgrounding for long-running processes.\n\nCommands that run for more than 2 minutes will automatically continue in the background.\n\nUsage:\nnpx create-react-app my-app\nnpx http-server -p 8080  # Auto-backgrounds after 2 minutes\nnpx prettier --write \"**/*.js\"\nnpx json-server db.json  # Auto-backgrounds if needed",
            json!({"yes": {"type": "boolean", "default": true, "description": "Pass -y"}}),
        ),
        _ => (
            "Run Python packages with uvx with automatic backgrounding for long-running processes.\n\nCommands that run for more than 2 minutes will automatically continue in the background.\n\nUsage:\nuvx ruff check .\nuvx mkdocs serve  # Auto-backgrounds after 2 minutes\nuvx black --check src/\nuvx jupyter lab --port 8888  # Auto-backgrounds if needed",
            json!({"python": {"type": "string", "description": "Python version for uvx --python"}}),
        ),
    };
    let mut props = json!({
        "package": {"type": "string", "description": "The package (and its command)"},
        "args": {"type": "string", "default": "", "description": "Arguments, split on whitespace"},
        "cwd": {"type": "string", "description": "Working directory"}
    });
    props.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
    json!({
        "name": tool,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": ["package"]}
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_matches_python() {
        let p = json!({"package": "prettier", "args": "--write  src/a.js"});
        assert_eq!(argv("npx", &p).unwrap(), ["npx", "-y", "prettier", "--write", "src/a.js"]);
        assert_eq!(argv("npx", &json!({"package": "x", "yes": false})).unwrap(), ["npx", "x"]);
        assert_eq!(argv("uvx", &json!({"package": "ruff", "args": "check .", "python": "3.12"})).unwrap(), ["uvx", "--python", "3.12", "ruff", "check", "."]);
        assert!(argv("uvx", &json!({})).is_err());
    }
}
