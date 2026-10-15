#!/usr/bin/env python3
"""
Empirical Benchmark: Tool Selection Architecture Comparison
Evaluates:
  1. Deterministic Name & Case Matching
  2. BM25 Lexical Matching
  3. Kai Calibrated Decision Model
  4. Hybrid (Deterministic Fast-Path + Kai Semantic Decision)

Measures:
  - Recall@1 (Top-1 Accuracy)
  - Recall@3 (Top-3 Accuracy)
  - Latency (p50, p95 ms)
  - Zero-Inference Fast-Path Hit Rate
"""

import json
import math
import re
import sys
import time
import urllib.request
import urllib.error
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

KAI_URL = "http://127.0.0.1:18977"

# Standard registered tools in agent environment (Claude Code + Hanzo MCP)
TOOLS = [
    {"name": "Bash", "description": "Execute shell commands, run tests, build projects, and run cargo or npm."},
    {"name": "Read", "description": "Read file contents, inspect code, and view files on disk."},
    {"name": "Edit", "description": "Edit file contents, apply code patches, and modify existing files."},
    {"name": "Grep", "description": "Search file contents for regex patterns or text across directory."},
    {"name": "Find", "description": "Locate files by name pattern or glob within directory hierarchy."},
    {"name": "code", "description": "Semantic code operations: symbols, definitions, references, hierarchy, and AST transform."},
    {"name": "git", "description": "Git version control operations: status, diff, log, commit, branch, and rebase."},
    {"name": "fetch", "description": "Network operations: HTTP requests, download web resources, crawl pages."},
    {"name": "kai_command_guard", "description": "Classify shell command execution risk (allow, ask, deny) enforcing security policy."},
    {"name": "kai_recover", "description": "Loop breaker and recovery strategy selection from failure fingerprints and recurring errors."},
    {"name": "browser", "description": "Automate web browser, inspect web elements via CDP, take page screenshots."}
]

# 44 Evaluation Queries with Ground Truth
EVAL_CASES = [
    # Category 1: Casing & Aliases (10 queries)
    {"query": "bash", "expected": "Bash", "category": "alias"},
    {"query": "BASH", "expected": "Bash", "category": "alias"},
    {"query": "sh", "expected": "Bash", "category": "alias"},
    {"query": "shell", "expected": "Bash", "category": "alias"},
    {"query": "edit", "expected": "Edit", "category": "alias"},
    {"query": "read_file", "expected": "Read", "category": "alias"},
    {"query": "read", "expected": "Read", "category": "alias"},
    {"query": "grep", "expected": "Grep", "category": "alias"},
    {"query": "glob", "expected": "Find", "category": "alias"},
    {"query": "find", "expected": "Find", "category": "alias"},

    # Category 2: Natural Language Task Intent (14 queries)
    {"query": "Run cargo test to see which assertions failed", "expected": "Bash", "category": "intent"},
    {"query": "Execute npm run build to compile TypeScript sources", "expected": "Bash", "category": "intent"},
    {"query": "Inspect the first 50 lines of src/lib.rs", "expected": "Read", "category": "intent"},
    {"query": "Open package.json and view the dependencies section", "expected": "Read", "category": "intent"},
    {"query": "Replace the broken function implementation in agent.rs", "expected": "Edit", "category": "intent"},
    {"query": "Modify line 42 in Cargo.toml to bump the version", "expected": "Edit", "category": "intent"},
    {"query": "Search for all occurrences of 'TODO: fixme' across the repo", "expected": "Grep", "category": "intent"},
    {"query": "Find all files ending in .test.ts in test directory", "expected": "Find", "category": "intent"},
    {"query": "Check git status to see modified files in working directory", "expected": "git", "category": "intent"},
    {"query": "View the git diff against main branch before committing", "expected": "git", "category": "intent"},
    {"query": "Fetch the OpenAPI schema from https://api.hanzo.ai/openapi.json", "expected": "fetch", "category": "intent"},
    {"query": "Send an HTTP GET request to verify health endpoint status", "expected": "fetch", "category": "intent"},
    {"query": "Navigate to localhost:3000 and capture screenshot of login page", "expected": "browser", "category": "intent"},
    {"query": "Inspect DOM tree elements using Chrome DevTools Protocol", "expected": "browser", "category": "intent"},

    # Category 3: Decision, Policy & Safety (10 queries)
    {"query": "Verify whether running `git push --force` requires human approval", "expected": "kai_command_guard", "category": "safety"},
    {"query": "Check risk policy for command `rm -rf /` before running", "expected": "kai_command_guard", "category": "safety"},
    {"query": "Evaluate lattice risk level for `sudo chmod 777 /etc/passwd`", "expected": "kai_command_guard", "category": "safety"},
    {"query": "Determine if `git status` is safe to execute without asking", "expected": "kai_command_guard", "category": "safety"},
    {"query": "We have failed 3 times with the exact same error, break the retry loop", "expected": "kai_recover", "category": "safety"},
    {"query": "Select a recovery strategy for rustc borrow checker lifetime error", "expected": "kai_recover", "category": "safety"},
    {"query": "Tripped circuit breaker after recurring test failure in number.rs", "expected": "kai_recover", "category": "safety"},
    {"query": "Analyze stack trace fingerprint to choose alternative fix approach", "expected": "kai_recover", "category": "safety"},
    {"query": "Check if dangerous shell command reads ~/.ssh/id_rsa credentials", "expected": "kai_command_guard", "category": "safety"},
    {"query": "Handle recurring compilation error by switching repair tactic", "expected": "kai_recover", "category": "safety"},

    # Category 4: Code Intelligence & Symbol Search (10 queries)
    {"query": "Find where trait Controller is declared and defined", "expected": "code", "category": "code"},
    {"query": "Locate definition of struct OptionMemory in crates", "expected": "code", "category": "code"},
    {"query": "Find all callers and references to method decide_next_action", "expected": "code", "category": "code"},
    {"query": "Inspect class hierarchy and exports of module src/tools/kai.ts", "expected": "code", "category": "code"},
    {"query": "Extract semantic outline and function signatures of lib.rs", "expected": "code", "category": "code"},
    {"query": "Rename symbol TokenCounter to TokenBudget across AST", "expected": "code", "category": "code"},
    {"query": "Query abstract syntax tree for all async handler methods", "expected": "code", "category": "code"},
    {"query": "Find type definition of ToolConfig interface in TypeScript", "expected": "code", "category": "code"},
    {"query": "Analyze code complexity metrics and exports of parser crate", "expected": "code", "category": "code"},
    {"query": "Search for all references to enum Verdict in codebase", "expected": "code", "category": "code"}
]

# -----------------------------------------------------------------------------
# 1. Deterministic Matcher
# -----------------------------------------------------------------------------
ALIAS_MAP = {
    "bash": "Bash", "sh": "Bash", "shell": "Bash", "cmd": "Bash", "terminal": "Bash",
    "read": "Read", "read_file": "Read", "cat": "Read", "view": "Read",
    "edit": "Edit", "edit_file": "Edit", "patch": "Edit", "write": "Edit",
    "grep": "Grep", "search": "Grep", "rg": "Grep",
    "find": "Find", "glob": "Find", "locate": "Find",
    "git": "git", "vcs": "git",
    "fetch": "fetch", "curl": "fetch", "http": "fetch",
    "browser": "browser", "playwright": "browser", "cdp": "browser"
}

def deterministic_match(query: str, tools: List[Dict]) -> Tuple[List[str], float, bool]:
    t0 = time.perf_counter()
    q = query.strip()
    q_lower = q.lower()

    # Exact name match (case-insensitive)
    for t in tools:
        if t["name"].lower() == q_lower:
            return [t["name"]], (time.perf_counter() - t0) * 1000, True

    # Exact alias match
    if q_lower in ALIAS_MAP:
        target = ALIAS_MAP[q_lower]
        for t in tools:
            if t["name"] == target:
                return [t["name"]], (time.perf_counter() - t0) * 1000, True

    # Simple prefix token match
    tokens = re.findall(r'\b[a-zA-Z_]+\b', q_lower)
    for tok in tokens:
        if tok in ALIAS_MAP:
            target = ALIAS_MAP[tok]
            for t in tools:
                if t["name"] == target:
                    return [t["name"]], (time.perf_counter() - t0) * 1000, True

    return [], (time.perf_counter() - t0) * 1000, False

# -----------------------------------------------------------------------------
# 2. BM25 Lexical Matcher
# -----------------------------------------------------------------------------
class BM25:
    def __init__(self, tools: List[Dict], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.tools = tools
        self.corpus = [self._tokenize(f"{t['name']} {t['name']} {t['description']}") for t in tools]
        self.doc_lens = [len(doc) for doc in self.corpus]
        self.avg_dl = sum(self.doc_lens) / max(1, len(self.doc_lens))
        self.df = Counter()
        for doc in self.corpus:
            for term in set(doc):
                self.df[term] += 1
        self.N = len(self.corpus)
        self.idf = {term: math.log(1 + (self.N - count + 0.5) / (count + 0.5)) for term, count in self.df.items()}

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r'\b[a-z0-9_]+\b', text.lower())

    def score(self, query: str) -> List[Tuple[str, float]]:
        q_tokens = self._tokenize(query)
        scores = []
        for i, doc in enumerate(self.corpus):
            doc_len = self.doc_lens[i]
            tf = Counter(doc)
            s = 0.0
            for term in q_tokens:
                if term in self.idf:
                    count = tf.get(term, 0)
                    denom = count + self.k1 * (1 - self.b + self.b * (doc_len / self.avg_dl))
                    s += self.idf[term] * (count * (self.k1 + 1)) / max(0.001, denom)
            scores.append((self.tools[i]["name"], s))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores

def bm25_match(bm25: BM25, query: str) -> Tuple[List[str], float]:
    t0 = time.perf_counter()
    ranked = bm25.score(query)
    lat = (time.perf_counter() - t0) * 1000
    return [name for name, s in ranked], lat

# -----------------------------------------------------------------------------
# 3. Kai Decision Model Matcher
# -----------------------------------------------------------------------------
def kai_decision_match(query: str, tools: List[Dict]) -> Tuple[List[str], float, bool]:
    criteria = {t["name"]: t["description"][:250] for t in tools}
    payload = {
        "model": "kai",
        "state": f"Task: {query}\nDetermine which tool the agent should call.",
        "questions": {
            "selected_tool": {
                "type": "choice",
                "instructions": "Which tool should the agent use to accomplish the task?",
                "criteria": criteria
            }
        }
    }
    t0 = time.perf_counter()
    req = urllib.request.Request(
        f"{KAI_URL}/v1/decisions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    lat = (time.perf_counter() - t0) * 1000

    ans = data.get("answers", {}).get("selected_tool", {})
    probs = ans.get("probabilities", {})
    ranked = sorted(probs.items(), key=lambda x: x[1], reverse=True)
    return [name for name, _ in ranked], lat, False

# -----------------------------------------------------------------------------
# 4. Hybrid Matcher (Deterministic Fast-Path -> Kai Fallback)
# -----------------------------------------------------------------------------
def hybrid_match(bm25: BM25, query: str, tools: List[Dict]) -> Tuple[List[str], float, bool]:
    # Phase 1: Zero-inference deterministic fast-path (<0.1ms)
    det_res, det_lat, hit = deterministic_match(query, tools)
    if hit:
        return det_res, det_lat, True

    # Phase 2: Kai Decision Model evaluation
    kai_res, kai_lat, _ = kai_decision_match(query, tools)
    return kai_res, det_lat + kai_lat, False

# -----------------------------------------------------------------------------
# Main Evaluation Loop
# -----------------------------------------------------------------------------
def run_benchmark():
    print("=" * 80)
    print("  KAI TOOL SELECT BENCHMARK: DETERMINISTIC VS BM25 VS KAI VS HYBRID")
    print(f"  Target: {KAI_URL} (Local Kai on GPU)")
    print(f"  Cases: {len(EVAL_CASES)} evaluation queries across 4 categories")
    print("=" * 80)

    bm25 = BM25(TOOLS)

    methods = ["Deterministic", "BM25", "Kai Decision", "Hybrid (Fast+Kai)"]
    top1 = {m: 0 for m in methods}
    top3 = {m: 0 for m in methods}
    latencies = {m: [] for m in methods}
    fast_hits = {m: 0 for m in methods}

    category_top1 = {m: Counter() for m in methods}

    for case in EVAL_CASES:
        q = case["query"]
        expected = case["expected"]
        cat = case["category"]

        # 1. Deterministic
        d_res, d_lat, d_hit = deterministic_match(q, TOOLS)
        latencies["Deterministic"].append(d_lat)
        if d_hit and d_res and d_res[0] == expected:
            top1["Deterministic"] += 1
            category_top1["Deterministic"][cat] += 1
        if d_res and expected in d_res[:3]:
            top3["Deterministic"] += 1
        if d_hit:
            fast_hits["Deterministic"] += 1

        # 2. BM25
        b_res, b_lat = bm25_match(bm25, q)
        latencies["BM25"].append(b_lat)
        if b_res and b_res[0] == expected:
            top1["BM25"] += 1
            category_top1["BM25"][cat] += 1
        if b_res and expected in b_res[:3]:
            top3["BM25"] += 1

        # 3. Kai
        k_res, k_lat, _ = kai_decision_match(q, TOOLS)
        latencies["Kai Decision"].append(k_lat)
        if k_res and k_res[0] == expected:
            top1["Kai Decision"] += 1
            category_top1["Kai Decision"][cat] += 1
        if k_res and expected in k_res[:3]:
            top3["Kai Decision"] += 1

        # 4. Hybrid
        h_res, h_lat, h_hit = hybrid_match(bm25, q, TOOLS)
        latencies["Hybrid (Fast+Kai)"].append(h_lat)
        if h_res and h_res[0] == expected:
            top1["Hybrid (Fast+Kai)"].append if isinstance(top1["Hybrid (Fast+Kai)"], list) else None
            top1["Hybrid (Fast+Kai)"] += 1
            category_top1["Hybrid (Fast+Kai)"][cat] += 1
        if h_res and expected in h_res[:3]:
            top3["Hybrid (Fast+Kai)"] += 1
        if h_hit:
            fast_hits["Hybrid (Fast+Kai)"] += 1

    total = len(EVAL_CASES)

    print("\n" + "-" * 88)
    print(f"{'Method':<24} | {'Recall@1':<10} | {'Recall@3':<10} | {'p50 Latency':<12} | {'p95 Latency':<12} | {'Fast-Path':<10}")
    print("-" * 88)

    for m in methods:
        lats = sorted(latencies[m])
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]
        r1 = (top1[m] / total) * 100
        r3 = (top3[m] / total) * 100
        fast_pct = (fast_hits[m] / total) * 100
        print(f"{m:<24} | {top1[m]}/{total} ({r1:4.1f}%) | {top3[m]}/{total} ({r3:4.1f}%) | {p50:8.2f} ms   | {p95:8.2f} ms   | {fast_pct:5.1f}%")

    print("-" * 88)

    print("\nBreakdown by Category (Recall@1):")
    cats = ["alias", "intent", "safety", "code"]
    cat_totals = Counter([c["category"] for c in EVAL_CASES])
    header = f"{'Method':<24} | " + " | ".join([f"{c} ({cat_totals[c]})" for c in cats])
    print(header)
    print("-" * len(header))
    for m in methods:
        row = f"{m:<24} | " + " | ".join([f"{category_top1[m][c]}/{cat_totals[c]:<8}" for c in cats])
        print(row)
    print("-" * len(header))

if __name__ == "__main__":
    run_benchmark()
