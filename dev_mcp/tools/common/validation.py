"""Parameter validation utilities for MCP Claude Code tools.

This module provides utilities for validating parameters in tool functions.
"""

from typing import Any, TypeVar, final

T = TypeVar("T")


@final
class ValidationResult:
    """Result of a parameter validation."""

    def __init__(self, is_valid: bool, error_message: str = ""):
        """Initialize a validation result.

        Args:
            is_valid: Whether the parameter is valid
            error_message: Optional error message for invalid parameters
        """
        self.is_valid: bool = is_valid
        self.error_message: str = error_message

    @property
    def is_error(self) -> bool:
        """Check if the validation resulted in an error.

        Returns:
            True if there was a validation error, False otherwise
        """
        return not self.is_valid


def validate_parameter(
    parameter: Any, parameter_name: str, allow_empty: bool = False
) -> ValidationResult:
    """Validate a single parameter.

    Args:
        parameter: The parameter value to validate
        parameter_name: The name of the parameter (for error messages)
        allow_empty: Whether to allow empty strings, lists, etc.

    Returns:
        A ValidationResult indicating whether the parameter is valid
    """
    # Check for None
    if parameter is None:
        return ValidationResult(
            is_valid=False,
            error_message=f"Parameter '{parameter_name}' is required but was None",
        )

    # Check for empty strings
    if isinstance(parameter, str) and not allow_empty and parameter.strip() == "":
        return ValidationResult(
            is_valid=False,
            error_message=f"Parameter '{parameter_name}' is required but was empty string",
        )

    # Check for empty collections
    if (
        isinstance(parameter, (list, tuple, dict, set))
        and not allow_empty
        and len(parameter) == 0
    ):
        return ValidationResult(
            is_valid=False,
            error_message=f"Parameter '{parameter_name}' is required but was empty {type(parameter).__name__}",
        )

    # Parameter is valid
    return ValidationResult(is_valid=True)


def validate_path_parameter(
    path: str | None, parameter_name: str = "path"
) -> ValidationResult:
    """Validate a path parameter.

    Args:
        path: The path parameter to validate
        parameter_name: The name of the parameter (for error messages)

    Returns:
        A ValidationResult indicating whether the parameter is valid
    """
    # Check for None
    if path is None:
        return ValidationResult(
            is_valid=False,
            error_message=f"Path parameter '{parameter_name}' is required but was None",
        )

    # Check for empty path
    if path.strip() == "":
        return ValidationResult(
            is_valid=False,
            error_message=f"Path parameter '{parameter_name}' is required but was empty string",
        )

    # Path is valid
    return ValidationResult(is_valid=True)


def validate_parameters(**kwargs: Any) -> ValidationResult:
    """Validate multiple parameters.

    Accepts keyword arguments where the key is the parameter name and the value is the parameter value.

    Args:
        **kwargs: Parameters to validate as name=value pairs

    Returns:
        A ValidationResult for the first invalid parameter, or a valid result if all are valid
    """
    for name, value in kwargs.items():
        result = validate_parameter(value, name)
        if result.is_error:
            return result

    # All parameters are valid
    return ValidationResult(is_valid=True)
