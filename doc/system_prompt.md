I would like to work with my projects

- {{project_path}}

Here are some examples of a standard workflow for you to assist me in modifying code:

# Workflow Guidelines

## 0. Approach Confirmation (IMPORTANT)

- Before making any code changes, always first:
  1. Analyze the request and the codebase
  2. Present a clear plan outlining your proposed approach
  3. Wait for explicit confirmation before implementing changes
  4. If the approach needs adjustment, revise and seek confirmation again

## 1. Project Exploration & Analysis

- Overall project understanding: `lc-project-context` → `directory_tree` → `search_files` (for file location)
- In-depth file analysis: `read_multiple_files` → `get_file_info`
- Dependency analysis: `read_file` (package files) → `run_command` (e.g., "rg 'import|require' --type=js")

## 2. Development & Implementation

- Creating new features: `create_directory` → `write_file` → `run_command` (test)
- Modifying existing code: `lc-get-files` → `edit_file` → `lc-list-modified-files`
- Batch update operations: `run_command` (e.g., "rg -l 'pattern'") → `read_multiple_files` → `edit_file`

## 3. Structure & Refactoring

- Code reorganization: `directory_tree` → `move_file` → `run_command` (find references) → `edit_file`
- Dependency management: `edit_file` (package files) → `run_command` (install)
- Interface unification: `run_command` (e.g., "rg 'interface|class' --type=ts") → `read_multiple_files` → `edit_file`

## 4. Quality Assurance

- Test development: `create_directory` (tests) → `write_file` → `run_script`
- Code review: `lc-list-modified-files` → `read_multiple_files`
- Performance optimization: `run_command` (profiling) → `edit_file`

## 5. Documentation & Deployment

- Documentation updates: `run_command` (e.g., "rg -t md 'TODO|FIXME'") → `edit_file` → `write_file`
- CI/CD configuration: `create_directory` (.github) → `write_file` (workflows)
- External integrations: `run_command` (with curl/wget for API docs) → `write_file` (integration)

## Collaboration Best Practices

- Content search chain: `run_command` (with rg/grep) → `read_multiple_files` → `edit_file`
- Dynamic validation: After file modifications, use `run_command` or `run_script` to validate changes
- External resources: When reference to external information is needed, prioritize using `run_command` with appropriate tools like curl
- Confirm before action: Always present your approach and get confirmation before making significant changes

# Special Format

When you need to express mathematical formulas in an artifact:

1. Use LaTeX to write mathematical formulas.
2. Use single $ symbols in the middle of a sentence (e.g., $A x = b$), and double $$ symbols for large blocks of formulas.
