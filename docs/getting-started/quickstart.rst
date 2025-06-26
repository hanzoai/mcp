Quick Start Guide
=================

This guide will get you up and running with Hanzo MCP in 5 minutes.

Your First Session
------------------

Once Hanzo MCP is installed in Claude Desktop, you can start using it immediately:

1. **Open Claude Desktop** and select Hanzo MCP from the server dropdown

2. **Grant permissions** to your project directory::

    I want to work on my project at /Users/me/myproject

3. **Start coding** with natural language::

    Show me the project structure

Claude will use the ``tree`` tool to display your project layout.

Essential Commands
------------------

File Operations
~~~~~~~~~~~~~~~

**Read files**::

    Show me the contents of src/main.py

**Edit code**::

    Change the function name from getData to fetchData in api.py

**Create files**::

    Create a new test file for the user service

Search & Discovery
~~~~~~~~~~~~~~~~~~

**Find code patterns**::

    Find all TODO comments in the codebase

**Search symbols**::

    Where is the UserController class defined?

**Semantic search**::

    Find code related to authentication

Development Workflow
~~~~~~~~~~~~~~~~~~~~

**Run tests**::

    Run the test suite

**Execute commands**::

    Build the project and show me any errors

**Manage processes**::

    Start the development server in the background

Example: Complete Feature Development
-------------------------------------

Here's a real-world example of developing a new feature:

.. code-block:: text

    You: Add a new endpoint to get user statistics
    
    Claude: I'll help you add a user statistics endpoint. Let me start by examining 
    the current API structure.
    
    [Claude uses search to find existing endpoints]
    [Claude creates new files and updates routes]
    [Claude adds tests for the new endpoint]
    [Claude runs tests to verify]

Task Management
---------------

Hanzo MCP includes built-in task tracking::

    You: Let's refactor the database module
    
    Claude: I'll create a task list for this refactoring:
    1. Analyze current database structure
    2. Identify code smells
    3. Plan refactoring approach
    4. Implement changes
    5. Update tests
    6. Run full test suite

Best Practices
--------------

1. **Be specific** about file paths when possible
2. **Use natural language** - Claude understands context
3. **Leverage task management** for complex projects
4. **Review changes** before accepting them
5. **Use agents** for parallel tasks

Pro Tips
--------

**Batch operations**::

    Update all import statements from old_module to new_module

**Smart search**::

    Find the implementation of the payment processing logic

**Agent delegation**::

    Analyze this codebase and create comprehensive documentation

Common Workflows
----------------

**Bug Fixing**
    1. Describe the bug
    2. Claude searches for related code
    3. Claude identifies the issue
    4. Claude proposes and implements fix
    5. Claude runs tests

**Refactoring**
    1. Explain what needs refactoring
    2. Claude analyzes code structure
    3. Claude creates refactoring plan
    4. Claude implements changes incrementally
    5. Claude ensures tests pass

**New Features**
    1. Describe the feature
    2. Claude explores existing code
    3. Claude implements feature
    4. Claude adds tests
    5. Claude updates documentation

Next Steps
----------

- :doc:`first-project` - Walk through a complete project
- :doc:`../tools/file-operations` - Master file manipulation
- :doc:`../concepts/action-system` - Understand tool actions