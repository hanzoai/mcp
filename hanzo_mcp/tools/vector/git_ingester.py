"""Git repository ingester for comprehensive code indexing.

This module provides functionality to ingest entire git repositories including:
- Full git history and commit metadata
- File contents at different points in time  
- AST analysis via tree-sitter
- Symbol extraction and cross-references
- Blame information for line-level attribution
"""

import subprocess
import json
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime
from dataclasses import dataclass
import logging

from .infinity_store import InfinityVectorStore
from .ast_analyzer import ASTAnalyzer

logger = logging.getLogger(__name__)


@dataclass
class GitCommit:
    """Represents a git commit."""
    hash: str
    author: str
    author_email: str
    timestamp: int
    message: str
    files: List[Dict[str, str]]  # [{'status': 'M', 'filename': 'main.py'}]
    parent_hashes: List[str]


@dataclass
class GitFileHistory:
    """History of a single file."""
    file_path: str
    commits: List[GitCommit]
    current_content: Optional[str]
    line_blame: Dict[int, Dict[str, Any]]  # line_number -> blame info


class GitIngester:
    """Ingests git repositories into vector store."""
    
    def __init__(self, vector_store: InfinityVectorStore):
        """Initialize the git ingester.
        
        Args:
            vector_store: The vector store to ingest into
        """
        self.vector_store = vector_store
        self.ast_analyzer = ASTAnalyzer()
        self._commit_cache: Dict[str, GitCommit] = {}
    
    def ingest_repository(
        self,
        repo_path: str,
        branch: str = "HEAD",
        include_history: bool = True,
        include_diffs: bool = True,
        include_blame: bool = True,
        file_patterns: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Ingest an entire git repository.
        
        Args:
            repo_path: Path to the git repository
            branch: Branch to ingest (default: HEAD)
            include_history: Whether to include commit history
            include_diffs: Whether to include diff information
            include_blame: Whether to include blame information
            file_patterns: List of file patterns to include (e.g., ["*.py", "*.js"])
            
        Returns:
            Summary of ingestion results
        """
        repo_path = Path(repo_path)
        if not (repo_path / ".git").exists():
            raise ValueError(f"Not a git repository: {repo_path}")
        
        logger.info(f"Starting ingestion of repository: {repo_path}")
        
        results = {
            "repository": str(repo_path),
            "branch": branch,
            "commits_processed": 0,
            "files_indexed": 0,
            "symbols_extracted": 0,
            "diffs_indexed": 0,
            "errors": []
        }
        
        try:
            # Get current branch/commit
            current_commit = self._get_current_commit(repo_path)
            results["current_commit"] = current_commit
            
            # Get list of files to process
            files = self._get_repository_files(repo_path, file_patterns)
            logger.info(f"Found {len(files)} files to process")
            
            # Process each file
            for file_path in files:
                try:
                    self._process_file(
                        repo_path,
                        file_path,
                        include_history=include_history,
                        include_blame=include_blame,
                        results=results
                    )
                except Exception as e:
                    logger.error(f"Error processing {file_path}: {e}")
                    results["errors"].append(f"{file_path}: {str(e)}")
            
            # Process commit history if requested
            if include_history:
                commits = self._get_commit_history(repo_path, branch)
                results["commits_processed"] = len(commits)
                
                for commit in commits:
                    self._index_commit(commit, include_diffs=include_diffs)
                    
                    if include_diffs:
                        results["diffs_indexed"] += len(commit.files)
            
            # Create repository metadata document
            self._index_repository_metadata(repo_path, results)
            
        except Exception as e:
            logger.error(f"Repository ingestion failed: {e}")
            results["errors"].append(f"Fatal error: {str(e)}")
        
        logger.info(f"Ingestion complete: {results}")
        return results
    
    def _get_current_commit(self, repo_path: Path) -> str:
        """Get the current commit hash."""
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    
    def _get_repository_files(
        self,
        repo_path: Path,
        patterns: Optional[List[str]] = None
    ) -> List[Path]:
        """Get list of files in repository matching patterns."""
        # Use git ls-files to respect .gitignore
        cmd = ["git", "ls-files"]
        
        result = subprocess.run(
            cmd,
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True
        )
        
        files = []
        for line in result.stdout.strip().split('\n'):
            if line:
                file_path = repo_path / line
                if file_path.exists():
                    # Apply pattern filtering if specified
                    if patterns:
                        if any(file_path.match(pattern) for pattern in patterns):
                            files.append(file_path)
                    else:
                        files.append(file_path)
        
        return files
    
    def _get_commit_history(
        self,
        repo_path: Path,
        branch: str = "HEAD",
        max_commits: int = 1000
    ) -> List[GitCommit]:
        """Get commit history for the repository."""
        # Get commit list with basic info
        result = subprocess.run(
            ["git", "log", branch, f"--max-count={max_commits}",
             "--pretty=format:%H|%P|%an|%ae|%at|%s"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True
        )
        
        commits = []
        for line in result.stdout.strip().split('\n'):
            if line:
                parts = line.split('|', 5)
                if len(parts) >= 6:
                    commit_hash = parts[0]
                    parent_hashes = parts[1].split() if parts[1] else []
                    
                    # Get file changes for this commit
                    files = self._get_commit_files(repo_path, commit_hash)
                    
                    commit = GitCommit(
                        hash=commit_hash,
                        parent_hashes=parent_hashes,
                        author=parts[2],
                        author_email=parts[3],
                        timestamp=int(parts[4]),
                        message=parts[5],
                        files=files
                    )
                    commits.append(commit)
                    self._commit_cache[commit_hash] = commit
        
        return commits
    
    def _get_commit_files(self, repo_path: Path, commit_hash: str) -> List[Dict[str, str]]:
        """Get list of files changed in a commit."""
        result = subprocess.run(
            ["git", "show", "--name-status", "--format=", commit_hash],
            cwd=repo_path,
            capture_output=True,
            text=True,
            check=True
        )
        
        files = []
        for line in result.stdout.strip().split('\n'):
            if line and '\t' in line:
                parts = line.split('\t', 1)
                if len(parts) == 2:
                    files.append({
                        'status': parts[0],
                        'filename': parts[1]
                    })
        
        return files
    
    def _process_file(
        self,
        repo_path: Path,
        file_path: Path,
        include_history: bool,
        include_blame: bool,
        results: Dict[str, Any]
    ):
        """Process a single file."""
        relative_path = file_path.relative_to(repo_path)
        
        # Read current content
        try:
            content = file_path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            content = file_path.read_text(encoding='latin-1')
        
        # Get file metadata
        metadata = {
            'repository': str(repo_path),
            'relative_path': str(relative_path),
            'file_type': file_path.suffix,
            'size': file_path.stat().st_size,
        }
        
        # Add git history metadata if requested
        if include_history:
            history = self._get_file_history(repo_path, relative_path)
            metadata['commit_count'] = len(history)
            if history:
                metadata['first_commit'] = history[-1]['hash']
                metadata['last_commit'] = history[0]['hash']
                metadata['last_modified'] = datetime.fromtimestamp(
                    history[0]['timestamp']
                ).isoformat()
        
        # Add blame information if requested
        if include_blame:
            blame_data = self._get_file_blame(repo_path, relative_path)
            metadata['unique_authors'] = len(set(
                b['author'] for b in blame_data.values()
            ))
        
        # Index the file content
        doc_ids = self.vector_store.add_file(
            str(file_path),
            chunk_size=1000,
            chunk_overlap=200,
            metadata=metadata
        )
        results["files_indexed"] += 1
        
        # Perform AST analysis for supported languages
        if file_path.suffix in ['.py', '.js', '.ts', '.java', '.cpp', '.c']:
            try:
                file_ast = self.ast_analyzer.analyze_file(str(file_path))
                if file_ast:
                    # Store complete AST
                    self.vector_store._store_file_ast(file_ast)
                    
                    # Store individual symbols
                    self.vector_store._store_symbols(file_ast.symbols)
                    results["symbols_extracted"] += len(file_ast.symbols)
                    
                    # Store cross-references
                    self.vector_store._store_references(file_ast)
            except Exception as e:
                logger.warning(f"AST analysis failed for {file_path}: {e}")
    
    def _get_file_history(
        self,
        repo_path: Path,
        file_path: Path
    ) -> List[Dict[str, Any]]:
        """Get commit history for a specific file."""
        result = subprocess.run(
            ["git", "log", "--follow", "--pretty=format:%H|%at|%an|%s", "--", str(file_path)],
            cwd=repo_path,
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            return []
        
        history = []
        for line in result.stdout.strip().split('\n'):
            if line:
                parts = line.split('|', 3)
                if len(parts) >= 4:
                    history.append({
                        'hash': parts[0],
                        'timestamp': int(parts[1]),
                        'author': parts[2],
                        'message': parts[3]
                    })
        
        return history
    
    def _get_file_blame(
        self,
        repo_path: Path,
        file_path: Path
    ) -> Dict[int, Dict[str, Any]]:
        """Get blame information for a file."""
        result = subprocess.run(
            ["git", "blame", "--line-porcelain", "--", str(file_path)],
            cwd=repo_path,
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            return {}
        
        blame_data = {}
        current_commit = None
        current_line = None
        author = None
        timestamp = None
        
        for line in result.stdout.strip().split('\n'):
            if line and not line.startswith('\t'):
                parts = line.split(' ')
                if len(parts) >= 3 and len(parts[0]) == 40:  # SHA-1 hash
                    current_commit = parts[0]
                    current_line = int(parts[2])
                elif line.startswith('author '):
                    author = line[7:]
                elif line.startswith('author-time '):
                    timestamp = int(line[12:])
                    
                    # We have all the data for this line
                    if current_line and author:
                        blame_data[current_line] = {
                            'commit': current_commit,
                            'author': author,
                            'timestamp': timestamp
                        }
        
        return blame_data
    
    def _index_commit(
        self,
        commit: GitCommit,
        include_diffs: bool = True
    ):
        """Index a single commit."""
        # Create commit document
        commit_doc = f"""Git Commit: {commit.hash}
Author: {commit.author} <{commit.author_email}>
Date: {datetime.fromtimestamp(commit.timestamp).isoformat()}
Message: {commit.message}

Files changed: {len(commit.files)}
"""
        
        for file_info in commit.files:
            commit_doc += f"\n{file_info['status']}\t{file_info['filename']}"
        
        # Index commit
        metadata = {
            'type': 'git_commit',
            'commit_hash': commit.hash,
            'author': commit.author,
            'timestamp': commit.timestamp,
            'file_count': len(commit.files)
        }
        
        self.vector_store.add_document(commit_doc, metadata)
        
        # Index diffs if requested
        if include_diffs:
            for file_info in commit.files:
                self._index_commit_diff(commit, file_info['filename'])
    
    def _index_commit_diff(self, commit: GitCommit, filename: str):
        """Index the diff for a specific file in a commit."""
        # This is a simplified version - in practice you'd want to
        # parse the actual diff and store meaningful chunks
        metadata = {
            'type': 'git_diff',
            'commit_hash': commit.hash,
            'filename': filename,
            'author': commit.author,
            'timestamp': commit.timestamp
        }
        
        # Create a document representing this change
        diff_doc = f"""File: {filename}
Commit: {commit.hash}
Author: {commit.author}
Message: {commit.message}
"""
        
        self.vector_store.add_document(diff_doc, metadata)
    
    def _index_repository_metadata(
        self,
        repo_path: Path,
        results: Dict[str, Any]
    ):
        """Index overall repository metadata."""
        # Get repository info
        remote_result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo_path,
            capture_output=True,
            text=True
        )
        
        remote_url = remote_result.stdout.strip() if remote_result.returncode == 0 else None
        
        # Create repository summary document
        repo_doc = f"""Repository: {repo_path.name}
Path: {repo_path}
Remote: {remote_url or 'No remote'}
Current Commit: {results.get('current_commit', 'Unknown')}

Statistics:
- Files indexed: {results['files_indexed']}
- Commits processed: {results['commits_processed']}
- Symbols extracted: {results['symbols_extracted']}
- Diffs indexed: {results['diffs_indexed']}
"""
        
        metadata = {
            'type': 'repository',
            'name': repo_path.name,
            'path': str(repo_path),
            'remote_url': remote_url,
            **results
        }
        
        self.vector_store.add_document(repo_doc, metadata)