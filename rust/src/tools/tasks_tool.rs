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
    Stats,
    Search,
    Batch,
    Archive,
    Move,
    Prioritize,
    Assign,
    Subtasks,
    Notes,
    Export,
    Import,
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
            "stats" => Ok(Self::Stats),
            "search" => Ok(Self::Search),
            "batch" => Ok(Self::Batch),
            "archive" => Ok(Self::Archive),
            "move" => Ok(Self::Move),
            "prioritize" => Ok(Self::Prioritize),
            "assign" => Ok(Self::Assign),
            "subtasks" => Ok(Self::Subtasks),
            "notes" => Ok(Self::Notes),
            "export" => Ok(Self::Export),
            "import" => Ok(Self::Import),
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
    pub assignee: Option<String>,
    pub notes: Option<Vec<String>>,
    pub subtasks: Option<Vec<TodoItem>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TasksToolArgs {
    pub action: Option<String>,
    pub text: Option<String>,
    pub id: Option<usize>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub query: Option<String>,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub position: Option<usize>,
    pub assignee: Option<String>,
    pub note: Option<String>,
    pub content: Option<String>,
    pub format: Option<String>,
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
            TodoAction::Stats => self.stats().await,
            TodoAction::Search => self.search(&args).await,
            TodoAction::Batch => self.batch(&args).await,
            TodoAction::Archive => self.archive(&args).await,
            TodoAction::Move => self.move_item(&args).await,
            TodoAction::Prioritize => self.prioritize(&args).await,
            TodoAction::Assign => self.assign(&args).await,
            TodoAction::Subtasks => self.subtasks(&args).await,
            TodoAction::Notes => self.notes(&args).await,
            TodoAction::Export => self.export_items(&args).await,
            TodoAction::Import => self.import_items(&args).await,
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
            assignee: None,
            notes: None,
            subtasks: None,
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

    async fn stats(&self) -> Result<Value> {
        let items = self.items.read().await;
        let total = items.len();
        let by_status = |s: &str| items.iter().filter(|i| i.status == s).count();
        Ok(json!({
            "ok": true,
            "data": { "total": total, "pending": by_status("pending"), "in_progress": by_status("in_progress"), "done": by_status("done") },
            "meta": { "tool": "tasks", "action": "stats" }
        }))
    }

    async fn search(&self, args: &TasksToolArgs) -> Result<Value> {
        let query = args.query.as_deref().or(args.text.as_deref()).ok_or_else(|| anyhow!("query or text required"))?;
        let items = self.items.read().await;
        let q = query.to_lowercase();
        let matches: Vec<&TodoItem> = items.iter().filter(|i| i.text.to_lowercase().contains(&q)).collect();
        Ok(json!({
            "ok": true,
            "data": { "matches": matches.len(), "items": matches.iter().map(|i| json!({"id": i.id, "text": &i.text, "status": &i.status})).collect::<Vec<_>>() },
            "meta": { "tool": "tasks", "action": "search" }
        }))
    }

    async fn batch(&self, args: &TasksToolArgs) -> Result<Value> {
        let from = args.from_status.as_deref().ok_or_else(|| anyhow!("from_status required"))?;
        let to = args.to_status.as_deref().or(args.status.as_deref()).ok_or_else(|| anyhow!("to_status or status required"))?;
        let mut items = self.items.write().await;
        let mut count = 0;
        for item in items.iter_mut() {
            if item.status == from { item.status = to.to_string(); count += 1; }
        }
        Ok(json!({ "ok": true, "data": { "updated": count }, "meta": { "tool": "tasks", "action": "batch" } }))
    }

    async fn archive(&self, args: &TasksToolArgs) -> Result<Value> {
        let mut items = self.items.write().await;
        if let Some(id) = args.id {
            if let Some(item) = items.iter_mut().find(|i| i.id == id) {
                item.status = "archived".to_string();
                return Ok(json!({ "ok": true, "data": { "archived": id }, "meta": { "tool": "tasks", "action": "archive" } }));
            }
            return Ok(json!({ "ok": false, "error": format!("Todo {} not found", id) }));
        }
        let mut count = 0;
        for item in items.iter_mut() {
            if item.status == "done" || item.status == "completed" { item.status = "archived".to_string(); count += 1; }
        }
        Ok(json!({ "ok": true, "data": { "archived": count }, "meta": { "tool": "tasks", "action": "archive" } }))
    }

    async fn move_item(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let pos = args.position.unwrap_or(0);
        let mut items = self.items.write().await;
        let idx = items.iter().position(|i| i.id == id).ok_or_else(|| anyhow!("Todo {} not found", id))?;
        let item = items.remove(idx);
        let pos = pos.min(items.len());
        items.insert(pos, item);
        Ok(json!({ "ok": true, "data": { "moved": id, "position": pos }, "meta": { "tool": "tasks", "action": "move" } }))
    }

    async fn prioritize(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let priority = args.priority.as_deref().ok_or_else(|| anyhow!("priority required"))?;
        let mut items = self.items.write().await;
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            item.priority = Some(priority.to_string());
            Ok(json!({ "ok": true, "data": { "id": id, "priority": priority }, "meta": { "tool": "tasks", "action": "prioritize" } }))
        } else {
            Ok(json!({ "ok": false, "error": format!("Todo {} not found", id) }))
        }
    }

    async fn assign(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let assignee = args.assignee.as_deref().unwrap_or("");
        let mut items = self.items.write().await;
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            item.assignee = Some(assignee.to_string());
            Ok(json!({ "ok": true, "data": { "id": id, "assignee": assignee }, "meta": { "tool": "tasks", "action": "assign" } }))
        } else {
            Ok(json!({ "ok": false, "error": format!("Todo {} not found", id) }))
        }
    }

    async fn subtasks(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let items = self.items.read().await;
        if let Some(item) = items.iter().find(|i| i.id == id) {
            let subs = item.subtasks.as_deref().unwrap_or(&[]);
            Ok(json!({ "ok": true, "data": { "id": id, "subtasks": subs.iter().map(|s| json!({"id": s.id, "text": &s.text, "status": &s.status})).collect::<Vec<_>>() }, "meta": { "tool": "tasks", "action": "subtasks" } }))
        } else {
            Ok(json!({ "ok": false, "error": format!("Todo {} not found", id) }))
        }
    }

    async fn notes(&self, args: &TasksToolArgs) -> Result<Value> {
        let id = args.id.ok_or_else(|| anyhow!("id required"))?;
        let items = self.items.read().await;
        if let Some(item) = items.iter().find(|i| i.id == id) {
            let notes = item.notes.as_deref().unwrap_or(&[]);
            Ok(json!({ "ok": true, "data": { "id": id, "notes": notes }, "meta": { "tool": "tasks", "action": "notes" } }))
        } else {
            Ok(json!({ "ok": false, "error": format!("Todo {} not found", id) }))
        }
    }

    async fn export_items(&self, _args: &TasksToolArgs) -> Result<Value> {
        let items = self.items.read().await;
        let items_json: Vec<Value> = items.iter().map(|i| json!({"id": i.id, "text": &i.text, "status": &i.status, "priority": &i.priority})).collect();
        Ok(json!({ "ok": true, "data": { "items": items_json, "count": items.len() }, "meta": { "tool": "tasks", "action": "export" } }))
    }

    async fn import_items(&self, args: &TasksToolArgs) -> Result<Value> {
        let content = args.content.as_deref().ok_or_else(|| anyhow!("content (JSON) required"))?;
        let data: Value = serde_json::from_str(content).map_err(|e| anyhow!("Invalid JSON: {}", e))?;
        let arr = data.as_array().or_else(|| data.get("items").and_then(|v| v.as_array())).ok_or_else(|| anyhow!("Expected array or {{items:[...]}}"))?;
        let mut counter = self.counter.write().await;
        let mut items = self.items.write().await;
        let mut count = 0;
        for v in arr {
            if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
                *counter += 1;
                items.push(TodoItem { id: *counter, text: text.to_string(), status: "pending".to_string(), priority: v.get("priority").and_then(|p| p.as_str()).map(String::from), assignee: None, notes: None, subtasks: None });
                count += 1;
            }
        }
        Ok(json!({ "ok": true, "data": { "imported": count }, "meta": { "tool": "tasks", "action": "import" } }))
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
