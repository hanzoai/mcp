"""Tests for the project analysis module."""

import json
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

if TYPE_CHECKING:
    from dev_mcp.tools.common.context import DocumentContext
    from dev_mcp.tools.common.permissions import PermissionManager
    from dev_mcp.tools.shell.command_executor import CommandExecutor

from dev_mcp.tools.project.analysis import (
    ProjectAnalysis,
    ProjectAnalyzer,
    ProjectManager,
)


class TestProjectAnalyzer:
    """Test the ProjectAnalyzer class."""

    @pytest.fixture
    def analyzer(self, command_executor: "CommandExecutor"):
        """Create a ProjectAnalyzer instance for testing."""
        return ProjectAnalyzer(command_executor)

    @pytest.mark.asyncio
    async def test_analyze_python_dependencies(
        self, analyzer: ProjectAnalyzer, test_project_dir: str
    ):
        """Test analyzing Python dependencies."""
        # Mock the execute_script_from_file method
        mock_result = MagicMock()
        mock_result.return_code = 0
        mock_result.stdout = json.dumps(
            {
                "requirements_files": ["requirements.txt"],
                "installed_packages": {"pytest": "7.3.1", "mcp": "1.3.0"},
                "imports": ["os", "json", "pathlib"],
            }
        )

        with patch.object(
            analyzer.command_executor,
            "execute_script_from_file",
            return_value=mock_result,
        ) as mock_execute:
            # Run analysis
            result = await analyzer.analyze_python_dependencies(test_project_dir)

            # Verify execution
            mock_execute.assert_called_once()
            assert "python" in mock_execute.call_args[1]["language"]

            # Verify result
            assert "requirements_files" in result
            assert "installed_packages" in result
            assert "imports" in result
            assert "requirements.txt" in result["requirements_files"]

    @pytest.mark.asyncio
    async def test_analyze_python_dependencies_failure(
        self, analyzer: ProjectAnalyzer, test_project_dir: str
    ):
        """Test handling failure when analyzing Python dependencies."""
        # Mock the execute_script_from_file method to return an error
        mock_result = MagicMock()
        mock_result.return_code = 1
        mock_result.stderr = "Error analyzing dependencies"

        with patch.object(
            analyzer.command_executor,
            "execute_script_from_file",
            return_value=mock_result,
        ):
            # Run analysis
            result = await analyzer.analyze_python_dependencies(test_project_dir)

            # Verify result contains error
            assert "error" in result
            assert "Failed to analyze Python dependencies" in result["error"]

    @pytest.mark.asyncio
    async def test_analyze_javascript_dependencies(
        self, analyzer: ProjectAnalyzer, test_project_dir: str
    ):
        """Test analyzing JavaScript dependencies."""
        # Mock the execute_script_from_file method
        mock_result = MagicMock()
        mock_result.return_code = 0
        mock_result.stdout = json.dumps(
            {
                "packageFiles": ["package.json"],
                "packageDetails": [
                    {
                        "path": "package.json",
                        "name": "test-project",
                        "version": "1.0.0",
                        "dependencies": {"react": "^17.0.2"},
                        "devDependencies": {"jest": "^27.0.0"},
                    }
                ],
                "imports": ["react", "lodash"],
            }
        )

        with patch.object(
            analyzer.command_executor,
            "execute_script_from_file",
            return_value=mock_result,
        ) as mock_execute:
            # Run analysis
            result = await analyzer.analyze_javascript_dependencies(test_project_dir)

            # Verify execution
            mock_execute.assert_called_once()
            assert "javascript" in mock_execute.call_args[1]["language"]

            # Verify result
            assert "packageFiles" in result
            assert "packageDetails" in result
            assert "imports" in result
            assert "package.json" in result["packageFiles"]

    @pytest.mark.asyncio
    async def test_analyze_project_structure(
        self, analyzer: ProjectAnalyzer, test_project_dir: str
    ):
        """Test analyzing project structure."""
        # Mock the execute_script_from_file method
        mock_result = MagicMock()
        mock_result.return_code = 0
        mock_result.stdout = json.dumps(
            {
                "file_count": 10,
                "directory_count": 5,
                "total_size": 1024,
                "total_lines": 100,
                "extensions": {
                    ".py": {"count": 3, "size": 512},
                    ".md": {"count": 1, "size": 256},
                    ".txt": {"count": 1, "size": 128},
                },
            }
        )

        with patch.object(
            analyzer.command_executor,
            "execute_script_from_file",
            return_value=mock_result,
        ) as mock_execute:
            # Run analysis
            result = await analyzer.analyze_project_structure(test_project_dir)

            # Verify execution
            mock_execute.assert_called_once()
            assert "python" in mock_execute.call_args[1]["language"]

            # Verify result
            assert "file_count" in result
            assert "directory_count" in result
            assert "total_size" in result
            assert "extensions" in result
            assert ".py" in result["extensions"]


class TestProjectManager:
    """Test the ProjectManager class."""

    @pytest.fixture
    def project_manager(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
        project_analyzer: ProjectAnalyzer,
    ):
        """Create a ProjectManager instance for testing."""
        return ProjectManager(document_context, permission_manager, project_analyzer)

    def test_initialization(
        self,
        document_context: "DocumentContext",
        permission_manager: "PermissionManager",
        project_analyzer: ProjectAnalyzer,
    ):
        """Test initializing ProjectManager."""
        manager = ProjectManager(document_context, permission_manager, project_analyzer)

        assert manager.document_context is document_context
        assert manager.permission_manager is permission_manager
        assert manager.project_analyzer is project_analyzer
        assert manager.project_root is None
        assert isinstance(manager.project_metadata, dict)
        assert isinstance(manager.project_analysis, dict)

    def test_set_project_root(
        self,
        project_manager: ProjectManager,
        temp_dir: str,
        permission_manager: "PermissionManager",
    ):
        """Test setting the project root directory."""
        # Allow the temp_dir path
        permission_manager.add_allowed_path(temp_dir)

        # Set the project root
        result = project_manager.set_project_root(temp_dir)

        # Verify result
        assert result
        assert project_manager.project_root == Path(temp_dir).resolve().as_posix()

    def test_set_project_root_disallowed(
        self, project_manager: ProjectManager, temp_dir: str
    ):
        """Test setting a disallowed project root directory."""
        # Don't allow the temp_dir path

        # Try to set the project root
        result = project_manager.set_project_root(temp_dir)

        # Verify result
        assert result

    def test_detect_programming_languages(
        self,
        project_manager: ProjectManager,
        test_project_dir: str,
        permission_manager: "PermissionManager",
    ):
        """Test detecting programming languages in a project."""
        # Allow the project directory
        permission_manager.add_allowed_path(test_project_dir)
        project_manager.set_project_root(test_project_dir)

        # Detect languages
        languages = project_manager.detect_programming_languages()

        # Verify result
        assert isinstance(languages, dict)
        assert "Python" in languages
        assert "Markdown" in languages

    def test_detect_project_type(
        self,
        project_manager: ProjectManager,
        test_project_dir: str,
        permission_manager: "PermissionManager",
    ):
        """Test detecting project type."""
        # Allow the project directory
        permission_manager.add_allowed_path(test_project_dir)
        project_manager.set_project_root(test_project_dir)

        # Patch _read_json and _read_lines methods
        with (
            patch.object(project_manager, "_read_json", return_value={}),
            patch.object(
                project_manager,
                "_read_lines",
                return_value=["pytest==7.3.1", "mcp>=1.3.0"],
            ),
        ):
            # Detect project type
            result = project_manager.detect_project_type()

            # Verify result
            assert isinstance(result, dict)
            assert "type" in result
            assert "frameworks" in result

    @pytest.mark.asyncio
    async def test_analyze_project(
        self,
        project_manager: ProjectManager,
        test_project_dir: str,
        permission_manager: "PermissionManager",
    ):
        """Test analyzing a project."""
        # Allow the project directory
        permission_manager.add_allowed_path(test_project_dir)
        project_manager.set_project_root(test_project_dir)

        # Mock methods
        project_manager.detect_programming_languages = MagicMock(
            return_value={"Python": 3, "Markdown": 1}
        )
        project_manager.detect_project_type = MagicMock(
            return_value={"type": "web-backend", "frameworks": ["Django"]}
        )

        # Mock project_analyzer methods
        project_manager.project_analyzer.analyze_project_structure = AsyncMock(
            return_value={
                "file_count": 10,
                "directory_count": 5,
                "extensions": {".py": {"count": 3}},
            }
        )
        project_manager.project_analyzer.analyze_python_dependencies = AsyncMock(
            return_value={
                "requirements_files": ["requirements.txt"],
                "imports": ["os", "json"],
            }
        )

        # Run analysis
        result = await project_manager.analyze_project()

        # Verify result
        assert "languages" in result
        assert "project_type" in result
        assert "structure" in result
        assert "python_dependencies" in result
        assert result["languages"]["Python"] == 3
        assert result["project_type"]["type"] == "web-backend"

    def test_generate_project_summary(
        self,
        project_manager: ProjectManager,
        test_project_dir: str,
        permission_manager: "PermissionManager",
    ):
        """Test generating a project summary."""
        # Allow the project directory
        permission_manager.add_allowed_path(test_project_dir)
        project_manager.set_project_root(test_project_dir)

        # Set up mock analysis data
        project_manager.project_analysis = {
            "languages": {"Python": 3, "Markdown": 1},
            "project_type": {"type": "web-backend", "frameworks": ["Django"]},
            "structure": {
                "file_count": 10,
                "directory_count": 5,
                "total_size": 1024,
                "total_lines": 100,
                "extensions": {
                    ".py": {"count": 3, "size": 512},
                    ".md": {"count": 1, "size": 256},
                },
            },
            "python_dependencies": {
                "requirements_files": ["requirements.txt"],
                "imports": ["os", "json", "django"],
            },
        }

        # Generate summary
        summary = project_manager.generate_project_summary()

        # Verify summary format and content
        assert "Project Summary" in summary
        assert "Project Type: Web-Backend" in summary
        assert "Django" in summary
        assert "Programming Languages" in summary
        assert "Python: 3" in summary
        assert "Project Structure" in summary
        assert "Total lines of code: 100" in summary

    def test_format_size(self, project_manager: ProjectManager):
        """Test formatting file sizes."""
        # Test different file sizes
        assert project_manager._format_size(0) == "0.0 B"
        assert project_manager._format_size(1023) == "1023.0 B"
        assert project_manager._format_size(1024) == "1.0 KB"
        assert project_manager._format_size(1024 * 1024) == "1.0 MB"
        assert project_manager._format_size(1024 * 1024 * 1024) == "1.0 GB"


class TestProjectAnalysis:
    """Test the ProjectAnalysis class."""

    @pytest.fixture
    def project_analysis(
        self,
        project_manager: ProjectManager,
        project_analyzer: ProjectAnalyzer,
        permission_manager: "PermissionManager",
    ):
        """Create a ProjectAnalysis instance for testing."""
        return ProjectAnalysis(project_manager, project_analyzer, permission_manager)

    def test_initialization(
        self,
        project_manager: ProjectManager,
        project_analyzer: ProjectAnalyzer,
        permission_manager: "PermissionManager",
    ):
        """Test initializing ProjectAnalysis."""
        analysis = ProjectAnalysis(
            project_manager, project_analyzer, permission_manager
        )

        assert analysis.project_manager is project_manager
        assert analysis.project_analyzer is project_analyzer
        assert analysis.permission_manager is permission_manager

    @pytest.mark.asyncio
    async def test_register_tools(self, project_analysis: ProjectAnalysis):
        """Test registering project analysis tools."""
        mock_server = MagicMock()
        tools = {}

        def mock_decorator():
            def decorator(func):
                tools[func.__name__] = func
                return func

            return decorator

        mock_server.tool = mock_decorator

        # Register tools
        project_analysis.register_tools(mock_server)

        # Verify tools were registered
        assert "project_analyze_tool" in tools

        # Test project_analyze_tool
        with (
            patch.object(
                project_analysis.project_manager, "set_project_root", return_value=True
            ),
            patch.object(
                project_analysis.project_manager, "analyze_project", return_value={}
            ),
            patch.object(
                project_analysis.project_manager,
                "generate_project_summary",
                return_value="Project summary",
            ),
        ):
            # Create mock context
            mock_context = AsyncMock()
            mock_tool_ctx = AsyncMock()

            # Mock permission check
            project_analysis.permission_manager.is_path_allowed = MagicMock(
                return_value=True
            )

            with patch(
                "dev_mcp.tools.project.analysis.create_tool_context",
                return_value=mock_tool_ctx,
            ):
                # Call the project_analyze_tool
                result = await tools["project_analyze_tool"](
                    "/test/project/dir", mock_context
                )

                # Verify result
                assert result == "Project summary"
                mock_tool_ctx.info.assert_called()
