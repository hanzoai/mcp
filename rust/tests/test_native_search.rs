//! `fs search_text` and `code search_symbol` over the in-process engine: the contract the two
//! tools keep (envelope, `uri` as `file://`, a cursor that really pages) and what the engine
//! adds (ranking, documents by glob, `.gitignore`), plus the library door Dev links.

use hanzo_mcp::tools::{CodeTool, CodeToolArgs, FsTool, FsToolArgs};
use serde_json::{json, Value};
use tempfile::TempDir;

#[path = "../trigram/tests/fixture/mod.rs"]
mod fixture;

async fn fs(args: Value) -> Value {
    let args: FsToolArgs = serde_json::from_value(args).unwrap();
    serde_json::from_str(&FsTool::new().execute(args).await.unwrap()).unwrap()
}

async fn code(args: Value) -> Value {
    let args: CodeToolArgs = serde_json::from_value(args).unwrap();
    CodeTool::new().execute(args).await.unwrap()
}

fn tree(files: &[(&str, &str)]) -> TempDir {
    let d = TempDir::new().unwrap();
    std::fs::create_dir(d.path().join(".git")).unwrap();
    for (name, body) in files {
        let p = d.path().join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    d
}

fn uris(r: &Value) -> Vec<String> {
    r["data"]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["uri"].as_str().unwrap().rsplit('/').next().unwrap().to_string() + ":" + &m["line"].to_string())
        .collect()
}

#[tokio::test]
async fn a_cursor_pages_the_ranked_list_without_gaps_or_repeats() {
    let d = tree(&[("a.txt", "hit\n"), ("b.txt", "hit\nhit\n"), ("c.txt", "hit\n"), ("d.txt", "hit\nhit\nhit\n"), ("e.txt", "hit\n")]);
    let root = d.path().display().to_string();
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut call = json!({"action": "search_text", "pattern": "hit", "uri": root, "limit": 3});
        if let Some(c) = &cursor {
            call["cursor"] = json!(c);
        }
        let r = fs(call).await;
        assert_eq!(r["ok"], true, "{r}");
        seen.extend(uris(&r));
        pages += 1;
        match r["data"]["paging"]["cursor"].as_str() {
            Some(c) => {
                assert_eq!(r["data"]["paging"]["more"], true);
                cursor = Some(c.to_string());
            }
            None => {
                assert_eq!(r["data"]["paging"]["more"], false);
                break;
            }
        }
        assert!(pages < 10);
    }
    assert_eq!(pages, 3);
    // Densest file first, then path order; the pages are one list.
    assert_eq!(
        seen,
        ["d.txt:1", "d.txt:2", "d.txt:3", "b.txt:1", "b.txt:2", "a.txt:1", "c.txt:1", "e.txt:1"]
    );
}

#[tokio::test]
async fn the_answer_keeps_its_shape_and_honours_gitignore() {
    let d = tree(&[(".gitignore", "out/\n"), ("src/a.rs", "let needle = 1;\n"), ("out/b.rs", "needle\n")]);
    let r = fs(json!({"action": "search_text", "pattern": "needle", "uri": d.path().display().to_string()})).await;
    assert_eq!((r["ok"].clone(), r["meta"]["action"].clone()), (json!(true), json!("search_text")));
    let m = r["data"]["matches"].as_array().unwrap();
    assert_eq!(m.len(), 1, "{r}");
    assert!(m[0]["uri"].as_str().unwrap().starts_with("file:///") && m[0]["uri"].as_str().unwrap().ends_with("/src/a.rs"));
    assert_eq!((m[0]["line"].clone(), m[0]["text"].clone()), (json!(1), json!("let needle = 1;")));
    assert!(m[0].get("entry").is_none() && m[0].get("place").is_none());
    assert_eq!(r["data"]["pattern"], "needle");
}

#[tokio::test]
async fn a_single_file_is_searched_where_a_directory_would_skip_it() {
    let d = tree(&[(".gitignore", "skip.txt\n"), ("skip.txt", "needle\nhay\nneedle\n")]);
    let file = d.path().join("skip.txt").display().to_string();
    let r = fs(json!({"action": "search_text", "pattern": "needle", "uri": file})).await;
    assert_eq!(uris(&r), ["skip.txt:1", "skip.txt:3"]);
}

#[tokio::test]
async fn a_bad_regex_and_a_missing_path_are_refused_with_their_codes() {
    let d = tree(&[("a.txt", "x\n")]);
    let bad = fs(json!({"action": "search_text", "pattern": "(", "uri": d.path().display().to_string()})).await;
    assert_eq!((bad["ok"].clone(), bad["error"]["code"].clone()), (json!(false), json!("INVALID_PARAMS")), "{bad}");
    let gone = fs(json!({"action": "search_text", "pattern": "x", "uri": d.path().join("nope").display().to_string()})).await;
    assert_eq!(gone["error"]["code"], "NOT_FOUND", "{gone}");
    let none = fs(json!({"action": "search_text", "uri": d.path().display().to_string()})).await;
    assert_eq!(none["error"]["code"], "INVALID_PARAMS");
}

#[tokio::test]
async fn a_glob_that_names_documents_reads_them_and_says_where() {
    let d = tree(&[("a.txt", "revenue\n")]);
    std::fs::write(d.path().join("r.pdf"), fixture::pdf(&[&["cover"], &["quarterly revenue"]])).unwrap();
    std::fs::write(d.path().join("b.zip"), fixture::zip(&[("n/todo.txt", b"plan revenue\n".as_slice())])).unwrap();
    let root = d.path().display().to_string();

    let plain = fs(json!({"action": "search_text", "pattern": "revenue", "uri": root})).await;
    assert_eq!(uris(&plain), ["a.txt:1"], "a tree search reads text");

    let pdf = fs(json!({"action": "search_text", "pattern": "revenue", "uri": root, "glob": "*.pdf"})).await;
    let m = &pdf["data"]["matches"][0];
    assert_eq!((m["place"].clone(), m["line"].clone(), m["text"].clone()), (json!("page 2"), json!(1), json!("quarterly revenue")), "{pdf}");

    let zip = fs(json!({"action": "search_text", "pattern": "revenue", "uri": root, "glob": "*.zip"})).await;
    assert_eq!(zip["data"]["matches"][0]["entry"], "n/todo.txt", "{zip}");
}

#[tokio::test]
async fn search_symbol_puts_definitions_first_and_reads_code_files() {
    let d = tree(&[
        ("a_use.py", "from m import Parser\nx = Parser()\n"),
        ("z_def.py", "class Parser:\n    pass\n"),
        ("notes.md", "the Parser is described here\n"),
        ("sub/ParserX.py", "ParserX = 1\n"),
    ]);
    let root = d.path().display().to_string();
    let r = code(json!({"action": "search_symbol", "query": "Parser", "uri": root})).await;
    assert_eq!(r["ok"], true, "{r}");
    let hits = r["data"]["results"].as_array().unwrap();
    assert_eq!(r["data"]["count"], 3);
    assert_eq!((hits[0]["type"].clone(), hits[0]["line"].clone()), (json!("definition"), json!(1)));
    assert!(hits[0]["uri"].as_str().unwrap().ends_with("z_def.py"));
    assert!(hits[1..].iter().all(|h| h["type"] == "reference" && h["uri"].as_str().unwrap().ends_with("a_use.py")));

    let md = code(json!({"action": "search_symbol", "query": "Parser", "uri": root, "pattern": "*.md"})).await;
    assert_eq!(md["data"]["count"], 1, "{md}");

    let one = code(json!({"action": "search_symbol", "query": "Parser", "uri": root, "max_results": 1})).await;
    assert_eq!(one["data"]["count"], 1);
    assert_eq!(one["data"]["results"][0]["type"], "definition");
}

#[test]
fn dev_links_the_engine_as_a_library() {
    let d = tree(&[("a.rs", "fn main() {}\n")]);
    let hits = hanzo_mcp::trigram::search(&hanzo_mcp::trigram::Query::symbol(d.path(), "main")).unwrap();
    assert_eq!((hits.len(), hits[0].mark), (1, hanzo_mcp::trigram::Mark::Definition));
}
