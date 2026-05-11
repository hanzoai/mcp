//! Recipe loader — Rust port of `@hanzo/bot-recipes-brain`.
//!
//! Reads YAML recipes from `<crate_dir>/recipes/*.yaml` plus any user
//! directory in `HANZO_BRAIN_RECIPES`. Same shape as the TS and Python
//! ports so a single recipe file works across all three runtimes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub recipe: String,
    pub version: u32,
    pub backend: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

fn recipe_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Built-in recipes ship alongside the bot extension; the crate-local
    // copy lives at compile time via include_str! when needed. For
    // runtime discovery, look at the bot extension dir if HANZO_HOME is
    // set, plus any user dir.
    if let Ok(home) = std::env::var("HANZO_HOME") {
        let p = PathBuf::from(home).join("recipes");
        if p.is_dir() {
            out.push(p);
        }
    }
    if let Ok(p) = std::env::var("HANZO_BRAIN_RECIPES") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            out.push(pb);
        }
    }
    out
}

pub fn list_recipes() -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for dir in recipe_dirs() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if seen.insert(stem.to_string()) {
                            out.push(stem.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

pub fn load_recipe(name: &str) -> anyhow::Result<Recipe> {
    for dir in recipe_dirs() {
        let path = dir.join(format!("{}.yaml", name));
        if path.is_file() {
            let raw = std::fs::read_to_string(&path)?;
            let recipe: Recipe = serde_yaml::from_str(&raw)?;
            return Ok(recipe);
        }
    }
    anyhow::bail!(
        "recipe `{}` not found. Set HANZO_HOME or HANZO_BRAIN_RECIPES to a directory containing <name>.yaml files.",
        name
    )
}

/// Embed recipes at compile time for the truly-zero-config build.
/// The bot's flagship email recipe ships alongside the binary so
/// `cargo build --release` produces a brain with at least one recipe
/// available even before HANZO_HOME is configured.
pub fn builtin_email_recipe_yaml() -> &'static str {
    // Sourced from `~/work/hanzo/bot/extensions/recipes-brain/recipes/email.yaml`.
    // The TS, Python, and Rust copies are byte-identical.
    include_str!("../../../../bot/extensions/recipes-brain/recipes/email.yaml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_email_recipe_parses() {
        let raw = builtin_email_recipe_yaml();
        let recipe: Recipe = serde_yaml::from_str(raw).expect("parse");
        assert_eq!(recipe.recipe, "email");
        assert_eq!(recipe.version, 1);
        assert_eq!(recipe.backend, "gmail");
    }
}
