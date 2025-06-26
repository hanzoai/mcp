Tools Reference
===============

Hanzo MCP provides 65+ tools organized by category. Each tool follows the principle of **one tool per orthogonal task** with multiple actions where appropriate.

File System Tools
-----------------

read
~~~~
Read files with encoding detection and pagination.

.. code-block:: bash

    read /path/to/file.py
    read /path/to/file.py --offset 100 --limit 50

write
~~~~~
Create or overwrite files.

.. code-block:: bash

    write /path/to/file.py --content "# New file content"

edit
~~~~
Precise line-based edits with pattern matching.

.. code-block:: bash

    edit /path/to/file.py --old "def old_func" --new "def new_func"
    edit /path/to/file.py --old "OLD_VAR" --new "NEW_VAR" --replace_all

multi_edit
~~~~~~~~~~
Batch edits to a single file.

.. code-block:: bash

    multi_edit /path/to/file.py --edits '[
      {"old": "import old", "new": "import new"},
      {"old": "OLD_CONST", "new": "NEW_CONST", "replace_all": true}
    ]'

tree
~~~~
Unix-style directory tree visualization.

.. code-block:: bash

    tree
    tree ./src --depth 2
    tree --dirs-only
    tree --pattern "*.py" --show-size

find
~~~~
Fast file finding with multiple backends (rg > ag > ack > grep).

.. code-block:: bash

    find "*.py"
    find "test_*.py" --type f
    find "src" --type d

Search Tools
------------

grep
~~~~
Fast pattern search using ripgrep.

.. code-block:: bash

    grep "TODO" --include "*.py"
    grep "def.*test" --regex

symbols
~~~~~~~
AST-aware symbol search using tree-sitter.

.. code-block:: bash

    symbols "class.*Controller"
    symbols "def process" --type function

search
~~~~~~
Multi-modal search combining text, vector, AST, git, and symbols.

.. code-block:: bash

    search "authentication logic"
    search "bug fix" --type git

git_search
~~~~~~~~~~
Search through git history.

.. code-block:: bash

    git_search "bug fix" --type commit
    git_search "TODO" --type diff
    git_search "auth" --type blame

vector_search
~~~~~~~~~~~~~
Semantic similarity search using embeddings.

.. code-block:: bash

    vector_search "user authentication flow"
    vector_search "database connection handling"

Shell & Process Tools
---------------------

run_command
~~~~~~~~~~~
Execute shell commands with timeout and environment control.

.. code-block:: bash

    run_command "npm test"
    run_command "python script.py" --timeout 30

run_background
~~~~~~~~~~~~~~
Background process execution.

.. code-block:: bash

    run_background "python server.py" --name myserver
    run_background "npm run dev" --name frontend

processes
~~~~~~~~~
List and monitor running processes.

.. code-block:: bash

    processes
    processes --filter python
    processes --sort cpu

pkill
~~~~~
Terminate processes by name/pattern.

.. code-block:: bash

    pkill myserver
    pkill "python.*test"

npx
~~~
Run Node.js packages directly.

.. code-block:: bash

    npx prettier --write "**/*.js"
    npx create-react-app my-app

uvx
~~~
Run Python packages directly.

.. code-block:: bash

    uvx ruff check
    uvx black --check .

Database Tools
--------------

sql
~~~
SQL database operations with actions.

.. code-block:: bash

    sql --action query --query "SELECT * FROM users"
    sql --action search --pattern "john@example.com"
    sql --action stats

graph
~~~~~
Graph database operations with actions.

.. code-block:: bash

    graph --action add --node '{"id": "user1", "name": "John"}'
    graph --action query --query "MATCH (n:User) RETURN n"
    graph --action stats

Development Tools
-----------------

jupyter
~~~~~~~
Jupyter notebook operations.

.. code-block:: bash

    jupyter --action read notebook.ipynb
    jupyter --action edit notebook.ipynb --cell 0 --content "print('Hello')"

neovim
~~~~~~
Advanced text editing with Vim.

.. code-block:: bash

    neovim --file /path/to/file.py --command ":%s/old/new/g"

todo
~~~~
Task management with actions.

.. code-block:: bash

    todo --action read
    todo --action write --tasks '[{"content": "Fix bug", "priority": "high"}]'

AI/Agent Tools
--------------

agent
~~~~~
Launch specialized sub-agents for task delegation.

.. code-block:: bash

    agent --prompt "Refactor this module" --files '["src/module.py"]'
    agent --prompt "Add tests" --model gpt-4

llm
~~~
Query multiple LLM providers with actions.

.. code-block:: bash

    llm --action query --prompt "Explain this code"
    llm --action list
    llm --action consensus --prompt "Is this secure?"

mcp
~~~
Manage MCP server connections.

.. code-block:: bash

    mcp --action add --server "github" --url "npx @github/mcp-server"
    mcp --action list
    mcp --action remove --server "github"

System Tools
------------

config
~~~~~~
Git-style configuration management.

.. code-block:: bash

    config index.scope
    config --action set index.scope project
    config --action list
    config --action toggle index.scope

stats
~~~~~
System and usage statistics.

.. code-block:: bash

    stats
    stats --format json

tool_enable / tool_disable
~~~~~~~~~~~~~~~~~~~~~~~~~~
Dynamic tool management.

.. code-block:: bash

    tool_disable todo
    tool_enable todo
    tool_list

batch
~~~~~
Execute multiple operations atomically.

.. code-block:: bash

    batch --invocations '[
      {"tool": "read", "params": {"file": "src/main.py"}},
      {"tool": "edit", "params": {"file": "src/main.py", "old": "v1", "new": "v2"}}
    ]'

think
~~~~~
Structured reasoning space.

.. code-block:: bash

    think --thought "Planning refactoring approach for authentication module"