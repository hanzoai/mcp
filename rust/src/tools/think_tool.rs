/// Reasoning tools (HIP-0300)
///
/// Provides structured thinking capabilities:
/// - think: Record and log thoughts for complex reasoning
/// - critic: Critical analysis and devil's advocate
/// - review: Balanced code review

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Think action types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ThinkAction {
    Think,
    Critic,
    Review,
    Help,
}

impl Default for ThinkAction {
    fn default() -> Self {
        Self::Help
    }
}

impl std::str::FromStr for ThinkAction {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "think" | "thought" => Ok(Self::Think),
            "critic" | "criticize" | "critique" => Ok(Self::Critic),
            "review" => Ok(Self::Review),
            "help" | "" => Ok(Self::Help),
            _ => Err(anyhow!("Unknown action: {}", s)),
        }
    }
}

/// Review focus areas
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewFocus {
    General,
    Functionality,
    Readability,
    Maintainability,
    Testing,
    Documentation,
    Architecture,
    Security,
    Performance,
}

impl Default for ReviewFocus {
    fn default() -> Self {
        Self::General
    }
}

impl std::str::FromStr for ReviewFocus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_uppercase().as_str() {
            "GENERAL" => Ok(Self::General),
            "FUNCTIONALITY" => Ok(Self::Functionality),
            "READABILITY" => Ok(Self::Readability),
            "MAINTAINABILITY" => Ok(Self::Maintainability),
            "TESTING" => Ok(Self::Testing),
            "DOCUMENTATION" => Ok(Self::Documentation),
            "ARCHITECTURE" => Ok(Self::Architecture),
            "SECURITY" => Ok(Self::Security),
            "PERFORMANCE" => Ok(Self::Performance),
            _ => Ok(Self::General),
        }
    }
}

/// Thought record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThoughtRecord {
    pub id: usize,
    pub thought: String,
    pub timestamp: String,
    pub action: String,
}

/// Arguments for reasoning tools
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThinkToolArgs {
    #[serde(default)]
    pub action: String,
    /// The thought content
    pub thought: Option<String>,
    /// Analysis for critic
    pub analysis: Option<String>,
    /// Review focus area
    pub focus: Option<String>,
    /// Work description for review
    pub work_description: Option<String>,
    /// Code snippets to review
    pub code_snippets: Option<Vec<String>>,
    /// File paths modified
    pub file_paths: Option<Vec<String>>,
    /// Additional context
    pub context: Option<String>,
}

/// Reasoning tool
pub struct ThinkTool {
    thoughts: Arc<RwLock<Vec<ThoughtRecord>>>,
    counter: Arc<RwLock<usize>>,
}

impl ThinkTool {
    pub fn new() -> Self {
        Self {
            thoughts: Arc::new(RwLock::new(Vec::new())),
            counter: Arc::new(RwLock::new(0)),
        }
    }

    pub async fn execute(&self, args: ThinkToolArgs) -> Result<String> {
        let action: ThinkAction = if args.action.is_empty() {
            // Default based on provided args
            if args.thought.is_some() {
                ThinkAction::Think
            } else if args.analysis.is_some() {
                ThinkAction::Critic
            } else if args.work_description.is_some() {
                ThinkAction::Review
            } else {
                ThinkAction::Help
            }
        } else {
            args.action.parse()?
        };

        let result = match action {
            ThinkAction::Think => self.think(args).await?,
            ThinkAction::Critic => self.critic(args).await?,
            ThinkAction::Review => self.review(args).await?,
            ThinkAction::Help => self.help()?,
        };

        Ok(serde_json::to_string(&result)?)
    }

    async fn think(&self, args: ThinkToolArgs) -> Result<Value> {
        let thought = args.thought.ok_or_else(|| anyhow!("thought required"))?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut counter = self.counter.write().await;
        *counter += 1;
        let id = *counter;

        let record = ThoughtRecord {
            id,
            thought: thought.clone(),
            timestamp: now.clone(),
            action: "think".to_string(),
        };

        self.thoughts.write().await.push(record);

        // Log the thought
        log::debug!("THINK [{}]: {}", id, thought);

        Ok(json!({
            "id": id,
            "recorded": true,
            "thought": thought,
            "timestamp": now,
            "message": "Thought recorded. This helps with complex reasoning and brainstorming."
        }))
    }

    async fn critic(&self, args: ThinkToolArgs) -> Result<Value> {
        let analysis = args.analysis.ok_or_else(|| anyhow!("analysis required"))?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut counter = self.counter.write().await;
        *counter += 1;
        let id = *counter;

        let record = ThoughtRecord {
            id,
            thought: format!("[CRITIC] {}", analysis),
            timestamp: now.clone(),
            action: "critic".to_string(),
        };

        self.thoughts.write().await.push(record);

        // Parse the analysis to extract key points
        let sections = self.parse_critic_analysis(&analysis);

        Ok(json!({
            "id": id,
            "recorded": true,
            "analysis": analysis,
            "sections": sections,
            "timestamp": now,
            "message": "Critical analysis recorded. This helps ensure high quality standards."
        }))
    }

    fn parse_critic_analysis(&self, analysis: &str) -> Value {
        let mut sections = serde_json::Map::new();
        let mut current_section = String::new();
        let mut current_items: Vec<String> = Vec::new();

        for line in analysis.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // Check for section headers
            if line.ends_with(':') && !line.starts_with('-') && !line.starts_with('*') {
                if !current_section.is_empty() && !current_items.is_empty() {
                    sections.insert(current_section.clone(), json!(current_items.clone()));
                }
                current_section = line.trim_end_matches(':').to_string();
                current_items.clear();
            } else if line.starts_with('-') || line.starts_with('*') || line.starts_with("•") {
                current_items.push(line.trim_start_matches(|c| c == '-' || c == '*' || c == '•' || c == ' ').to_string());
            }
        }

        if !current_section.is_empty() && !current_items.is_empty() {
            sections.insert(current_section, json!(current_items));
        }

        Value::Object(sections)
    }

    async fn review(&self, args: ThinkToolArgs) -> Result<Value> {
        let work_description = args.work_description
            .ok_or_else(|| anyhow!("work_description required"))?;

        let focus: ReviewFocus = args.focus
            .as_deref()
            .map(|s| s.parse().unwrap_or_default())
            .unwrap_or_default();

        let now = chrono::Utc::now().to_rfc3339();

        let mut counter = self.counter.write().await;
        *counter += 1;
        let id = *counter;

        let record = ThoughtRecord {
            id,
            thought: format!("[REVIEW:{}] {}", format!("{:?}", focus).to_uppercase(), work_description),
            timestamp: now.clone(),
            action: "review".to_string(),
        };

        self.thoughts.write().await.push(record);

        // Build review context
        let mut review_context = serde_json::Map::new();
        review_context.insert("focus".to_string(), json!(format!("{:?}", focus)));
        review_context.insert("work_description".to_string(), json!(work_description));

        if let Some(snippets) = args.code_snippets {
            review_context.insert("code_snippets".to_string(), json!(snippets));
        }
        if let Some(paths) = args.file_paths {
            review_context.insert("file_paths".to_string(), json!(paths));
        }
        if let Some(ctx) = args.context {
            review_context.insert("additional_context".to_string(), json!(ctx));
        }

        Ok(json!({
            "id": id,
            "recorded": true,
            "focus": format!("{:?}", focus),
            "work_description": work_description,
            "review_context": Value::Object(review_context),
            "timestamp": now,
            "message": "Review request recorded. This provides balanced, constructive feedback."
        }))
    }

    fn help(&self) -> Result<Value> {
        Ok(json!({
            "name": "think",
            "version": "0.12.0",
            "description": "Reasoning tools for structured thinking (HIP-0300)",
            "actions": {
                "think": "Record thoughts for complex reasoning",
                "critic": "Critical analysis and devil's advocate",
                "review": "Balanced code review"
            },
            "review_focuses": [
                "GENERAL", "FUNCTIONALITY", "READABILITY", "MAINTAINABILITY",
                "TESTING", "DOCUMENTATION", "ARCHITECTURE", "SECURITY", "PERFORMANCE"
            ],
            "examples": {
                "think": "think(thought='Considering approach A vs B...')",
                "critic": "think(action='critic', analysis='Implementation Issues:\\n- No error handling...')",
                "review": "think(action='review', focus='FUNCTIONALITY', work_description='Added email validation')"
            }
        }))
    }
}

/// MCP Tool Definition
#[derive(Debug, Serialize, Deserialize)]
pub struct ThinkToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl ThinkToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "think".to_string(),
            description: r#"Reasoning tools for structured thinking (HIP-0300).

Actions:
- think: Record thoughts for complex reasoning
- critic: Critical analysis and devil's advocate
- review: Balanced code review

Use for brainstorming, planning complex changes, and ensuring quality."#.to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["think", "critic", "review", "help"],
                        "description": "Action to perform"
                    },
                    "thought": {
                        "type": "string",
                        "description": "The thought to record"
                    },
                    "analysis": {
                        "type": "string",
                        "description": "Critical analysis content"
                    },
                    "focus": {
                        "type": "string",
                        "enum": ["GENERAL", "FUNCTIONALITY", "READABILITY", "MAINTAINABILITY", "TESTING", "DOCUMENTATION", "ARCHITECTURE", "SECURITY", "PERFORMANCE"],
                        "description": "Review focus area"
                    },
                    "work_description": {
                        "type": "string",
                        "description": "Description of work to review"
                    },
                    "code_snippets": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Code snippets to review"
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "File paths modified"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context"
                    }
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_think() {
        let tool = ThinkTool::new();
        let args = ThinkToolArgs {
            action: "think".to_string(),
            thought: Some("This is a test thought about problem solving.".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("recorded"));
        assert!(output.contains("test thought"));
    }

    #[tokio::test]
    async fn test_critic() {
        let tool = ThinkTool::new();
        let args = ThinkToolArgs {
            action: "critic".to_string(),
            analysis: Some("Implementation Issues:\n- No error handling\n- Missing tests".to_string()),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("recorded"));
        // Message is "Critical analysis recorded" (capitalized)
        assert!(output.contains("Critical analysis"));
    }

    #[tokio::test]
    async fn test_review() {
        let tool = ThinkTool::new();
        let args = ThinkToolArgs {
            action: "review".to_string(),
            focus: Some("FUNCTIONALITY".to_string()),
            work_description: Some("Added email validation function".to_string()),
            code_snippets: Some(vec!["fn validate_email(email: &str) -> bool".to_string()]),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("recorded"));
        // Focus uses Debug format: "Functionality" (capitalized, not all caps)
        assert!(output.contains("Functionality"));
    }

    #[tokio::test]
    async fn test_help() {
        let tool = ThinkTool::new();
        let args = ThinkToolArgs {
            action: "help".to_string(),
            ..Default::default()
        };

        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("think"));
        assert!(output.contains("critic"));
        assert!(output.contains("review"));
    }
}
