//! Hanzo Brain — Rust crate scaffold.
//!
//! Mirrors the TS (`bot/extensions/{memory,graph-links,recipes-brain}`)
//! and Python (`python-sdk/pkg/hanzo-memory/src/hanzo_memory/{graph_links,recipes}.py`)
//! implementations so a single `~/.hanzo/brain/brain.db` is read/written
//! by all three runtimes interchangeably.
//!
//! Schema:
//!   pages (slug, content, frontmatter, updated_at) + FTS5 mirror
//!   edges (source, target, type, evidence) PK (source, target, type)
//!   facts (id, subject, predicate, object, source, ts, confidence)
//!
//! Pluggable: implement the `BrainStore` trait against any store
//! (sqlite / qdrant / meilisearch / zapdb / postgres / …) and register
//! via `register_backend(name, factory)`. The canonical native store
//! is `zapdb` (`zap-proto/db`, ZAP-native, multi-language). `luxfi/database`
//! is the Lux-flavored extension of zapdb for blockchain workloads, not
//! a generic brain backend.

pub mod algorithms;
pub mod graph_links;
pub mod recipes;
pub mod store;

pub use algorithms::*;
pub use graph_links::{extract_edges, reconcile, slugify, Edge, EdgeType};
pub use recipes::{list_recipes, load_recipe, Recipe};
pub use store::{BrainStore, Fact, MemoryConfig, SearchHit};
