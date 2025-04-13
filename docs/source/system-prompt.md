# System Prompt

The Hanzo MCP system prompt provides structure and guidance for AI assistants when working with software projects. This document explains the key components of the system prompt and how to customize it for your needs.

## Overview

The system prompt is divided into several sections, each serving a specific purpose in guiding the AI assistant:

- **Goal**: Specifies the overall objective for the AI assistant
- **Project Info**: Provides basic repository details
- **Standard Flow**: Outlines the process for handling requests
- **Knowledge Continuity**: Guidelines for maintaining project context
- **Best Practices**: Principles for effective problem-solving
- **Tools**: Descriptions of available tools and how to use them
- **Problem Patterns**: Common scenarios and approaches
- **Tool Approaches**: Methods for gathering information and modifying code
- **Git**: Guidelines for version control
- **Zen**: Philosophical principles for software development
- **User Commands**: Special commands the user can invoke
- **Special Format**: Instructions for formatting content

## Customizing the System Prompt

When using the system prompt with your own projects, you need to replace the placeholders:

- `{project_path}`: The absolute path to your project
- `{repo name}`: Your repository name
- `{git user name}`: Your Git username

## Standard Workflow

The standard workflow defined in the system prompt consists of six steps:

1. **Understand**: Analyze the request in the context of the project's architecture
2. **Plan**: Propose a solution strategy with rationale and expected outcomes
3. **Confirm**: Describe the plan to the user and obtain permission before executing it
4. **Implement**: Execute the plan with appropriate tooling
5. **Validate**: Verify changes achieve the intended outcome
6. **Learn**: Document insights for future reference

This structured approach ensures thorough analysis before making changes, clear communication with the user, and continuous learning.

## Knowledge Continuity Management

The system prompt instructs the AI assistant to maintain a `LLM.md` file in your project. This file:

- Contains key insights about your project architecture
- Tracks important implementation decisions
- Documents the evolution of your project structure
- Is updated as the AI assistant learns more about your project

This mechanism provides context persistence between sessions and serves as valuable documentation.

## Available Tools

The system prompt configures the AI assistant to use various tools:

- **Think Tool**: For complex reasoning or brainstorming
- **Run Command**: For executing shell commands
- **Read Files**: For accessing file contents
- **Edit File**: For making precise changes to files
- **Write File**: For creating or completely rewriting files
- **Dispatch Agent**: For parallel exploration tasks

Each tool has specific guidelines for optimal use.

## User Commands

The system prompt defines special commands that users can trigger, including:

- `/init`: Investigate project structure and generate LLM.md
- `/audit`: Perform compliance audit
- `/commit`: Confirm edits and commit changes
- `/plan`: Create implementation plan
- `/pr`: Create pull request
- `/version`: Display current Hanzo MCP version

And many more. These commands provide shortcuts for common operations.

## Full System Prompt

The complete system prompt is available in the `doc/system_prompt` file in your Hanzo MCP installation. You can customize this file to match your specific project needs and workflow preferences.