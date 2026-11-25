use crate::context::Ctx;
use crate::{Config, ToolRegistry};
use anyhow::Result;
use jsonrpc_core::{MetaIoHandler, Params};
use jsonrpc_http_server::ServerBuilder;
use log::{debug, info, error};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, RwLock, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// Requests served at once over stdio. A request past this waits for a slot inside its own
/// task, so the reader keeps reading, and a cancel still reaches a request that is waiting.
const MAX_CONCURRENT: usize = 16;

pub struct MCPServer {
    config: Config,
    port: u16,
    roots: Vec<PathBuf>,
    shell: Arc<crate::tools::Shell>,
    tools: Arc<RwLock<ToolRegistry>>,
    handler: MetaIoHandler<Ctx>,
}

impl MCPServer {
    pub fn new(config: Config, port: u16) -> Result<Self> {
        let shell = Arc::new(crate::tools::Shell::new());
        let tools = Arc::new(RwLock::new(ToolRegistry::with_shell(shell.clone())));
        let mut handler = MetaIoHandler::<Ctx>::default();

        // Clone for move into closures
        let tools_clone = tools.clone();

        // Initialize method
        handler.add_method("initialize", move |params: Params| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                debug!("Received initialize request: {:?}", params);

                let _tools = tools.read().await;

                // Answer the revision the CLIENT asked for when we speak it.
                let requested = params
                    .parse::<Value>()
                    .ok()
                    .and_then(|v| v.get("protocolVersion").and_then(Value::as_str).map(str::to_owned));
                let version = crate::protocol::negotiate_version(requested.as_deref());

                Ok(crate::protocol::initialize_result(version))
            })
        });

        // List tools method
        let tools_clone = tools.clone();
        handler.add_method("tools/list", move |_params: Params| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                let tools = tools.read().await;
                let tool_list = tools.get_definitions();

                Ok(json!({
                    "tools": tool_list
                }))
            })
        });

        // Call tool method, with the request's cancellation and progress.
        let tools_clone = tools.clone();
        handler.add_method_with_meta("tools/call", move |params: Params, ctx: Ctx| {
            let tools = tools_clone.clone();
            Box::pin(async move {
                let params = params.parse::<serde_json::Value>()
                    .map_err(|e| jsonrpc_core::Error::invalid_params(e.to_string()))?;

                let tool_name = params["name"].as_str()
                    .ok_or_else(|| jsonrpc_core::Error::invalid_params("Missing tool name"))?;

                let tool_params = params.get("arguments").cloned().unwrap_or(json!({}));

                let tools = tools.read().await;
                let served = tools.list();
                if !served.iter().any(|n| n == tool_name) {
                    return Ok(error_result(format!(
                        "Unknown tool: {tool_name}. This server serves: {}.",
                        served.join(", ")
                    )));
                }
                match tools.execute_with(tool_name, tool_params, &ctx).await {
                    Ok(mut result) => {
                        // A capture rides as a native image block, never as base64 in the text.
                        let image = result.content.as_object_mut().and_then(|o| o.remove("image"));
                        let text = match (&result.content, result.success) {
                            (Value::String(s), true) => s.clone(),
                            (c, true) => serde_json::to_string(c).unwrap_or_default(),
                            _ => result.error.unwrap_or_else(|| format!("{tool_name} failed without saying why")),
                        };
                        let mut content = vec![json!({ "type": "text", "text": text })];
                        if let Some(img) = image.filter(|i| i.get("data").is_some()) {
                            content.push(json!({ "type": "image", "data": img["data"], "mimeType": img["mimeType"] }));
                        }
                        Ok(json!({
                            "content": content,
                            "isError": !result.success
                        }))
                    },
                    Err(e) => {
                        error!("Tool execution failed: {}", e);
                        Ok(error_result(call_error(tool_name, &e)))
                    }
                }
            })
        });

        // Listed for a client that asks anyway; `initialize` does not advertise either, since
        // neither holds anything yet.
        handler.add_method("resources/list", |_params: Params| {
            Box::pin(async move {
                Ok(json!({
                    "resources": []
                }))
            })
        });

        handler.add_method("prompts/list", |_params: Params| {
            Box::pin(async move {
                Ok(json!({
                    "prompts": []
                }))
            })
        });

        // Ping method for health checks
        handler.add_method("ping", |_params: Params| {
            Box::pin(async move {
                Ok(json!("pong"))
            })
        });

        Ok(Self {
            config,
            port,
            roots: Vec::new(),
            shell,
            tools,
            handler,
        })
    }

    /// Record an allowed filesystem root the server may operate under.
    pub fn allow_root(&mut self, root: PathBuf) {
        // The roots are also where a command may write without being asked about it.
        self.shell.add_root(&root);
        self.roots.push(root);
    }

    /// Serve JSON-RPC over STDIO: one message per line on stdin, one per line on stdout.
    ///
    /// Requests run concurrently, each in its own task, and answer in the order they finish;
    /// the client matches them by id. Every line out (answers and progress notifications)
    /// goes through one writer, so two never interleave. `notifications/cancelled` fires the
    /// named request's token: its task is dropped and sends no answer. At end of input the
    /// requests still running finish and answer before this returns.
    pub async fn run_stdio(self) -> Result<()> {
        for root in &self.roots {
            info!("[MCP] allowed root: {}", root.display());
        }
        info!("[MCP] JSON-RPC over STDIO");

        let handler = Arc::new(self.handler);
        let (out, mut lines_out) = mpsc::unbounded_channel::<String>();
        let writer = tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(line) = lines_out.recv().await {
                stdout.write_all(line.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            Ok::<_, std::io::Error>(())
        });

        let in_flight: Arc<Mutex<HashMap<String, CancellationToken>>> = Arc::default();
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT));
        let mut running = JoinSet::new();
        let mut lines = BufReader::new(tokio::io::stdin()).lines();

        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let message: Option<Value> = serde_json::from_str(&line).ok();
            let method = message.as_ref().and_then(|m| m.get("method")).and_then(Value::as_str);

            // A reply from the client (an id, a result or an error, no method) answers nothing
            // this server asked yet, and a server never answers a response.
            if message.as_ref().is_some_and(|m| m.get("method").is_none() && (m.get("result").is_some() || m.get("error").is_some())) {
                debug!("[MCP] ignored a reply: {line}");
                continue;
            }

            if method == Some("notifications/cancelled") {
                let id = message.as_ref().and_then(|m| m.pointer("/params/requestId"));
                if let Some(token) = id.and_then(|id| in_flight.lock().ok()?.remove(&id.to_string())) {
                    debug!("[MCP] cancelled request {}", id.unwrap());
                    token.cancel();
                }
                continue;
            }

            // A request (method and id) can be cancelled by its id; a batch or a reply cannot.
            let id = message
                .as_ref()
                .filter(|_| method.is_some())
                .and_then(|m| m.get("id"))
                .map(Value::to_string);
            let cancel = CancellationToken::new();
            let mut ctx = Ctx::new(cancel.clone());
            if let Some(token) = message.as_ref().and_then(|m| m.pointer("/params/_meta/progressToken")) {
                ctx = ctx.with_progress(token.clone(), out.clone());
            }
            if let (Some(id), Ok(mut map)) = (&id, in_flight.lock()) {
                map.insert(id.clone(), cancel.clone());
            }

            let (handler, out, in_flight, slots) = (handler.clone(), out.clone(), in_flight.clone(), slots.clone());
            running.spawn(async move {
                let answer = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    answer = async {
                        let _slot = slots.acquire_owned().await.ok();
                        handler.handle_request(&line, ctx).await
                    } => answer,
                };
                if let (Some(id), Ok(mut map)) = (&id, in_flight.lock()) {
                    map.remove(id);
                }
                // A cancelled request is not answered.
                if let Some(answer) = answer.filter(|_| !cancel.is_cancelled()) {
                    let _ = out.send(answer);
                }
            });
            while running.try_join_next().is_some() {}
        }

        while running.join_next().await.is_some() {}
        drop(out);
        // Every answer is queued by now. A sender some tool still holds would keep the writer
        // open, so it gets a moment to flush, not forever.
        match tokio::time::timeout(Duration::from_secs(1), writer).await {
            Ok(Ok(written)) => written?,
            Ok(Err(e)) => error!("[MCP] stdout writer failed: {e}"),
            Err(_) => debug!("[MCP] stdout writer still held at exit"),
        }

        Ok(())
    }

    pub async fn run(self) -> Result<()> {
        let server = ServerBuilder::new(self.handler)
            .start_http(&format!("127.0.0.1:{}", self.port).parse()?)
            .map_err(|e| anyhow::anyhow!("Failed to start server: {}", e))?;

        info!("MCP Server running on http://127.0.0.1:{}", self.port);

        // Keep server running
        server.wait();

        Ok(())
    }

    /// Serve only `names` (see [`ToolRegistry::restrict`]).
    pub async fn only(&self, names: &[String]) -> Result<()> {
        self.tools.write().await.restrict(names)
    }

    pub async fn add_tool(&self, tool: Box<dyn crate::MCPTool>) {
        let mut tools = self.tools.write().await;
        tools.register(tool);
    }
}

fn error_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// What a failed call tells the model: the tool, the reason, and, when the arguments did not
/// fit the tool, where to look.
fn call_error(tool: &str, e: &anyhow::Error) -> String {
    let hint = if e.downcast_ref::<serde_json::Error>().is_some() {
        format!(" (the arguments do not match {tool}'s inputSchema in tools/list)")
    } else {
        String::new()
    };
    format!("Error: {tool}: {e}{hint}")
}
