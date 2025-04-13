# Useful Prompts

This document provides a collection of useful prompts for various scenarios when working with Hanzo MCP.

## Summarizing Session for Continuity

Use this prompt when you want to summarize the current session for continued work in a future session:

```
Please provide a detailed yet concise summary of our conversation, focusing on key information for continuity.
Include what we've done, what we're currently working on, which files are involved, and the next steps.
Since previous tool-related memory will be lost in the next session, summarize the solutions provided so far.
Additionally, specify which files should be read at the start of our next discussion to maintain context.
Finally, outline the remaining tasks with clear instructions on how to complete them and include relevant examples as references.
```

## Automation Research Summary

When you need to research specific functionality within a project:

```
Now you need to research one or more of the following functionalities, focusing on their design concepts, dependent components, and implementation methods. The ultimate goal of this research is to produce a detailed yet accurate description that includes which functionalities were studied and which files are relevant. This summary will be used at the start of other new conversations to provide Claude with quick and precise understanding of key focus areas for seamless onboarding and immediate work initiation. Therefore, make sure to list all related files at the end of the summary with instructions for Claude to read them in one go for efficiency.

Directly reply with a summary without writing to any files.

The topics you need to investigate include:
- {topic}
```

Replace `{topic}` with the functionality you want to research.

## Releasing a New Version

When you want to publish a new version:

```
Then review all commits from the last release version up to now and use them as the changelog for the new release. Help me publish the new version.
```

## Resuming an Interrupted Conversation

If your AI assistant session was interrupted during code writing:

```bash
git diff --staged --no-color | clp
```

Then:

```
You have actually already completed part of the code writing and folder creation, but because the execution was interrupted, please continue to complete the code you were working on. To help you continue, I've provided the git diff --staged --no-color information from the code you just wrote.
```

## Project Analysis

For a comprehensive analysis of a project structure:

```
Analyze the entire project structure and provide me with:
1. An overview of the main components and their relationships
2. Key design patterns used in the codebase
3. Important dependencies and how they're integrated
4. Potential areas for improvement or refactoring
5. Any security concerns you might identify

Focus on high-level architecture rather than implementation details.
```

## Code Review

For reviewing code changes:

```
Perform a detailed code review of the changes I've made in [file path]. Please:
1. Check for any bugs or logic errors
2. Suggest performance improvements
3. Identify security concerns
4. Recommend clearer naming or better documentation
5. Point out any violations of best practices or coding standards
```

## Debugging Assistance

When troubleshooting an issue:

```
I'm encountering an error in my code. Here's the error message and relevant code snippet:

[Error message]
[Code snippet]

Please help me:
1. Understand what's causing this error
2. Identify the root issue
3. Suggest potential fixes
4. Explain how to prevent similar errors in the future
```

## Feature Implementation Planning

When planning a new feature:

```
I need to implement [feature description]. Please help me plan this implementation by:
1. Breaking down the task into smaller, manageable steps
2. Identifying which existing components will need to be modified
3. Suggesting any new components that need to be created
4. Outlining a testing strategy for the feature
5. Pointing out potential challenges or edge cases I should consider
```

## Refactoring Planning

When planning a refactoring effort:

```
I need to refactor [code description] to improve [maintenance/performance/readability]. Please help me:
1. Identify the core issues with the current implementation
2. Outline a step-by-step refactoring approach
3. Suggest specific patterns or techniques that would improve the code
4. Recommend ways to ensure the refactoring doesn't introduce bugs
5. Provide examples of how the refactored code might look
```

## Documentation Generation

When you need to generate documentation for code:

```
Please help me create clear documentation for [function/class/module]. I need:
1. A high-level overview of its purpose
2. Detailed explanations of parameters, return values, and exceptions
3. Usage examples that demonstrate common scenarios
4. Notes on any important edge cases or limitations
5. How it integrates with other components in the system
```