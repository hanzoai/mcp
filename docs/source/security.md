# Security Guide

This document outlines security concerns and mitigation strategies for Hanzo MCP.

## Key Security Concerns

### 1. Permission Management Issues

- **One-Time Authorization**: Many implementations only request permission once for a tool, allowing subsequent operations to execute without user awareness.
- **Permission Scope Expansion**: Initial benign operations can establish permissions that later enable malicious actions.
- **Permission-Click Fatigue**: Users facing too many permission prompts may simply "Allow All," defeating security measures.

### 2. Inadvertent Double Agents

- **Arbitrary Code Execution**: Many MCP servers allow command execution, which can be abused through indirect means.
- **Indirect Prompt Injection**: Malicious instructions embedded in documents, websites, or messages can hijack AI assistants.
- **Cross-Tool Exploitation**: Attackers can use one tool to inject instructions that trigger actions in other tools.

### 3. Tool Combinations for Attacks

- **Exfiltration Chains**: Multiple legitimate tools combined can create data exfiltration pathways.
- **Permission Circumvention**: Tools with different permission models can be chained to bypass restrictions.
- **Unintended Interactions**: Design assumptions about how tools will interact may be violated by creative attackers.

### 4. Tool Name Typosquatting

- **Tool Overwriting**: Tools with identical names can overwrite each other, with the last loaded taking precedence.
- **Malicious Tool Substitution**: Attackers can replace legitimate tools with malicious ones sharing the same name.
- **Dynamic Tool Injection**: Remote MCP servers can inject malicious tools after initial trust is established.

## Current Security Features

Hanzo MCP includes several security features:

1. **PermissionManager**: Controls access to system resources with allowlists and denylists.
2. **Path Restrictions**: File operations limited to specifically allowed directories.
3. **Command Validation**: Basic validation of shell commands to prevent dangerous operations.
4. **Input Sanitization**: Measures to validate inputs and prevent injection attacks.
5. **Tool Registration Control**: Centralized tool registration process.

## Best Practices for Safe Usage

### 1. Limiting Exposed Directories

Always use the `--allow-path` parameter to restrict access to only the directories needed:

```bash
hanzo-mcp --allow-path /path/to/project
```

Avoid exposing sensitive directories like your home directory or system directories.

### 2. Using Read-Only Mode

For exploratory work, use the `--disable-write-tools` flag to prevent modifications:

```bash
hanzo-mcp --disable-write-tools --allow-path /path/to/project
```

### 3. Reviewing Commands Before Execution

Always review shell commands suggested by AI assistants before allowing them to execute.

### 4. Regular Updates

Keep Hanzo MCP updated to benefit from the latest security improvements:

```bash
uv pip install --upgrade hanzo-mcp
```

### 5. Secure API Key Management

Never hardcode API keys in your configuration. Instead, use environment variables or a secure key management solution.

## For Developers: Implementing Secure MCP Extensions

When developing tools or extensions for Hanzo MCP:

1. **Design with Security in Mind**
   - Always assume that input to tools may contain malicious content
   - Implement least privilege for all operations
   - Design tools to be stateless when possible
   - Avoid implementing tools that can modify system configuration

2. **Tool Implementation Guidelines**
   - Clearly define tool capabilities and scope
   - Implement fine-grained permission controls
   - Validate all inputs thoroughly
   - Limit file system and network access

3. **Testing and Validation**
   - Test tools with adversarial prompts and inputs
   - Conduct regular security reviews
   - Create attack scenarios to validate protection mechanisms
   - Maintain a security testing framework

## Reporting Security Issues

If you discover a security vulnerability in Hanzo MCP, please report it by emailing [security@hanzo.ai](mailto:security@hanzo.ai). Do not disclose the issue publicly until it has been addressed.