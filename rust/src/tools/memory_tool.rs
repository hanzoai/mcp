/// Memory and knowledge management tool (HIP-0300)
///
/// Provides persistent memory capabilities:
/// - recall: Search memories
/// - create: Store new memories
/// - update: Update existing memories
/// - delete: Remove memories
/// - facts: Manage knowledge base facts
/// - summarize: Summarize and store information
/// - kb: Knowledge base management
/// - help: Documentation
///
/// Persistence: ~/.hanzo/memory.json (cross-runtime compatible with TypeScript)

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

impl std::fmt::Display for MemoryScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Session => write!(f, "session"),
            Self::Project => write!(f, "project"),
            Self::Global => write!(f, "global"),
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
    Stats,
    Clear,
    Export,
    Import,
    Merge,
    Tag,
    Untag,
    Namespaces,
    History,
    Kb,
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
            "stats" => Ok(Self::Stats),
            "clear" => Ok(Self::Clear),
            "export" => Ok(Self::Export),
            "import" | "import_memories" => Ok(Self::Import),
            "merge" => Ok(Self::Merge),
            "tag" => Ok(Self::Tag),
            "untag" => Ok(Self::Untag),
            "namespaces" => Ok(Self::Namespaces),
            "history" => Ok(Self::History),
            "kb" => Ok(Self::Kb),
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

// ---------------------------------------------------------------------------
// Persistence format — matches TypeScript ~/.hanzo/memory.json
// ---------------------------------------------------------------------------

/// On-disk entry format (TypeScript-compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistEntry {
    id: String,
    key: String,
    value: String,
    tags: Vec<String>,
    namespace: String,
    created: String,
    updated: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl: Option<String>,
}

/// On-disk fact format
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistFact {
    id: String,
    content: String,
    kb_name: String,
    scope: String,
    created: String,
}

/// On-disk KB metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistKb {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    scope: String,
    created: String,
}

/// On-disk store format (TypeScript-compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistStore {
    entries: Vec<PersistEntry>,
    #[serde(rename = "lastId")]
    last_id: u64,
    #[serde(default)]
    facts: Vec<PersistFact>,
    #[serde(rename = "lastFactId", default)]
    last_fact_id: u64,
    #[serde(rename = "knowledgeBases", default)]
    knowledge_bases: Vec<PersistKb>,
}

impl Default for PersistStore {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            last_id: 0,
            facts: Vec::new(),
            last_fact_id: 0,
            knowledge_bases: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Conversion: Memory <-> PersistEntry
// ---------------------------------------------------------------------------

fn scope_to_namespace(scope: &MemoryScope, metadata: &HashMap<String, Value>) -> String {
    if let Some(Value::String(ns)) = metadata.get("namespace") {
        return ns.clone();
    }
    match scope {
        MemoryScope::Session => "session".to_string(),
        MemoryScope::Project => "default".to_string(),
        MemoryScope::Global => "global".to_string(),
    }
}

fn namespace_to_scope(ns: &str) -> MemoryScope {
    match ns {
        "session" => MemoryScope::Session,
        "global" => MemoryScope::Global,
        "default" => MemoryScope::Project,
        _ => MemoryScope::Project,
    }
}

fn memory_to_entry(m: &Memory) -> PersistEntry {
    let tags: Vec<String> = m.metadata.keys()
        .filter(|k| k.starts_with("tag:"))
        .map(|k| k.strip_prefix("tag:").unwrap().to_string())
        .collect();

    let key = m.metadata.get("key")
        .and_then(|v| v.as_str())
        .unwrap_or(&m.id)
        .to_string();

    let ttl = m.metadata.get("ttl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Build clean metadata (exclude tags, key, ttl, namespace which are stored in dedicated fields)
    let clean_meta: HashMap<String, Value> = m.metadata.iter()
        .filter(|(k, _)| !k.starts_with("tag:") && *k != "key" && *k != "ttl" && *k != "namespace")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    PersistEntry {
        id: m.id.clone(),
        key,
        value: m.content.clone(),
        tags,
        namespace: scope_to_namespace(&m.scope, &m.metadata),
        created: m.created_at.clone(),
        updated: m.updated_at.clone(),
        metadata: if clean_meta.is_empty() { None } else { Some(clean_meta) },
        ttl,
    }
}

fn entry_to_memory(e: &PersistEntry) -> Memory {
    let mut metadata: HashMap<String, Value> = e.metadata.clone().unwrap_or_default();

    // Store tags in metadata
    for tag in &e.tags {
        metadata.insert(format!("tag:{}", tag), json!(true));
    }

    // Store key in metadata
    metadata.insert("key".to_string(), json!(e.key));

    // Store TTL in metadata
    if let Some(ref ttl) = e.ttl {
        metadata.insert("ttl".to_string(), json!(ttl));
    }

    // Store namespace in metadata if not a standard scope name
    let scope = namespace_to_scope(&e.namespace);
    if e.namespace != "session" && e.namespace != "global" && e.namespace != "default" {
        metadata.insert("namespace".to_string(), json!(e.namespace));
    }

    Memory {
        id: e.id.clone(),
        content: e.value.clone(),
        scope,
        created_at: e.created.clone(),
        updated_at: e.updated.clone(),
        metadata,
    }
}

fn fact_to_persist(f: &Fact) -> PersistFact {
    PersistFact {
        id: f.id.clone(),
        content: f.content.clone(),
        kb_name: f.kb_name.clone(),
        scope: f.scope.to_string(),
        created: f.created_at.clone(),
    }
}

fn persist_to_fact(p: &PersistFact) -> Fact {
    Fact {
        id: p.id.clone(),
        content: p.content.clone(),
        kb_name: p.kb_name.clone(),
        scope: p.scope.parse().unwrap_or_default(),
        created_at: p.created.clone(),
    }
}

// ---------------------------------------------------------------------------
// TTL check
// ---------------------------------------------------------------------------

fn is_expired(metadata: &HashMap<String, Value>) -> bool {
    if let Some(Value::String(ttl)) = metadata.get("ttl") {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(ttl) {
            return expiry < chrono::Utc::now();
        }
        // Try ISO date without timezone
        if let Ok(expiry) = chrono::NaiveDateTime::parse_from_str(ttl, "%Y-%m-%dT%H:%M:%S") {
            return expiry < chrono::Utc::now().naive_utc();
        }
    }
    false
}

fn entry_is_expired(e: &PersistEntry) -> bool {
    if let Some(ref ttl) = e.ttl {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(ttl) {
            return expiry < chrono::Utc::now();
        }
        if let Ok(expiry) = chrono::NaiveDateTime::parse_from_str(ttl, "%Y-%m-%dT%H:%M:%S") {
            return expiry < chrono::Utc::now().naive_utc();
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

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
    /// Namespace (alias for scope)
    pub namespace: Option<String>,
    /// Key for key-based storage
    pub key: Option<String>,
    /// TTL as ISO date string
    pub ttl: Option<String>,
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
    /// Tag name for tag/untag
    pub tag: Option<String>,
    /// JSON data for import
    pub data: Option<String>,
    /// Description for kb create
    pub description: Option<String>,
    /// Sub-action for kb management
    pub sub_action: Option<String>,
}

// ---------------------------------------------------------------------------
// MemoryTool
// ---------------------------------------------------------------------------

/// Memory tool
pub struct MemoryTool {
    memories: Arc<RwLock<HashMap<String, Memory>>>,
    knowledge_bases: Arc<RwLock<HashMap<String, KnowledgeBase>>>,
    counter: Arc<RwLock<u64>>,
    fact_counter: Arc<RwLock<u64>>,
    history: Arc<RwLock<Vec<String>>>,
    loaded: Arc<RwLock<bool>>,
    storage_path: PathBuf,
}

impl MemoryTool {
    pub fn new() -> Self {
        Self::with_path(None)
    }

    /// Create with explicit storage path (useful for testing)
    pub fn with_path(path: Option<PathBuf>) -> Self {
        let storage_path = path.unwrap_or_else(|| {
            if let Ok(p) = std::env::var("MEMORY_PATH") {
                PathBuf::from(p)
            } else {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".hanzo")
                    .join("memory.json")
            }
        });

        let tool = Self {
            memories: Arc::new(RwLock::new(HashMap::new())),
            knowledge_bases: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(RwLock::new(0)),
            fact_counter: Arc::new(RwLock::new(0)),
            history: Arc::new(RwLock::new(Vec::new())),
            loaded: Arc::new(RwLock::new(false)),
            storage_path,
        };

        // Load is async so we can't do it in the constructor.
        // The first execute() call will trigger load if needed.
        tool
    }

    /// Load from disk. Called lazily on first execute.
    async fn ensure_loaded(&self) -> Result<()> {
        {
            let loaded = self.loaded.read().await;
            if *loaded {
                return Ok(());
            }
        }
        self.load_from_disk().await?;
        *self.loaded.write().await = true;
        Ok(())
    }

    async fn load_from_disk(&self) -> Result<()> {
        let store = match tokio::fs::read_to_string(&self.storage_path).await {
            Ok(data) => {
                serde_json::from_str::<PersistStore>(&data).unwrap_or_default()
            }
            Err(_) => PersistStore::default(),
        };

        let mut memories = self.memories.write().await;
        let mut kbs = self.knowledge_bases.write().await;
        let mut counter = self.counter.write().await;
        let mut fact_counter = self.fact_counter.write().await;

        memories.clear();
        kbs.clear();

        *counter = store.last_id;
        *fact_counter = store.last_fact_id;

        // Load entries, filtering expired
        for entry in &store.entries {
            if entry_is_expired(entry) {
                continue;
            }
            let memory = entry_to_memory(entry);
            memories.insert(memory.id.clone(), memory);
        }

        // Load KB metadata first (so empty KBs are preserved)
        for pkb in &store.knowledge_bases {
            kbs.entry(pkb.name.clone()).or_insert_with(|| KnowledgeBase {
                name: pkb.name.clone(),
                description: pkb.description.clone(),
                scope: pkb.scope.parse().unwrap_or_default(),
                facts: Vec::new(),
                created_at: pkb.created.clone(),
            });
        }

        // Load facts into knowledge bases
        for pf in &store.facts {
            let fact = persist_to_fact(pf);
            let kb = kbs.entry(fact.kb_name.clone()).or_insert_with(|| KnowledgeBase {
                name: fact.kb_name.clone(),
                description: None,
                scope: fact.scope.clone(),
                facts: Vec::new(),
                created_at: fact.created_at.clone(),
            });
            kb.facts.push(fact);
        }

        Ok(())
    }

    async fn save_to_disk(&self) -> Result<()> {
        let memories = self.memories.read().await;
        let kbs = self.knowledge_bases.read().await;
        let counter = self.counter.read().await;
        let fact_counter = self.fact_counter.read().await;

        // Build entries, filtering expired
        let entries: Vec<PersistEntry> = memories.values()
            .filter(|m| !is_expired(&m.metadata))
            .map(|m| memory_to_entry(m))
            .collect();

        // Build facts from knowledge bases
        let facts: Vec<PersistFact> = kbs.values()
            .flat_map(|kb| kb.facts.iter().map(|f| fact_to_persist(f)))
            .collect();

        // Build KB metadata
        let knowledge_bases: Vec<PersistKb> = kbs.values()
            .map(|kb| PersistKb {
                name: kb.name.clone(),
                description: kb.description.clone(),
                scope: kb.scope.to_string(),
                created: kb.created_at.clone(),
            })
            .collect();

        let store = PersistStore {
            entries,
            last_id: *counter,
            facts,
            last_fact_id: *fact_counter,
            knowledge_bases,
        };

        // Ensure parent directory exists
        if let Some(parent) = self.storage_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let json = serde_json::to_string_pretty(&store)?;
        tokio::fs::write(&self.storage_path, json).await?;
        Ok(())
    }

    async fn next_id(&self, prefix: &str) -> String {
        let mut counter = self.counter.write().await;
        *counter += 1;
        format!("{}_{}", prefix, *counter)
    }

    async fn next_fact_id(&self) -> String {
        let mut counter = self.fact_counter.write().await;
        *counter += 1;
        format!("fact_{}", *counter)
    }

    /// Resolve scope from args: namespace takes priority, then scope, then default
    fn resolve_scope(args: &MemoryToolArgs) -> (MemoryScope, Option<String>) {
        if let Some(ref ns) = args.namespace {
            match ns.as_str() {
                "default" => (MemoryScope::Project, None),
                "session" => (MemoryScope::Session, None),
                "global" => (MemoryScope::Global, None),
                other => (MemoryScope::Project, Some(other.to_string())),
            }
        } else if let Some(ref s) = args.scope {
            (s.parse().unwrap_or_default(), None)
        } else {
            (MemoryScope::Project, None)
        }
    }

    /// Build metadata including key, ttl, namespace overrides
    fn build_metadata(args: &MemoryToolArgs, custom_namespace: &Option<String>) -> HashMap<String, Value> {
        let mut metadata = args.metadata.clone().unwrap_or_default();
        if let Some(ref key) = args.key {
            metadata.insert("key".to_string(), json!(key));
        }
        if let Some(ref ttl) = args.ttl {
            metadata.insert("ttl".to_string(), json!(ttl));
        }
        if let Some(ref ns) = custom_namespace {
            metadata.insert("namespace".to_string(), json!(ns));
        }
        metadata
    }

    pub async fn execute(&self, args: MemoryToolArgs) -> Result<String> {
        // Ensure data is loaded from disk on first call
        self.ensure_loaded().await?;

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
            MemoryAction::Stats => self.stats(args).await?,
            MemoryAction::Clear => self.clear(args).await?,
            MemoryAction::Export => self.export_memories().await?,
            MemoryAction::Import => self.import_memories(args).await?,
            MemoryAction::Merge => self.merge_memories().await?,
            MemoryAction::Tag => self.tag_memory(args).await?,
            MemoryAction::Untag => self.untag_memory(args).await?,
            MemoryAction::Namespaces => self.namespaces().await?,
            MemoryAction::History => self.history_log().await?,
            MemoryAction::Kb => self.kb(args).await?,
            MemoryAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------

    async fn recall(&self, args: MemoryToolArgs) -> Result<Value> {
        let queries = args.queries.clone()
            .or_else(|| args.query.clone().map(|q| vec![q]))
            .unwrap_or_default();
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let limit = args.limit.unwrap_or(10);

        let memories = self.memories.read().await;
        let mut results = Vec::new();

        // Key-based recall: if key is provided, filter by key
        if let Some(ref key) = args.key {
            let matches: Vec<&Memory> = memories.values()
                .filter(|m| {
                    !is_expired(&m.metadata)
                        && m.metadata.get("key").and_then(|v| v.as_str()) == Some(key.as_str())
                        && Self::matches_scope_and_ns(m, &scope, &custom_ns)
                })
                .take(limit)
                .collect();

            for m in matches {
                results.push(memory_to_json(m));
            }

            return Ok(json!({
                "key": key,
                "scope": scope.to_string(),
                "results": results,
                "count": results.len()
            }));
        }

        // Query-based recall
        if queries.is_empty() {
            // No queries and no key — return recent memories in scope
            let matches: Vec<&Memory> = memories.values()
                .filter(|m| {
                    !is_expired(&m.metadata)
                        && Self::matches_scope_and_ns(m, &scope, &custom_ns)
                })
                .take(limit)
                .collect();
            for m in matches {
                results.push(memory_to_json(m));
            }
        } else {
            for query in &queries {
                let query_lower = query.to_lowercase();
                let terms: Vec<&str> = query_lower.split_whitespace().collect();
                let matches: Vec<&Memory> = memories.values()
                    .filter(|m| {
                        if is_expired(&m.metadata) { return false; }
                        if !Self::matches_scope_and_ns(m, &scope, &custom_ns) { return false; }
                        let text = m.content.to_lowercase();
                        terms.iter().all(|t| text.contains(t))
                    })
                    .take(limit)
                    .collect();

                for m in matches {
                    results.push(memory_to_json(m));
                }
            }
        }

        Ok(json!({
            "queries": queries,
            "scope": scope.to_string(),
            "results": results,
            "count": results.len()
        }))
    }

    async fn create(&self, args: MemoryToolArgs) -> Result<Value> {
        let statements = args.statements.clone()
            .or_else(|| args.statement.clone().map(|s| vec![s]))
            .or_else(|| args.content.clone().map(|c| vec![c]))
            .ok_or_else(|| anyhow!("statements required"))?;
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let metadata = Self::build_metadata(&args, &custom_ns);
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
                metadata: metadata.clone(),
            };
            memories.insert(id.clone(), memory);
            created_ids.push(id);
        }

        drop(memories);
        self.save_to_disk().await?;
        self.record_history(&format!("create: {} memories", created_ids.len())).await;

        Ok(json!({
            "created": created_ids.len(),
            "ids": created_ids,
            "scope": scope.to_string()
        }))
    }

    async fn update(&self, args: MemoryToolArgs) -> Result<Value> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut updated_ids = Vec::new();

        // Single update by id + content/statement
        if let Some(ref id) = args.id {
            let new_content = args.statement.as_deref()
                .or(args.content.as_deref());
            if let Some(content) = new_content {
                let mut memories = self.memories.write().await;
                if let Some(memory) = memories.get_mut(id.as_str()) {
                    memory.content = content.to_string();
                    memory.updated_at = now.clone();
                    if let Some(ref ttl) = args.ttl {
                        memory.metadata.insert("ttl".to_string(), json!(ttl));
                    }
                    if let Some(ref key) = args.key {
                        memory.metadata.insert("key".to_string(), json!(key));
                    }
                    updated_ids.push(id.clone());
                }
                drop(memories);
                if !updated_ids.is_empty() {
                    self.save_to_disk().await?;
                }
                return Ok(json!({ "updated": updated_ids.len(), "ids": updated_ids }));
            }
        }

        // Batch updates
        let updates = args.updates.ok_or_else(|| anyhow!("updates or (id + statement) required"))?;
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

        drop(memories);
        if !updated_ids.is_empty() {
            self.save_to_disk().await?;
        }
        self.record_history(&format!("update: {} memories", updated_ids.len())).await;

        Ok(json!({
            "updated": updated_ids.len(),
            "ids": updated_ids
        }))
    }

    async fn delete(&self, args: MemoryToolArgs) -> Result<Value> {
        let mut ids_to_delete = args.ids.clone()
            .or_else(|| args.id.clone().map(|id| vec![id]))
            .unwrap_or_default();

        // Delete by key
        if ids_to_delete.is_empty() {
            if let Some(ref key) = args.key {
                let memories = self.memories.read().await;
                ids_to_delete = memories.values()
                    .filter(|m| m.metadata.get("key").and_then(|v| v.as_str()) == Some(key.as_str()))
                    .map(|m| m.id.clone())
                    .collect();
            }
        }

        if ids_to_delete.is_empty() {
            return Err(anyhow!("ids, id, or key required"));
        }

        let mut deleted_ids = Vec::new();
        let mut memories = self.memories.write().await;

        for id in ids_to_delete {
            if memories.remove(&id).is_some() {
                deleted_ids.push(id);
            }
        }

        drop(memories);
        if !deleted_ids.is_empty() {
            self.save_to_disk().await?;
        }
        self.record_history(&format!("delete: {} memories", deleted_ids.len())).await;

        Ok(json!({
            "deleted": deleted_ids.len(),
            "ids": deleted_ids
        }))
    }

    async fn manage(&self, args: MemoryToolArgs) -> Result<Value> {
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let metadata = Self::build_metadata(&args, &custom_ns);
        let now = chrono::Utc::now().to_rfc3339();

        let mut created_ids = Vec::new();
        let mut updated_ids = Vec::new();
        let mut deleted_ids = Vec::new();

        // Handle creations
        if let Some(creations) = args.creations.clone() {
            let mut memories = self.memories.write().await;
            for statement in creations {
                let id = self.next_id("mem").await;
                let memory = Memory {
                    id: id.clone(),
                    content: statement,
                    scope: scope.clone(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    metadata: metadata.clone(),
                };
                memories.insert(id.clone(), memory);
                created_ids.push(id);
            }
        }

        // Handle updates
        if let Some(updates) = args.updates.clone() {
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
        if let Some(deletions) = args.deletions.clone() {
            let mut memories = self.memories.write().await;
            for id in deletions {
                if memories.remove(&id).is_some() {
                    deleted_ids.push(id);
                }
            }
        }

        let mutated = !created_ids.is_empty() || !updated_ids.is_empty() || !deleted_ids.is_empty();
        if mutated {
            self.save_to_disk().await?;
        }

        Ok(json!({
            "created": created_ids,
            "updated": updated_ids,
            "deleted": deleted_ids,
            "scope": scope.to_string()
        }))
    }

    async fn facts(&self, args: MemoryToolArgs) -> Result<Value> {
        let kb_name = args.kb_name.clone().unwrap_or_else(|| "general".to_string());
        let (scope, _custom_ns) = Self::resolve_scope(&args);
        let now = chrono::Utc::now().to_rfc3339();

        if let Some(new_facts) = args.facts.clone() {
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
                let id = self.next_fact_id().await;
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

            drop(kbs);
            self.save_to_disk().await?;

            return Ok(json!({
                "stored": created_ids.len(),
                "ids": created_ids,
                "kb_name": kb_name
            }));
        }

        // Recall facts
        if let Some(queries) = args.queries.clone().or_else(|| args.query.clone().map(|q| vec![q])) {
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
                "scope": kb.scope.to_string()
            }))
            .collect();

        Ok(json!({
            "knowledge_bases": kb_list,
            "count": kb_list.len()
        }))
    }

    async fn summarize(&self, args: MemoryToolArgs) -> Result<Value> {
        let content = args.content.clone().ok_or_else(|| anyhow!("content required"))?;
        let topic = args.topic.clone().ok_or_else(|| anyhow!("topic required"))?;
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let now = chrono::Utc::now().to_rfc3339();

        // Create memory from summary
        let id = self.next_id("mem").await;
        let summary = format!("[{}] {}", topic, content);
        let mut metadata = Self::build_metadata(&args, &custom_ns);
        metadata.insert("topic".to_string(), json!(topic));
        metadata.insert("type".to_string(), json!("summary"));

        let memory = Memory {
            id: id.clone(),
            content: summary.clone(),
            scope,
            created_at: now.clone(),
            updated_at: now,
            metadata,
        };

        self.memories.write().await.insert(id.clone(), memory);
        self.save_to_disk().await?;

        // Extract key facts (simplified)
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
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let has_scope_filter = args.scope.is_some() || args.namespace.is_some();
        let limit = args.limit.unwrap_or(50);

        let memories = self.memories.read().await;
        let results: Vec<Value> = memories.values()
            .filter(|m| {
                if is_expired(&m.metadata) { return false; }
                if has_scope_filter {
                    Self::matches_scope_and_ns(m, &scope, &custom_ns)
                } else {
                    true
                }
            })
            .take(limit)
            .map(|m| memory_to_json(m))
            .collect();

        Ok(json!({
            "memories": results,
            "count": results.len(),
            "total": memories.len()
        }))
    }

    async fn record_history(&self, entry: &str) {
        let mut history = self.history.write().await;
        history.push(format!("[{}] {}", chrono::Utc::now().to_rfc3339(), entry));
        if history.len() > 1000 { history.drain(0..500); }
    }

    async fn stats(&self, _args: MemoryToolArgs) -> Result<Value> {
        let memories = self.memories.read().await;
        let kbs = self.knowledge_bases.read().await;
        let mut by_scope: HashMap<String, usize> = HashMap::new();
        let mut by_namespace: HashMap<String, usize> = HashMap::new();
        let mut total_size = 0usize;
        for m in memories.values() {
            if is_expired(&m.metadata) { continue; }
            let scope_key = m.scope.to_string();
            *by_scope.entry(scope_key).or_insert(0) += 1;
            let ns = scope_to_namespace(&m.scope, &m.metadata);
            *by_namespace.entry(ns).or_insert(0) += 1;
            total_size += m.content.len();
        }
        Ok(json!({
            "total_memories": memories.len(),
            "total_size_bytes": total_size,
            "by_scope": by_scope,
            "by_namespace": by_namespace,
            "knowledge_bases": kbs.len(),
            "total_facts": kbs.values().map(|kb| kb.facts.len()).sum::<usize>(),
            "storage_path": self.storage_path.to_string_lossy()
        }))
    }

    async fn clear(&self, args: MemoryToolArgs) -> Result<Value> {
        let (scope, custom_ns) = Self::resolve_scope(&args);
        let has_scope_filter = args.scope.is_some() || args.namespace.is_some();
        let mut memories = self.memories.write().await;
        let before = memories.len();
        if has_scope_filter {
            memories.retain(|_, m| !Self::matches_scope_and_ns(m, &scope, &custom_ns));
        } else {
            memories.clear();
        }
        let cleared = before - memories.len();
        drop(memories);
        self.save_to_disk().await?;
        self.record_history(&format!("clear: removed {} memories", cleared)).await;
        Ok(json!({ "cleared": cleared, "remaining": before - cleared }))
    }

    async fn export_memories(&self) -> Result<Value> {
        let memories = self.memories.read().await;
        let kbs = self.knowledge_bases.read().await;
        let mem_list: Vec<Value> = memories.values()
            .filter(|m| !is_expired(&m.metadata))
            .map(|m| memory_to_json(m))
            .collect();
        let kb_list: Vec<Value> = kbs.values().map(|kb| json!({
            "name": kb.name, "fact_count": kb.facts.len(),
            "scope": kb.scope.to_string()
        })).collect();
        Ok(json!({
            "memories": mem_list,
            "knowledge_bases": kb_list,
            "count": mem_list.len(),
            "storage_path": self.storage_path.to_string_lossy()
        }))
    }

    async fn import_memories(&self, args: MemoryToolArgs) -> Result<Value> {
        let data = args.data.clone().ok_or_else(|| anyhow!("data (JSON string) required"))?;
        let parsed: Value = serde_json::from_str(&data)?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut imported = 0;
        let mut memories = self.memories.write().await;
        if let Some(items) = parsed.get("memories").and_then(|v| v.as_array()) {
            for item in items {
                let id = self.next_id("mem").await;
                let content = item.get("content").and_then(|v| v.as_str())
                    .or_else(|| item.get("value").and_then(|v| v.as_str()))
                    .unwrap_or("").to_string();
                let scope: MemoryScope = item.get("scope").and_then(|v| v.as_str())
                    .unwrap_or("project").parse()?;
                let mut metadata = HashMap::new();
                if let Some(key) = item.get("key").and_then(|v| v.as_str()) {
                    metadata.insert("key".to_string(), json!(key));
                }
                let memory = Memory {
                    id: id.clone(), content, scope,
                    created_at: now.clone(), updated_at: now.clone(),
                    metadata,
                };
                memories.insert(id, memory);
                imported += 1;
            }
        }
        // Also import from "entries" key (TypeScript format)
        if let Some(items) = parsed.get("entries").and_then(|v| v.as_array()) {
            for item in items {
                if let Ok(entry) = serde_json::from_value::<PersistEntry>(item.clone()) {
                    if entry_is_expired(&entry) { continue; }
                    let memory = entry_to_memory(&entry);
                    let id = self.next_id("mem").await;
                    let mut m = memory;
                    m.id = id.clone();
                    memories.insert(id, m);
                    imported += 1;
                }
            }
        }
        drop(memories);
        self.save_to_disk().await?;
        self.record_history(&format!("import: {} memories", imported)).await;
        Ok(json!({ "imported": imported }))
    }

    async fn merge_memories(&self) -> Result<Value> {
        let mut memories = self.memories.write().await;
        let ids: Vec<String> = memories.keys().cloned().collect();
        let mut merged = 0;
        let mut to_remove = Vec::new();
        for i in 0..ids.len() {
            for j in (i+1)..ids.len() {
                if to_remove.contains(&ids[j]) { continue; }
                let a = memories.get(&ids[i]).map(|m| m.content.clone());
                let b = memories.get(&ids[j]).map(|m| m.content.clone());
                if let (Some(a), Some(b)) = (a, b) {
                    if a == b {
                        to_remove.push(ids[j].clone());
                        merged += 1;
                    }
                }
            }
        }
        for id in &to_remove { memories.remove(id); }
        drop(memories);
        if merged > 0 {
            self.save_to_disk().await?;
        }
        self.record_history(&format!("merge: removed {} duplicates", merged)).await;
        Ok(json!({ "merged": merged, "removed_ids": to_remove }))
    }

    async fn tag_memory(&self, args: MemoryToolArgs) -> Result<Value> {
        let id = args.id.clone().ok_or_else(|| anyhow!("id required"))?;
        let tag = args.tag.clone().ok_or_else(|| anyhow!("tag required"))?;
        let mut memories = self.memories.write().await;
        let memory = memories.get_mut(&id).ok_or_else(|| anyhow!("Memory not found: {}", id))?;
        memory.metadata.insert(format!("tag:{}", tag), json!(true));
        drop(memories);
        self.save_to_disk().await?;
        self.record_history(&format!("tag: {} += {}", id, tag)).await;
        Ok(json!({ "id": id, "tag": tag, "tagged": true }))
    }

    async fn untag_memory(&self, args: MemoryToolArgs) -> Result<Value> {
        let id = args.id.clone().ok_or_else(|| anyhow!("id required"))?;
        let tag = args.tag.clone().ok_or_else(|| anyhow!("tag required"))?;
        let mut memories = self.memories.write().await;
        let memory = memories.get_mut(&id).ok_or_else(|| anyhow!("Memory not found: {}", id))?;
        memory.metadata.remove(&format!("tag:{}", tag));
        drop(memories);
        self.save_to_disk().await?;
        self.record_history(&format!("untag: {} -= {}", id, tag)).await;
        Ok(json!({ "id": id, "tag": tag, "untagged": true }))
    }

    async fn namespaces(&self) -> Result<Value> {
        let memories = self.memories.read().await;
        let mut ns_counts: HashMap<String, usize> = HashMap::new();
        for m in memories.values() {
            if is_expired(&m.metadata) { continue; }
            let ns = scope_to_namespace(&m.scope, &m.metadata);
            *ns_counts.entry(ns).or_insert(0) += 1;
        }
        // Also include knowledge base names
        let kbs = self.knowledge_bases.read().await;
        let kb_names: Vec<String> = kbs.keys().cloned().collect();

        Ok(json!({
            "namespaces": ns_counts,
            "knowledge_bases": kb_names,
            "count": ns_counts.len()
        }))
    }

    async fn history_log(&self) -> Result<Value> {
        let history = self.history.read().await;
        let entries: Vec<&String> = history.iter().rev().take(50).collect();
        Ok(json!({ "history": entries, "count": entries.len() }))
    }

    async fn kb(&self, args: MemoryToolArgs) -> Result<Value> {
        let sub = args.sub_action.as_deref()
            .or(args.query.as_deref())
            .unwrap_or("list");

        match sub {
            "create" => {
                let name = args.kb_name.clone()
                    .ok_or_else(|| anyhow!("kb_name required for kb create"))?;
                let (scope, _) = Self::resolve_scope(&args);
                let now = chrono::Utc::now().to_rfc3339();
                let mut kbs = self.knowledge_bases.write().await;
                if kbs.contains_key(&name) {
                    return Ok(json!({ "error": format!("Knowledge base '{}' already exists", name) }));
                }
                kbs.insert(name.clone(), KnowledgeBase {
                    name: name.clone(),
                    description: args.description.clone(),
                    scope,
                    facts: Vec::new(),
                    created_at: now,
                });
                drop(kbs);
                self.save_to_disk().await?;
                Ok(json!({ "created": name, "description": args.description }))
            }
            "delete" => {
                let name = args.kb_name.clone()
                    .ok_or_else(|| anyhow!("kb_name required for kb delete"))?;
                let mut kbs = self.knowledge_bases.write().await;
                if kbs.remove(&name).is_some() {
                    drop(kbs);
                    self.save_to_disk().await?;
                    Ok(json!({ "deleted": name }))
                } else {
                    Ok(json!({ "error": format!("Knowledge base '{}' not found", name) }))
                }
            }
            "list" | _ => {
                let kbs = self.knowledge_bases.read().await;
                let list: Vec<Value> = kbs.values().map(|kb| json!({
                    "name": kb.name,
                    "description": kb.description,
                    "fact_count": kb.facts.len(),
                    "scope": kb.scope.to_string(),
                    "created_at": kb.created_at
                })).collect();
                Ok(json!({ "knowledge_bases": list, "count": list.len() }))
            }
        }
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "memory",
            "version": "0.13.0",
            "description": "Persistent memory and knowledge management tool (HIP-0300). Data persisted to ~/.hanzo/memory.json, compatible with TypeScript runtime.",
            "actions": {
                "recall": {
                    "description": "Search memories by query or key",
                    "params": ["queries|query", "key", "scope|namespace", "limit"]
                },
                "create": {
                    "description": "Store new memories",
                    "params": ["statements|statement|content", "scope|namespace", "key", "ttl", "metadata"]
                },
                "update": {
                    "description": "Update existing memories",
                    "params": ["id + statement|content", "updates[]", "key", "ttl"]
                },
                "delete": {
                    "description": "Remove memories by id, ids, or key",
                    "params": ["id|ids|key"]
                },
                "manage": {
                    "description": "Atomic create/update/delete in one call",
                    "params": ["creations[]", "updates[]", "deletions[]", "scope|namespace", "key", "ttl"]
                },
                "facts": {
                    "description": "Store/recall knowledge base facts",
                    "params": ["kb_name", "facts[]", "queries|query", "scope", "limit"]
                },
                "summarize": {
                    "description": "Summarize content and store as memory",
                    "params": ["content", "topic", "scope|namespace"]
                },
                "list": {
                    "description": "List all memories, optionally filtered by scope/namespace",
                    "params": ["scope|namespace", "limit"]
                },
                "stats": {
                    "description": "Memory statistics by scope and namespace",
                    "params": []
                },
                "clear": {
                    "description": "Clear memories (optional scope/namespace filter)",
                    "params": ["scope|namespace"]
                },
                "export": {
                    "description": "Export all memories as JSON",
                    "params": []
                },
                "import": {
                    "description": "Import memories from JSON data string",
                    "params": ["data"]
                },
                "merge": {
                    "description": "Remove duplicate memories",
                    "params": []
                },
                "tag": {
                    "description": "Add tag to a memory",
                    "params": ["id", "tag"]
                },
                "untag": {
                    "description": "Remove tag from a memory",
                    "params": ["id", "tag"]
                },
                "namespaces": {
                    "description": "List all namespaces with entry counts",
                    "params": []
                },
                "history": {
                    "description": "Recent operation history",
                    "params": []
                },
                "kb": {
                    "description": "Knowledge base management (create/list/delete)",
                    "params": ["sub_action (create|list|delete)", "kb_name", "description"]
                },
                "help": {
                    "description": "Show this documentation",
                    "params": []
                }
            },
            "scopes": ["session", "project", "global"],
            "namespace_mapping": {
                "default": "project scope",
                "session": "session scope",
                "global": "global scope",
                "<custom>": "project scope with namespace stored in metadata"
            },
            "persistence": "~/.hanzo/memory.json (auto-loaded, saved after every mutation)"
        }))
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn matches_scope_and_ns(m: &Memory, scope: &MemoryScope, custom_ns: &Option<String>) -> bool {
        if m.scope != *scope {
            return false;
        }
        if let Some(ref ns) = custom_ns {
            // Must match the custom namespace in metadata
            m.metadata.get("namespace")
                .and_then(|v| v.as_str())
                .map_or(false, |v| v == ns.as_str())
        } else {
            // Standard scope — should NOT have a custom namespace
            !m.metadata.contains_key("namespace")
        }
    }
}

fn memory_to_json(m: &Memory) -> Value {
    let ns = scope_to_namespace(&m.scope, &m.metadata);
    let key = m.metadata.get("key").and_then(|v| v.as_str()).unwrap_or(&m.id);
    let tags: Vec<String> = m.metadata.keys()
        .filter(|k| k.starts_with("tag:"))
        .map(|k| k.strip_prefix("tag:").unwrap().to_string())
        .collect();

    json!({
        "id": m.id,
        "key": key,
        "content": m.content,
        "scope": m.scope.to_string(),
        "namespace": ns,
        "tags": tags,
        "created_at": m.created_at,
        "updated_at": m.updated_at,
        "metadata": m.metadata
    })
}

// ---------------------------------------------------------------------------
// MCP Tool Definition
// ---------------------------------------------------------------------------

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
            description: r#"Persistent memory and knowledge management tool (HIP-0300).
Data persisted to ~/.hanzo/memory.json (cross-runtime compatible).

Actions:
- recall: Search memories by query or key
- create: Store new memories (with optional key, ttl, namespace)
- update: Update existing memories
- delete: Remove memories by id or key
- manage: Atomic create/update/delete
- facts: Manage knowledge base facts
- summarize: Summarize and store information
- list: List all memories
- stats: Memory statistics
- kb: Knowledge base management (create/list/delete)
- help: Show all actions and parameters

Scopes: session, project, global
Namespaces: alias for scope — "default"->project, "session"->session, "global"->global, custom->project+metadata"#.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["recall", "create", "update", "delete", "manage", "facts", "summarize", "list", "stats", "clear", "export", "import", "merge", "tag", "untag", "namespaces", "history", "kb", "help"]
                    },
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "query": {"type": "string"},
                    "statements": {"type": "array", "items": {"type": "string"}},
                    "statement": {"type": "string"},
                    "id": {"type": "string"},
                    "ids": {"type": "array", "items": {"type": "string"}},
                    "updates": {"type": "array", "items": {"type": "object"}},
                    "scope": {"type": "string", "enum": ["session", "project", "global"]},
                    "namespace": {"type": "string", "description": "Namespace alias for scope. 'default'->project, 'session'->session, 'global'->global, custom->project with namespace in metadata"},
                    "key": {"type": "string", "description": "Key for key-based storage and recall"},
                    "ttl": {"type": "string", "description": "Expiry as ISO date string (e.g. 2026-03-25T00:00:00Z)"},
                    "limit": {"type": "integer"},
                    "kb_name": {"type": "string"},
                    "facts": {"type": "array", "items": {"type": "string"}},
                    "content": {"type": "string"},
                    "topic": {"type": "string"},
                    "metadata": {"type": "object"},
                    "creations": {"type": "array", "items": {"type": "string"}},
                    "deletions": {"type": "array", "items": {"type": "string"}},
                    "tag": {"type": "string", "description": "Tag name for tag/untag"},
                    "data": {"type": "string", "description": "JSON data for import"},
                    "description": {"type": "string", "description": "Description for kb create"},
                    "sub_action": {"type": "string", "description": "Sub-action for kb (create|list|delete)"}
                }
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn test_tool() -> (MemoryTool, NamedTempFile) {
        let tmp = NamedTempFile::new().unwrap();
        let tool = MemoryTool::with_path(Some(tmp.path().to_path_buf()));
        (tool, tmp)
    }

    #[tokio::test]
    async fn test_create_memory() {
        let (tool, _tmp) = test_tool();
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
        let (tool, _tmp) = test_tool();

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
        let (tool, _tmp) = test_tool();
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
        let (tool, _tmp) = test_tool();
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

    #[tokio::test]
    async fn test_persistence_survives_reload() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();

        // Create with first tool instance
        {
            let tool = MemoryTool::with_path(Some(path.clone()));
            let args = MemoryToolArgs {
                action: "create".to_string(),
                statements: Some(vec!["Persistent memory test".to_string()]),
                key: Some("test-key".to_string()),
                ..Default::default()
            };
            tool.execute(args).await.unwrap();
        }

        // Read with second tool instance (simulating restart)
        {
            let tool = MemoryTool::with_path(Some(path.clone()));
            let args = MemoryToolArgs {
                action: "recall".to_string(),
                key: Some("test-key".to_string()),
                ..Default::default()
            };
            let result = tool.execute(args).await.unwrap();
            assert!(result.contains("Persistent memory test"), "Memory should survive restart: {}", result);
        }
    }

    #[tokio::test]
    async fn test_key_based_storage_and_recall() {
        let (tool, _tmp) = test_tool();

        // Create with key
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Blue agent report for task 42".to_string()]),
            key: Some("blue-report-42".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Recall by key
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            key: Some("blue-report-42".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("Blue agent report"), "Key recall should work: {}", result);
    }

    #[tokio::test]
    async fn test_namespace_support() {
        let (tool, _tmp) = test_tool();

        // Create with custom namespace
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Blue-red coordination data".to_string()]),
            namespace: Some("blue-red".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Recall with same namespace
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            queries: Some(vec!["coordination".to_string()]),
            namespace: Some("blue-red".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("coordination"), "Namespace recall should work: {}", result);

        // Recall with different namespace should NOT find it
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            queries: Some(vec!["coordination".to_string()]),
            namespace: Some("other".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["count"], 0, "Different namespace should not find memory");
    }

    #[tokio::test]
    async fn test_ttl_expiry() {
        let (tool, _tmp) = test_tool();

        // Create with expired TTL
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Should be expired".to_string()]),
            ttl: Some("2020-01-01T00:00:00Z".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Create with future TTL
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Should be visible".to_string()]),
            ttl: Some("2099-01-01T00:00:00Z".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // List should only show non-expired
        let args = MemoryToolArgs {
            action: "list".to_string(),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("Should be visible"), "Non-expired should be visible");
        assert!(!result.contains("Should be expired"), "Expired should be filtered: {}", result);
    }

    #[tokio::test]
    async fn test_kb_management() {
        let (tool, _tmp) = test_tool();

        // Create KB
        let args = MemoryToolArgs {
            action: "kb".to_string(),
            sub_action: Some("create".to_string()),
            kb_name: Some("test-kb".to_string()),
            description: Some("Test knowledge base".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("test-kb"), "KB should be created: {}", result);

        // List KBs
        let args = MemoryToolArgs {
            action: "kb".to_string(),
            sub_action: Some("list".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("test-kb"), "KB should be listed: {}", result);

        // Delete KB
        let args = MemoryToolArgs {
            action: "kb".to_string(),
            sub_action: Some("delete".to_string()),
            kb_name: Some("test-kb".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("test-kb"), "KB should be deleted: {}", result);

        // Verify deleted
        let args = MemoryToolArgs {
            action: "kb".to_string(),
            sub_action: Some("list".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["count"], 0, "KB list should be empty after delete");
    }

    #[tokio::test]
    async fn test_help_action() {
        let (tool, _tmp) = test_tool();
        let args = MemoryToolArgs {
            action: "help".to_string(),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("recall"));
        assert!(result.contains("create"));
        assert!(result.contains("kb"));
        assert!(result.contains("persistence"));
    }

    #[tokio::test]
    async fn test_delete_by_key() {
        let (tool, _tmp) = test_tool();

        // Create with key
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Deletable memory".to_string()]),
            key: Some("delete-me".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Delete by key
        let args = MemoryToolArgs {
            action: "delete".to_string(),
            key: Some("delete-me".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("\"deleted\":1"), "Should delete by key: {}", result);

        // Verify gone
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            key: Some("delete-me".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["count"], 0, "Deleted memory should not be found");
    }

    #[tokio::test]
    async fn test_json_format_compatibility() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();

        // Create with Rust tool
        {
            let tool = MemoryTool::with_path(Some(path.clone()));
            let args = MemoryToolArgs {
                action: "create".to_string(),
                statements: Some(vec!["Cross-runtime test".to_string()]),
                key: Some("compat-key".to_string()),
                namespace: Some("blue-red".to_string()),
                ..Default::default()
            };
            tool.execute(args).await.unwrap();
        }

        // Read raw JSON and verify TypeScript-compatible format
        let data = tokio::fs::read_to_string(&path).await.unwrap();
        let store: Value = serde_json::from_str(&data).unwrap();

        assert!(store.get("entries").is_some(), "Should have entries key");
        assert!(store.get("lastId").is_some(), "Should have lastId key");
        assert!(store.get("facts").is_some(), "Should have facts key");
        assert!(store.get("lastFactId").is_some(), "Should have lastFactId key");

        let entry = &store["entries"][0];
        assert!(entry.get("key").is_some(), "Entry should have key");
        assert!(entry.get("value").is_some(), "Entry should have value");
        assert!(entry.get("namespace").is_some(), "Entry should have namespace");
        assert!(entry.get("tags").is_some(), "Entry should have tags");
        assert!(entry.get("created").is_some(), "Entry should have created");
        assert!(entry.get("updated").is_some(), "Entry should have updated");

        assert_eq!(entry["key"], "compat-key");
        assert_eq!(entry["value"], "Cross-runtime test");
        assert_eq!(entry["namespace"], "blue-red");
    }

    #[tokio::test]
    async fn test_namespace_default_maps_to_project() {
        let (tool, _tmp) = test_tool();

        // Create with namespace "default" (should map to Project scope)
        let args = MemoryToolArgs {
            action: "create".to_string(),
            statements: Some(vec!["Default namespace test".to_string()]),
            namespace: Some("default".to_string()),
            ..Default::default()
        };
        tool.execute(args).await.unwrap();

        // Recall with scope "project" should find it
        let args = MemoryToolArgs {
            action: "recall".to_string(),
            queries: Some(vec!["Default namespace".to_string()]),
            scope: Some("project".to_string()),
            ..Default::default()
        };
        let result = tool.execute(args).await.unwrap();
        assert!(result.contains("Default namespace test"), "default namespace should map to project scope: {}", result);
    }

    #[tokio::test]
    async fn test_persistence_with_facts() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();

        // Store facts with first instance
        {
            let tool = MemoryTool::with_path(Some(path.clone()));
            let args = MemoryToolArgs {
                action: "facts".to_string(),
                kb_name: Some("coding".to_string()),
                facts: Some(vec!["Always use uv for Python".to_string()]),
                ..Default::default()
            };
            tool.execute(args).await.unwrap();
        }

        // Load with second instance and query
        {
            let tool = MemoryTool::with_path(Some(path.clone()));
            let args = MemoryToolArgs {
                action: "facts".to_string(),
                kb_name: Some("coding".to_string()),
                query: Some("uv".to_string()),
                ..Default::default()
            };
            let result = tool.execute(args).await.unwrap();
            assert!(result.contains("Always use uv"), "Facts should survive restart: {}", result);
        }
    }
}
