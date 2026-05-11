//! Pure-CPU algorithm port for the Hanzo MCP Rust runtime.
//!
//! Mirrors `@hanzo/bot-memory` (TS), `hanzo_memory.algorithms` (Python),
//! `bot-go/pkg/brain` (Go), and `bot-cpp/include/hanzo/brain/algorithms.hpp`
//! (C++). A `~/.hanzo/brain/brain.db` written by any runtime is read by
//! every other without translation.
//!
//! The node-side canonical home lives in
//! `hanzoai/node/hanzo-libs/hanzo-brain/src/algorithms.rs`; this file is
//! the byte-equivalent mirror for the standalone MCP server.

use std::collections::{HashMap, HashSet};

use super::store::SearchHit;

// ── Fusion ────────────────────────────────────────────────────────────

/// BEIR-tuned default RRF k (Elasticsearch 2024 grid search).
pub const RRF_K_DEFAULT: f64 = 20.0;

/// Reciprocal Rank Fusion (Cormack et al. 2009). Normalizes the top result to ~1.
pub fn rrf_fuse(lists: Vec<Vec<SearchHit>>, limit: usize, k: f64) -> Vec<SearchHit> {
    let k = if k == 0.0 { RRF_K_DEFAULT } else { k };
    let mut scores: HashMap<String, f64> = HashMap::new();
    let mut meta: HashMap<String, SearchHit> = HashMap::new();
    let num = lists.len() as f64;
    for list in lists {
        for (rank, hit) in list.into_iter().enumerate() {
            *scores.entry(hit.slug.clone()).or_insert(0.0) += 1.0 / (k + rank as f64 + 1.0);
            meta.entry(hit.slug.clone()).or_insert(hit);
        }
    }
    if scores.is_empty() {
        return vec![];
    }
    let max = num / (k + 1.0);
    let mut out: Vec<SearchHit> = scores
        .into_iter()
        .map(|(slug, s)| {
            let m = meta.remove(&slug).unwrap();
            let norm = if max > 0.0 { (s / max).min(1.0) } else { 0.0 };
            SearchHit { slug, score: norm, excerpt: m.excerpt, source: "fused".into() }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    if out.len() > limit {
        out.truncate(limit);
    }
    out
}

/// Relative Score Fusion (Weaviate v1.24). Preserves score magnitude.
pub fn rsf_fuse(lists: Vec<Vec<SearchHit>>, limit: usize, weights: Option<Vec<f64>>) -> Vec<SearchHit> {
    let n = lists.len();
    let w = weights.unwrap_or_else(|| vec![if n == 0 { 0.0 } else { 1.0 / n as f64 }; n]);
    if w.len() != n {
        // gracefully fall back to uniform
        return rsf_fuse(lists, limit, Some(vec![if n == 0 { 0.0 } else { 1.0 / n as f64 }; n]));
    }
    let mut scores: HashMap<String, f64> = HashMap::new();
    let mut meta: HashMap<String, SearchHit> = HashMap::new();
    for (i, list) in lists.into_iter().enumerate() {
        if list.is_empty() {
            continue;
        }
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for h in &list {
            if h.score < lo { lo = h.score; }
            if h.score > hi { hi = h.score; }
        }
        let span = hi - lo;
        for h in list {
            let norm = if span > 0.0 { (h.score - lo) / span } else { 1.0 };
            *scores.entry(h.slug.clone()).or_insert(0.0) += w[i] * norm;
            meta.entry(h.slug.clone()).or_insert(h);
        }
    }
    let mut out: Vec<SearchHit> = scores
        .into_iter()
        .map(|(slug, s)| {
            let m = meta.remove(&slug).unwrap();
            SearchHit { slug, score: s, excerpt: m.excerpt, source: "fused".into() }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    if out.len() > limit {
        out.truncate(limit);
    }
    out
}

/// Query characteristics used to pick adaptive RRF k / weights.
#[derive(Debug, Clone, Copy)]
pub struct QueryCharacteristics {
    pub token_count: usize,
    pub is_phrase: bool,
    pub is_boolean: bool,
}

/// Cheap query characterizer; no external NLP.
pub fn characterize(query: &str) -> QueryCharacteristics {
    let t = query.trim();
    let is_phrase = (t.starts_with('"') && t.ends_with('"') && t.len() > 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() > 2);
    let mut is_boolean = false;
    for kw in ["AND", "OR", "NOT"] {
        // word-boundary check
        for m in t.match_indices(kw) {
            let before_ok = m.0 == 0 || !t.as_bytes()[m.0 - 1].is_ascii_alphanumeric();
            let after_idx = m.0 + kw.len();
            let after_ok = after_idx == t.len()
                || !t.as_bytes()[after_idx].is_ascii_alphanumeric();
            if before_ok && after_ok {
                is_boolean = true;
                break;
            }
        }
        if is_boolean { break; }
    }
    if !is_boolean {
        // detect "-term" negation
        let mut prev_ws = false;
        for c in t.chars() {
            if c == '-' && prev_ws { is_boolean = true; break; }
            prev_ws = c.is_whitespace();
        }
    }
    let token_count = t.split_whitespace().count();
    QueryCharacteristics { token_count, is_phrase, is_boolean }
}

/// Pick an adaptive k value for RRF based on query shape.
pub fn select_rrf_k(q: QueryCharacteristics) -> i32 {
    if q.is_phrase { return 10; }
    if q.is_boolean { return 15; }
    if q.token_count <= 2 { return 15; }
    if q.token_count >= 10 { return 40; }
    20
}

/// FTS / semantic weights for fusion, always summing to 1.0.
#[derive(Debug, Clone, Copy)]
pub struct FusionWeights { pub fts: f64, pub semantic: f64 }

/// Pick adaptive FTS / semantic weights from query shape.
pub fn select_weights(q: QueryCharacteristics) -> FusionWeights {
    if q.is_phrase   { return FusionWeights { fts: 0.8, semantic: 0.2 }; }
    if q.is_boolean  { return FusionWeights { fts: 0.7, semantic: 0.3 }; }
    if q.token_count <= 2  { return FusionWeights { fts: 0.65, semantic: 0.35 }; }
    if q.token_count >= 10 { return FusionWeights { fts: 0.3, semantic: 0.7 }; }
    FusionWeights { fts: 0.5, semantic: 0.5 }
}

// ── Rerank (MMR) ─────────────────────────────────────────────────────

/// Cosine similarity. Returns 0 on dimension mismatch or zero norm.
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() { return 0.0; }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let d = na.sqrt() * nb.sqrt();
    if d == 0.0 { 0.0 } else { dot / d }
}

/// MMR input: a hit with an optional embedding for diversity scoring.
#[derive(Debug, Clone)]
pub struct MmrInput {
    pub hit: SearchHit,
    pub embedding: Option<Vec<f64>>,
}

/// Greedy MMR rerank (Carbonell & Goldstein 1998).
pub fn mmr_rerank(hits: Vec<MmrInput>, lambda: f64, limit: usize) -> Vec<MmrInput> {
    let limit = if limit == 0 { hits.len() } else { limit };
    let (mut embedded, orphans): (Vec<_>, Vec<_>) =
        hits.into_iter().partition(|h| h.embedding.as_ref().map(|e| !e.is_empty()).unwrap_or(false));
    let mut selected: Vec<MmrInput> = Vec::with_capacity(limit);
    while selected.len() < limit && !embedded.is_empty() {
        let mut best_idx: Option<usize> = None;
        let mut best_score = f64::NEG_INFINITY;
        for (i, c) in embedded.iter().enumerate() {
            let rel = c.hit.score;
            let mut max_sim = 0.0_f64;
            for s in &selected {
                let sim = cosine(
                    c.embedding.as_ref().unwrap(),
                    s.embedding.as_ref().unwrap(),
                );
                if sim > max_sim { max_sim = sim; }
            }
            let mmr = lambda * rel - (1.0 - lambda) * max_sim;
            if mmr > best_score {
                best_score = mmr;
                best_idx = Some(i);
            }
        }
        match best_idx {
            Some(i) => selected.push(embedded.remove(i)),
            None => break,
        }
    }
    for o in orphans {
        if selected.len() >= limit { break; }
        selected.push(o);
    }
    selected
}

// ── Dedup ────────────────────────────────────────────────────────────

fn chain_of(slug: &str) -> String {
    let mut s = slug.to_string();
    // strip "#chunk-N"
    if let Some(idx) = s.rfind("#chunk-") {
        if s[idx + 7..].chars().all(|c| c.is_ascii_digit()) {
            s.truncate(idx);
        }
    }
    // strip "::N"
    if let Some(idx) = s.rfind("::") {
        if s[idx + 2..].chars().all(|c| c.is_ascii_digit()) {
            s.truncate(idx);
        }
    }
    s
}

/// Keep the top-N best-scored hits per chain.
pub fn dedup_hits(hits: Vec<SearchHit>, per_chain: usize) -> Vec<SearchHit> {
    let per_chain = if per_chain == 0 { 1 } else { per_chain };
    let mut buckets: HashMap<String, Vec<SearchHit>> = HashMap::new();
    for h in hits {
        buckets.entry(chain_of(&h.slug)).or_default().push(h);
    }
    let mut out = Vec::new();
    for mut lst in buckets.into_values() {
        lst.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        out.extend(lst.into_iter().take(per_chain));
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ── Script detection ─────────────────────────────────────────────────

fn is_cjk(cp: u32) -> bool {
    (0x4E00..=0x9FFF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x3040..=0x30FF).contains(&cp)
        || (0xAC00..=0xD7AF).contains(&cp)
}

fn is_emoji(cp: u32) -> bool {
    (0x2600..=0x27BF).contains(&cp) || (0x1F300..=0x1FAFF).contains(&cp)
}

/// True when any CJK codepoint is present.
pub fn has_cjk(s: &str) -> bool { s.chars().any(|c| is_cjk(c as u32)) }

/// True when any emoji codepoint is present.
pub fn has_emoji(s: &str) -> bool { s.chars().any(|c| is_emoji(c as u32)) }

/// Detected script counts + fractions + primary.
#[derive(Debug, Clone)]
pub struct ScriptReport {
    pub primary: String,
    pub fractions: HashMap<String, f64>,
    pub has_cjk: bool,
    pub has_emoji: bool,
}

/// Classify a string's primary script.
pub fn detect_script(s: &str) -> ScriptReport {
    let keys = ["latin", "cjk", "emoji", "cyrillic", "arabic", "hebrew", "greek", "devanagari", "other"];
    let mut counts: HashMap<String, usize> = keys.iter().map(|k| (k.to_string(), 0)).collect();
    let mut total = 0usize;
    for c in s.chars() {
        let cp = c as u32;
        if (0x0030..=0x0039).contains(&cp) { continue; }
        if let Some(k) = classify_cp(cp) {
            *counts.entry(k.to_string()).or_insert(0) += 1;
            total += 1;
        }
    }
    let mut primary = "other".to_string();
    let mut max = 0usize;
    for &k in &keys {
        if counts[k] > max {
            max = counts[k];
            primary = k.to_string();
        }
    }
    let mut fractions: HashMap<String, f64> = HashMap::new();
    for &k in &keys {
        let v = counts[k];
        fractions.insert(k.to_string(), if total > 0 { v as f64 / total as f64 } else { 0.0 });
    }
    let has_cjk = counts["cjk"] > 0;
    let has_emoji = counts["emoji"] > 0;
    ScriptReport { primary, fractions, has_cjk, has_emoji }
}

fn classify_cp(cp: u32) -> Option<&'static str> {
    if is_cjk(cp) { return Some("cjk"); }
    if is_emoji(cp) { return Some("emoji"); }
    if (0x0041..=0x005A).contains(&cp) || (0x0061..=0x007A).contains(&cp) || (0x00C0..=0x024F).contains(&cp) {
        return Some("latin");
    }
    if (0x0370..=0x03FF).contains(&cp) { return Some("greek"); }
    if (0x0400..=0x04FF).contains(&cp) { return Some("cyrillic"); }
    if (0x0590..=0x05FF).contains(&cp) { return Some("hebrew"); }
    if (0x0600..=0x06FF).contains(&cp) { return Some("arabic"); }
    if (0x0900..=0x097F).contains(&cp) { return Some("devanagari"); }
    if cp <= 0x002F
        || (0x003A..=0x0040).contains(&cp)
        || (0x005B..=0x0060).contains(&cp)
        || (0x007B..=0x007E).contains(&cp)
    {
        return None;
    }
    Some("other")
}

// ── FTS helpers ──────────────────────────────────────────────────────

/// Split CJK runs into 2-character grams; Latin words pass through intact.
pub fn cjk_bigrams(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cjk_buf = String::new();
    let mut latin_buf = String::new();
    let flush_cjk = |buf: &mut String, out: &mut Vec<String>| {
        if buf.is_empty() { return; }
        let runes: Vec<char> = buf.chars().collect();
        if runes.len() == 1 {
            out.push(runes[0].to_string());
        } else {
            for i in 0..runes.len() - 1 {
                out.push(runes[i..i + 2].iter().collect::<String>());
            }
        }
        buf.clear();
    };
    let flush_latin = |buf: &mut String, out: &mut Vec<String>| {
        if !buf.is_empty() {
            out.push(buf.clone());
            buf.clear();
        }
    };
    for c in text.chars() {
        if is_cjk(c as u32) {
            flush_latin(&mut latin_buf, &mut out);
            cjk_buf.push(c);
        } else if c.is_whitespace() {
            flush_cjk(&mut cjk_buf, &mut out);
            flush_latin(&mut latin_buf, &mut out);
        } else {
            flush_cjk(&mut cjk_buf, &mut out);
            latin_buf.push(c);
        }
    }
    flush_cjk(&mut cjk_buf, &mut out);
    flush_latin(&mut latin_buf, &mut out);
    out
}

/// Emit length-3 grams over emoji runs.
pub fn emoji_trigrams(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    for i in 0..chars.len() {
        if !is_emoji(chars[i] as u32) { continue; }
        let mut s = String::new();
        s.push(chars[i]);
        if i + 1 < chars.len() { s.push(chars[i + 1]); }
        if i + 2 < chars.len() { s.push(chars[i + 2]); }
        out.push(s);
    }
    out
}

/// Decomposed websearch query.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedQuery {
    pub required: Vec<String>,
    pub excluded: Vec<String>,
    pub optional: Vec<Vec<String>>,
    pub phrases: Vec<String>,
}

/// Parse a websearch-style query into a structured form.
pub fn parse_websearch(query: &str) -> ParsedQuery {
    let tokens = tokenize_with_phrases(query);
    let mut out = ParsedQuery::default();
    let mut i = 0;
    while i < tokens.len() {
        let (kind, val) = &tokens[i];
        if kind == "phrase" {
            out.phrases.push(val.clone());
            out.required.push(val.clone());
            i += 1;
            continue;
        }
        if i + 1 < tokens.len() && tokens[i + 1].0 == "word" && tokens[i + 1].1 == "OR" {
            let mut group = vec![val.clone()];
            let mut j = i + 1;
            while j + 1 < tokens.len() && tokens[j].0 == "word" && tokens[j].1 == "OR" {
                group.push(tokens[j + 1].1.clone());
                j += 2;
            }
            out.optional.push(group);
            i = j;
            continue;
        }
        if val.starts_with('-') && val.len() > 1 {
            out.excluded.push(val[1..].to_string());
            i += 1;
            continue;
        }
        out.required.push(val.clone());
        i += 1;
    }
    out
}

fn tokenize_with_phrases(q: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = q.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() { i += 1; continue; }
        if chars[i] == '"' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '"' { j += 1; }
            out.push(("phrase".to_string(), chars[i + 1..j].iter().collect()));
            i = if j < chars.len() { j + 1 } else { j };
            continue;
        }
        let mut j = i;
        while j < chars.len() && !chars[j].is_whitespace() { j += 1; }
        out.push(("word".to_string(), chars[i..j].iter().collect()));
        i = j;
    }
    out
}

/// Render a parsed query as a SQLite FTS5 MATCH expression.
pub fn to_fts5_match(p: &ParsedQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    for r in &p.required { parts.push(quote_fts5(r)); }
    for group in &p.optional {
        let alts: Vec<String> = group.iter().map(|g| quote_fts5(g)).collect();
        parts.push(format!("({})", alts.join(" OR ")));
    }
    let mut s = parts.join(" AND ");
    for e in &p.excluded {
        s.push_str(&format!(" NOT {}", quote_fts5(e)));
    }
    s.trim().to_string()
}

fn quote_fts5(term: &str) -> String {
    let simple = !term.is_empty() && term.chars().all(|c| c.is_alphanumeric() || c == '_');
    if !simple || term.contains(' ') {
        let escaped = term.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    } else {
        term.to_string()
    }
}

// ── Embed registry + MRL ─────────────────────────────────────────────

/// Embedding model profile.
#[derive(Debug, Clone)]
pub struct EmbeddingModel {
    pub slug: String,
    pub dim: usize,
    pub mrl_dims: Vec<usize>,
    pub prefix_query: Option<String>,
    pub prefix_passage: Option<String>,
    pub family: Option<String>,
}

fn embed_registry() -> &'static std::sync::Mutex<HashMap<String, EmbeddingModel>> {
    use std::sync::OnceLock;
    static REG: OnceLock<std::sync::Mutex<HashMap<String, EmbeddingModel>>> = OnceLock::new();
    REG.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("ollama:nomic-embed-text".into(), EmbeddingModel {
            slug: "ollama:nomic-embed-text".into(), dim: 768,
            mrl_dims: vec![128, 256, 512, 768],
            prefix_query: None, prefix_passage: None,
            family: Some("nomic".into()),
        });
        m.insert("intfloat/e5-large-v2".into(), EmbeddingModel {
            slug: "intfloat/e5-large-v2".into(), dim: 1024,
            mrl_dims: vec![],
            prefix_query: Some("query: ".into()), prefix_passage: Some("passage: ".into()),
            family: Some("e5".into()),
        });
        m.insert("openai:text-embedding-3-small".into(), EmbeddingModel {
            slug: "openai:text-embedding-3-small".into(), dim: 1536,
            mrl_dims: vec![256, 512, 768, 1024, 1536],
            prefix_query: None, prefix_passage: None,
            family: Some("openai".into()),
        });
        m.insert("openai:text-embedding-3-large".into(), EmbeddingModel {
            slug: "openai:text-embedding-3-large".into(), dim: 3072,
            mrl_dims: vec![256, 512, 1024, 2048, 3072],
            prefix_query: None, prefix_passage: None,
            family: Some("openai".into()),
        });
        std::sync::Mutex::new(m)
    })
}

/// Register or replace an embedding model.
pub fn register_embedding_model(m: EmbeddingModel) {
    embed_registry().lock().unwrap().insert(m.slug.clone(), m);
}

/// Look up an embedding model by slug.
pub fn get_embedding_model(slug: &str) -> Option<EmbeddingModel> {
    embed_registry().lock().unwrap().get(slug).cloned()
}

/// List all known embedding models.
pub fn list_embedding_models() -> Vec<EmbeddingModel> {
    embed_registry().lock().unwrap().values().cloned().collect()
}

/// Apply asymmetric query / passage prefixes when the model requires them.
pub fn prefix_for(m: &EmbeddingModel, task: &str, text: &str) -> String {
    if task == "symmetric" || (m.prefix_query.is_none() && m.prefix_passage.is_none()) {
        return text.to_string();
    }
    match task {
        "query" => format!("{}{}", m.prefix_query.clone().unwrap_or_default(), text),
        _ => format!("{}{}", m.prefix_passage.clone().unwrap_or_default(), text),
    }
}

/// L2-normalize a vector in place.
pub fn l2_normalize(v: &mut [f64]) {
    let mut s = 0.0_f64;
    for x in v.iter() { s += x * x; }
    let n = s.sqrt();
    if n == 0.0 { return; }
    for x in v.iter_mut() { *x /= n; }
}

/// Matryoshka truncate + re-normalize.
pub fn mrl_truncate(embedding: &[f64], target_dim: usize) -> Vec<f64> {
    assert!(target_dim > 0, "target_dim must be positive");
    let mut copy = if target_dim >= embedding.len() {
        embedding.to_vec()
    } else {
        embedding[..target_dim].to_vec()
    };
    l2_normalize(&mut copy);
    copy
}

/// Coarse dim for two-stage retrieval (~1/8 of native).
pub fn coarse_dim(m: &EmbeddingModel) -> usize {
    if m.mrl_dims.is_empty() { return m.dim; }
    let target = (m.dim as f64) / 8.0;
    for &d in &m.mrl_dims {
        if (d as f64) >= target { return d; }
    }
    *m.mrl_dims.last().unwrap_or(&m.dim)
}

// ── Temporal ─────────────────────────────────────────────────────────

/// Render a UUIDv7 floor for the given epoch-ms timestamp.
pub fn v7_floor(epoch_ms: i64) -> String { v7(epoch_ms, false) }

/// Render a UUIDv7 ceiling for the given epoch-ms timestamp.
pub fn v7_ceiling(epoch_ms: i64) -> String { v7(epoch_ms, true) }

fn v7(epoch_ms: i64, ceiling: bool) -> String {
    let ts = if epoch_ms < 0 { 0u64 } else { epoch_ms as u64 };
    let hex = format!("{:012x}", ts);
    let hex = &hex[hex.len() - 12..];
    let (th, tl) = (&hex[..8], &hex[8..12]);
    if ceiling {
        format!("{}-{}-7fff-bfff-ffffffffffff", th, tl)
    } else {
        format!("{}-{}-7000-8000-000000000000", th, tl)
    }
}

// ── Captions ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CaptionSegment {
    pub start_secs: f64,
    pub end_secs: f64,
    pub text: String,
    pub speaker: Option<String>,
}

/// Render WebVTT.
pub fn render_vtt(segs: &[CaptionSegment]) -> String {
    let mut s = String::from("WEBVTT\n\n");
    for (i, sg) in segs.iter().enumerate() {
        s.push_str(&format!("{}\n", i + 1));
        s.push_str(&format!("{} --> {}\n", fmt_time(sg.start_secs, '.'), fmt_time(sg.end_secs, '.')));
        match &sg.speaker {
            Some(sp) => s.push_str(&format!("<v {}>{}</v>\n\n", sp, sg.text)),
            None => s.push_str(&format!("{}\n\n", sg.text)),
        }
    }
    s
}

/// Render SubRip (SRT).
pub fn render_srt(segs: &[CaptionSegment]) -> String {
    let mut s = String::new();
    for (i, sg) in segs.iter().enumerate() {
        s.push_str(&format!("{}\n", i + 1));
        s.push_str(&format!("{} --> {}\n", fmt_time(sg.start_secs, ','), fmt_time(sg.end_secs, ',')));
        match &sg.speaker {
            Some(sp) => s.push_str(&format!("{}: {}\n\n", sp, sg.text)),
            None => s.push_str(&format!("{}\n\n", sg.text)),
        }
    }
    s
}

/// Render NIST RTTM.
pub fn render_rttm(segs: &[CaptionSegment], uri: &str) -> String {
    let uri = if uri.is_empty() { "audio" } else { uri };
    let mut s = String::new();
    for sg in segs {
        if let Some(sp) = &sg.speaker {
            let dur = sg.end_secs - sg.start_secs;
            s.push_str(&format!(
                "SPEAKER {} 1 {:.3} {:.3} <NA> <NA> {} <NA> <NA>\n",
                uri, sg.start_secs, dur, sp,
            ));
        }
    }
    s
}

fn fmt_time(secs: f64, ms_sep: char) -> String {
    let ms = ((secs - secs.floor()) * 1000.0) as u32;
    let total = secs.floor() as u32;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    format!("{:02}:{:02}:{:02}{}{:03}", h, m, s, ms_sep, ms)
}

// ── Tokenizer ────────────────────────────────────────────────────────

/// Fast BPE-style token estimate.
pub fn estimate_tokens(text: &str) -> usize {
    let mut total = 0usize;
    let mut ascii_run = String::new();
    let flush = |buf: &mut String, total: &mut usize| {
        if buf.is_empty() { return; }
        for w in buf.split_whitespace() {
            *total += std::cmp::max(1, (w.chars().count() + 3) / 4);
        }
        buf.clear();
    };
    for c in text.chars() {
        if is_cjk(c as u32) || is_emoji(c as u32) {
            flush(&mut ascii_run, &mut total);
            total += 1;
        } else {
            ascii_run.push(c);
        }
    }
    flush(&mut ascii_run, &mut total);
    total
}

/// Truncate to fit a token budget via binary search.
pub fn truncate_to_tokens(text: &str, max: usize) -> String {
    if estimate_tokens(text) <= max { return text.to_string(); }
    let chars: Vec<char> = text.chars().collect();
    let (mut lo, mut hi) = (0usize, chars.len());
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        let s: String = chars[..mid].iter().collect();
        if estimate_tokens(&s) <= max { lo = mid; } else { hi = mid - 1; }
    }
    chars[..lo].iter().collect()
}

// ── Eval ─────────────────────────────────────────────────────────────

/// Per-query evaluation row.
#[derive(Debug, Clone)]
pub struct QueryEval {
    pub predicted: Vec<String>,
    pub relevant: HashMap<String, i32>,
}

fn rel_set(q: &QueryEval) -> HashSet<&String> {
    q.relevant.iter().filter_map(|(k, v)| if *v > 0 { Some(k) } else { None }).collect()
}

pub fn reciprocal_rank(q: &QueryEval) -> f64 {
    let rel = rel_set(q);
    for (i, p) in q.predicted.iter().enumerate() {
        if rel.contains(p) { return 1.0 / (i + 1) as f64; }
    }
    0.0
}

pub fn mean_reciprocal_rank(qs: &[QueryEval]) -> f64 {
    if qs.is_empty() { return 0.0; }
    qs.iter().map(reciprocal_rank).sum::<f64>() / qs.len() as f64
}

pub fn recall_at_k(q: &QueryEval, k: usize) -> f64 {
    let rel = rel_set(q);
    if rel.is_empty() { return 0.0; }
    let hits = q.predicted.iter().take(k).filter(|p| rel.contains(p)).count();
    hits as f64 / rel.len() as f64
}

pub fn precision_at_k(q: &QueryEval, k: usize) -> f64 {
    let head: Vec<_> = q.predicted.iter().take(k).collect();
    if head.is_empty() { return 0.0; }
    let rel = rel_set(q);
    let hits = head.iter().filter(|p| rel.contains(**p)).count();
    hits as f64 / head.len() as f64
}

pub fn ndcg_at_k(q: &QueryEval, k: usize) -> f64 {
    let dcg = |slugs: &[&String]| {
        let mut s = 0.0;
        for (i, slug) in slugs.iter().enumerate() {
            let g = q.relevant.get(*slug).copied().unwrap_or(0) as f64;
            s += (2f64.powf(g) - 1.0) / (((i + 2) as f64).log2());
        }
        s
    };
    let mut sorted: Vec<(&String, i32)> = q.relevant.iter().map(|(k, v)| (k, *v)).collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    let ideal: Vec<&String> = sorted.iter().take(k).map(|(k, _)| *k).collect();
    let idcg = dcg(&ideal);
    let head: Vec<&String> = q.predicted.iter().take(k).collect();
    let actual = dcg(&head);
    if idcg == 0.0 { 0.0 } else { actual / idcg }
}

// ── Spatial ──────────────────────────────────────────────────────────

const EARTH_KM: f64 = 6371.0088;

pub fn haversine_km(lat_a: f64, lng_a: f64, lat_b: f64, lng_b: f64) -> f64 {
    let d_lat = (lat_b - lat_a).to_radians();
    let d_lng = (lng_b - lng_a).to_radians();
    let r1 = lat_a.to_radians();
    let r2 = lat_b.to_radians();
    let x = (d_lat / 2.0).sin().powi(2)
        + (d_lng / 2.0).sin().powi(2) * r1.cos() * r2.cos();
    2.0 * EARTH_KM * x.sqrt().asin()
}

#[derive(Debug, Clone, Copy)]
pub struct BBox { pub min_lat: f64, pub min_lng: f64, pub max_lat: f64, pub max_lng: f64 }

pub fn bbox_around(lat: f64, lng: f64, radius_km: f64) -> BBox {
    let d_lat = radius_km / 111.0;
    let d_lng = radius_km / (111.0 * lat.to_radians().cos());
    BBox { min_lat: lat - d_lat, min_lng: lng - d_lng, max_lat: lat + d_lat, max_lng: lng + d_lng }
}

pub fn in_box(lat: f64, lng: f64, b: BBox) -> bool {
    lat >= b.min_lat && lat <= b.max_lat && lng >= b.min_lng && lng <= b.max_lng
}

// ── HTTP Range ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    Ok { start: i64, end: i64 },
    Unsatisfiable,
    Invalid,
}

pub fn parse_range(header: &str, total: i64) -> RangeOutcome {
    if !header.starts_with("bytes=") { return RangeOutcome::Invalid; }
    let spec = header[6..].split(',').next().unwrap_or("").trim();
    if spec.is_empty() { return RangeOutcome::Invalid; }
    if let Some(rest) = spec.strip_prefix('-') {
        match rest.parse::<i64>() {
            Ok(suffix) if suffix > 0 => {
                let start = (total - suffix).max(0);
                return RangeOutcome::Ok { start, end: total - 1 };
            }
            _ => return RangeOutcome::Invalid,
        }
    }
    let parts: Vec<&str> = spec.splitn(2, '-').collect();
    let start = match parts[0].parse::<i64>() { Ok(v) => v, Err(_) => return RangeOutcome::Invalid };
    let end = if parts.len() == 2 && !parts[1].is_empty() {
        match parts[1].parse::<i64>() { Ok(v) => v, Err(_) => return RangeOutcome::Invalid }
    } else {
        total - 1
    };
    if start > end || start >= total { return RangeOutcome::Unsatisfiable; }
    RangeOutcome::Ok { start, end: end.min(total - 1) }
}

pub fn content_range(start: i64, end: i64, total: i64) -> String {
    format!("bytes {}-{}/{}", start, end, total)
}

// ── Wallet address ───────────────────────────────────────────────────

const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const VERSION_V1: u8 = 0x01;

fn digest32(data: &[u8]) -> [u8; 32] {
    // BLAKE3 — wallet addresses are content-addressable; every brain runtime
    // (TS @noble/hashes/blake3, Python blake3, Go lukechampine.com/blake3,
    // C++ vendored reference impl) hashes with BLAKE3 so the output is
    // byte-equivalent across all five.
    blake3::hash(data).into()
}

pub fn encode_address(public_key: &[u8], prefix: Option<&str>) -> Result<String, &'static str> {
    if public_key.len() != 32 { return Err("public key must be 32 bytes"); }
    let prefix = prefix.unwrap_or("hanzo");
    let h = digest32(public_key);
    let mut versioned = Vec::with_capacity(21);
    versioned.push(VERSION_V1);
    versioned.extend_from_slice(&h[..20]);
    let cs = digest32(&versioned);
    let mut payload = versioned.clone();
    payload.extend_from_slice(&cs[..4]);
    Ok(format!("{}:{}", prefix, base58_encode(&payload)))
}

#[derive(Debug, Clone)]
pub struct DecodedAddress {
    pub prefix: String,
    pub version: u8,
    pub hash: [u8; 20],
}

pub fn decode_address(addr: &str) -> Result<DecodedAddress, &'static str> {
    let colon = match addr.find(':') { Some(i) => i, None => return Err("address: missing prefix") };
    let body = &addr[colon + 1..];
    let decoded = base58_decode(body)?;
    if decoded.len() != 25 { return Err("address: wrong length"); }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&decoded[1..21]);
    let expected = digest32(&decoded[..21]);
    if decoded[21..25] != expected[..4] { return Err("address: bad checksum"); }
    Ok(DecodedAddress { prefix: addr[..colon].to_string(), version: decoded[0], hash })
}

fn base58_encode(b: &[u8]) -> String {
    if b.is_empty() { return String::new(); }
    let zeros = b.iter().take_while(|&&c| c == 0).count();
    let bytes_to_int = |b: &[u8]| -> Vec<u8> { b.to_vec() };
    let mut n = bytes_to_int(b);
    let mut out = String::new();
    loop {
        let mut remainder: u32 = 0;
        let mut new = Vec::with_capacity(n.len());
        let mut started = false;
        for &byte in &n {
            let cur = remainder * 256 + byte as u32;
            let q = cur / 58;
            remainder = cur % 58;
            if started || q > 0 { new.push(q as u8); started = true; }
        }
        out.insert(0, BASE58.as_bytes()[remainder as usize] as char);
        if new.is_empty() { break; }
        n = new;
    }
    for _ in 0..zeros { out.insert(0, BASE58.as_bytes()[0] as char); }
    out
}

fn base58_decode(s: &str) -> Result<Vec<u8>, &'static str> {
    if s.is_empty() { return Ok(vec![]); }
    let zeros = s.chars().take_while(|c| *c == BASE58.chars().next().unwrap()).count();
    let mut n: Vec<u8> = vec![0];
    for c in s.chars() {
        let idx = BASE58.find(c).ok_or("base58: invalid char")? as u32;
        let mut carry = idx;
        for b in n.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 { n.push((carry & 0xff) as u8); carry >>= 8; }
    }
    let mut out = vec![0u8; zeros];
    let mut rev: Vec<u8> = n.iter().rev().copied().collect();
    while rev.first().copied() == Some(0) && rev.len() > 1 { rev.remove(0); }
    out.extend_from_slice(&rev);
    Ok(out)
}

// ── Graph maintenance ────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WeightedEdge {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

pub fn normalize_edges(edges: &[WeightedEdge]) -> Vec<WeightedEdge> {
    if edges.is_empty() { return vec![]; }
    let lo = edges.iter().map(|e| e.weight).fold(f64::INFINITY, f64::min);
    let hi = edges.iter().map(|e| e.weight).fold(f64::NEG_INFINITY, f64::max);
    let span = hi - lo;
    edges.iter().map(|e| WeightedEdge {
        source: e.source.clone(),
        target: e.target.clone(),
        weight: if span > 0.0 { (e.weight - lo) / span } else { 1.0 },
    }).collect()
}

pub fn snn_score(edges: &[WeightedEdge], k: usize) -> Vec<WeightedEdge> {
    let mut adj: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for e in edges {
        adj.entry(e.source.clone()).or_default().push((e.target.clone(), e.weight));
        adj.entry(e.target.clone()).or_default().push((e.source.clone(), e.weight));
    }
    let mut nbrs: HashMap<String, HashSet<String>> = HashMap::new();
    for (node, lst) in adj.iter_mut() {
        lst.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let set: HashSet<String> = lst.iter().take(k).map(|(t, _)| t.clone()).collect();
        nbrs.insert(node.clone(), set);
    }
    edges.iter().map(|e| {
        let a = nbrs.get(&e.source).cloned().unwrap_or_default();
        let b = nbrs.get(&e.target).cloned().unwrap_or_default();
        let inter = a.intersection(&b).count();
        let union = a.len() + b.len() - inter;
        let w = if union > 0 { inter as f64 / union as f64 } else { 0.0 };
        WeightedEdge { source: e.source.clone(), target: e.target.clone(), weight: w }
    }).collect()
}

pub fn pfnet_infinity(edges: &[WeightedEdge]) -> Vec<WeightedEdge> {
    let mut adj: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for e in edges {
        adj.entry(e.source.clone()).or_default().entry(e.target.clone())
            .and_modify(|v| { if e.weight > *v { *v = e.weight; } })
            .or_insert(e.weight);
    }
    let mut keep = Vec::new();
    for e in edges {
        let mut dominated = false;
        if let Some(srcs) = adj.get(&e.source) {
            for (x, w_ux) in srcs {
                if x == &e.target { continue; }
                if let Some(w_xv) = adj.get(x).and_then(|m| m.get(&e.target)) {
                    let path = (*w_ux).min(*w_xv);
                    if path > e.weight { dominated = true; break; }
                }
            }
        }
        if !dominated { keep.push(e.clone()); }
    }
    keep
}

pub fn louvain(edges: &[WeightedEdge], passes: usize) -> HashMap<String, i32> {
    let passes = if passes == 0 { 10 } else { passes };
    let mut nodes: HashSet<String> = HashSet::new();
    for e in edges {
        nodes.insert(e.source.clone());
        nodes.insert(e.target.clone());
    }
    let mut community: HashMap<String, i32> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        community.insert(n.clone(), i as i32);
    }
    let mut adj: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    let mut total = 0.0;
    for e in edges {
        adj.entry(e.source.clone()).or_default().push((e.target.clone(), e.weight));
        adj.entry(e.target.clone()).or_default().push((e.source.clone(), e.weight));
        total += e.weight;
    }
    let mut deg: HashMap<String, f64> = HashMap::new();
    for (n, lst) in &adj {
        let d: f64 = lst.iter().map(|(_, w)| w).sum();
        deg.insert(n.clone(), d);
    }
    let m = total;
    for _ in 0..passes {
        let mut improved = false;
        let order: Vec<String> = nodes.iter().cloned().collect();
        for n in &order {
            let cur = community[n];
            let mut w_to: HashMap<i32, f64> = HashMap::new();
            for (nb, w) in adj.get(n).cloned().unwrap_or_default() {
                let c = community[&nb];
                *w_to.entry(c).or_insert(0.0) += w;
            }
            let mut best = cur;
            let mut best_gain = 0.0;
            let kn = deg.get(n).copied().unwrap_or(0.0);
            for (c, wnc) in &w_to {
                if *c == cur { continue; }
                let sigma_tot: f64 = community.iter()
                    .filter(|(other, comm)| *comm == c && other.as_str() != n.as_str())
                    .map(|(other, _)| deg.get(other).copied().unwrap_or(0.0))
                    .sum();
                let gain = wnc - (kn * sigma_tot) / (2.0 * m).max(1e-9);
                if gain > best_gain { best_gain = gain; best = *c; }
            }
            if best != cur {
                community.insert(n.clone(), best);
                improved = true;
            }
        }
        if !improved { break; }
    }
    // compact ids
    let mut id_map: HashMap<i32, i32> = HashMap::new();
    let mut next = 0i32;
    for c in community.values() {
        id_map.entry(*c).or_insert_with(|| { let v = next; next += 1; v });
    }
    for (_, c) in community.iter_mut() {
        *c = id_map[c];
    }
    community
}

// ── Inference: slug + runtime config + link types ───────────────────

const KNOWN_PROVIDERS: &[&str] = &[
    "ollama", "openai", "openrouter", "llamacpp",
    "anthropic", "google", "azure", "groq", "together", "mock",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSlug { pub provider: String, pub model: String }

pub fn parse_slug(slug: &str, default_provider: &str) -> ParsedSlug {
    let colon = match slug.find(':') {
        Some(i) => i,
        None => return ParsedSlug { provider: default_provider.into(), model: slug.into() },
    };
    let head = &slug[..colon];
    if KNOWN_PROVIDERS.iter().any(|&k| k == head) {
        return ParsedSlug { provider: head.into(), model: slug[colon + 1..].into() };
    }
    ParsedSlug { provider: default_provider.into(), model: slug.into() }
}

pub fn format_slug(p: &ParsedSlug) -> String { format!("{}:{}", p.provider, p.model) }

#[derive(Debug, Default)]
pub struct RuntimeConfig {
    pub defaults: HashMap<String, String>,
    pub env: HashMap<String, String>,
    overrides: HashMap<String, String>,
}

impl RuntimeConfig {
    pub fn new(defaults: HashMap<String, String>, env: HashMap<String, String>) -> Self {
        Self { defaults, env, overrides: HashMap::new() }
    }
    pub fn get(&self, key: &str) -> Option<String> {
        if let Some(v) = self.overrides.get(key) { return Some(v.clone()); }
        if let Some(v) = self.env.get(key) { return Some(v.clone()); }
        self.defaults.get(key).cloned()
    }
    pub fn source(&self, key: &str) -> &'static str {
        if self.overrides.contains_key(key) { return "db_override"; }
        if self.env.contains_key(key) { return "env"; }
        if self.defaults.contains_key(key) { return "default"; }
        "absent"
    }
    pub fn set(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.overrides.insert(key.into(), value.into());
    }
    pub fn clear(&mut self, key: &str) { self.overrides.remove(key); }
}

pub const LINK_TYPES: &[&str] = &[
    "mentions", "founded", "invested_in", "advises", "works_at",
    "attended", "authored", "cites", "succeeded_by", "located_in", "related",
];

/// Zero-LLM rule-based link classifier.
pub fn classify_link_rule(evidence: &str) -> &'static str {
    let e = evidence.to_lowercase();
    if e.contains("founded") { return "founded"; }
    if let Some(idx) = e.find("invested") {
        if e[idx..].contains("in") { return "invested_in"; }
    }
    if e.contains("advisor") || e.contains("advises") || e.contains("advising") { return "advises"; }
    if e.contains("works at") || e.contains("works for") || e.contains("work at") || e.contains("work for") { return "works_at"; }
    if e.contains("attended") { return "attended"; }
    if e.contains("wrote") || e.contains("authored") { return "authored"; }
    if e.contains("cites") || e.contains("cite ") { return "cites"; }
    if e.contains("succeeded by") { return "succeeded_by"; }
    if e.contains("located in") { return "located_in"; }
    "mentions"
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain::store::SearchHit;

    fn hit(slug: &str, score: f64) -> SearchHit {
        SearchHit { slug: slug.into(), score, excerpt: slug.into(), source: "keyword".into() }
    }

    #[test]
    fn test_rrf_top_one() {
        let r = rrf_fuse(vec![vec![hit("a", 1.0), hit("b", 0.5)]], 10, 0.0);
        assert_eq!(r[0].slug, "a");
        assert!((r[0].score - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_rsf_preserves_magnitude() {
        let r = rsf_fuse(vec![vec![hit("a", 100.0), hit("b", 50.0)], vec![hit("a", 1.0), hit("c", 0.5)]], 10, None);
        assert_eq!(r[0].slug, "a");
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn test_select_rrf_k() {
        assert_eq!(select_rrf_k(characterize("\"hello world\"")), 10);
        assert_eq!(select_rrf_k(characterize("foo AND bar")), 15);
        assert_eq!(select_rrf_k(characterize("rust")), 15);
        assert_eq!(select_rrf_k(characterize("a b c d e f g h i j")), 40);
    }

    #[test]
    fn test_select_weights() {
        let short = select_weights(characterize("rust"));
        assert!(short.fts > short.semantic);
        let long = select_weights(characterize("how do retrieval augmented generation systems typically work in production scale"));
        assert!(long.semantic > long.fts);
    }

    #[test]
    fn test_cosine() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn test_mmr() {
        let hits = vec![
            MmrInput { hit: hit("a", 0.9), embedding: Some(vec![1.0, 0.0]) },
            MmrInput { hit: hit("b", 0.85), embedding: Some(vec![1.0, 0.01]) },
            MmrInput { hit: hit("c", 0.6), embedding: Some(vec![0.0, 1.0]) },
        ];
        let out = mmr_rerank(hits, 0.2, 2);
        assert_eq!(out[0].hit.slug, "a");
        assert_eq!(out[1].hit.slug, "c");
    }

    #[test]
    fn test_dedup() {
        let out = dedup_hits(vec![
            hit("page/foo#chunk-0", 0.5),
            hit("page/foo#chunk-1", 0.8),
            hit("page/bar", 0.6),
        ], 1);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn test_detect_script() {
        assert_eq!(detect_script("こんにちは世界").primary, "cjk");
        assert_eq!(detect_script("Hello world").primary, "latin");
        assert_eq!(detect_script("Привет").primary, "cyrillic");
    }

    #[test]
    fn test_cjk_bigrams() {
        let out = cjk_bigrams("hello 世界 こんにちは");
        assert!(out.contains(&"hello".to_string()));
        assert!(out.contains(&"世界".to_string()));
        assert!(out.contains(&"こん".to_string()));
    }

    #[test]
    fn test_emoji_trigrams_emit() {
        let out = emoji_trigrams("hi 🚀🌌🌟");
        assert!(!out.is_empty());
    }

    #[test]
    fn test_parse_websearch() {
        let p = parse_websearch("\"hello world\" foo OR bar -baz qux");
        assert_eq!(p.phrases, vec!["hello world"]);
        assert_eq!(p.optional[0], vec!["foo", "bar"]);
        assert_eq!(p.excluded, vec!["baz"]);
        assert!(p.required.contains(&"qux".to_string()));
    }

    #[test]
    fn test_to_fts5_match() {
        let sql = to_fts5_match(&parse_websearch("apple OR orange -spoil"));
        assert!(sql.contains("apple OR orange"));
        assert!(sql.contains("NOT spoil"));
    }

    #[test]
    fn test_embed_registry() {
        assert_eq!(get_embedding_model("ollama:nomic-embed-text").unwrap().dim, 768);
        assert_eq!(get_embedding_model("openai:text-embedding-3-small").unwrap().dim, 1536);
    }

    #[test]
    fn test_prefix_for() {
        let e5 = get_embedding_model("intfloat/e5-large-v2").unwrap();
        assert_eq!(prefix_for(&e5, "query", "x"), "query: x");
        assert_eq!(prefix_for(&e5, "passage", "x"), "passage: x");
        let nomic = get_embedding_model("ollama:nomic-embed-text").unwrap();
        assert_eq!(prefix_for(&nomic, "query", "x"), "x");
    }

    #[test]
    fn test_mrl_truncate() {
        let v: Vec<f64> = (1..=8).map(|x| x as f64).collect();
        let t = mrl_truncate(&v, 4);
        assert_eq!(t.len(), 4);
        let norm: f64 = t.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_coarse_dim() {
        let m = get_embedding_model("openai:text-embedding-3-large").unwrap();
        let cd = coarse_dim(&m);
        assert!((256..=512).contains(&cd));
    }

    #[test]
    fn test_l2_zero_vector() {
        let mut v = vec![0.0; 3];
        l2_normalize(&mut v);
        assert_eq!(v, vec![0.0; 3]);
    }

    #[test]
    fn test_v7_floor_ceiling_order() {
        let t = 1_700_000_000_000i64;
        assert!(v7_floor(t) < v7_ceiling(t));
    }

    #[test]
    fn test_captions() {
        let segs = vec![
            CaptionSegment { start_secs: 0.0, end_secs: 1.5, text: "hi".into(), speaker: Some("S0".into()) },
            CaptionSegment { start_secs: 1.5, end_secs: 3.0, text: "world".into(), speaker: Some("S1".into()) },
        ];
        assert!(render_vtt(&segs).starts_with("WEBVTT"));
        assert!(render_srt(&segs).contains("00:00:00,000 --> 00:00:01,500"));
        assert!(render_rttm(&segs, "").starts_with("SPEAKER"));
    }

    #[test]
    fn test_estimate_tokens() {
        assert!(estimate_tokens("hi there friend") > estimate_tokens("hi"));
        assert_eq!(estimate_tokens("こんにちは"), 5);
    }

    #[test]
    fn test_truncate_to_tokens() {
        let long = "alpha ".repeat(100);
        let t = truncate_to_tokens(&long, 20);
        assert!(estimate_tokens(&t) <= 20);
    }

    fn qe() -> QueryEval {
        let mut r = HashMap::new();
        r.insert("c".into(), 1);
        r.insert("d".into(), 1);
        QueryEval { predicted: vec!["a", "b", "c", "d"].into_iter().map(String::from).collect(), relevant: r }
    }

    #[test]
    fn test_reciprocal_rank() {
        assert!((reciprocal_rank(&qe()) - 1.0 / 3.0).abs() < 1e-6);
    }

    #[test]
    fn test_recall_at_k() {
        let q = qe();
        assert_eq!(recall_at_k(&q, 2), 0.0);
        assert!((recall_at_k(&q, 4) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_precision_at_k() {
        assert!((precision_at_k(&qe(), 4) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_ndcg_graded() {
        let mut r = HashMap::new();
        r.insert("a".into(), 3);
        r.insert("b".into(), 1);
        let g = QueryEval { predicted: vec!["a", "b"].into_iter().map(String::from).collect(), relevant: r };
        assert!(ndcg_at_k(&g, 2) > 0.9);
    }

    #[test]
    fn test_mrr() {
        assert!(mean_reciprocal_rank(&[qe()]) > 0.0);
    }

    #[test]
    fn test_haversine() {
        assert!(haversine_km(0.0, 0.0, 0.0, 0.0).abs() < 1e-6);
        let d = haversine_km(40.7128, -74.006, 34.0522, -118.2437);
        assert!((d - 3935.0).abs() < 50.0);
    }

    #[test]
    fn test_bbox() {
        let center = (37.77, -122.42);
        let box_ = bbox_around(center.0, center.1, 10.0);
        assert!(in_box(center.0, center.1, box_));
        assert!(!in_box(0.0, 0.0, box_));
    }

    #[test]
    fn test_range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), RangeOutcome::Ok { start: 0, end: 99 });
        assert_eq!(parse_range("bytes=-100", 1000), RangeOutcome::Ok { start: 900, end: 999 });
        assert_eq!(parse_range("bytes=2000-3000", 1000), RangeOutcome::Unsatisfiable);
        assert_eq!(content_range(0, 99, 1000), "bytes 0-99/1000");
    }

    #[test]
    fn test_address_round_trip() {
        let pk: Vec<u8> = (0..32u8).collect();
        let addr = encode_address(&pk, None).unwrap();
        assert!(addr.starts_with("hanzo:"));
        let dec = decode_address(&addr).unwrap();
        assert_eq!(dec.prefix, "hanzo");
        assert_eq!(dec.version, 1);
    }

    #[test]
    fn test_address_bad_checksum() {
        assert!(decode_address("hanzo:11111111111111111111111111").is_err());
    }

    #[test]
    fn test_normalize_edges() {
        let out = normalize_edges(&[
            WeightedEdge { source: "a".into(), target: "b".into(), weight: 10.0 },
            WeightedEdge { source: "b".into(), target: "c".into(), weight: 5.0 },
        ]);
        assert!((out[0].weight - 1.0).abs() < 1e-6);
        assert!(out[1].weight.abs() < 1e-6);
    }

    #[test]
    fn test_snn_bounds() {
        let edges = vec![
            WeightedEdge { source: "a".into(), target: "b".into(), weight: 0.9 },
            WeightedEdge { source: "a".into(), target: "c".into(), weight: 0.8 },
            WeightedEdge { source: "b".into(), target: "c".into(), weight: 0.7 },
        ];
        for e in snn_score(&edges, 2) {
            assert!((0.0..=1.0).contains(&e.weight));
        }
    }

    #[test]
    fn test_pfnet_drops_dominated() {
        let edges = vec![
            WeightedEdge { source: "a".into(), target: "b".into(), weight: 0.9 },
            WeightedEdge { source: "b".into(), target: "c".into(), weight: 0.9 },
            WeightedEdge { source: "a".into(), target: "c".into(), weight: 0.5 },
        ];
        for e in pfnet_infinity(&edges) {
            assert!(!(e.source == "a" && e.target == "c"));
        }
    }

    #[test]
    fn test_louvain_size() {
        let edges = vec![
            WeightedEdge { source: "a".into(), target: "b".into(), weight: 1.0 },
            WeightedEdge { source: "b".into(), target: "c".into(), weight: 1.0 },
            WeightedEdge { source: "a".into(), target: "c".into(), weight: 1.0 },
        ];
        let c = louvain(&edges, 0);
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn test_parse_slug() {
        let p = parse_slug("openai:gpt-4o", "ollama");
        assert_eq!(p, ParsedSlug { provider: "openai".into(), model: "gpt-4o".into() });
        let p = parse_slug("qwen3:8b", "ollama");
        assert_eq!(p, ParsedSlug { provider: "ollama".into(), model: "qwen3:8b".into() });
        assert_eq!(format_slug(&ParsedSlug { provider: "openai".into(), model: "gpt-4o".into() }), "openai:gpt-4o");
    }

    #[test]
    fn test_runtime_config_precedence() {
        let mut rc = RuntimeConfig::new(
            HashMap::from([("K".into(), "default".into())]),
            HashMap::from([("K".into(), "env".into())]),
        );
        assert_eq!(rc.get("K").as_deref(), Some("env"));
        rc.set("K", "override");
        assert_eq!(rc.get("K").as_deref(), Some("override"));
        assert_eq!(rc.source("K"), "db_override");
        rc.clear("K");
        assert_eq!(rc.get("K").as_deref(), Some("env"));
    }

    #[test]
    fn test_classify_link_rule() {
        assert_eq!(classify_link_rule("Alice founded Acme"), "founded");
        assert_eq!(classify_link_rule("Alice invested in Acme"), "invested_in");
        assert_eq!(classify_link_rule("worked together"), "mentions");
    }
}
