"""LLM File Manager for Hanzo MCP.

This module provides functionality for automatically managing LLM.md files,
which store project knowledge that persists across sessions.
"""

import os
import logging
import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any, Union, Tuple

logger = logging.getLogger(__name__)

class LLMFileManager:
    """Manages LLM.md files containing project context and knowledge."""
    
    def __init__(self, permission_manager=None):
        """Initialize the LLM file manager.
        
        Args:
            permission_manager: Optional permission manager for checking allowed paths
        """
        self.permission_manager = permission_manager
        self.llm_md_content = ""
        self.llm_md_path = None
        self.initialized = False
    
    def is_path_allowed(self, path: str) -> bool:
        """Check if a path is allowed.
        
        Args:
            path: Path to check
            
        Returns:
            True if the path is allowed or no permission manager is set, False otherwise
        """
        if self.permission_manager is None:
            return True
        return self.permission_manager.is_path_allowed(path)
    
    def find_llm_md(self, project_dir: str) -> Optional[str]:
        """Find LLM.md file in a project directory.
        
        Args:
            project_dir: Project directory to search in
            
        Returns:
            Path to LLM.md file if found, None otherwise
        """
        if not self.is_path_allowed(project_dir):
            logger.warning(f"Path not allowed: {project_dir}")
            return None
        
        # Check for LLM.md in the root directory
        llm_md_path = os.path.join(project_dir, "LLM.md")
        if os.path.exists(llm_md_path) and os.path.isfile(llm_md_path):
            logger.info(f"Found LLM.md file at: {llm_md_path}")
            return llm_md_path
        
        # Also check for lowercase llm.md
        llm_md_path = os.path.join(project_dir, "llm.md")
        if os.path.exists(llm_md_path) and os.path.isfile(llm_md_path):
            logger.info(f"Found llm.md file at: {llm_md_path}")
            return llm_md_path
        
        # Not found
        logger.info(f"No LLM.md file found in: {project_dir}")
        return None
    
    def load_llm_md(self, path: str) -> Tuple[bool, str]:
        """Load content from an LLM.md file.
        
        Args:
            path: Path to the LLM.md file
            
        Returns:
            Tuple of (success, content or error message)
        """
        if not self.is_path_allowed(path):
            return False, f"Path not allowed: {path}"
        
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            self.llm_md_content = content
            self.llm_md_path = path
            self.initialized = True
            
            return True, content
        except Exception as e:
            logger.error(f"Error loading LLM.md file: {str(e)}")
            return False, f"Error loading LLM.md file: {str(e)}"
    
    def create_default_llm_md(self, project_dir: str) -> Tuple[bool, str]:
        """Create a default LLM.md file with project information.
        
        Args:
            project_dir: Project directory
            
        Returns:
            Tuple of (success, path to created file or error message)
        """
        if not self.is_path_allowed(project_dir):
            return False, f"Path not allowed: {project_dir}"
        
        try:
            # Get project details
            project_name = os.path.basename(project_dir)
            project_path = project_dir
            current_date = datetime.datetime.now().strftime("%Y-%m-%d")
            
            # Create default content
            content = f"""# Project Information for {project_name}

## Project Basics
- **Project Name**: {project_name}
- **Project Path**: {project_path}
- **Documentation Created**: {current_date}

## Project Purpose
*Brief description of the project's purpose and goals.*

## Key Components
*Description of main project components, directories, and their purposes.*

## Architecture Overview
*High-level architecture description.*

## Development Guidelines
*Project-specific coding standards and development guidelines.*

## Implementation Decisions
*Record of important implementation decisions and their rationales.*

## Known Issues
*List of known issues and limitations.*

## Future Improvements
*Planned enhancements and future work.*

---
This file is automatically maintained by Hanzo MCP to provide context for AI assistants.
"""
            
            # Create the file
            llm_md_path = os.path.join(project_dir, "LLM.md")
            with open(llm_md_path, 'w', encoding='utf-8') as f:
                f.write(content)
            
            self.llm_md_content = content
            self.llm_md_path = llm_md_path
            self.initialized = True
            
            logger.info(f"Created default LLM.md file at: {llm_md_path}")
            return True, llm_md_path
        except Exception as e:
            logger.error(f"Error creating default LLM.md file: {str(e)}")
            return False, f"Error creating default LLM.md file: {str(e)}"
    
    def update_llm_md(self, new_content: str) -> Tuple[bool, str]:
        """Update the LLM.md file with new content.
        
        Args:
            new_content: New content for the LLM.md file
            
        Returns:
            Tuple of (success, message)
        """
        if not self.llm_md_path:
            return False, "No LLM.md file loaded"
        
        if not self.is_path_allowed(self.llm_md_path):
            return False, f"Path not allowed: {self.llm_md_path}"
        
        try:
            with open(self.llm_md_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            self.llm_md_content = new_content
            
            logger.info(f"Updated LLM.md file at: {self.llm_md_path}")
            return True, f"Successfully updated LLM.md file"
        except Exception as e:
            logger.error(f"Error updating LLM.md file: {str(e)}")
            return False, f"Error updating LLM.md file: {str(e)}"
    
    def append_to_llm_md(self, section: str, content: str) -> Tuple[bool, str]:
        """Append a new section to the LLM.md file.
        
        Args:
            section: Section title
            content: Content to append
            
        Returns:
            Tuple of (success, message)
        """
        if not self.llm_md_path:
            return False, "No LLM.md file loaded"
        
        if not self.is_path_allowed(self.llm_md_path):
            return False, f"Path not allowed: {self.llm_md_path}"
        
        try:
            # Create section header and content
            section_content = f"\n\n## {section}\n{content}"
            
            # Append to file
            with open(self.llm_md_path, 'a', encoding='utf-8') as f:
                f.write(section_content)
            
            # Update cached content
            self.llm_md_content += section_content
            
            logger.info(f"Appended to LLM.md file at: {self.llm_md_path}")
            return True, f"Successfully appended to LLM.md file"
        except Exception as e:
            logger.error(f"Error appending to LLM.md file: {str(e)}")
            return False, f"Error appending to LLM.md file: {str(e)}"
    
    def initialize_for_project(self, project_dir: str) -> Tuple[bool, str, bool]:
        """Initialize LLM.md for a project, creating if needed.
        
        Args:
            project_dir: Project directory
            
        Returns:
            Tuple of (success, content or error message, created)
        """
        # Find LLM.md file
        llm_md_path = self.find_llm_md(project_dir)
        
        if llm_md_path:
            # Load existing file
            success, content = self.load_llm_md(llm_md_path)
            return success, content, False
        else:
            # Create default file
            success, path = self.create_default_llm_md(project_dir)
            if success:
                return True, self.llm_md_content, True
            else:
                return False, path, False  # path contains error message in this case
    
    def get_llm_md_content(self) -> str:
        """Get the content of the LLM.md file.
        
        Returns:
            Content of the LLM.md file
        """
        return self.llm_md_content
