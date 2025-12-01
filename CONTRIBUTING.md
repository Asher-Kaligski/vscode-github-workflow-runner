# Contributing to GitHub Workflow Runner

Thank you for your interest in contributing to the GitHub Workflow Runner VS Code extension! This document provides guidelines and instructions for contributing to the project.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Code Quality Standards](#code-quality-standards)
- [Testing Requirements](#testing-requirements)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Branch Naming Conventions](#branch-naming-conventions)
- [Documentation Structure](#-documentation-structure)

## 📜 Code of Conduct

This project adheres to the Contributor Covenant Code of Conduct. By participating, you are expected to uphold this code. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: Version 22 or higher
- **npm**: Latest version
- **VS Code**: Latest version
- **Git**: For version control
- **GitHub Account**: For authentication testing

### Development Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:

   ```bash
   git clone https://github.com/YOUR_USERNAME/vscode-github-workflow-runner.git
   cd vscode-github-workflow-runner
   ```

3. **Add upstream remote**:

   ```bash
   git remote add upstream https://github.com/Asher-Kaligski/vscode-github-workflow-runner.git
   ```

4. **Install dependencies**:

   ```bash
   npm install
   ```

5. **Build the extension**:

   ```bash
   npm run compile
   ```

6. **Run in development mode**:
   - Press `F5` in VS Code to open a new Extension Development Host window
   - The extension will be loaded and ready for testing

## 🤝 How to Contribute

### Reporting Bugs

If you find a bug, please create an issue using the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Clear description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)
- Environment details (VS Code version, OS, Node.js version)

### Suggesting Features

For feature requests, use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md). Include:

- Clear description of the feature
- Use case and motivation
- Proposed implementation (if you have ideas)
- Alternative solutions considered

### Submitting Code Changes

1. **Check existing issues** to see if someone is already working on it
2. **Create an issue** if one doesn't exist
3. **Comment on the issue** to let others know you're working on it
4. **Follow the development workflow** outlined below

## 🔄 Pull Request Process

### Before Submitting

1. **Sync with upstream**:

   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```

2. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Make your changes** following our code quality standards

4. **Test thoroughly**:

   ```bash
   npm run compile
   npm test
   ```

5. **Commit your changes** following our commit message guidelines

### Submitting the PR

1. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub with:

   - Clear title describing the change
   - Reference to related issue(s)
   - Description of changes made
   - Screenshots/GIFs for UI changes
   - Checklist completed (from PR template)

3. **Wait for review**:
   - **All PRs require review and approval from Asher Kaligski before merge**
   - Address any feedback or requested changes
   - Keep your PR up to date with the main branch

### PR Requirements

- ✅ Code compiles without errors
- ✅ All tests pass
- ✅ No TypeScript errors
- ✅ Documentation updated (if applicable)
- ✅ CHANGELOG.md updated (for significant changes)
- ✅ Tested in VS Code Extension Development Host
- ✅ No breaking changes (or clearly documented)

## 💎 Code Quality Standards

### TypeScript Guidelines

- Use **strict TypeScript** settings
- Prefer `unknown` over `any` for better type safety
- Use explicit return types for functions
- Avoid `@ts-ignore` comments (use `@ts-expect-error` with explanation if necessary)
- Use proper error handling with try-catch blocks

### Code Style

- **Indentation**: 4 spaces (configured in `.editorconfig`)
- **Line length**: Maximum 120 characters
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Trailing commas**: Required for multi-line objects/arrays

### Best Practices

- **Early returns**: Avoid deep nesting by returning early
- **Descriptive names**: Use clear, self-documenting variable and function names
- **Comments**: Add JSDoc comments for public functions
- **DRY principle**: Don't repeat yourself - extract reusable code
- **Single responsibility**: Each function should do one thing well
- **Error handling**: Always handle errors gracefully with user-friendly messages

### Svelte Components

- Keep components small and focused
- Use TypeScript in `<script lang="ts">` blocks
- Follow reactive statement best practices
- Use proper prop typing with `export let`
- Add transitions for better UX

## 🧪 Testing Requirements

### Manual Testing

Before submitting a PR, test the following:

1. **Extension activation**: Extension loads without errors
2. **Authentication**: GitHub token validation works
3. **Workflow dispatch**: Can trigger workflows successfully
4. **UI rendering**: All UI components render correctly
5. **Error handling**: Errors are displayed properly to users
6. **Edge cases**: Test with invalid inputs, network failures, etc.

### Automated Testing

- Add unit tests for new utility functions
- Test error handling paths
- Run all tests before submitting: `npm test`

### Testing Checklist

- [ ] Tested in VS Code Extension Development Host
- [ ] Tested with valid GitHub token
- [ ] Tested with invalid/expired token
- [ ] Tested workflow dispatch with various input types
- [ ] Tested error scenarios (network failures, API errors)
- [ ] Tested on different operating systems (if possible)

## 📝 Commit Message Guidelines

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring (no feature change or bug fix)
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks, dependency updates

### Examples

```
feat(workflow): add support for environment inputs

- Added environment input type to workflow form
- Updated form generator to handle environment selection
- Added tests for environment input validation

Closes #123
```

```
fix(auth): handle expired token gracefully

Previously, expired tokens would cause the extension to crash.
Now displays a user-friendly error message and prompts for re-authentication.

Fixes #456
```

## 🌿 Branch Naming Conventions

Use descriptive branch names with the following prefixes:

- `feature/` - New features (e.g., `feature/add-workflow-templates`)
- `fix/` - Bug fixes (e.g., `fix/token-validation-error`)
- `docs/` - Documentation updates (e.g., `docs/update-readme`)
- `refactor/` - Code refactoring (e.g., `refactor/simplify-api-client`)
- `test/` - Test additions/updates (e.g., `test/add-auth-tests`)
- `chore/` - Maintenance tasks (e.g., `chore/update-dependencies`)

## 🎯 Development Tips

### Debugging

- Use VS Code's built-in debugger (F5)
- Check the Extension Development Host console for errors
- Use `console.log` in webview code (visible in Developer Tools)
- See [DEBUGGING.md](DEBUGGING.md) for detailed debugging guide

### Hot Reload

- Changes to TypeScript code require recompiling (`npm run compile`)
- Reload the Extension Development Host window (Ctrl+R / Cmd+R)
- Svelte changes require rebuilding the webview

### Useful Commands

```bash
npm run compile          # Compile TypeScript
npm run watch           # Watch mode for development
npm run package         # Build production bundle
npm run vsce:package    # Create VSIX package
```

## 📁 Documentation Structure

### Directory Organization

The documentation is organized into a hierarchical structure for clarity and maintainability:

```
├── README.md                    # User-facing documentation (features, installation, usage)
├── CONTRIBUTING.md              # Contributor guidelines (this file)
├── CODE_OF_CONDUCT.md           # Community conduct rules
├── docs/                        # Technical documentation
│   ├── IMPLEMENTATION.md        # Implementation overview and project structure
│   ├── WORKFLOW_RERUN_LOGIC.md  # Feature-specific technical documentation
│   ├── WORKFLOW_RUNS_ARCHITECTURE.md  # Comprehensive architecture guide
│   └── architecture/            # Deep-dive architecture documentation
│       ├── WORKFLOW_RUNS_FILTERING.md           # Detailed filtering system guide
│       └── WORKFLOW_RUNS_ARCHITECTURE_DIAGRAMS.md # Standalone Mermaid diagrams
└── .github/
    └── ISSUE_TEMPLATE/          # GitHub issue templates
        ├── bug_report.md
        └── feature_request.md
```

**Rationale for Subfolder Organization:**

| Location                    | Purpose                                                                     | Audience                          |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------- |
| **Root level**              | Standard open-source project files that GitHub and users expect at the root | All users and contributors        |
| **docs/**                   | Technical documentation that goes beyond basic usage                        | Developers and contributors       |
| **docs/architecture/**      | Deep-dive architecture docs with diagrams and implementation details        | Core contributors and maintainers |
| **.github/ISSUE_TEMPLATE/** | GitHub-specific templates (required location by GitHub)                     | Issue reporters                   |

### File Naming Convention

We follow these naming conventions for markdown files:

| Location                    | Convention     | Examples                                       | Rationale                                            |
| --------------------------- | -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| **Root level**              | `UPPERCASE.md` | `README.md`, `CONTRIBUTING.md`                 | Industry standard for important project files        |
| **docs/**                   | `UPPERCASE.md` | `IMPLEMENTATION.md`, `WORKFLOW_RERUN_LOGIC.md` | Consistency with root-level docs; signals importance |
| **docs/architecture/**      | `UPPERCASE.md` | `WORKFLOW_RUNS_FILTERING.md`                   | Consistency with parent directory                    |
| **.github/ISSUE_TEMPLATE/** | `lowercase.md` | `bug_report.md`, `feature_request.md`          | GitHub convention for templates                      |

**Note:** All documentation files now follow the `UPPERCASE.md` convention for consistency.

### When to Create New Documentation

- **Root level**: Only for standard project files (LICENSE, SECURITY.md, etc.)
- **docs/**: For new feature documentation, guides, or technical explanations
- **docs/architecture/**: For detailed system architecture, diagrams, or implementation deep-dives

## 📚 Additional Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [GitHub REST API Documentation](https://docs.github.com/en/rest)
- [Svelte Documentation](https://svelte.dev/docs)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## 🙏 Thank You

Thank you for contributing to the GitHub Workflow Runner! Your contributions help make this extension better for everyone.

If you have questions, feel free to:

- Open an issue for discussion
- Reach out to the maintainer: [Asher Kaligski](https://github.com/Asher-Kaligski)

Happy coding! 🚀
