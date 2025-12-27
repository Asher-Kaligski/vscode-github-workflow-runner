# Change Log

All notable changes to the "github-workflow-runner" extension will be documented in this file.

## [1.5.0] - 2025-12-27

### ✨ New Features

- **Step-Level Log Viewing:** View logs for individual job steps directly from the Job Steps Modal.
  - Click the "View Logs" button on any step to open its logs in the interactive log viewer
  - Logs are filtered to show only the selected step's output
  - Maintains full log viewer functionality (search, expand/collapse, download)

- **Interactive Log Viewer in Job Graph:** Click on any job in the dependency graph to open the interactive log viewer.
  - Re-enabled interactive log viewing feature for job nodes
  - View detailed logs with collapsible groups matching GitHub's native UI

### 🔧 Technical Improvements

- **API Efficiency Optimization:** Reduced GitHub API calls to minimize rate limit usage.
  - Always fetches 100 runs per API request (GitHub's maximum) regardless of UI page size
  - Reduces API calls by up to 5x when client-side filters have low match rates
  - `perPage` option is now only used for UI display purposes

- **Large Log File Safety:** Added protection against memory issues when viewing large logs.
  - Warning notification for logs exceeding 50MB
  - Automatic truncation for logs exceeding 100MB (preserves first 90MB + last 10MB)
  - Suggests using "View Raw Logs" for better performance with large files
  - Prevents UI freezing and out-of-memory errors

- **Improved Log Parsing:** Enhanced log parsing algorithm for better accuracy.
  - Sequential boundary approach for step-to-group matching
  - Proper nesting depth tracking with MAX_PARSE_DEPTH safety cap (50 levels)
  - Improved handling of self-hosted runner hook scripts
  - Better categorization of setup, main, and post steps
  - Enhanced action/command matching with comprehensive keyword mappings
  - Circular reference detection in recursive log group rendering

- **Memory Leak Prevention:** Improved resource cleanup in log viewer panel.
  - Prevents double-dispose errors with tracking flag
  - Clears raw logs and repository info on dispose
  - Early return when panel is being disposed

- **Enhanced Workflow State Management:** More robust handling of workflow and repository switching.
  - Sentinel value for `pendingWorkflowId` prevents stale data during workflow ID resolution
  - Reset caches, watched runs, and UI state when repository changes
  - Auto-refresh pauses during workflow switches to prevent race conditions
  - Resume auto-refresh after error recovery

- **Debug Logging:** Added detailed logging for workflow run fetching and message handling.
  - Traces workflow ID resolution and mismatches
  - Warns when workflow filter is set but ID is undefined
  - Logs progressive fetch parameters for troubleshooting

### 🐛 Fixed

- **Duplicate API Calls:** Fixed duplicate workflow runs API calls during webview initialization.
  - Webview now handles run fetching via `getWorkflowRuns` message instead of automatic `_sendWorkflowRuns()` call

## [1.4.0] - 2025-12-24

### ✨ New Features

- **Cancel Workflow Confirmation Modal:** Added a detailed confirmation dialog before canceling workflow runs.
  - Displays workflow name, branch, and author for verification
  - Prevents accidental cancellation of important runs
  - Clear "Dismiss" and "Cancel Run" action buttons
  - Keyboard accessible (Escape to close)

- **Adaptive Auto-Refresh:** Intelligent polling that adjusts based on workflow activity.
  - Automatically speeds up refresh interval (5-10s configurable) when in-progress or queued runs are detected
  - Falls back to your main auto-refresh interval when all runs are stable
  - Configurable fast refresh interval via slider in Settings panel
  - Enable/disable toggle with informative help modal
  - Visual indicator shows when adaptive refresh is active ("⚡ Faster refresh active due to in-progress runs")
  - Balances responsiveness with API quota preservation

- **Real-Time Rate Limit Monitoring:** Track GitHub API usage directly in the Settings panel.
  - Live display of remaining API requests with color-coded progress bar (green → yellow → red)
  - Shows exact remaining/limit values (e.g., "4,521 / 5,000")
  - Displays time until rate limit resets
  - Updates automatically with each API response

- **Rate Limit Protection:** Automatic throttling to prevent hitting API limits.
  - Configurable threshold (50-90%, default 70%) at which protection activates
  - When enabled, auto-refresh is paused to preserve API quota
  - Warning indicator appears in API Usage tab when threshold is exceeded
  - Toggle to enable/disable protection with persistent settings

- **Health Monitor Notification Banner:** Detects and helps recover from unresponsive panel states.
  - Automatically detects stuck loading states and stale timers
  - Displays informative banner with specific issue details
  - Three recovery actions: Reset State, Refresh Data, Restart Auto-refresh
  - Respects user activity to avoid false positives
  - Dismissible with automatic re-detection if issue persists

- **Filter Help Modals:** Added help buttons to Watched Runs and Favorites filter messages.
  - Explains what each filter mode does
  - Describes which filters are disabled and why
  - Accessible via ℹ️ icon next to filter status messages

- **Memory Management System:** Improved performance and resource usage for workflow runs.
  - Clears per-run state (expanded sections, job data) when runs are no longer visible
  - Limits cache entries to prevent memory bloat during long sessions
  - Automatic cleanup during background refresh cycles
  - Reduces memory footprint when monitoring many workflow runs

### 🎨 Enhancements

- **Improved Workflow Filtering:** Enhanced filtering logic for watched and favorites runs.
  - More accurate filtering when combining multiple filter criteria
  - Better handling of edge cases with watched runs
  - Consistent sorting behavior across filter modes

- **Enhanced Disabled Filter Visual Feedback:** Clearer indication when filters are disabled.
  - Dashed borders on disabled filter controls
  - Lock icon overlay indicating the filter cannot be changed
  - Reduced opacity for disabled state
  - Tooltip explaining why the filter is disabled

- **Settings Panel Improvements:** Better organization and discoverability of settings.
  - API Usage tab now shows real-time rate limit data
  - Improved slider controls for adaptive refresh interval
  - Better visual hierarchy in General tab

### 🔧 Technical Improvements

- Refactored code structure for improved readability and maintainability
- Added debouncing for adaptive refresh recalculation to prevent timer thrashing
- Protection against concurrent background refresh calls during fast refresh intervals
- New storage utilities for persisting adaptive refresh, rate limit, and memory management settings
- Throttled filter recalculation to handle rapid API responses gracefully
- Added `requestAnimationFrame` for job and artifact rendering to improve performance
- Generation counters to invalidate stale API responses during rapid filter changes
- Rate limit information extracted from GitHub API response headers
- Improved error handling with detailed console logging for cancel workflow operations
- Webview ready state tracking to prevent premature message sending

## [1.3.1] - 2025-12-22

### 🐛 Fixed

- **File Content Modal - Reload with Saved Settings:** The "reload with saved settings" icon (history icon) now appears in the File Content Modal header when the current file is a favorite with saved configuration, allowing quick re-extraction with previously saved settings (delimiter, extraction mode, selected values)

- **File Content Modal - Reload Icon Immediate Update:** The reload icon now appears immediately after adding a file to favorites with saved configuration, without needing to close and reopen the modal

- **Preview/Edit Modal - Add Value to Favorites:** Added an input field inside the expanded "⭐ Favorite Values" section to directly add new values to favorites without first adding them to the list

- **Preview/Edit Modal - Text-to-List Sync:** Switching from Text tab to List tab now properly parses the text value using the current delimiter setting and updates the list items accordingly

- **Preview/Edit Modal - Drag-and-Drop Reordering:** Added drag handles (⋮⋮ icon) to list items in the List tab, allowing users to drag and drop items to reorder them

- **Workflow Runs - Sorting for Filtered Views:** Runs are now sorted by creation date (most recent first) when "Watched Runs Only" or "Favorites Only" filters are active, making it easier to find the latest runs

- **Smart File Input - Reload Icon Consistency:** Fixed the reload icon (history icon) appearing incorrectly in the file dropdown. The reload icon now only appears in **Content mode** for files (favorites or recent) that have saved configuration. The icon no longer appears in Path mode

- **Smart File Input - Favorites Config Inheritance:** Fixed favorites not inheriting configuration when added from the Recent section. When a recent file with saved configuration is added to favorites (by clicking the star icon), the configuration is now properly transferred to the favorite, making the reload icon appear immediately

### ✨ Enhancements

- **Smart File Input - Value Loaded Animation:** Added a subtle highlight animation (300ms fade) when values are populated into Smart File Input fields. This provides visual feedback when:
  - Loading content from a file (Content mode)
  - Inserting a file path (Path mode)
  - Applying changes from the Preview/Edit Modal

## [1.3.0] - 2025-12-21

### ✨ New Features

- **Smart File Input:** Enhanced input fields for workflow parameters with intelligent file handling.
  - **Three Input Modes:** Switch between Text (direct input), Path (insert file path), and Content (extract values from files) modes using the mode selector icon
  - **Path Mode:** Browse and insert file paths from your workspace
  - **Content Extraction:** Load values from JSON, YAML, CSV, ENV, and text files with multi-select:
    - Extract property names, property values, or specific keys from JSON arrays
    - Support for nested arrays with path selection
    - Configurable delimiters (comma, pipe, newline, space, or custom)
  - **File Favorites:** Save frequently used files with custom nicknames for quick access
  - **Recent Files History:** Automatically tracks recently used files per input field
  - **Preview/Edit Modal:** View and edit multi-value inputs in a list format with:
    - Add, remove, and reorder items
    - Value favorites for frequently used values
    - Reload from file with saved configuration
  - **Open in Editor:** Quick action to open any file path in VS Code editor
  - **Discoverability Improvements:** Mode selector button now features a hover chevron indicator and first-time pulse animation to help users discover the feature

### 🔧 Technical Improvements

- Added typed message interfaces for Smart File Input communication
- Extracted constants for display limits and priority keys to improve maintainability
- New `SmartFileInputManager` utility class for managing file favorites and recent files

## [1.2.1] - 2025-12-18

### 🎨 Changed

- **GitHub Summary Button Improvements:**
  - Added GitHub icon (octicon) to the "Summary" button in both the job view and steps view
  - Updated tooltip text from "View job summary" to "View GitHub job summary" for clearer branding

- **Steps View Summary Behavior:** The "Summary" button in the Job Steps Modal now opens the summary in a new editor tab instead of displaying it in a modal dialog, providing a better reading experience for longer summaries. The job view Summary button behavior remains unchanged and still shows a modal for quick previews.

## [1.2.0] - 2025-12-17

### ✨ New Features

- **GitHub Summary Integration:** View workflow run summaries directly in VS Code.
  - New "View GitHub Summary" button in the Run Summary section
  - Parses and displays `$GITHUB_STEP_SUMMARY` content from job logs in a modal
  - Option to open summary in a new editor tab or view on GitHub

- **Syntax Highlighting for Logs:** GitHub Actions logs now have proper syntax highlighting.
  - New TextMate grammar for `github-actions-log` language
  - Highlights group markers, timestamps, error/warning messages, and more

### 🎨 Changed

- **Presets UI Redesign:** Presets have been moved from Advanced Configuration to a dedicated section.
  - New **"Presets"** labeled button in the workflow actions toolbar (next to Reload and Open File)
  - **Enhanced button design** with text label, bookmark icon, and chevron indicator (▼/▶) showing expand/collapse state
  - **Visual prominence** — the Presets button is now visually distinct from icon-only buttons
  - **Chevron rotation** — chevron points right (▶) when collapsed, down (▼) when expanded
  - **Active state highlighting** — button uses primary color when the presets panel is open
  - Expandable presets panel with all preset management options
  - New **ℹ️ help icon** in the presets section header with comprehensive documentation modal

- **Step Duration Display:** Improved step duration formatting in Job Steps Modal.
  - Shows `<1s` for completed steps that executed in under a second
  - Fixed step numbering to use sequential display index (1, 2, 3...) instead of internal step numbers

### 🐛 Fixed

- **Job Logs Error Handling:** Improved error feedback when job logs cannot be loaded.
  - Extension now properly sends error responses back to the webview
  - Better user feedback when repository information cannot be retrieved

### 📖 Documentation

- **Updated README:** Revised preset instructions to reflect the new labeled button design with chevron indicator.
- **New Presets Help Modal:** Added comprehensive help documentation for the presets feature, including:
  - Step-by-step instructions for saving, loading, and managing presets
  - Guide for sharing presets with team members via export/import
  - Best practices and tips for organizing presets

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
