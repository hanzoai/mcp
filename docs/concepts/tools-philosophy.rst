Tools Philosophy
================

Hanzo AI follows a carefully designed philosophy that makes it powerful yet simple to use.

Core Principles
---------------

One Tool, One Purpose
~~~~~~~~~~~~~~~~~~~~~

Each tool in Hanzo AI does exactly one thing well:

- ``read`` - reads files
- ``write`` - writes files  
- ``edit`` - edits existing files
- ``grep`` - searches text patterns
- ``tree`` - shows directory structure

This Unix-inspired approach means:

- **Predictable behavior** - You know what each tool does
- **Composability** - Tools work together naturally
- **Simplicity** - No feature creep or confusion

Action-Based Architecture
~~~~~~~~~~~~~~~~~~~~~~~~~

Complex tools support multiple actions through a interface:

.. code-block:: yaml

    sql:
      actions:
        - query: Execute SQL queries
        - search: Search database content
        - stats: Get database statistics
    
    llm:
      actions:
        - query: Query a specific model
        - list: List available models
        - consensus: Get consensus from multiple models

Benefits:

- **Fewer tools** to remember
- **Related operations** grouped logically
- **Consistent interface** across actions

Intelligent Defaults
~~~~~~~~~~~~~~~~~~~~

Tools make smart decisions so you don't have to:

**Search backends** (in order of preference):
  1. ``ripgrep`` (rg) - Fastest
  2. ``silver searcher`` (ag) - Fast
  3. ``ack`` - Reliable
  4. ``grep`` - Universal fallback

**File encoding**:
  - Auto-detects UTF-8, Latin-1, etc.
  - Handles binary files gracefully

**Context awareness**:
  - Git repository detection
  - Project type inference
  - Framework-specific patterns

Orthogonal Design
-----------------

No Overlapping Functionality
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Each tool has a distinct purpose with no overlap:

❌ **Bad Design** (overlapping tools)::

    search_files - searches in files
    find_in_files - finds text in files  
    grep_files - greps in files
    
✅ **Good Design** (orthogonal tools)::

    grep - text pattern search
    find - file name search
    symbols - AST symbol search
    vector_search - semantic search

Clear Tool Boundaries
~~~~~~~~~~~~~~~~~~~~~

Tools have well-defined boundaries:

**File Tools**
  - ``read``, ``write``, ``edit``, ``multi_edit``
  - Focus: File content manipulation

**Search Tools**
  - ``grep``, ``find``, ``symbols``, ``search``
  - Focus: Discovery and navigation

**Shell Tools**
  - ``run_command``, ``processes``, ``pkill``
  - Focus: System interaction

Composability
-------------

Tools as Building Blocks
~~~~~~~~~~~~~~~~~~~~~~~~

Simple tools combine for complex operations:

.. code-block:: text

    # Find files → Read content → Edit matches
    find "*.py" → read → edit pattern
    
    # Search code → Analyze → Refactor
    symbols "class.*Model" → agent analyze → multi_edit
    
    # Git search → Review → Fix
    git_search "bug" → read context → edit fix

Natural Language Integration
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Tools map naturally to human intent:

.. code-block:: text

    Human: "Find all test files"
    → find "*test*.py"
    
    Human: "Show me the database schema"
    → sql --action stats
    
    Human: "Search for authentication logic"
    → search "auth" (combines multiple strategies)

Performance Philosophy
----------------------

Parallel by Default
~~~~~~~~~~~~~~~~~~~

Operations run concurrently when possible:

- Multiple file reads
- Parallel search strategies
- Concurrent agent execution

Lazy Evaluation
~~~~~~~~~~~~~~~

Tools do minimal work until needed:

- Read files in chunks
- Search stops at max results
- Indexes built on demand

Caching Strategy
~~~~~~~~~~~~~~~~

Smart caching reduces redundant work:

- Git metadata cached
- Vector embeddings persisted
- Search results remembered

Security Philosophy
-------------------

Principle of Least Privilege
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Tools request only necessary permissions:

- Read-only tools can't write
- Path-based access control
- Explicit command approval

Fail-Safe Defaults
~~~~~~~~~~~~~~~~~~

Conservative behavior protects your code:

- No overwrites without confirmation
- Backup before dangerous operations
- Clear error messages

Audit Trail
~~~~~~~~~~~

All operations are traceable:

- Tool invocations logged
- File changes tracked
- Commands recorded

Evolution Strategy
------------------

Backward Compatibility
~~~~~~~~~~~~~~~~~~~~~~

New features don't break existing workflows:

- Tools maintain stable interfaces
- Actions can be added, not changed
- Deprecation warnings before removal

Community-Driven
~~~~~~~~~~~~~~~~

Tool development follows user needs:

- Real-world usage drives design
- Community feedback shapes features
- Open development process

Summary
-------

The Hanzo AI philosophy creates a system that is:

- **Simple** - One tool per task
- **Powerful** - Tools compose naturally  
- **Fast** - Optimized for performance
- **Secure** - Safe by default
- **Extensible** - Easy to enhance

This philosophy ensures Hanzo AI remains the most effective way to enhance Claude's capabilities for software development.