/// Plan tracking tool (HIP-0300)
///
/// Manages execution plans with step tracking:
/// - update: Update plan and step status
/// - get: Get current plan
/// - clear: Clear plan

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Step status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

impl Default for StepStatus {
    fn default() -> Self {
        Self::Pending
    }
}

impl std::str::FromStr for StepStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(Self::Pending),
            "in_progress" | "inprogress" => Ok(Self::InProgress),
            "completed" | "done" => Ok(Self::Completed),
            "failed" | "error" => Ok(Self::Failed),
            "skipped" | "skip" => Ok(Self::Skipped),
            _ => Err(anyhow!("Unknown status: {}", s)),
        }
    }
}

/// A tracked step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedStep {
    pub id: usize,
    pub description: String,
    pub status: StepStatus,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// A tracked plan
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrackedPlan {
    pub name: Option<String>,
    pub steps: Vec<TrackedStep>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Plan actions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    Create,
    Show,
    Update,
    Get,
    List,
    Next,
    Archive,
    AddStep,
    RemoveStep,
    Estimate,
    Visualize,
    Clone,
    Cancel,
    Notes,
    Progress,
    Clear,
    Help,
}

impl Default for PlanAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for PlanAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "create" | "new" => Ok(Self::Create),
            "show" => Ok(Self::Show),
            "update" | "set" => Ok(Self::Update),
            "get" => Ok(Self::Get),
            "list" | "ls" => Ok(Self::List),
            "next" => Ok(Self::Next),
            "archive" => Ok(Self::Archive),
            "add_step" | "addstep" => Ok(Self::AddStep),
            "remove_step" | "removestep" => Ok(Self::RemoveStep),
            "estimate" => Ok(Self::Estimate),
            "visualize" | "viz" => Ok(Self::Visualize),
            "clone" | "copy" => Ok(Self::Clone),
            "cancel" => Ok(Self::Cancel),
            "notes" | "note" => Ok(Self::Notes),
            "progress" => Ok(Self::Progress),
            "clear" | "reset" => Ok(Self::Clear),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Arguments for plan tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlanToolArgs {
    #[serde(default)]
    pub action: String,
    /// Plan name
    pub name: Option<String>,
    /// New name for clone
    pub new_name: Option<String>,
    /// Plan steps as text or structured
    pub steps: Option<Value>,
    /// Step text for add_step
    pub step: Option<String>,
    /// Step index to update
    pub step_index: Option<usize>,
    /// Step ID to update
    pub step_id: Option<usize>,
    /// Position for add_step
    pub position: Option<usize>,
    /// New status for step
    pub status: Option<String>,
    /// Output for step
    pub output: Option<String>,
    /// Error for step
    pub error: Option<String>,
    /// Note text
    pub note: Option<String>,
}

/// Plan tool
pub struct PlanTool {
    plan: Arc<RwLock<TrackedPlan>>,
    plans: Arc<RwLock<std::collections::HashMap<String, TrackedPlan>>>,
    notes: Arc<RwLock<Vec<String>>>,
    counter: Arc<RwLock<usize>>,
}

impl PlanTool {
    pub fn new() -> Self {
        Self {
            plan: Arc::new(RwLock::new(TrackedPlan::default())),
            plans: Arc::new(RwLock::new(std::collections::HashMap::new())),
            notes: Arc::new(RwLock::new(Vec::new())),
            counter: Arc::new(RwLock::new(0)),
        }
    }

    pub async fn execute(&self, args: PlanToolArgs) -> Result<String> {
        let action: PlanAction = if args.action.is_empty() {
            PlanAction::Help
        } else {
            args.action.parse()?
        };

        let result = match action {
            PlanAction::Create => self.create(args).await?,
            PlanAction::Show => self.get().await?,
            PlanAction::Update => self.update(args).await?,
            PlanAction::Get => self.get().await?,
            PlanAction::List => self.list_plans().await?,
            PlanAction::Next => self.next_step().await?,
            PlanAction::Archive => self.archive(args).await?,
            PlanAction::AddStep => self.add_step(args).await?,
            PlanAction::RemoveStep => self.remove_step(args).await?,
            PlanAction::Estimate => self.estimate().await?,
            PlanAction::Visualize => self.visualize().await?,
            PlanAction::Clone => self.clone_plan(args).await?,
            PlanAction::Cancel => self.cancel(args).await?,
            PlanAction::Notes => self.manage_notes(args).await?,
            PlanAction::Progress => self.progress().await?,
            PlanAction::Clear => self.clear().await?,
            PlanAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn update(&self, args: PlanToolArgs) -> Result<Value> {
        let mut plan = self.plan.write().await;
        let now = chrono::Utc::now().to_rfc3339();

        // Update plan name
        if let Some(name) = args.name {
            plan.name = Some(name);
        }

        // Update or set steps
        if let Some(steps_val) = args.steps {
            plan.steps = self.parse_steps(steps_val)?;
            plan.created_at = Some(now.clone());
        }

        // Update specific step
        if let Some(idx) = args.step_index.or(args.step_id) {
            if idx > 0 && idx <= plan.steps.len() {
                let step = &mut plan.steps[idx - 1];

                if let Some(status_str) = args.status {
                    step.status = status_str.parse()?;
                }
                if let Some(output) = args.output {
                    step.output = Some(output);
                }
                if let Some(error) = args.error {
                    step.error = Some(error);
                    step.status = StepStatus::Failed;
                }
            } else {
                return Err(anyhow!("Invalid step index: {}", idx));
            }
        }

        plan.updated_at = Some(now);

        // Calculate progress
        let total = plan.steps.len();
        let completed = plan.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
        let in_progress = plan.steps.iter().filter(|s| s.status == StepStatus::InProgress).count();
        let failed = plan.steps.iter().filter(|s| s.status == StepStatus::Failed).count();

        Ok(json!({
            "name": plan.name,
            "total_steps": total,
            "completed": completed,
            "in_progress": in_progress,
            "failed": failed,
            "progress": if total > 0 { (completed as f64 / total as f64) * 100.0 } else { 0.0 },
            "steps": plan.steps,
            "updated_at": plan.updated_at
        }))
    }

    fn parse_steps(&self, value: Value) -> Result<Vec<TrackedStep>> {
        match value {
            Value::String(text) => {
                // Parse numbered list
                let steps: Vec<TrackedStep> = text
                    .lines()
                    .filter_map(|line| {
                        let line = line.trim();
                        if line.is_empty() {
                            return None;
                        }
                        // Remove numbering
                        let desc = line
                            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == '-')
                            .trim();
                        if desc.is_empty() {
                            return None;
                        }
                        Some(desc.to_string())
                    })
                    .enumerate()
                    .map(|(i, desc)| TrackedStep {
                        id: i + 1,
                        description: desc,
                        status: StepStatus::Pending,
                        output: None,
                        error: None,
                    })
                    .collect();
                Ok(steps)
            }
            Value::Array(arr) => {
                let steps: Vec<TrackedStep> = arr
                    .into_iter()
                    .enumerate()
                    .filter_map(|(i, v)| {
                        let desc = match v {
                            Value::String(s) => s,
                            Value::Object(obj) => {
                                obj.get("description")
                                    .or(obj.get("desc"))
                                    .or(obj.get("step"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())?
                            }
                            _ => return None,
                        };
                        Some(TrackedStep {
                            id: i + 1,
                            description: desc,
                            status: StepStatus::Pending,
                            output: None,
                            error: None,
                        })
                    })
                    .collect();
                Ok(steps)
            }
            _ => Err(anyhow!("steps must be string or array")),
        }
    }

    async fn create(&self, args: PlanToolArgs) -> Result<Value> {
        let mut counter = self.counter.write().await;
        *counter += 1;
        let name = args.name.unwrap_or_else(|| format!("plan-{}", *counter));
        let now = chrono::Utc::now().to_rfc3339();
        let steps = if let Some(sv) = args.steps { self.parse_steps(sv)? } else { Vec::new() };
        let plan = TrackedPlan { name: Some(name.clone()), steps, created_at: Some(now.clone()), updated_at: Some(now) };
        self.plans.write().await.insert(name.clone(), plan.clone());
        *self.plan.write().await = plan;
        Ok(json!({ "message": format!("Created plan '{}'", name), "name": name }))
    }

    async fn list_plans(&self) -> Result<Value> {
        let plans = self.plans.read().await;
        let items: Vec<Value> = plans.iter().map(|(n, p)| {
            let done = p.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
            json!({"name": n, "steps": p.steps.len(), "completed": done})
        }).collect();
        Ok(json!({ "plans": items, "total": items.len() }))
    }

    async fn next_step(&self) -> Result<Value> {
        let plan = self.plan.read().await;
        for (i, s) in plan.steps.iter().enumerate() {
            if s.status == StepStatus::Pending {
                return Ok(json!({"index": i+1, "step": s.description, "status": "pending"}));
            }
        }
        Ok(json!({"message": "All steps completed"}))
    }

    async fn archive(&self, args: PlanToolArgs) -> Result<Value> {
        let name = args.name.or_else(|| {
            let p = self.plan.try_read().ok();
            p.and_then(|p| p.name.clone())
        });
        if let Some(n) = &name {
            self.plans.write().await.remove(n);
        }
        *self.plan.write().await = TrackedPlan::default();
        Ok(json!({"message": format!("Archived plan '{}'", name.unwrap_or_default())}))
    }

    async fn add_step(&self, args: PlanToolArgs) -> Result<Value> {
        let step_text = args.step.ok_or_else(|| anyhow!("step text required"))?;
        let mut plan = self.plan.write().await;
        let id = plan.steps.len() + 1;
        let new_step = TrackedStep { id, description: step_text.clone(), status: StepStatus::Pending, output: None, error: None };
        if let Some(pos) = args.position {
            let pos = pos.min(plan.steps.len());
            plan.steps.insert(pos, new_step);
        } else {
            plan.steps.push(new_step);
        }
        plan.updated_at = Some(chrono::Utc::now().to_rfc3339());
        Ok(json!({"message": "Step added", "total_steps": plan.steps.len()}))
    }

    async fn remove_step(&self, args: PlanToolArgs) -> Result<Value> {
        let idx = args.step_index.or(args.step_id).ok_or_else(|| anyhow!("step_index required"))?;
        let mut plan = self.plan.write().await;
        if idx == 0 || idx > plan.steps.len() {
            return Err(anyhow!("Invalid step index: {}", idx));
        }
        let removed = plan.steps.remove(idx - 1);
        plan.updated_at = Some(chrono::Utc::now().to_rfc3339());
        Ok(json!({"message": format!("Removed step: {}", removed.description), "total_steps": plan.steps.len()}))
    }

    async fn estimate(&self) -> Result<Value> {
        let plan = self.plan.read().await;
        let total = plan.steps.len();
        if total == 0 { return Ok(json!({"progress": 0, "remaining": 0, "total": 0})); }
        let completed = plan.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
        let in_progress = plan.steps.iter().filter(|s| s.status == StepStatus::InProgress).count();
        let pct = ((completed as f64 + in_progress as f64 * 0.5) / total as f64 * 100.0).round();
        Ok(json!({"total": total, "completed": completed, "in_progress": in_progress, "pending": total - completed - in_progress, "progress_pct": pct}))
    }

    async fn visualize(&self) -> Result<Value> {
        let plan = self.plan.read().await;
        let name = plan.name.as_deref().unwrap_or("(unnamed)");
        let mut lines = vec![format!("Plan: {}", name)];
        for (i, s) in plan.steps.iter().enumerate() {
            let icon = match s.status {
                StepStatus::Completed => "[x]",
                StepStatus::InProgress => "[~]",
                StepStatus::Failed => "[!]",
                _ => "[ ]",
            };
            lines.push(format!("  {}. {} {}", i + 1, icon, s.description));
        }
        let total = plan.steps.len();
        let done = plan.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
        if total > 0 {
            let bar_len = 20;
            let filled = bar_len * done / total;
            let bar: String = "█".repeat(filled) + &"░".repeat(bar_len - filled);
            lines.push(format!("\n  [{}] {}/{}", bar, done, total));
        }
        Ok(json!({"visualization": lines.join("\n")}))
    }

    async fn clone_plan(&self, args: PlanToolArgs) -> Result<Value> {
        let plan = self.plan.read().await;
        if plan.steps.is_empty() { return Err(anyhow!("No active plan to clone")); }
        let mut counter = self.counter.write().await;
        *counter += 1;
        let new_name = args.new_name.unwrap_or_else(|| format!("{}-copy-{}", plan.name.as_deref().unwrap_or("plan"), *counter));
        let now = chrono::Utc::now().to_rfc3339();
        let new_steps: Vec<TrackedStep> = plan.steps.iter().enumerate().map(|(i, s)| TrackedStep {
            id: i + 1, description: s.description.clone(), status: StepStatus::Pending, output: None, error: None
        }).collect();
        let new_plan = TrackedPlan { name: Some(new_name.clone()), steps: new_steps, created_at: Some(now.clone()), updated_at: Some(now) };
        self.plans.write().await.insert(new_name.clone(), new_plan);
        Ok(json!({"message": format!("Cloned to '{}'", new_name)}))
    }

    async fn cancel(&self, args: PlanToolArgs) -> Result<Value> {
        self.archive(args).await
    }

    async fn manage_notes(&self, args: PlanToolArgs) -> Result<Value> {
        if let Some(note) = args.note {
            self.notes.write().await.push(note);
            let notes = self.notes.read().await;
            Ok(json!({"message": "Note added", "notes": *notes}))
        } else {
            let notes = self.notes.read().await;
            Ok(json!({"notes": *notes}))
        }
    }

    async fn progress(&self) -> Result<Value> {
        let plan = self.plan.read().await;
        let total = plan.steps.len();
        if total == 0 { return Ok(json!({"progress": 100, "message": "Empty plan"})); }
        let completed = plan.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
        Ok(json!({"progress": (completed as f64 / total as f64 * 100.0).round(), "completed": completed, "total": total}))
    }

    async fn get(&self) -> Result<Value> {
        let plan = self.plan.read().await;

        if plan.steps.is_empty() {
            return Ok(json!({
                "message": "No plan set. Use plan(action='update', steps='...') to create one."
            }));
        }

        let total = plan.steps.len();
        let completed = plan.steps.iter().filter(|s| s.status == StepStatus::Completed).count();
        let in_progress = plan.steps.iter().filter(|s| s.status == StepStatus::InProgress).count();
        let failed = plan.steps.iter().filter(|s| s.status == StepStatus::Failed).count();

        Ok(json!({
            "name": plan.name,
            "total_steps": total,
            "completed": completed,
            "in_progress": in_progress,
            "failed": failed,
            "progress": if total > 0 { (completed as f64 / total as f64) * 100.0 } else { 0.0 },
            "steps": plan.steps,
            "created_at": plan.created_at,
            "updated_at": plan.updated_at
        }))
    }

    async fn clear(&self) -> Result<Value> {
        let mut plan = self.plan.write().await;
        let had_plan = !plan.steps.is_empty();
        *plan = TrackedPlan::default();

        Ok(json!({
            "cleared": had_plan,
            "message": if had_plan { "Plan cleared" } else { "No plan to clear" }
        }))
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "plan",
            "version": "0.12.0",
            "description": "Plan tracking tool (HIP-0300)",
            "actions": {
                "update": "Update plan and step status",
                "get": "Get current plan",
                "clear": "Clear plan"
            },
            "example": {
                "create": "plan(action='update', steps='1. First step\\n2. Second step')",
                "update_step": "plan(action='update', step_index=1, status='completed')"
            }
        }))
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct PlanToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl PlanToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "plan".to_string(),
            description: r#"Plan tracking tool (HIP-0300).

Actions:
- update: Update plan and step status
- get: Get current plan
- clear: Clear plan

Step statuses: pending, in_progress, completed, failed, skipped"#.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["update", "get", "clear", "help"],
                        "default": "help"
                    },
                    "name": {"type": "string", "description": "Plan name"},
                    "steps": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}}
                        ],
                        "description": "Plan steps"
                    },
                    "step_index": {"type": "integer", "description": "Step index to update (1-based)"},
                    "step_id": {"type": "integer", "description": "Alias for step_index"},
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "failed", "skipped"],
                        "description": "New status for step"
                    },
                    "output": {"type": "string", "description": "Output for step"},
                    "error": {"type": "string", "description": "Error for step"}
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_plan() {
        let tool = PlanTool::new();
        let args = PlanToolArgs {
            action: "update".to_string(),
            name: Some("Test Plan".to_string()),
            steps: Some(Value::String("1. First step\n2. Second step\n3. Third step".to_string())),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Test Plan"));
        assert!(output.contains("total_steps"));
    }

    #[tokio::test]
    async fn test_update_step() {
        let tool = PlanTool::new();

        // Create plan
        let args = PlanToolArgs {
            action: "update".to_string(),
            steps: Some(Value::String("1. First step\n2. Second step".to_string())),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Update step
        let args = PlanToolArgs {
            action: "update".to_string(),
            step_index: Some(1),
            status: Some("completed".to_string()),
            output: Some("Done!".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("completed"));
    }

    #[tokio::test]
    async fn test_get_plan() {
        let tool = PlanTool::new();

        // Create plan
        let args = PlanToolArgs {
            action: "update".to_string(),
            steps: Some(Value::Array(vec![
                Value::String("Step 1".to_string()),
                Value::String("Step 2".to_string()),
            ])),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Get plan
        let args = PlanToolArgs {
            action: "get".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Step 1"));
        assert!(output.contains("Step 2"));
    }

    #[tokio::test]
    async fn test_clear_plan() {
        let tool = PlanTool::new();

        // Create plan
        let args = PlanToolArgs {
            action: "update".to_string(),
            steps: Some(Value::String("1. Step".to_string())),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Clear
        let args = PlanToolArgs {
            action: "clear".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("cleared"));
    }
}
