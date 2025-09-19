/// Tool for managing development modes with programmer personalities

use crate::tools::personality::{self, ToolPersonality};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use anyhow::Result;

#[derive(Debug, Serialize, Deserialize)]
pub struct ModeToolArgs {
    #[serde(default = "default_action")]
    pub action: String,
    pub name: Option<String>,
}

fn default_action() -> String {
    "list".to_string()
}

pub struct ModeTool;

impl ModeTool {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute(&self, args: ModeToolArgs) -> Result<String> {
        match args.action.as_str() {
            "list" => self.list_modes(),
            "activate" => self.activate_mode(args.name),
            "show" => self.show_mode(args.name),
            "current" => self.current_mode(),
            _ => Ok(format!(
                "Unknown action: {}. Use 'list', 'activate', 'show', or 'current'",
                args.action
            )),
        }
    }

    fn list_modes(&self) -> Result<String> {
        let modes = personality::api::list();
        if modes.is_empty() {
            return Ok("No modes registered".to_string());
        }

        let mut output = vec!["Available development modes (programmer personalities):".to_string()];
        let active = personality::api::get_active();
        let active_name = active.as_ref().map(|a| a.name.clone());

        // Group modes by category
        let categories = self.categorize_modes(&modes);

        for (category, mode_names) in categories {
            output.push(format!("\n{}:", category));
            for mode_name in mode_names {
                if let Some(mode) = modes.iter().find(|m| m.name == mode_name) {
                    let marker = if active_name.as_ref() == Some(&mode.name) {
                        " (active)"
                    } else {
                        ""
                    };
                    output.push(format!(
                        "  {}{}: {} - {}",
                        mode.name, marker, mode.programmer, mode.description
                    ));
                }
            }
        }

        output.push("\nUse 'mode --action activate <name>' to activate a mode".to_string());
        Ok(output.join("\n"))
    }

    fn activate_mode(&self, name: Option<String>) -> Result<String> {
        let name = name.ok_or_else(|| anyhow::anyhow!("Mode name required for activate action"))?;
        
        personality::api::set_active(&name)
            .map_err(|e| anyhow::anyhow!("{}", e))?;
        
        let mode = personality::api::get(&name)
            .ok_or_else(|| anyhow::anyhow!("Failed to retrieve activated mode"))?;

        let mut output = vec![format!("Activated mode: {}", mode.name)];
        output.push(format!("Programmer: {}", mode.programmer));
        output.push(format!("Description: {}", mode.description));
        
        if let Some(philosophy) = &mode.philosophy {
            output.push(format!("Philosophy: {}", philosophy));
        }
        
        output.push(format!("\nEnabled tools ({}):", mode.tools.len()));
        
        // Group tools by category
        let (core, package, ai, search, other) = self.categorize_tools(&mode.tools);
        
        if !core.is_empty() {
            output.push(format!("  Core: {}", core.join(", ")));
        }
        if !package.is_empty() {
            output.push(format!("  Package managers: {}", package.join(", ")));
        }
        if !ai.is_empty() {
            output.push(format!("  AI tools: {}", ai.join(", ")));
        }
        if !search.is_empty() {
            output.push(format!("  Search: {}", search.join(", ")));
        }
        if !other.is_empty() {
            output.push(format!("  Specialized: {}", other.join(", ")));
        }
        
        if let Some(environment) = &mode.environment {
            output.push("\nEnvironment variables:".to_string());
            for (key, value) in environment {
                output.push(format!("  {}={}", key, value));
            }
        }
        
        output.push("\nNote: Restart MCP session for changes to take full effect".to_string());
        
        Ok(output.join("\n"))
    }

    fn show_mode(&self, name: Option<String>) -> Result<String> {
        let name = name.ok_or_else(|| anyhow::anyhow!("Mode name required for show action"))?;
        
        let mode = personality::api::get(&name)
            .ok_or_else(|| anyhow::anyhow!("Mode '{}' not found", name))?;
        
        let mut output = vec![format!("Mode: {}", mode.name)];
        output.push(format!("Programmer: {}", mode.programmer));
        output.push(format!("Description: {}", mode.description));
        
        if let Some(philosophy) = &mode.philosophy {
            output.push(format!("Philosophy: {}", philosophy));
        }
        
        output.push(format!("\nTools ({}):", mode.tools.len()));
        for tool in &mode.tools {
            output.push(format!("  - {}", tool));
        }
        
        if let Some(environment) = &mode.environment {
            output.push("\nEnvironment:".to_string());
            for (key, value) in environment {
                output.push(format!("  {}={}", key, value));
            }
        }
        
        Ok(output.join("\n"))
    }

    fn current_mode(&self) -> Result<String> {
        match personality::api::get_active() {
            Some(active) => {
                let mut output = vec![format!("Current mode: {}", active.name)];
                output.push(format!("Programmer: {}", active.programmer));
                output.push(format!("Description: {}", active.description));
                
                if let Some(philosophy) = &active.philosophy {
                    output.push(format!("Philosophy: {}", philosophy));
                }
                
                output.push(format!("Enabled tools: {}", active.tools.len()));
                
                Ok(output.join("\n"))
            }
            None => Ok("No mode currently active\nUse 'mode --action activate <name>' to activate one".to_string()),
        }
    }

    fn categorize_modes(&self, _modes: &[ToolPersonality]) -> Vec<(&'static str, Vec<String>)> {
        vec![
            ("Language Creators", vec![
                "guido", "matz", "brendan", "dennis", "bjarne", 
                "james", "anders", "larry", "rasmus", "rich",
            ].into_iter().map(String::from).collect()),
            ("Systems & Infrastructure", vec![
                "linus", "rob", "ken", "bill", "richard",
                "brian", "donald", "graydon", "ryan", "mitchell",
            ].into_iter().map(String::from).collect()),
            ("Web & Frontend", vec![
                "tim", "douglas", "john", "evan", "jordan",
                "jeremy", "david", "taylor", "adrian", "matt",
            ].into_iter().map(String::from).collect()),
            ("Database & Data", vec![
                "michael_s", "michael_w", "salvatore", "dwight", "edgar",
                "jim_gray", "jeff_dean", "sanjay", "mike", "matei",
            ].into_iter().map(String::from).collect()),
            ("AI & Machine Learning", vec![
                "yann", "geoffrey", "yoshua", "andrew", "demis",
                "ilya", "andrej", "chris", "francois", "jeremy_howard",
            ].into_iter().map(String::from).collect()),
            ("Security & Cryptography", vec![
                "bruce", "phil", "whitfield", "ralph", "daniel_b",
                "moxie", "theo", "dan_kaminsky", "katie", "matt_blaze",
            ].into_iter().map(String::from).collect()),
            ("Gaming & Graphics", vec![
                "carmack", "john_carmack", "sid", "shigeru", "gabe",
                "markus", "jonathan", "casey", "tim_sweeney", "hideo", "will",
            ].into_iter().map(String::from).collect()),
            ("Open Source Leaders", vec![
                "miguel", "nat", "patrick", "ian", "mark_shuttleworth",
                "lennart", "bram", "daniel_r", "judd", "fabrice",
            ].into_iter().map(String::from).collect()),
            ("Modern Innovators", vec![
                "vitalik", "satoshi", "chris_lattner", "joe", "jose",
                "sebastian", "palmer", "dylan", "guillermo", "tom",
            ].into_iter().map(String::from).collect()),
            ("Special Configurations", vec![
                "fullstack", "minimal", "data_scientist", "devops", "security",
                "academic", "startup", "enterprise", "creative", "hanzo", "10x",
            ].into_iter().map(String::from).collect()),
        ]
    }

    fn categorize_tools(&self, tools: &[String]) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
        let mut core = Vec::new();
        let mut package = Vec::new();
        let mut ai = Vec::new();
        let mut search = Vec::new();
        let mut other = Vec::new();

        for tool in tools {
            match tool.as_str() {
                "read" | "write" | "edit" | "multi_edit" | "bash" | "tree" | "grep" => {
                    core.push(tool.clone());
                }
                "npx" | "uvx" | "pip" | "cargo" | "gem" => {
                    package.push(tool.clone());
                }
                "agent" | "consensus" | "critic" | "think" | "llm" => {
                    ai.push(tool.clone());
                }
                "search" | "symbols" | "git_search" => {
                    search.push(tool.clone());
                }
                _ => {
                    other.push(tool.clone());
                }
            }
        }

        (core, package, ai, search, other)
    }
}

/// MCP tool interface implementation
#[derive(Debug, Serialize, Deserialize)]
pub struct ModeToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl ModeToolDefinition {
    pub fn new() -> Self {
        Self {
            name: "mode".to_string(),
            description: "Manage development modes (programmer personalities). Actions: list (default), activate, show, current.\n\nUsage:\nmode\nmode --action list\nmode --action activate guido\nmode --action show linus\nmode --action current".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "activate", "show", "current"],
                        "default": "list",
                        "description": "Action to perform"
                    },
                    "name": {
                        "type": "string",
                        "description": "Mode name (for activate/show actions)"
                    }
                },
                "required": []
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_list_modes() {
        let tool = ModeTool::new();
        let args = ModeToolArgs {
            action: "list".to_string(),
            name: None,
        };
        
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Available development modes"));
        assert!(output.contains("guido"));
        assert!(output.contains("linus"));
    }

    #[tokio::test]
    async fn test_show_mode() {
        let tool = ModeTool::new();
        let args = ModeToolArgs {
            action: "show".to_string(),
            name: Some("hanzo".to_string()),
        };
        
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Mode: hanzo"));
        assert!(output.contains("Hanzo AI Default"));
    }

    #[tokio::test]
    async fn test_activate_mode() {
        let tool = ModeTool::new();
        let args = ModeToolArgs {
            action: "activate".to_string(),
            name: Some("minimal".to_string()),
        };
        
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Activated mode: minimal"));
        assert!(output.contains("Minimalist"));
    }

    #[tokio::test]
    async fn test_current_mode() {
        let tool = ModeTool::new();
        
        // Activate a mode first
        let activate_args = ModeToolArgs {
            action: "activate".to_string(),
            name: Some("guido".to_string()),
        };
        let _ = tool.execute(activate_args).await;
        
        // Now check current
        let args = ModeToolArgs {
            action: "current".to_string(),
            name: None,
        };
        
        let result = tool.execute(args).await;
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("Current mode: guido"));
    }
}