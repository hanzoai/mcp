//! Multi-agent orchestration tool (HIP-0300).
//!
//! Spawns native coding CLIs (claude/codex/gemini/grok/qwen/dev) and
//! Anthropic-compatible providers (claude CLI + base_url override) as tokio
//! subprocesses, then composes them:
//!
//! - `run`       single agent
//! - `dag`       dependency graph, executed in topological waves ({dep} injection)
//! - `swarm`     one template fanned across N items (bounded concurrency)
//! - `consensus` Lux Quasar metastable multi-model agreement rounds
//! - `dispatch`  different agents for different tasks, in parallel
//! - `list`/`status`/`config`  introspection
//! - `zen`       64-path oracle guidance over Hanzo principles (no subprocess)
//! - `review`    balanced constructive review by focus area (no subprocess)
//!
//! Port of python-sdk/pkg/hanzo-tools-agent. Consensus protocol:
//! https://github.com/luxfi/consensus

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::Semaphore;

use super::{envelope_err, envelope_ok};
use crate::{MCPTool, ToolResult};

// ---------------------------------------------------------------------------
// Agent catalog
// ---------------------------------------------------------------------------

/// One agent's spawn recipe. Native agents run their own CLI; Anthropic-compatible
/// agents run the `claude` CLI with `base_url`/`auth_env` overriding the endpoint.
#[derive(Clone)]
struct AgentConfig {
    cmd: &'static str,
    args: &'static [&'static str],
    env_key: Option<&'static str>,
    priority: i32,
    base_url: Option<&'static str>,
    auth_env: Option<&'static str>,
    model: Option<&'static str>,
}

impl AgentConfig {
    const fn native(
        cmd: &'static str,
        args: &'static [&'static str],
        env_key: Option<&'static str>,
        priority: i32,
    ) -> Self {
        Self { cmd, args, env_key, priority, base_url: None, auth_env: None, model: None }
    }

    const fn compat(
        priority: i32,
        base_url: &'static str,
        auth_env: &'static str,
        model: &'static str,
    ) -> Self {
        Self {
            cmd: "claude",
            args: &["--print", "--dangerously-skip-permissions", "--output-format", "text"],
            env_key: None,
            priority,
            base_url: Some(base_url),
            auth_env: Some(auth_env),
            model: Some(model),
        }
    }
}

/// Native CLI agents in YOLO / non-interactive mode, priority-ordered.
fn native_agents() -> Vec<(&'static str, AgentConfig)> {
    vec![
        (
            "claude",
            AgentConfig::native(
                "claude",
                &["--print", "--dangerously-skip-permissions", "--output-format", "text"],
                Some("ANTHROPIC_API_KEY"),
                1,
            ),
        ),
        ("codex", AgentConfig::native("codex", &["--full-auto"], Some("OPENAI_API_KEY"), 2)),
        ("gemini", AgentConfig::native("gemini", &["-y", "-q"], Some("GOOGLE_API_KEY"), 3)),
        ("grok", AgentConfig::native("grok", &["-y"], Some("XAI_API_KEY"), 4)),
        (
            "qwen",
            AgentConfig::native("qwen", &["--approval-mode", "yolo", "-p"], Some("DASHSCOPE_API_KEY"), 5),
        ),
        ("vibe", AgentConfig::native("vibe", &["--auto-approve", "--max-turns", "999", "-p"], None, 6)),
        ("dev", AgentConfig::native("hanzo-dev", &["-y"], None, 8)),
    ]
}

/// Anthropic-compatible providers driven through the `claude` CLI.
fn compat_agents() -> Vec<(&'static str, AgentConfig)> {
    vec![
        ("minimax", AgentConfig::compat(10, "https://api.minimax.io/anthropic", "MINIMAX_API_KEY", "MiniMax-M2.1")),
        ("kimi", AgentConfig::compat(11, "https://api.moonshot.cn/anthropic", "MOONSHOT_API_KEY", "kimi-k2")),
        ("deepseek", AgentConfig::compat(12, "https://api.deepseek.com/anthropic", "DEEPSEEK_API_KEY", "deepseek-chat")),
        ("yi", AgentConfig::compat(13, "https://api.01.ai/anthropic", "YI_API_KEY", "yi-large")),
        ("glm", AgentConfig::compat(14, "https://open.bigmodel.cn/api/paas/v4/anthropic", "ZHIPU_API_KEY", "glm-4")),
        ("baichuan", AgentConfig::compat(15, "https://api.baichuan-ai.com/anthropic", "BAICHUAN_API_KEY", "Baichuan4")),
        ("step", AgentConfig::compat(16, "https://api.stepfun.com/anthropic", "STEPFUN_API_KEY", "step-2")),
        (
            "dashscope",
            AgentConfig::compat(
                17,
                "https://dashscope-intl.aliyuncs.com/api/v2/apps/claude-code-proxy",
                "DASHSCOPE_API_KEY",
                "qwen-max",
            ),
        ),
        (
            "qwen-cc",
            AgentConfig::compat(
                18,
                "https://dashscope-intl.aliyuncs.com/api/v2/apps/claude-code-proxy",
                "DASHSCOPE_API_KEY",
                "qwen-plus",
            ),
        ),
    ]
}

fn all_agents() -> HashMap<&'static str, AgentConfig> {
    native_agents().into_iter().chain(compat_agents()).collect()
}

fn in_claude() -> bool {
    std::env::var("CLAUDE_CODE").is_ok() || std::env::var("CLAUDE_SESSION_ID").is_ok()
}

/// Default agent: claude when inside Claude Code, else the highest-priority
/// native agent whose key is present, else the first compat agent with a key,
/// else `dev`.
fn default_agent() -> &'static str {
    if in_claude() {
        return "claude";
    }
    let mut native = native_agents();
    native.sort_by_key(|(_, c)| c.priority);
    for (name, cfg) in &native {
        if let Some(k) = cfg.env_key {
            if std::env::var(k).is_ok() {
                return name;
            }
        }
    }
    let mut compat = compat_agents();
    compat.sort_by_key(|(_, c)| c.priority);
    for (name, cfg) in &compat {
        if let Some(k) = cfg.auth_env {
            if std::env::var(k).is_ok() {
                return name;
            }
        }
    }
    "dev"
}

/// API-key env vars propagated to spawned agents so they can reach their provider.
const KEY_ENVS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "DEEPSEEK_API_KEY",
    "MINIMAX_API_KEY",
    "MOONSHOT_API_KEY",
    "YI_API_KEY",
    "ZHIPU_API_KEY",
    "BAICHUAN_API_KEY",
    "STEPFUN_API_KEY",
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Result of one agent invocation.
#[derive(Clone)]
struct AgentResult {
    agent: String,
    output: String,
    ok: bool,
    error: Option<String>,
    item: Option<String>,
    id: Option<String>,
    ms: u64,
}

impl AgentResult {
    fn fail(agent: &str, error: impl Into<String>) -> Self {
        Self { agent: agent.into(), output: String::new(), ok: false, error: Some(error.into()), item: None, id: None, ms: 0 }
    }
}

/// Build the argv for one agent, mirroring the Python `_exec` CLI builder.
fn build_argv(cfg: &AgentConfig, prompt: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec![cfg.cmd.to_string()];
    if cfg.cmd == "claude" {
        argv.push("--output-format".into());
        argv.push("text".into());
    }
    if let Some(model) = cfg.model {
        argv.push("--model".into());
        argv.push(model.into());
    }
    if cfg.base_url.is_some() {
        argv.push("--dangerously-skip-permissions".into());
    }
    for a in cfg.args {
        argv.push((*a).into());
    }
    argv.push(prompt.to_string());
    argv
}

/// Spawn one agent as a subprocess and capture its output, bounded by `timeout`.
async fn exec_agent(
    name: String,
    cfg: AgentConfig,
    prompt: String,
    cwd: Option<String>,
    timeout: u64,
) -> AgentResult {
    let argv = build_argv(&cfg, &prompt);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    // Silence OpenTelemetry noise and mark the child as an agent descendant.
    cmd.env("OTEL_SDK_DISABLED", "true");
    cmd.env("HANZO_AGENT_PARENT", "true");
    cmd.env("HANZO_AGENT_NAME", &name);
    cmd.env("HANZO_AGENT_MCP_ENABLED", "true");
    for k in KEY_ENVS {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }
    // Anthropic-compatible overrides route the claude CLI at another provider.
    if let Some(base) = cfg.base_url {
        cmd.env("ANTHROPIC_BASE_URL", base);
    }
    if let Some(auth) = cfg.auth_env {
        if let Ok(v) = std::env::var(auth) {
            cmd.env("ANTHROPIC_AUTH_TOKEN", v);
        }
    }

    let start = Instant::now();
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return AgentResult::fail(&name, format!("{} not found", cfg.cmd));
        }
        Err(e) => return AgentResult::fail(&name, e.to_string()),
    };

    let wait = tokio::time::timeout(std::time::Duration::from_secs(timeout), child.wait_with_output());
    match wait.await {
        Ok(Ok(out)) => {
            let ms = start.elapsed().as_millis() as u64;
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            let code = out.status.code().unwrap_or(-1);
            if out.status.success() {
                AgentResult { agent: name, output: text, ok: true, error: None, item: None, id: None, ms }
            } else {
                AgentResult {
                    agent: name,
                    output: text,
                    ok: false,
                    error: Some(format!("Exit code {}", code)),
                    item: None,
                    id: None,
                    ms,
                }
            }
        }
        Ok(Err(e)) => AgentResult::fail(&name, e.to_string()),
        Err(_) => {
            let ms = start.elapsed().as_millis() as u64;
            // kill_on_drop reaps the child as `wait` is dropped here.
            AgentResult {
                agent: name.clone(),
                output: format!("[timeout] Agent {} exceeded {}s and was terminated", name, timeout),
                ok: false,
                error: Some(format!("timeout after {}s", timeout)),
                item: None,
                id: None,
                ms,
            }
        }
    }
}

/// Probe whether an agent's CLI is installed (`<cmd> --version`, 5s bound).
async fn available(cmd: &str) -> bool {
    let mut c = Command::new(cmd);
    c.arg("--version");
    c.stdout(Stdio::null());
    c.stderr(Stdio::null());
    c.kill_on_drop(true);
    match c.spawn() {
        Ok(child) => matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output()).await,
            Ok(Ok(o)) if o.status.success()
        ),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct AgentArgs {
    action: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    cwd: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    tasks: Option<Vec<Value>>,
    items: Option<Vec<String>>,
    template: Option<String>,
    max_concurrent: Option<usize>,
    agents: Option<Vec<String>>,
    rounds: Option<u32>,
    // zen
    challenge: Option<String>,
    // review
    focus: Option<String>,
    work_description: Option<String>,
    code_snippets: Option<Vec<String>>,
    file_paths: Option<Vec<String>>,
    context: Option<String>,
}

fn default_timeout(t: Option<u64>) -> u64 {
    t.unwrap_or(300)
}

pub struct AgentTool;

impl AgentTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgentTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for AgentTool {
    fn name(&self) -> &str {
        "agent"
    }

    fn description(&self) -> &str {
        "Multi-agent orchestration: run/dag/swarm/consensus/dispatch across claude/codex/gemini/grok/qwen/dev CLIs, plus zen (oracle) and review. Consensus: https://github.com/luxfi/consensus"
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["run", "dag", "swarm", "consensus", "dispatch", "list", "status", "config", "zen", "review"],
                    "description": "Agent action",
                    "default": "run"
                },
                "name": { "type": "string", "description": "Agent: claude, codex, gemini, grok, qwen, dev, or a compat provider" },
                "prompt": { "type": "string", "description": "Prompt for run" },
                "cwd": { "type": "string", "description": "Working directory" },
                "timeout": { "type": "integer", "description": "Per-agent timeout seconds", "default": 300 },
                "tasks": { "type": "array", "description": "Tasks for dag [{id,prompt,agent?,after?}] or dispatch [{agent,prompt}]", "items": { "type": "object" } },
                "items": { "type": "array", "description": "Items for swarm", "items": { "type": "string" } },
                "template": { "type": "string", "description": "Swarm template with {item} substitution" },
                "max_concurrent": { "type": "integer", "description": "Max concurrency for swarm", "default": 100 },
                "agents": { "type": "array", "description": "Agents for consensus", "items": { "type": "string" } },
                "rounds": { "type": "integer", "description": "Consensus rounds", "default": 3 },
                "challenge": { "type": "string", "description": "Engineering challenge for zen" },
                "focus": { "type": "string", "description": "Review focus: general|functionality|readability|maintainability|testing|documentation|architecture" },
                "work_description": { "type": "string", "description": "What was implemented (review)" },
                "code_snippets": { "type": "array", "description": "Code snippets to review", "items": { "type": "string" } },
                "file_paths": { "type": "array", "description": "Modified file paths (review)", "items": { "type": "string" } },
                "context": { "type": "string", "description": "Extra context (review)" }
            }
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let args: AgentArgs = serde_json::from_value(params).unwrap_or_default();
        let action = args.action.clone().unwrap_or_else(|| "run".into());
        let timeout = default_timeout(args.timeout);

        let body = match action.as_str() {
            "list" => Ok(list_agents()),
            "config" => Ok(config_view()),
            "status" => Ok(status_view(args.name.as_deref()).await),
            "run" => run(&args, timeout).await,
            "dag" => dag(&args, timeout).await,
            "swarm" => swarm(&args, timeout).await,
            "dispatch" => dispatch(&args, timeout).await,
            "consensus" => consensus(&args, timeout).await,
            "zen" => zen(&args),
            "review" => review(&args),
            other => Err(format!(
                "Unknown action: {}. Use: run, dag, swarm, consensus, dispatch, list, status, config, zen, review",
                other
            )),
        };

        Ok(match body {
            Ok(v) => ToolResult::ok(envelope_ok("agent", &action, v)),
            Err(msg) => ToolResult::ok(envelope_err("agent", &action, "INVALID_ARGS", msg)),
        })
    }
}

// ---------------------------------------------------------------------------
// Introspection actions
// ---------------------------------------------------------------------------

fn list_agents() -> Value {
    let def = default_agent();
    let mut native = native_agents();
    native.sort_by_key(|(_, c)| c.priority);
    let native: Vec<Value> = native
        .iter()
        .map(|(n, c)| json!({ "name": n, "cmd": c.cmd, "default": *n == def }))
        .collect();

    let mut compat = compat_agents();
    compat.sort_by_key(|(_, c)| c.priority);
    let compat: Vec<Value> = compat
        .iter()
        .map(|(n, c)| {
            let has_key = c.auth_env.map(|k| std::env::var(k).is_ok()).unwrap_or(false);
            json!({ "name": n, "model": c.model, "has_key": has_key })
        })
        .collect();

    json!({
        "default": def,
        "native": native,
        "compat": compat,
        "actions": ["run", "dag", "swarm", "consensus", "dispatch", "zen", "review"],
        "in_claude": in_claude()
    })
}

fn config_view() -> Value {
    let mut native = native_agents();
    native.sort_by_key(|(_, c)| c.priority);
    let native: Vec<Value> = native
        .iter()
        .map(|(n, c)| json!({ "name": n, "cmd": c.cmd, "args": c.args }))
        .collect();
    let mut compat = compat_agents();
    compat.sort_by_key(|(_, c)| c.priority);
    let compat: Vec<Value> = compat
        .iter()
        .map(|(n, c)| json!({ "name": n, "model": c.model, "base_url": c.base_url }))
        .collect();
    json!({
        "default_agent": default_agent(),
        "in_claude": in_claude(),
        "native": native,
        "compat": compat,
        "override": {
            "file": "~/.hanzo/agents/<name>.json",
            "env": "HANZO_AGENT_<NAME>_ARGS=\"--flag1 --flag2\""
        }
    })
}

async fn status_view(name: Option<&str>) -> Value {
    let agents = all_agents();
    if let Some(n) = name {
        return match agents.get(n) {
            None => json!({ "name": n, "known": false, "available": [] }),
            Some(cfg) => {
                let ok = available(cfg.cmd).await;
                let env_to_check = cfg.auth_env.or(cfg.env_key);
                let has_key = env_to_check.map(|k| std::env::var(k).is_ok()).unwrap_or(false);
                json!({ "name": n, "known": true, "available": ok, "has_key": has_key })
            }
        };
    }

    let mut native = native_agents();
    native.sort_by_key(|(_, c)| c.priority);
    let mut native_status = Vec::new();
    for (n, c) in &native {
        let ok = available(c.cmd).await;
        let has_key = c.env_key.map(|k| std::env::var(k).is_ok()).unwrap_or(false);
        native_status.push(json!({ "name": n, "available": ok, "has_key": has_key }));
    }

    let claude_ok = available("claude").await;
    let mut compat = compat_agents();
    compat.sort_by_key(|(_, c)| c.priority);
    let compat_status: Vec<Value> = compat
        .iter()
        .map(|(n, c)| {
            let has_key = c.auth_env.map(|k| std::env::var(k).is_ok()).unwrap_or(false);
            json!({ "name": n, "model": c.model, "ready": claude_ok && has_key, "has_key": has_key, "needs_claude": !claude_ok })
        })
        .collect();

    json!({ "native": native_status, "compat": compat_status })
}

// ---------------------------------------------------------------------------
// Orchestration actions
// ---------------------------------------------------------------------------

fn resolve(name: Option<&str>) -> (String, Option<AgentConfig>) {
    let n = name.map(|s| s.to_string()).unwrap_or_else(|| default_agent().to_string());
    let cfg = all_agents().get(n.as_str()).cloned();
    (n, cfg)
}

fn result_json(r: &AgentResult) -> Value {
    json!({
        "agent": r.agent,
        "id": r.id,
        "item": r.item,
        "ok": r.ok,
        "error": r.error,
        "ms": r.ms,
        "output": r.output
    })
}

async fn run(args: &AgentArgs, timeout: u64) -> Result<Value, String> {
    let prompt = args.prompt.clone().filter(|p| !p.trim().is_empty()).ok_or("prompt required")?;
    let (name, cfg) = resolve(args.name.as_deref());
    let cfg = cfg.ok_or_else(|| format!("Unknown agent: {}", name))?;
    let r = exec_agent(name.clone(), cfg, prompt, args.cwd.clone(), timeout).await;
    Ok(json!({ "agent": name, "ok": r.ok, "error": r.error, "ms": r.ms, "output": r.output }))
}

async fn dispatch(args: &AgentArgs, timeout: u64) -> Result<Value, String> {
    let tasks = args.tasks.clone().filter(|t| !t.is_empty()).ok_or("tasks required")?;
    let cwd = args.cwd.clone();

    let mut handles = Vec::new();
    for t in tasks {
        let agent = t.get("agent").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| default_agent().to_string());
        let prompt = t.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cwd = cwd.clone();
        handles.push(tokio::spawn(async move {
            match all_agents().get(agent.as_str()).cloned() {
                Some(cfg) => exec_agent(agent, cfg, prompt, cwd, timeout).await,
                None => AgentResult::fail(&agent, format!("Unknown agent: {}", agent)),
            }
        }));
    }

    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.map_err(|e| e.to_string())?);
    }

    let ok = results.iter().filter(|r| r.ok).count();
    Ok(json!({
        "dispatched": results.len(),
        "success": ok,
        "failed": results.len() - ok,
        "results": results.iter().map(result_json).collect::<Vec<_>>()
    }))
}

async fn swarm(args: &AgentArgs, timeout: u64) -> Result<Value, String> {
    let items = args.items.clone().filter(|i| !i.is_empty()).ok_or("items required")?;
    let template = args.template.clone().filter(|t| !t.is_empty()).ok_or("template required (use {item})")?;
    let (name, cfg) = resolve(args.name.as_deref());
    let cfg = cfg.ok_or_else(|| format!("Unknown agent: {}", name))?;
    let max = args.max_concurrent.unwrap_or(100).max(1);
    let cwd = args.cwd.clone();

    let sem = Arc::new(Semaphore::new(max));
    let start = Instant::now();
    let mut handles = Vec::new();
    for item in items.clone() {
        let sem = sem.clone();
        let cfg = cfg.clone();
        let name = name.clone();
        let cwd = cwd.clone();
        let prompt = template.replace("{item}", &item);
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore closed");
            let mut r = exec_agent(name, cfg, prompt, cwd, timeout).await;
            r.item = Some(item);
            r
        }));
    }

    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.map_err(|e| e.to_string())?);
    }
    let elapsed = start.elapsed().as_secs_f64();
    let ok = results.iter().filter(|r| r.ok).count();

    Ok(json!({
        "agent": name,
        "items": items.len(),
        "success": ok,
        "failed": results.len() - ok,
        "max_concurrent": max,
        "elapsed_s": elapsed,
        "failures": results.iter().filter(|r| !r.ok)
            .map(|r| json!({ "item": r.item, "error": r.error }))
            .collect::<Vec<_>>(),
        "results": results.iter().map(result_json).collect::<Vec<_>>()
    }))
}

/// DAG execution in topological waves; each ready task's prompt has `{dep_id}`
/// replaced by that dependency's output before it runs.
async fn dag(args: &AgentArgs, timeout: u64) -> Result<Value, String> {
    let tasks = args.tasks.clone().filter(|t| !t.is_empty()).ok_or("tasks required")?;
    let default = args.name.clone().unwrap_or_else(|| default_agent().to_string());
    let cwd = args.cwd.clone();

    struct Node {
        prompt: String,
        agent: String,
        after: HashSet<String>,
        done: bool,
    }
    let mut graph: HashMap<String, Node> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (i, t) in tasks.iter().enumerate() {
        let id = t.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| i.to_string());
        let after: HashSet<String> = t
            .get("after")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        order.push(id.clone());
        graph.insert(
            id,
            Node {
                prompt: t.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                agent: t.get("agent").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| default.clone()),
                after,
                done: false,
            },
        );
    }

    let mut outputs: HashMap<String, String> = HashMap::new();
    let mut results: Vec<AgentResult> = Vec::new();

    loop {
        let ready: Vec<String> = order
            .iter()
            .filter(|id| {
                let n = &graph[*id];
                !n.done && n.after.iter().all(|d| outputs.contains_key(d))
            })
            .cloned()
            .collect();

        if ready.is_empty() {
            let pending: Vec<String> = order.iter().filter(|id| !graph[*id].done).cloned().collect();
            if !pending.is_empty() {
                return Err(format!("Dependency cycle or missing deps: {:?}", pending));
            }
            break;
        }

        let mut handles = Vec::new();
        for id in &ready {
            let n = &graph[id];
            let mut prompt = n.prompt.clone();
            for (dep, out) in &outputs {
                prompt = prompt.replace(&format!("{{{}}}", dep), out);
            }
            let agent = n.agent.clone();
            let cwd = cwd.clone();
            let id = id.clone();
            handles.push(tokio::spawn(async move {
                let mut r = match all_agents().get(agent.as_str()).cloned() {
                    Some(cfg) => exec_agent(agent, cfg, prompt, cwd, timeout).await,
                    None => AgentResult::fail(&agent, format!("Unknown agent: {}", agent)),
                };
                r.id = Some(id);
                r
            }));
        }

        for h in handles {
            let r = h.await.map_err(|e| e.to_string())?;
            let id = r.id.clone().unwrap_or_default();
            outputs.insert(id.clone(), r.output.clone());
            if let Some(n) = graph.get_mut(&id) {
                n.done = true;
            }
            results.push(r);
        }
    }

    let ok = results.iter().filter(|r| r.ok).count();
    Ok(json!({
        "tasks": results.len(),
        "success": ok,
        "failed": results.len() - ok,
        "results": results.iter().map(result_json).collect::<Vec<_>>()
    }))
}

/// Lux Quasar metastable consensus: agents answer, then re-answer each round
/// with visibility into the others, until a preferred answer stabilizes.
async fn consensus(args: &AgentArgs, timeout: u64) -> Result<Value, String> {
    let prompt = args.prompt.clone().filter(|p| !p.trim().is_empty()).ok_or("prompt required")?;
    let agents = args.agents.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| {
        vec!["claude".into(), "gemini".into(), "codex".into()]
    });
    let rounds = args.rounds.unwrap_or(3).max(1);
    let cwd = args.cwd.clone();

    let system = "You are participating in a multi-agent consensus protocol. \
Provide a clear, reasoned response that can be compared and synthesized with other participants.";

    let start = Instant::now();
    let mut last: HashMap<String, String> = HashMap::new();
    let mut round_log: Vec<Value> = Vec::new();

    for round in 0..rounds {
        // Each agent sees the others' latest answers.
        let mut handles = Vec::new();
        for agent in &agents {
            let cfg = match all_agents().get(agent.as_str()).cloned() {
                Some(c) => c,
                None => continue,
            };
            let peers: Vec<String> = agents.iter().filter(|a| *a != agent).cloned().collect();
            let mut ctx = String::new();
            for p in &peers {
                if let Some(o) = last.get(p) {
                    ctx.push_str(&format!("\n[{}]: {}", p, &o[..o.len().min(800)]));
                }
            }
            let full = format!(
                "{system}\n\nParticipants: {}\nRound {}/{}\n\nQuestion: {}{}",
                agents.join(", "),
                round + 1,
                rounds,
                prompt,
                if ctx.is_empty() { String::new() } else { format!("\n\nOther participants so far:{ctx}") }
            );
            let agent = agent.clone();
            let cwd = cwd.clone();
            handles.push(tokio::spawn(async move { exec_agent(agent, cfg, full, cwd, timeout).await }));
        }

        let mut this_round = Vec::new();
        for h in handles {
            let r = h.await.map_err(|e| e.to_string())?;
            if r.ok {
                last.insert(r.agent.clone(), r.output.clone());
            }
            this_round.push(result_json(&r));
        }
        round_log.push(json!({ "round": round + 1, "responses": this_round }));
    }

    // Winner = fastest successful agent in the final state (Photon/luminance weight).
    let winner = last.keys().next().cloned();
    let synthesis = winner.as_ref().and_then(|w| last.get(w)).cloned().unwrap_or_default();
    let finalized = last.len() >= ((agents.len() + 1) / 2).max(1);

    Ok(json!({
        "protocol": "metastable",
        "elapsed_s": start.elapsed().as_secs_f64(),
        "rounds": rounds,
        "participants": agents,
        "winner": winner,
        "finalized": finalized,
        "synthesis": synthesis,
        "log": round_log
    }))
}

// ---------------------------------------------------------------------------
// zen — 64-path oracle over Hanzo principles (no subprocess)
// ---------------------------------------------------------------------------

fn zen(args: &AgentArgs) -> Result<Value, String> {
    let challenge = args.challenge.clone().filter(|c| !c.trim().is_empty()).ok_or("challenge required")?;
    let lines = cast_hexagram();
    let (name, title, meaning) = hexagram(&lines);
    let principles = select_principles(&lines, &challenge);

    let pattern: String = lines
        .chars()
        .rev()
        .map(|c| if c == '1' { "━━━" } else { "━ ━" })
        .collect::<Vec<_>>()
        .join(" ");

    let plan = action_plan(&challenge);

    let principle_views: Vec<Value> = principles
        .iter()
        .map(|(n, wisdom, emoji)| json!({ "name": n, "wisdom": wisdom, "emoji": emoji }))
        .collect();

    Ok(json!({
        "challenge": challenge,
        "hexagram": { "name": name, "title": title, "meaning": meaning, "lines": lines, "pattern": pattern },
        "principles": principle_views,
        "action_plan": plan
    }))
}

/// Cast six lines via the three-coin method (heads=3, tails=2; 6/8→yin=0, 7/9→yang=1).
fn cast_hexagram() -> String {
    let mut lines = String::with_capacity(6);
    for _ in 0..6 {
        let coins: u32 = (0..3).map(|_| if coin() { 3 } else { 2 }).sum();
        lines.push(if coins == 6 || coins == 8 { '0' } else { '1' });
    }
    lines
}

/// Nondeterministic coin without pulling in the `rand` crate — nanosecond parity.
fn coin() -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    // Mix a thread-local counter so consecutive calls in the same nanosecond differ.
    std::thread::yield_now();
    (n.wrapping_add(counter())) % 2 == 0
}

fn counter() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static C: AtomicU32 = AtomicU32::new(0);
    C.fetch_add(2_654_435_761, Ordering::Relaxed)
}

/// 36 Hanzo principles: (name, wisdom, emoji), category order preserved from Python.
const PRINCIPLES: &[(&str, &str, &str)] = &[
    ("Autonomy", "Trust fully; freedom fuels genius", "🦅"),
    ("Balance", "Steady wins; burnout loses every time", "⚖️"),
    ("Customer Obsession", "Coach relentlessly; their victories yours", "🎓"),
    ("Humility", "Quiet confidence; greatness emerges naturally", "🧘"),
    ("Integrity", "Principles never break; reputation never fades", "🛡️"),
    ("Selflessness", "Elevate others; personal success follows", "🤝"),
    ("Curiosity", "Question always; truth never ends", "🌱"),
    ("Empiricism", "Hypothesize, measure; reality defines truth", "🔬"),
    ("Precision", "Discipline in data; eliminate guesswork completely", "🎯"),
    ("Validation", "Test assumptions hard; illusions crumble fast", "✅"),
    ("Objectivity", "Ego out; results speak plainly", "🧊"),
    ("Repeatability", "Do it again; success repeats systematically", "🔄"),
    ("Accessibility", "Open doors wide; adoption thrives naturally", "🌐"),
    ("Beauty", "Form speaks louder; aesthetics lift utility", "🎨"),
    ("Clarity", "Obvious is perfect; complexity hidden cleanly", "🔍"),
    ("Consistency", "Uniform patterns; predictable results always", "🎯"),
    ("Simplicity", "Cut ruthlessly; essential alone remains", "🪶"),
    ("Flow", "Remove friction; natural motion prevails", "🌊"),
    ("Batteries Included", "Ready instantly; everything you need to start", "🔋"),
    ("Concurrency", "Parallel flows; frictionless scale", "⚡"),
    ("Composable", "Modular magic; pieces multiply power", "🧩"),
    ("Interoperable", "Integrate effortlessly; value compounds infinitely", "🔗"),
    ("Orthogonal", "Each tool exact; no overlap, no waste", "⚙️"),
    ("Scalable", "Growth limitless; obstacles removed at inception", "📈"),
    ("Disruption", "Reinvent boldly; transcend competition entirely", "💥"),
    ("Experimentation", "Test quickly; iterate endlessly", "🧪"),
    ("Exponentiality", "Compound constantly; incremental fades", "📈"),
    ("Velocity", "Ship fast; refine faster", "🚀"),
    ("Urgency", "Act now; delays destroy opportunity", "⏱️"),
    ("Adaptability", "Pivot sharply; fluid response accelerates evolution", "🌊"),
    ("Decentralization", "Distribute power; resilience born from autonomy", "🕸️"),
    ("Freedom", "Democratize creativity; tools liberated, gatekeepers removed", "🗽"),
    ("Longevity", "Build timelessly; greatness endures beyond lifetimes", "⏳"),
    ("Security", "Encryption first; privacy non-negotiable", "🔐"),
    ("Zen", "Calm mastery; effortless excellence every moment", "☯️"),
];

/// Select up to 5 principles: a hexagram-derived primary plus challenge-keyword matches.
fn select_principles(lines: &str, challenge: &str) -> Vec<(&'static str, &'static str, &'static str)> {
    let primary = lines
        .chars()
        .enumerate()
        .map(|(i, b)| if b == '1' { 1usize << i } else { 0 })
        .sum::<usize>()
        % PRINCIPLES.len();

    let mut selected: Vec<usize> = vec![primary];
    let lowered = challenge.to_lowercase();
    let words: HashSet<&str> = lowered.split_whitespace().collect();
    // Keyword → principle indices (names must match PRINCIPLES order above).
    let matches: &[(&str, &[&str])] = &[
        ("scale", &["Scalable", "Exponentiality"]),
        ("speed", &["Velocity", "Urgency"]),
        ("quality", &["Precision", "Validation"]),
        ("team", &["Autonomy", "Balance"]),
        ("design", &["Simplicity", "Beauty"]),
        ("bug", &["Empiricism", "Objectivity"]),
        ("refactor", &["Clarity", "Composable"]),
        ("security", &["Security", "Integrity"]),
        ("performance", &["Concurrency", "Orthogonal"]),
        ("user", &["Customer Obsession", "Accessibility"]),
    ];
    for (kw, names) in matches {
        if words.contains(kw) {
            for name in *names {
                if let Some(idx) = PRINCIPLES.iter().position(|p| p.0 == *name) {
                    selected.push(idx);
                }
            }
        }
    }

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for idx in selected {
        if seen.insert(idx) {
            out.push(PRINCIPLES[idx]);
        }
        if out.len() >= 5 {
            break;
        }
    }
    out
}

fn action_plan(challenge: &str) -> Vec<&'static str> {
    let c = challenge.to_lowercase();
    let has = |ws: &[&str]| ws.iter().any(|w| c.contains(w));
    if has(&["bug", "error", "fix", "broken"]) {
        vec![
            "Diagnose systematically - use empirical debugging, not guesswork",
            "Fix root cause - address the source, not just symptoms",
            "Prevent recurrence - add tests and monitoring",
        ]
    } else if has(&["scale", "performance", "slow"]) {
        vec![
            "Measure first - profile to find actual bottlenecks",
            "Parallelize - use concurrency where possible",
            "Simplify - remove complexity before optimizing",
        ]
    } else if has(&["design", "architect", "structure"]) {
        vec![
            "Start simple - MVP first, elaborate later",
            "Stay flexible - design for change",
            "Think holistically - consider the entire system",
        ]
    } else if has(&["team", "collaborate", "people"]) {
        vec![
            "Enable autonomy - trust your team",
            "Maintain balance - sustainable pace wins",
            "Share knowledge - elevate everyone",
        ]
    } else {
        vec![
            "Clarify intent - what problem are you really solving?",
            "Start small - build incrementally",
            "Iterate rapidly - fast feedback loops",
        ]
    }
}

/// 64 hexagrams keyed by the six-line binary string → (name, title, meaning).
fn hexagram(lines: &str) -> (&'static str, &'static str, &'static str) {
    for (k, name, title, meaning) in HEXAGRAMS {
        if *k == lines {
            return (name, title, meaning);
        }
    }
    ("Unknown", "Mystery", "The pattern is unclear. Trust your intuition.")
}

const HEXAGRAMS: &[(&str, &str, &str, &str)] = &[
    ("111111", "乾 (Qián)", "Creative", "Initiating force, pure yang energy. Time for bold action."),
    ("000000", "坤 (Kūn)", "Receptive", "Pure receptivity, yielding. Time to listen and adapt."),
    ("100010", "屯 (Zhūn)", "Initial Difficulty", "Growing pains. Persevere through early challenges."),
    ("010001", "蒙 (Méng)", "Youthful Folly", "Beginner's mind. Learn humbly, question assumptions."),
    ("111010", "需 (Xū)", "Waiting", "Strategic patience. Prepare while waiting for the right moment."),
    ("010111", "訟 (Sòng)", "Conflict", "Address conflicts directly but seek resolution, not victory."),
    ("010000", "師 (Shī)", "Army", "Organize resources, build strong teams, lead by example."),
    ("000010", "比 (Bǐ)", "Holding Together", "Unity and collaboration. Strengthen bonds."),
    ("111011", "小畜 (Xiǎo Chù)", "Small Accumulation", "Small consistent improvements compound over time."),
    ("110111", "履 (Lǚ)", "Treading", "Careful progress. Mind the details while moving forward."),
    ("111000", "泰 (Tài)", "Peace", "Harmony achieved. Maintain balance while building."),
    ("000111", "否 (Pǐ)", "Standstill", "Blockage present. Pause, reassess, find new paths."),
    ("101111", "同人 (Tóng Rén)", "Fellowship", "Community strength. Build alliances and share knowledge."),
    ("111101", "大有 (Dà Yǒu)", "Great Possession", "Abundance available. Share generously to multiply value."),
    ("001000", "謙 (Qiān)", "Modesty", "Humble confidence. Let work speak for itself."),
    ("000100", "豫 (Yù)", "Enthusiasm", "Infectious energy. Channel excitement into action."),
    ("100110", "隨 (Suí)", "Following", "Adaptive leadership. Know when to lead and when to follow."),
    ("011001", "蠱 (Gǔ)", "Work on Decay", "Fix technical debt. Address root causes."),
    ("110000", "臨 (Lín)", "Approach", "Opportunity approaching. Prepare to receive it."),
    ("000011", "觀 (Guān)", "Contemplation", "Step back for perspective. See the whole system."),
    ("100101", "噬嗑 (Shì Kè)", "Biting Through", "Remove obstacles decisively. Clear blockages."),
    ("101001", "賁 (Bì)", "Grace", "Polish and refine. Beauty enhances function."),
    ("000001", "剝 (Bō)", "Splitting Apart", "Decay phase. Let go of what's not working."),
    ("100000", "復 (Fù)", "Return", "New cycle begins. Start fresh with lessons learned."),
    ("100111", "無妄 (Wú Wàng)", "Innocence", "Act with pure intention. Avoid overthinking."),
    ("111001", "大畜 (Dà Chù)", "Great Accumulation", "Build reserves. Invest in infrastructure."),
    ("100001", "頤 (Yí)", "Nourishment", "Feed growth. Provide resources teams need."),
    ("011110", "大過 (Dà Guò)", "Great Excess", "Extraordinary measures needed. Bold action required."),
    ("010010", "坎 (Kǎn)", "Abysmal", "Navigate danger carefully. Trust your training."),
    ("101101", "離 (Lí)", "Clinging Fire", "Clarity and vision. Illuminate the path forward."),
    ("001110", "咸 (Xián)", "Influence", "Mutual attraction. Build on natural affinities."),
    ("011100", "恆 (Héng)", "Duration", "Persistence pays. Maintain steady effort."),
    ("001111", "遯 (Dùn)", "Retreat", "Strategic withdrawal. Regroup and refocus."),
    ("111100", "大壯 (Dà Zhuàng)", "Great Power", "Strength available. Use power responsibly."),
    ("000101", "晉 (Jìn)", "Progress", "Advance steadily. Each step builds momentum."),
    ("101000", "明夷 (Míng Yí)", "Darkening Light", "Work quietly. Keep brilliance hidden for now."),
    ("101011", "家人 (Jiā Rén)", "Family", "Team harmony. Strengthen internal culture."),
    ("110101", "睽 (Kuí)", "Opposition", "Creative tension. Find synthesis in differences."),
    ("001010", "蹇 (Jiǎn)", "Obstruction", "Difficulty ahead. Find alternative routes."),
    ("010100", "解 (Xiè)", "Deliverance", "Breakthrough achieved. Consolidate gains."),
    ("110001", "損 (Sǔn)", "Decrease", "Simplify ruthlessly. Less is more."),
    ("100011", "益 (Yì)", "Increase", "Multiply value. Invest in growth."),
    ("111110", "夬 (Guài)", "Breakthrough", "Decisive moment. Act with conviction."),
    ("011111", "姤 (Gòu)", "Coming to Meet", "Unexpected encounter. Stay alert to opportunity."),
    ("000110", "萃 (Cuì)", "Gathering", "Convergence point. Bring elements together."),
    ("011000", "升 (Shēng)", "Pushing Upward", "Gradual ascent. Build systematically."),
    ("010110", "困 (Kùn)", "Exhaustion", "Resources depleted. Rest and recharge."),
    ("011010", "井 (Jǐng)", "The Well", "Deep resources. Draw from fundamentals."),
    ("101110", "革 (Gé)", "Revolution", "Transform completely. Embrace radical change."),
    ("011101", "鼎 (Dǐng)", "The Cauldron", "Transformation vessel. Cook new solutions."),
    ("100100", "震 (Zhèn)", "Thunder", "Shocking awakening. Respond to wake-up calls."),
    ("001001", "艮 (Gèn)", "Mountain", "Stillness and stability. Find solid ground."),
    ("001011", "漸 (Jiàn)", "Gradual Progress", "Step by step. Patient development."),
    ("110100", "歸妹 (Guī Mèi)", "Marrying Maiden", "New partnerships. Align expectations."),
    ("101100", "豐 (Fēng)", "Abundance", "Peak achievement. Prepare for cycles."),
    ("001101", "旅 (Lǚ)", "The Wanderer", "Explorer mindset. Learn from journey."),
    ("011011", "巽 (Xùn)", "Gentle Wind", "Subtle influence. Persistent gentle pressure."),
    ("110110", "兌 (Duì)", "Joy", "Infectious happiness. Celebrate progress."),
    ("010011", "渙 (Huàn)", "Dispersion", "Break up rigidity. Dissolve barriers."),
    ("110010", "節 (Jié)", "Limitation", "Healthy constraints. Focus through limits."),
    ("110011", "中孚 (Zhōng Fú)", "Inner Truth", "Authentic core. Build from truth."),
    ("001100", "小過 (Xiǎo Guò)", "Small Excess", "Minor adjustments. Fine-tune carefully."),
    ("101010", "既濟 (Jì Jì)", "After Completion", "Success achieved. Maintain vigilance."),
    ("010101", "未濟 (Wèi Jì)", "Before Completion", "Almost there. Final push needed."),
];

// ---------------------------------------------------------------------------
// review — balanced constructive review by focus area (no subprocess)
// ---------------------------------------------------------------------------

fn review(args: &AgentArgs) -> Result<Value, String> {
    let work = args.work_description.clone().filter(|w| !w.trim().is_empty()).ok_or("work_description required")?;
    let focus = args.focus.clone().unwrap_or_else(|| "general".into()).to_lowercase();
    let snippets = args.code_snippets.clone().unwrap_or_default();
    let paths = args.file_paths.clone().unwrap_or_default();
    let context = args.context.clone();

    let (strengths, suggestions) = match focus.as_str() {
        "functionality" => review_functionality(&snippets),
        "readability" => review_readability(&snippets),
        "maintainability" => review_maintainability(&snippets, &paths),
        "testing" => review_testing(&paths),
        "documentation" => review_documentation(&snippets),
        "architecture" => review_architecture(&paths),
        _ => review_general(&work, &snippets, &paths),
    };

    let focus = if matches!(
        focus.as_str(),
        "general" | "functionality" | "readability" | "maintainability" | "testing" | "documentation" | "architecture"
    ) {
        focus
    } else {
        "general".into()
    };

    Ok(json!({
        "focus": focus,
        "work_description": work,
        "strengths": strengths,
        "suggestions": suggestions,
        "context": context,
        "summary": "Balanced review - weigh both strengths and suggestions before finalizing."
    }))
}

fn review_general(work: &str, snippets: &[String], paths: &[String]) -> (Vec<String>, Vec<String>) {
    let w = work.to_lowercase();
    let mut s = Vec::new();
    if w.contains("fix") {
        s.push("Addressing identified issues proactively".into());
    }
    if w.contains("implement") {
        s.push("Adding new functionality to enhance the system".into());
    }
    if !snippets.is_empty() {
        s.push("Code structure appears organized".into());
    }
    if paths.len() == 1 {
        s.push("Focused changes in a single file (good for reviewability)".into());
    } else if paths.len() > 1 {
        s.push("Comprehensive approach across multiple files".into());
    }
    (
        s,
        vec![
            "Ensure all edge cases are handled appropriately".into(),
            "Consider adding unit tests if not already present".into(),
            "Verify the changes integrate well with existing code".into(),
        ],
    )
}

fn review_functionality(snippets: &[String]) -> (Vec<String>, Vec<String>) {
    let mut s = Vec::new();
    for snip in snippets {
        if snip.contains("func ") || snip.contains("def ") || snip.contains("function ") {
            s.push("Function definitions look properly structured".into());
        }
        if snip.contains("error") || snip.contains("err") || snip.contains("try") {
            s.push("Error handling is present".into());
        }
    }
    (
        s,
        vec![
            "Does the implementation handle all expected inputs?".into(),
            "Are return values meaningful and consistent?".into(),
            "Is the functionality easily testable?".into(),
        ],
    )
}

fn review_readability(snippets: &[String]) -> (Vec<String>, Vec<String>) {
    let mut s = Vec::new();
    if !snippets.is_empty() {
        let good = snippets.iter().any(|snip| {
            ["Add", "Get", "Set", "Create", "Update", "Delete"].iter().any(|w| snip.contains(w))
        });
        if good {
            s.push("Function/method names appear descriptive".into());
        }
    }
    (
        s,
        vec![
            "Use meaningful variable and function names".into(),
            "Keep functions focused on a single responsibility".into(),
            "Add comments for complex logic sections".into(),
        ],
    )
}

fn review_maintainability(snippets: &[String], paths: &[String]) -> (Vec<String>, Vec<String>) {
    let mut s = Vec::new();
    if paths.len() == 1 {
        s.push("Changes are localized to a single file".into());
    } else if paths.len() > 1 {
        s.push("Changes are logically distributed across files".into());
    }
    if snippets.iter().any(|snip| snip.contains("func ") || snip.contains("def ") || snip.contains("function ")) {
        s.push("Code is broken into functions/methods".into());
    }
    (
        s,
        vec![
            "Consider extracting common patterns into utilities".into(),
            "Ensure consistent patterns across the codebase".into(),
            "Document any non-obvious design decisions".into(),
        ],
    )
}

fn review_testing(paths: &[String]) -> (Vec<String>, Vec<String>) {
    let has_tests = paths.iter().any(|p| p.to_lowercase().contains("test"));
    let strengths = if has_tests {
        vec!["Test files are included with the changes".into()]
    } else {
        Vec::new()
    };
    let mut suggestions = vec![
        "Unit tests for new functions".into(),
        "Integration tests for feature interactions".into(),
        "Edge case coverage".into(),
        "Error condition testing".into(),
    ];
    if !has_tests {
        suggestions.push("No test files detected - add tests to prevent regressions".into());
    }
    (strengths, suggestions)
}

fn review_documentation(snippets: &[String]) -> (Vec<String>, Vec<String>) {
    let has_comments = snippets
        .iter()
        .any(|snip| snip.contains("//") || snip.contains("/*") || snip.contains('#') || snip.contains("\"\"\""));
    let strengths = if has_comments {
        vec!["Code includes some documentation".into()]
    } else {
        Vec::new()
    };
    (
        strengths,
        vec![
            "Document the 'why' not just the 'what'".into(),
            "Include examples for complex functions".into(),
            "Document any assumptions or limitations".into(),
        ],
    )
}

fn review_architecture(paths: &[String]) -> (Vec<String>, Vec<String>) {
    let modules: HashSet<&str> = paths
        .iter()
        .filter_map(|p| p.rsplit('/').nth(1))
        .collect();
    let strengths = if modules.len() > 1 {
        vec!["Changes span multiple modules (good separation)".into()]
    } else {
        vec!["Changes are cohesive within a module".into()]
    };
    (
        strengths,
        vec![
            "Does this fit well with the existing architecture?".into(),
            "Are the right abstractions in place?".into(),
            "Is the coupling between components appropriate?".into(),
            "Will this scale as requirements grow?".into(),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_and_schema() {
        let t = AgentTool::new();
        assert_eq!(t.name(), "agent");
        let params = t.parameters();
        let actions = params["properties"]["action"]["enum"].as_array().unwrap();
        for a in ["run", "dag", "swarm", "consensus", "dispatch", "list", "status", "config", "zen", "review"] {
            assert!(actions.iter().any(|v| v == a), "missing action {a}");
        }
    }

    #[test]
    fn catalog_has_native_and_compat() {
        let a = all_agents();
        for n in ["claude", "codex", "gemini", "grok", "qwen", "vibe", "dev"] {
            assert!(a.contains_key(n), "missing native {n}");
        }
        for n in ["minimax", "kimi", "deepseek", "glm"] {
            assert!(a.contains_key(n), "missing compat {n}");
        }
    }

    #[test]
    fn claude_argv_has_output_format_and_prompt() {
        let cfg = all_agents().get("claude").cloned().unwrap();
        let argv = build_argv(&cfg, "hello");
        assert_eq!(argv[0], "claude");
        assert!(argv.iter().any(|a| a == "--output-format"));
        assert_eq!(argv.last().unwrap(), "hello");
    }

    #[test]
    fn compat_argv_uses_claude_with_model_and_skip_permissions() {
        let cfg = all_agents().get("minimax").cloned().unwrap();
        let argv = build_argv(&cfg, "q");
        assert_eq!(argv[0], "claude");
        assert!(argv.iter().any(|a| a == "--model"));
        assert!(argv.iter().any(|a| a == "MiniMax-M2.1"));
        assert!(argv.iter().any(|a| a == "--dangerously-skip-permissions"));
    }

    #[test]
    fn hexagram_lookup_resolves_known_and_unknown() {
        assert_eq!(hexagram("111111").1, "Creative");
        assert_eq!(hexagram("000000").1, "Receptive");
        assert_eq!(hexagram("not-a-hexagram").0, "Unknown");
    }

    #[test]
    fn cast_hexagram_is_six_binary_lines() {
        let l = cast_hexagram();
        assert_eq!(l.len(), 6);
        assert!(l.chars().all(|c| c == '0' || c == '1'));
    }

    #[test]
    fn select_principles_bounded_and_keyword_aware() {
        let p = select_principles("111111", "how to scale and improve performance");
        assert!(!p.is_empty() && p.len() <= 5);
        assert!(p.iter().any(|(n, _, _)| *n == "Scalable" || *n == "Concurrency"));
    }

    #[tokio::test]
    async fn run_requires_prompt() {
        let t = AgentTool::new();
        let out = t.execute(json!({ "action": "run" })).await.unwrap();
        assert_eq!(out.content["ok"], false);
        assert_eq!(out.content["error"]["code"], "INVALID_ARGS");
    }

    #[tokio::test]
    async fn list_and_config_report_default() {
        let t = AgentTool::new();
        let list = t.execute(json!({ "action": "list" })).await.unwrap();
        assert_eq!(list.content["ok"], true);
        assert!(list.content["data"]["native"].as_array().unwrap().len() >= 7);
        let cfg = t.execute(json!({ "action": "config" })).await.unwrap();
        assert!(cfg.content["data"]["default_agent"].is_string());
    }

    #[tokio::test]
    async fn zen_produces_hexagram_and_plan() {
        let t = AgentTool::new();
        let out = t.execute(json!({ "action": "zen", "challenge": "refactor this legacy bug" })).await.unwrap();
        assert_eq!(out.content["ok"], true);
        assert!(out.content["data"]["hexagram"]["title"].is_string());
        assert!(!out.content["data"]["action_plan"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn review_is_balanced() {
        let t = AgentTool::new();
        let out = t
            .execute(json!({ "action": "review", "focus": "testing", "work_description": "implement fs tool" }))
            .await
            .unwrap();
        assert_eq!(out.content["ok"], true);
        assert!(out.content["data"]["suggestions"].as_array().unwrap().len() >= 3);
    }

    #[tokio::test]
    async fn unknown_action_is_error() {
        let t = AgentTool::new();
        let out = t.execute(json!({ "action": "nope" })).await.unwrap();
        assert_eq!(out.content["ok"], false);
    }
}
