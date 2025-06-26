File Operations
===============

Hanzo MCP provides a complete suite of file manipulation tools designed for safety and efficiency.

Overview
--------

.. list-table:: File Operation Tools
   :header-rows: 1
   :widths: 20 80

   * - Tool
     - Purpose
   * - ``read``
     - Read one or more files with automatic encoding detection
   * - ``write``
     - Create new files or overwrite existing ones
   * - ``edit``
     - Make precise line-based edits to existing files
   * - ``multi_edit``
     - Apply multiple edits to a single file atomically
   * - ``tree``
     - Display directory structure
   * - ``find``
     - Locate files by name pattern

Read Tool
---------

The ``read`` tool is your primary way to examine files.

Basic Usage
~~~~~~~~~~~

.. code-block:: text

    Read the main application file:
    → read src/app.py

Features
~~~~~~~~

**Automatic encoding detection**
    Handles UTF-8, Latin-1, and other encodings automatically

**Line range support**
    Read specific portions of large files::
    
        Read lines 100-150 of the log file:
        → read app.log --offset 100 --limit 50

**Multiple files**
    Read several files at once::
    
        Show me the test files:
        → read tests/test_user.py tests/test_auth.py

**Binary file handling**
    Safely handles binary files with appropriate messages

Write Tool
----------

Create new files or replace existing ones.

Basic Usage
~~~~~~~~~~~

.. code-block:: text

    Create a new configuration file:
    → write config/settings.yml with content:
      database:
        host: localhost
        port: 5432

Safety Features
~~~~~~~~~~~~~~~

- **Permission checks** before writing
- **Parent directory** creation if needed
- **Encoding specification** support
- **Binary content** handling

Edit Tool
---------

Make precise modifications to existing files.

Single Edit
~~~~~~~~~~~

.. code-block:: text

    Change a function name:
    → edit src/utils.py
      old: def calculate_total(
      new: def compute_total(

Multiple Occurrences
~~~~~~~~~~~~~~~~~~~~

.. code-block:: text

    Update all instances of a variable:
    → edit config.py
      old: DEBUG = True
      new: DEBUG = False
      replace_all: true

Pattern Matching
~~~~~~~~~~~~~~~~

The edit tool requires exact string matches including whitespace:

.. code-block:: python

    # Original code
    def process_data(input_list):
        return [x * 2 for x in input_list]
    
    # Edit command
    edit process.py
      old: "def process_data(input_list):"
      new: "def process_data(input_list: List[int]) -> List[int]:"

Multi-Edit Tool
---------------

Apply multiple changes to a file in one atomic operation.

Basic Usage
~~~~~~~~~~~

.. code-block:: text

    Refactor multiple imports and names:
    → multi_edit src/main.py with edits:
      - old: "from old_module import helper"
        new: "from new_module import helper"
      - old: "OLD_CONSTANT"
        new: "NEW_CONSTANT"
        replace_all: true

Benefits
~~~~~~~~

- **Atomic operations** - All edits succeed or none apply
- **Ordered execution** - Edits apply in sequence
- **Conflict prevention** - Ensures edits don't interfere

Tree Tool
---------

Visualize directory structures with Unix-style formatting.

Basic Usage
~~~~~~~~~~~

.. code-block:: text

    Show project structure:
    → tree

    Show only Python files:
    → tree --pattern "*.py"

Options
~~~~~~~

**Depth control**::

    tree src --depth 2

**Hidden files**::

    tree --show-hidden

**Directories only**::

    tree --dirs-only

**File sizes**::

    tree --show-size

Find Tool
---------

Locate files quickly using multiple search backends.

Basic Usage
~~~~~~~~~~~

.. code-block:: text

    Find all test files:
    → find "*test*.py"
    
    Find in specific directory:
    → find "*.js" src/

Backend Priority
~~~~~~~~~~~~~~~~

1. **ripgrep** (rg) - Fastest
2. **silver searcher** (ag) - Fast  
3. **ack** - Reliable
4. **find** command - Universal

Advanced Features
~~~~~~~~~~~~~~~~~

**Case sensitivity**::

    find "README" --case-sensitive

**File type filtering**::

    find "config" --type f  # files only
    find "tests" --type d   # directories only

Best Practices
--------------

File Reading
~~~~~~~~~~~~

1. **Read before editing** - Always examine files first
2. **Use line ranges** for large files
3. **Read multiple related files** together

Safe Editing
~~~~~~~~~~~~

1. **Preview changes** with grep before editing
2. **Use exact strings** including whitespace
3. **Test with single edit** before replace_all
4. **Use multi_edit** for complex refactoring

Performance Tips
~~~~~~~~~~~~~~~~

1. **Batch operations** when possible
2. **Use patterns** to limit file scope
3. **Leverage caching** for repeated reads

Common Patterns
---------------

**Rename across codebase**::

    # First find occurrences
    grep "OldClassName"
    
    # Then edit each file
    multi_edit file.py with edits:
      - old: "class OldClassName"
        new: "class NewClassName"
      - old: "OldClassName("
        new: "NewClassName("

**Add imports to multiple files**::

    # Find files needing the import
    grep "use_function" --include "*.py"
    
    # Add import to each
    edit file.py
      old: "import os\n"
      new: "import os\nfrom utils import use_function\n"

**Update configuration**::

    # Read current config
    read config/settings.json
    
    # Update values
    edit config/settings.json
      old: '"debug": true'
      new: '"debug": false'

Error Handling
--------------

**File not found**
    - Check path with ``tree`` or ``find``
    - Verify permissions with ``read``

**Edit pattern not found**
    - Use ``grep`` to verify exact text
    - Check whitespace and newlines
    - Consider using ``multi_edit``

**Permission denied**
    - Ensure path is in allowed directories
    - Check file permissions
    - Use appropriate flags

Related Tools
-------------

- :doc:`search-grep` - Find content within files
- :doc:`symbols-ast` - Navigate code structure  
- :doc:`git-integration` - Track file changes