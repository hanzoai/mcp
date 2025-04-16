# USEFUL PROMPTS

## Summarizing history for continued next conversation.

```
Please provide a detailed yet concise summary of our conversation, focusing on key information for continuity.
Include what we've done, what we're currently working on, which files are involved, and the next steps.
Since previous tool-related memory will be lost in the next session, summarize the solutions provided so far.
Additionally, specify which files should be read at the start of our next discussion to maintain context.
Finally, outline the remaining tasks with clear instructions on how to complete them and include relevant examples as references.
```

## Automation Research Summary

```
Now you need to research one or more of the following functionalities, focusing on their design concepts, dependent components, and implementation methods. The ultimate goal of this research is to produce a detailed yet accurate description that includes which functionalities were studied and which files are relevant. This summary will be used at the start of other new conversations to provide Claude with quick and precise understanding of key focus areas for seamless onboarding and immediate work initiation. Therefore, make sure to list all related files at the end of the summary with instructions for Claude to read them in one go for efficiency.

Directly reply with a summary without writing to any files.

The topics you need to investigate include:
- {topic}
```

## Release a new version

```
Then review all commits from the last release version up to now and use them as the changelog for the new release. Help me publish the new version.
```

## Resume interrupted conversation.

```bash
git diff --staged --no-color | clp
```

```
You have actually already completed part of the code writing and folder creation, but because the execution was interrupted, please continue to complete the code you were working on. To help you continue, I've provided the git diff --staged --no-color information from the code you just wrote.
```
