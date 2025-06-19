# Contributing to Hanzo MCP

[![Open in Hanzo.App](https://img.shields.io/badge/Open%20in-Hanzo.App-8A2BE2?style=for-the-badge&logo=rocket)](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp)
[![Contribute with Hanzo Dev](https://img.shields.io/badge/Contribute%20with-Hanzo%20Dev-00D4AA?style=for-the-badge&logo=code)](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=contribute)

We love your input! We want to make contributing to Hanzo MCP as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## =€ Quick Start with Hanzo Dev

**New to the project?** Get started instantly with Hanzo Dev - our AI-powered development assistant:

1. **[Launch the project in Hanzo.App](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp)** - No local setup required!
2. **[Use Hanzo Dev to contribute](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=contribute)** - AI helps you understand the codebase and implement features
3. **[Fix bugs automatically](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=bugfix)** - Let AI identify and fix issues
4. **[Add new features](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=feature)** - AI-assisted feature development

## We Develop with GitHub

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

## We Use [GitHub Flow](https://guides.github.com/introduction/flow/index.html)

Pull requests are the best way to propose changes to the codebase:

1. **Fork the repo** and create your branch from `main`
2. **Make your changes** - use [Hanzo Dev](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp) for AI-assisted development
3. **Add tests** if you've added code that should be tested
4. **Ensure the test suite passes** by running `make test`
5. **Make sure your code lints** by running `make lint`
6. **Issue that pull request!**

## Any Contributions You Make Will Be Under the MIT Software License

In short, when you submit code changes, your submissions are understood to be under the same [MIT License](http://choosealicense.com/licenses/mit/) that covers the project. Feel free to contact the maintainers if that's a concern.

## Report Bugs Using GitHub's [Issues](https://github.com/hanzoai/mcp/issues)

We use GitHub issues to track public bugs. Report a bug by [opening a new issue](https://github.com/hanzoai/mcp/issues/new); it's that easy!

**Great Bug Reports** tend to have:

- A quick summary and/or background
- Steps to reproduce
  - Be specific!
  - Give sample code if you can
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

People *love* thorough bug reports. I'm not even kidding.

## Development Environment Setup

### Traditional Setup

```bash
# Clone the repository
git clone https://github.com/hanzoai/mcp.git
cd mcp

# Install Python 3.13 using uv
make install-python

# Setup virtual environment and install dependencies
make setup

# Install with development dependencies
make install-dev

# Run tests
make test

# Run linting
make lint
```

### Using Hanzo.App (Recommended for New Contributors)

1. **[Open in Hanzo.App](https://hanzo.app/launch?repo=https://github.com/hanzoai/mcp)** - Instant development environment
2. **Use Hanzo Dev** for AI-assisted coding, testing, and debugging
3. **No local setup required** - everything runs in the cloud
4. **Collaborative features** - pair program with AI and team members

## Testing

We use pytest for testing. Make sure to add tests for new functionality:

```bash
# Run all tests
make test

# Run tests with coverage
make test-cov

# Run specific test file
pytest tests/test_specific_file.py
```

## Code Style

We use several tools to maintain code quality:

- **Black** for code formatting
- **isort** for import sorting  
- **Ruff** for linting
- **mypy** for type checking

Run all checks with:
```bash
make lint
```

## Documentation

- Keep docstrings up to date
- Add type hints to new functions
- Update relevant documentation in the `docs/` directory
- Consider adding examples in `docs/USEFUL_PROMPTS.md`

## Proposing New Features

We love new ideas! Before implementing a major feature:

1. **Open an issue** to discuss the feature
2. **Use [Hanzo Dev](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp&action=feature)** to prototype and implement
3. **Get feedback** from maintainers and community
4. **Submit a pull request** with tests and documentation

## Community Guidelines

- Be respectful and inclusive
- Help others learn and grow
- Share knowledge and best practices
- Celebrate contributions of all sizes
- Use [Hanzo Dev](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp) to help newcomers get started

## Questions?

- Check out our [documentation](./docs/)
- Browse [useful prompts](./docs/USEFUL_PROMPTS.md)
- Open an issue for discussion
- Try [Hanzo Dev](https://hanzo.app/dev?repo=https://github.com/hanzoai/mcp) for AI-powered assistance

## Recognition

Contributors are recognized in our:
- GitHub contributors list
- Release notes
- Documentation acknowledgments

Thank you for considering contributing to Hanzo MCP! <‰

---

*Made with d by the Hanzo community*