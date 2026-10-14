//! Kai Cache: what an action has been seen to do, and the results it can reuse.
//!
//! Two kinds of receipt share one file of JSON lines.
//!
//! A *proof* says an action, at this version and with these tools, ran in this environment and its
//! verifier passed. An action runs on its own only when a proof matches (an unproven or changed
//! action goes to the normal agent). A *memo* says a pure action, given these arguments, produced
//! this output while everything it reads was exactly as fingerprinted. A fingerprint covers only
//! what the action declares it reads (a file's content as it is on disk, uncommitted edits
//! included; or the commit and refs), so an edit to an unrelated file leaves a memo valid, and it
//! is computed again just before the action would run.

use crate::action::{Action, Args, Reads};
use crate::redact::{cut, redact};
use crate::state::{State, sha256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    /// `proof` or `memo`.
    pub kind: String,
    pub key: String,
    pub action: String,
    pub version: u32,
    pub at: String,
    /// A memo's output (redacted) and data.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

pub struct Store {
    file: PathBuf,
}

fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

impl Store {
    /// The cache in `dir`, created if it is not there.
    pub fn open(dir: &std::path::Path) -> Result<Store, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Store {
            file: dir.join("receipts.jsonl"),
        })
    }

    fn all(&self) -> Vec<Receipt> {
        std::fs::read_to_string(&self.file)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    fn add(&self, r: &Receipt) -> Result<(), String> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)
            .map_err(|e| format!("{}: {e}", self.file.display()))?;
        let line = serde_json::to_string(r).map_err(|e| e.to_string())?;
        writeln!(f, "{line}").map_err(|e| e.to_string())
    }

    pub fn proved(&self, key: &str) -> bool {
        self.all().iter().any(|r| r.kind == "proof" && r.key == key)
    }

    pub fn prove(&self, action: &dyn Action, key: &str) -> Result<(), String> {
        if self.proved(key) {
            return Ok(());
        }
        let s = action.spec();
        self.add(&Receipt {
            kind: "proof".into(),
            key: key.into(),
            action: s.id.into(),
            version: s.version,
            at: now(),
            text: String::new(),
            data: serde_json::Value::Null,
        })
    }

    pub fn memo(&self, key: &str) -> Option<Receipt> {
        self.all()
            .into_iter()
            .rev()
            .find(|r| r.kind == "memo" && r.key == key)
    }

    pub fn remember(
        &self,
        action: &dyn Action,
        key: &str,
        text: &str,
        data: &serde_json::Value,
    ) -> Result<(), String> {
        let s = action.spec();
        self.add(&Receipt {
            kind: "memo".into(),
            key: key.into(),
            action: s.id.into(),
            version: s.version,
            at: now(),
            text: cut(&redact(text), 8192),
            data: data.clone(),
        })
    }
}

fn tool_versions() -> &'static Mutex<BTreeMap<String, String>> {
    static V: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// The first line of `tool --version`, or a marker for a program that is not there.
pub fn version(tool: &str) -> String {
    let mut cache = tool_versions()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(v) = cache.get(tool) {
        return v.clone();
    }
    let args: &[&str] = if tool == "go" {
        &["version"]
    } else {
        &["--version"]
    };
    let v = match tool {
        "sh" | "kill" => "builtin".to_string(),
        _ => std::process::Command::new(tool)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .map(|o| {
                String::from_utf8_lossy(if o.stdout.is_empty() {
                    &o.stderr
                } else {
                    &o.stdout
                })
                .lines()
                .next()
                .unwrap_or("")
                .to_string()
            })
            .unwrap_or_else(|_| "absent".to_string()),
    };
    cache.insert(tool.to_string(), v.clone());
    v
}

fn tools_of(action: &dyn Action) -> String {
    action
        .spec()
        .tools
        .iter()
        .map(|t| format!("{t}={}", version(t)))
        .collect::<Vec<_>>()
        .join(";")
}

/// The key of an action's proof: which action, which version, which tools.
pub fn proof_key(action: &dyn Action) -> String {
    let s = action.spec();
    sha256(format!("proof|{}|{}|{}", s.id, s.version, tools_of(action)).as_bytes())
}

/// What an action reads, as one digest: the content of the files it declares as they are on disk,
/// or the commit and refs.
fn reads_digest(state: &State, reads: &Reads) -> String {
    match reads {
        Reads::Files(paths) => {
            let mut parts = Vec::new();
            for p in paths {
                parts.push(format!(
                    "{p}={}",
                    sha256(&std::fs::read(state.root.join(p)).unwrap_or_default())
                ));
            }
            parts.join("\n")
        }
        Reads::Tree => {
            let mut parts = Vec::new();
            for p in state.files() {
                parts.push(format!(
                    "{p}={}",
                    sha256(&std::fs::read(state.root.join(&p)).unwrap_or_default())
                ));
            }
            parts.join("\n")
        }
        Reads::Git => {
            let refs = state
                .git(&["for-each-ref", "--format=%(refname) %(objectname)"])
                .unwrap_or_default();
            format!("{}\n{refs}", state.head().unwrap_or_default())
        }
    }
}

/// The key of a result: the action, its tools, its arguments, and what it reads.
pub fn memo_key(action: &dyn Action, state: &State, args: &Args) -> String {
    let s = action.spec();
    let canonical = serde_json::to_string(args).unwrap_or_default();
    let reads = reads_digest(state, &action.reads(state, args));
    sha256(
        format!(
            "memo|{}|{}|{}|{canonical}|{reads}",
            s.id,
            s.version,
            tools_of(action)
        )
        .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;
    use serde_json::json;

    #[test]
    fn a_memo_survives_an_unrelated_edit_and_dies_with_a_related_one() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap_or_default();
        std::fs::write(root.join("b.txt"), "other\n").unwrap_or_default();
        let action = catalog::get("slice").unwrap_or_else(|| panic!("no slice"));
        let state = State::new(root, "");
        let args: Args = [
            ("path".to_string(), json!("a.txt")),
            ("from".to_string(), json!("1")),
            ("to".to_string(), json!("2")),
        ]
        .into_iter()
        .collect();
        let before = memo_key(action, &state, &args);
        std::fs::write(root.join("b.txt"), "changed\n").unwrap_or_default();
        assert_eq!(
            before,
            memo_key(action, &state, &args),
            "an unrelated file moved the key"
        );
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap_or_default();
        assert_ne!(
            before,
            memo_key(action, &state, &args),
            "a read file did not move the key"
        );
    }

    #[test]
    fn proofs_and_memos_are_kept_apart() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        let action = catalog::get("find").unwrap_or_else(|| panic!("no find"));
        let key = proof_key(action);
        assert!(!store.proved(&key));
        assert!(store.prove(action, &key).is_ok());
        assert!(store.proved(&key));
        assert!(store.memo(&key).is_none());
        assert!(
            store
                .remember(action, "k", "token=abcdef123456 found", &json!({}))
                .is_ok()
        );
        let got = store.memo("k").map(|r| r.text).unwrap_or_default();
        assert!(!got.contains("abcdef123456"), "{got}");
    }
}
