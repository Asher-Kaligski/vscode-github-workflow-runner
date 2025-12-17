# Change Log

All notable changes to the "github-workflow-runner" extension will be documented in this file.

## [1.2.0] - 2025-12-16

### ✨ New Features

- **Interactive Log Viewer:** A brand new GitHub-inspired log viewer for workflow jobs.
  - Collapsible log groups that mimic GitHub's native log viewing UI
  - Expand/collapse sections to focus on relevant log output
  - Syntax highlighting for GitHub Actions logs via TextMate grammar
  - Search functionality within logs with match navigation
  - Toggle timestamps visibility
  - Download logs as raw text files
  - Auto-scroll and expand to specific step when viewing step logs
  - ⚠️ **Beta:** The log parsing and grouping functionality is experimental. Logs from one step may occasionally appear in another step's section due to limitations in the current parsing algorithm. For accurate, ungrouped log viewing, use the "Raw" log viewer as an alternative.

- **Step-Level Log Navigation:** Click on individual job steps to view their specific logs.
  - Re-enabled step log viewing from the Job Steps Modal
  - Clicking a step automatically opens the interactive log viewer and scrolls to that step
  - Step logs are highlighted and auto-expanded for immediate visibility

- **GitHub Summary Integration:** Quick access to GitHub workflow run summaries.
  - New "View GitHub Summary" button in the Run Summary section
  - Opens the GitHub Actions run page directly in your browser

- **Syntax Highlighting for Logs:** GitHub Actions logs now have proper syntax highlighting.
  - New TextMate grammar for `github-actions-log` language
  - Highlights group markers, timestamps, error/warning messages, and more

### 🎨 Changed

- **Presets UI Redesign:** Presets have been moved from Advanced Configuration to a dedicated section.
  - New **"Presets"** labeled button in the workflow actions toolbar (next to Reload and Open File)
  - **Enhanced button design** with text label, bookmark icon, and chevron indicator (▼/▶) showing expand/collapse state
  - **Visual prominence** — the Presets button is now visually distinct from icon-only buttons, making it immediately obvious it controls an expandable section
  - **Chevron rotation** — chevron points right (▶) when collapsed, down (▼) when expanded
  - **Active state highlighting** — button uses primary color when the presets panel is open
  - Expandable presets panel with all preset management options
  - New **ℹ️ help icon** in the presets section header with comprehensive documentation modal
  - Cleaner, more accessible preset workflow
  - Pro Tips section updated to reflect the new presets location

- **Dual Log Viewing Options:** Choose between interactive and raw log viewing.
  - "View Logs" button now opens the interactive log viewer with collapsible groups
  - New "Raw" button for viewing plain text logs in VSCode's text editor
  - Job Steps Modal now includes both "View Logs" and "View Raw Logs" buttons

- **Step Duration Display:** Improved step duration formatting in Job Steps Modal.
  - Shows `<1s` for completed steps that executed in under a second
  - Fixed step numbering to use sequential display index (1, 2, 3...) instead of internal step numbers

### 🐛 Fixed

- **Step Logs Re-enabled:** Fixed and re-enabled step-level log viewing that was previously disabled.
  - Step logs now open in the interactive log viewer instead of attempting text extraction
  - Resolved issues with step log extraction by leveraging the new collapsible log groups

- **Job Logs Error Handling:** Improved error feedback when job logs cannot be loaded.
  - Extension now properly sends error responses back to the webview
  - Better user feedback when repository information cannot be retrieved

### 📖 Documentation

- **Updated README:** Revised preset instructions to reflect the new labeled button design with chevron indicator.
- **New Presets Help Modal:** Added comprehensive help documentation for the presets feature, including:
  - Step-by-step instructions for saving, loading, and managing presets
  - Guide for sharing presets with team members via export/import
  - Best practices and tips for organizing presets

### 🔧 Internal

- New `LogViewerPanel` class for managing the interactive log viewer webview
- New `LogViewer.svelte` component with full-featured log parsing and display
- Added `GitHubSummaryModal.svelte` component for summary display
- New `log-viewer-wrapper.js` entry point for Rollup bundling
- TextMate grammar file at `syntaxes/github-actions-log.tmLanguage.json`
- Added `github-actions-log` language contribution to `package.json`
- Extended `WebviewMessageType` with new message types for log viewer and summary features
- New `getGitHubSummary` API function for fetching workflow run summaries

## [1.1.0] - 2025-12-11

### ✨ New Features

- **Job Dependencies Graph:** Visualize workflow job dependencies with an interactive graph view inspired by GitHub's UI.
  - Horizontal left-to-right layout showing execution stages and job dependencies
  - Color-coded job status indicators (success, failure, in-progress, queued, skipped)
  - Animated indicators for running jobs
  - Click on jobs to view step details or logs
  - Full-screen modal view for complex workflows
  - Real-time updates during workflow execution

- **Matrix Job Support:** Matrix jobs are intelligently grouped together in the graph view.
  - Collapsible matrix job groups with aggregated status
  - Expand groups to see individual matrix variants
  - Clear visual distinction between regular jobs and matrix groups

- **Job Steps Modal:** View detailed step information for completed jobs.
  - Step-by-step breakdown with status icons
  - Duration information for each step
  - Quick access to view full job logs

- **Customizable Notification Settings:** Fine-grained control over notification behavior.
  - Workflow Toast Notifications: Toggle toast messages in the top-right corner for workflow start/complete/fail events
  - Progress Indicators: Toggle inline job progress display (e.g., "2/5 jobs completed")
  - All settings persisted across sessions

### 🎨 Changed

- **Default Run View:** Clicking on a workflow run now opens the Job Dependencies Graph view by default (previously opened the Jobs list).
- **Graph Button:** Added a new "Graph" action button to each run for quick access to the dependency visualization.
- **Improved Progress Display:** In-progress runs now show a mini job progress indicator in the run header.
- **Panel Focus Behavior:** Improved webview panel tab management and focus behavior for sidebar actions.
  - "View Workflow Runs" and "View Last Run" actions now always focus the panel
  - "Dispatch" action shows a non-modal prompt asking if you want to switch to the panel (when panel is open but not visible)
  - Panel state (scroll position, expanded sections, filters) is preserved when switching focus
- **State Preservation:** Replaced internal `_update()` calls with `postMessage` to avoid HTML reloads and preserve webview state.

### 📖 Documentation

- Updated "Workflow Runs Panel - Help & Guide" modal with comprehensive documentation for:
  - Job Dependencies Graph features and usage
  - Notification Settings configuration
  - New examples for troubleshooting failed workflows using the graph view

### 🐛 Fixed

- **Watch Runs Only Auto-Refresh:** Fixed auto-refresh functionality not working in "Watch Runs Only" mode. Background data updates now refresh the UI automatically without requiring manual refresh button clicks. The fix ensures watched runs are always updated with fresh data from the API.

### 🔧 Internal

- Added new TypeScript types for graph visualization (`JobGraphNode`, `JobGraphEdge`, `JobDependencyGraph`, etc.)
- New graph layout algorithms and utilities in `webview/utils/graph-utils.ts`
- New Svelte components: `JobDependencyGraph`, `JobGraphModal`, `JobNode`, `GraphConnector`, `MatrixJobGroup`, `JobStepsModal`
- Extended workflow parser to extract job definitions and dependencies from YAML
- Added storage support for notification settings persistence

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
