//! The engine over real trees written to a temp dir. Documents are built byte by byte, as
//! tgrep's own tests build them (MIT), so nothing here depends on an archive library.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use hanzo_trigram::search;
use hanzo_trigram::Kind;
use hanzo_trigram::Mark;
use hanzo_trigram::Query;
use tempfile::TempDir;

mod fixture;

fn tree(files: &[(&str, &str)]) -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    // A repository root, so .gitignore applies as it does for rg.
    fs::create_dir(dir.path().join(".git")).unwrap();
    for (name, body) in files {
        write(dir.path(), name, body.as_bytes());
    }
    dir
}

fn write(root: &Path, name: &str, body: &[u8]) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn lines(hits: &[hanzo_trigram::Hit]) -> Vec<(String, u64)> {
    hits.iter()
        .map(|hit| (hit.path.display().to_string(), hit.line))
        .collect()
}

#[test]
fn a_text_query_finds_lines_with_their_numbers() {
    let dir = tree(&[("a.txt", "one\nneedle here\nthree\nneedle again\n"), ("b.txt", "none\n")]);
    let hits = search(&Query::text(dir.path(), "needle")).unwrap();
    assert_eq!(lines(&hits), vec![("a.txt".into(), 2), ("a.txt".into(), 4)]);
    assert_eq!(hits[0].excerpt, "needle here");
    assert_eq!(hits[0].mark, Mark::Match);
    assert_eq!(hits[0].score, 2);
}

#[test]
fn files_with_more_matching_lines_come_first_then_path_order() {
    let dir = tree(&[
        ("a.txt", "x\n"),
        ("b.txt", "x\nx\nx\n"),
        ("c.txt", "x\n"),
        ("d.txt", "x\nx\n"),
    ]);
    let hits = search(&Query::text(dir.path(), "x")).unwrap();
    let files: Vec<String> = hits.iter().map(|h| h.path.display().to_string()).collect();
    assert_eq!(
        files,
        vec!["b.txt", "b.txt", "b.txt", "d.txt", "d.txt", "a.txt", "c.txt"]
    );
}

#[test]
fn the_same_query_gives_the_same_list_every_time() {
    let files: Vec<(String, String)> = (0..40)
        .map(|i| (format!("dir{}/f{i}.rs", i % 5), "fn target() {}\ntarget();\n".to_string()))
        .collect();
    let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let dir = tree(&refs);
    let first = search(&Query::text(dir.path(), "target")).unwrap();
    for _ in 0..5 {
        assert_eq!(first, search(&Query::text(dir.path(), "target")).unwrap());
    }
    assert_eq!(first.len(), 80);
}

#[test]
fn a_glob_keeps_and_a_bang_glob_drops() {
    let dir = tree(&[("a.rs", "hit\n"), ("b.py", "hit\n"), ("sub/c.rs", "hit\n"), ("sub/d.md", "hit\n")]);
    let mut query = Query::text(dir.path(), "hit");
    query.glob = vec!["*.rs".into()];
    let kept: Vec<String> = search(&query).unwrap().iter().map(|h| h.path.display().to_string()).collect();
    assert_eq!(kept, vec!["a.rs", "sub/c.rs"]);

    query.glob = vec!["!*.rs".into()];
    let dropped: Vec<String> = search(&query).unwrap().iter().map(|h| h.path.display().to_string()).collect();
    assert_eq!(dropped, vec!["b.py", "sub/d.md"]);

    query.glob = vec!["sub/*.rs".into()];
    let anchored: Vec<String> = search(&query).unwrap().iter().map(|h| h.path.display().to_string()).collect();
    assert_eq!(anchored, vec!["sub/c.rs"]);
}

#[test]
fn gitignored_hidden_and_binary_files_are_not_read() {
    let dir = tree(&[
        (".gitignore", "ignored.txt\nbuild/\n"),
        ("seen.txt", "needle\n"),
        ("ignored.txt", "needle\n"),
        ("build/out.txt", "needle\n"),
        (".hidden/x.txt", "needle\n"),
    ]);
    write(dir.path(), "blob.bin", b"needle\0needle");
    write(dir.path(), "image.png", b"needle");
    let hits = search(&Query::text(dir.path(), "needle")).unwrap();
    assert_eq!(lines(&hits), vec![("seen.txt".into(), 1)]);
}

#[test]
fn a_symbol_ranks_its_definitions_before_its_uses() {
    let dir = tree(&[
        ("a_uses.py", "from m import Parser\np = Parser()\nq = Parser()\nr = Parser()\n"),
        ("z_defines.py", "class Parser:\n    pass\n"),
        ("sub/ParserX.py", "ParserX = 1\nParserXY()\n"),
    ]);
    let hits = search(&Query::symbol(dir.path(), "Parser")).unwrap();
    assert_eq!(hits[0].path, PathBuf::from("z_defines.py"));
    assert_eq!(hits[0].mark, Mark::Definition);
    assert!(hits[1..].iter().all(|h| h.mark == Mark::Reference));
    assert_eq!(hits.len(), 5, "ParserX is another name, not a use of Parser");
    assert!(hits.iter().all(|h| !h.path.starts_with("sub")));
    assert_eq!(hits[0].score, 1 << 32);
}

#[test]
fn declarations_are_recognised_across_languages() {
    let dir = tree(&[(
        "defs.txt",
        "fn name() {}\ndef name():\nfunc (r *T) name() {}\nconst name = 1;\nname = function() {}\n#define name 1\nuse name;\nlet x = name + 1;\n",
    )]);
    let hits = search(&Query::symbol(dir.path(), "name")).unwrap();
    let marks: Vec<Mark> = {
        let mut hits = hits.clone();
        hits.sort_by_key(|h| h.line);
        hits.iter().map(|h| h.mark).collect()
    };
    use Mark::*;
    assert_eq!(
        marks,
        vec![Definition, Definition, Definition, Definition, Definition, Definition, Reference, Reference]
    );
}

#[test]
fn a_literal_and_case_folding() {
    let dir = tree(&[("a.txt", "a.b\naxb\nA.B\n")]);
    let mut query = Query::text(dir.path(), "a.b");
    query.fixed = true;
    assert_eq!(lines(&search(&query).unwrap()), vec![("a.txt".into(), 1)]);
    query.ignore_case = true;
    assert_eq!(lines(&search(&query).unwrap()), vec![("a.txt".into(), 1), ("a.txt".into(), 3)]);
    assert_eq!(
        lines(&search(&Query::text(dir.path(), "a.b")).unwrap()),
        vec![("a.txt".into(), 1), ("a.txt".into(), 2)]
    );
}

#[test]
fn a_bad_pattern_is_an_error_not_an_empty_list() {
    let dir = tree(&[("a.txt", "x\n")]);
    assert!(matches!(search(&Query::text(dir.path(), "(")), Err(hanzo_trigram::Error::Pattern(_))));
    assert!(matches!(search(&Query::text(dir.path(), "")), Err(hanzo_trigram::Error::Pattern(_))));
    let mut query = Query::text(dir.path(), "x");
    query.glob = vec!["[".into()];
    assert!(matches!(search(&query), Err(hanzo_trigram::Error::Pattern(_))));
    query.glob.clear();
    query.paths = vec![PathBuf::from("missing")];
    assert!(matches!(search(&query), Err(hanzo_trigram::Error::Io(..))));
}

#[test]
fn limit_keeps_the_best_hits() {
    let dir = tree(&[("a.txt", "x\n"), ("b.txt", "x\nx\n"), ("c.txt", "x\nx\nx\n")]);
    let mut query = Query::text(dir.path(), "x");
    query.limit = Some(4);
    let hits = search(&query).unwrap();
    assert_eq!(hits.len(), 4);
    assert!(hits[..3].iter().all(|h| h.path == PathBuf::from("c.txt")));
    assert_eq!(hits[3].path, PathBuf::from("b.txt"));
}

#[test]
fn context_lines_come_with_the_hit() {
    let dir = tree(&[("a.txt", "1\n2\nhit\n4\n5\n")]);
    let mut query = Query::text(dir.path(), "hit");
    query.context = 2;
    let hit = &search(&query).unwrap()[0];
    assert_eq!((hit.before.clone(), hit.after.clone()), (vec!["1".to_string(), "2".to_string()], vec!["4".to_string(), "5".to_string()]));
    query.context = 1;
    let hit = &search(&query).unwrap()[0];
    assert_eq!((hit.before.len(), hit.after.len()), (1, 1));
}

#[test]
fn crlf_files_and_a_missing_final_newline() {
    let dir = tree(&[]);
    write(dir.path(), "w.txt", b"one\r\ntwo needle\r\nthree");
    write(dir.path(), "n.txt", b"needle");
    let hits = search(&Query::text(dir.path(), "needle")).unwrap();
    assert_eq!(lines(&hits), vec![("n.txt".into(), 1), ("w.txt".into(), 2)]);
    assert_eq!(hits[1].excerpt, "two needle");
}

#[test]
fn a_pattern_cannot_match_across_lines() {
    let dir = tree(&[("a.txt", "foo\nbar\nfoo bar\n")]);
    let hits = search(&Query::text(dir.path(), r"foo\s+bar")).unwrap();
    assert_eq!(lines(&hits), vec![("a.txt".into(), 3)]);
}

#[test]
fn an_excerpt_is_cut_and_a_file_past_the_cap_is_not_read() {
    let long = format!("needle {}", "é".repeat(2000));
    let dir = tree(&[("a.txt", &long)]);
    let hits = search(&Query::text(dir.path(), "needle")).unwrap();
    assert_eq!(hits[0].excerpt.chars().count(), hanzo_trigram::EXCERPT);

    let dir = tree(&[]);
    let big = vec![b'x'; (hanzo_trigram::MAX_FILE + 1) as usize];
    write(dir.path(), "big.txt", &big);
    write(dir.path(), "small.txt", b"xx");
    let hits = search(&Query::text(dir.path(), "xx")).unwrap();
    assert_eq!(lines(&hits), vec![("small.txt".into(), 1)]);
}

#[test]
fn a_named_file_is_read_even_when_the_tree_would_skip_it() {
    let dir = tree(&[(".gitignore", "skip.txt\n"), ("skip.txt", "needle\n")]);
    assert!(search(&Query::text(dir.path(), "needle")).unwrap().is_empty());
    let mut query = Query::text(dir.path(), "needle");
    query.paths = vec![PathBuf::from("skip.txt")];
    assert_eq!(lines(&search(&query).unwrap()), vec![("skip.txt".into(), 1)]);
}

#[test]
fn a_per_file_cap_keeps_one_file_from_filling_the_list() {
    let body = "hit\n".repeat(hanzo_trigram::PER_FILE + 500);
    let dir = tree(&[("a.txt", &body), ("b.txt", "hit\n")]);
    let hits = search(&Query::text(dir.path(), "hit")).unwrap();
    assert_eq!(hits.len(), hanzo_trigram::PER_FILE + 1);
}

mod documents {
    use super::*;
    use crate::fixture;

    #[test]
    fn a_glob_names_a_document_by_its_extension_only() {
        use hanzo_trigram::names_document;
        for glob in ["*.pdf", "report.pdf", "docs/*.docx", "*.{docx,xlsx}", "*.tar.gz", "*.ZIP"] {
            assert!(names_document(glob), "{glob}");
        }
        for glob in ["*.rs", "zip/*.rs", "pdf_*.txt", "*", "pdf", "src/**/*.{rs,py}", "docs/*"] {
            assert!(!names_document(glob), "{glob}");
        }
    }

    #[test]
    fn a_pdf_page_a_zip_member_and_their_places() {
        let dir = tree(&[]);
        write(dir.path(), "report.pdf", &fixture::pdf(&[&["cover"], &["quarterly revenue", "second line"]]));
        write(
            dir.path(),
            "bundle.zip",
            &fixture::zip(&[("notes/todo.txt", b"call the bank\nrevenue plan\n".as_slice())]),
        );
        write(dir.path(), "plain.txt", b"revenue\n");

        let mut query = Query::text(dir.path(), "revenue");
        let plain = search(&query).unwrap();
        assert_eq!(lines(&plain), vec![("plain.txt".into(), 1)], "documents are opt-in under a tree");

        query.documents = true;
        let hits = search(&query).unwrap();
        let places: Vec<(String, Option<String>, Option<String>, u64)> = hits
            .iter()
            .map(|h| (h.path.display().to_string(), h.entry.clone(), h.place.clone(), h.line))
            .collect();
        assert!(places.contains(&("report.pdf".into(), None, Some("page 2".into()), 1)), "{places:?}");
        assert!(places.contains(&("bundle.zip".into(), Some("notes/todo.txt".into()), None, 2)), "{places:?}");
        assert!(places.contains(&("plain.txt".into(), None, None, 1)));
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn a_document_named_in_paths_is_read_without_the_flag() {
        let dir = tree(&[]);
        write(dir.path(), "report.pdf", &fixture::pdf(&[&["alpha"], &["beta needle"]]));
        let mut query = Query::text(dir.path(), "needle");
        query.paths = vec![PathBuf::from("report.pdf")];
        let hits = search(&query).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].place.as_deref(), Some("page 2"));
        assert_eq!(hits[0].excerpt, "beta needle");
        assert_eq!(hits[0].mark, Mark::Match);
        assert_eq!(Kind::Text, Kind::default());
    }

    #[test]
    fn a_corrupt_document_is_skipped_not_an_error() {
        let dir = tree(&[("ok.txt", "needle\n")]);
        write(dir.path(), "broken.pdf", b"%PDF-1.4 this is not a pdf needle");
        write(dir.path(), "broken.zip", b"PK\x03\x04 nope needle");
        let mut query = Query::text(dir.path(), "needle");
        query.documents = true;
        assert_eq!(lines(&search(&query).unwrap()), vec![("ok.txt".into(), 1)]);
    }
}
