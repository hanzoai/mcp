//! Asking Kai a choice over the Decisions API.
//!
//! One request carries every question that is open at once; each is a `choice` whose options are
//! the candidate values (or actions), and one more option, [`ABSTAIN`], that Kai may take when
//! none fits or the request does not say. Kai never writes a command: it only chooses among what
//! the caller read out of the repository.

use serde::Serialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// The option that means none of the others.
pub const ABSTAIN: &str = "abstain";

/// A choice put to Kai.
#[derive(Debug, Clone)]
pub struct Question {
    pub id: String,
    pub ask: String,
    /// `(key, description)` in the order Kai is shown them.
    pub options: Vec<(String, String)>,
}

/// Kai's distribution over a question's options, abstain last.
#[derive(Debug, Clone, Serialize)]
pub struct Answer {
    pub id: String,
    pub probs: Vec<(String, f64)>,
}

impl Answer {
    /// The probability Kai gives to abstaining.
    pub fn abstain(&self) -> f64 {
        self.probs
            .iter()
            .find(|(k, _)| k == ABSTAIN)
            .map_or(0.0, |(_, p)| *p)
    }

    /// The real options (abstain left out) with their probabilities renormalized to sum to one,
    /// likeliest first.
    pub fn ranked(&self) -> Vec<(String, f64)> {
        let total: f64 = self
            .probs
            .iter()
            .filter(|(k, _)| k != ABSTAIN)
            .map(|(_, p)| *p)
            .sum();
        let mut v: Vec<(String, f64)> = self
            .probs
            .iter()
            .filter(|(k, _)| k != ABSTAIN)
            .map(|(k, p)| (k.clone(), if total > 0.0 { p / total } else { 0.0 }))
            .collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        v
    }

    /// The likeliest real option, its renormalized probability, and its lead over the next.
    pub fn best(&self) -> (String, f64, f64) {
        match self.ranked().as_slice() {
            [] => (String::new(), 0.0, 0.0),
            [only] => (only.0.clone(), only.1, only.1),
            [first, second, ..] => (first.0.clone(), first.1, first.1 - second.1),
        }
    }
}

/// What one request to Kai returned.
#[derive(Debug, Clone, Serialize)]
pub struct Asked {
    pub answers: Vec<Answer>,
    pub ms: f64,
    pub checkpoint: String,
}

/// Anything that can answer choices: Kai over HTTP, or a script in a test.
pub trait Chooser: Sync {
    fn decide(&self, request: &str, questions: &[Question]) -> Result<Asked, String>;
}

/// Kai at the Decisions API.
pub struct Kai {
    url: String,
    model: String,
    key: Option<String>,
    client: reqwest::blocking::Client,
}

impl Kai {
    /// Kai at `url` (`https://api.hanzo.ai/v1`, or a local `http://127.0.0.1:18977/v1`) as `model`.
    pub fn new(url: &str, model: &str, key: Option<String>) -> Kai {
        Kai {
            url: format!("{}/decisions", url.trim_end_matches('/')),
            model: model.to_string(),
            key,
            client: reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Chooser for Kai {
    fn decide(&self, request: &str, questions: &[Question]) -> Result<Asked, String> {
        let mut qs = serde_json::Map::new();
        for q in questions {
            let mut criteria = serde_json::Map::new();
            for (k, d) in &q.options {
                criteria.insert(k.clone(), Value::String(d.clone()));
            }
            criteria.insert(
                ABSTAIN.into(),
                Value::String("none of these fits, or the request does not say which".into()),
            );
            qs.insert(q.id.clone(), json!({ "type": "choice", "instructions": q.ask, "criteria": Value::Object(criteria) }));
        }
        let body = json!({ "model": self.model, "state": request, "questions": Value::Object(qs) });
        let started = Instant::now();
        let mut req = self.client.post(&self.url).json(&body);
        if let Some(key) = &self.key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().map_err(|e| e.without_url().to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e| e.without_url().to_string())?;
        if !status.is_success() {
            return Err(format!(
                "kai answered {status}: {}",
                crate::redact::cut(&text, 200)
            ));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("kai: not JSON: {e}"))?;
        let mut answers = Vec::new();
        for q in questions {
            let probs = v["answers"][&q.id]["probabilities"]
                .as_object()
                .ok_or_else(|| format!("kai: no distribution for {}", q.id))?;
            let mut keys: Vec<&str> = q.options.iter().map(|(k, _)| k.as_str()).collect();
            keys.push(ABSTAIN);
            let all: Option<Vec<(String, f64)>> = keys
                .iter()
                .map(|k| {
                    probs
                        .get(*k)
                        .and_then(Value::as_f64)
                        .map(|p| ((*k).to_string(), p))
                })
                .collect();
            answers.push(Answer {
                id: q.id.clone(),
                probs: all
                    .ok_or_else(|| format!("kai: a distribution for {} misses an option", q.id))?,
            });
        }
        Ok(Asked {
            answers,
            ms: started.elapsed().as_secs_f64() * 1000.0,
            checkpoint: v["routing"]["checkpoint"]
                .as_str()
                .or_else(|| v["model"].as_str())
                .unwrap_or("")
                .to_string(),
        })
    }
}

/// A chooser that answers from a table, for tests: `(question id, key)` gets probability 0.9.
pub struct Script(pub Vec<(String, String)>);

impl Chooser for Script {
    fn decide(&self, _request: &str, questions: &[Question]) -> Result<Asked, String> {
        let answers = questions
            .iter()
            .map(|q| {
                let want = self
                    .0
                    .iter()
                    .find(|(id, _)| *id == q.id)
                    .map_or(ABSTAIN, |(_, k)| k.as_str());
                let mut keys: Vec<&str> = q.options.iter().map(|(k, _)| k.as_str()).collect();
                keys.push(ABSTAIN);
                let rest = 0.1 / (keys.len().max(2) - 1) as f64;
                Answer {
                    id: q.id.clone(),
                    probs: keys
                        .iter()
                        .map(|k| ((*k).to_string(), if *k == want { 0.9 } else { rest }))
                        .collect(),
                }
            })
            .collect();
        Ok(Asked {
            answers,
            ms: 0.0,
            checkpoint: "script".into(),
        })
    }
}
