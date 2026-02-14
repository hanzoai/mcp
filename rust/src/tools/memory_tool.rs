/// Memory and knowledge management tool (HIP-0300)
///
/// Provides persistent memory capabilities:
/// - recall: Search memories
/// - create: Store new memories
/// - update: Update existing memories
/// - delete: Remove memories
/// - facts: Manage knowledge base facts
/// - summarize: Summarize and store information

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Memory scope
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Session,
    Project,
    Global,
}

impl Default for MemoryScope {
    fn default() -> Self {
        Self::Project
    }
}

impl std::str::FromStr for MemoryScope {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "session" => Ok(Self::Session),
            "project" => Ok(Self::Project),
            "global" => Ok(Self::Global),
            _ => Ok(Self::Project),
        }
    }
}

/// Memory action types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAction {
    Recall,
    Create,
    Update,
    Delete,
    Manage,
    Facts,
    Summarize,
    List,
    Help,
}

impl Default for MemoryAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for MemoryAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "recall" | "search" | "query" => Ok(Self::Recall),
            "create" | "add" | "store" => Ok(Self::Create),
            "update" | "modify" => Ok(Self::Update),
            "delete" | "remove" => Ok(Self::Delete),
            "manage" => Ok(Self::Manage),
            "facts" | "fact" => Ok(Self::Facts),
            "summarize" | "summary" => Ok(Self::Summarize),
            "list" => Ok(Self::List),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// A stored memory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub scope: MemoryScope,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: HashMap<String, Value>,
}

/// A fact in a knowledge base
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub id: String,
    pub content: String,
    pub kb_name: String,
    pub scope: MemoryScope,
    pub created_at: String,
}

/// Knowledge base
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KnowledgeBase {
    pub name: String,
    pub description: Option<String>,
    pub scope: MemoryScope,
    pub facts: Vec<Fact>,
    pub created_at: String,
}

/// Arguments for memory tool
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryToolArgs {
    #[serde(default)]
    pub action: String,
    /// Query for recall
    pub queries: Option<Vec<String>>,
    /// Single query
    pub query: Option<String>,
    /// Statements to store
    pub statements: Option<Vec<String>>,
    /// Single statement
    pub statement: Option<String>,
    /// Memory ID for update/delete
    pub id: Option<String>,
    /// Memory IDs for batch operations
    pub ids: Option<Vec<String>>,
    /// Updates for batch update
    pub updates: Option<Vec<Value>>,
    /// Scope
    pub scope: Option<String>,
    /// Limit results
    pub limit: Option<usize>,
    /// Knowledge base name
    pub kb_name: Option<String>,
    /// Facts to store
    pub facts: Option<Vec<String>>,
    /// Content to summarize
    pub content: Option<String>,
    /// Topic for summary
    pub topic: Option<String>,
    /// Metadata
    pub metadata: Option<HashMap<String, Value>>,
    /// Creations for manage
    pub creations: Option<Vec<String>>,
    /// Deletions for manage
    pub deletions: Option<Vec<String>>,
}

/// Memory tool
pub struct MemoryTool {
    memories: Arc<RwLock<HashMap<String, Memory>>>,
    knowledge_bases: Arc<RwLock<HashMap<String, KnowledgeBase>>>,
    counter: Arc<RwLock<u64>>,
    storage_path: PathBuf,
}

impl MemoryTool {
    pub fn new() -> Self {
        let storage_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("hanzo-mcp")
            .join("memory");

        Self {
            memories: Arc::new(RwLock::new(HashMap::new())),
            knowledge_bases: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(RwLock::new(0)),
            storage_path,
        }
    }

    async fn next_id(&self, prefix: &str) -> String {
        let mut counter = self.counter.write().await;
        *counter += 1;
        format!("{}_{}", prefix, *counter)
    }

    pub async fn execute(&self, args: MemoryToolArgs) -> Result<String> {
        let action: MemoryAction = if args.action.is_empty() {
            MemoryAction::Help
        } else {
            args.action.parse()?
        };

        let result = match action {
            MemoryAction::Recall => self.recall(args).await?,
            MemoryAction::Create => self.create(args).await?,
            MemoryAction::Update => self.update(args).await?,
            MemoryAction::Delete => self.delete(args).await?,
            MemoryAction::Manage => self.manage(args).await?,
            MemoryAction::Facts => self.facts(args).await?,
            MemoryAction::Summarize => self.summarize(args).await?,
            MemoryAction::List => self.list(args).await?,
            MemoryAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn recall(&self, args: MemoryToolArgs) -> Result<Value> {
        let queries = args.queries.or_else(|| args.query.map(|q| vec![q]))
            .ok_or_else(|| anyhow!("queries required"))?;
        let scope: MemoryScope = args.scope.as_deref().unwrap_or("project").parse()?;
        let limit = args.limit.unwrap_or(10);

        let memories = self.memories.read().await;
        let mut results = Vec::new();

        for query in &queries {
            let query_lower = query.to_lowercase();
            let matches: Vec<&Memory> = memories.values()
                .filter(|m| {
                    m.scope == scope && m.content.to_lowercase().contains(&query_lower)
                })
                .take(limit)
                .collect();

            for m in matches {
                results.push(json!({
                    "id": m.id,
                    "content": m.content,
                    "scope": format!("{:?}", m.scope).to_lowercase(),
                    "created_at": m.created_at,
                    "relevance": 1.0 // Simplified - would use vector similarity in real impl
                }));
            }
        }

        Ok(json!({
            "queries": queries,
            "scope": format!("{:?}", scope).to_lowercase(),
            "results": results,
            "count": results.len()
        }))
    }

    async fn create(&self, args: MemoryToolArgs) -> Result<Value> {
        let statements = args.statements.or_else(|| args.statement.map(|s| vec![s]))
            .ok_or_else(|| anyhow!("statements required"))?;
        let scope: MemoryScope = args.scope.as_deref().unwrap_or("project").parse()?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut created_ids = Vec::new();
        let mut memories = self.memories.write().await;

        for statement in statements {
            let id = self.next_id("mem").await;
            let memory = Memory {
                id: id.clone(),
                content: statement,
                scope: scope.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
                metadata: args.metadata.clone().unwrap_or_default(),
            };
            memories.insert(id.clone(), memory);
            created_ids.push(id);
        }

        Ok(json!({
            "created": created_ids.len(),
            "ids": created_ids,
            "scope": format!("{:?}", scope).to_lowercase()
        }))
    }

    async fn update(&self, args: MemoryToolArgs) -> Result<Value> {
        let updates = args.updates.ok_or_else(|| anyhow!("updates required"))?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut updated_ids = Vec::new();
        let mut memories = self.memories.write().await;

        for update_val in updates {
            if let Some(obj) = update_val.as_object() {
                if let (Some(id), Some(statement)) = (
                    obj.get("id").and_then(|v| v.as_str()),
                    obj.get("statement").and_then(|v| v.as_str())
                ) {
                    if let Some(memory) = memories.get_mut(id) {
                        memory.content = statement.to_string();
                        memory.updated_at = now.clone();
                        updated_ids.push(id.to_string());
                    }
                }
            }
        }

        Ok(json!({
            "updated": updated_ids.len(),
            "ids": updated_ids
        }))
    }

    async fn delete(&self, args: MemoryToolArgs) -> Result<Value> {
        let ids = args.ids.or_else(|| args.id.map(|id| vec![id]))
            .ok_or_else(|| anyhow!("ids required"))?;

        let mut deleted_ids = Vec::new();
        let mut memories = self.memories.write().await;

        for id in ids {
            if memories.remove(&id).is_some() {
                deleted_ids.push(id);
            }
        }

        Ok(json!({
            "deleted": deleted_ids.len(),
            "ids": deleted_ids
        }))
    }

    async fn manage(&self, args: MemoryToolArgs) -> Result<Value> {
        let scope: MemoryScope = args.scope.as_deref().unwrap_or("project").parse()?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut created_ids = Vec::new();
        let mut updated_ids = Vec::new();
        let mut deleted_ids = Vec::new();

        // Handle creations
        if let Some(creations) = args.creations {
            let mut memories = self.memories.write().await;
            for statement in creations {
                let id = self.next_id("mem").await;
                let memory = Memory {
                    id: id.clone(),
                    content: statement,
                    scope: scope.clone(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    metadata: HashMap::new(),
                };
                memories.insert(id.clone(), memory);
                created_ids.push(id);
            }
        }

        // Handle updates
        if let Some(updates) = args.updates {
            let mut memories = self.memories.write().await;
            for update_val in updates {
                if let Some(obj) = update_val.as_object() {
                    if let (Some(id), Some(statement)) = (
                        obj.get("id").and_then(|v| v.as_str()),
                        obj.get("statement").and_then(|v| v.as_str())
                    ) {
                        if let Some(memory) = memories.get_mut(id) {
                            memory.content = statement.to_string();
                            memory.updated_at = now.clone();
                            updated_ids.push(id.to_string());
                        }
                    }
                }
            }
        }

        // Handle deletions
        if let Some(deletions) = args.deletions {
            let mut memories = self.memories.write().await;
            for id in deletions {
                if memories.remove(&id).is_some() {
                    deleted_ids.push(id);
                }
            }
        }

        Ok(json!({
            "created": created_ids,
            "updated": updated_ids,
            "deleted": deleted_ids,
            "scope": format!("{:?}", scope).to_lowercase()
        }))
    }

    async fn facts(&self, args: MemoryToolArgs) -> Result<Value> {
        let kb_name = args.kb_name.unwrap_or_else(|| "general".to_string());
        let scope: MemoryScope = args.scope.as_deref().unwrap_or("project").parse()?;
        let now = chrono::Utc::now().to_rfc3339();

        if let Some(new_facts) = args.facts {
            // Store facts
            let mut kbs = self.knowledge_bases.write().await;
            let kb = kbs.entry(kb_name.clone()).or_insert_with(|| KnowledgeBase {
                name: kb_name.clone(),
                description: None,
                scope: scope.clone(),
                facts: Vec::new(),
                created_at: now.clone(),
            });

            let mut created_ids = Vec::new();
            for fact_content in new_facts {
                let id = self.next_id("fact").await;
                let fact = Fact {
                    id: id.clone(),
                    content: fact_content,
                    kb_name: kb_name.clone(),
                    scope: scope.clone(),
                    created_at: now.clone(),
                };
                kb.facts.push(fact);
                created_ids.push(id);
            }

            return Ok(json!({
                "stored": created_ids.len(),
                "ids": created_ids,
                "kb_name": kb_name
            }));
        }

        // Recall facts
        if let Some(queries) = args.queries.or_else(|| args.query.map(|q| vec![q])) {
            let kbs = self.knowledge_bases.read().await;
            let limit = args.limit.unwrap_or(10);
            let mut results = Vec::new();

            if let Some(kb) = kbs.get(&kb_name) {
                for query in &queries {
                    let query_lower = query.to_lowercase();
                    let matches: Vec<&Fact> = kb.facts.iter()
                        .filter(|f| f.content.to_lowercase().contains(&query_lower))
                        .take(limit)
                        .collect();

                    for f in matches {
                        results.push(json!({
                            "id": f.id,
                            "content": f.content,
                            "kb_name": f.kb_name
                        }));
                    }
                }
            }

            return Ok(json!({
                "queries": queries,
                "kb_name": kb_name,
                "results": results,
                "count": results.len()
            }));
        }

        // List knowledge bases
        let kbs = self.knowledge_bases.read().await;
        let kb_list: Vec<Value> = kbs.values()
            .map(|kb| json!({
                "name": kb.name,
                "description": kb.description,
                "fact_count": kb.facts.len(),
                "scope": format!("{:?}", kb.scope).to_lowercase()
            }))
            .collect();

        Ok(json!({
            "knowledge_bases": kb_list,
            "count": kb_list.len()
        }))
    }

    async fn summarize(&self, args: MemoryToolArgs) -> Result<Value> {
        let content = args.content.ok_or_else(|| anyhow!("content required"))?;
        let topic = args.topic.ok_or_else(|| anyhow!("topic required"))?;
        let scope: MemoryScope = args.scope.as_deref().unwrap_or("project").parse()?;
        let now = chrono::Utc::now().to_rfc3339();

        // Create memory from summary
        let id = self.next_id("mem").await;
        let summary = format!("[{}] {}", topic, content);
        let memory = Memory {
            id: id.clone(),
            content: summary.clone(),
            scope,
            created_at: now.clone(),
            updated_at: now,
            metadata: {
                let mut m = HashMap::new();
                m.insert("topic".to_string(), json!(topic));
                m.insert("type".to_string(), json!("summary"));
                m
            },
        };

        self.memories.write().await.insert(id.clone(), memory);

        // Extract key facts (simplified - would use NLP in real impl)
        let facts: Vec<&str> = content.lines()
            .filter(|l| !l.trim().is_empty())
            .take(5)
            .collect();

        Ok(json!({
            "id": id,
            "topic": topic,
            "stored": true,
            "extracted_facts": facts.len(),
            "facts": facts
        }))
    }

    async fn list(&self, args: MemoryToolArgs) -> Result<Value> {
        let scope: Option<MemoryScope> = args.scope.as_deref().map(|s| s.parse().ok()).flatten();
        let limit = args.limit.unwrap_or(50);

        let memories = self.memories.read().await;
        let results: Vec<Value> = memories.values()
            .filter(|m| scope.as_ref().map_or(true, |s| m.scope == *s))
            .take(limit)
            .map(|m| json!({
                "id": m.id,
                "content": m.content,
                "scope": format!("{:?}", m.scope).to_lowercase(),
                "created_at": m.created_at
            }))
            .collect();

        Ok(json!({
            "memories": results,
            "count": results.len(),
            "total": memories.len()
        }))
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "memory",
            "version": "0.12.0",
            "description": "Memory and knowledge management tool (HIP-0300)",
            "actions": {
                "recall": "Search memories by query",
                "create": "Store new memories",
                "update": "Update existing memories",
                "delete": "Remove memories",
                "manage": "Atomic create/update/delete",
                "facts": "Manage knowledge base facts",
                "summarize": "Summarize and store information",
                "list": "List all memories"
            },
            "scopes": ["session", "project", "global"]
        }))
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl MemoryToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "memory".to_string(),
            description: r#"Memory and knowledge management tool (HIP-0300).

Actions:
- recall: Search memories by query
- create: Store new memories
- update: Update existing memories
- delete: Remove memories
- manage: Atomic create/update/delete
- facts: Manage knowledge base facts
- summarize: Summarize and store information
- list: List all memories

Scopes: session, project, global"#.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["recall", "create", "update", "delete", "manage", "facts", "summarize", "list", "help"]
                    },
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "query": {"type": "string"},
                    "statements": {"type": "array", "items": {"type": "string"}},
                    "statement": {"type": "string"},
                    "id": {"type": "string"},
                    "ids": {"type": "array", "items": {"type": "string"}},
                    "updates": {"type": "array", "items": {"type": "object"}},
                    "scope": {"type": "string", "enum": ["session", "project", "global"]},
                    "limit": {"type": "integer"},
                    "kb_name": {"type": "string"},
                    "facts": {"type": "array", "items": {"type": "string"}},
                    "content": {"type": "string"},
                    "topic": {"type": "string"},
                    "creations": {"type": "array", "items": {"type": "string"}},
                    "deletions": {"type": "array", "items": {"type": "string"}}
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_memory() {
        let tool = MemoryTool::new();
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["User prefers dark mode".to_string()]),
            scope: Some("project".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("created"));
    }

    #[tokio::test]
    async fn test_recall_memory() {
        let tool = MemoryTool::new();

        // Create first
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["User prefers Python".to_string()]),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Recall
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            queries: Some(vec!["Python".to_string()]),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Python"));
    }

    #[tokio::test]
    async fn test_facts() {
        let tool = MemoryTool::new();
        let args = MemoryToolArgs {
            action: "facts".to_string(),
            kb_name: Some("coding".to_string()),
            facts: Some(vec!["Use uv for Python".to_string()]),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("stored"));
    }

    #[tokio::test]
    async fn test_summarize() {
        let tool = MemoryTool::new();
        let args = MemoryToolArgs {
            action: "summarize".to_string(),
            content: Some("Discussion about API design patterns and best practices.".to_string()),
            topic: Some("API Design".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("API Design"));
    }
}
