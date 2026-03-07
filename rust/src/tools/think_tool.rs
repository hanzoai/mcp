/// Unified LLM reasoning tool (HIP-0300)
///
/// Provides reasoning and intelligence capabilities:
/// - think: Record structured reasoning thoughts
/// - critic: Critical analysis and code review
/// - review: Balanced code review
/// - summarize: Compress text to summary
/// - classify: Classify text
/// - explain: Explain code/concepts
///
/// Wraps the think/critic functionality with HIP-0300 naming.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LlmAction {
    Think,
    Critic,
    Review,
    Summarize,
    Classify,
    Explain,
    Help,
}

impl Default for LlmAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for LlmAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "think" | "thought" => Ok(Self::Think),
            "critic" | "critique" | "criticize" => Ok(Self::Critic),
            "review" => Ok(Self::Review),
            "summarize" | "summary" => Ok(Self::Summarize),
            "classify" | "categorize" => Ok(Self::Classify),
            "explain" => Ok(Self::Explain),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThinkToolArgs {
    pub action: Option<String>,
    pub thought: Option<String>,
    pub context: Option<String>,
    pub code: Option<String>,
    pub language: Option<String>,
    pub text: Option<String>,
    pub question: Option<String>,
    pub categories: Option<Vec<String>>,
}

pub struct ThinkToolDefinition {
    pub description: String,
    pub input_schema: Value,
}

impl ThinkToolDefinition {
    pub fn new() -> Self {
        Self {
            description: "LLM reasoning: think, critic, review, summarize, classify, explain".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["think", "critic", "review", "summarize", "classify", "explain", "help"],
                        "description": "LLM action"
                    },
                    "thought": { "type": "string", "description": "What to think about / critique" },
                    "context": { "type": "string", "description": "Additional context" },
                    "code": { "type": "string", "description": "Code to analyze (critic/review)" },
                    "language": { "type": "string", "description": "Programming language" },
                    "text": { "type": "string", "description": "Text for summarize/classify/explain" },
                    "question": { "type": "string", "description": "Question to answer" },
                    "categories": { "type": "array", "items": { "type": "string" }, "description": "Categories for classify" }
                },
                "required": ["action"]
            }),
        }
    }
}

/// Entry in thinking journal
#[derive(Debug, Clone, Serialize)]
struct ThinkEntry {
    id: usize,
    action: String,
    thought: String,
    context: Option<String>,
    timestamp: String,
}

pub struct ThinkTool {
    journal: Arc<RwLock<Vec<ThinkEntry>>>,
    counter: Arc<RwLock<usize>>,
}

impl ThinkTool {
    pub fn new() -> Self {
        Self {
            journal: Arc::new(RwLock::new(Vec::new())),
            counter: Arc::new(RwLock::new(0)),
        }
    }

    pub async fn execute(&self, args: ThinkToolArgs) -> Result<Value> {
        let action: LlmAction = args.action.as_deref().unwrap_or("help").parse()?;

        match action {
            LlmAction::Think => self.think(&args).await,
            LlmAction::Critic => self.critic(&args).await,
            LlmAction::Review => self.review(&args).await,
            LlmAction::Summarize => self.summarize(&args).await,
            LlmAction::Classify => self.classify(&args).await,
            LlmAction::Explain => self.explain(&args).await,
            LlmAction::Help => Ok(self.help()),
        }
    }

    async fn record(&self, action: &str, thought: &str, context: Option<&str>) -> usize {
        let mut counter = self.counter.write().await;
        *counter += 1;
        let id = *counter;

        let entry = ThinkEntry {
            id,
            action: action.to_string(),
            thought: thought.to_string(),
            context: context.map(|s| s.to_string()),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        self.journal.write().await.push(entry);
        id
    }

    async fn think(&self, args: &ThinkToolArgs) -> Result<Value> {
        let thought = args.thought.as_deref()
            .or(args.question.as_deref())
            .ok_or_else(|| anyhow!("thought or question required"))?;

        let id = self.record("think", thought, args.context.as_deref()).await;

        Ok(json!({
            "ok": true,
            "data": {
                "id": id,
                "thought": thought,
                "recorded": true,
                "hint": "Use this tool to structure your reasoning. The thought is recorded but not sent to any LLM."
            },
            "error": null,
            "meta": { "tool": "think", "action": "think" }
        }))
    }

    async fn critic(&self, args: &ThinkToolArgs) -> Result<Value> {
        let thought = args.thought.as_deref()
            .or(args.code.as_deref())
            .ok_or_else(|| anyhow!("thought or code required"))?;

        let id = self.record("critic", thought, args.context.as_deref()).await;

        Ok(json!({
            "ok": true,
            "data": {
                "id": id,
                "input": thought,
                "recorded": true,
                "hint": "Critical analysis recorded. Use this to challenge assumptions and find flaws."
            },
            "error": null,
            "meta": { "tool": "think", "action": "critic" }
        }))
    }

    async fn review(&self, args: &ThinkToolArgs) -> Result<Value> {
        let code = args.code.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("code required"))?;

        let id = self.record("review", code, args.language.as_deref()).await;

        Ok(json!({
            "ok": true,
            "data": {
                "id": id,
                "code_length": code.len(),
                "language": args.language,
                "recorded": true,
                "hint": "Code review recorded. Use this for balanced analysis of code quality."
            },
            "error": null,
            "meta": { "tool": "think", "action": "review" }
        }))
    }

    async fn summarize(&self, args: &ThinkToolArgs) -> Result<Value> {
        let text = args.text.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("text required"))?;

        let words = text.split_whitespace().count();
        let chars = text.len();

        Ok(json!({
            "ok": true,
            "data": {
                "input_words": words,
                "input_chars": chars,
                "hint": "Summarization is a reasoning action — the LLM should produce the summary based on the input."
            },
            "error": null,
            "meta": { "tool": "think", "action": "summarize" }
        }))
    }

    async fn classify(&self, args: &ThinkToolArgs) -> Result<Value> {
        let text = args.text.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("text required"))?;

        Ok(json!({
            "ok": true,
            "data": {
                "text_length": text.len(),
                "categories": args.categories,
                "hint": "Classification is a reasoning action — the LLM should classify based on the input and categories."
            },
            "error": null,
            "meta": { "tool": "think", "action": "classify" }
        }))
    }

    async fn explain(&self, args: &ThinkToolArgs) -> Result<Value> {
        let text = args.text.as_deref()
            .or(args.code.as_deref())
            .or(args.question.as_deref())
            .ok_or_else(|| anyhow!("text, code, or question required"))?;

        Ok(json!({
            "ok": true,
            "data": {
                "input_length": text.len(),
                "language": args.language,
                "hint": "Explanation is a reasoning action — the LLM should explain based on the input."
            },
            "error": null,
            "meta": { "tool": "think", "action": "explain" }
        }))
    }

    fn help(&self) -> Value {
        json!({
            "ok": true,
            "data": {
                "tool": "think",
                "actions": {
                    "think": "Record structured reasoning (requires thought)",
                    "critic": "Critical analysis (requires thought or code)",
                    "review": "Balanced code review (requires code)",
                    "summarize": "Compress to summary (requires text)",
                    "classify": "Classify text (requires text, optional categories)",
                    "explain": "Explain code/concepts (requires text or code)"
                }
            },
            "error": null,
            "meta": { "tool": "think", "action": "help" }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_action_parse() {
        assert_eq!("think".parse::<LlmAction>().unwrap(), LlmAction::Think);
        assert_eq!("critic".parse::<LlmAction>().unwrap(), LlmAction::Critic);
        assert_eq!("summarize".parse::<LlmAction>().unwrap(), LlmAction::Summarize);
    }

    #[tokio::test]
    async fn test_llm_think() {
        let tool = ThinkTool::new();
        let result = tool.execute(ThinkToolArgs {
            action: Some("think".to_string()),
            thought: Some("Testing reasoning".to_string()),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["data"]["recorded"], true);
    }
}
