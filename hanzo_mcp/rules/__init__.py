"""Rules package for Hanzo MCP.

This package contains pre-installed cursor rules files for various technologies
and frameworks. These rules provide guidance to AI assistants on how to
generate code following best practices for specific technologies.
"""

import os
import glob
from typing import List, Dict, Any

def get_available_rules() -> List[str]:
    """Get a list of all available pre-installed rules.
    
    Returns:
        List of rule file paths
    """
    current_dir = os.path.dirname(__file__)
    rule_files = []
    
    # Find all .cursorrules and .rules files
    for ext in [".cursorrules", ".rules"]:
        found_files = glob.glob(os.path.join(current_dir, f"**/*{ext}"), recursive=True)
        rule_files.extend(found_files)
    
    return rule_files

def get_technology_directories() -> Dict[str, List[str]]:
    """Get a dictionary of technology directories and their rule files.
    
    Returns:
        Dictionary mapping technology names to lists of rule files
    """
    current_dir = os.path.dirname(__file__)
    technologies = {}
    
    # Get all subdirectories
    for item in os.listdir(current_dir):
        item_path = os.path.join(current_dir, item)
        if os.path.isdir(item_path) and not item.startswith("__"):
            rule_files = []
            # Find all .cursorrules and .rules files in this directory
            for ext in [".cursorrules", ".rules"]:
                found_files = glob.glob(os.path.join(item_path, f"**/*{ext}"), recursive=True)
                rule_files.extend(found_files)
            
            technologies[item] = rule_files
    
    return technologies
