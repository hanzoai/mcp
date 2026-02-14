/// Unified filesystem tool (HIP-0300)
///
/// Handles all file operations:
/// - read: Read file contents
/// - write: Write file contents
/// - edit: Edit file with old/new replacement
/// - patch: Apply Rust-style patch format
/// - tree: Display directory tree
/// - find: Find files by pattern
/// - search: Search file contents

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Actions for the fs tool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FsAction {
    Read,
    Write,
    Edit,
    Patch,
    Tree,
    Find,
    Search,
    Info,
    Help,
}

impl Default for FsAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for FsAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "edit" => Ok(Self::Edit),
            "patch" | "apply_patch" => Ok(Self::Patch),
            "tree" | "ls" => Ok(Self::Tree),
            "find" | "glob" => Ok(Self::Find),
            "search" | "grep" => Ok(Self::Search),
            "info" | "stat" => Ok(Self::Info),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Arguments for fs tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FsToolArgs {
    #[serde(default)]
    pub action: String,
    /// File path
    pub path: Option<String>,
    /// Alias for path
    pub file_path: Option<String>,
    /// Content for write
    pub content: Option<String>,
    /// Old text for edit
    pub old_string: Option<String>,
    /// Alias for old_string
    pub old_text: Option<String>,
    /// New text for edit
    pub new_string: Option<String>,
    /// Alias for new_string
    pub new_text: Option<String>,
    /// Replace all occurrences
    #[serde(default)]
    pub replace_all: bool,
    /// Patch text
    pub patch: Option<String>,
    /// Pattern for find/search
    pub pattern: Option<String>,
    /// Max depth for tree
    pub depth: Option<usize>,
    /// Limit results
    pub limit: Option<usize>,
    /// Offset for pagination
    pub offset: Option<usize>,
    /// Include hidden files
    #[serde(default)]
    pub include_hidden: bool,
    /// Context lines for search
    pub context: Option<usize>,
    /// Case insensitive
    #[serde(default)]
    pub ignore_case: bool,
}

/// Patch operation type
#[derive(Debug, Clone, PartialEq)]
pub enum PatchOp {
    Add,
    Update,
    Delete,
}

/// Parsed patch file
#[derive(Debug, Clone)]
pub struct PatchFile {
    pub op: PatchOp,
    pub path: String,
    pub hunks: Vec<PatchHunk>,
}

/// Patch hunk
#[derive(Debug, Clone)]
pub struct PatchHunk {
    pub context: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
}

/// File system tool
pub struct FsTool;

impl FsTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: FsToolArgs) -> Result<String> {
        let action: FsAction = if args.action.is_empty() {
            FsAction::Help
        } else {
            args.action.parse()?
        };

        let result = match action {
            FsAction::Read => self.read(args).await?,
            FsAction::Write => self.write(args).await?,
            FsAction::Edit => self.edit(args).await?,
            FsAction::Patch => self.patch(args).await?,
            FsAction::Tree => self.tree(args).await?,
            FsAction::Find => self.find(args).await?,
            FsAction::Search => self.search(args).await?,
            FsAction::Info => self.info(args).await?,
            FsAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn read(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.file_path.or(args.path)
            .ok_or_else(|| anyhow!("path required"))?;
        let path = shellexpand::tilde(&path).to_string();

        let content = tokio::fs::read_to_string(&path).await?;
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();

        // Apply offset and limit
        let offset = args.offset.unwrap_or(0);
        let limit = args.limit.unwrap_or(2000);

        let lines: Vec<String> = lines
            .into_iter()
            .skip(offset)
            .take(limit)
            .enumerate()
            .map(|(i, line)| format!("{:>6}\u{2192}{}", offset + i + 1, line))
            .collect();

        Ok(json!({
            "path": path,
            "content": lines.join("\n"),
            "lines": lines.len(),
            "total_lines": total_lines,
            "offset": offset,
            "truncated": total_lines > offset + limit
        }))
    }

    async fn write(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.file_path.or(args.path)
            .ok_or_else(|| anyhow!("path required"))?;
        let path = shellexpand::tilde(&path).to_string();
        let content = args.content.ok_or_else(|| anyhow!("content required"))?;

        // Ensure parent directory exists
        if let Some(parent) = Path::new(&path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(&path, &content).await?;

        Ok(json!({
            "path": path,
            "bytes": content.len(),
            "lines": content.lines().count(),
            "success": true
        }))
    }

    async fn edit(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.file_path.or(args.path)
            .ok_or_else(|| anyhow!("path required"))?;
        let path = shellexpand::tilde(&path).to_string();

        let old_string = args.old_string.or(args.old_text)
            .ok_or_else(|| anyhow!("old_string required"))?;
        let new_string = args.new_string.or(args.new_text)
            .ok_or_else(|| anyhow!("new_string required"))?;

        // Handle creating new file
        if old_string.is_empty() {
            // Create new file
            if let Some(parent) = Path::new(&path).parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&path, &new_string).await?;
            return Ok(json!({
                "path": path,
                "created": true,
                "bytes": new_string.len()
            }));
        }

        // Read existing file
        let content = tokio::fs::read_to_string(&path).await?;

        // Count occurrences
        let count = content.matches(&old_string).count();

        if count == 0 {
            return Err(anyhow!("old_string not found in file"));
        }

        if count > 1 && !args.replace_all {
            return Err(anyhow!(
                "old_string matches {} locations. Use replace_all=true or provide more context.",
                count
            ));
        }

        // Replace
        let new_content = if args.replace_all {
            content.replace(&old_string, &new_string)
        } else {
            content.replacen(&old_string, &new_string, 1)
        };

        tokio::fs::write(&path, &new_content).await?;

        Ok(json!({
            "path": path,
            "replacements": if args.replace_all { count } else { 1 },
            "bytes": new_content.len(),
            "success": true
        }))
    }

    async fn patch(&self, args: FsToolArgs) -> Result<Value> {
        let patch_text = args.patch.or(args.content)
            .ok_or_else(|| anyhow!("patch required"))?;

        let patches = self.parse_patch(&patch_text)?;
        let mut results = Vec::new();

        for patch_file in patches {
            let path = shellexpand::tilde(&patch_file.path).to_string();

            match patch_file.op {
                PatchOp::Add => {
                    // Create new file
                    if let Some(parent) = Path::new(&path).parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    let content: String = patch_file.hunks
                        .iter()
                        .flat_map(|h| &h.new_lines)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n");
                    tokio::fs::write(&path, &content).await?;
                    results.push(json!({
                        "path": path,
                        "op": "add",
                        "success": true
                    }));
                }
                PatchOp::Delete => {
                    tokio::fs::remove_file(&path).await?;
                    results.push(json!({
                        "path": path,
                        "op": "delete",
                        "success": true
                    }));
                }
                PatchOp::Update => {
                    let mut content = tokio::fs::read_to_string(&path).await?;

                    for hunk in &patch_file.hunks {
                        let old_text = hunk.old_lines.join("\n");
                        let new_text = hunk.new_lines.join("\n");

                        if !content.contains(&old_text) {
                            return Err(anyhow!("Hunk not found in {}", path));
                        }

                        content = content.replacen(&old_text, &new_text, 1);
                    }

                    tokio::fs::write(&path, &content).await?;
                    results.push(json!({
                        "path": path,
                        "op": "update",
                        "hunks": patch_file.hunks.len(),
                        "success": true
                    }));
                }
            }
        }

        Ok(json!({
            "applied": results.len(),
            "results": results
        }))
    }

    fn parse_patch(&self, text: &str) -> Result<Vec<PatchFile>> {
        let mut patches = Vec::new();
        let mut current: Option<PatchFile> = None;
        let mut current_hunk: Option<PatchHunk> = None;

        for line in text.lines() {
            if line.starts_with("*** Begin Patch") {
                continue;
            }
            if line.starts_with("*** End Patch") {
                if let Some(mut hunk) = current_hunk.take() {
                    if let Some(ref mut patch) = current {
                        patch.hunks.push(hunk);
                    }
                }
                if let Some(patch) = current.take() {
                    patches.push(patch);
                }
                continue;
            }
            if line.starts_with("*** Add File:") {
                if let Some(mut hunk) = current_hunk.take() {
                    if let Some(ref mut patch) = current {
                        patch.hunks.push(hunk);
                    }
                }
                if let Some(patch) = current.take() {
                    patches.push(patch);
                }
                let path = line.trim_start_matches("*** Add File:").trim().to_string();
                current = Some(PatchFile {
                    op: PatchOp::Add,
                    path,
                    hunks: Vec::new(),
                });
                current_hunk = Some(PatchHunk {
                    context: None,
                    old_lines: Vec::new(),
                    new_lines: Vec::new(),
                });
                continue;
            }
            if line.starts_with("*** Update File:") {
                if let Some(mut hunk) = current_hunk.take() {
                    if let Some(ref mut patch) = current {
                        patch.hunks.push(hunk);
                    }
                }
                if let Some(patch) = current.take() {
                    patches.push(patch);
                }
                let path = line.trim_start_matches("*** Update File:").trim().to_string();
                current = Some(PatchFile {
                    op: PatchOp::Update,
                    path,
                    hunks: Vec::new(),
                });
                continue;
            }
            if line.starts_with("*** Delete File:") {
                if let Some(mut hunk) = current_hunk.take() {
                    if let Some(ref mut patch) = current {
                        patch.hunks.push(hunk);
                    }
                }
                if let Some(patch) = current.take() {
                    patches.push(patch);
                }
                let path = line.trim_start_matches("*** Delete File:").trim().to_string();
                current = Some(PatchFile {
                    op: PatchOp::Delete,
                    path,
                    hunks: Vec::new(),
                });
                continue;
            }
            if line.starts_with("@@") {
                if let Some(hunk) = current_hunk.take() {
                    if let Some(ref mut patch) = current {
                        patch.hunks.push(hunk);
                    }
                }
                current_hunk = Some(PatchHunk {
                    context: Some(line.to_string()),
                    old_lines: Vec::new(),
                    new_lines: Vec::new(),
                });
                continue;
            }

            if let Some(ref mut hunk) = current_hunk {
                if line.starts_with('+') {
                    hunk.new_lines.push(line[1..].to_string());
                } else if line.starts_with('-') {
                    hunk.old_lines.push(line[1..].to_string());
                } else if line.starts_with(' ') {
                    // Context line - add to both
                    hunk.old_lines.push(line[1..].to_string());
                    hunk.new_lines.push(line[1..].to_string());
                }
            }
        }

        // Flush remaining
        if let Some(mut hunk) = current_hunk.take() {
            if let Some(ref mut patch) = current {
                patch.hunks.push(hunk);
            }
        }
        if let Some(patch) = current.take() {
            patches.push(patch);
        }

        Ok(patches)
    }

    async fn tree(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.path.unwrap_or_else(|| ".".to_string());
        let path = shellexpand::tilde(&path).to_string();
        let depth = args.depth.unwrap_or(3);
        let include_hidden = args.include_hidden;

        let mut entries = Vec::new();
        let mut dirs = 0;
        let mut files = 0;

        for entry in WalkDir::new(&path)
            .max_depth(depth)
            .into_iter()
            .filter_entry(|e| {
                include_hidden || !e.file_name().to_string_lossy().starts_with('.')
            })
        {
            if let Ok(entry) = entry {
                let relative = entry.path().strip_prefix(&path).unwrap_or(entry.path());
                let depth = relative.components().count();
                let prefix = "  ".repeat(depth);
                let name = entry.file_name().to_string_lossy();

                if entry.file_type().is_dir() {
                    dirs += 1;
                    entries.push(format!("{}\u{251c}\u{2500} {}/", prefix, name));
                } else {
                    files += 1;
                    entries.push(format!("{}\u{251c}\u{2500} {}", prefix, name));
                }
            }
        }

        Ok(json!({
            "path": path,
            "tree": entries.join("\n"),
            "directories": dirs,
            "files": files
        }))
    }

    async fn find(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.path.unwrap_or_else(|| ".".to_string());
        let path = shellexpand::tilde(&path).to_string();
        let pattern = args.pattern.ok_or_else(|| anyhow!("pattern required"))?;
        let limit = args.limit.unwrap_or(100);
        let include_hidden = args.include_hidden;

        let glob = glob::Pattern::new(&pattern)?;
        let mut matches = Vec::new();

        for entry in WalkDir::new(&path)
            .into_iter()
            .filter_entry(|e| {
                include_hidden || !e.file_name().to_string_lossy().starts_with('.')
            })
        {
            if matches.len() >= limit {
                break;
            }

            if let Ok(entry) = entry {
                let name = entry.file_name().to_string_lossy();
                if glob.matches(&name) {
                    matches.push(entry.path().to_string_lossy().to_string());
                }
            }
        }

        Ok(json!({
            "path": path,
            "pattern": pattern,
            "matches": matches,
            "count": matches.len(),
            "truncated": matches.len() >= limit
        }))
    }

    async fn search(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.path.unwrap_or_else(|| ".".to_string());
        let path = shellexpand::tilde(&path).to_string();
        let pattern = args.pattern.ok_or_else(|| anyhow!("pattern required"))?;
        let limit = args.limit.unwrap_or(50);
        let context = args.context.unwrap_or(2);
        let ignore_case = args.ignore_case;
        let include_hidden = args.include_hidden;

        let regex = if ignore_case {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .build()?
        } else {
            regex::Regex::new(&pattern)?
        };

        let mut results = Vec::new();

        for entry in WalkDir::new(&path)
            .into_iter()
            .filter_entry(|e| include_hidden || !e.file_name().to_string_lossy().starts_with('.'))
        {
            if results.len() >= limit {
                break;
            }

            if let Ok(entry) = entry {
                if !entry.file_type().is_file() {
                    continue;
                }

                // Skip binary files
                let path_str = entry.path().to_string_lossy();
                if path_str.ends_with(".exe") || path_str.ends_with(".bin") ||
                   path_str.ends_with(".so") || path_str.ends_with(".dylib") {
                    continue;
                }

                if let Ok(content) = tokio::fs::read_to_string(entry.path()).await {
                    let lines: Vec<&str> = content.lines().collect();
                    for (i, line) in lines.iter().enumerate() {
                        if regex.is_match(line) {
                            let start = i.saturating_sub(context);
                            let end = (i + context + 1).min(lines.len());
                            let context_lines: Vec<String> = lines[start..end]
                                .iter()
                                .enumerate()
                                .map(|(j, l)| format!("{:>4}:{}", start + j + 1, l))
                                .collect();

                            results.push(json!({
                                "file": path_str,
                                "line": i + 1,
                                "match": line,
                                "context": context_lines.join("\n")
                            }));

                            if results.len() >= limit {
                                break;
                            }
                        }
                    }
                }
            }
        }

        Ok(json!({
            "pattern": pattern,
            "path": path,
            "results": results,
            "count": results.len(),
            "truncated": results.len() >= limit
        }))
    }

    async fn info(&self, args: FsToolArgs) -> Result<Value> {
        let path = args.file_path.or(args.path)
            .ok_or_else(|| anyhow!("path required"))?;
        let path = shellexpand::tilde(&path).to_string();

        let metadata = tokio::fs::metadata(&path).await?;
        let file_type = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else if metadata.is_symlink() {
            "symlink"
        } else {
            "unknown"
        };

        Ok(json!({
            "path": path,
            "type": file_type,
            "size": metadata.len(),
            "readonly": metadata.permissions().readonly(),
            "modified": metadata.modified().ok().map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
            })
        }))
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "fs",
            "version": "0.12.0",
            "description": "Unified filesystem tool (HIP-0300)",
            "actions": {
                "read": "Read file contents",
                "write": "Write file contents",
                "edit": "Edit file with old/new replacement",
                "patch": "Apply Rust-style patch format",
                "tree": "Display directory tree",
                "find": "Find files by pattern",
                "search": "Search file contents",
                "info": "Get file info"
            }
        }))
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct FsToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl FsToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "fs".to_string(),
            description: r#"Unified filesystem tool (HIP-0300).

Actions:
- read: Read file contents
- write: Write file contents
- edit: Edit file with old/new replacement
- patch: Apply Rust-style patch format
- tree: Display directory tree
- find: Find files by pattern
- search: Search file contents
- info: Get file info"#.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write", "edit", "patch", "tree", "find", "search", "info", "help"],
                        "default": "help"
                    },
                    "path": {"type": "string", "description": "File or directory path"},
                    "file_path": {"type": "string", "description": "Alias for path"},
                    "content": {"type": "string", "description": "Content for write"},
                    "old_string": {"type": "string", "description": "Text to replace"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences", "default": false},
                    "patch": {"type": "string", "description": "Patch text"},
                    "pattern": {"type": "string", "description": "Pattern for find/search"},
                    "depth": {"type": "integer", "description": "Max depth for tree"},
                    "limit": {"type": "integer", "description": "Limit results"},
                    "offset": {"type": "integer", "description": "Offset for pagination"},
                    "include_hidden": {"type": "boolean", "description": "Include hidden files", "default": false},
                    "context": {"type": "integer", "description": "Context lines for search"},
                    "ignore_case": {"type": "boolean", "description": "Case insensitive search", "default": false}
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_read_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        std::fs::write(&file_path, "hello\nworld").unwrap();

        let tool = FsTool::new();
        let args = FsToolArgs {
            action: "read".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("hello"));
        assert!(output.contains("world"));
    }

    #[tokio::test]
    async fn test_write_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("new.txt");

        let tool = FsTool::new();
        let args = FsToolArgs {
            action: "write".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            content: Some("test content".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());

        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "test content");
    }

    #[tokio::test]
    async fn test_edit_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("edit.txt");
        std::fs::write(&file_path, "hello world").unwrap();

        let tool = FsTool::new();
        let args = FsToolArgs {
            action: "edit".to_string(),
            path: Some(file_path.to_string_lossy().to_string()),
            old_string: Some("world".to_string()),
            new_string: Some("rust".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());

        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "hello rust");
    }

    #[tokio::test]
    async fn test_tree() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        std::fs::write(dir.path().join("file.txt"), "").unwrap();

        let tool = FsTool::new();
        let args = FsToolArgs {
            action: "tree".to_string(),
            path: Some(dir.path().to_string_lossy().to_string()),
            include_hidden: true, // Temp dirs start with '.' so we need to include hidden
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("subdir"), "Missing subdir in: {}", output);
        assert!(output.contains("file.txt"), "Missing file.txt in: {}", output);
    }

    #[tokio::test]
    async fn test_help() {
        let tool = FsTool::new();
        let args = FsToolArgs {
            action: "help".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("fs"));
        assert!(output.contains("read"));
        assert!(output.contains("write"));
    }
}
