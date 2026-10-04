//! `kai_decide` — Kai, Hanzo's decision model, at POST /v1/decisions.
//!
//! One state, any named typed questions, one call: the same tool, name and
//! contract as the TypeScript runtime's `kai_decide` (src/tools/kai.ts). A
//! question is `{type, instructions, criteria}`: `choice` picks a label, `score`
//! an ordinal level, `noul` the probability a statement holds. The answers come
//! back with calibrated probabilities and Kai writes no text.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

use super::{envelope_err, envelope_ok};
use crate::hanzo_api::HanzoApi;
use crate::{MCPTool, ToolResult};

/// The model a decision is asked of when none is named.
pub const DEFAULT_MODEL: &str = "kai";
const KINDS: &[&str] = &["choice", "score", "noul"];

/// Text, an object or an array: the wire's Content.
fn content(v: &Value) -> bool {
    v.is_string() || v.is_object() || v.is_array()
}

/// What is wrong with one question under the wire contract, or `None`.
fn fault(q: &Value) -> Option<String> {
    let Some(obj) = q.as_object() else { return Some("must be {type, instructions, criteria}".into()) };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if !KINDS.contains(&kind) {
        return Some(format!("type must be one of {}", KINDS.join(", ")));
    }
    if let Some(i) = obj.get("instructions").filter(|v| !v.is_null()) {
        if !content(i) {
            return Some("instructions must be text, an object or an array".into());
        }
    }
    let c = obj.get("criteria").unwrap_or(&Value::Null);
    match kind {
        "choice" => {
            let n = match c {
                Value::Array(labels) => {
                    if !labels.iter().all(Value::is_string) {
                        return Some("criteria as a list must hold string labels".into());
                    }
                    labels.iter().filter_map(Value::as_str).collect::<std::collections::BTreeSet<_>>().len()
                }
                Value::Object(m) => m.len(),
                _ => return Some("criteria must be {label: description} or [label, ...]".into()),
            };
            (n < 2).then(|| format!("criteria must name at least 2 labels, not {n}"))
        }
        "score" => match c {
            Value::Array(levels) if levels.is_empty() => Some("criteria must list at least 1 level".into()),
            Value::Array(levels) => levels
                .iter()
                .position(Value::is_null)
                .map(|i| format!("score level {i} is null; describe every level")),
            _ => Some("criteria must be the levels, lowest first: [level0, level1, ...]".into()),
        },
        _ => match c {
            Value::Null => None,
            Value::Object(m) => {
                let odd: Vec<&str> = m
                    .keys()
                    .map(String::as_str)
                    .filter(|k| !k.eq_ignore_ascii_case("true") && !k.eq_ignore_ascii_case("false"))
                    .collect();
                (!odd.is_empty()).then(|| format!("criteria take only \"true\" and \"false\", not {}", odd.join(", ")))
            }
            _ => Some("criteria must be {\"true\": ..., \"false\": ...}".into()),
        },
    }
}

/// Check a decision's shape and build its body; whether a state fits the model
/// is the server's to say (422 `state_too_long`).
pub fn request(state: &Value, questions: &Value, model: Option<&Value>) -> std::result::Result<Value, String> {
    if !content(state) {
        return Err("state required: text, an object or an array".into());
    }
    let Some(qs) = questions.as_object() else {
        return Err("questions required: {name: {type, instructions, criteria}}".into());
    };
    if qs.is_empty() || qs.len() > 100 {
        return Err(format!("questions must hold 1 to 100 questions, not {}", qs.len()));
    }
    for (name, q) in qs {
        if let Some(f) = fault(q) {
            return Err(format!("question '{name}': {f}"));
        }
    }
    let model = match model {
        None | Some(Value::Null) => DEFAULT_MODEL.to_string(),
        Some(Value::String(m)) if !m.is_empty() => m.clone(),
        Some(Value::String(_)) => DEFAULT_MODEL.to_string(),
        Some(_) => return Err("model must be a model name, e.g. kai".into()),
    };
    Ok(json!({ "model": model, "state": state, "questions": questions }))
}

pub struct KaiDecideTool {
    api: HanzoApi,
}

impl KaiDecideTool {
    pub fn new() -> Self {
        Self { api: HanzoApi::from_env() }
    }

    pub fn schema() -> Value {
        let content = json!({ "type": ["string", "object", "array"], "items": {} });
        json!({
            "name": "kai_decide",
            "description": "Ask Kai, Hanzo's decision model, typed questions about one case in one call (POST /v1/decisions). Reach for Kai when the answer is one of options you already know: classify, route, gate, rank, check. It writes no text. `questions` maps a name to {type, instructions, criteria}, 1 to 100 of them; `instructions` is optional but recommended, as the text Kai answers. choice picks one label: criteria {label: description} or [label, ...], 2 labels or more. score picks an ordinal level: criteria [level0, level1, ...], lowest first; act on the argmax of its probabilities, since score is the mean level index. noul gives the probability a statement holds: criteria {\"true\": ..., \"false\": ...}, optional; write it as a statement, not a bare yes/no question. Returns the decision {id, model, answers: {name: answer}, usage, routing, state_hash, latency_ms}. Probabilities are calibrated; confidence = (n·p_max − 1)/(n − 1) over n options. Billed on input tokens at the catalog's kai rate; output_tokens is 0.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "state": { "type": ["string", "object", "array"], "items": {}, "description": "The case to decide about: text, a JSON object or an array" },
                    "questions": {
                        "type": "object",
                        "description": "Question name → {type, instructions, criteria}; 1 to 100 questions",
                        "additionalProperties": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": KINDS },
                                "instructions": content,
                                "criteria": { "type": ["object", "array"], "items": {}, "description": "choice: {label: description} or [label, ...], 2 labels or more; score: [level0, level1, ...], lowest first, none null; noul: {\"true\": ..., \"false\": ...}, optional" }
                            },
                            "required": ["type"]
                        }
                    },
                    "model": { "type": "string", "description": "Decision model (default kai)" }
                },
                "required": ["state", "questions"]
            }
        })
    }
}

impl Default for KaiDecideTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MCPTool for KaiDecideTool {
    fn name(&self) -> &str {
        "kai_decide"
    }
    fn description(&self) -> &str {
        "Ask Kai, Hanzo's decision model, typed questions (choice, score, noul) about one case: calibrated answers, no text"
    }
    fn parameters(&self) -> Value {
        Self::schema()["inputSchema"].clone()
    }
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let body = match request(&params["state"], &params["questions"], params.get("model")) {
            Ok(b) => b,
            Err(e) => return Ok(ToolResult::ok(envelope_err("kai_decide", "decide", "INVALID_ARGS", e))),
        };
        if !self.api.has_key() {
            return Ok(ToolResult::ok(envelope_err("kai_decide", "decide", "NO_API_KEY", crate::hanzo_api::NO_KEY)));
        }
        Ok(match self.api.call(reqwest::Method::POST, "/v1/decisions", Some(body), &[]).await {
            Ok(a) if a.body["answers"].is_object() => ToolResult::ok(envelope_ok("kai_decide", "decide", a.body)),
            Ok(a) => ToolResult::ok(envelope_err("kai_decide", "decide", "UPSTREAM", format!("not a decision: {}", a.body))),
            Err(e) => ToolResult::ok(envelope_err("kai_decide", "decide", "UPSTREAM", e.to_string())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_decision_becomes_its_body() {
        let qs = json!({
            "team": { "type": "choice", "instructions": "Which team?", "criteria": { "billing": "money", "tech": "bugs" } },
            "urgency": { "type": "score", "criteria": ["low", "high"] },
            "angry": { "type": "noul", "criteria": { "true": "upset", "false": "calm" } }
        });
        let b = request(&json!({ "message": "charged twice" }), &qs, None).unwrap();
        assert_eq!(b, json!({ "model": "kai", "state": { "message": "charged twice" }, "questions": qs }));
        assert_eq!(request(&json!("text"), &qs, Some(&json!("typesafe/jev-1.13"))).unwrap()["model"], "typesafe/jev-1.13");
    }

    #[test]
    fn each_shape_the_contract_refuses_is_named() {
        let one = |q: Value| request(&json!("s"), &json!({ "q": q }), None).unwrap_err();
        assert!(one(json!({ "type": "vote" })).contains("type must be one of"));
        assert!(one(json!({ "type": "choice", "criteria": ["a", "a"] })).contains("at least 2 labels, not 1"));
        assert!(one(json!({ "type": "choice", "criteria": [1, 2] })).contains("string labels"));
        assert!(one(json!({ "type": "score", "criteria": [] })).contains("at least 1 level"));
        assert!(one(json!({ "type": "score", "criteria": ["a", null] })).contains("score level 1 is null"));
        assert!(one(json!({ "type": "noul", "criteria": { "maybe": "x" } })).contains("not maybe"));
        assert!(request(&json!(42), &json!({ "q": { "type": "noul" } }), None).unwrap_err().contains("state required"));
        assert!(request(&json!("s"), &json!({}), None).unwrap_err().contains("1 to 100"));
        assert!(request(&json!("s"), &json!({ "q": { "type": "noul" } }), Some(&json!(7))).unwrap_err().contains("model must be"));
    }
}
