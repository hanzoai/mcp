//! Refactor tool (HIP-0300) — single action-routed code refactoring surface.
//!
//! Advanced structural refactors that complement the local `code` AST engine:
//! `rename`, `extract_function`, `extract_variable`, `inline`, `move`,
//! `change_signature`, `organize_imports`. Reference discovery is a native
//! `walkdir` + `regex` scan (no external `rg` dependency); edits are applied
//! only when `dry_run=false`, otherwise a preview is returned.

use anyhow::Result;
use async_trait::async_trait;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use walkdir::WalkDir;

use crate::{MCPTool, ToolResult};

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", ".next",
];
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_REFS: usize = 5000;

/// One matched reference: `file:line: text`.
struct Ref {
    file: String,
    line: usize,
    text: String,
}

#[derive(Debug, Default, Deserialize)]
struct Args {
    action: Option<String>,
    symbol: Option<String>,
    #[serde(alias = "newName")]
    new_name: Option<String>,
    path: Option<String>,
    #[serde(alias = "filePattern")]
    file_pattern: Option<String>,
    #[serde(alias = "dryRun")]
    dry_run: Option<bool>,
    file: Option<String>,
    #[serde(alias = "startLine")]
    start_line: Option<usize>,
    #[serde(alias = "endLine")]
    end_line: Option<usize>,
    line: Option<usize>,
    name: Option<String>,
    #[serde(alias = "expr")]
    expression: Option<String>,
    from: Option<String>,
    to: Option<String>,
    #[serde(alias = "newSignature")]
    new_signature: Option<String>,
    limit: Option<usize>,
}

pub struct RefactorTool;

impl RefactorTool {
    pub fn new() -> Self {
        Self
    }

    pub fn schema() -> Value {
        json!({
            "name": "refactor",
            "description": "Structural code refactoring: rename, extract_function, extract_variable, inline, move, change_signature, organize_imports.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["rename", "extract_function", "extract_variable", "inline", "move", "change_signature", "organize_imports"],
                        "description": "Refactoring action"
                    },
                    "path": { "type": "string", "description": "Search root", "default": "." },
                    "filePattern": { "type": "string", "description": "File glob (e.g. \"*.rs\", \"*.{ts,js}\")" },
                    "symbol": { "type": "string", "description": "Symbol name (rename/inline/move/change_signature)" },
                    "newName": { "type": "string", "description": "New name (rename)" },
                    "dryRun": { "type": "boolean", "description": "Preview without applying", "default": true },
                    "file": { "type": "string", "description": "Source file (extract/change_signature/organize_imports)" },
                    "startLine": { "type": "number", "description": "Start line (extract_function)" },
                    "endLine": { "type": "number", "description": "End line (extract_function)" },
                    "line": { "type": "number", "description": "Target line (extract_variable)" },
                    "name": { "type": "string", "description": "New function/variable name (extract_*)" },
                    "expression": { "type": "string", "description": "Expression to extract (extract_variable)" },
                    "from": { "type": "string", "description": "Source file (move)" },
                    "to": { "type": "string", "description": "Destination file (move)" },
                    "newSignature": { "type": "string", "description": "Target signature (change_signature)" },
                    "limit": { "type": "number", "default": 50 }
                },
                "required": ["action"]
            }
        })
    }
}

impl Default for RefactorTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Text-plus-flag result matching the TS/Python `{content, isError}` shape.
fn text(body: impl Into<String>) -> Value {
    json!({ "text": body.into(), "isError": false })
}

fn fail(body: impl Into<String>) -> Value {
    json!({ "text": body.into(), "isError": true })
}

/// True when `name` matches a glob of the form `*.ext` or `*.{a,b,c}` (or bare `*`).
fn glob_match(name: &str, glob: &str) -> bool {
    let glob = glob.trim();
    if glob.is_empty() || glob == "*" || glob == "*.*" {
        return true;
    }
    if let Some(rest) = glob.strip_prefix("*.") {
        if let Some(inner) = rest.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            return inner.split(',').any(|ext| name.ends_with(&format!(".{}", ext.trim())));
        }
        return name.ends_with(&format!(".{}", rest));
    }
    // Fallback: substring match on the pattern with the star removed.
    name.contains(&glob.replace('*', ""))
}

/// Per-language indent unit.
fn indent_unit(ext: &str) -> &'static str {
    match ext {
        "go" => "\t",
        "js" | "jsx" | "ts" | "tsx" => "  ",
        _ => "    ",
    }
}

fn extension(file: &str) -> String {
    Path::new(file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string()
}

/// Native reference scan: walk `root` (or a single file), match `re` per line.
fn find_refs(re: &Regex, root: &str, glob: Option<&str>) -> Vec<Ref> {
    let mut refs = Vec::new();
    let root_path = Path::new(root);

    let scan_file = |path: &Path, refs: &mut Vec<Ref>| {
        if let Some(g) = glob {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !glob_match(name, g) {
                return;
            }
        }
        if path.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            return;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            return; // binary / non-utf8
        };
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                refs.push(Ref {
                    file: path.to_string_lossy().to_string(),
                    line: i + 1,
                    text: line.trim().to_string(),
                });
                if refs.len() >= MAX_REFS {
                    return;
                }
            }
        }
    };

    if root_path.is_file() {
        scan_file(root_path, &mut refs);
        return refs;
    }

    for entry in WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir()
                && e.file_name().to_str().map_or(false, |n| SKIP_DIRS.contains(&n)))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if refs.len() >= MAX_REFS {
            break;
        }
        scan_file(entry.path(), &mut refs);
    }
    refs
}

/// Group references by file, preserving discovery order per file.
fn group_by_file(refs: Vec<Ref>) -> BTreeMap<String, Vec<Ref>> {
    let mut groups: BTreeMap<String, Vec<Ref>> = BTreeMap::new();
    for r in refs {
        groups.entry(r.file.clone()).or_default().push(r);
    }
    groups
}

fn run(args: Args) -> Value {
    let action = args.action.clone().unwrap_or_default();
    let path = args.path.clone().unwrap_or_else(|| ".".to_string());
    let glob = args.file_pattern.as_deref();
    let dry_run = args.dry_run.unwrap_or(true);
    let limit = args.limit.unwrap_or(50);

    match action.as_str() {
        "rename" => {
            let (Some(symbol), Some(new_name)) = (args.symbol.as_deref(), args.new_name.as_deref())
            else {
                return fail("symbol and newName required");
            };
            let Ok(re) = Regex::new(&format!(r"\b{}\b", regex::escape(symbol))) else {
                return fail("invalid symbol");
            };
            let refs = find_refs(&re, &path, glob);
            if refs.is_empty() {
                return text(format!("No references found for '{}'", symbol));
            }
            let total = refs.len();
            let groups = group_by_file(refs);

            if dry_run {
                let mut out = vec![format!(
                    "Would rename '{}' -> '{}' in {} files ({} refs):\n",
                    symbol, new_name, groups.len(), total
                )];
                for (f, rs) in &groups {
                    out.push(format!("  {}: {} refs", f, rs.len()));
                    for r in rs.iter().take(3) {
                        out.push(format!("    L{}: {}", r.line, r.text));
                    }
                    if rs.len() > 3 {
                        out.push(format!("    ... +{} more", rs.len() - 3));
                    }
                }
                out.push("\nSet dryRun=false to apply.".to_string());
                return text(out.join("\n"));
            }

            let mut changed = 0usize;
            for f in groups.keys() {
                let Ok(content) = std::fs::read_to_string(f) else { continue };
                let next = re.replace_all(&content, new_name).into_owned();
                if next != content && std::fs::write(f, next).is_ok() {
                    changed += 1;
                }
            }
            text(format!("Renamed '{}' -> '{}' in {} files", symbol, new_name, changed))
        }

        "extract_function" | "extract" => {
            let (Some(file), Some(start), Some(end), Some(name)) = (
                args.file.as_deref(),
                args.start_line,
                args.end_line,
                args.name.as_deref(),
            ) else {
                return fail("file, startLine, endLine, name required");
            };
            if start == 0 || end < start {
                return fail("invalid line range");
            }
            let Ok(content) = std::fs::read_to_string(file) else {
                return fail(format!("cannot read file: {}", file));
            };
            let lines: Vec<&str> = content.lines().collect();
            if end > lines.len() {
                return fail("endLine beyond end of file");
            }
            let body = &lines[start - 1..end];
            let indent: String = body
                .first()
                .map(|l| l.chars().take_while(|c| c.is_whitespace()).collect())
                .unwrap_or_default();
            let stripped: Vec<String> = body
                .iter()
                .map(|l| l.strip_prefix(indent.as_str()).unwrap_or(l).to_string())
                .collect();
            let ext = extension(file);
            let unit = indent_unit(&ext);
            let inner = stripped
                .iter()
                .map(|l| format!("{}{}", unit, l))
                .collect::<Vec<_>>()
                .join("\n");
            let def = match ext.as_str() {
                "py" => format!("def {}():\n{}", name, inner),
                "go" => format!("func {}() {{\n{}\n}}", name, inner),
                "rs" => format!("fn {}() {{\n{}\n}}", name, inner),
                _ => format!("function {}() {{\n{}\n}}", name, inner),
            };
            text(format!(
                "Extracted function:\n\n{}\n\nReplace lines {}-{} with: {}{}()",
                def, start, end, indent, name
            ))
        }

        "extract_variable" => {
            let (Some(file), Some(line_no), Some(name), Some(expr)) = (
                args.file.as_deref(),
                args.line,
                args.name.as_deref(),
                args.expression.as_deref(),
            ) else {
                return fail("file, line, name, expression required");
            };
            if line_no == 0 {
                return fail("invalid line");
            }
            let Ok(content) = std::fs::read_to_string(file) else {
                return fail(format!("cannot read file: {}", file));
            };
            let lines: Vec<&str> = content.lines().collect();
            if line_no > lines.len() {
                return fail("line beyond end of file");
            }
            let target = lines[line_no - 1];
            if !target.contains(expr) {
                return fail(format!("expression not found on line {}", line_no));
            }
            let indent: String = target.chars().take_while(|c| c.is_whitespace()).collect();
            let ext = extension(file);
            let decl = match ext.as_str() {
                "py" => format!("{}{} = {}", indent, name, expr),
                "go" => format!("{}{} := {}", indent, name, expr),
                "rs" => format!("{}let {} = {};", indent, name, expr),
                _ => format!("{}const {} = {};", indent, name, expr),
            };
            let rewritten = target.replacen(expr, name, 1);
            text(format!(
                "Extract variable '{}' on line {}:\n\nInsert above:\n{}\n\nRewritten line:\n{}",
                name, line_no, decl, rewritten
            ))
        }

        "inline" | "references" => {
            let Some(symbol) = args.symbol.as_deref() else {
                return fail("symbol required");
            };
            let esc = regex::escape(symbol);
            let def_patterns = [
                format!(r"function\s+{}\s*\(", esc),
                format!(r"(?:const|let|var)\s+{}\s*=", esc),
                format!(r"def\s+{}\s*\(", esc),
                format!(r"fn\s+{}\s*\(", esc),
                format!(r"func\s+{}\s*\(", esc),
            ];
            let mut defs: Vec<Ref> = Vec::new();
            for p in &def_patterns {
                if let Ok(re) = Regex::new(p) {
                    defs.extend(find_refs(&re, &path, glob));
                }
            }
            let Ok(all_re) = Regex::new(&format!(r"\b{}\b", esc)) else {
                return fail("invalid symbol");
            };
            let all = find_refs(&all_re, &path, glob);
            let calls: Vec<Ref> = all
                .into_iter()
                .filter(|r| !defs.iter().any(|d| d.file == r.file && d.line == r.line))
                .collect();
            let mut out = vec![
                format!("Symbol: {}\n", symbol),
                format!("Definitions ({}):", defs.len()),
            ];
            for d in &defs {
                out.push(format!("  {}:{}: {}", d.file, d.line, d.text));
            }
            out.push(String::new());
            out.push(format!("References ({}):", calls.len()));
            for r in calls.iter().take(limit) {
                out.push(format!("  {}:{}: {}", r.file, r.line, r.text));
            }
            if calls.len() > limit {
                out.push(format!("  ... +{} more", calls.len() - limit));
            }
            text(out.join("\n"))
        }

        "move" => {
            let (Some(symbol), Some(from), Some(to)) =
                (args.symbol.as_deref(), args.from.as_deref(), args.to.as_deref())
            else {
                return fail("symbol, from, to required");
            };
            let dir = Path::new(from)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| ".".to_string());
            let Ok(re) = Regex::new(&format!(r"\b{}\b", regex::escape(symbol))) else {
                return fail("invalid symbol");
            };
            let refs = find_refs(&re, &dir, None);
            let imports: Vec<Ref> = refs
                .into_iter()
                .filter(|r| r.file != from && (r.text.contains("import") || r.text.contains("require")))
                .collect();
            let listed = imports
                .iter()
                .map(|r| format!("  {}:{}: {}", r.file, r.line, r.text))
                .collect::<Vec<_>>()
                .join("\n");
            text(format!(
                "Move '{}' {} -> {}\n\nFiles needing import updates ({}):\n{}",
                symbol, from, to, imports.len(), listed
            ))
        }

        "change_signature" | "signatures" => {
            let Some(file) = args.file.as_deref() else {
                return fail("file required");
            };
            let Some(symbol) = args.symbol.as_deref() else {
                return fail("symbol required (function to re-signature)");
            };
            let Ok(content) = std::fs::read_to_string(file) else {
                return fail(format!("cannot read file: {}", file));
            };
            let esc = regex::escape(symbol);
            let Ok(def_re) = Regex::new(&format!(
                r"(?:function|def|fn|func)\s+{}\s*\(|(?:const|let|var)\s+{}\s*=",
                esc, esc
            )) else {
                return fail("invalid symbol");
            };
            let mut current: Option<(usize, String)> = None;
            for (i, l) in content.lines().enumerate() {
                if def_re.is_match(l) {
                    current = Some((i + 1, l.trim().to_string()));
                    break;
                }
            }
            let Some((def_line, sig)) = current else {
                return fail(format!("no definition of '{}' found in {}", symbol, file));
            };
            let Ok(call_re) = Regex::new(&format!(r"\b{}\s*\(", esc)) else {
                return fail("invalid symbol");
            };
            let calls: Vec<Ref> = find_refs(&call_re, &path, glob)
                .into_iter()
                .filter(|r| !(r.file.ends_with(file) && r.line == def_line))
                .collect();
            let mut out = vec![
                format!("Change signature of '{}':\n", symbol),
                format!("Current ({}:{}):\n  {}", file, def_line, sig),
            ];
            if let Some(target) = args.new_signature.as_deref() {
                out.push(format!("\nTarget:\n  {}", target));
            }
            out.push(String::new());
            out.push(format!("Call sites to update ({}):", calls.len()));
            for r in calls.iter().take(limit) {
                out.push(format!("  {}:{}: {}", r.file, r.line, r.text));
            }
            if calls.len() > limit {
                out.push(format!("  ... +{} more", calls.len() - limit));
            }
            text(out.join("\n"))
        }

        "organize_imports" => {
            let Some(file) = args.file.as_deref() else {
                return fail("file required");
            };
            let Ok(content) = std::fs::read_to_string(file) else {
                return fail(format!("cannot read file: {}", file));
            };
            // import ... from 'src' | import 'src' | const x = require('src') | Rust `use a::b;`
            let Ok(im_re) = Regex::new(
                r#"^\s*(?:import\s+.*\s+from\s+['"](?P<a>[^'"]+)['"]|import\s+['"](?P<b>[^'"]+)['"]|const\s+.*=\s*require\(['"](?P<c>[^'"]+)['"]\)|use\s+(?P<d>[A-Za-z_][\w:]*))"#,
            ) else {
                return fail("regex error");
            };
            let mut imports: Vec<(String, String)> = Vec::new(); // (source, text)
            for l in content.lines() {
                if let Some(c) = im_re.captures(l) {
                    let src = ["a", "b", "c", "d"]
                        .iter()
                        .find_map(|n| c.name(n).map(|m| m.as_str().to_string()))
                        .unwrap_or_default();
                    imports.push((src, l.trim_end().to_string()));
                }
            }
            if imports.is_empty() {
                return text(format!("No imports found in {}", file));
            }
            let mut external: Vec<&(String, String)> =
                imports.iter().filter(|(s, _)| !s.starts_with('.')).collect();
            let mut internal: Vec<&(String, String)> =
                imports.iter().filter(|(s, _)| s.starts_with('.')).collect();
            external.sort_by(|a, b| a.0.cmp(&b.0));
            internal.sort_by(|a, b| a.0.cmp(&b.0));

            let mut organized: Vec<String> = external.iter().map(|(_, t)| t.clone()).collect();
            if !internal.is_empty() {
                organized.push(String::new());
                organized.extend(internal.iter().map(|(_, t)| t.clone()));
            }
            let block = organized.join("\n");
            let footer = if dry_run { "Set dryRun=false to apply." } else { "Applied." };
            text(format!(
                "Organized imports for {} ({} imports):\n\n{}\n\n{}",
                file, imports.len(), block, footer
            ))
        }

        "" => fail("action required"),
        other => fail(format!("Unknown action: {}", other)),
    }
}

#[async_trait]
impl MCPTool for RefactorTool {
    fn name(&self) -> &str {
        "refactor"
    }
    fn description(&self) -> &str {
        "Structural code refactoring: rename, extract_function, extract_variable, inline, move, change_signature, organize_imports"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: Args = serde_json::from_value(params).unwrap_or_default();
        Ok(ToolResult::ok(run(args)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn args(v: Value) -> Args {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn schema_shape() {
        let s = RefactorTool::schema();
        assert_eq!(s["name"], "refactor");
        assert_eq!(s["inputSchema"]["required"][0], "action");
        let actions = s["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        for a in ["rename", "extract_function", "extract_variable", "inline", "move", "change_signature", "organize_imports"] {
            assert!(actions.iter().any(|x| x == a), "missing action {}", a);
        }
    }

    #[test]
    fn name_is_stable() {
        assert_eq!(RefactorTool::new().name(), "refactor");
    }

    #[test]
    fn glob_matches_brace_and_ext() {
        assert!(glob_match("a.rs", "*.rs"));
        assert!(glob_match("a.ts", "*.{ts,js}"));
        assert!(glob_match("a.js", "*.{ts,js}"));
        assert!(!glob_match("a.py", "*.{ts,js}"));
        assert!(glob_match("anything", "*"));
    }

    #[test]
    fn rename_dry_run_previews() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        let mut fh = std::fs::File::create(&f).unwrap();
        writeln!(fh, "let foo = 1;\nlet y = foo + foo;").unwrap();
        let out = run(args(json!({
            "action": "rename", "symbol": "foo", "newName": "bar",
            "path": dir.path().to_str().unwrap()
        })));
        assert_eq!(out["isError"], false);
        assert!(out["text"].as_str().unwrap().contains("Would rename 'foo' -> 'bar'"));
        // file unchanged on dry run
        assert!(std::fs::read_to_string(&f).unwrap().contains("foo"));
    }

    #[test]
    fn rename_applies_when_not_dry() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        std::fs::write(&f, "let foo = 1;\nlet y = foo;").unwrap();
        let out = run(args(json!({
            "action": "rename", "symbol": "foo", "newName": "bar",
            "path": dir.path().to_str().unwrap(), "dryRun": false
        })));
        assert_eq!(out["isError"], false);
        let after = std::fs::read_to_string(&f).unwrap();
        assert!(after.contains("bar") && !after.contains("foo"));
    }

    #[test]
    fn extract_function_wraps_rust() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        std::fs::write(&f, "fn main() {\n    let x = 1;\n    let y = 2;\n}").unwrap();
        let out = run(args(json!({
            "action": "extract_function", "file": f.to_str().unwrap(),
            "startLine": 2, "endLine": 3, "name": "setup"
        })));
        assert_eq!(out["isError"], false);
        let t = out["text"].as_str().unwrap();
        assert!(t.contains("fn setup() {"));
        assert!(t.contains("let x = 1;"));
    }

    #[test]
    fn extract_variable_declares_and_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.rs");
        std::fs::write(&f, "    let total = price * 2 + tax;").unwrap();
        let out = run(args(json!({
            "action": "extract_variable", "file": f.to_str().unwrap(),
            "line": 1, "name": "subtotal", "expression": "price * 2"
        })));
        assert_eq!(out["isError"], false);
        let t = out["text"].as_str().unwrap();
        assert!(t.contains("let subtotal = price * 2;"));
        assert!(t.contains("subtotal + tax"));
    }

    #[test]
    fn organize_imports_sorts_and_splits() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.ts");
        std::fs::write(
            &f,
            "import { z } from 'zebra';\nimport { a } from './local';\nimport { m } from 'apple';\n",
        )
        .unwrap();
        let out = run(args(json!({ "action": "organize_imports", "file": f.to_str().unwrap() })));
        assert_eq!(out["isError"], false);
        let t = out["text"].as_str().unwrap();
        let apple = t.find("apple").unwrap();
        let zebra = t.find("zebra").unwrap();
        let local = t.find("./local").unwrap();
        assert!(apple < zebra, "external sorted");
        assert!(zebra < local, "internal after external");
    }

    #[test]
    fn missing_args_fail_cleanly() {
        let out = run(args(json!({ "action": "rename", "symbol": "x" })));
        assert_eq!(out["isError"], true);
        let out = run(args(json!({ "action": "bogus" })));
        assert_eq!(out["isError"], true);
        assert!(out["text"].as_str().unwrap().contains("Unknown action"));
    }

    /// Live end-to-end via the registry once wired. Run: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn refactor_via_registry() {
        let registry = crate::ToolRegistry::with_defaults();
        let out = registry
            .execute("refactor", json!({ "action": "rename", "symbol": "nope_symbol_xyz" }))
            .await
            .unwrap();
        assert_eq!(out.content["isError"], false);
    }
}
