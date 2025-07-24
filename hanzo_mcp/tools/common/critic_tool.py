"""Critic tool implementation.

This module provides the CriticTool for Claude to engage in critical analysis and code review.
"""

from typing import Annotated, TypedDict, Unpack, final, override

from mcp.server.fastmcp import Context as MCPContext
from mcp.server import FastMCP
from pydantic import Field

from hanzo_mcp.tools.common.base import BaseTool
from hanzo_mcp.tools.common.context import create_tool_context


Analysis = Annotated[
    str,
    Field(
        description="The critical analysis to perform - code review, error detection, or improvement suggestions",
        min_length=1,
    ),
]


class CriticToolParams(TypedDict):
    """Parameters for the CriticTool.

    Attributes:
        analysis: The critical analysis to perform
    """

    analysis: Analysis


@final
class CriticTool(BaseTool):
    """Tool for Claude to engage in critical analysis and play devil's advocate."""

    @property
    @override
    def name(self) -> str:
        """Get the tool name.

        Returns:
            Tool name
        """
        return "critic"

    @property
    @override
    def description(self) -> str:
        """Get the tool description.

        Returns:
            Tool description
        """
        return """Use this tool to perform critical analysis, play devil's advocate, and ensure high standards. 
This tool forces a critical thinking mode that reviews all code for errors, improvements, and edge cases.
It ensures tests are run, tests pass, and maintains high quality standards.

This is your inner critic that:
- Always questions assumptions
- Looks for potential bugs and edge cases
- Ensures proper error handling
- Verifies test coverage
- Checks for performance issues
- Reviews security implications
- Suggests improvements and refactoring
- Ensures code follows best practices
- Questions design decisions
- Looks for missing documentation

Common use cases:
1. Before finalizing any code changes - review for bugs, edge cases, and improvements
2. After implementing a feature - critically analyze if it truly solves the problem
3. When tests pass too easily - question if tests are comprehensive enough
4. Before marking a task complete - ensure all quality standards are met
5. When something seems too simple - look for hidden complexity or missing requirements
6. After fixing a bug - analyze if the fix addresses root cause or just symptoms

<critic_example>
Code Review Analysis:
- Implementation Issues:
  * No error handling for network failures in API calls
  * Missing validation for user input boundaries
  * Race condition possible in concurrent updates
  * Memory leak potential in event listener registration
  
- Test Coverage Gaps:
  * No tests for error scenarios
  * Missing edge case: empty array input
  * No performance benchmarks for large datasets
  * Integration tests don't cover authentication failures
  
- Security Concerns:
  * SQL injection vulnerability in query construction
  * Missing rate limiting on public endpoints
  * Sensitive data logged in debug mode
  
- Performance Issues:
  * O(n²) algorithm where O(n log n) is possible
  * Database queries in a loop (N+1 problem)
  * No caching for expensive computations
  
- Code Quality:
  * Functions too long and doing multiple things
  * Inconsistent naming conventions
  * Missing type annotations
  * No documentation for complex algorithms
  
- Design Flaws:
  * Tight coupling between modules
  * Hard-coded configuration values
  * No abstraction for external dependencies
  * Violates single responsibility principle

Recommendations:
1. Add comprehensive error handling with retry logic
2. Implement input validation with clear error messages
3. Use database transactions to prevent race conditions
4. Add memory cleanup in component unmount
5. Parameterize SQL queries to prevent injection
6. Implement rate limiting middleware
7. Use environment variables for sensitive config
8. Refactor algorithm to use sorting approach
9. Batch database queries
10. Add memoization for expensive calculations
</critic_example>"""

    def __init__(self) -> None:
        """Initialize the critic tool."""
        pass

    @override
    async def call(
        self,
        ctx: MCPContext,
        **params: Unpack[CriticToolParams],
    ) -> str:
        """Execute the tool with the given parameters.

        Args:
            ctx: MCP context
            **params: Tool parameters

        Returns:
            Tool result
        """
        tool_ctx = create_tool_context(ctx)
        tool_ctx.set_tool_info(self.name)

        # Extract parameters
        analysis = params.get("analysis")

        # Validate required analysis parameter
        if not analysis:
            await tool_ctx.error(
                "Parameter 'analysis' is required but was None or empty"
            )
            return "Error: Parameter 'analysis' is required but was None or empty"

        if analysis.strip() == "":
            await tool_ctx.error("Parameter 'analysis' cannot be empty")
            return "Error: Parameter 'analysis' cannot be empty"

        # Log the critical analysis
        await tool_ctx.info("Critical analysis recorded")

        # Return confirmation with reminder to act on the analysis
        return """Critical analysis complete. Remember to:
1. Address all identified issues before proceeding
2. Run comprehensive tests to verify fixes
3. Ensure all tests pass with proper coverage
4. Document any design decisions or trade-offs
5. Consider the analysis points in your implementation

Continue with improvements based on this critical review."""

    @override
    def register(self, mcp_server: FastMCP) -> None:
        """Register this critic tool with the MCP server.

        Creates a wrapper function with explicitly defined parameters that match
        the tool's parameter schema and registers it with the MCP server.

        Args:
            mcp_server: The FastMCP server instance
        """
        tool_self = self  # Create a reference to self for use in the closure

        @mcp_server.tool(name=self.name, description=self.description)
        async def critic(
            analysis: Analysis,
            ctx: MCPContext
        ) -> str:
            return await tool_self.call(ctx, analysis=analysis)
