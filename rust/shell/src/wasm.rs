//! The wasm-bindgen surface: `classify(command, options_json) -> report_json`.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::{classify as read, Context};

#[derive(Deserialize, Default)]
#[serde(default)]
struct Options {
    cwd: Option<String>,
    home: Option<String>,
    roots: Vec<String>,
    temp: Option<Vec<String>>,
    remote: bool,
}

/// Classifies `command`; `options` is JSON: `{"cwd": "/work/app", "home": "/home/me",
/// "roots": ["/work/other"], "temp": ["/tmp"], "remote": false}`. Returns JSON:
/// `{"risk": "allow" | "ask" | "deny", "findings": [{"risk", "kind", "reason"}]}`.
#[wasm_bindgen]
pub fn classify(command: &str, options: &str) -> String {
    let o: Options = serde_json::from_str(options).unwrap_or_default();
    let mut ctx = Context::new(o.cwd.as_deref(), o.home.as_deref());
    ctx.roots = o.roots;
    if let Some(t) = o.temp {
        ctx.temp = t;
    }
    ctx.remote = o.remote;
    serde_json::to_string(&read(command, &ctx)).unwrap_or_else(|_| "{\"risk\":\"ask\",\"findings\":[]}".to_string())
}
