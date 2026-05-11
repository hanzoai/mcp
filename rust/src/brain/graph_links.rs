//! Zero-LLM typed-link extractor — Rust port of `@hanzo/bot-graph-links`.
//!
//! Same six edge types (mentions / attended / works_at / invested_in /
//! founded / advises), same regex + role inference, same code-fence
//! stripping. Pure — no I/O, no LLM. >10K pages/sec on commodity hw.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeType {
    Mentions,
    Attended,
    WorksAt,
    InvestedIn,
    Founded,
    Advises,
}

impl EdgeType {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeType::Mentions => "mentions",
            EdgeType::Attended => "attended",
            EdgeType::WorksAt => "works_at",
            EdgeType::InvestedIn => "invested_in",
            EdgeType::Founded => "founded",
            EdgeType::Advises => "advises",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: EdgeType,
    pub evidence: Option<String>,
}

// ── Patterns ────────────────────────────────────────────────────────

static MD_LINK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[([^\]]+)\]\(([^)#\s]+)\)").unwrap());

static BARE_SLUG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:^|[^/\w])@?((?:people|companies|deals|projects|investors|firms)/[a-z0-9][a-z0-9-]*)",
    )
    .unwrap()
});

static CODE_FENCE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)```.*?```").unwrap());
static INLINE_CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`[^`\n]+`").unwrap());

// Role-inference patterns. Order matters — first match wins per (source, target).
static ROLE_PATTERNS: Lazy<Vec<(Regex, EdgeType)>> = Lazy::new(|| {
    vec![
        // FOUNDED
        (Regex::new(r"(?i)\b(?:co-?)?founded\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::Founded),
        (Regex::new(r"(?i)\bfounder\s+(?:and\s+\w+\s+)?of\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::Founded),
        // INVESTED_IN
        (Regex::new(r"(?i)\binvested\s+in\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::InvestedIn),
        (Regex::new(r"(?i)\bled\s+([^.\n]+?)['’]s\s+(?:seed|series|round)").unwrap(), EdgeType::InvestedIn),
        (Regex::new(r"(?i)\bwrote\s+(?:a\s+)?check\s+into\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::InvestedIn),
        // ADVISES
        (Regex::new(r"(?i)\badvises\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::Advises),
        (Regex::new(r"(?i)\badvisor\s+(?:to|at|for)\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::Advises),
        // WORKS_AT
        (Regex::new(r"(?i)\b(?:CEO|CTO|COO|CFO|VP|head\s+of\s+\w+|director)\s+of\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::WorksAt),
        (Regex::new(r"\bjoined\s+([A-Z][^\s.]*(?:\s+[A-Z][^\s.]*)*)(?:\s+(?:as|in)\b|[\s.,;:!?\n]|$)").unwrap(), EdgeType::WorksAt),
        (Regex::new(r"(?i)\bworks\s+at\s+([^.\n]+?)(?:[.\n]|$)").unwrap(), EdgeType::WorksAt),
    ]
});

// ── slugify ─────────────────────────────────────────────────────────

/// Lowercase ascii dashes — matches the TS + Python implementations.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let lower = s.to_lowercase().replace('&', " and ");
    let mut last_dash = true;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let take = trimmed.chars().take(80).collect::<String>();
    take
}

fn strip_code(md: &str) -> String {
    let no_fences = CODE_FENCE.replace_all(md, "");
    INLINE_CODE.replace_all(&no_fences, "").into_owned()
}

fn infer_category(t: EdgeType) -> &'static str {
    match t {
        EdgeType::Founded | EdgeType::InvestedIn | EdgeType::WorksAt => "companies",
        EdgeType::Advises => "people",
        _ => "entities",
    }
}

/// Extract typed edges from one page. Pure — no I/O, no LLM.
pub fn extract_edges(slug: &str, content: &str, page_type: Option<&str>) -> Vec<Edge> {
    let cleaned = strip_code(content);
    let mut seen: std::collections::HashMap<(String, EdgeType), Edge> =
        std::collections::HashMap::new();

    let meeting = page_type == Some("meeting");

    // 1. Markdown links.
    for cap in MD_LINK.captures_iter(&cleaned) {
        let target = cap.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        if target.starts_with("http") || target.starts_with('/') || !target.contains('/') {
            continue;
        }
        let ty = if meeting { EdgeType::Attended } else { EdgeType::Mentions };
        let edge = Edge {
            source: slug.to_string(),
            target: target.to_string(),
            edge_type: ty,
            evidence: Some(cap.get(0).unwrap().as_str().to_string()),
        };
        seen.entry((edge.target.clone(), edge.edge_type)).or_insert(edge);
    }

    // 2. Bare slug refs.
    for cap in BARE_SLUG.captures_iter(&cleaned) {
        let target = cap.get(1).unwrap().as_str().to_lowercase();
        let ty = if meeting { EdgeType::Attended } else { EdgeType::Mentions };
        let edge = Edge {
            source: slug.to_string(),
            target,
            edge_type: ty,
            evidence: Some(cap.get(0).unwrap().as_str().to_string()),
        };
        seen.entry((edge.target.clone(), edge.edge_type)).or_insert(edge);
    }

    // 3. Role inference.
    for (pat, etype) in ROLE_PATTERNS.iter() {
        if let Some(cap) = pat.captures(&cleaned) {
            let raw = cap.get(1).unwrap().as_str().trim().trim_end_matches(['.', ',', ';', ':', '!', '?']);
            let target_slug = format!("{}/{}", infer_category(*etype), slugify(raw));
            if target_slug.ends_with('/') {
                continue;
            }
            let edge = Edge {
                source: slug.to_string(),
                target: target_slug.clone(),
                edge_type: *etype,
                evidence: Some(cap.get(0).unwrap().as_str().to_string()),
            };
            seen.entry((target_slug, *etype)).or_insert(edge);
        }
    }

    seen.into_values().collect()
}

/// Return (add, remove) deltas between two edge sets.
pub fn reconcile(prior: &[Edge], next: &[Edge]) -> (Vec<Edge>, Vec<Edge>) {
    use std::collections::HashSet;
    let key = |e: &Edge| (e.source.clone(), e.target.clone(), e.edge_type);
    let prior_keys: HashSet<_> = prior.iter().map(key).collect();
    let next_keys: HashSet<_> = next.iter().map(key).collect();
    let add: Vec<_> = next.iter().filter(|e| !prior_keys.contains(&key(e))).cloned().collect();
    let remove: Vec<_> = prior.iter().filter(|e| !next_keys.contains(&key(e))).cloned().collect();
    (add, remove)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_lowercases_dashes_ascii() {
        assert_eq!(slugify("Acme AI Inc."), "acme-ai-inc");
        assert_eq!(slugify("Slack & Discord"), "slack-and-discord");
    }

    #[test]
    fn extracts_founded_invested_works_at() {
        let edges = extract_edges(
            "people/alice",
            "Alice is the CEO of Acme. She founded Beta Co. She invested in Foobar.",
            Some("person"),
        );
        let targets: std::collections::HashSet<_> =
            edges.iter().map(|e| (e.target.as_str(), e.edge_type)).collect();
        assert!(targets.contains(&("companies/acme", EdgeType::WorksAt)));
        assert!(targets.contains(&("companies/beta-co", EdgeType::Founded)));
        assert!(targets.contains(&("companies/foobar", EdgeType::InvestedIn)));
    }

    #[test]
    fn meeting_pages_emit_attended() {
        let edges = extract_edges(
            "meetings/m1",
            "Met with [Bob](people/bob) and [Carol](people/carol).",
            Some("meeting"),
        );
        let types: std::collections::HashSet<_> = edges.iter().map(|e| e.edge_type).collect();
        assert!(types.contains(&EdgeType::Attended));
        assert!(!types.contains(&EdgeType::Mentions));
    }

    #[test]
    fn strips_code_fences() {
        let edges = extract_edges(
            "concepts/snippet",
            "Normal: [link](people/real). Code:\n```\nfake = [x](people/fake)\n```\n",
            None,
        );
        let targets: std::collections::HashSet<_> = edges.iter().map(|e| e.target.as_str()).collect();
        assert!(targets.contains("people/real"));
        assert!(!targets.contains("people/fake"));
    }

    #[test]
    fn reconcile_add_remove() {
        let prior = vec![
            Edge { source: "a".into(), target: "x".into(), edge_type: EdgeType::Mentions, evidence: None },
            Edge { source: "a".into(), target: "y".into(), edge_type: EdgeType::Mentions, evidence: None },
        ];
        let next = vec![
            Edge { source: "a".into(), target: "y".into(), edge_type: EdgeType::Mentions, evidence: None },
            Edge { source: "a".into(), target: "z".into(), edge_type: EdgeType::Mentions, evidence: None },
        ];
        let (add, remove) = reconcile(&prior, &next);
        assert_eq!(add.len(), 1);
        assert_eq!(add[0].target, "z");
        assert_eq!(remove.len(), 1);
        assert_eq!(remove[0].target, "x");
    }
}
