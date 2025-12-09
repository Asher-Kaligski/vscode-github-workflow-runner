# Change Log

All notable changes to the "github-workflow-runner" extension will be documented in this file.

## [1.0.2] - 2025-12-09

### 🎨 Changed

- Refreshed activity bar icon with improved visual design.
- Updated extension preview imagery in the VS Code Marketplace.

### 🔧 Internal

- Added CI/CD pipeline with automated testing, linting, and format checking.
- Improved code quality and maintainability through refactoring.

## [1.0.0] - 2025-11-29

### Initial Release 🚀

**GitHub Workflow Runner** is now available! This extension allows you to run, monitor, and manage GitHub Actions workflows directly from VS Code.

### ✨ Key Features

- **Workflow Dispatch:**
  - Dispatch workflows with dynamic inputs (string, choice, boolean, number, environment).
  - Auto-detects current Git branch for dispatch.
  - Supports manual branch selection.
  - **File Path Detection:** Automatically detects file path inputs and provides a native VS Code file picker.

- **Real-Time Monitoring:**
  - **Workflow Runs Panel:** A dedicated view to monitor workflow runs in real-time.
  - **Live Updates:** Status indicators (queued, in-progress, success, failure) update automatically.
  - **Logs:** View live job logs directly in the VS Code editor.
  - **Artifacts:** Download workflow artifacts (ZIP) with one click.

- **Productivity Tools:**
  - **Presets:** Save frequently used workflow configurations as named presets.
  - **Favorites:** Mark workflows as favorites for quick access.
  - **History:** Tracks your dispatch history for easy reruns.
  - **Rerun:** Rerun failed jobs or entire workflows with previous inputs.
  - **Smart Recovery:** Recover inputs from previous runs (even from artifacts).

- **Filtering & Search:**
  - Filter runs by Status, Actor (User), Branch, PR, or Workflow.
  - "My Runs" filter to see only your dispatches.
  - Search workflows by name.

- **Authentication:**
  - Supports **GitHub OAuth** (VS Code built-in) and **Personal Access Tokens (PAT)**.
  - Secure token storage using VS Code SecretStorage.

- **Configuration:**
  - Customizable refresh intervals.
  - Workspace-specific or global favorites.
  - Configurable notifications for workflow completion.
