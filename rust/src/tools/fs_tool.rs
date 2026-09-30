//! `fs` — the filesystem on one axis (HIP-0300), with python-sdk
//! `hanzo_tools.fs.FsTool`'s contract: the same actions, the same parameters
//! (`uri`, `path` accepted for it), the same answers in the unified
//! `{ok, data, error, meta}` envelope.
//!
//! Every file answer carries its content hash (`sha256:<hex>`), and
//! `apply_patch` — the one way to edit an existing file — takes that hash as
//! its precondition, so an edit made against a stale read is refused rather
//! than applied. `write` only creates.

use anyhow::Result;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::{envelope_err, envelope_ok};

const ACTIONS: &[(&str, &str)] = &[
    ("read", "Read file contents (returns hash)"),
    ("write", "Create new files only"),
    ("stat", "File metadata including hash"),
    ("list", "Directory listing"),
    ("apply_patch", "Edit with base_hash precondition"),
    ("patch", "Apply Rust-style patch format (Rust parity)"),
    ("search_text", "Text search"),
    ("mv", "Move or rename file/directory"),
    ("mkdir", "Create directory"),
    ("rm", "Remove (requires confirm=true)"),
];

const DESCRIPTION: &str = r#"Unified filesystem tool (HIP-0300).

Actions:
- read: Read file contents (returns hash)
- write: Create new files only
- stat: File metadata including hash
- list: Directory listing
- apply_patch: Edit with base_hash precondition
- patch: Apply Rust-style patch format (Rust parity)
- search_text: Text search
- mkdir: Create directory
- rm: Remove (requires confirm=true)

IMPORTANT: apply_patch is the ONLY way to edit existing files.
patch supports Rust grammar format: *** Begin Patch / *** Update File: / @@ / -old +new
"#;

/// Arguments for the fs tool.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FsToolArgs {
    #[serde(default)]
    pub action: String,
    /// Absolute path or `file://` URI.
    #[serde(alias = "path")]
    pub uri: Option<String>,
    pub content: Option<String>,
    pub encoding: Option<String>,
    /// read: first line, 0-based. list/search_text page through `cursor`.
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub depth: Option<usize>,
    /// list: a name glob; search_text: the regex.
    pub pattern: Option<String>,
    /// search_text: a file glob.
    pub glob: Option<String>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub base_hash: Option<String>,
    /// patch: the patch text.
    pub input: Option<String>,
    pub destination: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

/// A refusal with its unified error code.
struct Refused(&'static str, String);

type Answer = std::result::Result<Value, Refused>;

fn invalid(msg: impl Into<String>) -> Refused {
    Refused("INVALID_PARAMS", msg.into())
}

fn io(e: std::io::Error) -> Refused {
    Refused("INTERNAL_ERROR", e.to_string())
}

/// `sha256:<hex>` of the bytes.
pub fn content_hash(b: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(b))
}

fn file_uri(p: &Path) -> String {
    format!("file://{}", p.canonicalize().unwrap_or_else(|_| p.to_path_buf()).display())
}

/// An absolute path from `uri`, `file://` stripped.
fn path(uri: Option<&str>) -> std::result::Result<PathBuf, Refused> {
    let raw = uri.filter(|u| !u.is_empty()).ok_or_else(|| invalid("Path is required"))?;
    let p = PathBuf::from(raw.strip_prefix("file://").unwrap_or(raw));
    if !p.is_absolute() {
        return Err(invalid("Path must be absolute"));
    }
    Ok(p)
}

fn mime(p: &Path) -> Option<&'static str> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// File system tool.
pub struct FsTool;

impl FsTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: FsToolArgs) -> Result<String> {
        let action = if args.action.is_empty() { "help".to_string() } else { args.action.clone() };
        let answer = match action.as_str() {
            "read" => read(&args),
            "write" => write(&args),
            "stat" => stat(&args),
            "list" => list(&args),
            "apply_patch" => apply_patch(&args),
            "patch" => patch(&args),
            "search_text" => search_text(&args),
            "mv" => mv(&args),
            "mkdir" => mkdir(&args),
            "rm" => rm(&args),
            "help" => Ok(json!({
                "tool": "fs",
                "actions": ACTIONS.iter().map(|(a, d)| json!({"name": a, "description": d})).collect::<Vec<_>>(),
            })),
            other => Err(invalid(format!(
                "Unknown action '{other}'. Available: {}",
                ACTIONS.iter().map(|(a, _)| *a).collect::<Vec<_>>().join(", ")
            ))),
        };
        Ok(match answer {
            Ok(data) => envelope_ok("fs", &action, data),
            Err(Refused(code, msg)) => envelope_err("fs", &action, code, msg),
        }
        .to_string())
    }
}

impl Default for FsTool {
    fn default() -> Self {
        Self::new()
    }
}

fn read(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    if !p.exists() {
        return Err(Refused("NOT_FOUND", format!("File not found: {}", p.display())));
    }
    if !p.is_file() {
        return Err(invalid(format!("Not a file: {}", p.display())));
    }
    let raw = std::fs::read(&p).map_err(io)?;
    // An image is pixels, not text: the server sends it as an MCP image block.
    if let Some(m) = mime(&p) {
        return Ok(json!({
            "uri": file_uri(&p), "hash": content_hash(&raw), "mime": m, "size": raw.len(),
            "image": { "data": base64::engine::general_purpose::STANDARD.encode(&raw), "mimeType": m },
        }));
    }
    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let (offset, limit) = (a.offset.unwrap_or(0), a.limit.unwrap_or(2000));
    let shown: Vec<String> = lines
        .iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(i, l)| {
            let l = l.trim_end_matches(['\n', '\r']);
            let l = if l.chars().count() > 2000 { format!("{}...", l.chars().take(2000).collect::<String>()) } else { l.to_string() };
            format!("{:6}│{l}", i + 1)
        })
        .collect();
    Ok(json!({
        "uri": file_uri(&p), "text": shown.join("\n"), "hash": content_hash(&raw),
        "total_lines": lines.len(), "offset": offset, "limit": limit,
    }))
}

fn write(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    let content = a.content.as_deref().ok_or_else(|| invalid("content required"))?;
    if p.exists() {
        return Err(Refused("CONFLICT", format!("File already exists: {}. Use apply_patch to edit.", p.display())));
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    std::fs::write(&p, content).map_err(io)?;
    Ok(json!({ "uri": file_uri(&p), "hash": content_hash(content.as_bytes()), "size": content.len() }))
}

fn stat(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    let m = std::fs::metadata(&p).map_err(|_| Refused("NOT_FOUND", format!("File not found: {}", p.display())))?;
    let hash = if m.is_file() { Some(content_hash(&std::fs::read(&p).map_err(io)?)) } else { None };
    let mtime = m.modified().ok().map(|t| chrono::DateTime::<chrono::Local>::from(t).naive_local().to_string());
    Ok(json!({
        "uri": file_uri(&p), "size": m.len(), "hash": hash, "mtime": mtime,
        "is_file": m.is_file(), "is_dir": m.is_dir(),
    }))
}

fn list(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    if !p.exists() {
        return Err(Refused("NOT_FOUND", format!("Directory not found: {}", p.display())));
    }
    if !p.is_dir() {
        return Err(invalid(format!("Not a directory: {}", p.display())));
    }
    let pattern = match a.pattern.as_deref() {
        Some(g) => Some(glob::Pattern::new(g).map_err(|e| invalid(format!("Invalid pattern: {e}")))?),
        None => None,
    };
    let (depth, limit) = (a.depth.unwrap_or(1).max(1), a.limit.unwrap_or(100));
    let start: usize = a.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
    let mut entries = Vec::new();
    let mut total = 0;
    // Sorted within each directory, each entry before its children; an entry
    // the pattern refuses is skipped with everything under it.
    let walk = WalkDir::new(&p).min_depth(1).max_depth(depth).sort_by_file_name().into_iter().filter_entry(|e| {
        e.depth() == 0 || pattern.as_ref().is_none_or(|g| g.matches(&e.file_name().to_string_lossy()))
    });
    for e in walk.filter_map(|e| e.ok()) {
        total += 1;
        if total <= start || entries.len() >= limit {
            continue;
        }
        let is_file = e.file_type().is_file();
        entries.push(json!({
            "name": e.path().strip_prefix(&p).unwrap_or(e.path()).display().to_string(),
            "uri": file_uri(e.path()),
            "is_dir": e.file_type().is_dir(),
            "size": if is_file { e.metadata().ok().map(|m| m.len()) } else { None },
        }));
    }
    let more = total > start + entries.len();
    Ok(json!({
        "uri": file_uri(&p), "entries": entries,
        "paging": { "cursor": more.then(|| (start + entries.len()).to_string()), "more": more, "total": total },
    }))
}

fn apply_patch(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    let old = a.old_text.as_deref().ok_or_else(|| invalid("old_text required"))?;
    let new = a.new_text.as_deref().ok_or_else(|| invalid("new_text required"))?;
    let base = a.base_hash.as_deref().ok_or_else(|| invalid("base_hash required: read the file first"))?;
    if !p.is_file() {
        return Err(Refused("NOT_FOUND", format!("File not found: {}", p.display())));
    }
    let content = std::fs::read_to_string(&p).map_err(io)?;
    let current = content_hash(content.as_bytes());
    if current != base {
        return Err(Refused(
            "CONFLICT",
            format!("File has changed since last read (base_hash mismatch): expected {base}, actual {current}"),
        ));
    }
    match content.matches(old).count() {
        0 => return Err(Refused("NOT_FOUND", "old_text not found in file".into())),
        1 => {}
        n => return Err(invalid(format!("old_text found {n} times. Make it more specific."))),
    }
    let next = content.replacen(old, new, 1);
    std::fs::write(&p, &next).map_err(io)?;
    Ok(json!({ "uri": file_uri(&p), "hash": content_hash(next.as_bytes()), "previous_hash": current }))
}

/// One file operation of a Rust-grammar patch.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchOp {
    Add,
    Update,
    Delete,
}

/// One file of a patch: its hunks, or for Add its whole content.
#[derive(Debug, Clone)]
pub struct PatchFile {
    pub op: PatchOp,
    pub path: String,
    pub hunks: Vec<PatchHunk>,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct PatchHunk {
    pub context: String,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
}

/// Parse `*** Begin Patch` / `*** Add|Update|Delete File:` / `@@` / `-old` `+new`.
pub fn parse_patch(text: &str) -> Vec<PatchFile> {
    let mut files = Vec::new();
    let mut file: Option<PatchFile> = None;
    let mut hunk: Option<PatchHunk> = None;
    let close = |file: &mut Option<PatchFile>, hunk: &mut Option<PatchHunk>, files: &mut Vec<PatchFile>| {
        if let Some(mut f) = file.take() {
            f.hunks.extend(hunk.take());
            files.push(f);
        }
        *hunk = None;
    };
    for line in text.trim().lines() {
        if matches!(line.trim(), "*** Begin Patch" | "*** End Patch") {
            continue;
        }
        let op = [("*** Add File:", PatchOp::Add), ("*** Update File:", PatchOp::Update), ("*** Delete File:", PatchOp::Delete)]
            .into_iter()
            .find_map(|(tag, op)| line.strip_prefix(tag).map(|p| (op, p.trim().to_string())));
        if let Some((op, path)) = op {
            close(&mut file, &mut hunk, &mut files);
            file = Some(PatchFile { op, path, hunks: Vec::new(), content: String::new() });
            continue;
        }
        let Some(f) = file.as_mut() else { continue };
        if line.starts_with("@@") {
            f.hunks.extend(hunk.take());
            hunk = Some(PatchHunk { context: line.trim().to_string(), ..Default::default() });
        } else if f.op == PatchOp::Add {
            f.content.push_str(line.strip_prefix('+').unwrap_or(line));
            f.content.push('\n');
        } else if let Some(h) = hunk.as_mut() {
            if let Some(l) = line.strip_prefix('-') {
                h.old_lines.push(l.to_string());
            } else if let Some(l) = line.strip_prefix('+') {
                h.new_lines.push(l.to_string());
            } else if let Some(l) = line.strip_prefix(' ') {
                h.old_lines.push(l.to_string());
                h.new_lines.push(l.to_string());
            }
        }
    }
    close(&mut file, &mut hunk, &mut files);
    files
}

fn patch(a: &FsToolArgs) -> Answer {
    let input = a.input.as_deref().filter(|s| !s.trim().is_empty()).ok_or_else(|| invalid("Patch input is required"))?;
    let files = parse_patch(input);
    if files.is_empty() {
        return Err(invalid("No file operations found in patch"));
    }
    let cwd = std::env::current_dir().map_err(io)?;
    let results: Vec<Value> = files
        .iter()
        .map(|f| {
            let p = cwd.join(&f.path);
            let op = format!("{:?}", f.op).to_lowercase();
            let done = (|| -> std::result::Result<Value, String> {
                match f.op {
                    PatchOp::Add => {
                        if p.exists() {
                            return Err(format!("File already exists: {}", p.display()));
                        }
                        if let Some(dir) = p.parent() {
                            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                        }
                        std::fs::write(&p, &f.content).map_err(|e| e.to_string())?;
                        Ok(json!({ "hash": content_hash(f.content.as_bytes()) }))
                    }
                    PatchOp::Update => {
                        let mut content = std::fs::read_to_string(&p).map_err(|_| format!("File not found: {}", p.display()))?;
                        for h in &f.hunks {
                            let (old, new) = (h.old_lines.join("\n"), h.new_lines.join("\n"));
                            if !old.is_empty() && content.contains(&old) {
                                content = content.replacen(&old, &new, 1);
                            } else if old.is_empty() && !new.is_empty() {
                                content.push('\n');
                                content.push_str(&new);
                            }
                        }
                        std::fs::write(&p, &content).map_err(|e| e.to_string())?;
                        Ok(json!({ "hash": content_hash(content.as_bytes()), "hunks_applied": f.hunks.len() }))
                    }
                    PatchOp::Delete if !p.exists() => Ok(json!({ "message": "File already deleted" })),
                    PatchOp::Delete => std::fs::remove_file(&p).map(|_| json!({})).map_err(|e| e.to_string()),
                }
            })();
            let mut r = json!({ "op": op, "path": p.display().to_string() });
            match done {
                Ok(extra) => {
                    r["success"] = json!(true);
                    r.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
                }
                Err(e) => {
                    r["success"] = json!(false);
                    r["error"] = json!(e);
                }
            }
            r
        })
        .collect();
    let success = results.iter().all(|r| r["success"] == true);
    Ok(json!({ "results": results, "total": results.len(), "success": success }))
}

fn search_text(a: &FsToolArgs) -> Answer {
    let pattern = a.pattern.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| invalid("pattern required"))?;
    let root = match a.uri.as_deref() {
        Some(u) => path(Some(u))?,
        None => PathBuf::from("."),
    };
    let limit = a.limit.unwrap_or(50);
    let start: usize = a.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
    let matches = rg(pattern, &root, a.glob.as_deref(), limit).map_or_else(|| scan(pattern, &root, a.glob.as_deref(), limit), Ok)?;
    let more = matches.len() >= limit;
    Ok(json!({
        "pattern": pattern, "matches": matches,
        "paging": { "cursor": more.then(|| (start + matches.len()).to_string()), "more": more },
    }))
}

/// ripgrep's matches, or `None` when rg is not installed.
fn rg(pattern: &str, root: &Path, glob: Option<&str>, limit: usize) -> Option<Vec<Value>> {
    let mut cmd = std::process::Command::new("rg");
    cmd.args(["--json", "-n", "--max-count", &(limit * 2).to_string()]);
    if let Some(g) = glob {
        cmd.args(["--glob", g]);
    }
    let out = cmd.arg("--").arg(pattern).arg(root).output().ok()?;
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["type"] == "match")
            .take(limit)
            .map(|v| {
                let d = &v["data"];
                json!({
                    "uri": file_uri(Path::new(d["path"]["text"].as_str().unwrap_or(""))),
                    "line": d["line_number"],
                    "text": d["lines"]["text"].as_str().unwrap_or("").trim(),
                })
            })
            .collect(),
    )
}

/// The same search in-process: a regex over every file under `root`.
fn scan(pattern: &str, root: &Path, glob: Option<&str>, limit: usize) -> std::result::Result<Vec<Value>, Refused> {
    let re = regex::Regex::new(pattern).map_err(|e| invalid(format!("Invalid regex: {e}")))?;
    let glob = match glob {
        Some(g) => Some(glob::Pattern::new(g).map_err(|e| invalid(format!("Invalid glob: {e}")))?),
        None => None,
    };
    let mut out = Vec::new();
    for e in WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) {
        if glob.as_ref().is_some_and(|g| !g.matches(&e.file_name().to_string_lossy())) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                out.push(json!({ "uri": file_uri(e.path()), "line": i + 1, "text": line.trim().chars().take(200).collect::<String>() }));
                if out.len() >= limit {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

fn mv(a: &FsToolArgs) -> Answer {
    let src = path(a.uri.as_deref())?;
    let dst = path(a.destination.as_deref()).map_err(|Refused(c, m)| Refused(c, format!("destination: {m}")))?;
    if !src.exists() {
        return Err(Refused("NOT_FOUND", format!("Source not found: {}", src.display())));
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    std::fs::rename(&src, &dst).map_err(io)?;
    Ok(json!({ "source": format!("file://{}", src.display()), "destination": file_uri(&dst), "moved": true }))
}

fn mkdir(a: &FsToolArgs) -> Answer {
    let p = path(a.uri.as_deref())?;
    if p.exists() {
        if p.is_dir() {
            return Ok(json!({ "uri": file_uri(&p), "created": false }));
        }
        return Err(Refused("CONFLICT", format!("Path exists and is not a directory: {}", p.display())));
    }
    std::fs::create_dir_all(&p).map_err(io)?;
    Ok(json!({ "uri": file_uri(&p), "created": true }))
}

fn rm(a: &FsToolArgs) -> Answer {
    if !a.confirm {
        return Err(invalid("rm requires confirm=true for safety"));
    }
    let p = path(a.uri.as_deref())?;
    let m = std::fs::symlink_metadata(&p).map_err(|_| Refused("NOT_FOUND", format!("Path not found: {}", p.display())))?;
    let uri = file_uri(&p);
    if m.is_dir() {
        std::fs::remove_dir_all(&p).map_err(io)?;
    } else {
        std::fs::remove_file(&p).map_err(io)?;
    }
    Ok(json!({ "uri": uri, "removed": true }))
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
            description: DESCRIPTION.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write", "stat", "list", "apply_patch", "patch", "search_text", "mv", "mkdir", "rm", "help"],
                        "default": "help"
                    },
                    "uri": {"type": "string", "description": "Absolute path or file:// URI (path is accepted too)"},
                    "content": {"type": "string", "description": "write: the new file's content"},
                    "encoding": {"type": "string", "default": "utf-8"},
                    "offset": {"type": "integer", "description": "read: first line, 0-based", "default": 0},
                    "limit": {"type": "integer", "description": "read: lines (2000); list: entries (100); search_text: matches (50)"},
                    "cursor": {"type": "string", "description": "list/search_text: the page after this cursor"},
                    "depth": {"type": "integer", "description": "list: levels", "default": 1},
                    "pattern": {"type": "string", "description": "list: name glob; search_text: regex"},
                    "glob": {"type": "string", "description": "search_text: file glob"},
                    "old_text": {"type": "string", "description": "apply_patch: the unique text to replace"},
                    "new_text": {"type": "string", "description": "apply_patch: its replacement"},
                    "base_hash": {"type": "string", "description": "apply_patch: the hash read returned"},
                    "input": {"type": "string", "description": "patch: *** Begin Patch … *** End Patch"},
                    "destination": {"type": "string", "description": "mv: where to"},
                    "confirm": {"type": "boolean", "description": "rm: required", "default": false}
                },
                "required": ["action"]
            }),
        }
    }
}

impl Default for FsToolDefinition {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_grammar_parses_like_python() {
        let files = parse_patch(
            "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: b.txt\n@@ fn x\n-old\n+new\n keep\n*** Delete File: c.txt\n*** End Patch\n",
        );
        assert_eq!(files.len(), 3);
        assert_eq!((files[0].op.clone(), files[0].content.as_str()), (PatchOp::Add, "one\ntwo\n"));
        assert_eq!(files[1].hunks[0].old_lines, vec!["old", "keep"]);
        assert_eq!(files[1].hunks[0].new_lines, vec!["new", "keep"]);
        assert_eq!((files[2].op.clone(), files[2].path.as_str()), (PatchOp::Delete, "c.txt"));
    }

    #[test]
    fn hash_is_sha256_hex() {
        assert_eq!(content_hash(b"hello"), "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }
}
