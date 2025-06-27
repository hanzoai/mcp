# Complete List of Hanzo MCP Tools

## 🗂️ Filesystem Tools
1. **read** - Read file contents
2. **write** - Write content to files (can be disabled with --disable-write-tools)
3. **edit** - Edit existing files (can be disabled with --disable-write-tools)
4. **multi_edit** - Make multiple edits to a single file (can be disabled with --disable-write-tools)
5. **directory_tree** - Display directory structure
6. **grep** - Search file contents with regex (can be disabled with --disable-search-tools)
7. **grep_ast** - Search code with AST awareness (can be disabled with --disable-search-tools)
8. **git_search** - Search git repository content (can be disabled with --disable-search-tools)
9. **content_replace** - Replace content in files (can be disabled with --disable-write-tools)
10. **batch_search** - Batch search operations (can be disabled with --disable-search-tools)
11. **find_files** - Find files by name patterns
12. **unified_search** - Unified search across multiple methods (can be disabled with --disable-search-tools)

## 💻 Shell Tools
13. **run_command** - Execute shell commands (unified command execution)
14. **bash** - Execute bash commands
15. **npx** - Execute npx commands
16. **uvx** - Execute uvx commands
17. **process** - Manage processes
18. **open** - Open files/URLs in default applications
19. **pkill** - Kill processes by name
20. **logs** - View process logs

## 📓 Jupyter Tools
21. **notebook_read** - Read Jupyter notebook contents
22. **notebook_edit** - Edit Jupyter notebooks

## 🤖 Agent Tools
23. **dispatch_agent** - Delegate tasks to sub-agents (requires --enable-agent-tool or individual enable)

## ✅ Todo Tools
24. **todo_read** - Read todo list
25. **todo_write** - Write/update todo list

## 🧠 Thinking Tool
26. **think** - Structured thinking space for Claude

## 🔍 Vector Tools (disabled by default)
27. **vector_index** - Index content for vector search
28. **vector_search** - Search using vector embeddings

## 🗄️ Database Tools
29. **sql_query** - Execute SQL queries
30. **sql_search** - Search SQL databases
31. **sql_stats** - Get SQL database statistics
32. **graph_add** - Add nodes/edges to graph database
33. **graph_remove** - Remove nodes/edges from graph database
34. **graph_query** - Query graph database
35. **graph_search** - Search graph database
36. **graph_stats** - Get graph database statistics

## 🔌 MCP Tools
37. **mcp** - Unified MCP server management (add/remove/stats)
38. **mcp_add** - Add MCP server (legacy, disabled by default)
39. **mcp_remove** - Remove MCP server (legacy, disabled by default)
40. **mcp_stats** - MCP server statistics (legacy, disabled by default)

## 🖊️ Editor Tools
41. **neovim_edit** - Edit files in Neovim
42. **neovim_command** - Execute Neovim commands
43. **neovim_session** - Manage Neovim sessions

## 🤖 LLM Tools
44. **llm** - Unified LLM interface (uses available API keys)
45. **llm_legacy** - Legacy LLM tool (disabled by default)
46. **consensus** - Multi-LLM consensus (disabled by default)
47. **llm_manage** - Manage LLM settings (disabled by default)

## 🎛️ System Tools (always enabled)
48. **tool_enable** - Enable specific tools
49. **tool_disable** - Disable specific tools
50. **tool_list** - List all available tools
51. **stats** - System statistics
52. **palette_load** - Load tool palettes (configurations)

## 🔧 Utility Tools
53. **batch** - Execute multiple tool calls in sequence

## Default Configuration:
- Most tools are **enabled by default**
- Write tools can be disabled with `--disable-write-tools`
- Search tools can be disabled with `--disable-search-tools`
- Agent tool requires `--enable-agent-tool`
- Vector tools are disabled by default
- Legacy tools (mcp_add, mcp_remove, mcp_stats, llm_legacy, consensus, llm_manage) are disabled by default

## Palette System:
Tools can be configured using palettes:
- **default**: Standard configuration
- **minimal**: Only essential tools
- **dev**: Development-focused tools
- **pentesting**: Security-focused tools
- **data-science**: Jupyter and data analysis tools
- Custom palettes can be created

Total: **53+ tools** available in Hanzo MCP!