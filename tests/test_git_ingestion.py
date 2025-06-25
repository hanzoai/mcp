"""Tests for Git history ingestion into vector store."""

import pytest
import tempfile
import subprocess
import os
from pathlib import Path
from datetime import datetime
import json

from hanzo_mcp.tools.vector.infinity_store import InfinityVectorStore
from hanzo_mcp.tools.vector.project_manager import ProjectVectorManager
from hanzo_mcp.tools.common.permissions import PermissionManager


class TestGitIngestion:
    """Test suite for ingesting git repositories."""
    
    @pytest.fixture
    def test_git_repo(self):
        """Create a test git repository with history."""
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_path = Path(tmpdir)
            
            # Initialize git repo
            subprocess.run(["git", "init"], cwd=repo_path, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_path, check=True)
            subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo_path, check=True)
            
            # Create initial commit
            readme = repo_path / "README.md"
            readme.write_text("# Test Project\n\nThis is a test project for git ingestion.")
            subprocess.run(["git", "add", "README.md"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=repo_path, check=True)
            
            # Add Python file
            main_py = repo_path / "main.py"
            main_py.write_text('''#!/usr/bin/env python3
"""Main application file."""

def main():
    """Entry point."""
    print("Hello, World!")
    
if __name__ == "__main__":
    main()
''')
            subprocess.run(["git", "add", "main.py"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "Add main.py"], cwd=repo_path, check=True)
            
            # Add more files and commits
            utils_py = repo_path / "utils.py"
            utils_py.write_text('''"""Utility functions."""

def format_string(s):
    """Format a string."""
    return s.strip().title()

def calculate_sum(numbers):
    """Calculate sum of numbers."""
    return sum(numbers)
''')
            subprocess.run(["git", "add", "utils.py"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "Add utility functions"], cwd=repo_path, check=True)
            
            # Modify existing file
            main_py.write_text('''#!/usr/bin/env python3
"""Main application file."""

from utils import format_string

def main():
    """Entry point."""
    message = format_string("  hello, world!  ")
    print(message)
    
def run():
    """Run the application."""
    main()
    
if __name__ == "__main__":
    run()
''')
            subprocess.run(["git", "add", "main.py"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "Update main.py to use utils"], cwd=repo_path, check=True)
            
            # Create a feature branch
            subprocess.run(["git", "checkout", "-b", "feature/testing"], cwd=repo_path, check=True)
            
            test_py = repo_path / "test_main.py"
            test_py.write_text('''"""Tests for main module."""

import unittest
from main import main

class TestMain(unittest.TestCase):
    def test_main(self):
        """Test main function."""
        # This is a simple test
        self.assertTrue(True)
''')
            subprocess.run(["git", "add", "test_main.py"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "Add tests"], cwd=repo_path, check=True)
            
            # Switch back to main branch
            subprocess.run(["git", "checkout", "main"], cwd=repo_path, check=True)
            
            yield repo_path
    
    def test_git_log_parsing(self, test_git_repo):
        """Test parsing git log output."""
        # Get git log
        result = subprocess.run(
            ["git", "log", "--pretty=format:%H|%an|%ae|%at|%s", "--name-status"],
            cwd=test_git_repo,
            capture_output=True,
            text=True,
            check=True
        )
        
        commits = []
        current_commit = None
        
        for line in result.stdout.strip().split('\n'):
            if '|' in line and len(line.split('|')) == 5:
                # Commit line
                hash_, author, email, timestamp, message = line.split('|')
                current_commit = {
                    'hash': hash_,
                    'author': author,
                    'email': email,
                    'timestamp': int(timestamp),
                    'message': message,
                    'files': []
                }
                commits.append(current_commit)
            elif line and current_commit and '\t' in line:
                # File change line
                parts = line.split('\t')
                if len(parts) >= 2:
                    status, filename = parts[0], parts[1]
                    current_commit['files'].append({
                        'status': status,
                        'filename': filename
                    })
        
        assert len(commits) >= 4  # Should have at least 4 commits
        assert any(c['message'] == 'Initial commit' for c in commits)
        assert any(c['message'] == 'Add main.py' for c in commits)
        assert any('utils' in c['message'] for c in commits)
    
    def test_git_diff_extraction(self, test_git_repo):
        """Test extracting diffs from git history."""
        # Get diff for a specific commit
        result = subprocess.run(
            ["git", "log", "-1", "-p", "--format=%H"],
            cwd=test_git_repo,
            capture_output=True,
            text=True,
            check=True
        )
        
        assert "diff --git" in result.stdout
        assert "@@" in result.stdout  # Diff chunks
    
    def test_git_blame_integration(self, test_git_repo):
        """Test git blame for line-level attribution."""
        # Run git blame on main.py
        result = subprocess.run(
            ["git", "blame", "--line-porcelain", "main.py"],
            cwd=test_git_repo,
            capture_output=True,
            text=True,
            check=True
        )
        
        blame_data = {}
        current_commit = None
        current_line = None
        
        for line in result.stdout.strip().split('\n'):
            if line and not line.startswith('\t'):
                parts = line.split(' ')
                if len(parts) >= 3 and len(parts[0]) == 40:  # SHA-1 hash
                    current_commit = parts[0]
                    current_line = int(parts[2])
                elif line.startswith('author '):
                    author = line[7:]
                    if current_line:
                        blame_data[current_line] = {
                            'commit': current_commit,
                            'author': author
                        }
        
        assert len(blame_data) > 0
        assert any('Test User' in data['author'] for data in blame_data.values())
    
    def test_full_repo_ingestion(self, test_git_repo):
        """Test ingesting an entire repository into vector store."""
        with tempfile.TemporaryDirectory() as vector_dir:
            store = InfinityVectorStore(data_path=vector_dir)
            
            # Ingest all Python files
            python_files = list(test_git_repo.rglob("*.py"))
            assert len(python_files) >= 2
            
            total_docs = 0
            for py_file in python_files:
                doc_ids = store.add_file(str(py_file), chunk_size=500)
                total_docs += len(doc_ids)
            
            assert total_docs > 0
            
            # Search for content
            results = store.search("main function", limit=5)
            assert len(results) > 0
            
            # Search for imports
            import_results = store.search("from utils import", limit=5)
            assert len(import_results) > 0
            
            store.close()
    
    def test_git_metadata_extraction(self, test_git_repo):
        """Test extracting and storing git metadata."""
        # Get file history
        result = subprocess.run(
            ["git", "log", "--follow", "--pretty=format:%H|%at|%s", "main.py"],
            cwd=test_git_repo,
            capture_output=True,
            text=True,
            check=True
        )
        
        history = []
        for line in result.stdout.strip().split('\n'):
            if line:
                parts = line.split('|')
                if len(parts) == 3:
                    history.append({
                        'commit': parts[0],
                        'timestamp': int(parts[1]),
                        'message': parts[2]
                    })
        
        assert len(history) >= 2  # main.py was modified at least twice
        
        # Create metadata for vector store
        metadata = {
            'file_path': 'main.py',
            'history_count': len(history),
            'first_commit': history[-1]['commit'] if history else None,
            'last_commit': history[0]['commit'] if history else None,
            'last_modified': datetime.fromtimestamp(history[0]['timestamp']).isoformat() if history else None
        }
        
        assert metadata['history_count'] >= 2
        assert metadata['first_commit'] != metadata['last_commit']


class TestGitProjectManager:
    """Test project manager with git repositories."""
    
    @pytest.fixture
    def project_manager(self):
        """Create a project manager."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = ProjectVectorManager(global_db_path=str(Path(tmpdir) / "global_db"))
            yield manager, tmpdir
    
    def test_detect_git_project(self, project_manager):
        """Test detecting git projects."""
        manager, base_dir = project_manager
        
        # Create a test git repo
        repo_dir = Path(base_dir) / "test_repo"
        repo_dir.mkdir()
        
        # Initialize git
        subprocess.run(["git", "init"], cwd=repo_dir, check=True)
        
        # Create LLM.md file to mark it as a project
        llm_md = repo_dir / "LLM.md"
        llm_md.write_text("# Test Project\n\nThis is a test project with git history.")
        
        # Get project info - this will detect the project
        project_info = manager.get_project_for_path(str(repo_dir))
        assert project_info is not None
        assert project_info.name == "test_repo"
        assert project_info.llm_md_path.name == "LLM.md"
        
        # Check if .git directory is detected
        git_dir = repo_dir / ".git"
        assert git_dir.exists()
        assert git_dir.is_dir()


class TestGitDiffIngestion:
    """Test ingesting git diffs for code evolution tracking."""
    
    def test_parse_unified_diff(self):
        """Test parsing unified diff format."""
        diff_text = """diff --git a/main.py b/main.py
index 1234567..abcdefg 100644
--- a/main.py
+++ b/main.py
@@ -1,5 +1,6 @@
 def hello():
-    print("Hello")
+    print("Hello, World!")
+    return True
 
 def goodbye():
     print("Goodbye")
"""
        
        # Parse diff
        changes = []
        current_file = None
        
        for line in diff_text.strip().split('\n'):
            if line.startswith('diff --git'):
                parts = line.split()
                if len(parts) >= 4:
                    current_file = parts[2][2:]  # Remove 'a/' prefix
            elif line.startswith('@@'):
                # Parse chunk header
                import re
                match = re.match(r'@@ -(\d+),(\d+) \+(\d+),(\d+) @@', line)
                if match:
                    changes.append({
                        'file': current_file,
                        'old_start': int(match.group(1)),
                        'old_lines': int(match.group(2)),
                        'new_start': int(match.group(3)),
                        'new_lines': int(match.group(4))
                    })
        
        assert len(changes) == 1
        assert changes[0]['file'] == 'main.py'
        assert changes[0]['old_lines'] == 5
        assert changes[0]['new_lines'] == 6


if __name__ == "__main__":
    pytest.main([__file__, "-v"])