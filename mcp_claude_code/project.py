"""Project context management for the MCP Claude Code server."""

import json
from pathlib import Path
from typing import Any, Callable, final

from mcp_claude_code.context import DocumentContext
from mcp_claude_code.executors import ProjectAnalyzer
from mcp_claude_code.tools.common.permissions import PermissionManager


@final
class ProjectManager:
    """Manages project context and understanding."""
    
    def __init__(
        self, 
        document_context: DocumentContext,
        permission_manager: PermissionManager,
        project_analyzer: ProjectAnalyzer
    ) -> None:
        """Initialize the project manager.
        
        Args:
            document_context: The document context for storing files
            permission_manager: The permission manager for checking permissions
            project_analyzer: The project analyzer for analyzing project structure
        """
        self.document_context: DocumentContext = document_context
        self.permission_manager: PermissionManager = permission_manager
        self.project_analyzer: ProjectAnalyzer = project_analyzer
        
        # Project metadata
        self.project_root: str | None = None
        self.project_metadata: dict[str, Any] = {}
        self.project_analysis: dict[str, Any] = {}
        self.project_files: dict[str, dict[str, Any]] = {}
        
        # Source code stats
        self.stats: dict[str, int] = {
            "files": 0,
            "directories": 0,
            "lines_of_code": 0,
            "functions": 0,
            "classes": 0
        }
        
        # Programming languages detected
        self.languages: dict[str, int] = {}
        
        # Detected framework/library usage
        self.frameworks: dict[str, dict[str, Any]] = {}
    
    def set_project_root(self, root_path: str) -> bool:
        """Set the project root directory.
        
        Args:
            root_path: The root directory of the project
            
        Returns:
            True if successful, False otherwise
        """
        if not self.permission_manager.is_path_allowed(root_path):
            return False
        
        path: Path = Path(root_path)
        if not path.exists() or not path.is_dir():
            return False
        
        self.project_root = str(path.resolve())
        return True
    
    def detect_programming_languages(self) -> dict[str, int]:
        """Detect programming languages used in the project.
        
        Returns:
            Dictionary mapping language names to file counts
        """
        if not self.project_root:
            return {}
        
        extension_to_language: dict[str, str] = {
            ".py": "Python",
            ".js": "JavaScript",
            ".jsx": "JavaScript (React)",
            ".ts": "TypeScript",
            ".tsx": "TypeScript (React)",
            ".html": "HTML",
            ".css": "CSS",
            ".scss": "SCSS",
            ".less": "LESS",
            ".java": "Java",
            ".kt": "Kotlin",
            ".rb": "Ruby",
            ".php": "PHP",
            ".go": "Go",
            ".rs": "Rust",
            ".swift": "Swift",
            ".c": "C",
            ".cpp": "C++",
            ".h": "C/C++ Header",
            ".cs": "C#",
            ".sh": "Shell",
            ".bat": "Batch",
            ".ps1": "PowerShell",
            ".md": "Markdown",
            ".json": "JSON",
            ".yaml": "YAML",
            ".yml": "YAML",
            ".toml": "TOML",
            ".xml": "XML",
            ".sql": "SQL",
            ".r": "R",
            ".scala": "Scala"
        }
        
        languages: dict[str, int] = {}
        root_path: Path = Path(self.project_root)
        
        for ext, lang in extension_to_language.items():
            files: list[Path] = list(root_path.glob(f"**/*{ext}"))
            
            # Filter out files in excluded directories
            filtered_files: list[Path] = []
            for file in files:
                if self.permission_manager.is_path_allowed(str(file)):
                    filtered_files.append(file)
            
            if filtered_files:
                languages[lang] = len(filtered_files)
        
        self.languages = languages
        return languages
    
    def detect_project_type(self) -> dict[str, Any]:
        """Detect the type of project.
        
        Returns:
            Dictionary describing the project type and frameworks
        """
        if not self.project_root:
            return {"type": "unknown"}
        
        root_path: Path = Path(self.project_root)
        result: dict[str, Any] = {"type": "unknown", "frameworks": []}
        
        # Define type checker functions with proper type annotations
        def check_package_dependency(p: Path, dependency: str) -> bool:
            return dependency in self._read_json(p).get("dependencies", {})
        
        def check_requirement(p: Path, prefix: str) -> bool:
            return any(x.startswith(prefix) for x in self._read_lines(p))
        
        def always_true(p: Path) -> bool:
            return True
        
        def is_directory(p: Path) -> bool:
            return p.is_dir()
        
        # Check for common project markers using list of tuples with properly typed functions
        markers: dict[str, list[tuple[str, Callable[[Path], bool]]]] = {
            "web-frontend": [
                ("package.json", lambda p: check_package_dependency(p, "react")),
                ("package.json", lambda p: check_package_dependency(p, "vue")),
                ("package.json", lambda p: check_package_dependency(p, "angular")),
                ("angular.json", always_true),
                ("next.config.js", always_true),
                ("nuxt.config.js", always_true),
            ],
            "web-backend": [
                ("requirements.txt", lambda p: check_requirement(p, "django")),
                ("requirements.txt", lambda p: check_requirement(p, "flask")),
                ("requirements.txt", lambda p: check_requirement(p, "fastapi")),
                ("package.json", lambda p: check_package_dependency(p, "express")),
                ("package.json", lambda p: check_package_dependency(p, "koa")),
                ("package.json", lambda p: check_package_dependency(p, "nest")),
                ("pom.xml", always_true),
                ("build.gradle", always_true),
            ],
            "mobile": [
                ("pubspec.yaml", always_true),  # Flutter
                ("AndroidManifest.xml", always_true),
                ("Info.plist", always_true),
                ("package.json", lambda p: check_package_dependency(p, "react-native")),
            ],
            "desktop": [
                ("package.json", lambda p: check_package_dependency(p, "electron")),
                ("CMakeLists.txt", always_true),
                ("Makefile", always_true),
            ],
            "data-science": [
                ("requirements.txt", lambda p: check_requirement(p, "pandas")),
                ("requirements.txt", lambda p: check_requirement(p, "numpy")),
                ("requirements.txt", lambda p: check_requirement(p, "jupyter")),
                ("environment.yml", always_true),
            ],
            "devops": [
                (".github/workflows", is_directory),
                (".gitlab-ci.yml", always_true),
                ("Dockerfile", always_true),
                ("docker-compose.yml", always_true),
                ("Jenkinsfile", always_true),
                ("terraform.tf", always_true),
            ],
            "game": [
                ("UnityProject.sln", always_true),
                ("Assembly-CSharp.csproj", always_true),
                ("ProjectSettings/ProjectSettings.asset", always_true),
                ("Godot", always_true),
                ("project.godot", always_true),
            ],
        }
        
        # Check markers
        for project_type, type_markers in markers.items():
            for marker, condition in type_markers:
                marker_path: Path = root_path / marker
                if marker_path.exists() and condition(marker_path):
                    result["type"] = project_type
                    break
        
        # Detect frameworks
        self._detect_frameworks(result)
        
        return result
    
    def _detect_frameworks(self, result: dict[str, Any]) -> None:
        """Detect frameworks used in the project.
        
        Args:
            result: Dictionary to update with framework information
        """
        if not self.project_root:
            return
        
        root_path: Path = Path(self.project_root)
        frameworks: list[str] = []
        
        # Package.json based detection
        package_json: Path = root_path / "package.json"
        if package_json.exists() and package_json.is_file():
            try:
                data: dict[str, Any] = self._read_json(package_json)
                dependencies: dict[str, Any] = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
                
                framework_markers: dict[str, list[str]] = {
                    "React": ["react", "react-dom"],
                    "Vue.js": ["vue"],
                    "Angular": ["@angular/core"],
                    "Next.js": ["next"],
                    "Nuxt.js": ["nuxt"],
                    "Express": ["express"],
                    "NestJS": ["@nestjs/core"],
                    "React Native": ["react-native"],
                    "Electron": ["electron"],
                    "jQuery": ["jquery"],
                    "Bootstrap": ["bootstrap"],
                    "Tailwind CSS": ["tailwindcss"],
                    "Material UI": ["@mui/material", "@material-ui/core"],
                    "Redux": ["redux"],
                    "Gatsby": ["gatsby"],
                    "Svelte": ["svelte"],
                    "Jest": ["jest"],
                    "Mocha": ["mocha"],
                    "Cypress": ["cypress"],
                }
                
                for framework, markers in framework_markers.items():
                    if any(marker in dependencies for marker in markers):
                        frameworks.append(framework)
                
            except Exception:
                pass
        
        # Python requirements.txt based detection
        requirements_txt: Path = root_path / "requirements.txt"
        if requirements_txt.exists() and requirements_txt.is_file():
            try:
                requirements: list[str] = self._read_lines(requirements_txt)
                
                framework_markers: dict[str, list[str]] = {
                    "Django": ["django"],
                    "Flask": ["flask"],
                    "FastAPI": ["fastapi"],
                    "Pandas": ["pandas"],
                    "NumPy": ["numpy"],
                    "TensorFlow": ["tensorflow"],
                    "PyTorch": ["torch"],
                    "Scikit-learn": ["scikit-learn", "sklearn"],
                    "Jupyter": ["jupyter", "ipython"],
                    "Pytest": ["pytest"],
                    "SQLAlchemy": ["sqlalchemy"],
                }
                
                for framework, markers in framework_markers.items():
                    if any(any(req.lower().startswith(marker) for marker in markers) for req in requirements):
                        frameworks.append(framework)
                
            except Exception:
                pass
        
        result["frameworks"] = frameworks
        self.frameworks = {f: {"detected": True} for f in frameworks}
    
    def _read_json(self, path: Path) -> dict[str, Any]:
        """Read a JSON file.
        
        Args:
            path: Path to the JSON file
            
        Returns:
            Dictionary containing the JSON data, or empty dict on error
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    
    def _read_lines(self, path: Path) -> list[str]:
        """Read lines from a text file.
        
        Args:
            path: Path to the text file
            
        Returns:
            List of lines, or empty list on error
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.readlines()
        except Exception:
            return []
    
    async def analyze_project(self) -> dict[str, Any]:
        """Analyze the project structure and dependencies.
        
        Returns:
            Dictionary containing analysis results
        """
        if not self.project_root:
            return {"error": "Project root not set"}
        
        result: dict[str, Any] = {}
        
        # Detect languages
        result["languages"] = self.detect_programming_languages()
        
        # Detect project type
        result["project_type"] = self.detect_project_type()
        
        # Analyze structure
        structure: dict[str, Any] = await self.project_analyzer.analyze_project_structure(self.project_root)
        result["structure"] = structure
        
        # Analyze dependencies based on project type
        if "Python" in result["languages"]:
            python_deps: dict[str, Any] = await self.project_analyzer.analyze_python_dependencies(self.project_root)
            result["python_dependencies"] = python_deps
        
        if "JavaScript" in result["languages"] or "TypeScript" in result["languages"]:
            js_deps: dict[str, Any] = await self.project_analyzer.analyze_javascript_dependencies(self.project_root)
            result["javascript_dependencies"] = js_deps
        
        self.project_analysis = result
        return result
    
    def generate_project_summary(self) -> str:
        """Generate a human-readable summary of the project.
        
        Returns:
            Formatted string with project summary
        """
        if not self.project_root or not self.project_analysis:
            return "No project analysis available. Please set project root and run analysis first."
        
        # Build summary
        summary: list[str] = [f"# Project Summary: {Path(self.project_root).name}\n"]
        
        # Project type
        project_type: dict[str, Any] = self.project_analysis.get("project_type", {})
        if project_type:
            summary.append(f"## Project Type: {project_type.get('type', 'Unknown').title()}")
            
            frameworks: list[str] = project_type.get("frameworks", [])
            if frameworks:
                summary.append("### Frameworks/Libraries")
                summary.append(", ".join(frameworks))
            
            summary.append("")
        
        # Languages
        languages: dict[str, int] = self.project_analysis.get("languages", {})
        if languages:
            summary.append("## Programming Languages")
            for lang, count in languages.items():
                summary.append(f"- {lang}: {count} files")
            summary.append("")
        
        # Structure
        structure: dict[str, Any] = self.project_analysis.get("structure", {})
        if structure and not isinstance(structure, str):
            summary.append("## Project Structure")
            summary.append(f"- Files: {structure.get('file_count', 0)}")
            summary.append(f"- Directories: {structure.get('directory_count', 0)}")
            summary.append(f"- Total size: {self._format_size(structure.get('total_size', 0))}")
            
            if structure.get('total_lines'):
                summary.append(f"- Total lines of code: {structure.get('total_lines', 0)}")
            
            # File extensions
            extensions: dict[str, dict[str, int]] = structure.get("extensions", {})
            if extensions:
                summary.append("\n### File Types")
                for ext, info in list(extensions.items())[:10]:  # Show top 10
                    if ext:
                        summary.append(f"- {ext}: {info.get('count', 0)} files ({self._format_size(info.get('size', 0))})")
            
            summary.append("")
        
        # Dependencies
        py_deps: dict[str, Any] = self.project_analysis.get("python_dependencies", {})
        if py_deps and not isinstance(py_deps, str) and not py_deps.get("error"):
            summary.append("## Python Dependencies")
            
            # Requirements files
            req_files: list[str] = py_deps.get("requirements_files", [])
            if req_files:
                summary.append("### Dependency Files")
                for req in req_files:
                    summary.append(f"- {req}")
            
            # Imports
            imports: list[str] = py_deps.get("imports", [])
            if imports:
                summary.append("\n### Top Imports")
                for imp in sorted(imports)[:15]:  # Show top 15
                    summary.append(f"- {imp}")
            
            summary.append("")
        
        js_deps: dict[str, Any] = self.project_analysis.get("javascript_dependencies", {})
        if js_deps and not isinstance(js_deps, str) and not js_deps.get("error"):
            summary.append("## JavaScript/TypeScript Dependencies")
            
            # Package files
            pkg_files: list[str] = js_deps.get("packageFiles", [])
            if pkg_files:
                summary.append("### Package Files")
                for pkg in pkg_files:
                    summary.append(f"- {pkg}")
            
            # Imports
            imports: list[str] = js_deps.get("imports", [])
            if imports:
                summary.append("\n### Top Imports")
                for imp in sorted(imports)[:15]:  # Show top 15
                    summary.append(f"- {imp}")
            
            summary.append("")
        
        return "\n".join(summary)
    
    def _format_size(self, size_bytes: float) -> str:
        """Format file size in human-readable form.
        
        Args:
            size_bytes: Size in bytes
            
        Returns:
            Formatted size string
        """
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024.0:
                return f"{size_bytes:.1f} {unit}"
            size_bytes = size_bytes / 1024.0
        return f"{size_bytes:.1f} TB"
