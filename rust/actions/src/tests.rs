use super::*;
use crate::ask::Script;
use crate::run::{Grant, Refuse};
use std::path::Path;
use std::process::Command;

fn sh(dir: &Path, args: &[&str]) {
    let ok = Command::new(args[0])
        .args(&args[1..])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(ok, "{args:?} failed in {}", dir.display());
}

fn write(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap_or_default();
    }
    std::fs::write(p, body).unwrap_or_default();
}

/// A repository with a bare remote beside it: `root/ws` and `root/remote.git`.
fn repo(root: &Path) -> std::path::PathBuf {
    let ws = root.join("ws");
    std::fs::create_dir_all(&ws).unwrap_or_default();
    sh(root, &["git", "init", "-q", "--bare", "remote.git"]);
    sh(&ws, &["git", "init", "-q", "-b", "main"]);
    sh(&ws, &["git", "config", "user.email", "a@b"]);
    sh(&ws, &["git", "config", "user.name", "a"]);
    write(
        &ws,
        "src/lib.py",
        "def parse_header(x):\n    return x\n\ndef other():\n    return parse_header(1)\n",
    );
    write(
        &ws,
        "README.md",
        "# Title\n\n## Notes\n\n- one\n\n## Other\n\ntext\n",
    );
    sh(&ws, &["git", "add", "-A"]);
    sh(&ws, &["git", "commit", "-q", "-m", "first"]);
    sh(&ws, &["git", "remote", "add", "origin", "../remote.git"]);
    sh(&ws, &["git", "push", "-q", "origin", "main"]);
    ws
}

fn engine<'a>(
    cache: Option<&'a Store>,
    chooser: Option<&'a dyn Chooser>,
    approver: &'a dyn Approver,
) -> Engine<'a> {
    Engine {
        chooser,
        cache,
        approver,
        cfg: Config {
            require_proof: false,
            ..Config::default()
        },
        prove: false,
    }
}

#[test]
fn a_unique_request_runs_without_asking_kai() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let e = engine(None, None, &Grant);
    let r = perform(
        &e,
        &ws,
        "Find all uses of `parse_header` and write the path:line list to answer.txt",
    );
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert_eq!(r.kai_calls, 0);
    assert_eq!(r.records[0].source, crate::ledger::Origin::Rule);
    let got = std::fs::read_to_string(ws.join("answer.txt")).unwrap_or_default();
    assert_eq!(
        got.lines().collect::<Vec<_>>(),
        vec!["src/lib.py:1", "src/lib.py:5"]
    );
}

#[test]
fn publish_commits_only_the_named_paths_and_needs_approval() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    write(&ws, "a.txt", "a\n");
    write(&ws, "b.txt", "b\n");
    let ask = "Commit `a.txt` with the message \"Add a\" and push it to origin";
    let denied = perform(&engine(None, None, &Refuse), &ws, ask);
    assert!(matches!(denied.outcome, Outcome::Declined(_)), "{denied:?}");
    assert!(denied.records[0].authorization.required && !denied.records[0].authorization.granted);
    let r = perform(&engine(None, None, &Grant), &ws, ask);
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert!(r.records[0].authorization.required && r.records[0].authorization.granted);
    let remote = Command::new("git")
        .args([
            "--git-dir",
            "../remote.git",
            "log",
            "-1",
            "--format=%s",
            "main",
        ])
        .current_dir(&ws)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    assert_eq!(remote, "Add a");
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&ws)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    assert_eq!(status.trim(), "?? b.txt");
}

#[test]
fn a_request_with_a_part_nothing_serves_is_declined_not_trimmed() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    write(&ws, "a.txt", "a\n");
    // The tests come first, but this repository has none: commit and push alone would drop the condition.
    let ask = "Run the tests, and if they pass commit `a.txt` with the message \"Add a\" and push";
    let r = perform(&engine(None, None, &Grant), &ws, ask);
    assert!(matches!(r.outcome, Outcome::Declined(_)), "{r:?}");
    assert!(r.records.is_empty());
}

#[test]
fn an_ambiguous_request_asks_kai_once_and_abstaining_declines() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let ask =
        "Show lines 1 to 2 of `src/lib.py` and find all uses of `parse_header`, writing to out.txt";
    let none = Script(vec![]);
    let r = perform(&engine(None, Some(&none), &Grant), &ws, ask);
    assert!(matches!(r.outcome, Outcome::Declined(_)), "{r:?}");
    assert_eq!(r.kai_calls, 1);
    assert!(r.asks.iter().any(|a| a.question == "action" && !a.accepted));
    let picks = Script(vec![("action".into(), "slice".into())]);
    let r = perform(&engine(None, Some(&picks), &Grant), &ws, ask);
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert_eq!(r.target.as_deref(), Some("slice"));
    assert_eq!(r.records[0].source, crate::ledger::Origin::Kai);
}

#[test]
fn the_cache_reuses_a_pure_result_until_a_read_file_changes() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let store = Store::open(&dir.path().join("cache")).unwrap_or_else(|e| panic!("{e}"));
    let e = engine(Some(&store), None, &Grant);
    let ask = "Show lines 1 to 2 of `src/lib.py` in out.txt";
    let first = perform(&e, &ws, ask);
    assert_eq!(first.outcome, Outcome::Done, "{first:?}");
    assert!(!first.records.is_empty(), "{first:?}");
    assert_eq!(first.records[0].cache.memo, "miss");
    write(&ws, "unrelated.txt", "x\n");
    let second = perform(&e, &ws, ask);
    assert!(!second.records.is_empty(), "{:?}", second.outcome);
    assert_eq!(second.records[0].cache.memo, "hit", "{second:?}");
    write(&ws, "src/lib.py", "def parse_header(x):\n    return 2\n");
    let third = perform(&e, &ws, ask);
    assert_eq!(third.records[0].cache.memo, "miss");
}

#[test]
fn an_unproven_action_does_not_run() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let store = Store::open(&dir.path().join("cache")).unwrap_or_else(|e| panic!("{e}"));
    let strict = Engine {
        chooser: None,
        cache: Some(&store),
        approver: &Grant,
        cfg: Config::default(),
        prove: false,
    };
    let ask = "Find all uses of `parse_header`";
    assert!(
        matches!(perform(&strict, &ws, ask).outcome, Outcome::Declined(ref w) if w.starts_with("unproven"))
    );
    let proving = Engine {
        prove: true,
        ..strict
    };
    assert_eq!(perform(&proving, &ws, ask).outcome, Outcome::Done);
    let again = Engine {
        chooser: None,
        cache: Some(&store),
        approver: &Grant,
        cfg: Config::default(),
        prove: false,
    };
    assert_eq!(perform(&again, &ws, ask).outcome, Outcome::Done);
}

#[test]
fn a_note_goes_under_its_heading_and_nothing_else_moves() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let e = engine(None, None, &Grant);
    let r = perform(
        &e,
        &ws,
        "Add the line \"- two\" at the end of the Notes section of `README.md`",
    );
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    let body = std::fs::read_to_string(ws.join("README.md")).unwrap_or_default();
    assert_eq!(
        body,
        "# Title\n\n## Notes\n\n- one\n- two\n\n## Other\n\ntext\n"
    );
}

#[test]
fn credentials_never_reach_a_record() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    write(&ws, "env.txt", "token=abcdef0123456789 ok\n");
    let e = engine(None, None, &Grant);
    let r = perform(&e, &ws, "Show lines 1 to 1 of `env.txt` in out.txt");
    let json = serde_json::to_string(&r).unwrap_or_default();
    assert!(!json.contains("abcdef0123456789"), "{json}");
}

#[test]
fn a_commit_the_request_describes_is_bound_without_asking_kai() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    write(&ws, "src/fetch.py", "retry = 3\n");
    sh(&ws, &["git", "add", "-A"]);
    sh(
        &ws,
        &["git", "commit", "-q", "-m", "add retry logic to fetch"],
    );
    write(&ws, "docs/guide.md", "fixed\n");
    sh(&ws, &["git", "add", "-A"]);
    sh(&ws, &["git", "commit", "-q", "-m", "fix typo in the docs"]);
    let e = engine(None, None, &Grant);
    let r = perform(
        &e,
        &ws,
        "List the files changed by the commit that added the retry logic, one path per line, in files.txt",
    );
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert_eq!(r.kai_calls, 0);
    assert_eq!(
        std::fs::read_to_string(ws.join("files.txt"))
            .unwrap_or_default()
            .trim(),
        "src/fetch.py"
    );
}

#[test]
fn a_results_file_must_hold_the_arms_the_request_names() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let row = |t: &str, a: &str, s: f64| {
        format!("{{\"task\":\"{t}\",\"arm\":\"{a}\",\"seconds\":{s},\"solve\":true}}\n")
    };
    write(
        &ws,
        "results/a.jsonl",
        &(row("t1", "kai", 1.0)
            + &row("t1", "native", 4.0)
            + &row("t2", "kai", 2.0)
            + &row("t2", "native", 6.0)),
    );
    write(
        &ws,
        "results/b.jsonl",
        &(row("t1", "lite", 1.0) + &row("t1", "native", 4.0)),
    );
    let e = engine(None, None, &Grant);
    let r = perform(
        &e,
        &ws,
        "Compare arm `kai` over arm `native` in the results file that has both arms, writing to out.txt",
    );
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert_eq!(r.kai_calls, 0);
    let got = std::fs::read_to_string(ws.join("out.txt")).unwrap_or_default();
    assert!(
        got.contains("n=2 faster=2") && got.contains("median_speedup=3.500"),
        "{got}"
    );
}

#[test]
fn a_value_that_looks_like_an_option_is_declined() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    let e = engine(None, None, &Grant);
    let r = perform(
        &e,
        &ws,
        "Create a git worktree for the new branch `--force` off `main` at `../wt`.",
    );
    assert!(matches!(r.outcome, Outcome::Declined(_)), "{r:?}");
    assert!(!dir.path().join("wt").exists());
}

#[test]
fn staging_neither_follows_a_link_out_nor_copies_from_outside_unasked() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let ws = repo(dir.path());
    write(&ws, "fixtures/a.txt", "a\n");
    write(dir.path(), "secret.txt", "s\n");
    std::os::unix::fs::symlink(dir.path().join("secret.txt"), ws.join("fixtures/link.txt"))
        .unwrap_or_default();
    let ask = "Copy the contents of `fixtures/` into `staging/`";
    let r = perform(&engine(None, None, &Grant), &ws, ask);
    assert_eq!(r.outcome, Outcome::Done, "{r:?}");
    assert!(ws.join("staging/a.txt").exists() && !ws.join("staging/link.txt").exists());
    let outside = perform(
        &engine(None, None, &Refuse),
        &ws,
        "Copy the contents of `../` into `staging2/`",
    );
    assert!(
        matches!(outside.outcome, Outcome::Declined(_)),
        "{outside:?}"
    );
}
