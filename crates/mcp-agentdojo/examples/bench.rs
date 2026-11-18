// SPDX-License-Identifier: Apache-2.0
//! Reproducible runner.
use mcp_agentdojo::{BenchConfig, run_bench, write_results_json};
use std::path::PathBuf;

fn main() {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("results.json"));
    let cfg = BenchConfig::default();
    eprintln!("running mcp-agentdojo");
    let report = run_bench(&cfg).expect("benchmark failed");
    write_results_json(&report, &out).expect("failed to write results");
    eprintln!("wrote {}", out.display());
}
