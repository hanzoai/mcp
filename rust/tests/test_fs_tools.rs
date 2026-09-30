//! fs against python-sdk's contract: `uri` (or `path`), the unified
//! `{ok, data, error, meta}` envelope, hashes as `sha256:<hex>`, `write` that
//! only creates, and `apply_patch` guarded by the hash a read returned.

use hanzo_mcp::tools::{FsTool, FsToolArgs};
use serde_json::{json, Value};
use tempfile::TempDir;

async fn fs(args: Value) -> Value {
    let args: FsToolArgs = serde_json::from_value(args).unwrap();
    serde_json::from_str(&FsTool::new().execute(args).await.unwrap()).unwrap()
}

fn at(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).display().to_string()
}

#[tokio::test]
async fn write_creates_and_read_numbers_lines_with_the_hash() {
    let d = TempDir::new().unwrap();
    let f = at(&d, "sub/a.txt");
    let w = fs(json!({"action": "write", "uri": f, "content": "one\ntwo\nthree\n"})).await;
    assert_eq!(w["ok"], true, "{w}");
    assert_eq!(w["meta"]["action"], "write");
    let hash = w["data"]["hash"].as_str().unwrap().to_string();
    assert!(hash.starts_with("sha256:") && hash.len() == 71);

    let r = fs(json!({"action": "read", "path": f, "offset": 1, "limit": 1})).await;
    assert_eq!(r["data"]["text"], "     2│two");
    assert_eq!(r["data"]["total_lines"], 3);
    assert_eq!(r["data"]["hash"], hash);
    assert!(r["data"]["uri"].as_str().unwrap().starts_with("file:///"));

    let again = fs(json!({"action": "write", "uri": f, "content": "x"})).await;
    assert_eq!((again["ok"].clone(), again["error"]["code"].clone()), (json!(false), json!("CONFLICT")));
}

#[tokio::test]
async fn apply_patch_needs_the_current_hash_and_a_unique_match() {
    let d = TempDir::new().unwrap();
    let f = at(&d, "b.txt");
    std::fs::write(&f, "alpha beta beta\n").unwrap();
    let hash = fs(json!({"action": "stat", "uri": f})).await["data"]["hash"].as_str().unwrap().to_string();

    let stale = fs(json!({"action": "apply_patch", "uri": f, "old_text": "alpha", "new_text": "A", "base_hash": "sha256:0"})).await;
    assert_eq!(stale["error"]["code"], "CONFLICT");
    let twice = fs(json!({"action": "apply_patch", "uri": f, "old_text": "beta", "new_text": "B", "base_hash": hash})).await;
    assert_eq!(twice["error"]["code"], "INVALID_PARAMS");

    let ok = fs(json!({"action": "apply_patch", "uri": f, "old_text": "alpha", "new_text": "A", "base_hash": hash})).await;
    assert_eq!(ok["data"]["previous_hash"], hash);
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "A beta beta\n");
}

#[tokio::test]
async fn list_walks_to_depth_filters_and_pages() {
    let d = TempDir::new().unwrap();
    for f in ["a.rs", "b.txt", "src/c.rs", "src/deep/d.rs"] {
        let p = d.path().join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
    }
    let root = d.path().display().to_string();
    let one = fs(json!({"action": "list", "uri": root})).await;
    let names: Vec<&str> = one["data"]["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["a.rs", "b.txt", "src"]);
    assert_eq!(one["data"]["entries"][2]["is_dir"], true);

    let deep = fs(json!({"action": "list", "uri": root, "depth": 3, "pattern": "*.rs"})).await;
    let names: Vec<&str> = deep["data"]["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["a.rs"], "a directory that fails the pattern is not entered: {deep}");

    let page = fs(json!({"action": "list", "uri": root, "limit": 2})).await;
    assert_eq!(page["data"]["paging"], json!({"cursor": "2", "more": true, "total": 3}));
    let rest = fs(json!({"action": "list", "uri": root, "limit": 2, "cursor": "2"})).await;
    assert_eq!(rest["data"]["entries"][0]["name"], "src");
}

#[tokio::test]
async fn search_text_finds_lines_under_a_glob() {
    let d = TempDir::new().unwrap();
    std::fs::write(d.path().join("a.rs"), "fn main() {}\nlet needle = 1;\n").unwrap();
    std::fs::write(d.path().join("b.txt"), "needle\n").unwrap();
    let s = fs(json!({"action": "search_text", "pattern": "needle", "uri": d.path().display().to_string(), "glob": "*.rs"})).await;
    let m = s["data"]["matches"].as_array().unwrap();
    assert_eq!(m.len(), 1, "{s}");
    assert_eq!((m[0]["line"].clone(), m[0]["text"].clone()), (json!(2), json!("let needle = 1;")));
}

#[tokio::test]
async fn patch_applies_the_rust_grammar() {
    let d = TempDir::new().unwrap();
    std::fs::write(d.path().join("u.txt"), "keep\nold\n").unwrap();
    std::fs::write(d.path().join("gone.txt"), "x").unwrap();
    std::env::set_current_dir(d.path()).unwrap();
    let p = fs(json!({"action": "patch", "input": "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: u.txt\n@@\n keep\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch"})).await;
    assert_eq!(p["data"]["success"], true, "{p}");
    assert_eq!(std::fs::read_to_string(d.path().join("new.txt")).unwrap(), "hello\n");
    assert_eq!(std::fs::read_to_string(d.path().join("u.txt")).unwrap(), "keep\nnew\n");
    assert!(!d.path().join("gone.txt").exists());
}

#[tokio::test]
async fn mv_mkdir_and_a_guarded_rm() {
    let d = TempDir::new().unwrap();
    let dir = at(&d, "x/y");
    assert_eq!(fs(json!({"action": "mkdir", "uri": dir})).await["data"]["created"], true);
    assert_eq!(fs(json!({"action": "mkdir", "uri": dir})).await["data"]["created"], false);
    std::fs::write(at(&d, "f"), "1").unwrap();
    let m = fs(json!({"action": "mv", "uri": at(&d, "f"), "destination": at(&d, "x/y/g")})).await;
    assert_eq!(m["data"]["moved"], true);
    assert_eq!(fs(json!({"action": "rm", "uri": at(&d, "x")})).await["error"]["code"], "INVALID_PARAMS");
    assert_eq!(fs(json!({"action": "rm", "uri": at(&d, "x"), "confirm": true})).await["data"]["removed"], true);
    assert!(!d.path().join("x").exists());
}

#[tokio::test]
async fn paths_are_absolute_and_actions_are_named() {
    assert_eq!(fs(json!({"action": "read", "uri": "relative.txt"})).await["error"]["message"], "Path must be absolute");
    let bad = fs(json!({"action": "edit", "uri": "/tmp/x"})).await;
    assert!(bad["error"]["message"].as_str().unwrap().starts_with("Unknown action 'edit'. Available: read, write, stat, list"));
    let help = fs(json!({})).await;
    assert_eq!(help["data"]["actions"].as_array().unwrap().len(), 10);
}

#[tokio::test]
async fn an_image_reads_as_pixels() {
    let d = TempDir::new().unwrap();
    let png = [0x89, b'P', b'N', b'G', 13, 10, 26, 10];
    std::fs::write(d.path().join("i.png"), png).unwrap();
    let r = fs(json!({"action": "read", "uri": at(&d, "i.png")})).await;
    assert_eq!(r["data"]["mime"], "image/png");
    assert_eq!(r["data"]["image"]["data"], "iVBORw0KGgo=");
}
