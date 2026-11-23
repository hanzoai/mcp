//! `gimp` — Clean-room BSD-3 GIMP Procedural Database (PDB) TCP JSON bridge.
//!
//! Mirrors `src/tools/gimp.ts` (absorbed under `computer` action=`gimp`, and
//! callable directly via legacy `tools/call` alias `gimp`).

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::{envelope_err, envelope_ok};
use crate::{MCPTool, ToolResult};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9876;

async fn gimp_request(method: &str, params: Value, host: &str, port: u16) -> Result<Value> {
    let addr = format!("{}:{}", host, port);
    let stream = tokio::time::timeout(Duration::from_secs(60), TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow!("GIMP bridge timed out connecting to {addr}"))?
        .map_err(|e| anyhow!("GIMP bridge connection failed ({addr}): {e}"))?;

    let (reader, mut writer) = stream.into_split();
    let id = chrono::Utc::now().timestamp_millis();
    let line = format!("{}\n", json!({ "id": id, "method": method, "params": params }));
    writer.write_all(line.as_bytes()).await?;

    let mut lines = BufReader::new(reader).lines();
    let reply = tokio::time::timeout(Duration::from_secs(60), lines.next_line())
        .await
        .map_err(|_| anyhow!("GIMP bridge timed out waiting for reply"))??
        .ok_or_else(|| anyhow!("GIMP bridge closed connection without reply"))?;

    let msg: Value = serde_json::from_str(&reply)
        .map_err(|e| anyhow!("Invalid response from GIMP bridge: {e}"))?;
    if let Some(err) = msg.get("error") {
        let m = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("GIMP bridge error");
        return Err(anyhow!("{m}"));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

pub struct GimpTool;

impl GimpTool {
    pub fn new() -> Self {
        Self
    }

    pub fn schema() -> Value {
        json!({
            "name": "gimp",
            "description": "GIMP automation via the clean-room BSD-3 bridge (JSON-over-TCP to the GIMP PDB): version, open, export, pdb_call, new_image, image_info, list_procedures, flatten.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["version", "open", "export", "pdb_call", "new_image", "image_info", "list_procedures", "flatten"],
                        "description": "GIMP action"
                    },
                    "path": { "type": "string", "description": "File path (open, export)" },
                    "image_id": { "type": "number", "description": "GIMP image id (export, image_info, flatten)" },
                    "procedure": { "type": "string", "description": "PDB procedure name (pdb_call)" },
                    "args": { "type": "array", "items": {}, "description": "Positional PDB args (pdb_call)" },
                    "width": { "type": "number", "description": "Image width (new_image)" },
                    "height": { "type": "number", "description": "Image height (new_image)" },
                    "prefix": { "type": "string", "description": "Filter procedures by name prefix (list_procedures)" },
                    "host": { "type": "string", "default": DEFAULT_HOST },
                    "port": { "type": "number", "default": DEFAULT_PORT }
                },
                "required": ["action"]
            }
        })
    }
}

impl Default for GimpTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for GimpTool {
    fn name(&self) -> &str {
        "gimp"
    }

    fn description(&self) -> &str {
        "GIMP automation via the clean-room BSD-3 PDB TCP bridge"
    }

    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let action = params
            .get("gimp_action")
            .or_else(|| params.get("sub_action"))
            .or_else(|| params.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let host = params.get("host").and_then(Value::as_str).unwrap_or(DEFAULT_HOST);
        let port = params
            .get("port")
            .and_then(Value::as_u64)
            .map(|p| p as u16)
            .unwrap_or(DEFAULT_PORT);

        let req = match action {
            "version" => ("version", json!({})),
            "open" => {
                let Some(p) = params.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "path required")));
                };
                ("open_image", json!({ "path": p }))
            }
            "export" => {
                let Some(id) = params.get("image_id") else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "image_id required")));
                };
                let Some(p) = params.get("path").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "path required")));
                };
                ("export", json!({ "image_id": id, "path": p }))
            }
            "pdb_call" => {
                let Some(proc_name) = params.get("procedure").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "procedure required")));
                };
                let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
                ("pdb_call", json!({ "procedure": proc_name, "args": args }))
            }
            "new_image" => {
                let (Some(w), Some(h)) = (params.get("width"), params.get("height")) else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "width and height required")));
                };
                ("new_image", json!({ "width": w, "height": h }))
            }
            "image_info" => {
                let Some(id) = params.get("image_id") else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "image_id required")));
                };
                ("image_info", json!({ "image_id": id }))
            }
            "list_procedures" => {
                let p = match params.get("prefix").and_then(Value::as_str) {
                    Some(pfx) if !pfx.is_empty() => json!({ "prefix": pfx }),
                    _ => json!({}),
                };
                ("list_procedures", p)
            }
            "flatten" => {
                let Some(id) = params.get("image_id") else {
                    return Ok(ToolResult::ok(envelope_err("gimp", action, "INVALID_ARGS", "image_id required")));
                };
                ("flatten", json!({ "image_id": id }))
            }
            _ => {
                return Ok(ToolResult::ok(envelope_err(
                    "gimp",
                    action,
                    "INVALID_ARGS",
                    format!("Unknown action: {action}"),
                )));
            }
        };

        match gimp_request(req.0, req.1, host, port).await {
            Ok(res) => Ok(ToolResult::ok(envelope_ok("gimp", action, res))),
            Err(e) => Ok(ToolResult::ok(envelope_err("gimp", action, "UPSTREAM", e.to_string()))),
        }
    }
}
