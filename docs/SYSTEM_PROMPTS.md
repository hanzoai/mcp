# System Prompts Guide

Hanzo MCP uses system prompts to guide AI assistants in helping with software engineering tasks. This document explains the system prompts available and how to use them.

## Available System Prompts

Hanzo MCP includes several system prompts optimized for different use cases:

1. **Standard MCP Prompt** (`prompts/mcp_system_prompt.txt`)
   - Main system prompt for general usage
   - Comprehensive tool usage guidance
   - Complete workflow for software engineering tasks

2. **IDE Integration Prompt** (`prompts/ide_system_prompt.txt`)
   - Specialized for IDE integration scenarios
   - Focuses on code suggestions rather than direct modifications
   - Formatted for IDE-friendly display

## Key Components of System Prompts

Each system prompt is divided into several sections:

### 1. Goal and Project Info
```
<goal>
I hope you can assist me with the project.
- {project_path}
</goal>

<project_info>
repo: {repo name}
owner: {git user name}
</project_info>
```

### 2. Standard Workflow
```
<standard_flow>
1. Plan: Propose a solution strategy with rationale and expected outcomes
2. Confirm: Describe your plan to the user and obtain permission before executing any tool
3. Implement: Execute the plan with appropriate tooling
4. Validate: Verify changes achieve the intended outcome
5. Learn: Document insights for future reference
</standard_flow>
```

### 3. Knowledge Continuity
Guidelines for maintaining context across sessions using the LLM.md file.

### 4. Tool Documentation
Detailed documentation for each available tool, including:
- Think tool
- Run command
- File operations
- Dispatch agent
- grep_ast (code structure search)

### 5. Special Guides
- Problem patterns
- Tool approaches
- Git workflows
- Design principles

## Using System Prompts

To use a specific system prompt:

```bash
hanzo-mcp --system-prompt /path/to/prompt/file.txt --allow-path /path/to/your/project
```

When integrating with Claude Desktop or other MCP clients, specify the system prompt file in the configuration settings.

## Customizing System Prompts

The system prompts can be customized to better fit your specific project needs:

1. **Replace Placeholders**:
   - `{project_path}`: Your project's absolute path
   - `{repo name}`: Your repository name
   - `{git user name}`: Your Git username

2. **Add Project-Specific Guidance**:
   - Coding standards
   - Architecture principles
   - Team workflows

3. **Modify Tool Guidelines**:
   - Adjust tool usage recommendations
   - Add custom tool documentation

For more detailed information, see the README in the `prompts/` directory.
