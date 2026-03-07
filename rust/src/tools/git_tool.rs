/// Unified version control tool (HIP-0300)
///
/// Handles all VCS operations:
/// - status: Working tree status
/// - diff: Show differences
/// - apply: Apply patch
/// - commit: Create commit
/// - branch: Branch operations
/// - checkout: Switch branches
/// - log: Commit history

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VcsAction {
    Status,
    Diff,
    Apply,
    Commit,
    Branch,
    Checkout,
    Log,
    Help,
}

impl Default for VcsAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for VcsAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "status" | "st" => Ok(Self::Status),
            "diff" | "d" => Ok(Self::Diff),
            "apply" | "patch" => Ok(Self::Apply),
            "commit" | "ci" => Ok(Self::Commit),
            "branch" | "br" => Ok(Self::Branch),
            "checkout" | "co" | "switch" => Ok(Self::Checkout),
            "log" | "history" => Ok(Self::Log),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitToolArgs {
    pub action: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
    pub branch: Option<String>,
    pub patch: Option<String>,
    pub count: Option<usize>,
    pub staged: Option<bool>,
}

pub struct GitToolDefinition;

impl GitToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "git",
            "description": "Version control: status, diff, apply, commit, branch, checkout, log",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "diff", "apply", "commit", "branch", "checkout", "log", "help"],
                        "description": "VCS action"
                    },
                    "path": { "type": "string", "description": "Repository path", "default": "." },
                    "message": { "type": "string", "description": "Commit message" },
                    "branch": { "type": "string", "description": "Branch name" },
                    "patch": { "type": "string", "description": "Patch content for apply" },
                    "count": { "type": "number", "description": "Number of log entries", "default": 10 },
                    "staged": { "type": "boolean", "description": "Show staged changes only" }
                },
                "required": ["action"]
            }
        })
    }
}

pub struct GitTool {
    cwd: String,
}

impl GitTool {
    pub fn new() -> Self {
        Self {
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
        }
    }

    pub async fn execute(&self, args: GitToolArgs) -> Result<Value> {
        let action: VcsAction = args.action.as_deref().unwrap_or("help").parse()?;
        let cwd = args.path.as_deref().unwrap_or(&self.cwd);

        match action {
            VcsAction::Status => self.status(cwd).await,
            VcsAction::Diff => self.diff(cwd, &args).await,
            VcsAction::Apply => self.apply(cwd, &args).await,
            VcsAction::Commit => self.commit(cwd, &args).await,
            VcsAction::Branch => self.branch(cwd, &args).await,
            VcsAction::Checkout => self.checkout(cwd, &args).await,
            VcsAction::Log => self.log(cwd, &args).await,
            VcsAction::Help => Ok(self.help()),
        }
    }

    async fn git(&self, cwd: &str, args: &[&str]) -> Result<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .await?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(anyhow!("git error: {}", stderr.trim()))
        }
    }

    async fn status(&self, cwd: &str) -> Result<Value> {
        let out = self.git(cwd, &["status", "--porcelain=v1"]).await?;
        let branch = self.git(cwd, &["branch", "--show-current"]).await
            .unwrap_or_default().trim().to_string();

        let files: Vec<Value> = out.lines()
            .filter(|l| !l.is_empty())
            .map(|l| {
                let status = &l[..2];
                let file = l[3..].trim();
                json!({ "status": status.trim(), "file": file })
            })
            .collect();

        Ok(json!({
            "ok": true,
            "data": { "branch": branch, "files": files, "clean": files.is_empty() },
            "error": null,
            "meta": { "tool": "git", "action": "status" }
        }))
    }

    async fn diff(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let mut git_args = vec!["diff"];
        if args.staged.unwrap_or(false) {
            git_args.push("--staged");
        }
        let out = self.git(cwd, &git_args).await?;

        Ok(json!({
            "ok": true,
            "data": { "diff": out, "lines": out.lines().count() },
            "error": null,
            "meta": { "tool": "git", "action": "diff" }
        }))
    }

    async fn apply(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let patch = args.patch.as_deref()
            .ok_or_else(|| anyhow!("patch content required"))?;

        // Write patch to temp file and apply
        let tmp = format!("{}/.__vcs_patch_tmp", cwd);
        tokio::fs::write(&tmp, patch).await?;
        let result = self.git(cwd, &["apply", &tmp]).await;
        let _ = tokio::fs::remove_file(&tmp).await;

        match result {
            Ok(_) => Ok(json!({
                "ok": true,
                "data": { "applied": true },
                "error": null,
                "meta": { "tool": "git", "action": "apply" }
            })),
            Err(e) => Ok(json!({
                "ok": false,
                "data": null,
                "error": { "code": "APPLY_FAILED", "message": e.to_string() },
                "meta": { "tool": "git", "action": "apply" }
            })),
        }
    }

    async fn commit(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let message = args.message.as_deref()
            .ok_or_else(|| anyhow!("message required"))?;

        let out = self.git(cwd, &["commit", "-m", message]).await?;

        Ok(json!({
            "ok": true,
            "data": { "output": out.trim() },
            "error": null,
            "meta": { "tool": "git", "action": "commit" }
        }))
    }

    async fn branch(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        if let Some(name) = &args.branch {
            let out = self.git(cwd, &["branch", name]).await?;
            Ok(json!({
                "ok": true,
                "data": { "created": name, "output": out.trim() },
                "error": null,
                "meta": { "tool": "git", "action": "branch" }
            }))
        } else {
            let out = self.git(cwd, &["branch", "-a"]).await?;
            let branches: Vec<&str> = out.lines().map(|l| l.trim()).collect();
            Ok(json!({
                "ok": true,
                "data": { "branches": branches },
                "error": null,
                "meta": { "tool": "git", "action": "branch" }
            }))
        }
    }

    async fn checkout(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let branch = args.branch.as_deref()
            .ok_or_else(|| anyhow!("branch required"))?;

        let out = self.git(cwd, &["checkout", branch]).await?;

        Ok(json!({
            "ok": true,
            "data": { "branch": branch, "output": out.trim() },
            "error": null,
            "meta": { "tool": "git", "action": "checkout" }
        }))
    }

    async fn log(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let count = args.count.unwrap_or(10).to_string();
        let out = self.git(cwd, &["log", "--oneline", "-n", &count]).await?;

        let entries: Vec<Value> = out.lines()
            .filter(|l| !l.is_empty())
            .map(|l| {
                let parts: Vec<&str> = l.splitn(2, ' ').collect();
                json!({
                    "hash": parts.first().unwrap_or(&""),
                    "message": parts.get(1).unwrap_or(&"")
                })
            })
            .collect();

        Ok(json!({
            "ok": true,
            "data": { "entries": entries, "count": entries.len() },
            "error": null,
            "meta": { "tool": "git", "action": "log" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "git",
                "actions": {
                    "status": "Working tree status",
                    "diff": "Show differences (unified patch format)",
                    "apply": "Apply patch (requires patch)",
                    "commit": "Create commit (requires message)",
                    "branch": "List or create branches",
                    "checkout": "Switch branches (requires branch)",
                    "log": "Commit history (optional count)"
                }
            },
            "error": null,
            "meta": { "tool": "git", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vcs_action_parse() {
        let action: VcsAction = "status".parse().unwrap();
        assert_eq!(action, VcsAction::Status);
    }

    #[test]
    fn test_vcs_action_aliases() {
        assert_eq!("st".parse::<VcsAction>().unwrap(), VcsAction::Status);
        assert_eq!("co".parse::<VcsAction>().unwrap(), VcsAction::Checkout);
        assert_eq!("ci".parse::<VcsAction>().unwrap(), VcsAction::Commit);
    }
}
