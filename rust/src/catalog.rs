//! The fleet's agent surface, as cloud generated it.
//!
//! One entry per subsystem, carrying that subsystem's operation names. It is the
//! SAME file the TypeScript runtime embeds (`src/tools/catalog.json`), written by
//! cloud's `plugin/gen-mcp-catalog` out of its own typed operations — so the two
//! runtimes cannot come to disagree about what the API offers, which is what
//! "the runtimes mirror one-to-one" has to mean to be worth saying.
//!
//! It is embedded rather than fetched because a tool list is answered before any
//! request has been made, and because a client that needs the network to say
//! what it can do has nothing to say when the network is what failed.
//!
//! Refresh it with `pnpm sync:catalog` at the repo root.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

const CATALOG: &str = include_str!("../../src/tools/catalog.json");

#[derive(Debug, Deserialize)]
struct Entry {
    ops: Vec<String>,
}

fn fleet() -> &'static BTreeMap<String, Entry> {
    static ONCE: OnceLock<BTreeMap<String, Entry>> = OnceLock::new();
    ONCE.get_or_init(|| serde_json::from_str(CATALOG).expect("catalog.json is generated and must parse"))
}

/// services names every subsystem the fleet offers, in a stable order.
pub fn services() -> Vec<&'static str> {
    fleet().keys().map(String::as_str).collect()
}

/// serves reports whether the fleet offers this subsystem.
pub fn serves(service: &str) -> bool {
    fleet().contains_key(service)
}

/// actions names one subsystem's operations, empty for a subsystem the fleet
/// does not offer — the caller has already been told which those are.
pub fn actions(service: &str) -> Vec<&'static str> {
    fleet()
        .get(service)
        .map(|e| e.ops.iter().map(String::as_str).collect())
        .unwrap_or_default()
}

/// operations counts what this client can address, for anything reporting reach.
pub fn operations() -> usize {
    fleet().values().map(|e| e.ops.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_is_whole() {
        assert!(services().len() > 100, "expected the fleet, got {}", services().len());
        assert!(operations() > 1000, "expected the fleet's operations, got {}", operations());
    }

    #[test]
    fn a_subsystem_carries_its_operations() {
        assert!(serves("iam"));
        assert!(actions("iam").contains(&"get_iam_users"));
    }

    #[test]
    fn what_the_fleet_withholds_is_absent() {
        // The rule is applied once, in cloud, and reaches here through the
        // generated file: reading who holds a role is not granting one.
        assert!(!actions("iam").contains(&"post_iam_users"));
        assert!(!actions("iam").contains(&"delete_iam_users"));
    }

    #[test]
    fn a_name_the_fleet_dropped_is_not_offered() {
        // paas became platform and storage became s3 ; a client still naming the
        // old ones is a client describing an API that has moved.
        assert!(!serves("paas"));
        assert!(!serves("storage"));
        assert!(serves("platform"));
    }
}
