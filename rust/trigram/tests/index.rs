//! The on-disk index must change how fast a search is, never what it finds. Every query here is
//! asked three ways on the same tree, scanned, indexed (`Index::Only`, which refuses to scan, so
//! the index really answered) and by default, and the three lists must be equal, before and
//! after the tree changes under the index.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

use hanzo_trigram::index;
use hanzo_trigram::search;
use hanzo_trigram::Error;
use hanzo_trigram::Hit;
use hanzo_trigram::Index;
use hanzo_trigram::Query;
use tempfile::TempDir;

mod fixture;

fn put(root: &Path, name: &str, body: &[u8]) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn project() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".git")).unwrap();
    put(dir.path(), ".gitignore", b"target/\n*.log\n");
    put(dir.path(), "src/lib.rs", b"pub struct Parser;\nimpl Parser { pub fn parse(&self) {} }\n// Parser notes\n");
    put(dir.path(), "src/main.rs", b"fn main() { let p = Parser; p.parse(); }\n");
    put(dir.path(), "src/deep/util.py", b"class Parser:\n    def parse(self):\n        return 'needle'\n");
    put(dir.path(), "docs/readme.md", b"The Parser reads text. needle in a haystack.\n");
    put(dir.path(), "target/out.rs", b"Parser needle\n");
    put(dir.path(), "run.log", b"Parser needle\n");
    put(dir.path(), ".hidden/x.txt", b"Parser needle\n");
    put(dir.path(), "data.bin", b"Parser\0needle");
    put(dir.path(), "crlf.txt", b"one\r\nParser two\r\nthree");
    for i in 0..40 {
        put(dir.path(), &format!("many/f{i}.txt"), format!("filler {i}\nline two {i}\n").as_bytes());
    }
    dir
}

fn key(hits: &[Hit]) -> Vec<(PathBuf, Option<String>, Option<String>, u64, String)> {
    hits.iter()
        .map(|h| (h.path.clone(), h.entry.clone(), h.place.clone(), h.line, h.excerpt.clone()))
        .collect()
}

/// The queries every check asks.
fn queries(root: &Path) -> Vec<Query> {
    let mut all = Vec::new();
    for pattern in ["needle", "Parser", r"Parse\w+", r"fn\s+\w+\(", "filler 7", "zzz-no-such-text", "parse", r"(?i)PARSER", "."] {
        all.push(Query::text(root, pattern));
    }
    for name in ["Parser", "parse", "main", "nothing"] {
        all.push(Query::symbol(root, name));
    }
    let mut q = Query::text(root, "needle");
    q.glob = vec!["*.py".into()];
    all.push(q);
    let mut q = Query::text(root, "Parser");
    q.glob = vec!["!*.md".into(), "src/**".into()];
    all.push(q);
    let mut q = Query::text(root, "parser");
    q.ignore_case = true;
    q.context = 1;
    all.push(q);
    let mut q = Query::text(root, "a.b");
    q.fixed = true;
    all.push(q);
    let mut q = Query::text(root, "Parser");
    q.limit = Some(3);
    all.push(q);
    let mut q = Query::symbol(root, "Parser");
    q.paths = vec![PathBuf::from("src")];
    all.push(q);
    all
}

fn same(root: &Path) {
    for query in queries(root) {
        let mut scan = query.clone();
        scan.index = Index::Skip;
        let mut only = query.clone();
        only.index = Index::Only;
        let expect = search(&scan).unwrap();
        let by_index = search(&only).unwrap_or_else(|e| panic!("{:?}: {e}", query.pattern));
        assert_eq!(key(&expect), key(&by_index), "{} {:?} {:?}", query.pattern, query.kind, query.glob);
        assert_eq!(key(&expect), key(&search(&query).unwrap()), "default: {}", query.pattern);
    }
}

#[test]
fn no_index_is_an_error_only_when_asked_to_use_one() {
    let dir = project();
    assert!(index::status(dir.path()).is_none());
    let mut q = Query::text(dir.path(), "needle");
    q.index = Index::Only;
    assert!(matches!(search(&q), Err(Error::Unindexed(_))));
    q.index = Index::Auto;
    assert!(!search(&q).unwrap().is_empty(), "Auto scans when there is no index");
}

#[test]
fn an_indexed_search_finds_what_a_scan_finds() {
    let dir = project();
    let status = index::build(dir.path()).unwrap();
    assert!(status.usable && status.files > 40, "{status:?}");
    assert_eq!(status.root, dir.path().canonicalize().unwrap());
    same(dir.path());
}

#[test]
fn an_index_is_found_from_a_subdirectory() {
    let dir = project();
    index::build(dir.path()).unwrap();
    let sub = dir.path().join("src");
    assert_eq!(index::locate(&sub), Some(dir.path().to_path_buf()));
    let mut q = Query::text(&sub, "Parser");
    q.index = Index::Only;
    let mut scan = q.clone();
    scan.index = Index::Skip;
    assert_eq!(key(&search(&q).unwrap()), key(&search(&scan).unwrap()));
    assert!(!search(&q).unwrap().is_empty());
}

#[test]
fn what_changes_after_the_build_is_still_found() {
    let dir = project();
    let root = dir.path();
    // tgrep stamps an index in whole seconds, and a change in the same second counts as after.
    index::build(root).unwrap();
    sleep(Duration::from_millis(1100));

    // An edit that adds a match, an edit that removes one, a new file, a deleted file, a rename.
    put(root, "src/lib.rs", b"pub struct Parser;\n// brand new needle\n");
    put(root, "src/deep/util.py", b"class Other:\n    pass\n");
    put(root, "src/fresh.rs", b"fn fresh() { /* needle Parser */ }\n");
    fs::remove_file(root.join("docs/readme.md")).unwrap();
    fs::rename(root.join("crlf.txt"), root.join("renamed.txt")).unwrap();
    same(root);

    let mut q = Query::text(root, "needle");
    q.index = Index::Only;
    let found: Vec<String> = search(&q).unwrap().iter().map(|h| h.path.display().to_string()).collect();
    assert!(found.contains(&"src/fresh.rs".to_string()) && found.contains(&"src/lib.rs".to_string()), "{found:?}");
    assert!(!found.contains(&"docs/readme.md".to_string()) && !found.contains(&"src/deep/util.py".to_string()), "{found:?}");
    let mut q = Query::text(root, "Parser two");
    q.index = Index::Only;
    assert_eq!(search(&q).unwrap()[0].path, PathBuf::from("renamed.txt"));
}

#[test]
fn a_file_changed_in_the_second_of_the_build_is_not_missed() {
    let dir = project();
    let root = dir.path();
    index::build(root).unwrap();
    put(root, "late.txt", b"needle late\n");
    put(root, "src/main.rs", b"fn main() { /* needle */ }\n");
    same(root);
}

#[test]
fn documents_follow_the_flag_with_or_without_an_index() {
    let dir = project();
    let root = dir.path();
    put(root, "report.pdf", &fixture::pdf(&[&["cover"], &["quarterly needle"]]));
    put(root, "b.zip", &fixture::zip(&[("n/todo.txt", b"plan needle\n".as_slice())]));
    index::build(root).unwrap();
    for documents in [false, true] {
        let mut scan = Query::text(root, "needle");
        scan.documents = documents;
        let mut only = scan.clone();
        scan.index = Index::Skip;
        only.index = Index::Only;
        let expect = search(&scan).unwrap();
        assert_eq!(key(&expect), key(&search(&only).unwrap()), "documents={documents}");
        let docs = expect.iter().filter(|h| h.place.is_some() || h.entry.is_some()).count();
        assert_eq!(docs > 0, documents, "{expect:?}");
    }
}

#[test]
fn a_file_the_index_lists_but_the_tree_no_longer_has_is_not_reported() {
    let dir = project();
    let root = dir.path();
    index::build(root).unwrap();
    for i in 0..40 {
        fs::remove_file(root.join(format!("many/f{i}.txt"))).unwrap();
    }
    let mut q = Query::text(root, "filler");
    q.index = Index::Only;
    assert!(search(&q).unwrap().is_empty());
}
