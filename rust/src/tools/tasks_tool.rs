/// Unified todo tool (HIP-0300)
///
/// Actions: list, add, update, remove, clear

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TodoAction {
    List,
    Add,
    Update,
    Remove,
    Clear,
    Help,
}

impl Default for TodoAction {
    fn default() -> Self {
        Self::List
    }
}

impl std::str::FromStr for TodoAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "list" | "ls" | "" => Ok(Self::List),
            "add" | "create" | "new" => Ok(Self::Add),
            "update" | "edit" | "modify" => Ok(Self::Update),
            "remove" | "delete" | "rm" => Ok(Self::Remove),
            "clear" | "reset" => Ok(Self::Clear),
            "help" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: usize,
    pub text: String,
    pub status: String, // "pending", "in_progress", "done"
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TasksToolArgs {
    pub action: Option<String>,
    pub text: Option<String>,
    pub id: Option<usize>,
    pub status: Option<String>,
    pub priority: Option<String>,
}

pub struct TasksToolDefinition;

impl TasksToolDefinition {
    pub fn schema() -> Value {
        json!({
            "name": "tasks",
            "description": "Task tracking: list, add, update, remove, clear",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "add", "update", "remove", "clear", "help"],
                        "description": "Todo action"
                    },
                    "text": { "type": "string", "description": "Todo text" },
                    "id": { "type": "number", "description": "Todo ID" },
                    "status": { "type": "string", "description": "Status: pending, in_progress, done" },
                    "priority": { "type": "string", "description": "Priority: low, medium, high" }
                },
                "required": []
            }
        })
    }
}

pub struct TasksTool {
    items: Arc<RwLock<Vec<TodoItem>>>,
    counter: Arc<RwLock<usize>>,
}

impl TasksTool {
    pub fn new() -> Self {
        Self {
            items: Arc::new(RwLock::new(Vec::new())),
            counter: Arc::new(RwLock::new(0)),
        }
    }

    pub async fn execute(&self, args: TasksToolArgs) -> Result<Value> {
        let action: TodoAction = args.action.as_deref().unwrap_or("list").parse()?;

        match action {
            TodoAction::List => self.list().await,
            TodoAction::Add => self.add(&args).await,
            TodoAction::Update => self.update(&args).await,
            TodoAction::Remove => self.remove(&args).await,
            TodoAction::Clear => self.clear().await,
            TodoAction::Help => Ok(self.help()),
        }
    }

    async fn list(&self) -> Result<Value> {
        let items = self.items.read().await;
        let items_json: Vec<Value> = items.iter().map(|i| json!(i)).collect();

        Ok(json!({
            "ok": true,
            "data": { "items": items_json, "count": items.len() },
            "error": null,
            "meta": { "tool": "tasks", "action": "list" }
        }))
    }

    async fn add(&self, args: &TasksToolArgs) -> Result<Value> {
        let text = args.text.as_deref().ok_or_else(|| anyhow!("text required"))?;

        let mut counter = self.counter.write().await;
        *counter += 1;
        let id = *counter;

        let item = TodoItem {
            id,
            text: text.to_string(),
            status: "pending".to_string(),
            priority: args.priority.clone(),
        };

        self.items.write().await.push(item.clone());

        Ok(json!({
            "ok": true,
            "data": { "item": item, "id": id },
            "error": null,
            "meta": { "tool": "tasks", "action": "add" }
        }))
    }

    async fn update(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let mut items = self.items.write().await;

        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            if let Some(text) = &args.text { item.text = text.clone(); }
            if let Some(status) = &args.status { item.status = status.clone(); }
            if let Some(priority) = &args.priority { item.priority = Some(priority.clone()); }

            Ok(json!({
                "ok": true,
                "data": { "item": json!(item) },
                "error": null,
                "meta": { "tool": "tasks", "action": "update" }
            }))
        } else {
            Ok(json!({
                "ok": false,
                "data": null,
                "error": { "code": "NOT_FOUND", "message": format!("Todo {} not found", id) },
                "meta": { "tool": "tasks", "action": "update" }
            }))
        }
    }

    async fn remove(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let mut items = self.items.write().await;
        let len_before = items.len();
        items.retain(|i| i.id != id);

        if items.len() < len_before {
            Ok(json!({
                "ok": true,
                "data": { "removed": id },
                "error": null,
                "meta": { "tool": "tasks", "action": "remove" }
            }))
        } else {
            Ok(json!({
                "ok": false,
                "data": null,
                "error": { "code": "NOT_FOUND", "message": format!("Todo {} not found", id) },
                "meta": { "tool": "tasks", "action": "remove" }
            }))
        }
    }

    async fn clear(&self) -> Result<Value> {
        let mut items = self.items.write().await;
        let count = items.len();
        items.clear();

        Ok(json!({
            "ok": true,
            "data": { "cleared": count },
            "error": null,
            "meta": { "tool": "tasks", "action": "clear" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "tasks",
                "actions": {
                    "list": "List all todos",
                    "add": "Add todo (requires text, optional priority)",
                    "update": "Update todo (requires id, optional text/status/priority)",
                    "remove": "Remove todo (requires id)",
                    "clear": "Clear all todos"
                }
            },
            "error": null,
            "meta": { "tool": "tasks", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_todo_crud() {
        let tool = TasksTool::new();

        // Add
        let result = tool.execute(TasksToolArgs {
            action: Some("add".to_string()),
            text: Some("Test task".to_string()),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(result["ok"], true);

        // List
        let result = tool.execute(TasksToolArgs {
            action: Some("list".to_string()),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(result["data"]["count"], 1);

        // Clear
        let result = tool.execute(TasksToolArgs {
            action: Some("clear".to_string()),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(result["data"]["cleared"], 1);
    }
}
