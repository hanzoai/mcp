"""Cursor Rules handler for Hanzo MCP.

This module provides functionality for loading, validating, and querying
Cursor Rules files (.cursorrules or .rules) that define project-specific
instructions for AI coding assistance.
"""

import os
import glob
import re
import json
from pathlib import Path
from typing import Dict, List, Optional, Any, Union

# Try to import yaml, but make it optional
try:
    import yaml
    has_yaml = True
except ImportError:
    has_yaml = False

# Default locations for pre-installed rules
DEFAULT_RULES_LOCATIONS = [
    # Location within the package for pre-installed rules
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "rules"),
    # User home directory rules
    os.path.join(os.path.expanduser("~"), ".config", "hanzo", "rules"),
]

class CursorRulesHandler:
    """Handler for Cursor Rules (.cursorrules and .rules files).
    
    This class provides functionality to:
    - Load cursor rules from local project directories
    - Search for rules in pre-installed locations
    - Extract and validate rule frontmatter
    - Query rules based on technology or focus
    """
    
    def __init__(self, permission_manager=None):
        """Initialize the Cursor Rules handler.
        
        Args:
            permission_manager: Optional permission manager for checking allowed paths
        """
        self.permission_manager = permission_manager
        self.rules_cache = {}  # Cache for loaded rules
        
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
    
    def find_rules_in_project(self, project_dir: str) -> List[str]:
        """Find all cursor rules files in a project directory.
        
        Args:
            project_dir: The project directory to search in
            
        Returns:
            List of paths to cursor rules files
        """
        if not self.is_path_allowed(project_dir):
            return []
        
        rules_files = []
        
        # Look for .cursorrules files at the root level
        cursorrules_path = os.path.join(project_dir, ".cursorrules")
        if os.path.exists(cursorrules_path) and os.path.isfile(cursorrules_path):
            rules_files.append(cursorrules_path)
            
        # Look for .rules files at the root level
        rules_path = os.path.join(project_dir, ".rules")
        if os.path.exists(rules_path) and os.path.isfile(rules_path):
            rules_files.append(rules_path)
            
        # Look for rules in a rules directory
        rules_dir = os.path.join(project_dir, "rules")
        if os.path.exists(rules_dir) and os.path.isdir(rules_dir):
            # Find all .cursorrules and .rules files in the rules directory
            for ext in [".cursorrules", ".rules"]:
                found_files = glob.glob(os.path.join(rules_dir, f"**/*{ext}"), recursive=True)
                rules_files.extend([f for f in found_files if self.is_path_allowed(f)])
        
        return rules_files
    
    def find_preinstalled_rules(self, technology: Optional[str] = None) -> List[str]:
        """Find pre-installed cursor rules files.
        
        Args:
            technology: Optional technology name to filter rules by
            
        Returns:
            List of paths to pre-installed cursor rules files
        """
        rules_files = []
        
        for rules_location in DEFAULT_RULES_LOCATIONS:
            if os.path.exists(rules_location) and os.path.isdir(rules_location):
                # Find all .cursorrules and .rules files
                for ext in [".cursorrules", ".rules"]:
                    pattern = f"**/*{ext}"
                    if technology:
                        # If technology is provided, look for specific rule patterns
                        pattern = f"**/*{technology}*{ext}"
                    
                    found_files = glob.glob(os.path.join(rules_location, pattern), recursive=True)
                    rules_files.extend(found_files)
        
        return rules_files
    
    def load_rule_file(self, file_path: str) -> Dict[str, Any]:
        """Load and parse a cursor rules file.
        
        Args:
            file_path: Path to the cursor rules file
            
        Returns:
            Dictionary containing the rule content and metadata
        """
        if file_path in self.rules_cache:
            return self.rules_cache[file_path]
        
        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            return {"error": f"File not found: {file_path}"}
            
        if not self.is_path_allowed(file_path):
            return {"error": f"File not allowed: {file_path}"}
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Extract frontmatter if present
            frontmatter = {}
            rule_content = content
            
            # Check for YAML frontmatter
            yaml_pattern = r'^---\s*\n(.*?)\n---\s*\n'
            yaml_match = re.search(yaml_pattern, content, re.DOTALL)
            if yaml_match:
                if has_yaml:
                    try:
                        frontmatter = yaml.safe_load(yaml_match.group(1))
                        rule_content = content[yaml_match.end():]
                    except Exception as e:
                        return {"error": f"Error parsing YAML frontmatter: {str(e)}"}
                else:
                    # If yaml is not available, try to parse as simple key-value pairs
                    try:
                        fm_text = yaml_match.group(1)
                        # Very basic YAML-like parsing
                        for line in fm_text.split('\n'):
                            if ':' in line:
                                key, value = line.split(':', 1)
                                key = key.strip()
                                value = value.strip()
                                
                                # Handle lists (very basic)
                                if value.startswith('-'):
                                    frontmatter[key] = [item.strip('- ') for item in value.split('\n-')]
                                else:
                                    frontmatter[key] = value
                        rule_content = content[yaml_match.end():]
                    except Exception as e:
                        return {"error": f"Error parsing frontmatter without YAML support: {str(e)}"}
            
            # Check for JSON frontmatter (alternative format)
            json_pattern = r'^\{\s*\n(.*?)\n\}\s*\n'
            json_match = re.search(json_pattern, content, re.DOTALL)
            if not frontmatter and json_match:
                try:
                    frontmatter_str = "{" + json_match.group(1) + "}"
                    frontmatter = json.loads(frontmatter_str)
                    rule_content = content[json_match.end():]
                except Exception as e:
                    return {"error": f"Error parsing JSON frontmatter: {str(e)}"}
            
            # Create rule object
            rule = {
                "path": file_path,
                "filename": os.path.basename(file_path),
                "frontmatter": frontmatter,
                "content": rule_content.strip(),
                "technologies": [],
                "focus": []
            }
            
            # Extract technologies and focus from frontmatter
            if "technologies" in frontmatter:
                rule["technologies"] = frontmatter["technologies"]
            elif "technology" in frontmatter:
                rule["technologies"] = [frontmatter["technology"]]
                
            if "focus" in frontmatter:
                rule["focus"] = frontmatter["focus"]
            elif "focuses" in frontmatter:
                rule["focus"] = frontmatter["focuses"]
                
            # Try to extract technology info from filename if not in frontmatter
            if not rule["technologies"]:
                filename = os.path.basename(file_path).lower()
                # Remove extension
                base_name = filename.replace(".cursorrules", "").replace(".rules", "")
                # Split by common delimiters
                parts = re.split(r'[-_\s]', base_name)
                rule["technologies"] = [part for part in parts if part]
            
            # Cache the rule
            self.rules_cache[file_path] = rule
            return rule
            
        except Exception as e:
            return {"error": f"Error loading rule file: {str(e)}"}
    
    def search_rules(
        self, 
        query: str, 
        project_dir: Optional[str] = None,
        include_preinstalled: bool = True
    ) -> List[Dict[str, Any]]:
        """Search for cursor rules matching a query.
        
        Args:
            query: Search query (technology or focus)
            project_dir: Optional project directory to search in
            include_preinstalled: Whether to include pre-installed rules
            
        Returns:
            List of matching rules
        """
        query = query.lower()
        matching_rules = []
        
        # Find rule files
        rule_files = []
        
        # Check project directory if provided
        if project_dir:
            rule_files.extend(self.find_rules_in_project(project_dir))
            
        # Include pre-installed rules if requested
        if include_preinstalled:
            rule_files.extend(self.find_preinstalled_rules())
            
        # Load and check rules
        for rule_file in rule_files:
            rule = self.load_rule_file(rule_file)
            
            if "error" in rule:
                continue
                
            # Check for matches in technologies or focus
            technologies = [tech.lower() for tech in rule.get("technologies", [])]
            focus = [f.lower() for f in rule.get("focus", [])]
            
            # Also search in content
            content_matches = query in rule.get("content", "").lower()
            
            if (any(query in tech for tech in technologies) or
                any(query in f for f in focus) or
                content_matches):
                matching_rules.append(rule)
                
        return matching_rules
    
    def get_rule_summary(self, rule: Dict[str, Any]) -> Dict[str, Any]:
        """Get a summary of a rule.
        
        Args:
            rule: The rule object
            
        Returns:
            Dictionary with rule summary
        """
        return {
            "path": rule.get("path", ""),
            "filename": rule.get("filename", ""),
            "technologies": rule.get("technologies", []),
            "focus": rule.get("focus", []),
            "frontmatter": rule.get("frontmatter", {}),
            "content_preview": rule.get("content", "")[:200] + "..." if len(rule.get("content", "")) > 200 else rule.get("content", "")
        }
