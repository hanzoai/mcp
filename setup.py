#!/usr/bin/env python
"""Setup script for hanzo-mcp."""

import os
import subprocess
import sys
from setuptools import setup
from setuptools.command.build_py import build_py
from setuptools.command.develop import develop


class UpdateVersionBuildPy(build_py):
    """Custom build_py command that updates version before building."""
    
    def run(self):
        """Run the command."""
        # Run the version update script before building
        update_script = os.path.join('scripts', 'update_version.py')
        if os.path.exists(update_script):
            print("Running version update script...")
            subprocess.check_call([sys.executable, update_script])
        else:
            print(f"Warning: Version update script not found at {update_script}")
        
        # Continue with the regular build process
        super().run()


class UpdateVersionDevelop(develop):
    """Custom develop command that updates version before installing in development mode."""
    
    def run(self):
        """Run the command."""
        # Run the version update script before installing
        update_script = os.path.join('scripts', 'update_version.py')
        if os.path.exists(update_script):
            print("Running version update script...")
            subprocess.check_call([sys.executable, update_script])
        else:
            print(f"Warning: Version update script not found at {update_script}")
        
        # Continue with the regular develop process
        super().run()


setup(
    cmdclass={
        'build_py': UpdateVersionBuildPy,
        'develop': UpdateVersionDevelop,
    },
)
