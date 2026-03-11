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
    Status, Diff, Apply, Commit, Branch, Checkout, Log,
    Blame, Show, Stash, Tag, Remote, Merge, Rebase, CherryPick,
    Reset, Clean, Init, Clone, Fetch, Pull, Push, Config,
    Worktree, Reflog, Shortlog, RevParse, Describe, Bisect,
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
            "blame" => Ok(Self::Blame),
            "show" => Ok(Self::Show),
            "stash" => Ok(Self::Stash),
            "tag" => Ok(Self::Tag),
            "remote" => Ok(Self::Remote),
            "merge" => Ok(Self::Merge),
            "rebase" => Ok(Self::Rebase),
            "cherry_pick" | "cherry-pick" => Ok(Self::CherryPick),
            "reset" => Ok(Self::Reset),
            "clean" => Ok(Self::Clean),
            "init" => Ok(Self::Init),
            "clone" => Ok(Self::Clone),
            "fetch" => Ok(Self::Fetch),
            "pull" => Ok(Self::Pull),
            "push" => Ok(Self::Push),
            "config" => Ok(Self::Config),
            "worktree" => Ok(Self::Worktree),
            "reflog" => Ok(Self::Reflog),
            "shortlog" => Ok(Self::Shortlog),
            "rev_parse" | "rev-parse" => Ok(Self::RevParse),
            "describe" => Ok(Self::Describe),
            "bisect" => Ok(Self::Bisect),
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
    pub target: Option<String>,
    pub file: Option<String>,
    pub remote: Option<String>,
    pub url: Option<String>,
    pub key: Option<String>,
    pub value: Option<String>,
    pub args: Option<Vec<String>>,
    pub force: Option<bool>,
}

pub struct GitToolDefinition;

impl GitToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "git",
            "description": "Version control: status, diff, apply, commit, branch, checkout, log, blame, show, stash, tag, remote, merge, rebase, cherry_pick, reset, clean, init, clone, fetch, pull, push, config, worktree, reflog, shortlog, rev_parse, describe, bisect",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "diff", "apply", "commit", "branch", "checkout", "log", "blame", "show", "stash", "tag", "remote", "merge", "rebase", "cherry_pick", "reset", "clean", "init", "clone", "fetch", "pull", "push", "config", "worktree", "reflog", "shortlog", "rev_parse", "describe", "bisect", "help"],
                        "description": "VCS action"
                    },
                    "path": { "type": "string", "description": "Repository path", "default": "." },
                    "message": { "type": "string", "description": "Commit message or tag message" },
                    "branch": { "type": "string", "description": "Branch name" },
                    "patch": { "type": "string", "description": "Patch content for apply" },
                    "count": { "type": "number", "description": "Number of entries", "default": 10 },
                    "staged": { "type": "boolean", "description": "Show staged changes only" },
                    "target": { "type": "string", "description": "Target ref, subcommand, or commit" },
                    "file": { "type": "string", "description": "File path" },
                    "remote": { "type": "string", "description": "Remote name" },
                    "url": { "type": "string", "description": "URL for clone/remote" },
                    "key": { "type": "string", "description": "Config key" },
                    "value": { "type": "string", "description": "Config value" },
                    "force": { "type": "boolean", "description": "Force operation" }
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
            VcsAction::Blame => self.blame(cwd, &args).await,
            VcsAction::Show => self.show(cwd, &args).await,
            VcsAction::Stash => self.stash(cwd, &args).await,
            VcsAction::Tag => self.tag(cwd, &args).await,
            VcsAction::Remote => self.remote(cwd, &args).await,
            VcsAction::Merge => self.merge(cwd, &args).await,
            VcsAction::Rebase => self.rebase(cwd, &args).await,
            VcsAction::CherryPick => self.cherry_pick(cwd, &args).await,
            VcsAction::Reset => self.reset(cwd, &args).await,
            VcsAction::Clean => self.clean(cwd, &args).await,
            VcsAction::Init => self.init(cwd).await,
            VcsAction::Clone => self.clone_repo(cwd, &args).await,
            VcsAction::Fetch => self.fetch(cwd, &args).await,
            VcsAction::Pull => self.pull(cwd, &args).await,
            VcsAction::Push => self.push(cwd, &args).await,
            VcsAction::Config => self.config(cwd, &args).await,
            VcsAction::Worktree => self.worktree(cwd, &args).await,
            VcsAction::Reflog => self.reflog(cwd, &args).await,
            VcsAction::Shortlog => self.shortlog(cwd, &args).await,
            VcsAction::RevParse => self.rev_parse(cwd, &args).await,
            VcsAction::Describe => self.describe(cwd, &args).await,
            VcsAction::Bisect => self.bisect(cwd, &args).await,
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

    async fn blame(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let file = args.file.as_deref().or(args.target.as_deref()).ok_or_else(|| anyhow!("file required"))?;
        let out = self.git(cwd, &["blame", "--porcelain", file]).await?;
        Ok(json!({"ok": true, "data": {"output": out}, "meta": {"tool": "git", "action": "blame"}}))
    }

    async fn show(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let target = args.target.as_deref().unwrap_or("HEAD");
        let out = self.git(cwd, &["show", "--stat", target]).await?;
        Ok(json!({"ok": true, "data": {"output": out}, "meta": {"tool": "git", "action": "show"}}))
    }

    async fn stash(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let sub = args.target.as_deref().unwrap_or("list");
        let mut cmd = vec!["stash"];
        cmd.push(sub);
        if let Some(msg) = args.message.as_deref() { if sub == "push" { cmd.push("-m"); cmd.push(msg); } }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "stash"}}))
    }

    async fn tag(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        if let Some(name) = args.target.as_deref() {
            let mut cmd = vec!["tag"];
            if let Some(msg) = args.message.as_deref() { cmd.extend_from_slice(&["-a", name, "-m", msg]); } else { cmd.push(name); }
            let out = self.git(cwd, &cmd).await?;
            Ok(json!({"ok": true, "data": {"created": name, "output": out.trim()}, "meta": {"tool": "git", "action": "tag"}}))
        } else {
            let out = self.git(cwd, &["tag", "-l"]).await?;
            let tags: Vec<&str> = out.lines().collect();
            Ok(json!({"ok": true, "data": {"tags": tags}, "meta": {"tool": "git", "action": "tag"}}))
        }
    }

    async fn remote(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let sub = args.target.as_deref().unwrap_or("list");
        match sub {
            "list" => { let out = self.git(cwd, &["remote", "-v"]).await?; Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "remote"}})) }
            "add" => { let name = args.remote.as_deref().ok_or_else(|| anyhow!("remote name required"))?; let url = args.url.as_deref().ok_or_else(|| anyhow!("url required"))?; let out = self.git(cwd, &["remote", "add", name, url]).await?; Ok(json!({"ok": true, "data": {"added": name, "output": out.trim()}, "meta": {"tool": "git", "action": "remote"}})) }
            "remove" => { let name = args.remote.as_deref().ok_or_else(|| anyhow!("remote name required"))?; let out = self.git(cwd, &["remote", "remove", name]).await?; Ok(json!({"ok": true, "data": {"removed": name, "output": out.trim()}, "meta": {"tool": "git", "action": "remote"}})) }
            _ => { let out = self.git(cwd, &["remote", sub]).await?; Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "remote"}})) }
        }
    }

    async fn merge(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let branch = args.branch.as_deref().or(args.target.as_deref()).ok_or_else(|| anyhow!("branch required"))?;
        let out = self.git(cwd, &["merge", branch]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "merge"}}))
    }

    async fn rebase(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let target = args.target.as_deref().or(args.branch.as_deref()).ok_or_else(|| anyhow!("target required"))?;
        let out = self.git(cwd, &["rebase", target]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "rebase"}}))
    }

    async fn cherry_pick(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let commit = args.target.as_deref().ok_or_else(|| anyhow!("commit hash required"))?;
        let out = self.git(cwd, &["cherry-pick", commit]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "cherry_pick"}}))
    }

    async fn reset(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let target = args.target.as_deref().unwrap_or("HEAD");
        let mode = if args.force.unwrap_or(false) { "--hard" } else { "--mixed" };
        let out = self.git(cwd, &["reset", mode, target]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "reset"}}))
    }

    async fn clean(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let mut cmd = vec!["clean", "-fd"];
        if args.force.unwrap_or(false) { cmd.push("-x"); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "clean"}}))
    }

    async fn init(&self, cwd: &str) -> Result<Value> {
        let out = self.git(cwd, &["init"]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "init"}}))
    }

    async fn clone_repo(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let url = args.url.as_deref().or(args.target.as_deref()).ok_or_else(|| anyhow!("url required"))?;
        let mut cmd = vec!["clone", url];
        if let Some(path) = args.file.as_deref() { cmd.push(path); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "clone"}}))
    }

    async fn fetch(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let remote = args.remote.as_deref().unwrap_or("origin");
        let out = self.git(cwd, &["fetch", remote]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "fetch"}}))
    }

    async fn pull(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let remote = args.remote.as_deref().unwrap_or("origin");
        let mut cmd = vec!["pull", remote];
        if let Some(branch) = args.branch.as_deref() { cmd.push(branch); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "pull"}}))
    }

    async fn push(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let remote = args.remote.as_deref().unwrap_or("origin");
        let mut cmd = vec!["push", remote];
        if let Some(branch) = args.branch.as_deref() { cmd.push(branch); }
        if args.force.unwrap_or(false) { cmd.push("--force"); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "push"}}))
    }

    async fn config(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        if let Some(key) = args.key.as_deref() {
            if let Some(val) = args.value.as_deref() {
                let out = self.git(cwd, &["config", key, val]).await?;
                Ok(json!({"ok": true, "data": {"set": key, "value": val, "output": out.trim()}, "meta": {"tool": "git", "action": "config"}}))
            } else {
                let out = self.git(cwd, &["config", "--get", key]).await?;
                Ok(json!({"ok": true, "data": {"key": key, "value": out.trim()}, "meta": {"tool": "git", "action": "config"}}))
            }
        } else {
            let out = self.git(cwd, &["config", "--list"]).await?;
            Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "config"}}))
        }
    }

    async fn worktree(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let sub = args.target.as_deref().unwrap_or("list");
        let mut cmd = vec!["worktree", sub];
        if let Some(path) = args.file.as_deref() { cmd.push(path); }
        if let Some(branch) = args.branch.as_deref() { cmd.push(branch); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "worktree"}}))
    }

    async fn reflog(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let count = args.count.unwrap_or(10).to_string();
        let out = self.git(cwd, &["reflog", "-n", &count]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "reflog"}}))
    }

    async fn shortlog(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let out = self.git(cwd, &["shortlog", "-sn", "HEAD"]).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "shortlog"}}))
    }

    async fn rev_parse(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let target = args.target.as_deref().unwrap_or("HEAD");
        let out = self.git(cwd, &["rev-parse", target]).await?;
        Ok(json!({"ok": true, "data": {"hash": out.trim()}, "meta": {"tool": "git", "action": "rev_parse"}}))
    }

    async fn describe(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let target = args.target.as_deref().unwrap_or("HEAD");
        let out = self.git(cwd, &["describe", "--tags", "--always", target]).await?;
        Ok(json!({"ok": true, "data": {"description": out.trim()}, "meta": {"tool": "git", "action": "describe"}}))
    }

    async fn bisect(&self, cwd: &str, args: &GitToolArgs) -> Result<Value> {
        let sub = args.target.as_deref().unwrap_or("status");
        let mut cmd = vec!["bisect", sub];
        if let Some(commit) = args.branch.as_deref() { cmd.push(commit); }
        let out = self.git(cwd, &cmd).await?;
        Ok(json!({"ok": true, "data": {"output": out.trim()}, "meta": {"tool": "git", "action": "bisect"}}))
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
