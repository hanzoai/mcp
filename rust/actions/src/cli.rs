//! `hanzo-mcp kai`: run a request as a Kai action, or list the catalog.
//!
//! ```text
//! hanzo-mcp kai run --cwd DIR (--request TEXT | --request-file FILE) [--kai URL] [--model kai] [--key-env NAME]
//!             [--cache DIR] [--approve grant] [--prove] [--min-margin X] [--min-p X] [--max-abstain X]
//! hanzo-mcp kai plan   (the same flags: binds the request and prints what would run, runs nothing)
//! hanzo-mcp kai list
//! hanzo-mcp kai triggers --request TEXT
//! ```
//!
//! `run` prints one JSON report: the outcome (`done`, `failed`, `declined`), the ledger records,
//! and what asking Kai cost. Exit status is 0 when the request was done, 2 when it was declined
//! (the normal agent should take it), 3 when an action ran and failed.

use crate::bind::Config;
use crate::ledger::Outcome;
use crate::run::{Grant, Refuse};
use crate::{Engine, Kai, Store, catalog, perform, workflow};
use std::path::PathBuf;

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// `hanzo-mcp kai ARGS`: the arguments after `kai`. Returns the exit status.
pub fn main(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("list") => {
            list();
            0
        }
        Some("triggers") => {
            triggers(&args[1..]);
            0
        }
        Some("run") => run(&args[1..], false),
        Some("plan") => run(&args[1..], true),
        _ => {
            eprintln!("usage: hanzo-mcp kai run --cwd DIR --request TEXT [--kai URL] [--cache DIR] | hanzo-mcp kai list | hanzo-mcp kai triggers --request TEXT");
            64
        }
    }
}

fn list() {
    let actions: Vec<serde_json::Value> = catalog::all()
        .iter()
        .map(|a| {
            let s = a.spec();
            serde_json::json!({ "id": s.id, "version": s.version, "summary": s.summary, "effect": s.effect, "inputs": s.inputs.iter().map(|i| i.name).collect::<Vec<_>>() })
        })
        .collect();
    let workflows: Vec<serde_json::Value> = workflow::all().iter().map(|w| serde_json::json!({ "id": w.id, "version": w.version, "summary": w.summary, "steps": w.parts.iter().map(|p| p.action).collect::<Vec<_>>() })).collect();
    println!(
        "{}",
        serde_json::json!({ "actions": actions, "workflows": workflows })
    );
}

/// The ids of the actions and workflows whose triggers fit a request, as a JSON array.
fn triggers(args: &[String]) {
    let ids: Vec<&str> = crate::triggered(&flag(args, "--request").unwrap_or_default())
        .iter()
        .map(crate::bind::Target::id)
        .collect();
    println!("{}", serde_json::json!(ids));
}

fn run(args: &[String], plan_only: bool) -> i32 {
    let Some(cwd) = flag(args, "--cwd").map(PathBuf::from) else {
        eprintln!("--cwd is required");
        return 64;
    };
    let request = match (flag(args, "--request"), flag(args, "--request-file")) {
        (Some(r), _) => r,
        (None, Some(f)) => match std::fs::read_to_string(&f) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{f}: {e}");
                return 64;
            }
        },
        _ => {
            eprintln!("--request or --request-file is required");
            return 64;
        }
    };
    let kai = flag(args, "--kai").map(|url| {
        Kai::new(
            &url,
            &flag(args, "--model").unwrap_or_else(|| "kai".into()),
            flag(args, "--key-env").and_then(|n| std::env::var(n).ok()),
        )
    });
    let store = match flag(args, "--cache")
        .map(|d| Store::open(&PathBuf::from(d)))
        .transpose()
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return 64;
        }
    };
    let mut cfg = Config::default();
    if let Some(v) = flag(args, "--min-margin").and_then(|v| v.parse().ok()) {
        cfg.min_margin = v;
    }
    if let Some(v) = flag(args, "--min-p").and_then(|v| v.parse().ok()) {
        cfg.min_p = v;
    }
    if let Some(v) = flag(args, "--max-abstain").and_then(|v| v.parse().ok()) {
        cfg.max_abstain = v;
    }
    let approver: &dyn crate::Approver =
        if flag(args, "--approve").as_deref() == Some("grant") {
            &Grant
        } else {
            &Refuse
        };
    let engine = Engine {
        chooser: kai.as_ref().map(|k| k as &dyn crate::Chooser),
        cache: store.as_ref(),
        approver,
        cfg,
        prove: args.iter().any(|a| a == "--prove"),
    };
    if plan_only {
        println!("{}", crate::run::plan_report(&engine, &cwd, &request));
        return 0;
    }
    let report = perform(&engine, &cwd, &request);
    match serde_json::to_string(&report) {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("{e}");
            return 70;
        }
    }
    match report.outcome {
        Outcome::Done | Outcome::Skipped(_) => 0,
        Outcome::Declined(_) => 2,
        Outcome::Failed(_) => 3,
    }
}
