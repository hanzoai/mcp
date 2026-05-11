//! BrainStore trait — pluggable memory contract.
//!
//! Identical surface to the TS `BrainStore` interface and the Python
//! `BaseVectorDB` so a single `~/.hanzo/brain/brain.db` is consumed
//! interchangeably across all three runtimes.
//!
//! Reference impl (`SqliteStore`) shipped as a separate crate
//! `hanzo-brain-sqlite` to keep this trait crate dep-free.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::graph_links::Edge;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub backend: Option<String>,    // default "sqlite"
    pub data_dir: Option<String>,   // default ~/.hanzo/brain
    pub db_path: Option<String>,    // explicit file; overrides data_dir
    pub embedding_model: Option<String>,
    pub embedding_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub id: Option<String>,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub source: Option<String>,
    pub ts: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub slug: String,
    pub excerpt: String,
    pub score: f64,
    pub source: String, // "vector" | "keyword" | "fused"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    pub slug: String,
    pub content: String,
    pub updated_at: String,
}

#[async_trait]
pub trait BrainStore: Send + Sync {
    async fn init(&self) -> anyhow::Result<()>;
    async fn upsert_page(
        &self,
        slug: &str,
        content: &str,
        frontmatter: Option<&serde_json::Value>,
    ) -> anyhow::Result<()>;
    async fn get_page(&self, slug: &str) -> anyhow::Result<Option<Page>>;
    async fn upsert_edges(&self, source: &str, edges: &[Edge]) -> anyhow::Result<()>;
    async fn edges_for(&self, slug: &str, dir: EdgeDir) -> anyhow::Result<Vec<Edge>>;
    async fn upsert_fact(&self, fact: &Fact) -> anyhow::Result<()>;
    async fn recall(
        &self,
        entity: &str,
        limit: Option<usize>,
        since: Option<&str>,
    ) -> anyhow::Result<Vec<Fact>>;
    async fn hybrid_search(&self, query: &str, top_k: usize) -> anyhow::Result<Vec<SearchHit>>;
    async fn close(&self) -> anyhow::Result<()>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum EdgeDir {
    In,
    Out,
    Both,
}
