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
    Consensus,
    Agent,
    Summarize,
    Classify,
    Explain,
    Translate,
    Compare,
    Chain,
    Embed,
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
            "consensus" => Ok(Self::Consensus),
            "agent" => Ok(Self::Agent),
            "summarize" | "summary" => Ok(Self::Summarize),
            "classify" | "categorize" => Ok(Self::Classify),
            "explain" => Ok(Self::Explain),
            "translate" => Ok(Self::Translate),
            "compare" => Ok(Self::Compare),
            "chain" => Ok(Self::Chain),
            "embed" | "embedding" => Ok(Self::Embed),
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
    pub topic: Option<String>,
    pub perspectives: Option<usize>,
    pub goal: Option<String>,
    pub target: Option<String>,
    pub items: Option<String>,
    pub criteria: Option<String>,
    pub steps: Option<String>,
    pub content: Option<String>,
    pub audience: Option<String>,
}

pub struct ThinkToolDefinition {
    pub description: String,
    pub input_schema: Value,
}

impl ThinkToolDefinition {
    pub fn new() -> Self {
        Self {
            description: "LLM reasoning: think, critic, review, consensus, agent, summarize, classify, explain, translate, compare, chain, embed".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["think", "critic", "review", "consensus", "agent", "summarize", "classify", "explain", "translate", "compare", "chain", "embed", "help"],
                        "description": "LLM action"
                    },
                    "thought": { "type": "string", "description": "What to think about / critique" },
                    "context": { "type": "string", "description": "Additional context" },
                    "code": { "type": "string", "description": "Code to analyze (critic/review)" },
                    "language": { "type": "string", "description": "Programming language" },
                    "text": { "type": "string", "description": "Text for summarize/classify/explain" },
                    "question": { "type": "string", "description": "Question to answer" },
                    "categories": { "type": "array", "items": { "type": "string" }, "description": "Categories for classify" },
                    "topic": { "type": "string", "description": "Topic for consensus" },
                    "perspectives": { "type": "integer", "description": "Number of perspectives for consensus" },
                    "goal": { "type": "string", "description": "Goal for agent reasoning" },
                    "target": { "type": "string", "description": "Target format for translate" },
                    "items": { "type": "string", "description": "Items for compare" },
                    "criteria": { "type": "string", "description": "Criteria for compare" },
                    "steps": { "type": "string", "description": "Steps for chain-of-thought" },
                    "content": { "type": "string", "description": "Content for embed/translate" },
                    "audience": { "type": "string", "description": "Target audience for explain" }
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
            LlmAction::Consensus => self.consensus(&args).await,
            LlmAction::Agent => self.agent(&args).await,
            LlmAction::Summarize => self.summarize(&args).await,
            LlmAction::Classify => self.classify(&args).await,
            LlmAction::Explain => self.explain(&args).await,
            LlmAction::Translate => self.translate(&args).await,
            LlmAction::Compare => self.compare(&args).await,
            LlmAction::Chain => self.chain(&args).await,
            LlmAction::Embed => self.embed(&args).await,
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

    async fn consensus(&self, args: &ThinkToolArgs) -> Result<Value> {
        let topic = args.topic.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("topic or thought required"))?;
        let perspectives = args.perspectives.unwrap_or(3);
        let id = self.record("consensus", topic, args.context.as_deref()).await;
        Ok(json!({
            "ok": true,
            "data": { "id": id, "topic": topic, "perspectives": perspectives, "recorded": true,
                "hint": "Multi-perspective consensus reasoning recorded." },
            "error": null,
            "meta": { "tool": "think", "action": "consensus" }
        }))
    }

    async fn agent(&self, args: &ThinkToolArgs) -> Result<Value> {
        let goal = args.goal.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("goal or thought required"))?;
        let id = self.record("agent", goal, args.context.as_deref()).await;
        Ok(json!({
            "ok": true,
            "data": { "id": id, "goal": goal, "recorded": true,
                "hint": "Agent reasoning recorded. Execute planned steps." },
            "error": null,
            "meta": { "tool": "think", "action": "agent" }
        }))
    }

    async fn translate(&self, args: &ThinkToolArgs) -> Result<Value> {
        let content = args.content.as_deref()
            .or(args.text.as_deref())
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("content or text required"))?;
        let target = args.target.as_deref().unwrap_or("");
        Ok(json!({
            "ok": true,
            "data": { "input_length": content.len(), "target": target,
                "hint": "Translation recorded. Apply the translated version." },
            "error": null,
            "meta": { "tool": "think", "action": "translate" }
        }))
    }

    async fn compare(&self, args: &ThinkToolArgs) -> Result<Value> {
        let items = args.items.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("items or thought required"))?;
        Ok(json!({
            "ok": true,
            "data": { "items": items, "criteria": args.criteria,
                "hint": "Comparison recorded. Use analysis for decision." },
            "error": null,
            "meta": { "tool": "think", "action": "compare" }
        }))
    }

    async fn chain(&self, args: &ThinkToolArgs) -> Result<Value> {
        let steps = args.steps.as_deref()
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("steps or thought required"))?;
        let id = self.record("chain", steps, args.context.as_deref()).await;
        Ok(json!({
            "ok": true,
            "data": { "id": id, "recorded": true,
                "hint": "Chain-of-thought reasoning recorded. Follow logical progression." },
            "error": null,
            "meta": { "tool": "think", "action": "chain" }
        }))
    }

    async fn embed(&self, args: &ThinkToolArgs) -> Result<Value> {
        let content = args.content.as_deref()
            .or(args.text.as_deref())
            .or(args.thought.as_deref())
            .ok_or_else(|| anyhow!("content or text required"))?;
        Ok(json!({
            "ok": true,
            "data": { "input_length": content.len(),
                "hint": "Embedding placeholder. Use dedicated embedding service for production." },
            "error": null,
            "meta": { "tool": "think", "action": "embed" }
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
                    "consensus": "Multi-perspective reasoning (requires topic)",
                    "agent": "Agent-style reasoning (requires goal)",
                    "summarize": "Compress to summary (requires text)",
                    "classify": "Classify text (requires text, optional categories)",
                    "explain": "Explain code/concepts (requires text or code)",
                    "translate": "Translate between formats (requires content, target)",
                    "compare": "Compare items (requires items, optional criteria)",
                    "chain": "Chain-of-thought reasoning (requires steps)",
                    "embed": "Embedding placeholder (requires content)"
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
