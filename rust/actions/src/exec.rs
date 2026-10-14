//! Running a program with an argument vector, never a shell string, under a time limit.
//!
//! Credentials in the environment are not handed on (names holding KEY, TOKEN, SECRET, PASSWORD,
//! CREDENTIAL or AUTH), so a project's script cannot read the model's login.

use crate::redact::{redact, secret};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One command an action ran.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    /// The argument vector, redacted.
    pub argv: Vec<String>,
    pub code: Option<i32>,
    pub ms: f64,
}

/// What a command printed.
#[derive(Debug, Clone)]
pub struct Out {
    pub step: Step,
    pub stdout: String,
    pub stderr: String,
}

impl Out {
    pub fn ok(&self) -> bool {
        self.step.code == Some(0)
    }

    /// Both streams, stdout first.
    pub fn text(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

/// Runs `argv` in `cwd`, killed after `limit`.
pub fn run(cwd: &Path, argv: &[&str], limit: Duration) -> Result<Out, String> {
    let (program, args) = argv.split_first().ok_or("empty command")?;
    let started = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, _) in std::env::vars() {
        if secret(&name) {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    let mut child = command.spawn().map_err(|e| format!("{program}: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let (out, err, code) = std::thread::scope(|scope| {
        let a = scope.spawn(move || {
            let mut s = Vec::new();
            let _ = stdout.read_to_end(&mut s);
            s
        });
        let b = scope.spawn(move || {
            let mut s = Vec::new();
            let _ = stderr.read_to_end(&mut s);
            s
        });
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) if started.elapsed() > limit => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => break None,
            }
        };
        (
            a.join().unwrap_or_default(),
            b.join().unwrap_or_default(),
            code,
        )
    });
    Ok(Out {
        step: Step {
            argv: argv.iter().map(|a| redact(a)).collect(),
            code,
            ms: started.elapsed().as_secs_f64() * 1000.0,
        },
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
    })
}

/// `git` in `cwd`; its stdout trimmed when it succeeds.
pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut argv = vec!["git"];
    argv.extend_from_slice(args);
    let out = run(cwd, &argv, Duration::from_secs(60))?;
    if out.ok() {
        Ok(out.stdout.trim_end().to_string())
    } else {
        Err(format!("git {}: {}", args.join(" "), out.stderr.trim()))
    }
}
