# 🚀 GitHub Actions Runner for VS Code

[![Requires VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.93-007ACC?logo=visual-studio-code)](https://code.visualstudio.com/)
[![GitHub Stars](https://img.shields.io/github/stars/Asher-Kaligski/vscode-github-workflow-runner?style=social)](https://github.com/Asher-Kaligski/vscode-github-workflow-runner)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/github/sponsors/Asher-Kaligski?label=Sponsor&logo=github)](https://github.com/sponsors/Asher-Kaligski)

**Run and monitor GitHub Actions workflows directly from VS Code — no browser needed.**

Dispatch workflows with dynamic inputs, monitor runs in real-time, save presets, and view logs/artifacts without leaving your editor.

---

## 🎬 See It in Action

![GitHub Actions Runner Demo](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/vscode-github-workflow-runner.gif)

> **Watch the extension in action:** Dispatch workflows, visualize job dependencies, fill dynamic inputs, monitor runs in real-time — all without leaving VS Code.

---

## 💡 Why Use GitHub Actions Runner?

### ⚡ **Stay in Your Flow**

Stop switching between VS Code and GitHub's web UI. Dispatch workflows, monitor runs, and view logs without breaking your development flow.

### 🎯 **Smart & Dynamic**

- **Auto-generated forms** from your workflow YAML — no manual configuration
- **Intelligent input recovery** — rerun workflows with prefilled inputs from previous runs
- **Branch auto-detection** — automatically uses your current Git branch
- **Smart File Input** — enhanced input fields with file path autocomplete, content extraction, and favorites

### 📁 **Smart File Input** _(New in v1.3.0)_

Enhanced input fields that make working with file-based values effortless:

- **Three Input Modes:** Switch between Text, Path, and Content modes using the mode selector
- **Path Mode:** Browse and insert file paths from your workspace
- **Content Extraction:** Load values from JSON, YAML, CSV, ENV, and text files with multi-select
- **File Favorites:** Save frequently used files with custom nicknames
- **Recent Files:** Automatically tracks your recently used files per input
- **Preview/Edit Modal:** View and edit multi-value inputs in a list format

### 💾 **Reusable Presets**

Save workflow configurations as named presets (e.g., "Staging Deploy", "Production Release") and dispatch them with one click. Export/import presets to share with your team.

### ⭐ **Favorites & Quick Access**

Mark frequently used workflows as favorites for instant access. Pin workflows to filter runs and find what matters most.

### 📊 **Real-Time Monitoring**

- Live status updates with color-coded indicators
- **Interactive job dependencies graph** with execution stages
- **Adaptive auto-refresh** — speeds up polling when workflows are running _(New in v1.4.0)_
- **Cancel confirmation modal** — prevents accidental cancellation with detailed verification _(New in v1.4.0)_
- **Real-time API rate limit monitoring** — track GitHub API usage with visual progress bar _(New in v1.4.0)_
- **Rate limit protection** — automatic throttling to prevent hitting API limits _(New in v1.4.0)_
- Filter by workflow, branch, PR, or marked workflows
- View logs directly in VS Code editor
- Download artifacts with one click
- Rerun failed jobs or entire workflows
- **Click jobs to view step details**

### 🔐 **Secure & Flexible**

- GitHub OAuth or Personal Access Token (PAT) authentication
- Secure token storage using VS Code SecretStorage
- Works with any GitHub repository

---

## 🚀 Quick Start

### 1️⃣ **Install the Extension**

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=asher-kaligski.github-workflow-runner) or search for "GitHub Actions Runner" in VS Code.

### 2️⃣ **Authenticate with GitHub**

1. Click the **GitHub Actions Runner** icon in the sidebar
2. Click **"Sign in with GitHub"** or **"Use Personal Access Token"**
3. If using PAT, create one with `workflow` scope at [github.com/settings/tokens](https://github.com/settings/tokens)

### 3️⃣ **Dispatch Your First Workflow**

1. Open a repository with GitHub Actions workflows
2. Select a workflow from the dropdown (only `workflow_dispatch` workflows are shown)
3. Fill in any required inputs
4. Select a branch (defaults to your current branch)
5. Click **"Dispatch Workflow"** 🚀

### 4️⃣ **Monitor Workflow Runs**

1. Click **"Open Workflow Runs"** to view all runs
2. **Click on a run** to see the job dependencies graph
3. Filter by workflow, branch, PR, or marked workflows
4. **Click on a job** in the graph to view step details
5. Click **"View Logs"** to see job logs in VS Code
6. Click **"Download Artifacts"** to download build artifacts
7. Click **"Rerun"** to rerun workflows with smart input recovery

### 5️⃣ **Save Presets for Quick Access**

1. Fill in workflow inputs
2. Click the **"Presets"** button to expand the presets panel
3. Click **"Save preset"** and give it a name (e.g., "Production Deploy")
4. Load presets anytime from the dropdown selector
5. Use **Rename**, **Export**, **Delete**, or **Import from File** to manage your presets
6. Click **"Storage Info"** to see where presets are stored

**Pro Tip**: Use **Export/Import** to share presets with your team!

---

## 📸 Screenshots

| Feature                                           | Description                                   |
| ------------------------------------------------- | --------------------------------------------- |
| [Workflow Dispatch](#workflow-dispatch)           | Select workflows, fill inputs, and dispatch   |
| [Workflow Runs](#workflow-runs)                   | Monitor runs in real-time with filters        |
| [Watched Runs](#watched-runs)                     | Track important runs across sessions          |
| [Preset Management](#preset-management)           | Save and share reusable configurations        |
| [Favorites](#favorites)                           | Quick access to frequent workflows            |
| [Smart File Input](#smart-file-input)             | Enhanced input with file path & content modes |
| [Logs View](#logs-view)                           | View logs directly in VS Code                 |
| [Job Dependencies Graph](#job-dependencies-graph) | Visualize job execution stages                |
| [Job Step Details](#job-step-details)             | Step-by-step execution details                |
| [Workflow Summary](#workflow-summary)             | GitHub step summaries and annotations         |
| [Settings Panel](#settings-panel)                 | General, Notifications, and API Usage tabs    |

### Workflow Dispatch

![Workflow Dispatch](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/hero-workflow-dispatch.png)

> Select workflows, fill inputs, and dispatch with one click

### Workflow Runs

![Workflow Runs](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/workflow-runs-panel.png)

> Monitor runs in real-time with powerful filters

### Watched Runs

![Watched Runs](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/marked-workflows.png)

> Mark important runs as "watched" to track them across sessions regardless of filters

### Preset Management

![Preset Management](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/preset-management-expanded.png)

> Save and load workflow configurations as reusable presets — share configurations with your team via export/import

### Favorites

![Workflow Favorites](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/workflow-favorites.png)

> Quick access to frequently used workflows

### Smart File Input

The Smart File Input feature provides three modes for entering workflow input values, making it easy to work with file-based configurations, test tags, and multi-value inputs.

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/smart-input-preview-modal.png" width="220" alt="Mode selector showing Text, Path, and Content options">

_**Mode Selector** — Switch between Text (direct input), Path (insert file path), and Content (extract from file) modes_

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/smart-input-file-content-modal.png" width="450" alt="Content mode dropdown showing favorites and recent files">

_**Content Mode Dropdown** — Access favorite files and recently used files for quick content extraction_

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/smart-input-content-dropdown.png" width="450" alt="File content modal with extraction options for JSON, YAML, CSV, ENV, and text files">

_**File Content Modal** — Extract values from JSON, YAML, CSV, ENV, and text files with multi-select and configurable delimiters_

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/smart-input-mode-selector.png" width="350" alt="Preview/Edit modal with list mode">

_**Preview/Edit Modal** — View and edit multi-value inputs in list format with favorites support_

### Logs View

![Logs View](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/logs-view.png)

> View workflow logs directly in VS Code editor

### Job Dependencies Graph

![Job Dependencies Graph](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/job-dependencies-graph.png)

> Visualize job dependencies with an interactive graph showing execution stages, matrix jobs, and real-time status updates. Click jobs to view step details.

### Job Step Details

![Job Step Details](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/job-step-details.png)

> Click any job to view step-by-step execution details with status indicators and timing information

### Workflow Summary

![Workflow Summary](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/workflow-summary.png)

> View GitHub step summaries with security scan results, build metadata, and error details — rendered directly from workflow step annotations

### Settings Panel

The Settings Panel provides three tabs for configuring different aspects of the extension:

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/settings-general-tab.png" width="350" alt="Settings General Tab">

_**General Tab** — Configure workflow runs per page, run limits, and date filters_

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/settings-notifications-tab.png" width="350" alt="Settings Notifications Tab">

_**Notifications Tab** — Control toast notifications and progress indicators for workflow events_

<img src="https://github.com/Asher-Kaligski/vscode-github-workflow-runner/raw/main/media/settings-api-usage-tab.png" width="350" alt="Settings API Usage Tab">

_**API Usage Tab** — Configure auto-refresh intervals with adaptive refresh (speeds up polling when workflows are running), monitor GitHub API rate limits in real-time with color-coded progress bar, and configure automatic rate limit protection (threshold 50-90%)_

---

## ✨ Features

### 🔧 Workflow Runs Panel

| Feature                    | Description                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **Job Dependencies Graph** | Visualize job dependencies with an interactive graph showing execution stages        |
| **Matrix Job Groups**      | Matrix jobs are intelligently grouped with collapsible views for each variant        |
| **Job Steps Details**      | Click on any job to view step-by-step breakdown with status and duration             |
| **Workflow Summary**       | View GitHub step summaries with build metadata and error details                     |
| **View Logs**              | Open workflow run logs directly in VS Code editor                                    |
| **View Jobs & Steps**      | Expand any run to see individual jobs with status, duration, and step details        |
| **Download Artifacts**     | Download workflow artifacts as ZIP files                                             |
| **Rerun Workflows**        | Rerun all jobs or only failed jobs                                                   |
| **Cancel Runs**            | Cancel in-progress workflows with detailed confirmation modal (name, branch, author) |

### 🔍 Advanced Filtering & Auto-Refresh

| Feature                  | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| **Filter by Status**     | Success, Failure, In Progress, Queued, Cancelled                   |
| **Filter by Actor**      | "My Runs" or "All Users"                                           |
| **Filter by Date Range** | Predefined (Today, Last 7/30 Days) or custom date ranges           |
| **Filter by Workflow**   | Focus on runs from a specific workflow                             |
| **Search by Text**       | Search runs by branch name, commit, or PR number                   |
| **Show Bot Runs**        | Include or exclude runs triggered by bot accounts                  |
| **Favorites Only**       | Show only runs from workflows marked as favorite                   |
| **Pagination**           | Configure runs per page (10/20/30/50/100)                          |
| **Progressive Loading**  | Fetches up to 10,000 runs with smart caching                       |
| **Auto-Refresh**         | Configurable interval (15s–3m) with smart pause                    |
| **Adaptive Refresh**     | Automatically speeds up polling (5-10s) when workflows are running |

### 👁️ Watched Runs

- **Watch Important Runs** — Mark any run as "watched" to track it regardless of filters
- **Persistent Tracking** — Watched runs persist across sessions (up to 20 per repository)
- **Dedicated Filter** — Toggle "Watched Runs Only" to see all your tracked runs

### 💾 Presets & Templates

- **Save Presets** — Save workflow configurations with custom names (e.g., "Staging Deploy")
- **Quick Load** — Select presets from dropdown to populate inputs instantly
- **Export/Import** — Share presets with your team via JSON export
- **Workflow History** — Track your dispatched workflows and rerun with one click

### ⭐ Favorites System

- **Mark Favorites** — Star frequently used workflows for instant access
- **Pre-filled Inputs** — Automatically populate workflow inputs from favorites
- **Workspace/Global Scope** — Choose between workspace-specific or global storage
- **Visual Cards** — Browse favorites with workflow name, repository, and branch info

### 📁 File Path Detection

- **Auto-Detection** — Detects file path parameters based on configurable keywords
- **Native File Picker** — Browse and select files using VS Code's file picker
- **Smart Paths** — Uses workspace-relative paths when possible
- **Size Warnings** — Warnings for large files (configurable threshold)

### 🔐 Authentication

- **OAuth Support** — Use VS Code's built-in GitHub authentication (recommended)
- **PAT Support** — Personal Access Token with `workflow` scope
- **Secure Storage** — Tokens stored in VS Code SecretStorage (encrypted)
- **User Display** — Shows authenticated GitHub username with profile icon

### 🔔 Notifications

- **Desktop Notifications** — Get notified when workflows complete
- **Configurable Alerts** — Choose when to receive notifications (success/failure)
- **Non-Intrusive** — Stay informed without switching contexts
- **Workflow Toast Notifications** — Toast messages in the top-right corner for workflow start/complete/fail events
- **Progress Indicators** — Inline job progress display (e.g., "2/5 jobs completed")

### ⚡ Adaptive Auto-Refresh _(New in v1.4.0)_

- **Smart Polling** — Automatically increases refresh frequency when in-progress or queued runs are detected
- **Configurable Fast Interval** — Set your preferred fast refresh rate (5-10 seconds) via Settings panel slider
- **Visual Indicator** — Shows "⚡ Faster refresh active" when adaptive mode is engaged
- **API-Friendly** — Falls back to normal interval when workflows complete, preserving API quota
- **Toggle Control** — Enable/disable with a single click in the Settings panel

### 🧠 Memory Management _(New in v1.4.0)_

- **Automatic Cleanup** — Clears per-run state for runs no longer visible in the panel
- **Cache Limiting** — Prevents memory bloat during long monitoring sessions
- **Background Optimization** — Cleanup runs during refresh cycles without impacting UX

### 📊 Rate Limit Monitoring _(New in v1.4.0)_

- **Real-Time Display** — See remaining API requests and total limit (e.g., "4,521 / 5,000")
- **Visual Progress Bar** — Color-coded indicator (green → yellow → red) based on usage
- **Reset Time** — Shows when your rate limit will reset
- **Automatic Protection** — Optional throttling when usage exceeds configurable threshold (50-90%)
- **Persistent Settings** — Rate limit protection preferences are saved across sessions

### 🏥 Health Monitor _(New in v1.4.0)_

- **Automatic Detection** — Identifies stuck loading states and stale timers
- **Recovery Actions** — Reset State, Refresh Data, and Restart Auto-refresh buttons
- **Smart Suppression** — Respects user activity to avoid false positive notifications
- **Dismissible Banner** — Can be dismissed but will return if issues persist

## ⚙️ Configuration

Access settings via `File > Preferences > Settings` and search for "GitHub Actions Runner". You can also open settings directly from the Sidebar using the ⚙️ Settings button in the Repository Configuration section.

### Repository Settings

- `githubWorkflowRunner.repository.owner`: Repository owner/organization (auto-detected)
- `githubWorkflowRunner.repository.name`: Repository name (auto-detected)
- `githubWorkflowRunner.repository.manualOwner`: Manual override for repository owner
- `githubWorkflowRunner.repository.manualName`: Manual override for repository name
- `githubWorkflowRunner.defaultBranch`: Default branch for dispatch

**Note**: Repository settings can be configured directly in the sidebar UI. Manual overrides take precedence over auto-detection.

### Monitoring Settings

- `githubWorkflowRunner.monitoring.autoRefresh`: Enable auto-refresh
- `githubWorkflowRunner.monitoring.refreshInterval`: Refresh interval (seconds)
- `githubWorkflowRunner.monitoring.maxRuns`: Max runs to display

### UI Settings

- `githubWorkflowRunner.ui.confirmBeforeDispatch`: Show confirmation dialog
- `githubWorkflowRunner.ui.rememberLastWorkflow`: Remember last workflow

### Git Settings

- `githubWorkflowRunner.git.autoDetectBranch`: Auto-detect current branch

### Notification Settings

- `githubWorkflowRunner.notifications.enabled`: Enable notifications
- `githubWorkflowRunner.notifications.onSuccess`: Notify on success
- `githubWorkflowRunner.notifications.onFailure`: Notify on failure
- `githubWorkflowRunner.notifications.showWorkflowToastNotifications`: Show toast notifications in the top-right corner when workflows start, complete, or fail. Default: `true`
- `githubWorkflowRunner.notifications.showProgressIndicators`: Show inline job progress for running workflows. Default: `true`

### Authentication Settings

- `githubWorkflowRunner.authentication.method`: Authentication method to use. Options:
  - `auto` (default): Try OAuth first, fall back to PAT
  - `oauth`: Use VS Code's built-in GitHub authentication (recommended)
  - `pat`: Use Personal Access Token only

### Workflow Settings

- `githubWorkflowRunner.workflows.excludePatterns`: Array of glob-like patterns to exclude workflows from the list (e.g., `["**/experimental-*", "**/legacy.yml"]`). Default: `[]`

### Favorites Settings

- `githubWorkflowRunner.favorites.scope`: Storage scope for favorites, either `workspace` (per-workspace) or `global` (across all workspaces). Default: `workspace`
- `githubWorkflowRunner.favoriteRepositories`: Array of favorite repositories to show in the repository selector. Each item is an object `{ owner: string, name: string }`.

Example:

```json
{
  "githubWorkflowRunner.favoriteRepositories": [
    { "owner": "my-org", "name": "service-a" },
    { "owner": "my-org", "name": "service-b" }
  ]
}
```

### File Path Detection

- `githubWorkflowRunner.filePathDetection.enabled`: Enable automatic file path parameter detection. Default: `true`
- `githubWorkflowRunner.filePathDetection.keywords`: Keywords used to detect file path-like inputs. Default: `["path", "file", "config", "script", "template", "yaml", "json"]`
- `githubWorkflowRunner.filePathDetection.preferRelativePaths`: Prefer workspace-relative paths when possible. Default: `true`
- `githubWorkflowRunner.filePathDetection.warnSizeThreshold`: File size threshold (bytes) above which a warning is shown when loading file contents. Default: `1048576` (1MB)
- `githubWorkflowRunner.filePathDetection.maxFileSize`: Maximum file size (bytes) allowed when loading a file content into an input. Default: `10485760` (10MB)

### Logs

- `githubWorkflowRunner.logs.debug`: Enable verbose debug logging for fetching job logs and artifacts. Default: `false`

## 🎮 Commands

| Command                                     | Description            |
| ------------------------------------------- | ---------------------- |
| `GitHub Actions Runner: Show Workflow Runs` | Open monitoring panel  |
| `GitHub Actions Runner: Hide Workflow Runs` | Close monitoring panel |
| `GitHub Actions Runner: Refresh Workflows`  | Reload workflow list   |
| `GitHub Actions Runner: Run Last Workflow`  | Rerun last workflow    |

## 🏗️ Architecture

### Documentation

For detailed architecture documentation, see:

- **[📘 Complete Architecture Guide](docs/WORKFLOW_RUNS_ARCHITECTURE.md)** - Comprehensive guide with embedded diagrams, code examples, and detailed explanations
- **[Workflow Runs Filtering System](docs/architecture/WORKFLOW_RUNS_FILTERING.md)** - Detailed implementation guide
- **[Architecture Diagrams](docs/architecture/WORKFLOW_RUNS_ARCHITECTURE_DIAGRAMS.md)** - Standalone Mermaid diagrams

### Supported Input Types

- **string**: Text input field
- **choice**: Dropdown select with options
- **boolean**: Checkbox
- **number**: Number input
- **environment**: Environment selector (if defined)

### Workflow Requirements

Workflows must have a `workflow_dispatch` trigger with optional inputs:

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy'
        required: true
        type: choice
        options:
          - dev
          - staging
          - production
      version:
        description: 'Version to deploy'
        required: true
        type: string
      dry_run:
        description: 'Perform dry run'
        required: false
        type: boolean
        default: false
```

## 🔧 Troubleshooting

### Authentication Issues

- Verify token has `workflow` scope
- Try signing out and back in

### Workflow Not Found

- Ensure workflow has `workflow_dispatch` trigger
- Check workflow file is in `.github/workflows/`
- Verify YAML syntax is valid

### Branch Not Detected

- Ensure you're in a Git repository
- Check Git extension is enabled in VS Code
- Verify repository has commits

### Git Context Changed Warning

If you see a warning about "Git repository or branch has changed":

- This occurs when you switch branches or repositories while the extension is open
- Click the **"Reload"** button in the sidebar to refresh the extension state
- This safety feature prevents accidentally dispatching workflows to the wrong branch/repository

## 📝 License

Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 💖 Sponsor

If you find this extension helpful, please consider [sponsoring my work](https://github.com/sponsors/Asher-Kaligski)! Your support helps me:

- ⏰ Dedicate more time to development and maintenance
- 🐛 Fix bugs and improve stability faster
- ✨ Build new features requested by the community
- 📚 Create better documentation and tutorials

Every contribution, no matter the size, makes a real difference and is greatly appreciated! 🙏

[![Sponsor](https://img.shields.io/github/sponsors/Asher-Kaligski?label=Sponsor&logo=github&style=for-the-badge)](https://github.com/sponsors/Asher-Kaligski)

## 📞 Support

For issues or questions, please [open an issue](https://github.com/Asher-Kaligski/vscode-github-workflow-runner/issues) on GitHub.
