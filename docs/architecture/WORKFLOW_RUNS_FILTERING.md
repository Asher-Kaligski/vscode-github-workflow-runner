# Workflow Runs Fetching and Filtering System

## Overview

The Workflow Runs panel in the VS Code GitHub Workflow Runner extension implements a sophisticated two-tier filtering system that combines **backend (API-level) filtering** with **client-side filtering** to efficiently handle large volumes of workflow runs while providing powerful filtering capabilities.

### Key Features

- **Progressive Fetching**: Automatically fetches up to 1000 runs across multiple pages when date filters are active
- **Hybrid Filtering**: Date range filtering at the API level, all other filters applied client-side
- **Smart Caching**: Workflow-specific caching with automatic invalidation
- **Configurable Pagination**: User-selectable page sizes (20/50/100 runs per page)
- **Watched Runs**: Track up to 20 important runs per repository
- **Filter Persistence**: Maintains filter state across sessions with smart reset logic

## Architecture Components

### 1. Backend (`src/providers/workflow-runs-panel.ts`)

The backend provider manages:

- Communication between VS Code extension and webview
- Orchestration of GitHub API calls
- Filter state persistence via Storage API
- Initial settings management

**Key Methods:**

- `_sendWorkflowRuns()`: Main entry point for fetching runs
- `_fetchRunsSinceDate()`: Progressive fetching with date range filters
- `_sendInitialSettings()`: Loads persisted settings (with date filter clearing)

### 2. GitHub API Layer (`src/api/workflow-monitor.ts`)

Handles direct communication with GitHub Actions API:

- `getWorkflowRuns()`: Fetches runs with optional date range filtering
- Supports `created` parameter for server-side date filtering
- Returns runs with `totalCount` and optional `truncated` flag

**API Parameters:**

```typescript
{
  workflowId?: number;
  branch?: string;        // Not sent to API (unreliable)
  actor?: string;         // Not sent to API (unreliable)
  status?: string;        // Not sent to API (unreliable)
  perPage?: number;       // Max 100
  page?: number;
  createdFrom?: Date;     // Sent as created=FROM..TO
  createdTo?: Date;
}
```

### 3. Webview (`webview/WorkflowRuns.svelte`)

The Svelte-based UI component that:

- Displays workflow runs with rich filtering UI
- Applies client-side filters to fetched runs
- Manages pagination and user interactions
- Handles watched runs feature

**Key Functions:**

- `applyFiltersToRuns()`: Applies the 7-step filter chain
- `filterRuns()`: Main filtering orchestrator
- `handleDateFilterFromChange()` / `handleDateFilterToChange()`: Triggers backend refetch

### 4. Storage Layer (`src/utils/storage.ts`)

Persists state across sessions:

- Workflow runs panel settings (page size, date filters)
- Watched runs per repository (max 20)
- Filter states

**Storage Keys:**

- `WORKFLOW_RUNS_PANEL_SETTINGS_KEY`: Panel configuration
- `WATCHED_RUNS_KEY`: Map of repo → watched run IDs

## Fetching Strategy

### Initial Load Behavior

When the Workflow Runs panel opens:

1. **Load Persisted Settings** from Storage
2. **CRITICAL**: Clear date filters for initial load
   - Prevents empty results if persisted date range has no runs
   - Date filter values are sent to UI but not applied to API call
3. **Fetch Runs** without date filter (most recent runs)

**Code Reference:**

```typescript
// src/providers/workflow-runs-panel.ts:792-805
this._currentDateFilterFrom = null;
this._currentDateFilterTo = null;
console.log(
  '[WorkflowRunsPanel] _sendInitialSettings: Cleared date filters for initial load.',
  'Persisted values (sent to webview but not applied):',
  { dateFilterFrom, dateFilterTo }
);
```

### Standard Fetch (No Date Filter)

When no date filter is active:

- Single API call: `GET /repos/{owner}/{repo}/actions/runs?per_page=100&page=1`
- Returns most recent runs (up to 100)
- Fast and efficient for typical use cases

### Progressive Fetch (Date Filter Active)

When date range filter is set:

1. **Server-Side Filtering**: Pass `created=FROM..TO` to GitHub API
2. **Progressive Pagination**: Fetch pages 1-10 sequentially
3. **Stop Conditions**:
   - Runs older than `fromDate` (reached lower bound)
   - Page returned fewer runs than requested (no more data)
   - Reached page 10 (max pages limit)
   - Collected 1000 runs (max runs limit)

**Code Reference:**

```typescript
// src/providers/workflow-runs-panel.ts:1233-1426
private async _fetchRunsSinceDate(params: {
  owner: string;
  repo: string;
  workflowId?: number;
  pageSize: number;
  fromDate?: Date | null;
  toDate?: Date | null;
}): Promise<{
  runs: WorkflowRun[];
  totalCount: number;
  truncated: boolean;
} | null>
```

### Why Date Filters Are Cleared on Initial Load

**Problem**: Persisted date filters from previous sessions can result in zero runs if:

- The date range is in the past with no matching runs
- The workflow hasn't run during that period
- User forgot they had a date filter active

**Solution**: Always start with no date filter, showing the most recent runs. Users can explicitly apply date filters if needed.

### The 1000-Run Limit

**Rationale:**

- Prevents excessive API calls (10 pages × 100 runs = 1000 max)
- Balances completeness with performance
- GitHub API rate limits (5000 requests/hour)

**Behavior When Exceeded:**

- `truncated: true` flag is set
- Webview displays warning message (unless "Watched Runs Only" filter is active)
- User is prompted to narrow the date range

**Note:** The warning message is suppressed when "Watched Runs Only" filter is active because watched runs are tracked by specific run IDs (max 20 per repository), making the 1000-run fetch limit irrelevant in that context.

**Code Reference:**

```typescript
// src/providers/workflow-runs-panel.ts:1258
const MAX_DATE_WINDOW_RUNS = 1000;
```

## Filtering Strategy

### Two-Tier Filtering Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (API-LEVEL)                      │
│  Date Range Filtering: created=FROM..TO                    │
│  • Handles high-volume workflows (1000+ runs/day)          │
│  • Progressive fetch up to 1000 runs                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                  CLIENT-SIDE (WEBVIEW)                      │
│  7-Step Filter Chain:                                       │
│  1. Bot Filter                                              │
│  2. Actor Filter                                            │
│  3. Favorites Filter                                        │
│  4. Workflow Filter                                         │
│  5. Search Filter                                           │
│  6. Status Filter                                           │
│  7. Date Filter (precision)                                 │
└─────────────────────────────────────────────────────────────┘
```

### Backend (API-Level) Filtering

**Date Range Only**: The only filter sent to GitHub API

**Why?**

- GitHub Actions API has known reliability issues with other filters (branch, actor, status)
- These filters often return incomplete or empty results
- Date filtering is reliable and critical for high-volume workflows

**Implementation:**

```typescript
// src/api/workflow-monitor.ts:47-62
if (options.createdFrom || options.createdTo) {
  const fromStr = options.createdFrom ? options.createdFrom.toISOString() : '*';
  const toStr = options.createdTo ? options.createdTo.toISOString() : '*';
  const createdRange = `${fromStr}..${toStr}`;
  params.append('created', createdRange);
}
```

### Client-Side Filtering: The 7-Step Chain

All runs fetched from the API are stored in memory and filtered client-side:

#### Step 1: Bot Filter

```typescript
// webview/WorkflowRuns.svelte:2097-2099
if (!skipBot && !showBotRuns) {
  filtered = filtered.filter((run) => !run.actor.login.endsWith('[bot]'));
}
```

- **Default**: Exclude bot runs
- **When enabled**: Show runs triggered by bot accounts (e.g., `dependabot[bot]`)

#### Step 2: Actor Filter

```typescript
// webview/WorkflowRuns.svelte:2102-2110
if (actorFilter === 'me' && currentUsername) {
  filtered = filtered.filter((run) => run.actor.login === currentUsername);
} else if (actorFilter !== 'all' && actorFilter !== 'me') {
  filtered = filtered.filter((run) => run.actor.login === actorFilter);
}
```

- **Options**: `all`, `me`, or specific username
- **Default**: `me` (current user's runs only)

#### Step 3: Favorites Filter

```typescript
// webview/WorkflowRuns.svelte:2113-2119
if (!skipFavoritesOnly && showFavoritesOnly && markedWorkflows.length > 0) {
  filtered = filtered.filter((run) => {
    const workflowPath = run.path.split('@')[0];
    return markedWorkflows.includes(workflowPath);
  });
}
```

- **When enabled**: Show only runs from workflows marked as favorites
- **Storage**: Persisted in `MARKED_WORKFLOWS_KEY`

#### Step 4: Workflow Filter

```typescript
// webview/WorkflowRuns.svelte:2122-2128
if (!skipWorkflow && workflowFilter !== 'all') {
  filtered = filtered.filter((run) => {
    const workflowPath = run.path.split('@')[0];
    return workflowPath === workflowFilter;
  });
}
```

- **Options**: `all` or specific workflow path
- **Use case**: Focus on a single workflow's runs

#### Step 5: Search Filter

```typescript
// webview/WorkflowRuns.svelte:2131-2140
if (!skipSearch && searchQuery.trim()) {
  const query = searchQuery.toLowerCase();
  filtered = filtered.filter(
    (run) =>
      run.name.toLowerCase().includes(query) ||
      run.display_title?.toLowerCase().includes(query) ||
      run.head_branch.toLowerCase().includes(query) ||
      run.actor.login.toLowerCase().includes(query)
  );
}
```

- **Searches**: Workflow name, display title, branch name, actor username
- **Case-insensitive**

#### Step 6: Status Filter

```typescript
// webview/WorkflowRuns.svelte:2142-2167
if (!skipStatus && statusFilter !== 'all') {
  filtered = filtered.filter((run) => {
    if (statusFilter === 'success') {
      return run.conclusion === 'success';
    } else if (statusFilter === 'failed') {
      return run.conclusion === 'failure';
    } else if (statusFilter === 'in_progress') {
      return run.status === 'in_progress' || run.status === 'queued';
    } else if (statusFilter === 'queued') {
      return run.status === 'queued';
    } else if (statusFilter === 'cancelled') {
      return run.conclusion === 'cancelled';
    }
    return true;
  });
}
```

- **Options**: `all`, `success`, `failed`, `in_progress`, `queued`, `cancelled`

#### Step 7: Date Filter (Client-Side Precision)

```typescript
// webview/WorkflowRuns.svelte:2169-2195
if (!skipDate && (dateFilterFrom || dateFilterTo)) {
  const fromDate = dateFilterFrom ? new Date(dateFilterFrom) : null;
  const toDate = dateFilterTo ? new Date(dateFilterTo) : null;

  filtered = filtered.filter((run) => {
    const timestamp = run.run_started_at ?? run.created_at;
    const runDate = new Date(timestamp);

    if (fromDate && runDate < fromDate) {
      return false;
    }
    if (toDate && runDate > toDate) {
      return false;
    }
    return true;
  });
}
```

- **Purpose**: Additional precision beyond API-level filtering
- **Handles edge cases**: Where GitHub API may return incomplete results

### Special Case: "Watched Runs Only" Filter

**Overrides ALL other filters:**

```typescript
// webview/WorkflowRuns.svelte:2083-2094
if (showWatchedOnly && !skipWatchedOnly && watchedRuns.size > 0) {
  const watchedFiltered = runs.filter((run) => watchedRuns.has(run.id));
  console.log(
    '[WorkflowRuns] Watched-only mode: showing',
    watchedFiltered.length,
    'watched runs out of',
    runs.length,
    'total runs. Watched IDs:',
    Array.from(watchedRuns)
  );
  return watchedFiltered;
}
```

**Behavior:**

- When enabled, ONLY watched runs are shown
- All other filters (status, actor, workflow, search, etc.) are ignored
- Useful for tracking specific important runs

## Pagination

### Configurable Per-Page Limits

Users can select page size from the settings:

- **20 runs per page** (default)
- **50 runs per page**
- **100 runs per page**

**Storage:**

```typescript
// src/utils/storage.ts:21-26
type WorkflowRunsPanelSettings = {
  workflowLoadLimit?: number;
  autoRefreshSeconds?: number;
  dateFilterFrom?: string | null;
  dateFilterTo?: string | null;
};
```

### Pagination Logic

```typescript
// webview/WorkflowRuns.svelte
const totalPages = Math.ceil(filteredRuns.length / workflowLoadLimit);
const start = (currentPage - 1) * workflowLoadLimit;
const end = start + workflowLoadLimit;
const displayedRuns = filteredRuns.slice(start, end);
```

**Key Points:**

- Pagination is applied AFTER all filters
- Page size persists across sessions
- Current page resets when filters change

## Filter Persistence

### Filters That Persist Across Sessions

All filter states are persisted in VS Code's global state:

```typescript
// Persisted filters:
-workflowFilter -
  actorFilter -
  showBotRuns -
  dateFilterFrom -
  dateFilterTo -
  statusFilter -
  searchQuery -
  showWatchedOnly -
  showFavoritesOnly -
  workflowLoadLimit;
```

### Filter Reset Logic

**When filters are reset:**

- After workflow dispatch action
- After "View Last Run" action

**What gets reset (Secondary Filters):**

```typescript
// webview/WorkflowRuns.svelte:1752-1759
searchQuery = '';
statusFilter = 'all';
showWatchedOnly = false;
showFavoritesOnly = false;

if (dateFilterFrom || dateFilterTo) {
  clearDateFilter();
}
```

**What persists (Primary Filters):**

```typescript
// These are NOT reset:
-workflowFilter - actorFilter - showBotRuns;
```

**Rationale:**

- After dispatching a workflow, users typically want to see that specific workflow's runs
- Secondary filters (search, status, date range) are cleared to show all runs for that workflow
- Primary filters (workflow, actor, bot runs) are kept to maintain context

## Watched Runs Feature

### Overview

Users can "watch" up to 20 workflow runs per repository to track important runs.

### Storage Mechanism

```typescript
// src/utils/storage.ts:31
type WatchedRunsMap = Record<string, number[]>;

// Storage key format: "owner/repo" → [runId1, runId2, ...]
const key = `${owner}/${repo}`;
```

### 20-Run Limit Per Repository

**Enforcement:**

```typescript
// src/utils/storage.ts:518-520
if (watched.length >= MAX_WATCHED_RUNS_PER_REPO) {
  return `You have reached the maximum of ${MAX_WATCHED_RUNS_PER_REPO} watched runs for this repository. Please remove older watched runs to add new ones.`;
}
```

**Why 20?**

- Prevents unbounded growth of stored data
- Encourages users to focus on truly important runs
- Keeps UI manageable

### Integration with Filtering

**Visual Indicator:**

- Watched runs show an eye icon (👁️) in the UI
- Visible regardless of filter state (unless "Watched Runs Only" is active)

**"Watched Runs Only" Filter:**

- When enabled, shows ONLY watched runs
- Overrides all other filters
- Useful for quick access to tracked runs

**Management:**

- Users can view all watched runs in a modal
- Can unwatch individual runs or unwatch all at once
- Watched status persists across sessions

## Diagrams

For visual representations of the architecture, see:

- [Architecture Flowchart](./WORKFLOW_RUNS_ARCHITECTURE_DIAGRAMS.md#architecture-flowchart)
- [Sequence Diagram](./WORKFLOW_RUNS_ARCHITECTURE_DIAGRAMS.md#sequence-diagram)

## Key Files Reference

### Backend

- `src/providers/workflow-runs-panel.ts` - Main panel provider
- `src/api/workflow-monitor.ts` - GitHub API integration
- `src/utils/storage.ts` - Persistence layer

### Frontend

- `webview/WorkflowRuns.svelte` - Main UI component
- `webview/WorkflowRuns.svelte` (lines 2065-2195) - Filter chain implementation

### Configuration

- `src/utils/config.ts` - Extension configuration
- `src/types/workflow-types.ts` - Type definitions

## Best Practices

### For Users

1. **Use Date Filters for Old Runs**: If you need to find runs from weeks/months ago, use date range filters
2. **Narrow Date Ranges**: If you see the "1000 run limit" warning, narrow your date range
3. **Watch Important Runs**: Use the watch feature to track critical runs (max 20 per repo)
4. **Clear Filters**: Use "Clear Filters" button if you're not seeing expected runs

### For Developers

1. **Always Clear Date Filters on Initial Load**: Prevents empty results
2. **Use Progressive Fetching for Date Ranges**: Don't fetch all runs at once
3. **Apply Filters Client-Side**: Except for date ranges (GitHub API unreliability)
4. **Respect the 1000-Run Limit**: Balance completeness with performance
5. **Persist Filter State**: But reset secondary filters after dispatch/view actions

## Troubleshooting

### No Runs Displayed

**Possible causes:**

1. Date filter is active with no matching runs → Clear date filter
2. Too many filters active → Check "Applied Filters" section
3. "Watched Runs Only" is enabled with no watched runs → Disable the filter

### "1000 Run Limit Reached" Warning

**Solution:**

- Narrow the date range to a shorter period
- Use additional filters (workflow, status, actor) to reduce results
- Consider if you really need to see that many runs

### Watched Runs Not Showing

**Possible causes:**

1. Reached 20-run limit → Remove old watched runs
2. Runs are filtered out by other active filters → Check filter state
3. Runs are from a different repository → Watched runs are per-repo

## Future Enhancements

Potential improvements to consider:

1. **Incremental Loading**: Load runs as user scrolls instead of pagination
2. **Advanced Search**: Support for complex queries (e.g., "branch:main AND status:failed")
3. **Custom Date Presets**: Quick filters like "Last 7 days", "Last 30 days"
4. **Export Functionality**: Export filtered runs to CSV/JSON
5. **Run Comparison**: Compare parameters/results between multiple runs
6. **Notification System**: Alert when watched runs complete or fail

## Conclusion

The Workflow Runs fetching and filtering system provides a robust, performant solution for managing large volumes of GitHub Actions workflow runs. By combining backend date filtering with comprehensive client-side filtering, it handles both high-volume workflows and complex filtering requirements while maintaining a responsive user experience.
