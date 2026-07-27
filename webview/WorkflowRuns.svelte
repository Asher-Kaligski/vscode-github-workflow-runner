<script lang="ts">
  /**
   * Workflow runs monitoring component
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade, slide, fly } from 'svelte/transition';
  import type {
    WorkflowRun,
    WorkflowJob,
    CancellationState,
    WorkflowJobDefinition,
    JobGraphNode,
  } from '../src/types/workflow-types';
  import JobDependencyGraph from './components/JobDependencyGraph.svelte';
  import JobStepsModal from './components/JobStepsModal.svelte';
  import JobGraphModal from './components/JobGraphModal.svelte';
  // GitHub summary modal - now uses log-based parsing to extract summary content
  import GitHubSummaryModal from './components/GitHubSummaryModal.svelte';
  import { formatDuration as formatMs } from './utils/graph-utils';
  import { markdownToHtml } from './utils/markdown-utils';

  // Debug: Log immediately when script runs
  console.log('[WorkflowRuns] Script block executing...');

  /**
   * Parse a datetime-local input value (e.g., "2025-11-20T09:58") as local time.
   * The datetime-local input returns a string in local timezone, but new Date()
   * interprets it as UTC if there's no timezone offset. This helper ensures the
   * datetime is parsed in the local timezone.
   */
  function parseDateTimeLocal(datetimeLocal: string): Date | null {
    try {
      // datetime-local format: "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss"
      // We need to parse this as local time, not UTC.
      // The Date constructor with a string argument interprets ISO 8601 strings
      // without a timezone as UTC, which is NOT what we want.
      //
      // Solution: Parse the components and use the Date constructor with
      // individual arguments, which interprets them as local time.
      const match = datetimeLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (!match) {
        return null;
      }

      const [, year, month, day, hour, minute, second] = match;
      const date = new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1, // Month is 0-indexed
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        second ? parseInt(second, 10) : 0
      );

      return date;
    } catch (error) {
      console.error('[WorkflowRuns] Failed to parse datetime-local:', datetimeLocal, error);
      return null;
    }
  }

  const MAX_TOTAL_RUNS_OPTIONS: number[] = [1000, 2000, 3000, 4000, 5000];
  const WORKFLOW_LOAD_LIMIT_OPTIONS: number[] = [10, 20, 30, 40, 50];
  // Full options including 0 (Off) for validation and persistence
  const AUTO_REFRESH_SECONDS_OPTIONS: number[] = [0, 15, 30, 45, 60, 90, 120, 180];
  // Slider options exclude 0 - checkbox controls on/off state
  const AUTO_REFRESH_SLIDER_OPTIONS: number[] = [15, 30, 45, 60, 90, 120, 180];
  const DEFAULT_MAX_TOTAL_RUNS = 2000;
  const DEFAULT_WORKFLOW_LOAD_LIMIT = 20;
  // Default to 30 seconds - provides responsive monitoring without excessive API usage
  // Adaptive refresh handles faster polling when in-progress/queued runs exist
  const DEFAULT_AUTO_REFRESH_SECONDS = 30;

  // Adaptive refresh configuration
  const DEFAULT_ADAPTIVE_REFRESH_ENABLED = true; // Enabled by default
  const DEFAULT_ADAPTIVE_FAST_REFRESH_SECONDS = 10; // Default fast interval
  const MIN_ADAPTIVE_FAST_REFRESH_SECONDS = 5; // Minimum allowed (slider minimum)
  const MAX_ADAPTIVE_FAST_REFRESH_SECONDS = 10; // Maximum allowed (slider maximum)

  // Health issue types for granular cooldown tracking
  type HealthIssueType = 'loading' | 'refreshing' | 'dateFilter' | 'apiResponse' | 'autoRefresh';

  let runs: WorkflowRun[] = [];
  let filteredRuns: WorkflowRun[] = [];
  let visibleRuns: WorkflowRun[] = [];
  let loading = true;
  let refreshInterval: number | null = null;
  let highlightedRunId: number | null = null;
  let autoRefreshSeconds = DEFAULT_AUTO_REFRESH_SECONDS;
  let previousAutoRefreshSeconds = DEFAULT_AUTO_REFRESH_SECONDS; // Store previous value for toggle
  let autoRefreshPaused = false; // Pause auto-refresh when opening external resources
  let adaptiveRefreshActive = false; // True when using faster polling due to active runs
  let adaptiveRefreshEnabled = DEFAULT_ADAPTIVE_REFRESH_ENABLED; // User preference for adaptive refresh
  let adaptiveFastRefreshSeconds = DEFAULT_ADAPTIVE_FAST_REFRESH_SECONDS; // User-configurable fast interval (5-10s)

  // Debounce timer for adaptive refresh recalculation to prevent timer thrashing
  let adaptiveRefreshDebounceId: number | null = null;
  const ADAPTIVE_REFRESH_DEBOUNCE_MS = 500;

  // Protection against concurrent background refresh calls
  let isBackgroundRefreshInProgress = false;

  // Track status changes for background updates
  // Map<runId, { oldStatus: string, newStatus: string, timestamp: number }>
  let statusChanges: Map<number, { oldStatus: string; newStatus: string; timestamp: number }> =
    new Map();

  let searchQuery = '';
  let statusFilter = 'all';
  let refreshing = false;
  let showRefreshSettings = false;
  let settingsActiveTab: 'general' | 'notifications' | 'ratelimit' = 'general'; // Active tab in settings dropdown
  let totalCount = 0; // Total number of runs available (server-side count)
  let currentPage = 1; // Current client-side page over filteredRuns
  let loadingMore = false; // Loading more runs from the backend via an explicit user action
  let workflowLoadLimit = DEFAULT_WORKFLOW_LOAD_LIMIT; // Number of runs to show per page in the UI (default: 20)
  let dateFilterFrom = ''; // Date/time filter: show runs from this point onwards (empty = no filter)
  let dateFilterTo = ''; // Date/time filter: show runs up to this point (empty = no upper bound)

  // Notification settings
  let showWorkflowToastNotifications = true; // Show toast notifications for workflow run events (start, complete, fail)
  let showProgressIndicators = true; // Show inline job progress for running workflows

  let fetchingDateFilteredRuns = false; // True while backend is fetching runs for an active date filter
  let dateFilterTruncated = false; // True when the backend truncated date-filtered results due to pagination limits
  // Backend pagination state: which GitHub API page to request next when loading
  // additional runs. This is intentionally decoupled from the client-side
  // currentPage used for paginating over filteredRuns.
  let nextBackendPage: number | null = null;
  // When progressive fetching is paused due to hitting the max limit, store the
  // page number here so we can resume if the user increases the limit.
  let pausedBackendPage: number | null = null;
  let smartSuggestions: string[] = [];
  let progressiveFetching = false; // True while progressive fetching is in progress
  let showFetchingIndicator = false; // Delayed visibility for background fetch indicator (prevents flashing)
  let fetchingIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
  let totalRunsFetched = 0; // Total number of runs fetched so far (for progressive loading limits)
  let DATE_FILTER_MAX_TOTAL_RUNS = DEFAULT_MAX_TOTAL_RUNS; // Max runs to fetch when a date filter is active
  let NON_DATE_MAX_TOTAL_RUNS = DEFAULT_MAX_TOTAL_RUNS; // Max runs to fetch when no date filter is active

  // Track slider positions for the configurable limits so the UI can render
  // tick marks and current values.
  let nonDateMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(NON_DATE_MAX_TOTAL_RUNS);
  let dateFilterMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(DATE_FILTER_MAX_TOTAL_RUNS);
  let workflowLoadLimitIndex = getWorkflowLoadLimitIndex(workflowLoadLimit);
  let autoRefreshIndex = getAutoRefreshOptionIndex(autoRefreshSeconds);

  // Track initial filter messages to avoid double-loading perception
  let waitingForInitialFilters = false; // True when we're waiting for initial filter messages after getWorkflowRuns
  let initialFilterTimeout: number | null = null; // Timeout to finalize initial load if filter messages don't arrive

  // Track when we're manually switching workflows (user interaction, not initial load)
  // This bypasses the 500ms filter message wait since no filter messages are expected
  let isManualWorkflowFetch = false;
  // Track the expected workflowId for the pending manual workflow fetch
  // This is used to ignore stale responses from webviewReady/other sources
  // Values: null (not tracking), 'pending' (waiting for workflow ID), 'all' (all workflows), or number (specific workflow)
  let pendingWorkflowId: number | null | 'all' | 'pending' = null;

  // Timeout ID for scheduled progressive fetch - allows cancellation when switching workflows
  let progressiveFetchTimeoutId: number | null = null;
  // Debounce timeout ID for workflow switches to prevent rapid-fire requests
  let workflowSwitchDebounceId: number | null = null;
  // Counter to track workflow switch generation - used to ignore stale progressive fetch callbacks
  let workflowSwitchGeneration = 0;

  // Watchdog timeout for workflow fetch operations - prevents UI freeze if response never arrives
  let workflowFetchWatchdogId: number | null = null;
  // Timestamp when loading state was set to true - used for stuck state detection
  let loadingStartTime: number | null = null;
  // Maximum time (ms) to wait for a workflow fetch response before triggering recovery
  const WORKFLOW_FETCH_TIMEOUT_MS = 30000; // 30 seconds
  // Threshold (ms) for detecting stuck loading state in message handler
  const STUCK_LOADING_THRESHOLD_MS = 30000; // 30 seconds

  // Throttle state for filterRuns to prevent excessive recomputation during rapid refreshes
  let filterRunsThrottleId: number | null = null;
  let filterRunsPending = false;
  const FILTER_RUNS_THROTTLE_MS = 100; // Minimum interval between filterRuns calls

  // Flag to track if a filter operation is currently in progress
  // This prevents concurrent filter modifications that can corrupt Svelte's internal state
  let filterOperationInProgress = false;

  // Render key to force complete DOM re-creation when arrays change.
  // This prevents Svelte's internal linked-list corruption during rapid updates.
  // Incrementing this key forces {#key} blocks to fully re-render.
  let visibleRunsRenderKey = 0;

  // GitHub API Rate Limit Tracking
  // GitHub allows 5,000 requests/hour for authenticated users
  const GITHUB_RATE_LIMIT_MAX = 5000;
  const RATE_LIMIT_WARNING_50_THRESHOLD = 0.5; // Show first warning at 50% usage
  const RATE_LIMIT_WARNING_75_THRESHOLD = 0.75; // Show urgent warning at 75% usage
  // Configurable auto-throttling threshold options (percentage of limit used)
  const RATE_LIMIT_THRESHOLD_OPTIONS = [50, 60, 70, 80, 90];
  const DEFAULT_RATE_LIMIT_THRESHOLD = 70; // Default threshold at 70% usage
  let rateLimitRemaining: number | null = null;
  let rateLimitLimit: number | null = null;
  let rateLimitResetTime: Date | null = null;
  let rateLimitWarning50Shown = false; // Track if 50% warning was shown
  let rateLimitWarning75Shown = false; // Track if 75% warning was shown
  let rateLimitProtectionEnabled = true; // User preference for automatic throttling
  let rateLimitThreshold = DEFAULT_RATE_LIMIT_THRESHOLD; // User-configurable threshold (50-90%)
  let rateLimitProtectionActive = false; // True when rate limit protection is engaged
  let rateLimitBackoffMultiplier = 1; // Exponential backoff multiplier (1x, 2x, 4x, etc.)

  // Panel Health Monitoring System
  // Detects unresponsive/stuck states and provides recovery options
  const HEALTH_CHECK_INTERVAL_MS = 20000; // Check panel health every 20 seconds
  const LOADING_TIMEOUT_MS = 60000; // Loading state timeout (60 seconds)
  const REFRESHING_TIMEOUT_MS = 45000; // Refreshing state timeout (45 seconds)
  const DATE_FILTER_TIMEOUT_MS = 90000; // Date filter fetch timeout (90 seconds)
  const API_RESPONSE_TIMEOUT_MS = 300000; // No API response timeout (5 minutes)
  const HEALTH_NOTIFICATION_COOLDOWN_MS = 120000; // Minimum time between health notifications (2 minutes)
  const USER_ACTIVITY_GRACE_PERIOD_MS = 180000; // Don't show modal if user was active in last 3 minutes
  const USER_ACTION_COOLDOWN_MS = 600000; // Extended cooldown after user takes action from modal (10 minutes)

  let healthCheckInterval: number | null = null; // Timer for health check loop
  // Note: loadingStartTime is declared above in watchdog section, reused for health monitoring
  let refreshingStartTime: number | null = null; // Timestamp when refreshing started
  let dateFilterStartTime: number | null = null; // Timestamp when date filter fetch started
  let lastSuccessfulApiResponse: number = Date.now(); // Timestamp of last successful API response
  // Granular health notification cooldowns - track separately per issue type
  // This allows different health issues to be reported independently
  let healthNotificationCooldowns: Record<HealthIssueType, number> = {
    loading: 0,
    refreshing: 0,
    dateFilter: 0,
    apiResponse: 0,
    autoRefresh: 0,
  };
  let healthNotificationDismissed = false; // Whether user dismissed the current health notification
  let panelUnresponsive = false; // Whether panel is currently detected as unresponsive
  let unresponsiveReason: string | null = null; // Reason for unresponsiveness detection
  let currentHealthIssueType: HealthIssueType | null = null; // Current issue type being shown
  let lastAutoRefreshTime: number | null = null; // Timestamp of last auto-refresh execution
  let expectedNextAutoRefresh: number | null = null; // Expected time of next auto-refresh
  let lastUserActivity: number = Date.now(); // Timestamp of last user interaction with the panel
  let lastUserActionFromModal: number = 0; // Timestamp of last recovery action taken from health modal

  // Request generation tracking for cancelling stale requests
  // This is separate from workflowSwitchGeneration to handle filter changes
  let filterChangeGeneration = 0;

  // Default to "All Users" so the initial render matches the common entry points
  // (View Workflow Runs / View Last Run / Dispatch / Rerun) which all request
  // actorFilter: 'all' from the backend. This avoids a visible flicker from
  // "My Runs" to "All Users" while initial filter messages are in flight.
  let actorFilter = 'all'; // 'all', 'me', or specific username
  let workflowFilter: string | 'all' = 'all'; // 'all' or specific workflow filename
  let previousWorkflowFilter: string | 'all' = workflowFilter;
  let previousActorFilter = actorFilter;
  let previousStatusFilter = statusFilter;
  let showBotRuns = false; // Toggle to show/hide bot runs - coupled with actorFilter
  let currentUsername = ''; // Current GitHub username
  let availableWorkflows: Array<{
    path: string;
    name: string;
    filename: string;
  }> = []; // Unique workflow paths with names from workflow definitions
  let workflowPathToName: Map<string, string> = new Map(); // workflow path -> workflow name map
  let userInfo: { login: string; name?: string } | null = null; // User info for welcome header
  let allWorkflowDefinitions: Array<{
    name: string;
    filename: string;
    filepath: string;
  }> = []; // All workflow definitions from backend
  let repository: { owner: string; name: string } | null = null; // Repository info for building GitHub URLs
  let markedWorkflows: string[] = []; // List of marked/pinned workflow paths (for dropdown filter)
  let watchedRuns: Set<number> = new Set(); // Set of watched workflow run IDs
  let showWatchedOnly = false; // Toggle to show only watched workflow runs
  let showFavoritesOnly = false; // Toggle to show only runs from favorite workflows
  let previousShowWatchedOnly = showWatchedOnly;
  let previousShowFavoritesOnly = showFavoritesOnly;
  let workflowSearchQuery = ''; // Search query for workflow filter dropdown
  let isWorkflowSearchActive = false; // Whether the current workflowSearchQuery should be treated as an active search filter
  let workflowDropdownOpen = false; // Whether workflow filter dropdown is open
  let filtersExpanded = true; // Whether the "Applied Filters" section is expanded (default: expanded)
  let userManuallyToggledFilters = false; // Whether user manually toggled filters (prevents auto-collapse override)
  let isScrolled = false; // Whether user has scrolled down (for auto-collapse and sticky shadow)
  let showWatchedRunsModal = false; // Whether the watched runs management modal is open
  const MAX_WATCHED_RUNS_PER_REPO = 20; // Maximum watched runs per repository
  let rerunLoadingRunIds: Set<number> = new Set(); // Track which runs have rerun buttons in loading state
  let filteredAvailableWorkflows: Array<{
    path: string;
    name: string;
    filename: string;
  }> = []; // Filtered workflows for dropdown

  // Toasts
  type ToastType = 'success' | 'error' | 'info' | 'warning';
  type Toast = {
    id: number;
    message: string;
    type: ToastType;
    duration: number;
  };
  let toasts: Toast[] = [];
  let toastIdCounter = 1;
  let reduceMotion = false;

  // Wave animation state
  const WAVE_ANIMATION_MIN_INTERVAL_MS = 60_000;
  const WORKFLOW_RUNS_WAVE_STORAGE_KEY = 'githubWorkflowRunner:workflowRunsWaveLastTime';
  let showWelcomeWave = false;
  let showGitHubIcon = false; // Track transition to GitHub icon

  function showToast(message: string, type: ToastType = 'info', duration = 4000) {
    const id = toastIdCounter++;
    toasts = [...toasts, { id, message, type, duration }];
    const ms = Math.min(Math.max(duration, 2000), 8000);
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, ms);
  }

  /**
   * Clear all toasts immediately.
   * Called when switching workflows to prevent stale notifications from showing.
   */
  function clearAllToasts() {
    toasts = [];
  }

  /**
   * Cancel all pending operations when switching workflows.
   * This prevents race conditions and resource exhaustion from rapid workflow switches.
   */
  function cancelPendingOperations() {
    // Cancel pending progressive fetch timeout
    if (progressiveFetchTimeoutId !== null) {
      window.clearTimeout(progressiveFetchTimeoutId);
      progressiveFetchTimeoutId = null;
    }

    // Cancel pending workflow switch debounce
    // When we cancel a pending workflow switch, we must also reset the associated state
    // (isManualWorkflowFetch, pendingWorkflowId) because the debounced callback that would
    // have set pendingWorkflowId properly is being cancelled. Without this reset, subsequent
    // getWorkflowRuns responses may be incorrectly filtered out or the UI may become stuck.
    if (workflowSwitchDebounceId !== null) {
      window.clearTimeout(workflowSwitchDebounceId);
      workflowSwitchDebounceId = null;
      // Reset the manual workflow fetch state since the pending operation was cancelled
      isManualWorkflowFetch = false;
      pendingWorkflowId = null;
    }

    // Cancel pending initial filter timeout and reset waiting state
    // This is critical: if we're switching workflows while waitingForInitialFilters is true,
    // we must reset it to prevent finalizeInitialLoad() from being called prematurely
    if (initialFilterTimeout !== null) {
      window.clearTimeout(initialFilterTimeout);
      initialFilterTimeout = null;
    }
    waitingForInitialFilters = false;

    // Reset progressive fetching state
    progressiveFetching = false;

    // Increment generation to invalidate any in-flight progressive fetch callbacks
    workflowSwitchGeneration++;

    // Increment filter change generation to invalidate stale filter-triggered requests
    filterChangeGeneration++;

    // Cancel workflow fetch watchdog
    if (workflowFetchWatchdogId !== null) {
      window.clearTimeout(workflowFetchWatchdogId);
      workflowFetchWatchdogId = null;
    }

    // Cancel pending filterRuns throttle
    if (filterRunsThrottleId !== null) {
      window.clearTimeout(filterRunsThrottleId);
      filterRunsThrottleId = null;
      filterRunsPending = false;
    }

    // Notify backend to cancel any pending requests
    vscode.postMessage({
      type: 'cancelPendingRequests',
      data: {
        workflowGeneration: workflowSwitchGeneration,
        filterGeneration: filterChangeGeneration,
      },
    });
  }

  /**
   * Cancel pending requests on rapid filter changes.
   * This is called when filters change to invalidate stale requests.
   */
  function cancelPendingFilterRequests() {
    // Increment filter generation to mark all pending filter requests as stale
    filterChangeGeneration++;

    console.log(
      '[WorkflowRuns] Filter changed - incrementing filterChangeGeneration to',
      filterChangeGeneration
    );
  }

  /**
   * Clear per-run state data (jobs, artifacts, dependencies, etc.) to free memory.
   * Called when switching workflows to prevent unbounded memory growth from
   * accumulated per-run data across different workflow views.
   */
  function clearPerRunState() {
    // Clear expansion state
    expandedRuns.clear();
    expandedRuns = expandedRuns;

    // Clear job data
    runJobs.clear();
    runJobs = runJobs;
    loadingJobs.clear();
    loadingJobs = loadingJobs;

    // Clear job dependency graph state
    runJobDefinitions.clear();
    runJobDefinitions = runJobDefinitions;
    loadingJobDependencies.clear();
    loadingJobDependencies = loadingJobDependencies;
    showDependencyGraph.clear();
    showDependencyGraph = showDependencyGraph;

    // Clear artifacts state
    runArtifacts.clear();
    runArtifacts = runArtifacts;
    loadingArtifacts.clear();
    loadingArtifacts = loadingArtifacts;
    showArtifacts.clear();
    showArtifacts = showArtifacts;

    // Clear summary state
    showSummary.clear();
    showSummary = showSummary;

    console.log('[WorkflowRuns] Cleared per-run state data');
  }

  /**
   * Start the workflow fetch watchdog timer.
   * This timer will trigger recovery if no valid response arrives within the timeout period.
   * Prevents UI freeze when responses are lost or never arrive.
   */
  function startWorkflowFetchWatchdog() {
    // Clear any existing watchdog
    if (workflowFetchWatchdogId !== null) {
      window.clearTimeout(workflowFetchWatchdogId);
    }

    // Record when loading started
    loadingStartTime = Date.now();

    // Start the watchdog timer
    workflowFetchWatchdogId = window.setTimeout(() => {
      workflowFetchWatchdogId = null;

      // Check if we're still in a loading state that should have completed
      if (loading && isManualWorkflowFetch) {
        console.warn(
          '[WorkflowRuns] WATCHDOG: Workflow fetch timeout after',
          WORKFLOW_FETCH_TIMEOUT_MS,
          'ms - triggering recovery'
        );
        console.warn('[WorkflowRuns] WATCHDOG: State at timeout:', {
          loading,
          isManualWorkflowFetch,
          pendingWorkflowId,
          refreshing,
          workflowFilter,
        });

        // Trigger recovery
        resetLoadingState('Workflow fetch timed out. Please try again.');
      }
    }, WORKFLOW_FETCH_TIMEOUT_MS);
  }

  /**
   * Clear the workflow fetch watchdog timer.
   * Called when a valid response is received or loading completes normally.
   */
  function clearWorkflowFetchWatchdog() {
    if (workflowFetchWatchdogId !== null) {
      window.clearTimeout(workflowFetchWatchdogId);
      workflowFetchWatchdogId = null;
    }
    loadingStartTime = null;
  }

  /**
   * Reset all loading-related state to recover from a stuck UI.
   * This is a defensive recovery mechanism that clears all flags that could block UI interaction.
   * @param errorMessage Optional error message to show to the user
   */
  function resetLoadingState(errorMessage?: string) {
    console.warn('[WorkflowRuns] resetLoadingState called - recovering from stuck state');
    console.warn('[WorkflowRuns] State before reset:', {
      loading,
      refreshing,
      loadingMore,
      isManualWorkflowFetch,
      pendingWorkflowId,
      waitingForInitialFilters,
      progressiveFetching,
      fetchingDateFilteredRuns,
    });

    // Clear all loading flags
    loading = false;
    refreshing = false;
    loadingMore = false;
    isManualWorkflowFetch = false;
    pendingWorkflowId = null;
    waitingForInitialFilters = false;
    progressiveFetching = false;
    fetchingDateFilteredRuns = false;

    // Clear all pending timeouts
    if (workflowFetchWatchdogId !== null) {
      window.clearTimeout(workflowFetchWatchdogId);
      workflowFetchWatchdogId = null;
    }
    if (initialFilterTimeout !== null) {
      window.clearTimeout(initialFilterTimeout);
      initialFilterTimeout = null;
    }
    if (progressiveFetchTimeoutId !== null) {
      window.clearTimeout(progressiveFetchTimeoutId);
      progressiveFetchTimeoutId = null;
    }
    if (workflowSwitchDebounceId !== null) {
      window.clearTimeout(workflowSwitchDebounceId);
      workflowSwitchDebounceId = null;
    }

    loadingStartTime = null;

    // Resume auto-refresh after recovery from stuck state
    autoRefreshPaused = false;
    startAutoRefresh();

    // Show error toast if message provided
    if (errorMessage) {
      showToast(errorMessage, 'error');
    }

    // Re-apply filters to ensure UI is in a consistent state
    if (runs.length > 0) {
      filterRuns();
    }

    console.warn('[WorkflowRuns] State after reset:', {
      loading,
      refreshing,
      loadingMore,
      isManualWorkflowFetch,
      pendingWorkflowId,
    });
  }

  /**
   * Check if the UI is in a stuck loading state and trigger recovery if needed.
   * This is called at the start of message handling to detect and recover from stuck states.
   */
  function checkAndRecoverFromStuckState() {
    // Only check if we're in a loading state with a recorded start time
    if (!loading || loadingStartTime === null) {
      return;
    }

    const elapsedMs = Date.now() - loadingStartTime;

    // If we've been loading for too long, trigger recovery
    if (elapsedMs > STUCK_LOADING_THRESHOLD_MS) {
      console.warn(
        '[WorkflowRuns] STUCK STATE DETECTED: Loading for',
        Math.round(elapsedMs / 1000),
        'seconds'
      );
      resetLoadingState('The panel became unresponsive and was automatically recovered.');
    }
  }

  /**
   * Clear all status change indicators.
   * Called when switching workflows to prevent stale inline status messages.
   */
  function clearStatusChanges() {
    statusChanges.clear();
    statusChanges = statusChanges; // Trigger reactivity
  }

  function getToastIcon(t: ToastType): string {
    switch (t) {
      case 'success':
        return 'codicon-pass';
      case 'error':
        return 'codicon-error';
      case 'warning':
        return 'codicon-warning';
      default:
        return 'codicon-info';
    }
  }

  /**
   * Decide whether the workflow runs panel welcome wave animation should run.
   */
  function shouldPlayWorkflowRunsWave(): boolean {
    try {
      const last = window.sessionStorage.getItem(WORKFLOW_RUNS_WAVE_STORAGE_KEY);
      const now = Date.now();

      if (last) {
        const lastTime = Number(last);
        if (!Number.isNaN(lastTime) && now - lastTime < WAVE_ANIMATION_MIN_INTERVAL_MS) {
          return false;
        }
      }

      window.sessionStorage.setItem(WORKFLOW_RUNS_WAVE_STORAGE_KEY, String(now));
      return true;
    } catch {
      // If storage is unavailable, fall back to animating once per mount.
      return true;
    }
  }

  /**
   * Trigger the welcome wave animation once, with a small reset to
   * ensure the CSS animation reliably plays.
   * After the wave completes, wait 3-5 seconds and transition to GitHub icon.
   */
  async function playWorkflowRunsWaveOnce() {
    // Reset the class so toggling re-triggers the animation.
    showWelcomeWave = false;
    showGitHubIcon = false;
    await tick();
    showWelcomeWave = true;

    // Remove the class after the animation finishes so it can be
    // re-applied in a future session if allowed by rate limiting.
    window.setTimeout(() => {
      showWelcomeWave = false;
    }, 2000);

    // After wave animation completes, wait 3-5 seconds then transition to GitHub icon
    // Wave animation is 2s, so total delay is 2s + 4s = 6s
    window.setTimeout(() => {
      showGitHubIcon = true;
    }, 6000); // 2s wave + 4s delay
  }

  function triggerWorkflowRunsWaveIfAllowed() {
    if (reduceMotion) {
      return;
    }
    if (!shouldPlayWorkflowRunsWave()) {
      return;
    }
    void playWorkflowRunsWaveOnce();
  }

  // Reactive: Count of marked workflows that are actually available
  $: availableMarkedWorkflowsCount = availableWorkflows.filter((w) =>
    markedWorkflows.includes(w.path)
  ).length;

  // Reactive: Rate limit display values for real-time updates
  // These must be reactive to ensure the UI updates when rate limit data changes
  $: rateLimitStatusText =
    rateLimitRemaining !== null && rateLimitLimit !== null
      ? `${rateLimitRemaining.toLocaleString()} / ${rateLimitLimit.toLocaleString()}`
      : 'Unknown';

  $: rateLimitUsagePercent =
    rateLimitRemaining !== null && rateLimitLimit !== null && rateLimitLimit > 0
      ? ((rateLimitLimit - rateLimitRemaining) / rateLimitLimit) * 100
      : 0;

  $: rateLimitColorClass = (() => {
    if (rateLimitUsagePercent >= 90) return 'rate-limit-critical';
    if (rateLimitUsagePercent >= 75) return 'rate-limit-warning';
    if (rateLimitUsagePercent >= 50) return 'rate-limit-caution';
    return 'rate-limit-good';
  })();

  $: rateLimitResetTimeText = rateLimitResetTime
    ? rateLimitResetTime.toLocaleTimeString()
    : 'Unknown';

  $: rateLimitRemainingPercent = Math.round(100 - rateLimitUsagePercent);

  // Reactive: Auto-refresh label for the slider value display.
  // Always shows the user's configured interval to match the slider position.
  // The adaptive refresh status is shown separately in the note below the slider.
  $: autoRefreshLabelText = (() => {
    if (
      typeof autoRefreshSeconds !== 'number' ||
      !Number.isFinite(autoRefreshSeconds) ||
      autoRefreshSeconds <= 0
    ) {
      return 'Off';
    }

    // Format based on user's configured interval (not the effective adaptive interval)
    if (autoRefreshSeconds < 60) {
      return `${autoRefreshSeconds}s`;
    }

    switch (autoRefreshSeconds) {
      case 60:
        return '1m';
      case 90:
        return '1m 30s';
      case 120:
        return '2m';
      case 180:
        return '3m';
      default:
        return `${autoRefreshSeconds}s`;
    }
  })();

  // Reactive: Check if "Increase Interval" button should be disabled (at max)
  $: isAtMaxRefreshInterval = (() => {
    // Get the maximum interval from slider options
    const maxOption = Math.max(...AUTO_REFRESH_SLIDER_OPTIONS);
    // Button is disabled if already at max, or if no valid higher options exist
    const validHigherOptions = AUTO_REFRESH_SLIDER_OPTIONS.filter(
      (opt) => opt >= 60 && opt > autoRefreshSeconds
    );
    return autoRefreshSeconds >= maxOption || validHigherOptions.length === 0;
  })();

  // Reactive: Reset "Favorites Only" filter when no favorites are available
  // This prevents the checkbox from being checked but disabled
  $: if (availableMarkedWorkflowsCount === 0 && showFavoritesOnly) {
    showFavoritesOnly = false;
  }

  // Reactive: Active filter labels for display
  // Explicitly depend on all filter variables AND filteredRuns to ensure updates
  $: activeFilterLabels = getActiveFilterLabels(
    statusFilter,
    actorFilter,
    showBotRuns,
    workflowFilter,
    searchQuery,
    showWatchedOnly,
    showFavoritesOnly,
    dateFilterFrom,
    dateFilterTo,
    filteredRuns,
    runs,
    markedWorkflows,
    watchedRuns
  );

  // Reactive: reset pagination and clear per-run state when the workflow selection changes.
  // This ensures we show the first page for the newly selected workflow and frees memory
  // from expanded runs, loaded jobs, artifacts, etc. from the previous workflow.
  $: {
    if (workflowFilter !== previousWorkflowFilter) {
      currentPage = 1;
      previousWorkflowFilter = workflowFilter;
      // Clear per-run state (expanded runs, jobs, artifacts, etc.) to free memory
      // This prevents unbounded growth as users switch between workflows
      clearPerRunState();
    }
  }

  // Track previous username to detect changes
  let previousCurrentUsername = '';

  // Track previous repository to detect changes
  let previousRepository: { owner: string; name: string } | null = null;

  // Reactive: Clear caches when repository changes.
  // This prevents cross-repository cache conflicts when switching between repositories.
  $: {
    if (repository !== null && previousRepository !== null) {
      const repoChanged =
        repository.owner !== previousRepository.owner ||
        repository.name !== previousRepository.name;
      if (repoChanged) {
        console.log(
          '[WorkflowRuns] Repository changed from',
          `${previousRepository.owner}/${previousRepository.name}`,
          'to',
          `${repository.owner}/${repository.name}`,
          '- clearing all caches'
        );
        clearCache(); // Clear all caches to prevent cross-repository data
        // Also clear watched runs as they are repository-specific
        watchedRuns = new Set();
        showWatchedOnly = false;
        // The workflow dropdown is built from the previous repository's local
        // workflow definitions. Drop them and re-request the new repository's
        // workflows so the "All workflows" list reflects the active repo only.
        allWorkflowDefinitions = [];
        buildAvailableWorkflows();
        vscode.postMessage({ type: 'getWorkflows' });
      }
    }
    previousRepository = repository ? { owner: repository.owner, name: repository.name } : null;
  }

  // Reactive: Re-apply filters when currentUsername changes while actorFilter is 'me'.
  // This fixes an intermittent bug where the "My Runs" filter fails to work correctly
  // when the user changes to "My Runs" before the getUserInfo response arrives.
  // Without this, if currentUsername is empty when filterRuns() is called, the actor
  // filter is skipped, and subsequent updates to currentUsername don't trigger re-filtering.
  $: {
    if (currentUsername !== previousCurrentUsername) {
      previousCurrentUsername = currentUsername;
      // Only re-filter if we have runs loaded and actor filter is set to 'me'
      // This ensures we update the display when username becomes available
      if (runs.length > 0 && actorFilter === 'me' && currentUsername) {
        console.log(
          '[WorkflowRuns] currentUsername changed to',
          currentUsername,
          '- re-applying filters for My Runs'
        );
        filterRuns();
      }
    }
  }

  // Reactive: reset pagination when non-search filters that significantly
  // change the result set change. We intentionally do NOT reset for
  // searchQuery, dateFilterFrom/dateFilterTo, or workflowLoadLimit here;
  // those have their own handlers or should preserve pagination.
  $: {
    let shouldResetPage = false;

    if (actorFilter !== previousActorFilter) {
      previousActorFilter = actorFilter;
      shouldResetPage = true;
    }

    if (statusFilter !== previousStatusFilter) {
      previousStatusFilter = statusFilter;
      shouldResetPage = true;
    }

    if (showWatchedOnly !== previousShowWatchedOnly) {
      previousShowWatchedOnly = showWatchedOnly;
      shouldResetPage = true;
    }

    if (showFavoritesOnly !== previousShowFavoritesOnly) {
      previousShowFavoritesOnly = showFavoritesOnly;
      shouldResetPage = true;
    }

    if (shouldResetPage) {
      currentPage = 1;
    }
  }

  // Debug: Log active filters whenever they change
  $: {
    console.log('[WorkflowRuns] Active Filters Debug:', {
      statusFilter,
      actorFilter,
      showBotRuns,
      workflowFilter,
      searchQuery,
      showWatchedOnly,
      showFavoritesOnly,
      dateFilterFrom,
      dateFilterTo,
      activeFilterLabels,
      runsLength: runs.length,
      filteredRunsLength: filteredRuns.length,
    });
  }

  // Reactive: Manage delayed visibility for background fetch indicator
  // This prevents the indicator from flashing for brief fetches (< 300ms)
  // and ensures smooth transitions when fetching starts/stops
  const FETCH_INDICATOR_SHOW_DELAY = 300; // ms before showing indicator
  const FETCH_INDICATOR_HIDE_DELAY = 200; // ms before hiding indicator (prevents flicker)

  /**
   * Handle changes to progressiveFetching state by showing/hiding the indicator
   * with appropriate delays to prevent flicker.
   */
  function handleProgressiveFetchingChange(isFetching: boolean) {
    if (fetchingIndicatorTimeout) {
      clearTimeout(fetchingIndicatorTimeout);
      fetchingIndicatorTimeout = null;
    }

    if (isFetching) {
      // When fetching starts, delay showing the indicator
      fetchingIndicatorTimeout = setTimeout(() => {
        showFetchingIndicator = true;
        fetchingIndicatorTimeout = null;
      }, FETCH_INDICATOR_SHOW_DELAY);
    } else {
      // When fetching stops, delay hiding to prevent flicker
      fetchingIndicatorTimeout = setTimeout(() => {
        showFetchingIndicator = false;
        fetchingIndicatorTimeout = null;
      }, FETCH_INDICATOR_HIDE_DELAY);
    }
  }

  // React to progressiveFetching changes
  $: handleProgressiveFetchingChange(progressiveFetching);

  // Reactive: Track if progressive fetching is active or will resume shortly.
  // This is computed reactively to ensure the UI updates when any of the
  // underlying state changes (progressiveFetching, nextBackendPage, runs,
  // totalCount, totalRunsFetched, showWatchedOnly, loading, filteredRuns, etc.)
  $: isSearchingForRuns = computeIsSearchingForRuns(
    progressiveFetching,
    nextBackendPage,
    runs,
    totalCount,
    totalRunsFetched,
    showWatchedOnly,
    loading,
    filteredRuns,
    workflowLoadLimit,
    currentPage,
    dateFilterFrom,
    dateFilterTo,
    DATE_FILTER_MAX_TOTAL_RUNS,
    NON_DATE_MAX_TOTAL_RUNS
  );

  // Reactive: Current page number for display
  // Explicitly depend on filteredRuns to ensure updates
  $: currentPageNumber = getCurrentPage(filteredRuns, workflowLoadLimit, currentPage);

  // Reactive: Total pages for display
  // Explicitly depend on filteredRuns to ensure updates
  $: totalPagesNumber = getTotalPages(filteredRuns, workflowLoadLimit);

  // Reactive: Track loading state changes for health monitoring
  $: {
    if (loading) {
      recordLoadingStart();
    } else {
      recordLoadingEnd();
    }
  }

  // Reactive: Track refreshing state changes for health monitoring
  $: {
    if (refreshing) {
      recordRefreshingStart();
    } else {
      recordRefreshingEnd();
    }
  }

  // Reactive: Track date filter fetch state for health monitoring
  $: {
    if (fetchingDateFilteredRuns) {
      recordDateFilterStart();
    } else {
      recordDateFilterEnd();
    }
  }

  // Reactive: Memoized computation for max runs warning visibility
  // Avoids calling shouldShowMaxRunsWarning() multiple times in templates with identical params
  $: showMaxRunsWarningMemo = shouldShowMaxRunsWarning(
    filteredRuns.length,
    runs.length,
    totalRunsFetched
  );

  // Motion preference
  reduceMotion = !!(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  // Job expansion state
  let expandedRuns = new Set<number>(); // Set of expanded run IDs
  let runJobs = new Map<number, WorkflowJob[]>(); // Map of run ID to jobs
  let loadingJobs = new Set<number>(); // Set of run IDs currently loading jobs
  // Render key for jobs list - forces DOM re-creation to prevent Svelte corruption
  let jobsRenderKey = new Map<number, number>(); // Map of run ID to render key

  // Job dependency graph state
  let runJobDefinitions = new Map<number, WorkflowJobDefinition[]>(); // Map of run ID to job definitions
  let loadingJobDependencies = new Set<number>(); // Set of run IDs currently loading job dependencies
  let showDependencyGraph = new Set<number>(); // Set of run IDs with graph visible

  // Artifacts state
  let runArtifacts = new Map<number, any[]>(); // Map of run ID to artifacts
  let loadingArtifacts = new Set<number>(); // Set of run IDs currently loading artifacts
  let showArtifacts = new Set<number>(); // Set of run IDs with artifacts section visible
  // Render key for artifacts list - forces DOM re-creation to prevent Svelte corruption
  let artifactsRenderKey = new Map<number, number>(); // Map of run ID to render key

  // Summary state
  let showSummary = new Set<number>(); // Set of run IDs with summary section visible

  // Cancellation state management
  let cancellationState: CancellationState = {
    cancellingRuns: new Set<number>(),
    cancelledRuns: new Set<number>(),
    failedCancellations: new Map<number, string>(),
  };

  // Help modal state
  let showHelpModal = false;
  let helpModalTitle = '';
  let helpModalContent = '';

  // Parameters modal state
  let showParametersModal = false;
  let parametersModalTitle = '';
  let parametersModalRunId: number | null = null;
  let parametersModalBranch: string | null = null;
  let parametersModalInputs: Record<string, unknown> | null = null;
  let parametersModalNotFound = false;

  // Rerun dispatch confirmation modal state (reuses Parameters styling)
  let showDispatchConfirmModal = false;
  let dispatchConfirmTitle = '';
  let dispatchConfirmBranch: string | null = null;
  let dispatchConfirmInputs: Record<string, unknown> = {};

  // Cancel confirmation modal state
  let showCancelConfirmModal = false;
  let cancelConfirmRunId: number | null = null;
  let cancelConfirmRunName: string = '';
  let cancelConfirmRunBranch: string = '';
  let cancelConfirmRunAuthor: string = '';

  // Job steps modal state (for jobs list view)
  let selectedJobForStepsModal: JobGraphNode | null = null;
  let selectedJobRunIdForSteps: number | null = null;
  let selectedJobWorkflowIdForSteps: number | null = null; // Workflow ID for step comparison
  let selectedJobWorkflowNameForSteps: string | null = null; // Workflow name for step comparison
  let loadingJobSteps: Set<number> = new Set(); // Track jobs currently loading steps
  let loadingJobLogs: Set<number> = new Set(); // Track jobs currently loading interactive logs
  let loadingRawJobLogs: Set<number> = new Set(); // Track jobs currently loading raw logs
  let loadingStepLogs: Map<string, boolean> = new Map(); // Track steps currently loading logs (key: jobId-stepNumber)
  let loadingJobSummary: Set<number> = new Set(); // Track jobs currently loading summary
  let jobSummaryFromStepsModal: boolean = false; // Track if job summary was requested from steps modal

  // Log comparison state
  let compareSourceJob: {
    jobId: number;
    jobName: string;
    runId: number;
    workflowId: number;
    workflowName: string;
  } | null = null;
  let loadingComparison: boolean = false;

  // Step log comparison state
  let compareSourceStep: {
    stepNumber: number;
    stepName: string;
    jobId: number;
    jobName: string;
    runId: number;
    workflowId: number;
    workflowName: string;
  } | null = null;
  let loadingStepComparison: boolean = false;

  // Job graph modal state (full screen view)
  let showJobGraphModal = false;
  let jobGraphModalRunId: number | null = null;

  // GitHub summary modal state
  // Note: GitHub API doesn't provide job summary content via REST API.
  // The button now opens the browser directly instead of this modal.
  let showGitHubSummaryModal = false;
  let gitHubSummaryModalRunId: number | null = null;
  let gitHubSummaryContent: string = ''; // HTML content for modal display
  let gitHubSummaryMarkdown: string = ''; // Raw markdown content for tab view
  let gitHubSummaryHtmlUrl: string = '';
  let gitHubSummaryLoading: boolean = false;
  let gitHubSummaryError: string = '';

  function formatParameterValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  // Cache for workflow runs (workflow-specific)
  interface WorkflowRunsCache {
    runs: WorkflowRun[];
    totalCount: number;
    lastFetchTimestamp: number; // When we last fetched runs for this workflow
    cacheTimestamp: number; // When this cache entry was created
    repository: { owner: string; name: string } | null;
  }
  // Map of workflow path -> cache
  // Limited to MAX_CACHE_ENTRIES to prevent unbounded memory growth
  let workflowRunsCache: Map<string, WorkflowRunsCache> = new Map();
  const CACHE_EXPIRATION_MS = 3 * 60 * 1000; // 3 minutes
  const MAX_CACHE_ENTRIES = 5; // Limit number of cached workflows to prevent memory bloat
  const MAX_CACHED_RUNS_PER_WORKFLOW = 500; // Limit runs per cache entry

  // Scroll threshold (pixels) after which Active Filters auto-collapses
  const SCROLL_THRESHOLD = 50;

  /**
   * Handle scroll events for smart Active Filters auto-collapse.
   * - When scrolled past threshold: auto-collapse filters (unless user manually toggled)
   * - When scrolled back to top: reset manual toggle flag and expand filters
   */
  function handleScroll() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const wasScrolled = isScrolled;
    isScrolled = scrollTop > SCROLL_THRESHOLD;

    // When scrolling down past threshold: auto-collapse if user hasn't manually toggled
    if (isScrolled && !wasScrolled && !userManuallyToggledFilters) {
      filtersExpanded = false;
    }

    // When scrolling back to top: reset manual toggle flag and expand filters
    if (!isScrolled && wasScrolled) {
      userManuallyToggledFilters = false;
      filtersExpanded = true;
    }
  }

  onMount(() => {
    // Check cache first for current workflow filter
    const cacheKey = getCacheKey();
    console.log('[WorkflowRuns] onMount: Checking cache for:', cacheKey);
    if (loadFromCache(cacheKey)) {
      console.log('[WorkflowRuns] onMount: Using cached data');
      loading = false;
      buildAvailableWorkflows();
      filterRuns();
    } else {
      console.log('[WorkflowRuns] onMount: Cache miss, requesting fresh data...');
    }

    // Request initial data (will update cache if expired or missing)
    // If cache exists, request only new runs since last fetch
    const lastFetch = getLastFetchTimestamp(cacheKey);
    console.log('[WorkflowRuns] onMount: Requesting initial data...');
    vscode.postMessage({
      type: 'getWorkflowRuns',
      data: lastFetch ? { since: new Date(lastFetch).toISOString() } : undefined,
    });
    vscode.postMessage({ type: 'getUserInfo' });
    vscode.postMessage({ type: 'getCurrentPR' });
    vscode.postMessage({ type: 'getMarkedWorkflows' });
    vscode.postMessage({ type: 'getWatchedRuns' });
    console.log('[WorkflowRuns] onMount: Sending getWorkflows message...');
    vscode.postMessage({ type: 'getWorkflows' }); // Get workflow definitions for dropdown
    vscode.postMessage({ type: 'getCurrentBranch' }); // Get current branch
    vscode.postMessage({ type: 'getDefaultBranch' }); // Get default branch
    vscode.postMessage({ type: 'checkBranchOnRemote' }); // Check if branch exists on remote

    // Listen for messages from extension
    window.addEventListener('message', handleMessage);

    // Listen for clicks outside workflow dropdown
    window.addEventListener('click', handleWorkflowDropdownClickOutside);

    // Listen for scroll events (for smart Active Filters auto-collapse)
    window.addEventListener('scroll', handleScroll, { passive: true });

    // Start auto-refresh if enabled
    startAutoRefresh();

    // Start health monitoring system
    startHealthMonitoring();

    // Trigger welcome wave animation if allowed
    triggerWorkflowRunsWaveIfAllowed();

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleWorkflowDropdownClickOutside);
      window.removeEventListener('scroll', handleScroll);
      stopAutoRefresh();
      stopHealthMonitoring();
    };
  });

  onDestroy(() => {
    stopAutoRefresh();
    stopHealthMonitoring();
  });

  /**
   * Check if there are any active (in_progress or queued) runs that warrant faster polling.
   * Considers visible runs to avoid unnecessary fast polling when active runs are filtered out.
   */
  function hasActiveRuns(): boolean {
    // Check visible runs first (what user sees), fall back to all runs
    const runsToCheck = visibleRuns.length > 0 ? visibleRuns : runs;
    return runsToCheck.some((run) => run.status === 'in_progress' || run.status === 'queued');
  }

  /**
   * Calculate the effective refresh interval based on adaptive logic and rate limit protection.
   * Returns faster interval when active runs exist and adaptive refresh is enabled,
   * applies backoff when rate limit protection is active,
   * returns user's main preference otherwise.
   */
  function getEffectiveRefreshInterval(): number {
    if (autoRefreshSeconds === 0) {
      return 0; // Auto-refresh disabled
    }

    let baseInterval = autoRefreshSeconds;

    // Only use adaptive fast polling if:
    // 1. Adaptive refresh is enabled by the user
    // 2. There are active runs
    // 3. User's main interval is slower than the fast interval
    // 4. Rate limit protection is NOT active (don't speed up when throttled)
    if (
      adaptiveRefreshEnabled &&
      hasActiveRuns() &&
      autoRefreshSeconds > adaptiveFastRefreshSeconds &&
      !rateLimitProtectionActive
    ) {
      baseInterval = adaptiveFastRefreshSeconds;
    }

    // Apply rate limit protection backoff if active
    if (rateLimitProtectionActive && rateLimitProtectionEnabled) {
      // Apply exponential backoff: interval * multiplier (2x, 4x, etc.)
      // Cap at 4x the base interval to avoid excessively long waits
      const maxMultiplier = 4;
      const effectiveMultiplier = Math.min(rateLimitBackoffMultiplier, maxMultiplier);
      baseInterval = Math.max(baseInterval * effectiveMultiplier, 60); // Minimum 60s when throttled

      console.log('[WorkflowRuns] Rate limit protection applied:', {
        originalInterval: autoRefreshSeconds,
        multiplier: effectiveMultiplier,
        effectiveInterval: baseInterval,
      });
    }

    return baseInterval;
  }

  /**
   * Start auto-refresh timer with adaptive interval support.
   * Uses faster polling (10s) when in-progress/queued runs exist,
   * falls back to user's selected interval when all runs are stable.
   */
  /**
   * Get the IDs of currently visible runs for scoped refresh.
   * Returns visible runs plus any runs with expanded UI (jobs, graph, summary).
   */
  function getVisibleRunIdsForRefresh(): number[] {
    const visibleRunIds = new Set<number>();

    // Add currently visible runs in the pagination slice
    for (const run of visibleRuns) {
      visibleRunIds.add(run.id);
    }

    // Also include runs with expanded UI that may need updates
    // even if they're not currently visible (scrolled out of view)
    for (const runId of expandedRuns) {
      visibleRunIds.add(runId);
    }
    for (const runId of showDependencyGraph) {
      visibleRunIds.add(runId);
    }
    for (const runId of showSummary) {
      visibleRunIds.add(runId);
    }

    return Array.from(visibleRunIds);
  }

  function startAutoRefresh() {
    stopAutoRefresh(); // Clear any existing interval

    if (autoRefreshSeconds > 0) {
      const effectiveInterval = getEffectiveRefreshInterval();
      adaptiveRefreshActive = effectiveInterval < autoRefreshSeconds;

      console.log('[WorkflowRuns] Starting auto-refresh:', {
        userInterval: autoRefreshSeconds,
        effectiveInterval,
        adaptiveRefreshActive,
        adaptiveRefreshEnabled,
      });

      refreshInterval = window.setInterval(() => {
        // Record auto-refresh execution for health monitoring
        recordAutoRefreshExecution();

        // Skip if a background refresh is already in progress to prevent
        // request pile-up during fast refresh intervals (5-10s)
        if (isBackgroundRefreshInProgress) {
          console.log('[WorkflowRuns] Skipping auto-refresh - previous request still in progress');
          return;
        }

        // Avoid overlapping with explicit background fetches or temporary
        // pauses (for example when viewing logs or artifacts), or while
        // the panel is already busy loading data (initial load, manual
        // refresh, "Load more", progressive fetch, or a date-filtered fetch).
        if (
          !autoRefreshPaused &&
          !loadingMore &&
          !loading &&
          !refreshing &&
          !fetchingDateFilteredRuns &&
          !progressiveFetching
        ) {
          // Mark that a background refresh is starting
          isBackgroundRefreshInProgress = true;

          // Always use background refresh for auto-refresh to avoid showing
          // loading indicators and preserve UI state (scroll position, etc.)
          // When "Watched Runs Only" filter is active, use the specialized
          // background refresh that only fetches watched runs
          if (showWatchedOnly && watchedRuns.size > 0) {
            vscode.postMessage({
              type: 'backgroundRefreshWatchedRuns',
              data: { watchedRunIds: Array.from(watchedRuns) },
            });
          } else {
            // Send visible run IDs for scoped refresh to reduce API calls
            // The backend will prioritize these runs but may also fetch new runs
            const visibleRunIds = getVisibleRunIdsForRefresh();
            vscode.postMessage({
              type: 'backgroundRefreshAllRuns',
              data: { visibleRunIds },
            });
          }
        }
      }, effectiveInterval * 1000);
    } else {
      adaptiveRefreshActive = false;
    }
  }

  function handleAutoRefreshSliderChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    const index = Number(target.value);
    if (!Number.isFinite(index)) {
      return;
    }

    const clampedIndex = Math.min(
      Math.max(Math.trunc(index), 0),
      AUTO_REFRESH_SLIDER_OPTIONS.length - 1
    );
    const nextSeconds = AUTO_REFRESH_SLIDER_OPTIONS[clampedIndex];
    if (
      typeof nextSeconds !== 'number' ||
      !Number.isFinite(nextSeconds) ||
      nextSeconds === autoRefreshSeconds
    ) {
      autoRefreshIndex = clampedIndex;
      return;
    }

    autoRefreshIndex = clampedIndex;
    // When slider changes, also store as previous value and enable auto-refresh
    previousAutoRefreshSeconds = nextSeconds;
    updateAutoRefresh(nextSeconds);
  }

  /**
   * Stop auto-refresh timer
   */
  function stopAutoRefresh() {
    if (refreshInterval) {
      clearInterval(refreshInterval);

      refreshInterval = null;
    }
  }

  /**
   * Recalculate adaptive refresh interval based on current run states.
   * Called after runs are updated to adjust polling frequency dynamically.
   * Only restarts the timer if the effective interval has changed.
   *
   * IMPORTANT: This function is debounced to prevent timer thrashing when
   * multiple API responses arrive rapidly (e.g., during fast refresh with
   * multiple active runs). Without debouncing, each response would trigger
   * a timer restart, potentially causing the panel to freeze.
   */
  function recalculateAdaptiveRefresh() {
    if (autoRefreshSeconds === 0 || autoRefreshPaused) {
      return; // Auto-refresh disabled or paused
    }

    // Clear any pending debounce to prevent stale calculations
    if (adaptiveRefreshDebounceId !== null) {
      window.clearTimeout(adaptiveRefreshDebounceId);
      adaptiveRefreshDebounceId = null;
    }

    // Debounce the actual recalculation to prevent timer thrashing
    adaptiveRefreshDebounceId = window.setTimeout(() => {
      adaptiveRefreshDebounceId = null;

      const currentEffectiveInterval = getEffectiveRefreshInterval();
      const wasAdaptive = adaptiveRefreshActive;
      const shouldBeAdaptive = currentEffectiveInterval < autoRefreshSeconds;

      // Only restart if adaptive state changed (to avoid unnecessary timer resets)
      if (wasAdaptive !== shouldBeAdaptive) {
        console.log(
          '[WorkflowRuns] Adaptive refresh (debounced):',
          shouldBeAdaptive
            ? `activating fast refresh (${currentEffectiveInterval}s)`
            : `reverting to user interval (${autoRefreshSeconds}s)`
        );
        startAutoRefresh();
      }
    }, ADAPTIVE_REFRESH_DEBOUNCE_MS);
  }

  /**
   * Update auto-refresh interval and notify the extension host so it can be
   * persisted for future sessions.
   */
  function updateAutoRefresh(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }

    autoRefreshSeconds = seconds;
    autoRefreshIndex = getAutoRefreshOptionIndex(seconds);
    startAutoRefresh();

    vscode.postMessage({
      type: 'updateAutoRefresh',
      data: { autoRefreshSeconds: seconds },
    });
  }

  /**
   * Update notification settings and persist to extension storage.
   * Call this function whenever any notification checkbox is toggled.
   */
  function updateNotificationSettings() {
    vscode.postMessage({
      type: 'updateNotificationSettings',
      data: {
        showWorkflowToastNotifications,
        showProgressIndicators,
      },
    });
  }

  /**
   * Update rate limit tracking from API response data.
   * Called when receiving responses that include rate limit headers.
   */
  function updateRateLimit(rateLimitData: {
    remaining?: number;
    limit?: number;
    reset?: number | string;
  }) {
    const previousRemaining = rateLimitRemaining;

    if (typeof rateLimitData.remaining === 'number') {
      rateLimitRemaining = rateLimitData.remaining;
    }
    if (typeof rateLimitData.limit === 'number') {
      rateLimitLimit = rateLimitData.limit;
    }
    if (rateLimitData.reset) {
      const resetTime =
        typeof rateLimitData.reset === 'number'
          ? new Date(rateLimitData.reset * 1000)
          : new Date(rateLimitData.reset);
      if (!isNaN(resetTime.getTime())) {
        rateLimitResetTime = resetTime;
      }
    }

    // Check if rate limit has reset (remaining increased significantly)
    // This happens when the hour window rolls over
    if (
      previousRemaining !== null &&
      rateLimitRemaining !== null &&
      rateLimitRemaining > previousRemaining + 100
    ) {
      console.log('[WorkflowRuns] Rate limit appears to have reset:', {
        previous: previousRemaining,
        current: rateLimitRemaining,
      });
      resetRateLimitWarnings();
      // Restart auto-refresh with normal interval
      if (autoRefreshSeconds > 0) {
        startAutoRefresh();
      }
    }

    // Check if usage dropped below critical threshold, disable protection
    // Use configurable threshold - exit at 90% of the threshold (10% hysteresis)
    if (rateLimitProtectionActive && rateLimitRemaining !== null && rateLimitLimit !== null) {
      const usagePercent = 1 - rateLimitRemaining / rateLimitLimit;
      const exitThreshold = (rateLimitThreshold / 100) * 0.9; // Exit at 90% of entry threshold
      if (usagePercent < exitThreshold) {
        rateLimitProtectionActive = false;
        rateLimitBackoffMultiplier = 1;
        console.log('[WorkflowRuns] Rate limit protection deactivated, resuming normal refresh');
        showToast('Rate limit protection deactivated - normal refresh resumed', 'info', 3000);
        if (autoRefreshSeconds > 0) {
          startAutoRefresh();
        }
      }
    }

    // Check if we should show a warning
    checkRateLimitWarning();
  }

  /**
   * Check if rate limit usage is approaching thresholds and show appropriate warnings.
   * Implements tiered warning system at 50%, 75%, and 90% usage.
   */
  function checkRateLimitWarning() {
    if (rateLimitRemaining === null || rateLimitLimit === null || rateLimitLimit === 0) {
      return;
    }

    const usagePercent = 1 - rateLimitRemaining / rateLimitLimit;
    const resetTimeStr = rateLimitResetTime ? rateLimitResetTime.toLocaleTimeString() : 'soon';
    const configuredThreshold = rateLimitThreshold / 100; // Convert percentage to decimal

    // Check for configurable threshold usage - enable rate limit protection
    if (usagePercent >= configuredThreshold && rateLimitProtectionEnabled) {
      if (!rateLimitProtectionActive) {
        rateLimitProtectionActive = true;
        rateLimitBackoffMultiplier = 2; // Start with 2x backoff

        showToast(
          `⚠️ Rate limit protection active: Only ${rateLimitRemaining} requests remaining (${rateLimitThreshold}% threshold reached). ` +
            `Background refreshes are being throttled. Resets at ${resetTimeStr}.`,
          'warning',
          10000
        );

        console.warn('[WorkflowRuns] Rate limit protection activated:', {
          remaining: rateLimitRemaining,
          limit: rateLimitLimit,
          usagePercent: (usagePercent * 100).toFixed(1) + '%',
          threshold: rateLimitThreshold + '%',
        });

        // Restart auto-refresh to apply throttled interval
        startAutoRefresh();
      } else {
        // Increase backoff if still approaching limits
        if (rateLimitBackoffMultiplier < 4) {
          rateLimitBackoffMultiplier = Math.min(rateLimitBackoffMultiplier * 2, 4);
          startAutoRefresh();
        }
      }
      return; // Skip lower warnings if protection is active
    }

    // Check for 75% usage - urgent warning
    if (usagePercent >= RATE_LIMIT_WARNING_75_THRESHOLD && !rateLimitWarning75Shown) {
      rateLimitWarning75Shown = true;

      const suggestedInterval = Math.max(60, autoRefreshSeconds * 2);

      showToast(
        `🚨 API Rate Limit: ${rateLimitRemaining}/${rateLimitLimit} requests remaining (${Math.round((1 - usagePercent) * 100)}%). ` +
          `Consider disabling auto-refresh or increasing interval to ${suggestedInterval}s. Resets at ${resetTimeStr}.`,
        'warning',
        12000
      );

      console.warn('[WorkflowRuns] Rate limit 75% warning:', {
        remaining: rateLimitRemaining,
        limit: rateLimitLimit,
        usagePercent: (usagePercent * 100).toFixed(1) + '%',
      });
      return;
    }

    // Check for 50% usage - first warning with suggestions
    if (usagePercent >= RATE_LIMIT_WARNING_50_THRESHOLD && !rateLimitWarning50Shown) {
      rateLimitWarning50Shown = true;

      const currentInterval = autoRefreshSeconds > 0 ? autoRefreshSeconds : 30;
      const suggestedInterval = Math.max(60, currentInterval * 2);

      showToast(
        `⚡ API Rate Limit: ${rateLimitRemaining}/${rateLimitLimit} requests remaining (${Math.round((1 - usagePercent) * 100)}%). ` +
          `Consider reducing auto-refresh from ${currentInterval}s to ${suggestedInterval}s. Resets at ${resetTimeStr}.`,
        'info',
        10000
      );

      console.log('[WorkflowRuns] Rate limit 50% warning:', {
        remaining: rateLimitRemaining,
        limit: rateLimitLimit,
        usagePercent: (usagePercent * 100).toFixed(1) + '%',
      });
    }
  }

  /**
   * Handle quick action to increase refresh interval from rate limit warning.
   * Jumps to the next valid option in AUTO_REFRESH_SECONDS_OPTIONS that is >= 60s.
   */
  function increaseRefreshInterval() {
    // Find the next higher option in AUTO_REFRESH_SECONDS_OPTIONS
    // Only consider options >= 60 seconds for rate limit protection
    const validHigherOptions = AUTO_REFRESH_SLIDER_OPTIONS.filter(
      (opt) => opt >= 60 && opt > autoRefreshSeconds
    );

    if (validHigherOptions.length === 0) {
      // Already at max, use the highest available option
      const maxOption = Math.max(...AUTO_REFRESH_SLIDER_OPTIONS);
      showToast(`Already at maximum interval (${maxOption} seconds)`, 'info', 3000);
      return;
    }

    const newInterval = validHigherOptions[0]; // First option that's higher
    updateAutoRefresh(newInterval);
    showToast(
      `Auto-refresh interval increased to ${formatAutoRefreshLabel(newInterval)}`,
      'info',
      3000
    );
  }

  /**
   * Handle quick action to disable auto-refresh from rate limit warning.
   */
  function disableAutoRefreshForRateLimit() {
    // Store current interval before disabling
    if (autoRefreshSeconds > 0) {
      previousAutoRefreshSeconds = autoRefreshSeconds;
    }
    updateAutoRefresh(0);
    showToast('Auto-refresh disabled to preserve API quota', 'info', 3000);
  }

  /**
   * Handle quick action to enable auto-refresh (restore previous interval).
   */
  function enableAutoRefreshFromRateLimit() {
    // Restore previous interval, or use default if none stored
    const intervalToRestore =
      previousAutoRefreshSeconds > 0 ? previousAutoRefreshSeconds : DEFAULT_AUTO_REFRESH_SECONDS;
    updateAutoRefresh(intervalToRestore);
    showToast(`Auto-refresh enabled (${formatAutoRefreshLabel(intervalToRestore)})`, 'info', 3000);
  }

  /**
   * Toggle auto-refresh on/off via checkbox.
   * Stores the previous interval when disabling, restores it when enabling.
   */
  function handleAutoRefreshToggle(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;

    if (target.checked) {
      // Enable auto-refresh - restore previous interval
      const intervalToRestore =
        previousAutoRefreshSeconds > 0 ? previousAutoRefreshSeconds : DEFAULT_AUTO_REFRESH_SECONDS;
      updateAutoRefresh(intervalToRestore);
    } else {
      // Disable auto-refresh - store current interval first
      if (autoRefreshSeconds > 0) {
        previousAutoRefreshSeconds = autoRefreshSeconds;
      }
      updateAutoRefresh(0);
    }
  }

  /**
   * Reset rate limit warning flags when rate limit resets.
   * Called when we detect the reset time has passed.
   */
  function resetRateLimitWarnings() {
    rateLimitWarning50Shown = false;
    rateLimitWarning75Shown = false;
    rateLimitProtectionActive = false;
    rateLimitBackoffMultiplier = 1;
  }

  /**
   * Check if rate limit has reset and clear warning flags.
   */
  function checkRateLimitReset() {
    if (rateLimitResetTime && new Date() > rateLimitResetTime) {
      resetRateLimitWarnings();
    }
  }

  // Note: Rate limit display functions (getRateLimitStatus, getRateLimitUsagePercent,
  // getRateLimitColorClass, getFormattedResetTime) have been replaced with reactive
  // variables (rateLimitStatusText, rateLimitUsagePercent, rateLimitColorClass,
  // rateLimitResetTimeText, rateLimitRemainingPercent) defined near line 633
  // to ensure real-time UI updates when rate limit data changes.

  /**
   * Toggle rate limit protection setting.
   */
  function toggleRateLimitProtection(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    rateLimitProtectionEnabled = target.checked;

    // Persist to extension storage
    vscode.postMessage({
      type: 'updateRateLimitSettings',
      data: { rateLimitProtectionEnabled },
    });

    if (rateLimitProtectionEnabled) {
      showToast(
        `Rate limit protection enabled - will auto-throttle at ${rateLimitThreshold}% usage`,
        'info',
        3000
      );
    } else {
      showToast('Rate limit protection disabled - requests will not be throttled', 'info', 3000);
      rateLimitProtectionActive = false;
      rateLimitBackoffMultiplier = 1;
    }
  }

  /**
   * Handle changes to the rate limit threshold selector.
   * Updates local state and persists the preference.
   */
  function handleRateLimitThresholdChange(event: Event) {
    const target = event.target as HTMLSelectElement | null;
    if (!target) return;

    const newThreshold = parseInt(target.value, 10);
    if (!RATE_LIMIT_THRESHOLD_OPTIONS.includes(newThreshold)) return;

    rateLimitThreshold = newThreshold;

    // Persist to extension storage
    vscode.postMessage({
      type: 'updateRateLimitSettings',
      data: { rateLimitProtectionEnabled, rateLimitThreshold },
    });

    showToast(`Auto-throttling threshold set to ${rateLimitThreshold}%`, 'info', 3000);

    // If protection is already active and new threshold is higher than current usage, deactivate
    if (rateLimitProtectionActive && rateLimitRemaining !== null && rateLimitLimit !== null) {
      const currentUsage = 1 - rateLimitRemaining / rateLimitLimit;
      if (currentUsage < rateLimitThreshold / 100) {
        rateLimitProtectionActive = false;
        rateLimitBackoffMultiplier = 1;
        showToast('Rate limit protection deactivated due to threshold change', 'info', 3000);
        if (autoRefreshSeconds > 0) {
          startAutoRefresh();
        }
      }
    }
  }

  /**
   * Show help modal with information about auto-throttling.
   */
  function showAutoThrottlingHelp() {
    helpModalTitle = 'Auto-Throttling';
    helpModalContent = `
<h4>How Auto-Throttling Works</h4>
<p>Auto-throttling automatically reduces API request frequency when your usage approaches the configured threshold.</p>

<h4>Threshold Setting</h4>
<p>The threshold (${rateLimitThreshold}%) determines when protection activates:</p>
<ul>
  <li><strong>50%</strong> - Conservative, protects early (2,500 requests remaining)</li>
  <li><strong>70%</strong> - Moderate protection (1,500 requests remaining)</li>
  <li><strong>90%</strong> - Aggressive, maximizes usage (500 requests remaining)</li>
</ul>

<h4>What Happens When Active</h4>
<ul>
  <li>Auto-refresh interval is multiplied by a backoff factor (2x, 4x)</li>
  <li>Minimum 60 second intervals are enforced</li>
  <li>Manual refreshes are still allowed</li>
  <li>Protection deactivates when usage drops below ${Math.round(rateLimitThreshold * 0.9)}%</li>
</ul>

<h4>Rate Limit Info</h4>
<p>GitHub allows 5,000 authenticated API requests per hour. The limit resets hourly.</p>
`;
    showHelpModal = true;
  }

  /**
   * Handle changes to the "Enable Adaptive Refresh" checkbox.
   * Updates local state and persists the preference.
   */
  function handleAdaptiveRefreshEnabledChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    adaptiveRefreshEnabled = target.checked;
    startAutoRefresh(); // Apply the change immediately

    vscode.postMessage({
      type: 'updateAdaptiveRefreshSettings',
      data: {
        adaptiveRefreshEnabled: adaptiveRefreshEnabled,
        adaptiveFastRefreshSeconds: adaptiveFastRefreshSeconds,
      },
    });
  }

  /**
   * Handle changes to the adaptive fast refresh interval slider.
   * Updates local state and persists the preference.
   */
  function handleAdaptiveFastRefreshSliderChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    const value = Number(target.value);
    if (!Number.isFinite(value)) {
      return;
    }

    // Clamp to valid range
    const clampedValue = Math.min(
      Math.max(Math.round(value), MIN_ADAPTIVE_FAST_REFRESH_SECONDS),
      MAX_ADAPTIVE_FAST_REFRESH_SECONDS
    );

    adaptiveFastRefreshSeconds = clampedValue;
    startAutoRefresh(); // Apply the change immediately

    vscode.postMessage({
      type: 'updateAdaptiveRefreshSettings',
      data: {
        adaptiveRefreshEnabled: adaptiveRefreshEnabled,
        adaptiveFastRefreshSeconds: adaptiveFastRefreshSeconds,
      },
    });
  }

  /**
   * Show help modal with information about adaptive refresh.
   */
  function showAdaptiveRefreshSettingsHelp() {
    helpModalTitle = 'Adaptive Refresh';
    helpModalContent = `
      <p><strong>Adaptive Refresh</strong> automatically speeds up polling when in-progress or queued runs are detected.</p>
      <p>When enabled:</p>
      <ul>
        <li>Uses the <strong>fast refresh interval</strong> (configurable: 5-10 seconds) when active runs exist</li>
        <li>Falls back to your <strong>main auto-refresh interval</strong> when all runs are stable</li>
      </ul>
      <p>When disabled:</p>
      <ul>
        <li>Always uses your main auto-refresh interval, regardless of run states</li>
      </ul>
      <p><strong>⚡ GitHub API Rate Limits:</strong></p>
      <ul>
        <li>GitHub allows ~5,000 requests per hour for authenticated users</li>
        <li>At 5s intervals: ~720 requests/hour (~14% of quota)</li>
        <li>At 10s intervals: ~360 requests/hour (~7% of quota)</li>
      </ul>
      <p>Adaptive refresh helps balance responsiveness with API quota preservation by only using faster polling when needed.</p>
      <p><strong>Note:</strong> Adaptive refresh requires auto-refresh to be enabled. When auto-refresh is disabled, adaptive refresh has no effect.</p>
    `;
    showHelpModal = true;
  }

  /**
   * Show help modal with information about API rate limits.
   */
  function showRateLimitStatusHelp() {
    helpModalTitle = 'API Rate Limit (Live)';
    helpModalContent = `
      <p><strong>What are GitHub API rate limits?</strong></p>
      <p>GitHub imposes limits on how many API requests you can make to prevent abuse and ensure fair usage:</p>
      <ul>
        <li><strong>5,000 requests per hour</strong> for authenticated users (using personal access tokens)</li>
        <li>GitHub uses a <strong>sliding window</strong> that starts from your first API request</li>
        <li>The "Resets at" time shows when your current window expires (exactly 1 hour after it started)</li>
        <li>All GitHub Actions API calls count toward this limit</li>
      </ul>

      <p><strong>How does this extension track usage?</strong></p>
      <ul>
        <li>Every API response includes rate limit headers</li>
        <li>The extension displays remaining requests and usage percentage</li>
        <li>Shows "Unknown" until the first API call is made in the current session</li>
      </ul>

      <p><strong>What happens when limits are approached?</strong></p>
      <ul>
        <li>At <strong>50% usage</strong>: Info notification with suggestions to reduce refresh frequency</li>
        <li>At <strong>75% usage</strong>: Warning notification urging action</li>
        <li>At <strong>90% usage</strong>: Protection mode activates, auto-throttling refresh intervals</li>
      </ul>

      <p><strong>Why is rate limit protection important?</strong></p>
      <ul>
        <li>Prevents hitting the hard limit (which causes all requests to fail for the remainder of the hour)</li>
        <li>Ensures you can continue using GitHub APIs for other activities</li>
        <li>Automatically backs off when usage is high, then resumes normal operation</li>
      </ul>

      <p><strong>How does adaptive refresh affect API usage?</strong></p>
      <ul>
        <li>5-second intervals: ~720 requests/hour (~14% of quota)</li>
        <li>10-second intervals: ~360 requests/hour (~7% of quota)</li>
        <li>30-second intervals: ~120 requests/hour (~2% of quota)</li>
        <li>Adaptive refresh only uses fast polling when needed, reducing overall usage</li>
      </ul>
    `;
    showHelpModal = true;
  }

  // ============================================================================
  // Panel Health Monitoring System
  // ============================================================================

  /**
   * Start the health monitoring system.
   * Runs a check every HEALTH_CHECK_INTERVAL_MS to detect unresponsive states.
   */
  function startHealthMonitoring() {
    stopHealthMonitoring(); // Clear any existing interval

    healthCheckInterval = window.setInterval(() => {
      checkPanelHealth();
    }, HEALTH_CHECK_INTERVAL_MS);

    console.log('[WorkflowRuns] Health monitoring started');
  }

  /**
   * Stop the health monitoring system.
   */
  function stopHealthMonitoring() {
    if (healthCheckInterval !== null) {
      window.clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  }

  /**
   * Record user activity/interaction with the panel.
   * This is used to suppress health notifications when user is actively using the panel.
   * Activity includes: clicking runs, changing filters, scrolling, expanding sections, etc.
   */
  function recordUserActivity() {
    lastUserActivity = Date.now();
    // If there's an active unresponsive state, clear it since user is actively engaged
    if (panelUnresponsive && !loading && !refreshing && !fetchingDateFilteredRuns) {
      clearUnresponsiveState();
    }
  }

  /**
   * Check if user has been recently active (within grace period).
   * Used to suppress health notifications when user is actively using the panel.
   */
  function isUserRecentlyActive(): boolean {
    return Date.now() - lastUserActivity < USER_ACTIVITY_GRACE_PERIOD_MS;
  }

  /**
   * Check if user recently took action from health modal (within extended cooldown).
   * After user clicks action buttons or dismisses, give extended time before showing again.
   */
  function isInUserActionCooldown(): boolean {
    return Date.now() - lastUserActionFromModal < USER_ACTION_COOLDOWN_MS;
  }

  /**
   * Check if a specific health issue type is in cooldown.
   * Uses granular per-issue-type cooldowns to allow different health
   * problems to be reported independently.
   */
  function isHealthIssueCoolingDown(issueType: HealthIssueType): boolean {
    const now = Date.now();
    return now - healthNotificationCooldowns[issueType] < HEALTH_NOTIFICATION_COOLDOWN_MS;
  }

  /**
   * Check panel health and detect unresponsive states.
   * Called periodically by the health monitoring timer.
   * Uses granular cooldowns to allow different health issues to be reported independently.
   * Considers user activity and extended cooldowns from modal actions.
   */
  function checkPanelHealth() {
    const now = Date.now();

    // Skip health checks if user is in extended cooldown from modal action
    if (isInUserActionCooldown()) {
      return;
    }

    // Skip health checks if user has been recently active
    // This prevents annoying the user when they're actively using the panel
    if (isUserRecentlyActive()) {
      return;
    }

    // Check for stuck loading state (> 60 seconds)
    if (loading && loadingStartTime !== null && !isHealthIssueCoolingDown('loading')) {
      const loadingDuration = now - loadingStartTime;
      if (loadingDuration > LOADING_TIMEOUT_MS) {
        setUnresponsiveState(
          `Loading state has been active for ${Math.round(loadingDuration / 1000)} seconds`,
          'loading'
        );
        return;
      }
    }

    // Check for stuck refreshing state (> 45 seconds)
    if (refreshing && refreshingStartTime !== null && !isHealthIssueCoolingDown('refreshing')) {
      const refreshingDuration = now - refreshingStartTime;
      if (refreshingDuration > REFRESHING_TIMEOUT_MS) {
        setUnresponsiveState(
          `Refresh operation has been running for ${Math.round(refreshingDuration / 1000)} seconds`,
          'refreshing'
        );
        return;
      }
    }

    // Check for stuck date filter fetch (> 90 seconds)
    if (
      fetchingDateFilteredRuns &&
      dateFilterStartTime !== null &&
      !isHealthIssueCoolingDown('dateFilter')
    ) {
      const dateFilterDuration = now - dateFilterStartTime;
      if (dateFilterDuration > DATE_FILTER_TIMEOUT_MS) {
        setUnresponsiveState(
          `Date filter fetch has been running for ${Math.round(dateFilterDuration / 1000)} seconds`,
          'dateFilter'
        );
        return;
      }
    }

    // Check for no API responses during active usage (> 5 minutes)
    // Only check if auto-refresh is enabled and we're not in a loading state
    if (
      autoRefreshSeconds > 0 &&
      !loading &&
      !refreshing &&
      now - lastSuccessfulApiResponse > API_RESPONSE_TIMEOUT_MS &&
      !isHealthIssueCoolingDown('apiResponse')
    ) {
      const minutesSinceResponse = Math.round((now - lastSuccessfulApiResponse) / 60000);
      setUnresponsiveState(
        `No API responses received in the last ${minutesSinceResponse} minutes`,
        'apiResponse'
      );
      return;
    }

    // Check if auto-refresh has stopped unexpectedly
    // Only check if auto-refresh should be running but hasn't triggered
    if (
      autoRefreshSeconds > 0 &&
      refreshInterval !== null &&
      lastAutoRefreshTime !== null &&
      expectedNextAutoRefresh !== null &&
      !isHealthIssueCoolingDown('autoRefresh')
    ) {
      // Allow some grace period (2x the expected interval) before flagging
      const gracePeriod = autoRefreshSeconds * 2000;
      if (now > expectedNextAutoRefresh + gracePeriod) {
        const missedSeconds = Math.round((now - expectedNextAutoRefresh) / 1000);
        setUnresponsiveState(
          `Auto-refresh appears to have stopped (${missedSeconds}s overdue)`,
          'autoRefresh'
        );
        return;
      }
    }

    // If we got here, panel is healthy - clear any previous unresponsive state
    if (panelUnresponsive && !healthNotificationDismissed) {
      clearUnresponsiveState();
    }
  }

  /**
   * Set the panel as unresponsive and show notification.
   * Records the issue type for granular cooldown tracking.
   *
   * @param reason - Human-readable description of the issue
   * @param issueType - Category of health issue for cooldown tracking
   */
  function setUnresponsiveState(reason: string, issueType: HealthIssueType) {
    if (panelUnresponsive && healthNotificationDismissed) {
      // User dismissed the notification, don't show again for same issue
      return;
    }

    panelUnresponsive = true;
    unresponsiveReason = reason;
    currentHealthIssueType = issueType;
    healthNotificationCooldowns[issueType] = Date.now();
    healthNotificationDismissed = false;

    console.warn('[WorkflowRuns] Panel unresponsive detected:', {
      reason,
      issueType,
      loading,
      refreshing,
      fetchingDateFilteredRuns,
      loadingStartTime,
      refreshingStartTime,
      dateFilterStartTime,
      lastSuccessfulApiResponse,
      autoRefreshSeconds,
      refreshInterval,
    });
  }

  /**
   * Clear the unresponsive state.
   */
  function clearUnresponsiveState() {
    panelUnresponsive = false;
    unresponsiveReason = null;
    currentHealthIssueType = null;
    healthNotificationDismissed = false;
  }

  /**
   * Record timestamp when loading state starts.
   * Called when loading is set to true.
   */
  function recordLoadingStart() {
    if (!loadingStartTime) {
      loadingStartTime = Date.now();
    }
  }

  /**
   * Clear loading timestamp when loading completes.
   * Called when loading is set to false.
   */
  function recordLoadingEnd() {
    loadingStartTime = null;
    // Also record successful API response
    recordSuccessfulApiResponse();
  }

  /**
   * Record timestamp when refreshing state starts.
   */
  function recordRefreshingStart() {
    if (!refreshingStartTime) {
      refreshingStartTime = Date.now();
    }
  }

  /**
   * Clear refreshing timestamp when refresh completes.
   */
  function recordRefreshingEnd() {
    refreshingStartTime = null;
    recordSuccessfulApiResponse();
  }

  /**
   * Record timestamp when date filter fetch starts.
   */
  function recordDateFilterStart() {
    if (!dateFilterStartTime) {
      dateFilterStartTime = Date.now();
    }
  }

  /**
   * Clear date filter timestamp when fetch completes.
   */
  function recordDateFilterEnd() {
    dateFilterStartTime = null;
    recordSuccessfulApiResponse();
  }

  /**
   * Record a successful API response.
   * Updates the timestamp used for API response timeout detection.
   */
  function recordSuccessfulApiResponse() {
    lastSuccessfulApiResponse = Date.now();
    // Clear unresponsive state if we're receiving responses again
    if (panelUnresponsive && !loading && !refreshing && !fetchingDateFilteredRuns) {
      clearUnresponsiveState();
    }
  }

  /**
   * Record auto-refresh execution and calculate expected next refresh.
   */
  function recordAutoRefreshExecution() {
    const now = Date.now();
    lastAutoRefreshTime = now;
    const effectiveInterval = getEffectiveRefreshInterval();
    expectedNextAutoRefresh = now + effectiveInterval * 1000;
  }

  // ============================================================================
  // Panel Health Recovery Functions
  // ============================================================================

  /**
   * Reset panel state - clears all loading flags and resets to idle state.
   * This is a recovery action for when the panel gets stuck in a loading state.
   */
  function resetPanelState() {
    console.log('[WorkflowRuns] Resetting panel state...');

    // Record user action from modal for extended cooldown
    lastUserActionFromModal = Date.now();
    recordUserActivity();

    // Clear all loading flags
    loading = false;
    refreshing = false;
    fetchingDateFilteredRuns = false;
    loadingMore = false;
    progressiveFetching = false;

    // Clear timestamps
    loadingStartTime = null;
    refreshingStartTime = null;
    dateFilterStartTime = null;

    // Clear any pending operations
    cancelPendingOperations();

    // Reset generation counters to prevent stale responses from affecting UI
    workflowSwitchGeneration++;
    filterChangeGeneration++;

    // Clear unresponsive state
    clearUnresponsiveState();

    // Record this as a successful recovery (resets API response timestamp)
    lastSuccessfulApiResponse = Date.now();

    showToast('Panel state has been reset', 'info', 3000);

    console.log('[WorkflowRuns] Panel state reset complete');
  }

  /**
   * Force a complete data refresh from the GitHub API.
   * This re-fetches all workflow runs and resets the UI state.
   */
  function forceDataRefresh() {
    console.log('[WorkflowRuns] Forcing complete data refresh...');

    // First reset the panel state
    resetPanelState();

    // Then trigger a full refresh
    loading = true;
    recordLoadingStart();

    // Request fresh data from the backend
    vscode.postMessage({
      type: 'getWorkflowRuns',
      data: {
        workflow: workflowFilter === 'all' ? undefined : workflowFilter,
        per_page: workflowLoadLimit,
        page: 1,
        actor: actorFilter === 'all' || actorFilter === 'me' ? undefined : actorFilter,
        includeBotRuns: showBotRuns,
      },
    });

    showToast('Refreshing data from GitHub...', 'info', 3000);

    console.log('[WorkflowRuns] Data refresh request sent');
  }

  /**
   * Restart the auto-refresh timer.
   * This is a recovery action when auto-refresh appears to have stopped.
   */
  function restartAutoRefresh() {
    console.log('[WorkflowRuns] Restarting auto-refresh...');

    // Record user action from modal for extended cooldown
    lastUserActionFromModal = Date.now();
    recordUserActivity();

    // Clear unresponsive state
    clearUnresponsiveState();

    // Update the auto-refresh cooldown specifically to prevent the health check
    // from immediately re-triggering the modal after restart. Without this,
    // the next health check (in ~20s) would see that auto-refresh tracking
    // variables are reset and potentially show the modal again.
    // Using granular cooldown allows other health issues to still be detected.
    healthNotificationCooldowns.autoRefresh = Date.now();

    // Reset tracking timestamps BEFORE restarting so the health check
    // doesn't see stale "overdue" values
    lastAutoRefreshTime = null;
    expectedNextAutoRefresh = null;

    // Restart the auto-refresh timer
    startAutoRefresh();

    showToast(`Auto-refresh restarted (${autoRefreshSeconds}s interval)`, 'info', 3000);

    console.log('[WorkflowRuns] Auto-refresh restarted');
  }

  /**
   * Dismiss the health notification without taking recovery action.
   * Sets extended cooldown to prevent notification from reappearing too soon.
   */
  function dismissHealthNotification() {
    console.log('[WorkflowRuns] Health notification dismissed by user');

    // Record user action from modal for extended cooldown
    lastUserActionFromModal = Date.now();
    recordUserActivity();

    healthNotificationDismissed = true;
    // Keep panelUnresponsive = true so we don't auto-clear immediately
    // The notification will auto-clear when the underlying issue resolves
  }

  /**
   * Update the max number of workflow runs shown per page and notify the extension host.
   *
   * This only affects client-side pagination; the backend page size is
   * controlled separately via configuration. When the page size changes we
   * reset the current page so the user always lands on a valid slice of
   * filtered results.
   */
  function updateWorkflowLoadLimit(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    workflowLoadLimit = limit;
    workflowLoadLimitIndex = getWorkflowLoadLimitIndex(limit);
    currentPage = 1;

    // Re-render the current slice using the new page size without touching
    // the cached runs or active filters.
    filterRuns();

    vscode.postMessage({
      type: 'updateWorkflowLoadLimit',
      data: { limit },
    });
  }

  function handleWorkflowLoadLimitSliderChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    const index = Number(target.value);
    if (!Number.isFinite(index)) {
      return;
    }

    const clampedIndex = Math.min(
      Math.max(Math.trunc(index), 0),
      WORKFLOW_LOAD_LIMIT_OPTIONS.length - 1
    );
    const nextLimit = WORKFLOW_LOAD_LIMIT_OPTIONS[clampedIndex];
    if (!nextLimit || nextLimit === workflowLoadLimit) {
      workflowLoadLimitIndex = clampedIndex;
      return;
    }

    workflowLoadLimitIndex = clampedIndex;
    updateWorkflowLoadLimit(nextLimit);
  }

  /**
   * Handle changes to the "From" date/time filter input and re-filter runs.
   */
  function handleDateFilterChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    dateFilterFrom = target?.value ?? '';

    // Changing the date range invalidates the current pagination window.
    currentPage = 1;

    // When the date filter changes, clear cached runs so we can fetch
    // the correct range from the extension host, then notify the host.
    clearCache();
    filterRuns();

    // Reset any previous truncation state; the new date range will
    // compute its own truncation flag when results arrive.
    dateFilterTruncated = false;

    // Show a small fetching indicator while the backend loads the
    // date-filtered runs. This will be cleared when the next
    // getWorkflowRuns payload arrives.
    fetchingDateFilteredRuns = !!dateFilterFrom || !!dateFilterTo;

    vscode.postMessage({
      type: 'updateDateFilter',
      data: { from: dateFilterFrom, to: dateFilterTo },
    });
  }

  /**
   * Handle changes to the "To" date/time filter input and re-filter runs.
   */
  function handleDateFilterToChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    dateFilterTo = target?.value ?? '';

    // Changing the date range invalidates the current pagination window.
    currentPage = 1;

    clearCache();
    filterRuns();

    // Reset any previous truncation state; the new date range will
    // compute its own truncation flag when results arrive.
    dateFilterTruncated = false;

    fetchingDateFilteredRuns = !!dateFilterFrom || !!dateFilterTo;

    vscode.postMessage({
      type: 'updateDateFilter',
      data: { from: dateFilterFrom, to: dateFilterTo },
    });
  }

  /**
   * Clear the "From" date/time filter only.
   */
  function clearDateFilterFrom() {
    if (!dateFilterFrom) {
      return;
    }
    dateFilterFrom = '';

    // Reset pagination when the date filter changes.
    currentPage = 1;

    clearCache();
    filterRuns();

    // Update fetching indicator based on remaining filter state.
    fetchingDateFilteredRuns = !!dateFilterTo;
    dateFilterTruncated = false;

    vscode.postMessage({
      type: 'updateDateFilter',
      data: { from: '', to: dateFilterTo },
    });
  }

  /**
   * Clear the "To" date/time filter only.
   */
  function clearDateFilterTo() {
    if (!dateFilterTo) {
      return;
    }
    dateFilterTo = '';

    // Reset pagination when the date filter changes.
    currentPage = 1;

    clearCache();
    filterRuns();

    // Update fetching indicator based on remaining filter state.
    fetchingDateFilteredRuns = !!dateFilterFrom;
    dateFilterTruncated = false;

    vscode.postMessage({
      type: 'updateDateFilter',
      data: { from: dateFilterFrom, to: '' },
    });
  }

  /**
   * Clear the date/time filter (both "From" and "To").
   */
  function clearDateFilter() {
    if (!dateFilterFrom && !dateFilterTo) {
      return;
    }
    dateFilterFrom = '';
    dateFilterTo = '';

    // Reset pagination when the date filter is cleared so the first
    // page of unfiltered results is shown.
    currentPage = 1;

    clearCache();
    filterRuns();

    // No active date filter, so we don't need the fetching indicator here.
    fetchingDateFilteredRuns = false;
    dateFilterTruncated = false;

    vscode.postMessage({
      type: 'updateDateFilter',
      data: { from: '', to: '' },
    });
  }

  /**
   * Check if there are more runs to load from GitHub.
   */
  function hasMoreRuns(): boolean {
    return runs.length < totalCount;
  }

  /**
   * Determine whether a date filter is currently active.
   */
  function hasActiveDateFilter(): boolean {
    return !!(dateFilterFrom || dateFilterTo);
  }

  /**
   * Map a max-total-runs value onto the slider index used by the UI.
   */
  function getMaxTotalRunsOptionIndex(value: number | null | undefined): number {
    const safeValue =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_MAX_TOTAL_RUNS;
    const foundIndex = MAX_TOTAL_RUNS_OPTIONS.indexOf(safeValue);
    if (foundIndex !== -1) {
      return foundIndex;
    }
    const fallbackIndex = MAX_TOTAL_RUNS_OPTIONS.indexOf(DEFAULT_MAX_TOTAL_RUNS);
    return fallbackIndex >= 0 ? fallbackIndex : 0;
  }

  /**
   * Map the auto-refresh interval value onto the slider index used by the UI.
   * Uses AUTO_REFRESH_SLIDER_OPTIONS which excludes 0 (Off).
   * When value is 0 (Off), returns the index of the previousAutoRefreshSeconds.
   */
  function getAutoRefreshOptionIndex(value: number | null | undefined): number {
    // If value is 0 or invalid, use previous or default interval for slider position
    const safeValue =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : previousAutoRefreshSeconds > 0
          ? previousAutoRefreshSeconds
          : DEFAULT_AUTO_REFRESH_SECONDS;

    const foundIndex = AUTO_REFRESH_SLIDER_OPTIONS.indexOf(safeValue);
    if (foundIndex !== -1) {
      return foundIndex;
    }

    // Find the closest option
    const fallbackIndex = AUTO_REFRESH_SLIDER_OPTIONS.indexOf(DEFAULT_AUTO_REFRESH_SECONDS);
    return fallbackIndex >= 0 ? fallbackIndex : 1; // Default to 30s (index 1) if not found
  }

  /**
   * Map the workflow load limit value onto the slider index used by the UI.
   */
  function getWorkflowLoadLimitIndex(value: number | null | undefined): number {
    const safeValue =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_WORKFLOW_LOAD_LIMIT;
    const foundIndex = WORKFLOW_LOAD_LIMIT_OPTIONS.indexOf(safeValue);
    if (foundIndex !== -1) {
      return foundIndex;
    }
    const fallbackIndex = WORKFLOW_LOAD_LIMIT_OPTIONS.indexOf(DEFAULT_WORKFLOW_LOAD_LIMIT);
    return fallbackIndex >= 0 ? fallbackIndex : 0;
  }

  /**
   * Format the auto-refresh interval for human-readable display.
   * Always shows the user's configured interval to match the slider position.
   */
  function formatAutoRefreshLabel(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return 'Off';
    }

    // Format based on user's configured interval (not the effective adaptive interval)
    if (seconds < 60) {
      return `${seconds}s`;
    }

    switch (seconds) {
      case 60:
        return '1m';
      case 90:
        return '1m 30s';
      case 120:
        return '2m';
      case 180:
        return '3m';
      default:
        return `${seconds}s`;
    }
  }

  /**
   * Get the maximum number of runs we are willing to progressively fetch for
   * the current context.
   *
   * - With a date filter: cap at DATE_FILTER_MAX_TOTAL_RUNS to keep the
   *   range-bounded behaviour and date truncation messaging.
   * - Without a date filter: cap at NON_DATE_MAX_TOTAL_RUNS so users can
   *   search further back in history before we ask them to apply a date range.
   */
  function getMaxTotalRuns(): number {
    return hasActiveDateFilter() ? DATE_FILTER_MAX_TOTAL_RUNS : NON_DATE_MAX_TOTAL_RUNS;
  }

  /**
   * Determine whether the "max runs reached" warning should be displayed.
   *
   * The warning informs users they may have hit the configured maximum and
   * potentially be missing runs due to hitting the fetch limit.
   *
   * Logic:
   * - Show warning when we've fetched the maximum allowed runs AND there are
   *   still more runs available on the server (totalCount > fetchedCount)
   * - The warning is shown regardless of current filter state because users
   *   filtering by "My Runs", specific workflows, etc. may be missing runs
   *   that match their criteria but weren't fetched due to hitting the limit
   *
   * @param _filteredCount - Number of runs after applying filters (kept for API compatibility)
   * @param _loadedCount - Total number of runs loaded in memory (kept for API compatibility)
   * @param fetchedCount - Total runs fetched from API
   */
  function shouldShowMaxRunsWarning(
    _filteredCount: number,
    _loadedCount: number,
    fetchedCount: number
  ): boolean {
    // Validate fetchedCount
    if (!Number.isFinite(fetchedCount) || fetchedCount <= 0) {
      return false;
    }

    // Get the effective max runs limit based on whether date filter is active
    const effectiveMaxRuns = getMaxTotalRuns();

    // Show warning if we've hit the fetch limit AND there are more runs on the server
    // This means there could be runs matching the user's filters that weren't fetched
    const hitFetchLimit = fetchedCount >= effectiveMaxRuns;
    const moreRunsExist = totalCount > fetchedCount;

    return hitFetchLimit && moreRunsExist;
  }

  /**
   * Update the non-date (no date filter) maximum total run cap and persist it.
   * If the new limit is higher than totalRunsFetched and we have a paused page,
   * resume progressive fetching.
   */
  function updateNonDateMaxTotalRuns(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    NON_DATE_MAX_TOTAL_RUNS = limit;
    nonDateMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(limit);

    vscode.postMessage({
      type: 'updateWorkflowRunsTotalLimits',
      data: {
        nonDateMaxTotalRuns: limit,
      },
    });

    // If we're not in date filter mode, check if we can resume fetching
    if (!hasActiveDateFilter()) {
      resumeProgressiveFetchingIfNeeded();
    }
  }

  /**
   * Update the date-filtered maximum total run cap and persist it.
   * If the new limit is higher than totalRunsFetched and we have a paused page,
   * resume progressive fetching.
   */
  function updateDateFilterMaxTotalRuns(limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    DATE_FILTER_MAX_TOTAL_RUNS = limit;
    dateFilterMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(limit);

    vscode.postMessage({
      type: 'updateWorkflowRunsTotalLimits',
      data: {
        dateFilterMaxTotalRuns: limit,
      },
    });

    // If we're in date filter mode, check if we can resume fetching
    if (hasActiveDateFilter()) {
      resumeProgressiveFetchingIfNeeded();
    }
  }

  /**
   * Check if progressive fetching was paused due to hitting the limit and can
   * now resume because the limit was increased. If so, restore nextBackendPage
   * from pausedBackendPage and trigger progressive fetching.
   */
  function resumeProgressiveFetchingIfNeeded() {
    // If we have a paused page and the new limit allows more fetching, resume
    if (pausedBackendPage !== null && totalRunsFetched < getMaxTotalRuns() && hasMoreRuns()) {
      // Restore the paused page so progressive fetching can continue
      nextBackendPage = pausedBackendPage;
      pausedBackendPage = null;
      // Clear the truncation flag since we're resuming
      dateFilterTruncated = false;
    }
    scheduleProgressiveFetchIfNeeded();
  }

  function handleNonDateMaxTotalRunsSliderChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    const index = Number(target.value);
    if (!Number.isFinite(index)) {
      return;
    }

    const clampedIndex = Math.min(
      Math.max(Math.trunc(index), 0),
      MAX_TOTAL_RUNS_OPTIONS.length - 1
    );
    const nextLimit = MAX_TOTAL_RUNS_OPTIONS[clampedIndex];
    if (!nextLimit || nextLimit === NON_DATE_MAX_TOTAL_RUNS) {
      nonDateMaxTotalRunsIndex = clampedIndex;
      return;
    }

    updateNonDateMaxTotalRuns(nextLimit);
  }

  function handleDateFilterMaxTotalRunsSliderChange(event: Event) {
    const target = event.target as HTMLInputElement | null;
    if (!target) {
      return;
    }

    const index = Number(target.value);
    if (!Number.isFinite(index)) {
      return;
    }

    const clampedIndex = Math.min(
      Math.max(Math.trunc(index), 0),
      MAX_TOTAL_RUNS_OPTIONS.length - 1
    );
    const nextLimit = MAX_TOTAL_RUNS_OPTIONS[clampedIndex];
    if (!nextLimit || nextLimit === DATE_FILTER_MAX_TOTAL_RUNS) {
      dateFilterMaxTotalRunsIndex = clampedIndex;
      return;
    }

    updateDateFilterMaxTotalRuns(nextLimit);
  }

  /**
   * Progressive fetch runs to reach the desired page size after filtering.
   * This is called when client-side filtering reduces the visible runs below
   * the workflowLoadLimit and there are more runs available to fetch.
   */
  async function progressiveFetch() {
    if (progressiveFetching || !nextBackendPage || totalRunsFetched >= getMaxTotalRuns()) {
      return;
    }

    progressiveFetching = true;

    // Calculate how many pages to fetch.
    //
    // With an active date filter, we keep the existing behaviour of scanning
    // up to DATE_FILTER_MAX_TOTAL_RUNS runs in the background so the selected
    // date range is well-covered.
    //
    // Without a date filter, we only ever prefetch a single additional page
    // at a time. This ensures the UI shows incremental progress updates
    // (100, 200, 300, etc.) rather than jumping by large amounts, which
    // provides better user feedback during searches.
    const hasDateFilter = hasActiveDateFilter();
    const pagesToFetch = hasDateFilter
      ? Math.min(10, Math.ceil((DATE_FILTER_MAX_TOTAL_RUNS - totalRunsFetched) / 100))
      : 1;

    vscode.postMessage({
      type: 'progressiveFetchRuns',
      data: {
        startPage: nextBackendPage,
        maxPages: pagesToFetch,
        // Include generation so we can detect stale responses
        generation: workflowSwitchGeneration,
      },
    });
  }

  /**
   * Toggle expansion of the "Applied Filters" summary section.
   * Marks userManuallyToggledFilters=true so auto-collapse respects user's choice.
   */
  function toggleFiltersExpanded() {
    recordUserActivity();
    filtersExpanded = !filtersExpanded;
    userManuallyToggledFilters = true;
  }

  /**
   * Toggle run expansion to show/hide jobs
   * Closes other sections (Graph, Artifacts, Summary) when opening
   */
  function toggleRunExpansion(runId: number) {
    recordUserActivity();
    if (expandedRuns.has(runId)) {
      expandedRuns.delete(runId);
      expandedRuns = expandedRuns; // Trigger reactivity
    } else {
      // When opening jobs, close other sections so that
      // only one section (Graph, Jobs, Artifacts, or Summary) is expanded at a time.
      if (showDependencyGraph.has(runId)) {
        showDependencyGraph.delete(runId);
        showDependencyGraph = showDependencyGraph; // Trigger reactivity
      }
      if (showArtifacts.has(runId)) {
        showArtifacts.delete(runId);
        showArtifacts = showArtifacts; // Trigger reactivity
      }
      if (showSummary.has(runId)) {
        showSummary.delete(runId);
        showSummary = showSummary; // Trigger reactivity
      }

      expandedRuns.add(runId);
      expandedRuns = expandedRuns; // Trigger reactivity

      // Fetch jobs if not already loaded
      if (!runJobs.has(runId) && !loadingJobs.has(runId)) {
        loadingJobs.add(runId);

        loadingJobs = loadingJobs; // Trigger reactivity
        vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId } });
      }
    }
  }

  /**
   * Toggle job dependency graph visibility
   * Fetches job definitions from workflow YAML if not already loaded
   * Closes other sections (Jobs, Artifacts, Summary) when opening
   */
  function toggleDependencyGraph(run: WorkflowRun) {
    recordUserActivity();
    const runId = run.id;

    if (showDependencyGraph.has(runId)) {
      showDependencyGraph.delete(runId);
      showDependencyGraph = showDependencyGraph; // Trigger reactivity
    } else {
      // Close other sections when opening graph
      if (expandedRuns.has(runId)) {
        expandedRuns.delete(runId);
        expandedRuns = expandedRuns; // Trigger reactivity
      }
      if (showArtifacts.has(runId)) {
        showArtifacts.delete(runId);
        showArtifacts = showArtifacts; // Trigger reactivity
      }
      if (showSummary.has(runId)) {
        showSummary.delete(runId);
        showSummary = showSummary; // Trigger reactivity
      }

      showDependencyGraph.add(runId);
      showDependencyGraph = showDependencyGraph; // Trigger reactivity

      // Fetch job dependencies if not already loaded
      if (!runJobDefinitions.has(runId) && !loadingJobDependencies.has(runId)) {
        loadingJobDependencies.add(runId);
        loadingJobDependencies = loadingJobDependencies; // Trigger reactivity

        // Extract workflow path from run.path (format: ".github/workflows/filename.yml")
        const workflowPath = run.path?.split('@')[0] || '';

        vscode.postMessage({
          type: 'getJobDependencies',
          data: { runId, workflowPath },
        });

        // Also fetch jobs if not already loaded
        if (!runJobs.has(runId) && !loadingJobs.has(runId)) {
          loadingJobs.add(runId);
          loadingJobs = loadingJobs; // Trigger reactivity
          vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId } });
        }
      }
    }
  }

  /**
   * Handle click on a job node in the dependency graph
   * Opens the interactive job logs viewer
   */
  function handleGraphJobClick(node: JobGraphNode, runId: number) {
    if (node.jobId) {
      viewJobLogsInteractive(node.jobId, node.name, runId);
    }
  }

  /**
   * View job logs in interactive webview with collapsible groups
   */
  function viewJobLogsInteractive(jobId: number, jobName: string, runId: number) {
    // Track loading state
    loadingJobLogs.add(jobId);
    loadingJobLogs = loadingJobLogs; // Trigger reactivity

    // Pause auto-refresh briefly
    autoRefreshPaused = true;
    stopAutoRefresh();
    window.setTimeout(() => {
      autoRefreshPaused = false;
      if (autoRefreshSeconds > 0) {
        startAutoRefresh();
      }
    }, 30_000);

    vscode.postMessage({
      type: 'viewJobLogsInteractive',
      data: { jobId, jobName, runId },
    });
  }

  /**
   * View raw job logs in text editor (plain text)
   */
  function viewRawJobLogs(jobId: number, jobName: string, runId: number) {
    // Track loading state for raw logs button
    loadingRawJobLogs.add(jobId);
    loadingRawJobLogs = loadingRawJobLogs; // Trigger reactivity

    // Pause auto-refresh briefly to avoid disruptive refresh when a new tab opens
    autoRefreshPaused = true;
    stopAutoRefresh();
    window.setTimeout(() => {
      autoRefreshPaused = false;
      if (autoRefreshSeconds > 0) {
        startAutoRefresh();
      }
    }, 30_000);

    vscode.postMessage({
      type: 'viewJobLogs',
      data: { jobId, jobName, runId },
    });
  }

  /**
   * View logs for a specific step within a job
   */
  function viewStepLogs(
    jobId: number,
    jobName: string,
    runId: number,
    stepNumber: number,
    stepName: string
  ) {
    // Track loading state
    const key = `${jobId}-${stepNumber}`;
    loadingStepLogs.set(key, true);
    loadingStepLogs = loadingStepLogs; // Trigger reactivity

    // Pause auto-refresh briefly to avoid disruptive refresh when a new tab opens
    autoRefreshPaused = true;
    stopAutoRefresh();
    window.setTimeout(() => {
      autoRefreshPaused = false;
      if (autoRefreshSeconds > 0) {
        startAutoRefresh();
      }
    }, 30_000);

    vscode.postMessage({
      type: 'viewStepLogs',
      data: { jobId, jobName, runId, stepNumber, stepName },
    });
  }

  /**
   * Get loading state for a specific step's logs
   */
  function getStepLogsLoadingSet(jobId: number | undefined): Set<number> {
    if (jobId === undefined) {
      return new Set();
    }
    const result = new Set<number>();
    loadingStepLogs.forEach((_, key) => {
      const [keyJobId, stepNum] = key.split('-').map(Number);
      if (keyJobId === jobId) {
        result.add(stepNum);
      }
    });
    return result;
  }

  /**
   * Start log comparison mode by selecting a job as the comparison source
   */
  function startLogComparison(
    jobId: number,
    jobName: string,
    runId: number,
    workflowId: number,
    workflowName: string
  ) {
    compareSourceJob = { jobId, jobName, runId, workflowId, workflowName };
  }

  /**
   * Clear comparison mode
   */
  function clearComparisonMode() {
    compareSourceJob = null;
  }

  /**
   * Check if a job can be compared with the current comparison source
   * Jobs can only be compared if they have the same job name AND workflow name
   */
  function canCompareWithJob(jobName: string, workflowId: number): boolean {
    if (!compareSourceJob) return false;
    return compareSourceJob.jobName === jobName && compareSourceJob.workflowId === workflowId;
  }

  /**
   * Complete log comparison by selecting the target job
   * Sends request to backend to fetch and diff the logs
   */
  function compareWithJob(targetJobId: number, targetJobName: string, targetRunId: number) {
    if (!compareSourceJob) {
      return;
    }

    loadingComparison = true;

    vscode.postMessage({
      type: 'compareJobLogs',
      data: {
        sourceJobId: compareSourceJob.jobId,
        sourceJobName: compareSourceJob.jobName,
        sourceRunId: compareSourceJob.runId,
        targetJobId,
        targetJobName,
        targetRunId,
      },
    });

    // Clear comparison mode after initiating
    compareSourceJob = null;
  }

  /**
   * Check if a job is the current comparison source
   */
  function isCompareSource(jobId: number): boolean {
    return compareSourceJob?.jobId === jobId;
  }

  /**
   * Handle step comparison - either set source, cancel, or compare with target
   */
  function handleStepComparison(
    stepNumber: number,
    stepName: string,
    jobId: number,
    jobName: string,
    runId: number,
    workflowId: number,
    workflowName: string
  ) {
    if (compareSourceStep === null) {
      // Set this step as the comparison source
      compareSourceStep = { stepNumber, stepName, jobId, jobName, runId, workflowId, workflowName };
    } else if (
      compareSourceStep.stepNumber === stepNumber &&
      compareSourceStep.jobId === jobId &&
      compareSourceStep.runId === runId
    ) {
      // Clicking on the same source step - cancel comparison mode
      compareSourceStep = null;
    } else {
      // Compare with this step as the target
      loadingStepComparison = true;

      vscode.postMessage({
        type: 'compareStepLogs',
        data: {
          sourceJobId: compareSourceStep.jobId,
          sourceJobName: compareSourceStep.jobName,
          sourceRunId: compareSourceStep.runId,
          sourceStepNumber: compareSourceStep.stepNumber,
          sourceStepName: compareSourceStep.stepName,
          targetJobId: jobId,
          targetJobName: jobName,
          targetRunId: runId,
          targetStepNumber: stepNumber,
          targetStepName: stepName,
        },
      });

      // Clear comparison mode after initiating
      compareSourceStep = null;
    }
  }

  /**
   * Check if a step can be compared with the current comparison source
   * Steps can only be compared if they have the same step name, job name, AND workflow
   */
  function canCompareWithStep(stepName: string, jobName: string, workflowId: number): boolean {
    if (!compareSourceStep) return false;
    return (
      compareSourceStep.stepName === stepName &&
      compareSourceStep.jobName === jobName &&
      compareSourceStep.workflowId === workflowId
    );
  }

  /**
   * Clear step comparison mode
   */
  function clearStepComparisonMode() {
    compareSourceStep = null;
  }

  /**
   * Open job steps modal from jobs list
   * Converts WorkflowJob to JobGraphNode format for the modal
   * For running jobs, fetches the latest steps from the API
   */
  function openJobStepsModal(
    job: WorkflowJob,
    runId: number,
    workflowId: number,
    workflowName: string
  ) {
    // Don't show steps for queued jobs (they haven't started yet)
    if (job.status === 'queued') {
      return;
    }

    // For completed jobs with steps, show immediately
    if (job.status === 'completed' && job.steps && job.steps.length > 0) {
      showJobStepsModalWithData(job, runId, workflowId, workflowName);
      return;
    }

    // For running jobs or jobs without steps data, fetch from API
    if (job.status === 'in_progress' || !job.steps || job.steps.length === 0) {
      loadingJobSteps.add(job.id);
      loadingJobSteps = loadingJobSteps; // Trigger reactivity

      // Set the runId and workflow info so the response handler knows which run this is for
      selectedJobRunIdForSteps = runId;
      selectedJobWorkflowIdForSteps = workflowId;
      selectedJobWorkflowNameForSteps = workflowName;

      vscode.postMessage({
        type: 'getJobDetails',
        data: { jobId: job.id, runId },
      });
      return;
    }

    // Fallback: show with available data
    showJobStepsModalWithData(job, runId, workflowId, workflowName);
  }

  /**
   * Helper to display job steps modal with job data
   * Converts WorkflowJob steps to JobNodeStep format with calculated durations
   */
  function showJobStepsModalWithData(
    job: WorkflowJob,
    runId: number,
    workflowId?: number,
    workflowName?: string
  ) {
    const duration =
      job.started_at && job.completed_at
        ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
        : job.started_at
          ? Date.now() - new Date(job.started_at).getTime()
          : undefined;

    // Convert WorkflowJob steps to JobNodeStep format with calculated durations
    const steps = (job.steps || []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      // Calculate duration: for completed steps use actual time, for running steps calculate from now
      duration:
        step.started_at && step.completed_at
          ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
          : step.started_at
            ? Date.now() - new Date(step.started_at).getTime()
            : undefined,
    }));

    selectedJobForStepsModal = {
      id: job.name,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion || undefined,
      position: { x: 0, y: 0 },
      dependencies: [],
      jobId: job.id,
      steps,
      duration,
    };
    selectedJobRunIdForSteps = runId;
    // Use provided workflow info or keep existing (for async responses)
    if (workflowId !== undefined) {
      selectedJobWorkflowIdForSteps = workflowId;
    }
    if (workflowName !== undefined) {
      selectedJobWorkflowNameForSteps = workflowName;
    }
  }

  /**
   * Close job steps modal
   */
  function closeJobStepsModal() {
    selectedJobForStepsModal = null;
    selectedJobRunIdForSteps = null;
    selectedJobWorkflowIdForSteps = null;
    selectedJobWorkflowNameForSteps = null;
  }

  /**
   * View job summary - fetches and displays summary from job logs.
   * Opens the GitHub summary modal or editor tab (when from steps modal) with content from a single job.
   * @param fromStepsModal - If true, opens summary in editor tab instead of modal
   */
  function viewJobSummary(
    jobId: number,
    jobName: string,
    runId?: number,
    fromStepsModal: boolean = false
  ) {
    // Set loading state
    loadingJobSummary.add(jobId);
    loadingJobSummary = loadingJobSummary;

    // Track if this request came from the steps modal
    jobSummaryFromStepsModal = fromStepsModal;

    // Request job summary from extension
    vscode.postMessage({
      type: 'getJobSummary',
      data: { jobId, jobName, runId },
    });
  }

  /**
   * Open job graph modal for a specific run
   */
  function openJobGraphModal(runId: number) {
    jobGraphModalRunId = runId;
    showJobGraphModal = true;
  }

  /**
   * Close job graph modal
   */
  function closeJobGraphModal() {
    showJobGraphModal = false;
    jobGraphModalRunId = null;
  }

  /**
   * Open GitHub summary page in browser for a specific run.
   * Note: GitHub API doesn't provide job summary content via REST API,
   * so this function opens the browser directly instead of using the modal.
   */
  function openGitHubSummaryInBrowser(runId: number) {
    const run = runs.find((r) => r.id === runId);
    if (run?.html_url) {
      vscode.postMessage({
        type: 'openInBrowser',
        data: { url: run.html_url },
      });
    }
  }

  /**
   * Open GitHub summary modal for a specific run.
   * Note: This modal is currently not used - the button opens browser directly.
   */
  function openGitHubSummaryModal(runId: number) {
    const run = runs.find((r) => r.id === runId);
    gitHubSummaryModalRunId = runId;
    gitHubSummaryContent = '';
    gitHubSummaryHtmlUrl = run?.html_url || '';
    gitHubSummaryError = '';
    gitHubSummaryLoading = true;
    showGitHubSummaryModal = true;

    // Request the GitHub summary from the extension
    vscode.postMessage({
      type: 'getGitHubSummary',
      data: { runId },
    });
  }

  /**
   * Close GitHub summary modal
   */
  function closeGitHubSummaryModal() {
    showGitHubSummaryModal = false;
    gitHubSummaryModalRunId = null;
    gitHubSummaryContent = '';
    gitHubSummaryMarkdown = '';
    gitHubSummaryHtmlUrl = '';
    gitHubSummaryError = '';
    gitHubSummaryLoading = false;
  }

  /**
   * Open GitHub summary in a new editor tab
   */
  function openGitHubSummaryInTab() {
    if (!gitHubSummaryContent) {
      return;
    }

    const run = gitHubSummaryModalRunId ? runs.find((r) => r.id === gitHubSummaryModalRunId) : null;
    vscode.postMessage({
      type: 'openGitHubSummaryInTab',
      data: {
        runId: gitHubSummaryModalRunId || 0,
        runName: run?.display_title || run?.name || 'Job Summary',
        markdownContent: gitHubSummaryMarkdown,
        htmlContent: gitHubSummaryContent, // Send HTML for the tab view
        htmlUrl: gitHubSummaryHtmlUrl,
      },
    });
  }

  /**
   * Open GitHub summary URL in browser (from modal)
   */
  function openGitHubSummaryInBrowserFromModal() {
    if (gitHubSummaryHtmlUrl) {
      vscode.postMessage({
        type: 'openInBrowser',
        data: { url: gitHubSummaryHtmlUrl },
      });
    }
  }

  /**
   * Get status codicon class for job
   */
  function getJobStatusCodicon(job: WorkflowJob): string {
    if (job.status === 'completed') {
      switch (job.conclusion) {
        case 'success':
          return 'codicon-pass';
        case 'failure':
          return 'codicon-error';
        case 'cancelled':
          return 'codicon-circle-slash';
        case 'skipped':
          return 'codicon-skip';
        default:
          return 'codicon-question';
      }
    } else if (job.status === 'in_progress') {
      return 'codicon-sync';
    } else if (job.status === 'queued') {
      return 'codicon-clock';
    }
    return 'codicon-question';
  }

  /**
   * Get status class for job
   */
  function getJobStatusClass(job: WorkflowJob): string {
    if (job.status === 'completed') {
      return job.conclusion || 'unknown';
    }
    return job.status;
  }

  /**
   * Toggle artifacts section
   */
  function toggleArtifacts(runId: number) {
    recordUserActivity();
    if (showArtifacts.has(runId)) {
      showArtifacts.delete(runId);
      showArtifacts = showArtifacts; // Trigger reactivity
    } else {
      // When opening artifacts, close jobs and summary for this run so that only
      // one section (Jobs, Artifacts, or Summary) is expanded at a time.
      if (expandedRuns.has(runId)) {
        expandedRuns.delete(runId);
        expandedRuns = expandedRuns; // Trigger reactivity
      }
      if (showSummary.has(runId)) {
        showSummary.delete(runId);
        showSummary = showSummary; // Trigger reactivity
      }

      showArtifacts.add(runId);
      showArtifacts = showArtifacts; // Trigger reactivity

      // Fetch artifacts if not already loaded
      if (!runArtifacts.has(runId) && !loadingArtifacts.has(runId)) {
        loadingArtifacts.add(runId);
        loadingArtifacts = loadingArtifacts; // Trigger reactivity
        vscode.postMessage({
          type: 'getWorkflowRunArtifacts',
          data: { runId },
        });
      }
    }
  }

  /**
   * Download artifact
   */
  function downloadArtifact(artifactId: number, artifactName: string) {
    // Pause auto-refresh briefly to avoid disruptive refresh when a new tab opens
    autoRefreshPaused = true;
    stopAutoRefresh();
    window.setTimeout(() => {
      autoRefreshPaused = false;
      if (autoRefreshSeconds > 0) {
        startAutoRefresh();
      }
    }, 30_000);

    vscode.postMessage({
      type: 'downloadArtifact',
      data: { artifactId, artifactName },
    });
  }

  /**
   * Open workflow file in editor
   */
  function openWorkflowFile(workflowPath: string) {
    // Extract the workflow file path without the @branch suffix
    const filePath = workflowPath.split('@')[0];
    vscode.postMessage({
      type: 'openWorkflowFile',
      data: { filePath },
    });
  }

  /**
   * Format file size
   */
  function formatFileSize(bytes: number): string {
    if (bytes === 0) {
      return '0 B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Toggle summary section
   */
  function toggleSummary(runId: number) {
    recordUserActivity();
    if (showSummary.has(runId)) {
      showSummary.delete(runId);
      showSummary = showSummary; // Trigger reactivity
    } else {
      // When opening summary, close jobs, artifacts, and graph for this run so that
      // only one section (Jobs, Artifacts, Graph, or Summary) is expanded at a time.
      if (expandedRuns.has(runId)) {
        expandedRuns.delete(runId);
        expandedRuns = expandedRuns; // Trigger reactivity
      }
      if (showArtifacts.has(runId)) {
        showArtifacts.delete(runId);
        showArtifacts = showArtifacts; // Trigger reactivity
      }
      if (showDependencyGraph.has(runId)) {
        showDependencyGraph.delete(runId);
        showDependencyGraph = showDependencyGraph; // Trigger reactivity
      }

      showSummary.add(runId);
      showSummary = showSummary; // Trigger reactivity

      // Fetch jobs if not already loaded (for summary stats)
      if (!runJobs.has(runId) && !loadingJobs.has(runId)) {
        loadingJobs.add(runId);
        loadingJobs = loadingJobs; // Trigger reactivity
        vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId } });
      }
    }
  }

  /**
   * Toggle workflow marked/pinned status
   */
  function toggleWorkflowMarked(workflowPath: string, event: Event) {
    event.stopPropagation();
    vscode.postMessage({
      type: 'toggleWorkflowMarked',
      data: { workflowPath },
    });
  }

  /**
   * Check if a workflow is marked
   */
  function isWorkflowMarked(workflowPath: string): boolean {
    return markedWorkflows.includes(workflowPath);
  }

  /**
   * Show help modal with panel usage information
   */
  function showPanelHelpModal() {
    helpModalTitle = 'Workflow Runs Panel - Help & Guide';
    helpModalContent = `
<h4>🔍 Filtering Workflow Runs</h4>
<ul>
  <li><strong>Search:</strong> Type in the search box to filter runs by workflow name, run title, branch, or actor username.</li>
  <li><strong>Status Filter:</strong> Choose which run statuses to include:
    <ul>
      <li><strong>All Statuses</strong> – show runs regardless of status.</li>
      <li><strong>Success</strong> – runs that completed successfully.</li>
      <li><strong>Failed</strong> – runs that completed with a failure.</li>
      <li><strong>In Progress</strong> – runs that are currently running.</li>
      <li><strong>Queued</strong> – runs waiting to start.</li>
      <li><strong>Cancelled</strong> – runs that were cancelled.</li>
    </ul>
  </li>
  <li><strong>Actor Filter:</strong> Filter by who triggered the run:
    <ul>
      <li><strong>All Users</strong> – runs from any actor.</li>
      <li><strong>My Runs</strong> – only runs started by your GitHub account.</li>
    </ul>
  </li>
  <li><strong>Workflow Filter:</strong> Use the "All workflows" combobox to show runs for a specific workflow file. Selecting a workflow loads and shows only runs for that workflow; clearing it shows runs for all workflows.</li>
  <li><strong>Date Filter:</strong> In the settings menu, use the "From" and "To" date/time inputs to limit runs to a specific range. Only runs whose start time falls within this range are shown.</li>
  <li><strong>Show Bot Runs:</strong> When enabled, includes runs triggered by bot accounts (actor logins ending with <code>[bot]</code>). When disabled, those runs are hidden.</li>
  <li><strong>Favorites Only:</strong> Show only runs from workflows you've marked as favorite (★/☆ star icon in the workflow dropdown).</li>
  <li><strong>Watched Runs Only:</strong> When enabled, shows <em>only</em> runs you have explicitly marked as watched (using the Watch/Watching button on each run) and ignores all other filters (actor, workflow, date, status, search, favorites, and bot visibility). Only watched runs that exist in the currently loaded dataset can be shown.</li>
</ul>

<h4>📊 Job Dependencies Graph</h4>
<ul>
  <li><strong>Graph Button:</strong> Click the <strong>Graph</strong> button on any run to visualize job dependencies. This is also the default view when clicking on a run.</li>
  <li><strong>Visual Layout:</strong> Jobs are displayed in a horizontal left-to-right layout showing execution stages. Connected lines indicate dependencies between jobs.</li>
  <li><strong>Job Status:</strong> Each job node shows its current status with color-coded icons:
    <ul>
      <li><span style="color: #2ea043;">●</span> Success – job completed successfully</li>
      <li><span style="color: #f85149;">●</span> Failure – job failed</li>
      <li><span style="color: #d29922;">●</span> In Progress – job is currently running (animated)</li>
      <li><span style="color: #8b949e;">●</span> Queued/Skipped – job is waiting or was skipped</li>
    </ul>
  </li>
  <li><strong>Matrix Jobs:</strong> Jobs using matrix strategies are grouped together. Click the group header to expand and see individual matrix job variants.</li>
  <li><strong>Click a Job:</strong> Click on any job node to view its step details in a modal. You can also view the full job logs by clicking the "View Logs" button.</li>
  <li><strong>Full Screen:</strong> Click the expand icon in the top-right corner of the graph to open it in a full-screen modal for better visibility of complex workflows.</li>
  <li><strong>Real-Time Updates:</strong> For in-progress runs, the graph updates automatically as jobs start and complete.</li>
</ul>

<h4>⚡ Run Actions</h4>
<ul>
  <li><strong>Click Run:</strong> Opens the job dependencies graph view (default). Use the action buttons to switch to Jobs list, Artifacts, or Summary views.</li>
  <li><strong><span class="codicon codicon-debug-restart"></span> Rerun:</strong> Rerun the workflow. When inputs are available, you'll be prompted to reuse or edit them.</li>
  <li><strong><span class="codicon codicon-debug-restart"></span> Rerun Failed:</strong> Only rerun jobs that failed for this run (available when the run conclusion is Failed).</li>
  <li><strong><span class="codicon codicon-circle-slash"></span> Cancel:</strong> Cancel a running workflow (In Progress or Queued).</li>
  <li><strong><span class="codicon codicon-file-text"></span> View Logs:</strong> Open detailed logs for a specific job in VS Code.</li>
  <li><strong><span class="codicon codicon-cloud-download"></span> Download:</strong> Download artifacts for this run (expired artifacts show a warning icon).</li>
  <li><strong><span class="codicon codicon-symbol-parameter"></span> Parameters:</strong> View the input parameters used for this run.</li>
  <li><strong><span class="codicon codicon-eye"></span> View:</strong> Open the run in your browser on GitHub.</li>
  <li><strong><span class="codicon codicon-watch"></span> Watch/Watching:</strong> Mark runs for tracking (they appear when "Watched Runs Only" is enabled).</li>
  <li><strong><span class="codicon codicon-file-code"></span> View File:</strong> Open the workflow YAML file in the editor.</li>
</ul>

<h4>🔔 Notification Settings</h4>
<ul>
  <li>Click the <span class="codicon codicon-gear"></span> settings button and select the <strong>Notifications</strong> tab to customize notification behavior.</li>
  <li><strong>Workflow Toast Notifications:</strong> Show toast messages in the top-right corner when workflows start, complete, or fail.</li>
  <li><strong>Progress Indicators:</strong> Show inline progress (e.g., "2/5 jobs completed") on in-progress workflow runs.</li>
  <li>All notification settings are persisted across sessions.</li>
</ul>

<h4>⭐ Workflow Favorites</h4>
<ul>
  <li>Click the ★/☆ star icon next to a workflow in the dropdown to add or remove a favorite.</li>
  <li>Favorited workflows appear with a ★ prefix in the dropdown.</li>
  <li>Use the "Favorites Only" checkbox to show only runs from favorite workflows (unless "Watched Runs Only" is enabled, which overrides other filters).</li>
  <li>Favorites persist across VS Code sessions.</li>
</ul>

<h4>📋 Examples</h4>
<ul>
  <li>To see all runs you've marked as watched, regardless of who triggered them or when they ran, enable <strong>Watched Runs Only</strong>. Other filters are ignored.</li>
  <li>To focus on your recent successful runs for a single workflow, select that workflow, set <strong>Status</strong> to <strong>Success</strong>, choose <strong>My Runs</strong>, and optionally apply a date range in settings.</li>
  <li>To view only runs from your most important workflows, mark them as favorites in the workflow dropdown and enable <strong>Favorites Only</strong>.</li>
  <li>To understand why a workflow failed, click the run to open the <strong>Graph</strong> view, then click on the failed job to see its step details and identify which step caused the failure.</li>
</ul>

<h4>🔄 Auto-Refresh</h4>
<ul>
  <li>Click the <span class="codicon codicon-gear"></span> settings button next to the Refresh button to configure auto-refresh.</li>
  <li>Use the slider to choose intervals such as Off, 15s, 30s, 45s, 1min, 1.5min, 2min, or 3min.</li>
  <li>Auto-refresh pauses when viewing external resources.</li>
</ul>

	`.trim();
    showHelpModal = true;
  }

  function showAutoRefreshSettingsHelp() {
    helpModalTitle = 'Auto-Refresh';
    helpModalContent = `
	<p>
	  Auto-refresh periodically refreshes the current runs list in the background so you see status changes without having to click Refresh.
	</p>
	<p>
	  Use the slider to pick how often the panel checks for updates. <strong>Off</strong> disables automatic refresh; higher values like <strong>90 seconds</strong> or <strong>2 minutes</strong> reduce GitHub API usage.
	</p>
	<p>
	  The panel also pauses auto-refresh while you are viewing external resources such as logs or artifacts, so the UI does not jump while you are inspecting a run.
	</p>
	`.trim();
    showHelpModal = true;
  }

  function showNonDateMaxTotalRunsHelp() {
    helpModalTitle = 'Maximum Workflow Runs Limit (on open)';
    helpModalContent = `
<p>
  This setting controls the <strong>maximum number of workflow runs</strong> the panel will
  progressively load when <strong>no date filter</strong> is active. It affects how far back
  in history the panel is willing to search while you are browsing or applying
  client-side filters such as actor, status, search text, favorites, and watched runs.
</p>
<p>
  Increasing this limit lets you look further back in time (for example when filtering
  by a specific branch or actor), at the cost of more GitHub API requests and larger
  in-memory result sets. Decreasing it keeps things fast but may require you to apply
  a date range if you need to go further back.
</p>
`.trim();
    showHelpModal = true;
  }

  function showDateFilterMaxTotalRunsHelp() {
    helpModalTitle = 'Maximum Workflow Runs Limit (Date Range)';
    helpModalContent = `
<p>
  This setting controls the <strong>maximum number of workflow runs</strong> that will be
  scanned when a <strong>Date Filter</strong> is active. The panel asks the extension host
  to walk through GitHub pages for the selected date window until it either reaches
  this limit, runs out of data, or hits a safety cap on the number of pages.
</p>
<p>
  If the date window contains more runs than this cap, the results are marked as
  <strong>truncated</strong> and a warning is shown so you know additional runs exist
  outside the loaded subset. Increasing the limit can give more complete coverage
  for very busy repositories, but also increases API usage.
</p>
`.trim();
    showHelpModal = true;
  }

  function showWorkflowLoadLimitHelp() {
    helpModalTitle = 'Workflow Runs Per Page';
    helpModalContent = `
<p>
  This setting controls how many workflow runs are displayed <strong>per page</strong> in
  the panel. It only affects client-side pagination over the runs that have already
  been loaded from GitHub.
</p>
<p>
  Changing this does <em>not</em> change the GitHub API page size or how many runs are
  fetched in total; it simply adjusts how much data you see at once in the UI.
  Lower values make each page lighter and easier to scan, while higher values
  reduce the number of pages you need to step through.
</p>
`.trim();
    showHelpModal = true;
  }

  /**
   * Close help modal
   */
  function closeHelpModal() {
    showHelpModal = false;
  }

  /**
   * Show help modal with information about watched runs feature.
   */
  function showWatchedRunsHelp() {
    helpModalTitle = 'Watched Runs Only';
    helpModalContent = `
<h4>⏱️ How Watched Runs Work</h4>
<p>Watched runs let you track specific workflow runs regardless of their age or other filters.</p>

<h4>Managing Watched Runs</h4>
<ul>
  <li><strong>Watch a run:</strong> Click the <span class="codicon codicon-watch"></span> Watch button on any workflow run to start watching it.</li>
  <li><strong>Unwatch a run:</strong> Click the Watching button again on a watched run to stop watching it.</li>
  <li><strong>View all watched runs:</strong> Enable the "Watched Runs Only" checkbox to see only your watched runs.</li>
  <li><strong>Manage watched runs:</strong> When "Watched Runs Only" is enabled, use the "Manage" button to see and remove watched runs.</li>
</ul>

<h4>Important Behavior</h4>
<ul>
  <li><strong>Overrides all filters:</strong> When "Watched Runs Only" is enabled, all other filters (status, actor, workflow, date, search, favorites) are ignored.</li>
  <li><strong>Limit:</strong> You can watch up to <strong>${MAX_WATCHED_RUNS_PER_REPO}</strong> runs per repository.</li>
  <li><strong>Persistence:</strong> Watched runs are saved and persist across VS Code sessions.</li>
  <li><strong>Cross-workflow:</strong> Watched runs can span multiple workflows, so the workflow filter is disabled when this mode is active.</li>
</ul>

<h4>💡 Tips</h4>
<ul>
  <li>Watch runs you want to monitor closely, even if they're older than your date range.</li>
  <li>Use watched runs to track important deployments or long-running jobs.</li>
  <li>Watched runs are refreshed when you enable "Watched Runs Only" to ensure you see current status.</li>
</ul>
`.trim();
    showHelpModal = true;
  }

  /**
   * Show help modal with information about favorites feature.
   */
  function showFavoritesHelp() {
    helpModalTitle = 'Favorites Only';
    helpModalContent = `
<h4>⭐ How Workflow Favorites Work</h4>
<p>Favorites let you quickly filter to runs from your most important workflows.</p>

<h4>Managing Favorites</h4>
<ul>
  <li><strong>Add a favorite:</strong> Open the workflow dropdown and click the ☆ star icon next to any workflow to mark it as a favorite.</li>
  <li><strong>Remove a favorite:</strong> Click the ★ star icon next to a favorited workflow to remove it from favorites.</li>
  <li><strong>View favorite runs only:</strong> Enable the "Favorites Only" checkbox to show only runs from favorited workflows.</li>
</ul>

<h4>Where to Find the Star Icon</h4>
<p>The star icon (★/☆) appears next to each workflow in the workflow filter dropdown:</p>
<ol>
  <li>Click on the workflow search/filter field</li>
  <li>Look for the star icon on the right side of each workflow row</li>
  <li>Click the star to toggle favorite status</li>
</ol>

<h4>Important Behavior</h4>
<ul>
  <li><strong>Cross-workflow:</strong> Favorites Only shows runs from all favorited workflows, so the workflow dropdown filter is disabled when active.</li>
  <li><strong>Persistence:</strong> Favorites are saved and persist across VS Code sessions.</li>
  <li><strong>Sorting:</strong> Favorited workflows appear at the top of the workflow dropdown for easy access.</li>
  <li><strong>Combined with other filters:</strong> Unlike "Watched Runs Only", favorites can be combined with status, actor, date, and search filters.</li>
</ul>

<h4>💡 Tips</h4>
<ul>
  <li>Favorite your most frequently monitored workflows for quick access.</li>
  <li>Combine with status filter to see all failures from your favorite workflows.</li>
  <li>Use with the actor filter to see your runs across all favorite workflows.</li>
</ul>
`.trim();
    showHelpModal = true;
  }

  /**
   * Filter available workflows based on search query and sort favorites first.
   * When isWorkflowSearchActive is false, we ignore workflowSearchQuery and show all workflows
   * so the selected workflow label in the input does not act as a filter.
   */
  function filterAvailableWorkflows() {
    let workflows = availableWorkflows;

    // Apply search filter only when the user is actively searching
    if (isWorkflowSearchActive && workflowSearchQuery.trim()) {
      const query = workflowSearchQuery.toLowerCase();
      workflows = workflows.filter(
        (workflow) =>
          workflow.name.toLowerCase().includes(query) || workflow.path.toLowerCase().includes(query)
      );
    }

    // Sort workflows: favorites first, then alphabetically by name
    filteredAvailableWorkflows = workflows.sort((a, b) => {
      const aMarked = isWorkflowMarked(a.path);
      const bMarked = isWorkflowMarked(b.path);

      // If one is marked and the other isn't, marked comes first
      if (aMarked && !bMarked) {
        return -1;
      }
      if (!aMarked && bMarked) {
        return 1;
      }

      // Otherwise, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Handle workflow search input
   */
  function handleWorkflowSearchInput() {
    // Mark search as active only when there is a non-empty query
    isWorkflowSearchActive = !!workflowSearchQuery.trim();
    filterAvailableWorkflows();
    workflowDropdownOpen = true;
  }

  /**
   * Get the original workflow name from the YAML file for a given run
   */
  function getOriginalWorkflowName(run: WorkflowRun): string | null {
    // Extract workflow path without @branch suffix
    const workflowPath = run.path.split('@')[0];
    return workflowPathToName.get(workflowPath) || null;
  }

  /**
   * Request runs for a specific workflow, ensuring we scope by workflow_id so the
   * backend can persist it for subsequent operations (for example, date filters).
   * Uses debouncing to prevent overwhelming the backend with rapid workflow switches.
   */
  function requestRunsForWorkflow(workflow: { path: string; name: string; filename: string }) {
    // Cancel all pending operations from previous workflow switch
    cancelPendingOperations();

    // Try to find workflow_id from existing runs for this workflow
    // IMPORTANT: This searches in the CURRENT runs array before it's cleared.
    // If runs contains data from a previous workflow view, we need to ensure
    // the path match is exact to avoid using the wrong workflow_id.
    const matchingRun = runs.find((run) => {
      const runPath = run.path.split('@')[0];
      return runPath === workflow.path;
    });

    // Debug logging to help trace workflow ID resolution issues
    console.log('[WorkflowRuns] requestRunsForWorkflow:', {
      targetPath: workflow.path,
      targetFilename: workflow.filename,
      runsCount: runs.length,
      matchingRunFound: !!matchingRun,
      matchingWorkflowId: matchingRun?.workflow_id,
      matchingRunPath: matchingRun?.path,
    });

    // Clear notifications from previous workflow to prevent stale notifications
    clearAllToasts();
    clearStatusChanges();

    // Pause auto-refresh during workflow switch to prevent race conditions
    // where auto-refresh responses arrive before the workflow-specific response.
    // This will be resumed once the workflow fetch completes or times out.
    autoRefreshPaused = true;
    stopAutoRefresh();

    // Show a loading state while fetching runs for the selected workflow
    runs = [];
    filteredRuns = [];
    smartSuggestions = [];
    loading = true;

    // Mark this as a manual workflow fetch to skip the filter message wait
    isManualWorkflowFetch = true;

    // Use a sentinel value to track that we're waiting for a workflow ID
    // This helps the stale response detection handle the getWorkflowId flow
    pendingWorkflowId = 'pending';

    // Start watchdog timer to recover from stuck state if response never arrives
    startWorkflowFetchWatchdog();

    // Debounce the actual request to prevent rapid-fire API calls
    workflowSwitchDebounceId = window.setTimeout(() => {
      workflowSwitchDebounceId = null;

      if (matchingRun) {
        // Found a matching run, use its workflow_id to fetch runs
        console.log(
          '[WorkflowRuns] Found workflow_id from existing run:',
          workflow.name,
          'workflow_id:',
          matchingRun.workflow_id
        );
        // Track the expected workflowId to ignore stale responses
        pendingWorkflowId = matchingRun.workflow_id;
        vscode.postMessage({
          type: 'getWorkflowRuns',
          data: { workflowId: matchingRun.workflow_id },
        });
      } else {
        // No matching run found, request workflow ID from backend
        // pendingWorkflowId stays as 'pending' until getWorkflowIdResponse arrives
        console.log(
          '[WorkflowRuns] No existing run found, requesting workflow ID for:',
          workflow.filename
        );
        vscode.postMessage({
          type: 'getWorkflowId',
          data: { workflowFilename: workflow.filename },
        });
      }
    }, 150); // 150ms debounce for rapid workflow switches
  }

  /**
   * Select workflow from dropdown
   */
  function selectWorkflowFromDropdown(workflow: { path: string; name: string; filename: string }) {
    recordUserActivity();
    workflowFilter = workflow.path;
    workflowSearchQuery = workflow.name;
    isWorkflowSearchActive = false;
    workflowDropdownOpen = false;

    requestRunsForWorkflow(workflow);
  }

  /**
   * Clear workflow filter
   */
  function clearWorkflowFilter() {
    recordUserActivity();
    // Cancel all pending operations from previous workflow
    cancelPendingOperations();

    workflowFilter = 'all';
    workflowSearchQuery = '';
    isWorkflowSearchActive = false;
    workflowDropdownOpen = false;

    // Clear notifications from previous workflow to prevent stale notifications
    clearAllToasts();
    clearStatusChanges();

    // Pause auto-refresh during workflow switch to prevent race conditions
    // where auto-refresh responses arrive before the workflow-specific response.
    // This will be resumed once the workflow fetch completes or times out.
    autoRefreshPaused = true;
    stopAutoRefresh();

    // Show a loading state while fetching runs without a workflow filter
    runs = [];
    filteredRuns = [];
    smartSuggestions = [];
    loading = true;

    // Mark this as a manual workflow fetch to skip the filter message wait
    isManualWorkflowFetch = true;
    // Track that we're expecting "all" runs (no workflow filter)
    pendingWorkflowId = 'all';

    // Start watchdog timer to recover from stuck state if response never arrives
    startWorkflowFetchWatchdog();

    // Debounce the actual request to prevent rapid-fire API calls
    workflowSwitchDebounceId = window.setTimeout(() => {
      workflowSwitchDebounceId = null;
      // Request all runs (no workflow filter)
      vscode.postMessage({ type: 'getWorkflowRuns' });
    }, 150); // 150ms debounce for rapid workflow switches
  }

  /**
   * Handle click outside workflow dropdown and settings dropdown.
   * Closes dropdowns when user clicks outside of them.
   */
  function handleWorkflowDropdownClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    // Close workflow dropdown if click is outside
    if (!target.closest('.workflow-filter-combobox')) {
      workflowDropdownOpen = false;
    }
    // Close settings dropdown if click is outside
    if (!target.closest('.refresh-settings-wrapper')) {
      showRefreshSettings = false;
    }
  }

  /**
   * Handle "Show Bot Runs" checkbox change with one-way coupling.
   * Rule: When CHECKED → automatically switch to "All Users" (bot runs only visible with All Users)
   * Rule: When UNCHECKED → do NOT change Actor Filter (user can view All Users or My Runs without bots)
   */
  function handleShowBotRunsChange() {
    // Cancel any pending requests from previous filter state
    cancelPendingFilterRequests();

    if (showBotRuns) {
      // User just checked "Show Bot Runs" → switch to "All Users" if not already
      if (actorFilter !== 'all') {
        actorFilter = 'all';
        console.log('[WorkflowRuns] Show Bot Runs enabled: switching to All Users');
        // Provide clear feedback about the automatic filter change
        showToast(
          'Actor filter switched to "All Users" – bot runs are only visible with All Users',
          'info',
          4000
        );
      }
    } else {
      // User unchecked "Show Bot Runs" → do NOT change Actor Filter
      console.log('[WorkflowRuns] Show Bot Runs disabled: keeping Actor Filter as', actorFilter);
    }
    filterRuns();
  }

  /**
   * Handle "Watched Runs Only" checkbox changes.
   *
   * When enabled and we have watched run IDs, we ask the backend to refresh
   * exactly those runs by ID instead of paginating over all runs. This keeps
   * the "Watched Runs Only" view fast and focused.
   */
  function handleShowWatchedOnlyChange() {
    // When "Watched Runs Only" is enabled, reset the workflow filter to "all"
    // because watched runs can span multiple workflows
    if (showWatchedOnly) {
      workflowFilter = 'all';
      workflowSearchQuery = '';
      isWorkflowSearchActive = false;
      workflowDropdownOpen = false;
    }

    filterRuns();

    if (showWatchedOnly && watchedRuns.size > 0) {
      vscode.postMessage({
        type: 'backgroundRefreshWatchedRuns',
        data: { watchedRunIds: Array.from(watchedRuns) },
      });
    }
  }

  /**
   * Handle "Favorites Only" checkbox change.
   * When enabled, reset the workflow filter since favorites can span multiple workflows.
   */
  function handleShowFavoritesOnlyChange() {
    // When "Favorites Only" is enabled, reset the workflow filter to "all"
    // because favorite workflows show runs from multiple workflows
    if (showFavoritesOnly) {
      workflowFilter = 'all';
      workflowSearchQuery = '';
      isWorkflowSearchActive = false;
      workflowDropdownOpen = false;
    }

    filterRuns();
  }

  /**
   * Handle actor filter dropdown change with one-way coupling.
   * Rule: When "My Runs" selected → automatically uncheck "Show Bot Runs" (My Runs never shows bots)
   * Rule: When "All Users" selected → do NOT change "Show Bot Runs" (All Users can show with or without bots)
   */
  function handleActorFilterChange() {
    recordUserActivity();
    // Cancel any pending requests from previous filter state
    cancelPendingFilterRequests();

    if (actorFilter === 'me') {
      // User selected "My Runs" → uncheck bot runs if checked
      if (showBotRuns) {
        showBotRuns = false;
        console.log('[WorkflowRuns] Actor filter changed to My Runs: disabling bot runs');
        // Provide clear feedback about the automatic filter change
        showToast('"Show Bot Runs" disabled – My Runs filter excludes bot accounts', 'info', 4000);
      }
    } else if (actorFilter === 'all') {
      // User selected "All Users" → do NOT change bot runs checkbox
      console.log(
        '[WorkflowRuns] Actor filter changed to All Users: keeping Show Bot Runs as',
        showBotRuns
      );
    }
    filterRuns();
  }

  /**
   * Toggle watch status for a workflow run
   */
  function toggleRunWatch(runId: number, event: Event) {
    recordUserActivity();
    event.stopPropagation();
    let nowWatched: boolean;
    if (watchedRuns.has(runId)) {
      watchedRuns.delete(runId);
      nowWatched = false;

      // When the last watch is removed, reset the "Watched Runs Only" filter
      // to prevent the checkbox from being checked but disabled
      if (watchedRuns.size === 0 && showWatchedOnly) {
        showWatchedOnly = false;
      }
    } else {
      // Check if we've reached the maximum limit (20 runs per repository)
      const MAX_WATCHED_RUNS_PER_REPO = 20;
      if (watchedRuns.size >= MAX_WATCHED_RUNS_PER_REPO) {
        showToast(
          `Cannot watch more than ${MAX_WATCHED_RUNS_PER_REPO} runs per repository. Please unwatch some runs first.`,
          'error',
          5000
        );
        return;
      }
      watchedRuns.add(runId);
      nowWatched = true;
    }
    watchedRuns = watchedRuns; // Trigger reactivity
    console.log(
      '[WorkflowRuns] toggleRunWatch: runId',
      runId,
      'nowWatched:',
      nowWatched,
      'total watched:',
      watchedRuns.size
    );
    vscode.postMessage({
      type: 'toggleRunWatch',
      data: { runId, isWatched: nowWatched },
    });
    filterRuns();
    // Toast feedback
    showToast(
      nowWatched ? `Watching run #${runId}` : `Stopped watching run #${runId}`,
      'info',
      2500
    );
  }

  /**
   * Unwatch all currently watched workflow runs.
   * Triggered from the "Unwatch all" control next to the Watched Runs filter.
   */
  function handleUnwatchAllRuns() {
    if (watchedRuns.size === 0) {
      return;
    }

    vscode.postMessage({
      type: 'unwatchAllRuns',
    });
  }

  /**
   * Open the watched runs management modal
   */
  function openWatchedRunsModal() {
    showWatchedRunsModal = true;
  }

  /**
   * Close the watched runs management modal
   */
  function closeWatchedRunsModal() {
    showWatchedRunsModal = false;
  }

  /**
   * Unwatch a specific run from the management modal
   */
  function unwatchRunFromModal(runId: number, event: Event) {
    event.stopPropagation();
    toggleRunWatch(runId, event);
  }

  /**
   * Check if a run is watched
   */
  function isRunWatched(runId: number): boolean {
    return watchedRuns.has(runId);
  }

  /**
   * Get summary statistics for a run
   */
  function getRunSummary(runId: number) {
    const jobs = runJobs.get(runId) || [];
    const successCount = jobs.filter(
      (j) => j.status === 'completed' && j.conclusion === 'success'
    ).length;
    const failureCount = jobs.filter(
      (j) => j.status === 'completed' && j.conclusion === 'failure'
    ).length;
    const cancelledCount = jobs.filter(
      (j) => j.status === 'completed' && j.conclusion === 'cancelled'
    ).length;
    const skippedCount = jobs.filter(
      (j) => j.status === 'completed' && j.conclusion === 'skipped'
    ).length;
    const inProgressCount = jobs.filter((j) => j.status === 'in_progress').length;
    const queuedCount = jobs.filter((j) => j.status === 'queued').length;

    return {
      totalJobs: jobs.length,
      successCount,
      failureCount,
      cancelledCount,
      skippedCount,
      inProgressCount,
      queuedCount,
    };
  }

  /**
   * Normalize workflow filepath to relative .github/workflows/ format
   * Converts absolute paths like /Users/.../repo/.github/workflows/file.yml
   * or C:\Users\...\repo\.github\workflows\file.yml (Windows)
   * to relative paths like .github/workflows/file.yml to match GitHub API format
   */
  function normalizeWorkflowPath(filepath: string): string {
    // First, normalize all backslashes to forward slashes for cross-platform compatibility
    const normalizedPath = filepath.replace(/\\/g, '/');
    // Extract the .github/workflows/filename.yml part
    const match = normalizedPath.match(/\.github\/workflows\/[^/]+$/);
    return match ? match[0] : normalizedPath;
  }

  /**
   * Build available workflows list from workflow definitions
   */
  function buildAvailableWorkflows() {
    console.log(
      '[WorkflowRuns] buildAvailableWorkflows: Starting...',
      'allWorkflowDefinitions.length:',
      allWorkflowDefinitions.length,
      'runs.length:',
      runs.length
    );

    // Build workflow path -> name mapping from definitions
    workflowPathToName = new Map();
    const workflowsMap = new Map<string, { path: string; name: string; filename: string }>();

    // First, add workflows from local definitions
    for (const workflow of allWorkflowDefinitions) {
      // Normalize the absolute filepath to relative .github/workflows/ format
      const normalizedPath = normalizeWorkflowPath(workflow.filepath);
      workflowPathToName.set(normalizedPath, workflow.name);
      workflowsMap.set(normalizedPath, {
        path: normalizedPath,
        name: workflow.name,
        filename: workflow.filename,
      });
    }

    // Second, add workflows from runs that don't have local definitions
    // This allows filtering by workflows from other repositories or deleted workflows
    console.log(
      '[WorkflowRuns] buildAvailableWorkflows: Checking runs for workflows without local files...'
    );
    for (const run of runs) {
      const runPath = run.path.split('@')[0]; // Remove @branch suffix
      if (!workflowsMap.has(runPath)) {
        workflowPathToName.set(runPath, run.name);
        // Extract filename from path
        const filename = runPath.split('/').pop() || runPath;
        workflowsMap.set(runPath, {
          path: runPath,
          name: run.name,
          filename: filename,
        });
      }
    }

    // Show all workflows (from local definitions + runs)
    availableWorkflows = Array.from(workflowsMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    console.log(
      '[WorkflowRuns] buildAvailableWorkflows: Final availableWorkflows:',
      availableWorkflows.length,
      'workflows'
    );

    // Initialize filtered workflows
    filterAvailableWorkflows();
  }

  /**
   * Get cache key for current workflow filter.
   * Includes repository info to prevent cache conflicts between different repositories.
   */
  function getCacheKey(): string {
    const workflowPart = workflowFilter === 'all' ? '__all__' : workflowFilter;
    // Include repository in cache key to prevent cross-repository cache conflicts
    const repoPart = repository ? `${repository.owner}/${repository.name}` : '__no_repo__';
    return `${repoPart}::${workflowPart}`;
  }

  /**
   * Check if cache is valid for a specific cache key.
   * Validates both age and repository match.
   */
  function isCacheValid(cacheKey: string): boolean {
    const cache = workflowRunsCache.get(cacheKey);
    if (!cache) {
      return false;
    }

    // Check if repository matches current context
    // This prevents using cached data from a different repository
    if (repository && cache.repository) {
      const repoMatches =
        cache.repository.owner === repository.owner && cache.repository.name === repository.name;
      if (!repoMatches) {
        console.log('[WorkflowRuns] Cache invalidated - repository mismatch');
        return false;
      }
    }

    const now = Date.now();
    const age = now - cache.cacheTimestamp;
    return age < CACHE_EXPIRATION_MS;
  }

  /**
   * Evict oldest cache entries if we've exceeded MAX_CACHE_ENTRIES.
   * Uses LRU (Least Recently Used) strategy based on lastFetchTimestamp.
   */
  function evictOldestCacheEntries() {
    if (workflowRunsCache.size <= MAX_CACHE_ENTRIES) {
      return;
    }

    // Sort entries by lastFetchTimestamp (oldest first)
    const entries = Array.from(workflowRunsCache.entries()).sort(
      (a, b) => a[1].lastFetchTimestamp - b[1].lastFetchTimestamp
    );

    // Remove oldest entries until we're at the limit
    const entriesToRemove = entries.slice(0, workflowRunsCache.size - MAX_CACHE_ENTRIES);
    for (const [key] of entriesToRemove) {
      workflowRunsCache.delete(key);
      console.log('[WorkflowRuns] Evicted cache entry for workflow:', key);
    }
  }

  /**
   * Save runs to workflow-specific cache.
   * Enforces MAX_CACHE_ENTRIES limit and truncates runs to MAX_CACHED_RUNS_PER_WORKFLOW.
   */
  function saveToCache(
    workflowPath: string,
    runsToCache: WorkflowRun[],
    totalCount: number,
    repository: { owner: string; name: string } | null
  ) {
    const now = Date.now();

    // Limit the number of runs stored in cache to prevent memory bloat
    // Keep the most recent runs (array is sorted by created_at descending)
    const truncatedRuns =
      runsToCache.length > MAX_CACHED_RUNS_PER_WORKFLOW
        ? runsToCache.slice(0, MAX_CACHED_RUNS_PER_WORKFLOW)
        : runsToCache;

    workflowRunsCache.set(workflowPath, {
      runs: truncatedRuns,
      totalCount,
      lastFetchTimestamp: now,
      cacheTimestamp: now,
      repository,
    });

    // Evict old entries if cache is full
    evictOldestCacheEntries();

    console.log(
      '[WorkflowRuns] Saved runs to cache for workflow:',
      workflowPath,
      truncatedRuns.length,
      'runs (truncated from',
      runsToCache.length,
      ')'
    );
  }

  /**
   * Load runs from workflow-specific cache
   */
  function loadFromCache(workflowPath: string): boolean {
    if (isCacheValid(workflowPath)) {
      const cache = workflowRunsCache.get(workflowPath);
      if (cache) {
        runs = cache.runs;
        totalCount = cache.totalCount;
        repository = cache.repository;
        console.log(
          '[WorkflowRuns] Loaded runs from cache for workflow:',
          workflowPath,
          runs.length,
          'runs'
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Get last fetch timestamp for a workflow
   */
  function getLastFetchTimestamp(workflowPath: string): number | null {
    const cache = workflowRunsCache.get(workflowPath);
    return cache ? cache.lastFetchTimestamp : null;
  }

  /**
   * Merge new runs with cached runs, removing duplicates
   */
  function mergeRuns(cachedRuns: WorkflowRun[], newRuns: WorkflowRun[]): WorkflowRun[] {
    const runMap = new Map<number, WorkflowRun>();

    // Add cached runs first
    for (const run of cachedRuns) {
      runMap.set(run.id, run);
    }

    // Add/update with new runs (newer data takes precedence)
    for (const run of newRuns) {
      runMap.set(run.id, run);
    }

    // Convert back to array and sort by created_at (newest first)
    return Array.from(runMap.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  /**
   * Clear cache for a specific workflow or all workflows
   */
  function clearCache(workflowPath?: string) {
    if (workflowPath) {
      workflowRunsCache.delete(workflowPath);
      console.log('[WorkflowRuns] Cache cleared for workflow:', workflowPath);
    } else {
      workflowRunsCache.clear();
      console.log('[WorkflowRuns] All caches cleared');
    }
  }

  /**
   * Auto-load jobs for in-progress runs to show mini progress indicator.
   * This provides immediate visibility into running workflows without expanding the graph.
   */
  function autoLoadJobsForInProgressRuns() {
    const inProgressRuns = runs.filter(
      (run) => run.status === 'in_progress' || run.status === 'queued'
    );

    if (inProgressRuns.length === 0) {
      return;
    }

    console.log('[WorkflowRuns] Auto-loading jobs for', inProgressRuns.length, 'in-progress runs');

    // Load jobs for all in-progress runs so mini progress indicator can show them
    for (const run of inProgressRuns) {
      if (!runJobs.has(run.id) && !loadingJobs.has(run.id)) {
        loadingJobs.add(run.id);
        loadingJobs = loadingJobs; // Trigger reactivity
        vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId: run.id } });
      }
    }
  }

  /**
   * Finalize initial load by applying filters and clearing loading state.
   * This is called after all initial filter messages have been received,
   * or after a timeout to prevent indefinite waiting.
   */
  function finalizeInitialLoad() {
    if (!waitingForInitialFilters) {
      return; // Already finalized or not in initial load state
    }

    // Safety check: if we're in a manual workflow fetch, don't finalize the initial load
    // This can happen if the user switches workflows while waiting for initial filters
    if (isManualWorkflowFetch) {
      console.log(
        '[WorkflowRuns] Skipping finalizeInitialLoad - manual workflow fetch in progress'
      );
      waitingForInitialFilters = false;
      if (initialFilterTimeout !== null) {
        clearTimeout(initialFilterTimeout);
        initialFilterTimeout = null;
      }
      return;
    }

    console.log(
      '[WorkflowRuns] Finalizing initial load - applying filters and clearing loading state'
    );

    // Clear the timeout if it exists
    if (initialFilterTimeout !== null) {
      clearTimeout(initialFilterTimeout);
      initialFilterTimeout = null;
    }

    // Clear the waiting flag
    waitingForInitialFilters = false;

    // IMPORTANT: Clear loading flags BEFORE filterRuns() so that
    // scheduleProgressiveFetchIfNeeded() can trigger progressive fetching
    // when filteredRuns.length is below the threshold.
    loading = false;
    refreshing = false;

    // Now apply filters
    buildAvailableWorkflows();
    filterRuns();

    autoLoadJobsForInProgressRuns();
  }

  /**
   * Handle messages from extension
   */
  function handleMessage(event: MessageEvent) {
    const message = event.data;

    // Check for stuck loading state on every message and recover if needed
    // This provides a safety net in case the watchdog timer doesn't fire
    checkAndRecoverFromStuckState();

    // Avoid disruptive refresh while we intentionally pause (e.g., when opening logs)
    // BUT always process responses for manual workflow switches (isManualWorkflowFetch)
    // to prevent the UI from getting stuck in a loading state
    if (message.type === 'getWorkflowRuns') {
      // Always clear the date-filter fetching indicator when a runs payload
      // arrives, even if we skip applying it while auto-refresh is paused.
      fetchingDateFilteredRuns = false;

      // Only block auto-refresh responses, not manual workflow switch responses
      if (autoRefreshPaused && !isManualWorkflowFetch) {
        console.log('[WorkflowRuns] Skipping auto-refresh response while paused');
        return;
      }
    }

    if (message.type === 'getWorkflows' && message.success) {
      console.log(
        '[WorkflowRuns] handleMessage: Received getWorkflows response, data:',
        message.data
      );
      allWorkflowDefinitions = message.data || [];
      console.log(
        '[WorkflowRuns] handleMessage: Set allWorkflowDefinitions, length:',
        allWorkflowDefinitions.length
      );
      buildAvailableWorkflows();
    } else if (message.type === 'getWorkflows' && !message.success) {
      console.error('[WorkflowRuns] handleMessage: getWorkflows failed:', message.error);
    } else if (message.type === 'initialSettings') {
      if (message.success && message.data) {
        const settings = message.data as {
          workflowLoadLimit?: number;
          autoRefreshSeconds?: number;
          dateFilterFrom?: string | null;
          dateFilterTo?: string | null;
          nonDateMaxTotalRuns?: number;
          dateFilterMaxTotalRuns?: number;
          showWorkflowToastNotifications?: boolean;
          showProgressIndicators?: boolean;
          adaptiveRefreshEnabled?: boolean;
          adaptiveFastRefreshSeconds?: number;
          rateLimitProtectionEnabled?: boolean;
          rateLimitThreshold?: number;
          // NOTE: rateLimitInfo is intentionally not included - we only show real API values
        };

        const {
          workflowLoadLimit: savedLimit,
          autoRefreshSeconds: savedAutoRefreshSeconds,
          dateFilterFrom: savedFrom,
          dateFilterTo: savedTo,
          nonDateMaxTotalRuns: savedNonDateMaxTotalRuns,
          dateFilterMaxTotalRuns: savedDateFilterMaxTotalRuns,
          showWorkflowToastNotifications: savedWorkflowToast,
          showProgressIndicators: savedProgress,
          adaptiveRefreshEnabled: savedAdaptiveEnabled,
          adaptiveFastRefreshSeconds: savedAdaptiveFast,
          rateLimitProtectionEnabled: savedRateLimitProtection,
          rateLimitThreshold: savedRateLimitThreshold,
        } = settings;

        if (typeof savedLimit === 'number' && Number.isFinite(savedLimit) && savedLimit > 0) {
          workflowLoadLimit = savedLimit;
        } else {
          workflowLoadLimit = DEFAULT_WORKFLOW_LOAD_LIMIT;
        }
        workflowLoadLimitIndex = getWorkflowLoadLimitIndex(workflowLoadLimit);

        if (
          typeof savedNonDateMaxTotalRuns === 'number' &&
          Number.isFinite(savedNonDateMaxTotalRuns) &&
          savedNonDateMaxTotalRuns > 0
        ) {
          NON_DATE_MAX_TOTAL_RUNS = savedNonDateMaxTotalRuns;
        } else {
          NON_DATE_MAX_TOTAL_RUNS = DEFAULT_MAX_TOTAL_RUNS;
        }
        nonDateMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(NON_DATE_MAX_TOTAL_RUNS);

        if (
          typeof savedDateFilterMaxTotalRuns === 'number' &&
          Number.isFinite(savedDateFilterMaxTotalRuns) &&
          savedDateFilterMaxTotalRuns > 0
        ) {
          DATE_FILTER_MAX_TOTAL_RUNS = savedDateFilterMaxTotalRuns;
        } else {
          DATE_FILTER_MAX_TOTAL_RUNS = DEFAULT_MAX_TOTAL_RUNS;
        }
        dateFilterMaxTotalRunsIndex = getMaxTotalRunsOptionIndex(DATE_FILTER_MAX_TOTAL_RUNS);

        if (
          typeof savedAutoRefreshSeconds === 'number' &&
          Number.isFinite(savedAutoRefreshSeconds) &&
          savedAutoRefreshSeconds >= 0
        ) {
          autoRefreshSeconds = savedAutoRefreshSeconds;
        } else {
          autoRefreshSeconds = DEFAULT_AUTO_REFRESH_SECONDS;
        }
        autoRefreshIndex = getAutoRefreshOptionIndex(autoRefreshSeconds);

        // Initialize adaptive refresh settings (default to enabled with 10s fast interval)
        adaptiveRefreshEnabled =
          typeof savedAdaptiveEnabled === 'boolean' ? savedAdaptiveEnabled : true;
        if (
          typeof savedAdaptiveFast === 'number' &&
          Number.isFinite(savedAdaptiveFast) &&
          savedAdaptiveFast >= MIN_ADAPTIVE_FAST_REFRESH_SECONDS &&
          savedAdaptiveFast <= MAX_ADAPTIVE_FAST_REFRESH_SECONDS
        ) {
          adaptiveFastRefreshSeconds = savedAdaptiveFast;
        } else {
          adaptiveFastRefreshSeconds = DEFAULT_ADAPTIVE_FAST_REFRESH_SECONDS;
        }

        // Initialize rate limit settings
        rateLimitProtectionEnabled =
          typeof savedRateLimitProtection === 'boolean' ? savedRateLimitProtection : true;
        if (
          typeof savedRateLimitThreshold === 'number' &&
          RATE_LIMIT_THRESHOLD_OPTIONS.includes(savedRateLimitThreshold)
        ) {
          rateLimitThreshold = savedRateLimitThreshold;
        } else {
          rateLimitThreshold = DEFAULT_RATE_LIMIT_THRESHOLD;
        }

        // NOTE: Rate limit info is NOT loaded from persisted data.
        // Display will show "Unknown" until the first API response is received.
        // This ensures we only show actual values from real GitHub API calls,
        // not stale cached data from previous sessions.

        startAutoRefresh();

        // Initialize notification settings (default to true if not set)
        showWorkflowToastNotifications =
          typeof savedWorkflowToast === 'boolean' ? savedWorkflowToast : true;
        showProgressIndicators = typeof savedProgress === 'boolean' ? savedProgress : true;

        dateFilterFrom = savedFrom ?? '';
        dateFilterTo = savedTo ?? '';

        if (runs.length > 0) {
          filterRuns();
        }
      } else if (!message.success && message.error) {
        console.error('[WorkflowRuns] handleMessage: initialSettings failed:', message.error);
      }
    } else if (message.type === 'getWorkflowRuns' && message.success) {
      const newRuns = message.data?.runs || [];
      totalCount = message.data?.totalCount || 0;
      repository = message.data?.repository || null;
      const responseWorkflowId = message.data?.workflowId ?? null;

      console.log('[WorkflowRuns] getWorkflowRuns response received:', {
        runsCount: newRuns.length,
        responseWorkflowId,
        isManualWorkflowFetch,
        pendingWorkflowId,
      });

      // Check if this is a stale response that should be ignored
      // This happens when we're waiting for a workflow-specific response but
      // a response from webviewReady (with all runs) arrives first
      if (isManualWorkflowFetch && pendingWorkflowId !== null) {
        // If we're still waiting for the workflow ID (pendingWorkflowId === 'pending'),
        // ignore any getWorkflowRuns responses as they are from previous requests
        if (pendingWorkflowId === 'pending') {
          console.log(
            '[WorkflowRuns] Ignoring getWorkflowRuns response while waiting for workflow ID:',
            'received workflowId:',
            responseWorkflowId
          );
          return;
        }

        const pendingIsAll = pendingWorkflowId === 'all';
        const responseIsAll = responseWorkflowId === null;

        // Only accept the response if it matches what we're expecting
        if (
          pendingIsAll !== responseIsAll ||
          (!pendingIsAll && pendingWorkflowId !== responseWorkflowId)
        ) {
          console.log(
            '[WorkflowRuns] Ignoring stale getWorkflowRuns response:',
            'expected workflowId:',
            pendingWorkflowId,
            'received workflowId:',
            responseWorkflowId
          );
          // Don't process this response - wait for the correct one
          return;
        }
      }

      // Update date filter truncation state based on the backend flag.
      // We only show the warning when a date filter is currently active.
      const backendTruncated = Boolean(message.data?.truncated);
      dateFilterTruncated = backendTruncated && (!!dateFilterFrom || !!dateFilterTo);

      // Reset backend pagination cursor when a fresh runs payload arrives.
      // The backend always serves GitHub page 1 for getWorkflowRuns, so the
      // next page to request via loadMoreRuns is 2 as long as there are more
      // runs available on the server.
      nextBackendPage = hasMoreRuns() ? 2 : null;
      // Clear any paused page from a previous fetch session
      pausedBackendPage = null;

      // Get cache key for current workflow
      const cacheKey = getCacheKey();

      // If we have cached runs, merge them with new runs
      const cache = workflowRunsCache.get(cacheKey);
      if (cache && cache.runs.length > 0) {
        console.log(
          '[WorkflowRuns] Merging',
          cache.runs.length,
          'cached runs with',
          newRuns.length,
          'new runs'
        );
        runs = mergeRuns(cache.runs, newRuns);
      } else {
        runs = newRuns;
      }

      // Update total runs fetched counter
      totalRunsFetched = runs.length;

      // Check if cache merge caused us to exceed the max limit.
      // If so, stop progressive fetching by clearing nextBackendPage.
      // This prevents the UI from showing "Searching..." when we've already
      // hit the limit via cached runs.
      const effectiveMaxRuns = getMaxTotalRuns();
      if (totalRunsFetched >= effectiveMaxRuns && nextBackendPage !== null) {
        pausedBackendPage = nextBackendPage;
        nextBackendPage = null;
        // Set truncation flag only if there's an active date filter
        if (hasActiveDateFilter()) {
          dateFilterTruncated = true;
        }
      }

      // Save merged runs to cache
      saveToCache(cacheKey, runs, totalCount, repository);

      console.log(
        '[WorkflowRuns] handleMessage: Received getWorkflowRuns response:',
        'runs.length:',
        runs.length,
        'totalCount:',
        totalCount,
        'repository:',
        repository,
        'workflowFilter:',
        workflowFilter
      );

      // Log first few run paths for debugging
      if (runs.length > 0) {
        console.log(
          '[WorkflowRuns] Sample run paths:',
          runs.slice(0, 3).map((r) => ({ name: r.name, path: r.path }))
        );
      }

      // Check if we're in the initial load and should wait for filter messages
      // We wait for filter messages only if this is the first load (loading === true)
      // and we're not refreshing (refreshing === false) and NOT a manual workflow fetch
      const isInitialLoad = loading && !refreshing && !isManualWorkflowFetch;

      if (isManualWorkflowFetch) {
        // This is a manual workflow switch (user clicked dropdown) - apply filters immediately
        // No need to wait for filter messages since this is a user-initiated action
        console.log('[WorkflowRuns] Manual workflow fetch - applying filters immediately');
        isManualWorkflowFetch = false; // Reset the flag
        pendingWorkflowId = null; // Reset the pending workflow ID
        clearWorkflowFetchWatchdog(); // Clear watchdog - successful response received
        // IMPORTANT: Clear loading flags BEFORE filterRuns() so that
        // scheduleProgressiveFetchIfNeeded() can trigger progressive fetching
        // when filteredRuns.length is below the threshold.
        loading = false;
        refreshing = false;
        buildAvailableWorkflows();
        filterRuns();
        // Resume auto-refresh after successful workflow switch
        autoRefreshPaused = false;
        startAutoRefresh();
      } else if (isInitialLoad) {
        console.log(
          '[WorkflowRuns] Initial load detected - waiting for filter messages before finalizing'
        );
        waitingForInitialFilters = true;
        clearWorkflowFetchWatchdog(); // Clear watchdog - response received, waiting for filters

        // Set a timeout to finalize the load even if filter messages don't arrive
        // This prevents indefinite waiting if no filter messages are sent
        initialFilterTimeout = window.setTimeout(() => {
          console.log('[WorkflowRuns] Filter message timeout - finalizing initial load');
          finalizeInitialLoad();
        }, 500); // 500ms should be enough for filter messages to arrive

        // Don't call filterRuns() or clear loading state yet - wait for filter messages
      } else {
        // This is a refresh or subsequent load - apply filters immediately
        clearWorkflowFetchWatchdog(); // Clear watchdog - successful response received
        // IMPORTANT: Clear loading flags BEFORE filterRuns() so that
        // scheduleProgressiveFetchIfNeeded() can trigger progressive fetching
        // when filteredRuns.length is below the threshold.
        loading = false;
        refreshing = false;
        buildAvailableWorkflows();
        filterRuns();
      }
    } else if (message.type === 'getWorkflowRuns' && !message.success) {
      // Handle error case - reset loading states
      console.error('[WorkflowRuns] Failed to fetch workflow runs:', message.error);
      isManualWorkflowFetch = false;
      pendingWorkflowId = null;
      clearWorkflowFetchWatchdog(); // Clear watchdog - error response received
      loading = false;
      refreshing = false;
      // Resume auto-refresh after failed workflow fetch
      autoRefreshPaused = false;
      startAutoRefresh();
    } else if (message.type === 'getUserInfo' && message.success) {
      currentUsername = message.data?.login || '';
      userInfo = message.data || null;
    } else if (message.type === 'setWorkflowFilter' && message.success) {
      // Set the workflow filter from the backend (prefer workflow path)
      const wfPath = message.data?.workflowPath;
      const wfName = message.data?.workflowName;

      let resolvedWorkflowPath: string | null = null;
      let resolvedWorkflowName: string | null = null;

      if (typeof wfPath === 'string') {
        resolvedWorkflowPath = wfPath;
        resolvedWorkflowName =
          workflowPathToName.get(wfPath) || (typeof wfName === 'string' ? wfName : null);
      } else if (typeof wfName === 'string') {
        // Map name to path using current mapping (first match)
        const match = Array.from(workflowPathToName.entries()).find(([, name]) => name === wfName);
        resolvedWorkflowPath = match ? match[0] : null;
        resolvedWorkflowName = wfName;
      }

      if (resolvedWorkflowPath) {
        workflowFilter = resolvedWorkflowPath;
        // Reflect selection in the combobox input for clarity
        workflowSearchQuery = resolvedWorkflowName || '';
        isWorkflowSearchActive = false;
      } else {
        workflowFilter = 'all';
        workflowSearchQuery = '';
        isWorkflowSearchActive = false;
      }

      // Always reset pagination when the workflow context changes so the
      // first page of runs for the new workflow is shown.
      currentPage = 1;

      // When the panel is opened with explicit context (dispatch / "View Last Run"),
      // reset secondary filters to their defaults while keeping workflow/actor/bot filters.
      searchQuery = '';
      statusFilter = 'all';
      showWatchedOnly = false;
      showFavoritesOnly = false;

      if (dateFilterFrom || dateFilterTo) {
        clearDateFilter();
      }

      let requestedRunsForWorkflow = false;
      if (resolvedWorkflowPath && resolvedWorkflowPath !== 'all') {
        const workflowForContext = availableWorkflows.find(
          (workflow) => workflow.path === resolvedWorkflowPath
        );

        if (workflowForContext) {
          requestedRunsForWorkflow = true;
          // Cancel any pending initial filter timeout since we're starting a new load cycle
          // This prevents setActorFilter/setShowBotRuns from calling finalizeInitialLoad()
          // before the workflow-specific getWorkflowRuns response arrives
          if (waitingForInitialFilters) {
            console.log(
              '[WorkflowRuns] setWorkflowFilter: Cancelling initial filter wait - starting workflow-specific fetch'
            );
            if (initialFilterTimeout !== null) {
              clearTimeout(initialFilterTimeout);
              initialFilterTimeout = null;
            }
            waitingForInitialFilters = false;
          }
          requestRunsForWorkflow(workflowForContext);
        }
      }

      if (!requestedRunsForWorkflow) {
        // If we're waiting for initial filters, finalize the load now
        if (waitingForInitialFilters) {
          console.log('[WorkflowRuns] setWorkflowFilter received during initial load - finalizing');
          finalizeInitialLoad();
        } else {
          filterRuns();
        }
      }
    } else if (message.type === 'getCurrentBranch' && message.success) {
      currentBranch = message.data || null;
    } else if (message.type === 'getDefaultBranch' && message.success) {
      defaultBranch = message.data || 'main';
    } else if (message.type === 'checkBranchOnRemote' && message.success) {
      branchExistsOnRemote = message.data?.exists ?? false;
    } else if (message.type === 'setActorFilter' && message.success) {
      // Set the actor filter from the backend and maintain one-way coupling
      actorFilter = message.data?.actorFilter || 'all';

      // One-way coupling: "My Runs" forces unchecking bot runs
      if (actorFilter === 'me' && showBotRuns) {
        showBotRuns = false;
        console.log('[WorkflowRuns] Backend set Actor Filter to My Runs: disabling bot runs');
      }
      // "All Users" does NOT change bot runs checkbox

      // When the panel is opened with explicit context (dispatch / "View Last Run"),
      // reset secondary filters to their defaults while keeping workflow/actor/bot filters.
      searchQuery = '';
      statusFilter = 'all';
      showWatchedOnly = false;
      showFavoritesOnly = false;

      if (dateFilterFrom || dateFilterTo) {
        clearDateFilter();
      }

      // Skip filter application if we're waiting for a workflow-specific fetch
      // The filters will be applied when the getWorkflowRuns response arrives
      if (isManualWorkflowFetch) {
        console.log(
          '[WorkflowRuns] setActorFilter: skipping filterRuns - waiting for workflow-specific fetch'
        );
      } else if (waitingForInitialFilters) {
        // If we're waiting for initial filters, finalize the load now
        console.log('[WorkflowRuns] setActorFilter received during initial load - finalizing');
        finalizeInitialLoad();
      } else {
        filterRuns();
      }
    } else if (message.type === 'setShowBotRuns' && message.success) {
      // Set the show bot runs flag from the backend and maintain one-way coupling
      showBotRuns = message.data?.showBotRuns ?? false;

      // One-way coupling: checking bot runs forces "All Users"
      if (showBotRuns && actorFilter !== 'all') {
        actorFilter = 'all';
        console.log('[WorkflowRuns] Backend enabled Show Bot Runs: switching to All Users');
      }
      // Unchecking bot runs does NOT change actor filter

      // When the panel is opened with explicit context (dispatch / "View Last Run"),
      // reset secondary filters to their defaults while keeping workflow/actor/bot filters.
      searchQuery = '';
      statusFilter = 'all';
      showWatchedOnly = false;
      showFavoritesOnly = false;

      if (dateFilterFrom || dateFilterTo) {
        clearDateFilter();
      }

      // Skip filter application if we're waiting for a workflow-specific fetch
      // The filters will be applied when the getWorkflowRuns response arrives
      if (isManualWorkflowFetch) {
        console.log(
          '[WorkflowRuns] setShowBotRuns: skipping filterRuns - waiting for workflow-specific fetch'
        );
      } else if (waitingForInitialFilters) {
        // If we're waiting for initial filters, finalize the load now
        console.log('[WorkflowRuns] setShowBotRuns received during initial load - finalizing');
        finalizeInitialLoad();
      } else {
        filterRuns();
      }
    } else if (message.type === 'finalizeInitialLoad' && message.success) {
      // Backend is telling us to finalize the initial load immediately
      // This happens when the panel is opened without explicit filters
      console.log('[WorkflowRuns] Received finalizeInitialLoad message from backend');
      if (waitingForInitialFilters) {
        finalizeInitialLoad();
      }
    } else if (message.type === 'highlightRun' && message.data?.runId) {
      // Highlight newly dispatched run
      highlightedRunId = message.data.runId;
      // Auto-remove highlight after 30 seconds
      setTimeout(() => {
        highlightedRunId = null;
      }, 30000);
      // Refresh to get the new run
      setTimeout(() => {
        vscode.postMessage({ type: 'refreshWorkflowRuns' });
      }, 2000);
    } else if (message.type === 'confirmDispatch') {
      // Show rerun confirmation modal using the same visual language as the
      // Parameters modal (branch pill + parameter table).
      const data = message.data || {};
      const name: string | undefined = data.workflowName;
      dispatchConfirmTitle =
        name && name.trim().length > 0 ? `Rerun "${name}"?` : 'Rerun workflow?';
      dispatchConfirmBranch = data.branch || null;
      dispatchConfirmInputs = data.inputs || {};
      showDispatchConfirmModal = true;
    } else if (message.type === 'cancelWorkflowRunResponse') {
      const runId = message.data?.runId;
      console.log('[CancelWorkflow] Received cancelWorkflowRunResponse:', {
        runId,
        success: message.success,
        error: message.error,
      });

      if (runId) {
        if (message.success) {
          console.log('[CancelWorkflow] Successfully updated UI for cancelled run:', runId);
          // Mark as successfully cancelled
          cancellationState.cancelledRuns.add(runId);
          cancellationState.cancellingRuns.delete(runId);
          cancellationState = cancellationState; // Trigger reactivity

          // Update the run status in the local list without full refresh
          const run = runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'cancelled';
            run.conclusion = 'cancelled';
            runs = runs; // Trigger reactivity
          }
        } else {
          console.error('[CancelWorkflow] Cancellation failed for run:', runId, message.error);
          // Mark as failed
          cancellationState.failedCancellations.set(
            runId,
            message.error || 'Failed to cancel workflow'
          );
          cancellationState.cancellingRuns.delete(runId);
          cancellationState = cancellationState; // Trigger reactivity
        }
      } else {
        console.warn('[CancelWorkflow] Received response without runId:', message);
      }
    } else if (message.type === 'rerunWorkflowResponse') {
      const responseRunId: number | undefined = message.data?.runId;
      if (responseRunId) {
        // Clear loading state for this run now that the rerun request
        // has completed (successfully or not).
        rerunLoadingRunIds.delete(responseRunId);
        rerunLoadingRunIds = rerunLoadingRunIds;
      }
      if (message.success) {
        // Refresh runs to show the new run
        setTimeout(() => {
          vscode.postMessage({ type: 'refreshWorkflowRuns' });
        }, 2000);
      }
    } else if (message.type === 'getJobDetailsResponse') {
      // Handle response for fetching job details (for running jobs)
      const jobId = message.data?.jobId;
      if (jobId) {
        loadingJobSteps.delete(jobId);
        loadingJobSteps = loadingJobSteps; // Trigger reactivity
      }
      if (message.success && message.data?.job) {
        const job = message.data.job as WorkflowJob;
        // Find the run ID from the pending request context
        const runId = selectedJobRunIdForSteps;
        if (runId) {
          showJobStepsModalWithData(job, runId);
        }
      }
    } else if (message.type === 'checkJobLogsAvailabilityResponse') {
      // Handle response for checking job logs availability
      const jobId = message.data?.jobId;
      if (jobId) {
        loadingJobLogs.delete(jobId);
        loadingJobLogs = loadingJobLogs; // Trigger reactivity
      }
      // The actual log viewing is handled by the extension
    } else if (message.type === 'viewJobLogsResponse') {
      // Handle response for viewing raw job logs - clear loading state
      const jobId = message.data?.jobId;
      if (jobId) {
        loadingRawJobLogs.delete(jobId);
        loadingRawJobLogs = loadingRawJobLogs; // Trigger reactivity
      }
    } else if (message.type === 'viewJobLogsInteractiveResponse') {
      // Handle response for viewing interactive job logs - clear loading state
      const jobId = message.data?.jobId;
      if (jobId) {
        loadingJobLogs.delete(jobId);
        loadingJobLogs = loadingJobLogs; // Trigger reactivity
      }
    } else if (message.type === 'viewStepLogsResponse') {
      // Handle response for viewing step logs
      const jobId = message.data?.jobId;
      const stepNumber = message.data?.stepNumber;
      if (jobId && stepNumber !== undefined) {
        const key = `${jobId}-${stepNumber}`;
        loadingStepLogs.delete(key);
        loadingStepLogs = loadingStepLogs; // Trigger reactivity
      }
    } else if (message.type === 'compareJobLogsResponse') {
      // Handle response for log comparison - clear loading state
      loadingComparison = false;
    } else if (message.type === 'compareStepLogsResponse') {
      // Handle response for step log comparison - clear loading state
      loadingStepComparison = false;
    } else if (message.type === 'promptRerunWorkflowComplete') {
      const responseRunId: number | undefined = message.data?.runId;
      if (responseRunId) {
        // The rerun prompt flow (including any dispatch modal) has
        // finished, so clear the loading state even if no direct rerun
        // was triggered (e.g. user cancelled or chose a different path).
        rerunLoadingRunIds.delete(responseRunId);
        rerunLoadingRunIds = rerunLoadingRunIds;
      }
    } else if (message.type === 'loadMoreRuns' && message.success) {
      // Append new runs to existing list
      const newRuns = message.data?.runs || [];
      runs = [...runs, ...newRuns];
      totalCount = message.data?.totalCount || totalCount;
      repository = message.data?.repository || repository;
      loadingMore = false;

      // Advance backend pagination cursor if there are still more runs
      // available according to the server-side totalCount.
      nextBackendPage = hasMoreRuns() && nextBackendPage !== null ? nextBackendPage + 1 : null;

      // Rebuild available workflows with new runs
      buildAvailableWorkflows();

      // Re-apply filters and keep the current page slice in sync.
      filterRuns();
    } else if (message.type === 'loadMoreRuns' && !message.success) {
      loadingMore = false;
      // On error, do not advance nextBackendPage so the user can retry.
    } else if (message.type === 'progressiveFetchRunsResponse') {
      progressiveFetching = false;

      // Check if this response is for a stale workflow switch (ignore if so)
      const responseGeneration = message.data?.generation;
      if (responseGeneration !== undefined && responseGeneration !== workflowSwitchGeneration) {
        console.log(
          '[WorkflowRuns] Ignoring stale progressiveFetchRunsResponse for generation',
          responseGeneration,
          'current:',
          workflowSwitchGeneration
        );
        // Don't modify any other state for stale responses - just exit early
        return;
      }

      if (message.success && message.data) {
        const newRuns = message.data.runs || [];
        const fetchedPages = message.data.fetchedPages || 0;

        if (newRuns.length > 0) {
          // Merge new runs with existing runs
          runs = [...runs, ...newRuns];
          totalRunsFetched = runs.length;

          // Update backend pagination cursor
          if (nextBackendPage) {
            nextBackendPage += fetchedPages;
          }

          const effectiveMaxRuns = getMaxTotalRuns();

          // Check if we've hit the active safety limit
          if (totalRunsFetched >= effectiveMaxRuns) {
            // Only set truncation flag if there's an active date filter
            dateFilterTruncated = hasActiveDateFilter();
            // Save the current page so we can resume if the user increases the limit
            pausedBackendPage = nextBackendPage;
            nextBackendPage = null; // Stop further fetching
          }

          // NOTE: We intentionally skip buildAvailableWorkflows() here because:
          // 1. Workflow definitions don't change during progressive fetch
          // 2. Calling it on every page (100 runs at a time) is expensive
          // 3. It causes visible UI stuttering during rapid fetches
          // The workflows were already built during initial load.

          // Re-apply filters
          filterRuns();

          // After incorporating the new runs, decide whether we still need
          // more data for the current page (or to prefetch the next page).
          scheduleProgressiveFetchIfNeeded();
        } else {
          // No more runs available from GitHub - stop fetching
          nextBackendPage = null;
          pausedBackendPage = null; // Clear paused page since there's nothing more
          // Re-apply filters to ensure UI updates and shows "no matches" if applicable
          filterRuns();
        }
      } else {
        // Response failed or had no data - reset fetching state
        // Don't clear nextBackendPage so the user can retry, but ensure UI reflects
        // that we're not actively searching anymore (progressiveFetching is already false)
        console.warn(
          '[WorkflowRuns] progressiveFetchRunsResponse failed or had no data:',
          message.error || 'No data'
        );
        // Re-apply filters to update the UI state
        filterRuns();
      }
    } else if (message.type === 'getWorkflowRunJobs') {
      const runId = message.data?.runId;
      if (runId) {
        loadingJobs.delete(runId);
        loadingJobs = loadingJobs; // Trigger reactivity

        if (message.success) {
          const jobs = message.data?.jobs || [];
          // Use requestAnimationFrame to batch DOM updates and prevent mid-render corruption
          requestAnimationFrame(() => {
            runJobs.set(runId, jobs);
            // Increment render key to force DOM re-creation
            jobsRenderKey.set(runId, (jobsRenderKey.get(runId) || 0) + 1);
            jobsRenderKey = jobsRenderKey;
            runJobs = runJobs; // Trigger reactivity
          });

          // Update job steps modal if it's open and showing a job from this run
          if (
            selectedJobForStepsModal &&
            selectedJobRunIdForSteps === runId &&
            selectedJobForStepsModal.jobId
          ) {
            const updatedJob = jobs.find(
              (j: WorkflowJob) => j.id === selectedJobForStepsModal?.jobId
            );
            if (updatedJob) {
              // Update the modal with fresh job data
              showJobStepsModalWithData(updatedJob, runId);
            }
          }
        }
      }
    } else if (message.type === 'getJobDependenciesResponse') {
      // Handle job dependencies response for graph visualization
      const runId = message.data?.runId;
      if (runId) {
        loadingJobDependencies.delete(runId);
        loadingJobDependencies = loadingJobDependencies; // Trigger reactivity

        if (message.success) {
          // Store job definitions for this run
          runJobDefinitions.set(runId, message.data?.jobDefinitions || []);
          runJobDefinitions = runJobDefinitions; // Trigger reactivity

          // Also update jobs if included in response
          if (message.data?.jobs) {
            const jobs = message.data.jobs;
            // Use requestAnimationFrame to batch DOM updates and prevent mid-render corruption
            requestAnimationFrame(() => {
              runJobs.set(runId, jobs);
              // Increment render key to force DOM re-creation
              jobsRenderKey.set(runId, (jobsRenderKey.get(runId) || 0) + 1);
              jobsRenderKey = jobsRenderKey;
              runJobs = runJobs; // Trigger reactivity
            });

            loadingJobs.delete(runId);
            loadingJobs = loadingJobs; // Trigger reactivity

            // Update job steps modal if it's open and showing a job from this run
            if (
              selectedJobForStepsModal &&
              selectedJobRunIdForSteps === runId &&
              selectedJobForStepsModal.jobId
            ) {
              const updatedJob = jobs.find(
                (j: WorkflowJob) => j.id === selectedJobForStepsModal?.jobId
              );
              if (updatedJob) {
                // Update the modal with fresh job data
                showJobStepsModalWithData(updatedJob, runId);
              }
            }
          }
        } else {
          console.error('[WorkflowRuns] Failed to fetch job dependencies:', message.error);
        }
      }
    } else if (message.type === 'getWorkflowRunArtifacts') {
      const runId = message.data?.runId;
      if (runId) {
        loadingArtifacts.delete(runId);
        loadingArtifacts = loadingArtifacts; // Trigger reactivity

        if (message.success) {
          const artifacts = message.data?.artifacts || [];
          // Use requestAnimationFrame to batch DOM updates and prevent mid-render corruption
          requestAnimationFrame(() => {
            runArtifacts.set(runId, artifacts);
            // Increment render key to force DOM re-creation
            artifactsRenderKey.set(runId, (artifactsRenderKey.get(runId) || 0) + 1);
            artifactsRenderKey = artifactsRenderKey;
            runArtifacts = runArtifacts; // Trigger reactivity
          });
        }
      }
    } else if (message.type === 'getRunParametersResponse') {
      if (!showParametersModal) {
        return;
      }

      const responseRunId = typeof message.data?.runId === 'number' ? message.data.runId : null;

      // Ignore responses that don't match the currently open parameters modal.
      if (
        parametersModalRunId !== null &&
        responseRunId !== null &&
        responseRunId !== parametersModalRunId
      ) {
        return;
      }

      if (!message.success) {
        showToast(message.error || 'Failed to load run parameters.', 'error', 4000);
        return;
      }

      if (!message.data?.found) {
        parametersModalInputs = null;
        parametersModalNotFound = true;
        return;
      }

      const { workflowFilename, branch, inputs } = message.data;
      parametersModalTitle = workflowFilename || parametersModalTitle || 'Run parameters';
      parametersModalBranch = branch ?? parametersModalBranch;
      parametersModalInputs = inputs || {};
      parametersModalNotFound = false;
    } else if (message.type === 'getMarkedWorkflowsResponse' && message.success) {
      markedWorkflows = message.data || [];
      filterRuns();
    } else if (message.type === 'toggleWorkflowMarkedResponse' && message.success) {
      const { workflowPath, isMarked } = message.data || {};
      if (workflowPath) {
        if (isMarked) {
          markedWorkflows = [...markedWorkflows, workflowPath];
        } else {
          markedWorkflows = markedWorkflows.filter((p) => p !== workflowPath);

          // When the last favorite is removed, reset the "Favorites Only" filter
          // to prevent the checkbox from being checked but disabled
          if (markedWorkflows.length === 0 && showFavoritesOnly) {
            showFavoritesOnly = false;
          }
        }
        // Trigger reactivity by reassigning
        markedWorkflows = markedWorkflows;
        filterAvailableWorkflows();
        filterRuns();
      }
    } else if (message.type === 'getWatchedRunsResponse' && message.success) {
      const runIds = message.data || [];
      watchedRuns = new Set(runIds);
      console.log(
        '[WorkflowRuns] Loaded watched runs from backend:',
        runIds.length,
        'watched run IDs:',
        runIds
      );
      filterRuns();
    } else if (message.type === 'loadWatchedRuns') {
      // Load watched runs from storage on panel initialization
      if (message.success && message.data) {
        const { watchedRunIds } = message.data as { watchedRunIds: number[] };
        watchedRuns = new Set(watchedRunIds);
        console.log('[WorkflowRuns] Loaded', watchedRuns.size, 'watched runs from storage');
        filterRuns();
      } else if (message.error) {
        console.error('[WorkflowRuns] Failed to load watched runs:', message.error);
      }
    } else if (message.type === 'toggleRunWatchResponse') {
      const { runId, isWatched } = (message.data || {}) as {
        runId?: number;
        isWatched?: boolean;
      };

      if (message.success && typeof runId === 'number') {
        const wasWatched = watchedRuns.has(runId);
        if (isWatched && !wasWatched) {
          watchedRuns.add(runId);
          watchedRuns = watchedRuns; // Trigger reactivity
        } else if (!isWatched && wasWatched) {
          watchedRuns.delete(runId);
          watchedRuns = watchedRuns; // Trigger reactivity

          // When the last watch is removed, reset the "Watched Runs Only" filter
          // to prevent the checkbox from being checked but disabled
          if (watchedRuns.size === 0 && showWatchedOnly) {
            showWatchedOnly = false;
          }
        }

        console.log(
          '[WorkflowRuns] toggleRunWatchResponse received for runId',
          runId,
          'isWatched:',
          isWatched,
          'total watched:',
          watchedRuns.size
        );
        filterRuns();
      } else if (message.error) {
        // If there was an error (e.g., max limit reached), revert the local state
        const { runId: erroredRunId } = message.data || {};
        if (erroredRunId && watchedRuns.has(erroredRunId)) {
          watchedRuns.delete(erroredRunId);
          watchedRuns = watchedRuns; // Trigger reactivity
        }
        showToast(message.error, 'error', 5000);
      }
    } else if (message.type === 'unwatchAllRunsResponse') {
      if (message.success) {
        const clearedCount = message.data?.clearedCount ?? 0;
        watchedRuns = new Set();
        showWatchedOnly = false;
        filterRuns();
        if (clearedCount > 0) {
          const label =
            clearedCount === 1
              ? 'Stopped watching 1 run.'
              : `Stopped watching ${clearedCount} runs.`;
          showToast(label, 'info', 2500);
        }
      } else if (message.error) {
        showToast(message.error, 'error', 4000);
      }
    } else if (message.type === 'backgroundRefreshWatchedRunsResponse') {
      // Clear the in-progress flag since the background refresh has completed
      isBackgroundRefreshInProgress = false;

      // Log if refresh was skipped or failed (for debugging)
      if (!message.success) {
        const reason = message.skipped || 'unknown error';
        console.log('[WorkflowRuns] Background refresh watched runs skipped/failed:', reason);
      }

      if (message.success && message.data) {
        const updatedRuns = message.data.runs || [];
        const rateLimitInfo = message.data.rateLimitInfo as
          | { remaining: number; limit: number; reset: number }
          | undefined;

        console.log(
          '[WorkflowRuns] Background refresh: received',
          updatedRuns.length,
          'watched runs',
          rateLimitInfo
            ? `(Rate limit: ${rateLimitInfo.remaining}/${rateLimitInfo.limit})`
            : '(no rate limit info)'
        );

        // Update rate limit tracking from API response
        if (rateLimitInfo) {
          updateRateLimit(rateLimitInfo);
        }

        // Skip processing if we're in the middle of a workflow switch
        // This prevents stale status changes from appearing during the transition
        if (isManualWorkflowFetch || loading) {
          console.log('[WorkflowRuns] Skipping watched runs refresh - workflow switch in progress');
          return;
        }

        if (!updatedRuns.length) {
          return;
        }

        // Update watched runs in the dataset, tracking status changes for
        // notifications. Also add any watched runs not yet present so that
        // "Watched Runs Only" can be populated without a full pagination.
        const updatedRunsMap = new Map(updatedRuns.map((run: WorkflowRun) => [run.id, run]));
        const existingIds = new Set(runs.map((run) => run.id));

        runs = runs.map((run) => {
          if (updatedRunsMap.has(run.id)) {
            const updatedRun = updatedRunsMap.get(run.id);
            // Track status changes for inline notification
            if (
              updatedRun &&
              (run.status !== updatedRun.status || run.conclusion !== updatedRun.conclusion)
            ) {
              console.log(
                '[WorkflowRuns] Background refresh: run',
                run.id,
                'status changed from',
                run.status,
                'to',
                updatedRun.status
              );

              // Track status change for inline message
              statusChanges.set(run.id, {
                oldStatus: run.status,
                newStatus: updatedRun.status,
                timestamp: Date.now(),
              });
              statusChanges = statusChanges; // Trigger reactivity

              // Auto-clear status change message after 10 seconds
              setTimeout(() => {
                statusChanges.delete(run.id);
                statusChanges = statusChanges;
              }, 10000);
            }
            // Always return the updated run to get latest data (e.g., updated_at)
            return updatedRun;
          }
          return run;
        });

        // Add any watched runs that are not yet part of the dataset so that
        // they can appear in "Watched Runs Only" without a full reload.
        const newRunsToAdd: WorkflowRun[] = [];
        for (const updatedRun of updatedRuns as WorkflowRun[]) {
          if (!existingIds.has(updatedRun.id)) {
            newRunsToAdd.push(updatedRun);
          }
        }

        if (newRunsToAdd.length > 0) {
          runs = [...runs, ...newRunsToAdd];
          console.log(
            '[WorkflowRuns] Background refresh: added',
            newRunsToAdd.length,
            'new watched runs to dataset'
          );
        }

        // Always rebuild workflow options and re-filter to update the UI,
        // matching the behavior of backgroundRefreshAllRunsResponse.
        buildAvailableWorkflows();
        filterRuns();

        // Recalculate adaptive refresh based on updated run states
        recalculateAdaptiveRefresh();

        // Refresh jobs for watched runs that have visible job UI
        // Limit the number of concurrent requests to avoid API overload
        let jobRefreshCount = 0;
        const MAX_JOB_REFRESHES_PER_CYCLE = 10;
        const refreshedRunIds = new Set<number>();

        for (const run of updatedRuns as WorkflowRun[]) {
          if (jobRefreshCount >= MAX_JOB_REFRESHES_PER_CYCLE) {
            break;
          }

          const runId = run.id;
          const hasVisibleJobUI =
            showDependencyGraph.has(runId) ||
            expandedRuns.has(runId) ||
            showSummary.has(runId) ||
            runJobs.has(runId);

          const needsJobRefresh =
            // Only refresh if run has visible job UI
            hasVisibleJobUI &&
            (run.status === 'in_progress' || run.status === 'queued' || run.status === 'completed');

          if (needsJobRefresh) {
            vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId } });
            refreshedRunIds.add(runId);
            jobRefreshCount++;
          }
        }

        // Also refresh jobs if the modal is open showing a job from a watched run
        if (
          selectedJobForStepsModal &&
          selectedJobRunIdForSteps &&
          jobRefreshCount < MAX_JOB_REFRESHES_PER_CYCLE &&
          !refreshedRunIds.has(selectedJobRunIdForSteps)
        ) {
          const modalRunUpdated = updatedRuns.find(
            (r: WorkflowRun) => r.id === selectedJobRunIdForSteps
          );
          if (modalRunUpdated) {
            vscode.postMessage({
              type: 'getWorkflowRunJobs',
              data: { runId: selectedJobRunIdForSteps },
            });
          }
        }
      }
    } else if (message.type === 'backgroundRefreshAllRunsResponse') {
      // Clear the in-progress flag since the background refresh has completed
      isBackgroundRefreshInProgress = false;

      // Log if refresh was skipped or failed (for debugging)
      if (!message.success) {
        const reason = message.skipped || 'unknown error';
        console.log('[WorkflowRuns] Background refresh skipped/failed:', reason);
      }

      if (message.success && message.data) {
        const newRuns = message.data.runs || [];
        console.log('[WorkflowRuns] Background refresh all: received', newRuns.length, 'runs');

        // Update rate limit tracking if included in response
        if (message.data.rateLimitInfo) {
          updateRateLimit(message.data.rateLimitInfo);
        }

        // Skip processing if we're in the middle of a workflow switch
        // This prevents stale notifications from appearing during the transition
        if (isManualWorkflowFetch || loading) {
          console.log('[WorkflowRuns] Skipping background refresh - workflow switch in progress');
          return;
        }

        // Create a map of new runs by ID for quick lookup
        const newRunsMap = new Map(newRuns.map((run: WorkflowRun) => [run.id, run]));

        // Track changes for notification
        let updatedCount = 0;
        let newRunsCount = 0;

        /**
         * Helper to check if a run matches ALL currently active filters.
         * This ensures notifications only appear for runs the user wants to see.
         */
        const runMatchesActiveFilters = (run: WorkflowRun): boolean => {
          // Check workflow filter
          if (workflowFilter !== 'all') {
            const runPath = run.path?.split('@')[0] || '';
            if (runPath !== workflowFilter) {
              return false;
            }
          }

          // Check actor filter
          if (actorFilter === 'me' && currentUsername) {
            if (run.actor?.login !== currentUsername) {
              return false;
            }
          } else if (actorFilter !== 'all' && actorFilter !== 'me') {
            if (run.actor?.login !== actorFilter) {
              return false;
            }
          }

          // Check bot filter - if showBotRuns is false, exclude bot runs
          if (!showBotRuns && run.actor?.login) {
            const login = run.actor.login.toLowerCase();
            if (login.includes('[bot]') || login.endsWith('-bot') || login.includes('bot[')) {
              return false;
            }
          }

          // Note: Status filter is intentionally NOT checked here for the initial run match
          // because we want to show notifications when a run's status CHANGES to match
          // the filter (e.g., show "completed" notification when filter is set to "completed")
          // The status check is done separately based on the NEW status after the change.

          return true;
        };

        /**
         * Helper to check if a run's NEW status matches the current status filter.
         * Used to determine if a status change notification should be shown.
         */
        const runStatusMatchesFilter = (newStatus: string, newConclusion?: string): boolean => {
          if (statusFilter === 'all') {
            return true;
          }
          if (statusFilter === 'completed') {
            return newStatus === 'completed' && newConclusion === 'success';
          }
          if (statusFilter === 'failed') {
            return newStatus === 'completed' && newConclusion === 'failure';
          }
          if (statusFilter === 'in_progress') {
            return newStatus === 'in_progress';
          }
          if (statusFilter === 'queued') {
            return newStatus === 'queued';
          }
          if (statusFilter === 'cancelled') {
            return newStatus === 'completed' && newConclusion === 'cancelled';
          }
          return true;
        };

        // Update existing runs and track changes
        const workflowStatusChanges: Array<{
          name: string;
          status: string;
          conclusion?: string;
          matchesActiveFilters: boolean;
        }> = [];
        // Track runs that just completed so we can refresh their job statuses
        const justCompletedRunIds = new Set<number>();
        const existingRunIds = new Set(runs.map((r) => r.id));
        runs = runs.map((run) => {
          if (newRunsMap.has(run.id)) {
            const newRun = newRunsMap.get(run.id);
            // Check if status or conclusion has changed
            if (newRun && (run.status !== newRun.status || run.conclusion !== newRun.conclusion)) {
              updatedCount++;
              console.log(
                '[WorkflowRuns] Background refresh all: run',
                run.id,
                'status changed from',
                run.status,
                'to',
                newRun.status
              );

              // Only notify for significant workflow state transitions
              const isWorkflowStarted = run.status === 'queued' && newRun.status === 'in_progress';
              const isWorkflowCompleted =
                run.status === 'in_progress' && newRun.status === 'completed';

              // Track just-completed runs so we can refresh their job statuses
              if (isWorkflowCompleted) {
                justCompletedRunIds.add(run.id);
              }

              if (isWorkflowStarted || isWorkflowCompleted) {
                // Check if run matches all active filters (workflow, actor, bot)
                // AND if the NEW status matches the status filter
                const matchesFilters =
                  runMatchesActiveFilters(newRun) &&
                  runStatusMatchesFilter(newRun.status, newRun.conclusion);

                workflowStatusChanges.push({
                  name: newRun.name || `Run #${newRun.id}`,
                  status: newRun.status,
                  conclusion: newRun.conclusion,
                  matchesActiveFilters: matchesFilters,
                });
              }

              // Track status change for inline message
              statusChanges.set(run.id, {
                oldStatus: run.status,
                newStatus: newRun.status,
                timestamp: Date.now(),
              });
              statusChanges = statusChanges; // Trigger reactivity

              // Auto-clear status change message after 10 seconds
              setTimeout(() => {
                statusChanges.delete(run.id);
                statusChanges = statusChanges;
              }, 10000);

              return newRun;
            }
            // Even if no status change, update the run to get latest data
            return newRun;
          }
          return run;
        });

        // Add any new runs that weren't in the existing list
        // IMPORTANT: Batch all new runs into a single array assignment to avoid
        // triggering excessive Svelte reactivity that can cause "Invalid array length" errors
        const newRunsToAdd: WorkflowRun[] = [];
        for (const newRun of newRuns) {
          if (!existingRunIds.has(newRun.id)) {
            newRunsToAdd.push(newRun);
            newRunsCount++;
            // New runs are also workflow-level events
            // Check if run matches all active filters (workflow, actor, bot)
            // For new runs, we check if their current status matches the status filter
            const matchesFilters =
              runMatchesActiveFilters(newRun) &&
              runStatusMatchesFilter(newRun.status, newRun.conclusion);

            workflowStatusChanges.push({
              name: newRun.name || `Run #${newRun.id}`,
              status: 'new',
              conclusion: undefined,
              matchesActiveFilters: matchesFilters,
            });
          }
        }
        // Single reactive assignment for all new runs
        if (newRunsToAdd.length > 0) {
          runs = [...newRunsToAdd, ...runs];
        }

        // Instead of showing "X runs updated", show specific workflow events
        // Only show if workflow toast notifications are enabled
        // Filter to only show notifications for runs that match all active filters
        const relevantChanges = workflowStatusChanges.filter((c) => c.matchesActiveFilters);
        if (showWorkflowToastNotifications && relevantChanges.length > 0) {
          for (const change of relevantChanges) {
            let message = '';
            if (change.status === 'new') {
              message = `New workflow: ${change.name}`;
            } else if (change.status === 'in_progress') {
              message = `Workflow started: ${change.name}`;
            } else if (change.status === 'completed') {
              const conclusionText =
                change.conclusion === 'success'
                  ? '✓'
                  : change.conclusion === 'failure'
                    ? '✗'
                    : change.conclusion || '';
              message = `Workflow completed ${conclusionText}: ${change.name}`;
            }
            if (message) {
              showToast(message, 'info', 3000);
            }
          }
        }

        // Re-filter to update the UI
        filterRuns();

        // Recalculate adaptive refresh based on updated run states
        recalculateAdaptiveRefresh();

        // Refresh jobs only for VISIBLE runs to avoid overwhelming the API
        // This ensures the mini progress indicator and graph stay updated
        // while limiting the number of concurrent API calls
        const visibleRunIds = new Set(visibleRuns.map((r) => r.id));
        let jobRefreshCount = 0;
        const MAX_JOB_REFRESHES_PER_CYCLE = 10; // Limit concurrent job refreshes

        for (const run of visibleRuns) {
          if (jobRefreshCount >= MAX_JOB_REFRESHES_PER_CYCLE) {
            break; // Don't send too many requests at once
          }

          const runId = run.id;
          const needsJobRefresh =
            // Only refresh if run has visible job UI (expanded, graph, or summary)
            (run.status === 'in_progress' || run.status === 'queued') &&
            (showDependencyGraph.has(runId) ||
              expandedRuns.has(runId) ||
              showSummary.has(runId) ||
              runJobs.has(runId));

          // Also refresh just-completed runs if they have jobs visible
          const isJustCompleted =
            justCompletedRunIds.has(runId) &&
            (showDependencyGraph.has(runId) ||
              expandedRuns.has(runId) ||
              showSummary.has(runId) ||
              runJobs.has(runId));

          if (needsJobRefresh || isJustCompleted) {
            vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId } });
            jobRefreshCount++;
          }
        }

        // Also refresh jobs if the modal is open showing a job from any updated run
        // (even if the run has completed, so the modal shows updated status)
        if (
          selectedJobForStepsModal &&
          selectedJobRunIdForSteps &&
          jobRefreshCount < MAX_JOB_REFRESHES_PER_CYCLE
        ) {
          const modalRunUpdated = newRunsMap.has(selectedJobRunIdForSteps);
          // Check if already refreshed above (only if in visibleRuns)
          const alreadyRefreshed = visibleRunIds.has(selectedJobRunIdForSteps);
          if (modalRunUpdated && !alreadyRefreshed) {
            vscode.postMessage({
              type: 'getWorkflowRunJobs',
              data: { runId: selectedJobRunIdForSteps },
            });
          }
        }
      }
    } else if (message.type === 'getWorkflowIdResponse') {
      if (message.success && message.data) {
        const { workflowId } = message.data;
        console.log('[WorkflowRuns] Received workflow ID:', workflowId, 'requesting runs...');
        // Track the expected workflowId to ignore stale responses
        pendingWorkflowId = workflowId;
        // Note: Don't clear watchdog here - we're still waiting for getWorkflowRuns response
        // Now request runs for this workflow
        vscode.postMessage({
          type: 'getWorkflowRuns',
          data: { workflowId },
        });
      } else {
        console.error('[WorkflowRuns] Failed to get workflow ID:', message.error);
        // Reset the manual workflow fetch flag since we won't get a getWorkflowRuns response
        isManualWorkflowFetch = false;
        pendingWorkflowId = null;
        clearWorkflowFetchWatchdog(); // Clear watchdog - error response received
        // Fall back to local filtering and clear loading state
        filterRuns();
        loading = false;
      }
    } else if (message.type === 'stopAutoRefresh') {
      // Panel is no longer visible, stop auto-refresh
      console.log('[WorkflowRuns] Panel not visible, stopping auto-refresh');
      stopAutoRefresh();
      // Note: We do NOT reset autoRefreshSeconds here anymore.
      // The persisted value will be restored when the panel becomes visible again.
    } else if (message.type === 'restoreAutoRefresh') {
      // Panel became visible again, restore the persisted auto-refresh setting
      if (message.success && message.data) {
        const {
          autoRefreshSeconds: restoredSeconds,
          adaptiveRefreshEnabled: restoredAdaptiveEnabled,
          adaptiveFastRefreshSeconds: restoredAdaptiveFast,
        } = message.data as {
          autoRefreshSeconds?: number;
          adaptiveRefreshEnabled?: boolean;
          adaptiveFastRefreshSeconds?: number;
        };
        if (
          typeof restoredSeconds === 'number' &&
          Number.isFinite(restoredSeconds) &&
          restoredSeconds >= 0
        ) {
          console.log('[WorkflowRuns] Restoring auto-refresh to', restoredSeconds, 'seconds');
          autoRefreshSeconds = restoredSeconds;
          autoRefreshIndex = getAutoRefreshOptionIndex(autoRefreshSeconds);
        }
        // Restore adaptive refresh settings
        if (typeof restoredAdaptiveEnabled === 'boolean') {
          adaptiveRefreshEnabled = restoredAdaptiveEnabled;
        }
        if (
          typeof restoredAdaptiveFast === 'number' &&
          Number.isFinite(restoredAdaptiveFast) &&
          restoredAdaptiveFast >= MIN_ADAPTIVE_FAST_REFRESH_SECONDS &&
          restoredAdaptiveFast <= MAX_ADAPTIVE_FAST_REFRESH_SECONDS
        ) {
          adaptiveFastRefreshSeconds = restoredAdaptiveFast;
        }
        startAutoRefresh();
      }
    } else if (message.type === 'getFilterState') {
      // Extension is requesting current filter state
      console.log('[WorkflowRuns] Sending filter state to extension');
      vscode.postMessage({
        type: 'filterStateResponse',
        success: true,
        data: {
          workflowFilter,
          actorFilter,
          showBotRuns,
          dateFilterFrom,
          dateFilterTo,
          statusFilter,
        },
      });
    } else if (message.type === 'clearFilters') {
      // Extension is requesting to clear filters to show all runs
      console.log('[WorkflowRuns] Clearing filters to show all runs');
      actorFilter = 'all';
      statusFilter = 'all';
      dateFilterFrom = '';
      dateFilterTo = '';
      // Keep workflow filter as is and re-apply filters with the relaxed
      // state so any newly-dispatched or rerun workflow becomes visible.
      filterRuns();
    } else if (message.type === 'getGitHubSummaryResponse') {
      // Handle GitHub summary response - convert markdown to HTML for display
      gitHubSummaryLoading = false;

      if (message.success && message.data) {
        // Store both raw markdown (for tab view) and HTML (for modal)
        const markdownContent = message.data.markdownContent || '';
        gitHubSummaryMarkdown = markdownContent;
        gitHubSummaryContent = markdownContent ? markdownToHtml(markdownContent) : '';
        gitHubSummaryHtmlUrl = message.data.htmlUrl || '';
        gitHubSummaryError = '';
      } else {
        gitHubSummaryError = message.error || 'Failed to load GitHub summary';
        gitHubSummaryContent = '';
        gitHubSummaryMarkdown = '';
      }
    } else if (message.type === 'getJobSummaryResponse') {
      // Handle job summary response
      const jobId = message.data?.jobId;
      const jobName = message.data?.jobName || 'Job Summary';
      const fromStepsModal = jobSummaryFromStepsModal;

      // Reset the flag
      jobSummaryFromStepsModal = false;

      if (jobId) {
        loadingJobSummary.delete(jobId);
        loadingJobSummary = loadingJobSummary;
      }

      if (message.success && message.data) {
        const markdownContent = message.data.markdownContent || '';
        const htmlContent = markdownContent ? markdownToHtml(markdownContent) : '';
        const htmlUrl = message.data.htmlUrl || '';

        if (fromStepsModal) {
          // From steps modal: open summary in editor tab (keep modal open)
          vscode.postMessage({
            type: 'openGitHubSummaryInTab',
            data: {
              runId: 0,
              runName: jobName,
              markdownContent: markdownContent,
              htmlContent: htmlContent,
              htmlUrl: htmlUrl,
            },
          });
        } else {
          // From job view: show in modal (existing behavior)
          // Close the JobStepsModal if it's open (so summary modal can be shown)
          if (selectedJobForStepsModal) {
            selectedJobForStepsModal = null;
            selectedJobRunIdForSteps = null;
          }

          // Store both raw markdown (for tab view) and HTML (for modal)
          gitHubSummaryMarkdown = markdownContent;
          gitHubSummaryContent = htmlContent;
          gitHubSummaryHtmlUrl = htmlUrl;
          gitHubSummaryError = '';
          gitHubSummaryModalRunId = null; // Job summary, not run summary
          showGitHubSummaryModal = true;
          gitHubSummaryLoading = false;
        }
      } else {
        showToast(message.error || 'Failed to load job summary', 'error', 3000);
      }
    } else if (message.type === 'openGitHubSummaryInTabResponse') {
      // Handle response from opening summary in tab
      if (message.success) {
        showToast('Summary opened in new tab', 'info', 2000);
      } else {
        showToast(message.error || 'Failed to open summary in tab', 'error', 3000);
      }
    }
  }

  type FilterComputationOptions = {
    skipStatus?: boolean;
    skipWatchedOnly?: boolean;
    skipFavoritesOnly?: boolean;
    skipWorkflow?: boolean;
    skipDate?: boolean;
    skipSearch?: boolean;
    skipActor?: boolean;
    skipBot?: boolean;
  };

  /**
   * Apply all filters to the in-memory runs and return the filtered list.
   * Optimized to use a single pass over the array for better performance with large datasets.
   * Accepts options to temporarily skip specific filters (used for smart suggestions).
   *
   * Includes defensive checks to prevent "Invalid array length" errors.
   */
  function applyFiltersToRuns(options: FilterComputationOptions = {}): WorkflowRun[] {
    // Defensive check: ensure runs is a valid array
    if (!Array.isArray(runs)) {
      console.warn('[WorkflowRuns] applyFiltersToRuns: runs is not an array, returning empty');
      return [];
    }

    // Defensive check: limit array size to prevent memory issues
    const MAX_SAFE_ARRAY_LENGTH = 100000;
    if (runs.length > MAX_SAFE_ARRAY_LENGTH) {
      console.warn(
        '[WorkflowRuns] applyFiltersToRuns: runs array too large (',
        runs.length,
        '), truncating to',
        MAX_SAFE_ARRAY_LENGTH
      );
      runs = runs.slice(0, MAX_SAFE_ARRAY_LENGTH);
    }

    const {
      skipStatus,
      skipWatchedOnly,
      skipFavoritesOnly,
      skipWorkflow,
      skipDate,
      skipSearch,
      skipActor,
      skipBot,
    } = options;

    // When "Watched Runs Only" is enabled (and not explicitly skipped), ignore
    // ALL other filters and show only watched runs present in the current dataset.
    if (showWatchedOnly && !skipWatchedOnly && watchedRuns.size > 0) {
      const watchedFiltered = runs.filter((run) => watchedRuns.has(run.id));
      // Sort by created_at descending (most recent first)
      watchedFiltered.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
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

    // Pre-compute filter criteria to avoid recomputation per item
    const applyBotFilter = !skipBot && !showBotRuns;
    const applyActorFilter =
      !skipActor &&
      ((actorFilter === 'me' && currentUsername) ||
        (actorFilter !== 'all' && actorFilter !== 'me'));
    const targetActor = actorFilter === 'me' ? currentUsername : actorFilter;
    const applyFavoritesFilter =
      !skipFavoritesOnly && showFavoritesOnly && markedWorkflows.length > 0;
    const favoritesSet = applyFavoritesFilter ? new Set(markedWorkflows) : null;
    const applyWorkflowFilter = !skipWorkflow && workflowFilter !== 'all';
    const applySearchFilter = !skipSearch && searchQuery.trim();
    const searchQueryLower = applySearchFilter ? searchQuery.toLowerCase() : '';
    const applyStatusFilter = !skipStatus && statusFilter !== 'all';

    // Pre-compute date filter criteria
    const applyDateFilter = !skipDate && (dateFilterFrom || dateFilterTo);
    let fromDate: Date | null = null;
    let toDate: Date | null = null;
    let hasValidFrom = false;
    let hasValidTo = false;

    if (applyDateFilter) {
      fromDate = dateFilterFrom ? parseDateTimeLocal(dateFilterFrom) : null;
      toDate = dateFilterTo ? parseDateTimeLocal(dateFilterTo) : null;
      hasValidFrom = !!fromDate && !Number.isNaN(fromDate.getTime());
      hasValidTo = !!toDate && !Number.isNaN(toDate.getTime());
    }

    // Single-pass filter combining all criteria for better performance
    // This reduces the number of iterations from 7-8 passes to 1 pass
    const filtered = runs.filter((run) => {
      // Bot filter - exclude bot runs by default
      if (applyBotFilter && run.actor.login.endsWith('[bot]')) {
        return false;
      }

      // Actor filter - filter by specific user
      if (applyActorFilter && run.actor.login !== targetActor) {
        return false;
      }

      // Extract workflow path once for favorites and workflow filters
      const workflowPath =
        applyFavoritesFilter || applyWorkflowFilter ? run.path.split('@')[0] : '';

      // Favorites filter - show only runs from favorite workflows
      if (applyFavoritesFilter && favoritesSet && !favoritesSet.has(workflowPath)) {
        return false;
      }

      // Workflow filter - filter by specific workflow
      if (applyWorkflowFilter && workflowPath !== workflowFilter) {
        return false;
      }

      // Search filter - search across name, title, branch, and actor
      if (applySearchFilter) {
        const nameMatch = run.name.toLowerCase().includes(searchQueryLower);
        const titleMatch = run.display_title?.toLowerCase().includes(searchQueryLower);
        const branchMatch = run.head_branch.toLowerCase().includes(searchQueryLower);
        const actorMatch = run.actor.login.toLowerCase().includes(searchQueryLower);
        if (!nameMatch && !titleMatch && !branchMatch && !actorMatch) {
          return false;
        }
      }

      // Date filter - filter by date range
      if (applyDateFilter && (hasValidFrom || hasValidTo)) {
        const timestamp = run.run_started_at ?? run.created_at;
        const runDate = new Date(timestamp);

        if (!Number.isNaN(runDate.getTime())) {
          if (hasValidFrom && fromDate && runDate < fromDate) {
            return false;
          }
          if (hasValidTo && toDate && runDate > toDate) {
            return false;
          }
        }
      }

      // Status filter - filter by run status/conclusion
      if (applyStatusFilter) {
        if (statusFilter === 'completed') {
          if (!(run.status === 'completed' && run.conclusion === 'success')) {
            return false;
          }
        } else if (statusFilter === 'failed') {
          if (!(run.status === 'completed' && run.conclusion === 'failure')) {
            return false;
          }
        } else if (statusFilter === 'in_progress') {
          if (run.status !== 'in_progress') {
            return false;
          }
        } else if (statusFilter === 'queued') {
          if (run.status !== 'queued') {
            return false;
          }
        } else if (statusFilter === 'cancelled') {
          if (!(run.status === 'completed' && run.conclusion === 'cancelled')) {
            return false;
          }
        }
      }

      return true;
    });

    // This ensures the most recent runs appear at the top regardless of workflow
    if (!skipFavoritesOnly && showFavoritesOnly && markedWorkflows.length > 0) {
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return filtered;
  }

  /**
   * Compute base filter options for the current context.
   * Returns an empty object since the watched-only override is handled
   * directly in applyFiltersToRuns() via an early return.
   */
  function getBaseFilterOptionsForCurrentContext(): FilterComputationOptions {
    return {};
  }

  /**
   * Internal implementation of filterRuns that actually performs the filtering.
   * This is called by the throttled wrapper.
   *
   * Includes defensive error handling to prevent crashes during filtering.
   */
  function filterRunsImpl() {
    try {
      console.log(
        '[WorkflowRuns] filterRunsImpl called: showWatchedOnly=',
        showWatchedOnly,
        'watchedRuns.size=',
        watchedRuns.size,
        'runs.length=',
        runs.length
      );
      const baseOptions = getBaseFilterOptionsForCurrentContext();
      const result = applyFiltersToRuns(baseOptions);

      // Ensure we always get a valid array
      if (Array.isArray(result)) {
        filteredRuns = result;
      } else {
        console.warn('[WorkflowRuns] filterRunsImpl: applyFiltersToRuns returned non-array');
        filteredRuns = [];
      }
      console.log(
        '[WorkflowRuns] filterRunsImpl result: filteredRuns.length=',
        filteredRuns.length
      );
    } catch (error) {
      console.error('[WorkflowRuns] filterRunsImpl error, resetting filteredRuns:', error);
      filteredRuns = [];
    }
  }

  /**
   * Filter runs based on search query, status, actor, workflow, and bot runs.
   *
   * This also updates the current page slice used for rendering so pagination
   * stays in sync after any filter or setting change.
   *
   * Uses throttling to prevent excessive recomputation during rapid refreshes
   * (e.g., with 5-second adaptive refresh intervals).
   *
   * Includes defensive guards against concurrent filter operations that can
   * cause "Invalid array length" errors in Svelte's rendering pipeline.
   */
  function filterRuns() {
    // If a throttle is already in progress, mark as pending and return
    if (filterRunsThrottleId !== null) {
      filterRunsPending = true;
      return;
    }

    // Prevent concurrent filter operations that can corrupt Svelte's internal state
    // This can happen when rapid filter changes overlap with background refreshes
    if (filterOperationInProgress) {
      filterRunsPending = true;
      return;
    }

    filterOperationInProgress = true;

    try {
      // Execute immediately
      filterRunsImpl();

      // Keep client-side pagination slice in sync with the latest filters.
      // Use defensive bounds checking to prevent "Invalid array length" errors
      const limit = Math.max(1, workflowLoadLimit > 0 ? workflowLoadLimit : 20);
      const safePage = Math.max(1, currentPage > 0 ? currentPage : 1);

      // Ensure filteredRuns is a valid array before operations
      if (!Array.isArray(filteredRuns)) {
        console.warn('[WorkflowRuns] filteredRuns is not an array, resetting to empty array');
        filteredRuns = [];
      }

      // Calculate bounds with overflow protection
      const filteredLength = filteredRuns.length;
      const start = Math.max(0, Math.min((safePage - 1) * limit, filteredLength));
      const end = Math.min(start + limit, filteredLength);

      // Only slice if we have valid bounds
      // Create new array reference to ensure Svelte detects the change
      let newVisibleRuns: WorkflowRun[];
      if (start <= end && start >= 0 && end >= 0) {
        newVisibleRuns = filteredRuns.slice(start, end);
      } else {
        console.warn('[WorkflowRuns] Invalid slice bounds, setting empty visibleRuns:', {
          start,
          end,
          filteredLength,
        });
        newVisibleRuns = [];
      }

      // Use requestAnimationFrame to batch DOM updates and prevent mid-render corruption.
      // This ensures the previous render cycle completes before we start a new one.
      requestAnimationFrame(() => {
        // Increment render key to force {#key} block to fully recreate DOM
        // This prevents Svelte's internal linked-list corruption
        visibleRunsRenderKey++;
        visibleRuns = newVisibleRuns;
      });

      const baseOptions = getBaseFilterOptionsForCurrentContext();
      smartSuggestions =
        filteredRuns.length === 0 && runs.length > 0 ? computeSmartSuggestions(baseOptions) : [];

      // After (re)computing the filtered and visible runs, decide whether we
      // should continue progressive fetching for the current page / view.
      scheduleProgressiveFetchIfNeeded();
    } catch (error) {
      // Log and recover from any errors during filtering to prevent panel freeze
      console.error('[WorkflowRuns] Error during filterRuns, recovering:', error);
      // Reset to safe state using requestAnimationFrame to avoid mid-render corruption
      requestAnimationFrame(() => {
        visibleRunsRenderKey++;
        filteredRuns = [];
        visibleRuns = [];
        smartSuggestions = [];
      });
    } finally {
      filterOperationInProgress = false;
    }

    // Set up throttle - any calls during this window will be coalesced
    filterRunsThrottleId = window.setTimeout(() => {
      filterRunsThrottleId = null;
      // If a call was pending during the throttle window, execute it now
      if (filterRunsPending) {
        filterRunsPending = false;
        filterRuns();
      }
    }, FILTER_RUNS_THROTTLE_MS);
  }

  /**
   * Decide whether we should continue progressive fetching for the current
   * page, and if so schedule another background fetch. This is used both
   * after filters change and after page navigation so that under-filled
   * pages (or pages we haven't prefetched yet) can trigger additional
   * loading.
   */
  function scheduleProgressiveFetchIfNeeded() {
    if (!shouldProgressiveFetchForCurrentView()) {
      return;
    }

    // Cancel any existing scheduled progressive fetch
    if (progressiveFetchTimeoutId !== null) {
      window.clearTimeout(progressiveFetchTimeoutId);
    }

    // Capture the current generation to detect stale callbacks
    const generation = workflowSwitchGeneration;

    progressiveFetchTimeoutId = window.setTimeout(() => {
      progressiveFetchTimeoutId = null;

      // Check if this callback is stale (workflow switched since it was scheduled)
      if (generation !== workflowSwitchGeneration) {
        console.log('[WorkflowRuns] Ignoring stale progressive fetch callback');
        return;
      }

      progressiveFetch();
    }, 100);
  }

  /**
   * Determine whether more runs should be fetched in the background for the
   * current view.
   *
   * We try to keep enough filtered runs loaded to:
   * - Fill the current page; and
   * - Prefetch one additional page ahead.
   */
  function shouldProgressiveFetchForCurrentView(): boolean {
    // In "Watched Runs Only" mode we never paginate over the full run
    // history. Instead we refresh only the specific watched IDs via the
    // backgroundRefreshWatchedRuns path.
    if (showWatchedOnly) {
      return false;
    }

    if (progressiveFetching || loading) {
      return false;
    }

    if (!nextBackendPage || !hasMoreRuns()) {
      return false;
    }

    const effectiveMaxRuns = getMaxTotalRuns();
    if (totalRunsFetched >= effectiveMaxRuns) {
      return false;
    }

    const limit = workflowLoadLimit > 0 ? workflowLoadLimit : 20;
    const safePage = currentPage > 0 ? currentPage : 1;

    // Cover the current page plus one page ahead so that navigating forward
    // feels responsive.
    const pagesToCover = safePage + 1;
    const requiredFilteredCount = pagesToCover * limit;

    return filteredRuns.length < requiredFilteredCount;
  }

  /**
   * Check if progressive fetching is currently active OR will resume shortly.
   * This is used to avoid flickering the empty state UI between fetch cycles.
   * Returns true if we're actively fetching OR if conditions are met for more fetching.
   *
   * @deprecated Use the reactive `isSearchingForRuns` variable instead for UI rendering.
   * This function remains for internal use.
   */
  function isProgressiveFetchingActive(): boolean {
    // If currently fetching, obviously active
    if (progressiveFetching) {
      return true;
    }

    // If no more runs to fetch, not active
    if (!nextBackendPage || !hasMoreRuns()) {
      return false;
    }

    // If at max limit, not active
    const effectiveMaxRuns = getMaxTotalRuns();
    if (totalRunsFetched >= effectiveMaxRuns) {
      return false;
    }

    // Watched only mode doesn't use progressive fetch
    if (showWatchedOnly) {
      return false;
    }

    // If loading initial data, let that complete first
    if (loading) {
      return false;
    }

    // Check if we still need more runs to fill the current view
    // This mirrors the logic in shouldProgressiveFetchForCurrentView but
    // without the progressiveFetching guard since we want to detect the
    // "about to resume" state
    const limit = workflowLoadLimit > 0 ? workflowLoadLimit : 20;
    const safePage = currentPage > 0 ? currentPage : 1;
    const pagesToCover = safePage + 1;
    const requiredFilteredCount = pagesToCover * limit;

    return filteredRuns.length < requiredFilteredCount;
  }

  /**
   * Compute whether we're searching for matching runs.
   * This is a wrapper function for use in reactive statements that explicitly
   * lists all dependencies so Svelte can properly track them and re-render
   * the UI when any of them change.
   *
   * The parameters are passed explicitly even though they're accessed via
   * closure to ensure Svelte's reactivity system tracks them as dependencies.
   */
  function computeIsSearchingForRuns(
    _progressiveFetching: boolean,
    _nextBackendPage: number | null,
    _runs: WorkflowRun[],
    _totalCount: number,
    _totalRunsFetched: number,
    _showWatchedOnly: boolean,
    _loading: boolean,
    _filteredRuns: WorkflowRun[],
    _workflowLoadLimit: number,
    _currentPage: number,
    _dateFilterFrom: string,
    _dateFilterTo: string,
    _dateFilterMaxTotalRuns: number,
    _nonDateMaxTotalRuns: number
  ): boolean {
    // Use the actual implementation from isProgressiveFetchingActive
    return isProgressiveFetchingActive();
  }

  /**
   * Compute smart suggestions for the empty state when filters hide all runs.
   */
  function computeSmartSuggestions(baseOptions: FilterComputationOptions = {}): string[] {
    const suggestions: string[] = [];

    if (!runs.length) {
      return suggestions;
    }

    // When "Watched Runs Only" is enabled it overrides all other filters.
    // In that mode the only meaningful suggestion is to turn it off.
    if (showWatchedOnly) {
      const relaxed = applyFiltersToRuns({
        ...baseOptions,
        skipWatchedOnly: true,
      });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(`Turn off "Watched only" to see ${count} run${count === 1 ? '' : 's'}.`);
      }
      return suggestions;
    }

    // Suggest relaxing the status filter
    if (statusFilter !== 'all') {
      const relaxed = applyFiltersToRuns({ ...baseOptions, skipStatus: true });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(
          `Change the Status filter to "All" to see ${count} run${count === 1 ? '' : 's'}.`
        );
      }
    }

    // Suggest turning off "Favorites only"
    if (showFavoritesOnly) {
      const relaxed = applyFiltersToRuns({
        ...baseOptions,
        skipFavoritesOnly: true,
      });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(`Turn off "Favorites only" to see ${count} run${count === 1 ? '' : 's'}.`);
      }
    }

    // Suggest clearing search query
    if (searchQuery.trim()) {
      const relaxed = applyFiltersToRuns({ ...baseOptions, skipSearch: true });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(`Clear the search box to see ${count} run${count === 1 ? '' : 's'}.`);
      }
    }

    // Suggest clearing date filter
    if (dateFilterFrom || dateFilterTo) {
      const relaxed = applyFiltersToRuns({ ...baseOptions, skipDate: true });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(`Clear the date filter to see ${count} run${count === 1 ? '' : 's'}.`);
      }
    }

    // Suggest showing bot runs
    if (!showBotRuns) {
      const relaxed = applyFiltersToRuns({ ...baseOptions, skipBot: true });
      if (relaxed.length > 0) {
        const count = relaxed.length;
        suggestions.push(
          `Enable "Show bot runs" to see ${count} additional run${count === 1 ? '' : 's'}.`
        );
      }
    }

    return suggestions;
  }

  /**
   * Format a run count with correct pluralization ("1 run" vs "2 runs").
   */
  function formatRunCount(count: number): string {
    return `${count} run${count === 1 ? '' : 's'}`;
  }

  /**
   * Format a raw ISO date/time string into a compact summary label.
   * Falls back to the raw value if parsing fails.
   */
  function formatDateForSummary(raw: string): string {
    if (!raw) {
      return '';
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return raw.replace('T', ' ');
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  /**
   * Build a human-readable summary for the current date range filter.
   */
  function getDateRangeSummaryLabel(): string | null {
    if (!dateFilterFrom && !dateFilterTo) {
      return null;
    }

    const hasFrom = !!dateFilterFrom;
    const hasTo = !!dateFilterTo;

    const fromLabel = hasFrom ? formatDateForSummary(dateFilterFrom) : null;
    const toLabel = hasTo ? formatDateForSummary(dateFilterTo) : null;

    if (fromLabel && toLabel) {
      return `${fromLabel} to ${toLabel}`;
    }
    if (fromLabel) {
      return `from ${fromLabel}`;
    }
    if (toLabel) {
      return `up to ${toLabel}`;
    }

    return null;
  }

  /**
   * Get the current visible page index.
   *
   * This reflects the page the user is actually viewing over filteredRuns.
   * Parameters are passed explicitly to ensure Svelte reactivity triggers correctly.
   */
  function getCurrentPage(
    _filteredRuns: WorkflowRun[],
    _workflowLoadLimit: number,
    _currentPage: number
  ): number | null {
    if (!_filteredRuns.length || _workflowLoadLimit <= 0) {
      return null;
    }
    return Math.max(1, _currentPage);
  }

  /**
   * Compute the total number of pages based on filteredRuns length and the current per-page limit.
   * Parameters are passed explicitly to ensure Svelte reactivity triggers correctly.
   */
  function getTotalPages(_filteredRuns: WorkflowRun[], _workflowLoadLimit: number): number | null {
    if (!_filteredRuns.length || _workflowLoadLimit <= 0) {
      return null;
    }
    return Math.max(1, Math.ceil(_filteredRuns.length / _workflowLoadLimit));
  }

  /**
   * Navigate to the previous page
   */
  function goToPreviousPage() {
    if (currentPage > 1) {
      currentPage--;
      filterRuns(); // Re-apply filters to update visibleRuns
    }
  }

  /**
   * Navigate to the next page
   */
  function goToNextPage() {
    const totalPages = getTotalPages(filteredRuns, workflowLoadLimit);
    if (totalPages && currentPage < totalPages) {
      currentPage++;
      filterRuns(); // Re-apply filters to update visibleRuns
    }
  }

  /**
   * Build a human-readable list of labels for the currently active filters.
   * Used in the summary banner so users can quickly see which filters are
   * narrowing the result set without reading each control.
   * Parameters are passed explicitly to ensure Svelte reactivity triggers correctly.
   */
  function getActiveFilterLabels(
    _statusFilter: string,
    _actorFilter: string,
    _showBotRuns: boolean,
    _workflowFilter: string,
    _searchQuery: string,
    _showWatchedOnly: boolean,
    _showFavoritesOnly: boolean,
    _dateFilterFrom: string,
    _dateFilterTo: string,
    _filteredRuns: WorkflowRun[],
    _runs: WorkflowRun[],
    _markedWorkflows: string[],
    _watchedRuns: Set<number>
  ): string[] {
    const labels: string[] = [];

    // Don't return early if runs.length is 0 - we still want to show active filters
    const baseOptions = _runs.length > 0 ? getBaseFilterOptionsForCurrentContext() : null;

    // When "Watched Runs Only" is enabled it overrides all other filters,
    // so surface it as the only active filter in the summary.
    if (_showWatchedOnly && _watchedRuns.size > 0) {
      const watchedCount = _filteredRuns.length || _watchedRuns.size;
      if (watchedCount > 0) {
        labels.push(`Watched runs only [${formatRunCount(watchedCount)}]`);
      } else {
        labels.push('Watched runs only');
      }
      return labels;
    }

    // Show "Bot runs hidden" only when the checkbox is UNCHECKED (showBotRuns = false)
    if (!_showBotRuns) {
      if (baseOptions) {
        const relaxed = applyFiltersToRuns({ ...baseOptions, skipBot: true });
        const additional = relaxed.length - _filteredRuns.length;
        if (additional > 0) {
          labels.push(`Bot runs hidden [${formatRunCount(additional)} filtered]`);
        } else {
          labels.push('Bot runs hidden');
        }
      } else {
        labels.push('Bot runs hidden');
      }
    }

    if (_actorFilter === 'me') {
      if (_filteredRuns.length > 0) {
        labels.push(`My runs [${formatRunCount(_filteredRuns.length)}]`);
      } else {
        labels.push('My runs');
      }
    } else if (_actorFilter !== 'all') {
      if (_filteredRuns.length > 0) {
        labels.push(`Actor: ${_actorFilter} [${formatRunCount(_filteredRuns.length)}]`);
      } else {
        labels.push(`Actor: ${_actorFilter}`);
      }
    }

    if (_showFavoritesOnly && _markedWorkflows.length > 0) {
      // Show the list of favorite workflow names in the Active Filters section
      // Filter to only include workflows that exist in the current repository (availableWorkflows)
      // This prevents showing favorites from other repositories in the active filters
      const currentRepoMarkedWorkflows = _markedWorkflows.filter((path) =>
        availableWorkflows.some((w) => w.path === path)
      );
      const favoriteNames = currentRepoMarkedWorkflows
        .map((path) => workflowPathToName.get(path) || path.split('/').pop() || path)
        .filter((name) => name);

      if (favoriteNames.length === 1) {
        labels.push(`Favorite: ${favoriteNames[0]}`);
      } else if (favoriteNames.length <= 3) {
        labels.push(`Favorites: ${favoriteNames.join(', ')}`);
      } else {
        // For more than 3 favorites, show first 2 and count
        const displayNames = favoriteNames.slice(0, 2).join(', ');
        labels.push(`Favorites: ${displayNames} +${favoriteNames.length - 2} more`);
      }
    }

    if (_workflowFilter !== 'all') {
      const workflowName = workflowPathToName.get(_workflowFilter) ?? _workflowFilter;
      labels.push(`Workflow: ${workflowName}`);
    }

    if (_searchQuery.trim()) {
      labels.push(`Search: "${_searchQuery.trim()}"`);
    }

    const dateRangeLabel = getDateRangeSummaryLabel();
    if (dateRangeLabel) {
      labels.push(`Date range: ${dateRangeLabel}`);
    }

    if (_statusFilter !== 'all') {
      let statusLabel: string;
      if (_statusFilter === 'completed') {
        statusLabel = 'Success';
      } else if (_statusFilter === 'failed') {
        statusLabel = 'Failed';
      } else if (_statusFilter === 'in_progress') {
        statusLabel = 'In progress';
      } else if (_statusFilter === 'queued') {
        statusLabel = 'Queued';
      } else if (_statusFilter === 'cancelled') {
        statusLabel = 'Cancelled';
      } else {
        statusLabel = _statusFilter;
      }
      labels.push(`Status: ${statusLabel}`);
    }

    const current = getCurrentPage(_filteredRuns, workflowLoadLimit, currentPage);
    const totalPages = getTotalPages(_filteredRuns, workflowLoadLimit);
    if (current && totalPages && totalPages > 1) {
      labels.push(`Page ${current} of ${totalPages}`);
    }

    return labels;
  }

  /**
   * Manual refresh
   */
  function handleRefresh() {
    refreshing = true;
    // Clear cache on manual refresh to force fresh data
    clearCache();
    vscode.postMessage({
      type: 'refreshWorkflowRuns',
    });
  }

  /**
   * Cancel workflow run - shows confirmation modal before proceeding.
   */
  function handleCancelRun(run: WorkflowRun) {
    // Show confirmation modal with run details
    cancelConfirmRunId = run.id;
    cancelConfirmRunName = run.display_title || run.name || `Run #${run.id}`;
    cancelConfirmRunBranch = run.head_branch || '';
    cancelConfirmRunAuthor = run.actor?.login || '';
    showCancelConfirmModal = true;

    console.log('[CancelWorkflow] Modal opened for run:', {
      runId: run.id,
      name: cancelConfirmRunName,
      branch: cancelConfirmRunBranch,
      author: cancelConfirmRunAuthor,
    });
  }

  /**
   * Confirm cancel run - called when user confirms cancellation in modal.
   */
  function confirmCancelRun() {
    if (cancelConfirmRunId === null) {
      console.warn('[CancelWorkflow] confirmCancelRun called but cancelConfirmRunId is null');
      return;
    }

    // Capture the run ID before closing modal to prevent race conditions
    const runIdToCancel = cancelConfirmRunId;

    console.log('[CancelWorkflow] User confirmed cancellation for run:', runIdToCancel);

    // Mark as cancelling in the state
    cancellationState.cancellingRuns.add(runIdToCancel);
    cancellationState = cancellationState; // Trigger reactivity

    // Send cancel request to backend
    console.log('[CancelWorkflow] Sending cancelWorkflowRun message to backend:', {
      runId: runIdToCancel,
    });
    vscode.postMessage({
      type: 'cancelWorkflowRun',
      data: { runId: runIdToCancel },
    });

    // Close modal and reset state
    closeCancelConfirmModal();
  }

  /**
   * Close cancel confirmation modal and reset state.
   */
  function closeCancelConfirmModal() {
    showCancelConfirmModal = false;
    cancelConfirmRunId = null;
    cancelConfirmRunName = '';
    cancelConfirmRunBranch = '';
    cancelConfirmRunAuthor = '';
  }

  /**
   * Rerun workflow
   * - failedJobsOnly: directly reruns failed jobs via backend
   * - otherwise: prompt user in backend to either rerun now or open dispatch dialog to modify inputs
   */
  function handleRerunWorkflow(run: WorkflowRun, failedJobsOnly: boolean = false) {
    // Set loading state
    rerunLoadingRunIds.add(run.id);
    rerunLoadingRunIds = rerunLoadingRunIds; // Trigger reactivity

    if (failedJobsOnly) {
      vscode.postMessage({
        type: 'rerunWorkflow',
        data: { runId: run.id, failedJobsOnly: true },
      });
      return;
    }

    vscode.postMessage({
      type: 'promptRerunWorkflow',
      data: {
        runId: run.id,
        workflowName: run.name,
        branch: run.head_branch,
      },
    });
  }

  /**
   * View recovered input parameters for a workflow run in a lightweight modal.
   */
  function handleViewParameters(run: WorkflowRun) {
    // Always reset modal state completely when opening for a new run
    parametersModalTitle = run.name || `Run #${run.id}`;
    parametersModalRunId = run.id;
    parametersModalBranch = run.head_branch || null;
    parametersModalInputs = null; // Clear previous inputs
    parametersModalNotFound = false;
    showParametersModal = true;

    vscode.postMessage({
      type: 'getRunParameters',
      data: { runId: run.id },
    });
  }

  /**
   * Close the parameters modal and clear its state.
   */
  function closeParametersModal() {
    showParametersModal = false;
    parametersModalRunId = null;
    parametersModalBranch = null;
    parametersModalInputs = null;
    parametersModalNotFound = false;
  }

  /**
   * View workflow in GitHub
   */
  function viewWorkflowInGitHub(run: WorkflowRun) {
    vscode.postMessage({
      type: 'openWorkflowRun',
      data: run.html_url,
    });
  }

  /**
   * Handle search input
   */
  function handleSearchInput() {
    filterRuns();
  }

  /**
   * Handle toggle for Current PR Runs: when enabled, fetch runs for current branch
   */

  /**
   * Clear secondary filters and reset to default state.
   * Preserves workflow filter and search query.
   *
   * Important: this must also clear any active date filter and reset
   * pagination so we don't end up with an invisible date range filter
   * still hiding runs after the user clicks "Clear Filters".
   */
  function clearAllFilters() {
    // Clear secondary filters only - preserve workflow filter and search
    statusFilter = 'all';
    // Reset to "All Users" - the default state for showing all runs
    actorFilter = 'all';
    showBotRuns = false;
    showWatchedOnly = false;
    showFavoritesOnly = false;

    // Always reset pagination when clearing filters.
    currentPage = 1;

    if (dateFilterFrom || dateFilterTo) {
      // Delegate to the dedicated helper so cache, backend state, and
      // truncation flags are all reset consistently.
      clearDateFilter();
      return;
    }

    filterRuns();
  }

  /**
   * Handle status filter change
   */
  function handleStatusFilterChange() {
    recordUserActivity();
    filterRuns();
  }

  /**
   * Get status codicon class for workflow run
   */
  function getStatusCodicon(run: WorkflowRun): string {
    if (run.status === 'completed') {
      switch (run.conclusion) {
        case 'success':
          return 'codicon-pass';
        case 'failure':
          return 'codicon-error';
        case 'cancelled':
          return 'codicon-circle-slash';
        case 'skipped':
          return 'codicon-skip';
        default:
          return 'codicon-question';
      }
    } else if (run.status === 'in_progress') {
      return 'codicon-sync';
    } else if (run.status === 'queued') {
      return 'codicon-clock';
    }
    return 'codicon-question';
  }

  /**
   * Get status color class
   */
  function getStatusClass(run: WorkflowRun): string {
    if (run.status === 'completed') {
      switch (run.conclusion) {
        case 'success':
          return 'success';
        case 'failure':
          return 'failure';
        case 'cancelled':
          return 'cancelled';
        default:
          return 'neutral';
      }
    } else if (run.status === 'in_progress') {
      return 'in-progress';
    }
    return 'queued';
  }

  /**
   * Format relative time
   */
  function formatRelativeTime(timestamp: string): string {
    const now = Date.now();
    const time = new Date(timestamp).getTime();
    const diffMs = now - time;

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    }
    if (hours > 0) {
      return `${hours}h ago`;
    }
    if (minutes > 0) {
      return `${minutes}m ago`;
    }
    return `${seconds}s ago`;
  }

  /**
   * Handle clicking on a run - toggle dependency graph view
   */
  function openRun(run: WorkflowRun) {
    toggleDependencyGraph(run);
  }

  /**
   * Check if run is highlighted
   */
  function isHighlighted(run: WorkflowRun): boolean {
    return highlightedRunId !== null && run.id === highlightedRunId;
  }

  /**
   * Format duration
   */
  function formatDuration(startTime: string, endTime?: string): string {
    const start = new Date(startTime).getTime();
    const end = endTime ? new Date(endTime).getTime() : Date.now();
    const durationMs = end - start;

    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
</script>

<div class="container">
  <!-- Welcome Header -->
  {#if userInfo}
    <div class="welcome-header">
      <div class="welcome-message">
        <div class="icon-container">
          <span
            class="wave-emoji"
            class:wave-emoji--animated={showWelcomeWave}
            class:fade-out={showGitHubIcon}>👋</span
          >
          <span
            class="codicon codicon-mark-github github-icon"
            class:fade-in={showGitHubIcon}
            title="GitHub"
            aria-label="GitHub"
          ></span>
        </div>
        <div class="welcome-text">
          <div class="welcome-greeting-wrapper">
            <span class="welcome-greeting">Workflow Runs</span>
          </div>
          <span class="welcome-username">@{userInfo.login}</span>
        </div>
      </div>
      <div class="refresh-controls">
        <button
          on:click={handleRefresh}
          disabled={loading || refreshing}
          class="refresh-button"
          title="Refresh workflow runs"
        >
          <span class={`codicon codicon-refresh refresh-icon ${refreshing ? 'spinning-icon' : ''}`}
          ></span>
          <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
        </button>
        <div class="refresh-settings-wrapper">
          <button
            class="refresh-settings-button"
            on:click={() => (showRefreshSettings = !showRefreshSettings)}
            title="Auto-refresh settings"
          >
            <span class="codicon codicon-gear"></span>
            {#if autoRefreshSeconds > 0}
              <span class="refresh-indicator">●</span>
            {/if}
          </button>
          {#if showRefreshSettings}
            <div class="refresh-settings-dropdown">
              <!-- Settings Tab Navigation -->
              <div class="settings-tabs">
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'general'}
                  on:click={() => (settingsActiveTab = 'general')}
                >
                  <span class="codicon codicon-gear"></span>
                  <span>General</span>
                </button>
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'notifications'}
                  on:click={() => (settingsActiveTab = 'notifications')}
                >
                  <span class="codicon codicon-bell"></span>
                  <span>Notifications</span>
                </button>
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'ratelimit'}
                  on:click={() => (settingsActiveTab = 'ratelimit')}
                >
                  <span class="codicon codicon-pulse"></span>
                  <span>API Usage</span>
                  {#if rateLimitProtectionActive}
                    <span class="rate-limit-badge">!</span>
                  {/if}
                </button>
              </div>

              <!-- General Tab Content -->
              {#if settingsActiveTab === 'general'}
                <div class="settings-tab-content">
                  <div class="refresh-settings-header">
                    <span
                      title="Maximum total workflow runs to progressively load when no date filter is active"
                    >
                      Maximum Workflow Runs Limit (on open)
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showNonDateMaxTotalRunsHelp}
                      title="Learn more about the on-open workflow runs limit"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={MAX_TOTAL_RUNS_OPTIONS.length - 1}
                      step="1"
                      value={nonDateMaxTotalRunsIndex}
                      on:input={handleNonDateMaxTotalRunsSliderChange}
                      title={`Maximum ${NON_DATE_MAX_TOTAL_RUNS.toLocaleString()} runs to load when no date filter is active`}
                    />
                    <span class="settings-slider-value">
                      {NON_DATE_MAX_TOTAL_RUNS.toLocaleString()} runs
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Caps how many runs are progressively loaded when no date filter is active.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">
                    <span title="Maximum workflow runs to scan when a Date Filter is active">
                      Maximum Workflow Runs Limit (Date Range)
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showDateFilterMaxTotalRunsHelp}
                      title="Learn more about the date-range workflow runs limit"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={MAX_TOTAL_RUNS_OPTIONS.length - 1}
                      step="1"
                      value={dateFilterMaxTotalRunsIndex}
                      on:input={handleDateFilterMaxTotalRunsSliderChange}
                      title={`Maximum ${DATE_FILTER_MAX_TOTAL_RUNS.toLocaleString()} runs to scan when a date range is active`}
                    />
                    <span class="settings-slider-value">
                      {DATE_FILTER_MAX_TOTAL_RUNS.toLocaleString()} runs
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Limits how many runs are scanned for an active Date Filter before marking
                    results as truncated.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">
                    <span title="Number of workflow runs shown per page in this panel">
                      Workflow Runs Per Page
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showWorkflowLoadLimitHelp}
                      title="Learn more about Workflow Runs Per Page"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={WORKFLOW_LOAD_LIMIT_OPTIONS.length - 1}
                      step="1"
                      value={workflowLoadLimitIndex}
                      on:input={handleWorkflowLoadLimitSliderChange}
                      title={`Show ${workflowLoadLimit} runs per page in this panel`}
                    />
                    <span class="settings-slider-value">
                      {workflowLoadLimit} per page
                    </span>
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">Date Filter</div>
                  <div class="settings-input-group">
                    <label for="date-filter-from" class="settings-date-label">From:</label>
                    <input
                      id="date-filter-from"
                      type="datetime-local"
                      class="settings-date-input"
                      bind:value={dateFilterFrom}
                      max={dateFilterTo || undefined}
                      on:change={handleDateFilterChange}
                      disabled={showWatchedOnly}
                      title={showWatchedOnly
                        ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                        : 'Lower bound of date range; only show runs created on or after this date/time'}
                    />
                    {#if dateFilterFrom}
                      <button
                        type="button"
                        class="settings-clear-button"
                        on:click={clearDateFilterFrom}
                        disabled={showWatchedOnly}
                        title={showWatchedOnly
                          ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                          : "Clear 'From' date"}
                      >
                        <span class="codicon codicon-close"></span>
                      </button>
                    {/if}
                  </div>
                  <div class="settings-input-group">
                    <label for="date-filter-to" class="settings-date-label">To:</label>
                    <input
                      id="date-filter-to"
                      type="datetime-local"
                      class="settings-date-input"
                      bind:value={dateFilterTo}
                      min={dateFilterFrom || undefined}
                      on:change={handleDateFilterToChange}
                      disabled={showWatchedOnly}
                      title={showWatchedOnly
                        ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                        : 'Upper bound of date range; only show runs created on or before this date/time'}
                    />
                    {#if dateFilterTo}
                      <button
                        type="button"
                        class="settings-clear-button"
                        on:click={clearDateFilterTo}
                        disabled={showWatchedOnly}
                        title={showWatchedOnly
                          ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                          : "Clear 'To' date"}
                      >
                        <span class="codicon codicon-close"></span>
                      </button>
                    {/if}
                  </div>
                  <div class="settings-help-text">
                    Only show runs created between these date/times (inclusive).
                  </div>
                  {#if autoRefreshSeconds > 0 && dateFilterTo}
                    <div class="settings-help-text settings-help-text--info">
                      <span class="codicon codicon-info"></span>
                      <span>
                        Auto-refresh is active, but new runs won't appear in this historical date
                        range.
                      </span>
                    </div>
                  {/if}
                  {#if fetchingDateFilteredRuns && (dateFilterFrom || dateFilterTo)}
                    <div class="settings-help-text settings-help-text--fetching">
                      <span class="codicon codicon-loading spinning-icon"></span>
                      <span>Fetching runs for the selected date range…</span>
                    </div>
                  {/if}
                  {#if !showWatchedOnly}
                    {#if dateFilterTruncated && (dateFilterFrom || dateFilterTo)}
                      <div class="settings-help-text settings-help-text--warning">
                        <span class="codicon codicon-alert"></span>
                        <span>
                          Fetched the {DATE_FILTER_MAX_TOTAL_RUNS} most recent runs for this date range.
                          Filters are applied to these
                          {DATE_FILTER_MAX_TOTAL_RUNS} runs. If you're not seeing expected results, there
                          may be more matching runs beyond this limit. Try narrowing the date range to
                          fetch different runs.
                        </span>
                      </div>
                    {:else if !hasActiveDateFilter() && totalRunsFetched >= NON_DATE_MAX_TOTAL_RUNS && showMaxRunsWarningMemo}
                      <div class="settings-help-text settings-help-text--warning">
                        <span class="codicon codicon-alert"></span>
                        <span>
                          Loaded {NON_DATE_MAX_TOTAL_RUNS} most recent runs. Please apply date filters
                          to search further back in history.
                        </span>
                      </div>
                    {/if}
                  {/if}
                </div>
              {/if}

              <!-- Notifications Tab Content -->
              {#if settingsActiveTab === 'notifications'}
                <div class="settings-tab-content">
                  <div class="settings-checkbox-row">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        bind:checked={showWorkflowToastNotifications}
                        on:change={updateNotificationSettings}
                        title="Show toast notifications when workflows start, complete, or fail"
                      />
                      <span>Workflow Toast Notifications</span>
                    </label>
                  </div>
                  <div class="settings-help-text">
                    Show toast notifications when workflows start, complete, or fail.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="settings-checkbox-row">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        bind:checked={showProgressIndicators}
                        on:change={updateNotificationSettings}
                        title="Show inline job progress indicators for running workflows"
                      />
                      <span>Progress Indicators</span>
                    </label>
                  </div>
                  <div class="settings-help-text">
                    Show inline job progress for running workflows (e.g., "2/5 jobs completed").
                  </div>
                </div>
              {/if}

              <!-- API Rate Limit Tab Content -->
              {#if settingsActiveTab === 'ratelimit'}
                <div class="settings-tab-content">
                  <!-- Auto-Refresh Settings -->
                  <div class="refresh-settings-header">
                    <span>Auto-Refresh</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAutoRefreshSettingsHelp}
                      title="Learn more about Auto-Refresh"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-checkbox-row settings-checkbox-row--with-info">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoRefreshSeconds > 0}
                        on:change={handleAutoRefreshToggle}
                        title="Enable or disable automatic background refresh"
                      />
                      <span>Enable Auto-Refresh</span>
                    </label>
                  </div>
                  <div
                    class="settings-slider-row"
                    class:settings-slider-disabled={autoRefreshSeconds === 0}
                  >
                    <input
                      type="range"
                      min="0"
                      max={AUTO_REFRESH_SLIDER_OPTIONS.length - 1}
                      step="1"
                      value={autoRefreshIndex}
                      on:input={handleAutoRefreshSliderChange}
                      title={autoRefreshSeconds > 0
                        ? autoRefreshLabelText
                        : `Will be: ${AUTO_REFRESH_SLIDER_OPTIONS[autoRefreshIndex]}s when enabled`}
                      disabled={autoRefreshSeconds === 0}
                    />
                    <span class="settings-slider-value">
                      {autoRefreshSeconds > 0
                        ? autoRefreshLabelText
                        : `${AUTO_REFRESH_SLIDER_OPTIONS[autoRefreshIndex]}s`}
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Controls how often the panel refreshes runs in the background.
                  </div>

                  <!-- Adaptive Refresh Settings -->
                  <div
                    class="settings-checkbox-row settings-checkbox-row--with-info {autoRefreshSeconds ===
                    0
                      ? 'settings-checkbox-row--disabled'
                      : ''}"
                  >
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={adaptiveRefreshEnabled}
                        on:change={handleAdaptiveRefreshEnabledChange}
                        disabled={autoRefreshSeconds === 0}
                      />
                      <span>Enable Adaptive Refresh</span>
                    </label>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAdaptiveRefreshSettingsHelp}
                      title="Learn more about Adaptive Refresh"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  {#if adaptiveRefreshEnabled && autoRefreshSeconds > 0}
                    <div class="settings-slider-row" style="margin-top: 6px;">
                      <span class="settings-slider-label">Fast interval:</span>
                      <input
                        type="range"
                        min={MIN_ADAPTIVE_FAST_REFRESH_SECONDS}
                        max={MAX_ADAPTIVE_FAST_REFRESH_SECONDS}
                        step="1"
                        value={adaptiveFastRefreshSeconds}
                        on:input={handleAdaptiveFastRefreshSliderChange}
                        title={`Fast refresh interval: ${adaptiveFastRefreshSeconds} seconds`}
                        style="flex: 1;"
                      />
                      <span class="settings-slider-value">
                        {adaptiveFastRefreshSeconds}s
                      </span>
                    </div>
                  {/if}
                  <div class="settings-help-text" style="margin-top: 4px;">
                    {#if autoRefreshSeconds === 0}
                      <span class="settings-help-text-muted">
                        ⚠️ Adaptive refresh requires auto-refresh to be enabled.
                      </span>
                    {:else if adaptiveRefreshEnabled}
                      {#if adaptiveRefreshActive}
                        <span class="adaptive-refresh-note">
                          ⚡ Faster refresh ({adaptiveFastRefreshSeconds}s) active due to
                          in-progress runs.
                        </span>
                      {:else if autoRefreshSeconds > adaptiveFastRefreshSeconds}
                        <span class="adaptive-refresh-note">
                          Auto-speeds up to {adaptiveFastRefreshSeconds}s when runs are active.
                        </span>
                      {/if}
                    {:else}
                      <span class="settings-help-text-muted">
                        Adaptive refresh is disabled. Always uses the main auto-refresh interval.
                      </span>
                    {/if}
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header refresh-settings-header--with-info">
                    <span>API Rate Limit (Live)</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showRateLimitStatusHelp}
                      title="Learn more about API rate limits"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>

                  <!-- Rate Limit Progress Bar (reactive values for real-time updates) -->
                  <div class="rate-limit-display">
                    <div class="rate-limit-status-row">
                      <span class="rate-limit-label">Requests:</span>
                      <span class="rate-limit-value {rateLimitColorClass}"
                        >{rateLimitStatusText}</span
                      >
                    </div>
                    <div class="rate-limit-progress-container">
                      <div
                        class="rate-limit-progress-bar {rateLimitColorClass}"
                        style="width: {rateLimitRemainingPercent}%"
                      ></div>
                    </div>
                    <div class="rate-limit-status-row">
                      <span class="rate-limit-label">Resets at:</span>
                      <span class="rate-limit-value">{rateLimitResetTimeText}</span>
                    </div>
                    {#if rateLimitRemaining !== null && rateLimitLimit !== null}
                      <div class="rate-limit-percentage">
                        {rateLimitRemainingPercent}% remaining
                      </div>
                    {/if}
                  </div>

                  <div class="settings-divider"></div>

                  <!-- Rate Limit Protection Toggle -->
                  <div class="refresh-settings-header">
                    <span>Rate Limit Protection</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAutoThrottlingHelp}
                      title="Learn more about Auto-Throttling"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-checkbox-row settings-checkbox-row--with-info">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={rateLimitProtectionEnabled}
                        on:change={toggleRateLimitProtection}
                        title="Automatically throttle requests when approaching rate limits"
                      />
                      <span>Enable auto-throttling</span>
                    </label>
                  </div>
                  {#if rateLimitProtectionEnabled}
                    <div class="settings-option-row" style="margin-top: 6px;">
                      <span class="settings-option-label">Threshold:</span>
                      <select
                        class="settings-select"
                        value={rateLimitThreshold}
                        on:change={handleRateLimitThresholdChange}
                        title="API usage percentage at which auto-throttling activates"
                      >
                        {#each RATE_LIMIT_THRESHOLD_OPTIONS as threshold (threshold)}
                          <option value={threshold}>{threshold}%</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                  <div class="settings-help-text">
                    Automatically reduce request frequency when API usage reaches {rateLimitThreshold}%.
                  </div>

                  {#if rateLimitProtectionActive}
                    <div class="settings-help-text settings-help-text--warning">
                      <span class="codicon codicon-shield"></span>
                      <span>
                        Rate limit protection is active. Background refreshes are throttled.
                      </span>
                    </div>
                  {/if}

                  <div class="settings-divider"></div>

                  <!-- Quick Actions -->
                  <div class="refresh-settings-header">
                    <span>Quick Actions</span>
                  </div>
                  <div class="rate-limit-actions">
                    <button
                      type="button"
                      class="secondary-button rate-limit-action-btn"
                      class:btn-click-feedback={false}
                      on:click={increaseRefreshInterval}
                      disabled={autoRefreshSeconds === 0 || isAtMaxRefreshInterval}
                      title={isAtMaxRefreshInterval
                        ? 'Already at maximum interval (180s)'
                        : 'Increase to the next available refresh interval'}
                    >
                      <span class="codicon codicon-watch"></span>
                      Increase Interval
                    </button>
                    {#if autoRefreshSeconds > 0}
                      <button
                        type="button"
                        class="secondary-button rate-limit-action-btn"
                        on:click={disableAutoRefreshForRateLimit}
                        title="Disable auto-refresh to preserve API quota"
                      >
                        <span class="codicon codicon-stop"></span>
                        Disable Refresh
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="secondary-button rate-limit-action-btn rate-limit-action-btn--enable"
                        on:click={enableAutoRefreshFromRateLimit}
                        title="Enable auto-refresh with the previously selected interval"
                      >
                        <span class="codicon codicon-play"></span>
                        Enable Refresh
                      </button>
                    {/if}
                  </div>
                  <div class="settings-help-text">
                    GitHub allows 5,000 API requests per hour. Reduce refresh frequency to preserve
                    quota.
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="header">
      <div class="header-title-wrapper">
        <h3>Workflow Runs</h3>
        <span class="codicon codicon-mark-github header-icon" aria-hidden="true"></span>
      </div>
      <div class="refresh-controls">
        <button
          on:click={handleRefresh}
          disabled={loading || refreshing}
          class="refresh-button"
          title="Refresh workflow runs"
        >
          <span class={`codicon codicon-refresh refresh-icon ${refreshing ? 'spinning-icon' : ''}`}
          ></span>
          <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
        </button>
        <div class="refresh-settings-wrapper">
          <button
            class="refresh-settings-button"
            on:click={() => (showRefreshSettings = !showRefreshSettings)}
            title="Auto-refresh settings"
          >
            <span class="codicon codicon-gear"></span>
            {#if autoRefreshSeconds > 0}
              <span class="refresh-indicator">●</span>
            {/if}
          </button>
          {#if showRefreshSettings}
            <div class="refresh-settings-dropdown">
              <!-- Settings Tab Navigation -->
              <div class="settings-tabs">
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'general'}
                  on:click={() => (settingsActiveTab = 'general')}
                >
                  <span class="codicon codicon-gear"></span>
                  <span>General</span>
                </button>
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'notifications'}
                  on:click={() => (settingsActiveTab = 'notifications')}
                >
                  <span class="codicon codicon-bell"></span>
                  <span>Notifications</span>
                </button>
                <button
                  type="button"
                  class="settings-tab"
                  class:settings-tab--active={settingsActiveTab === 'ratelimit'}
                  on:click={() => (settingsActiveTab = 'ratelimit')}
                >
                  <span class="codicon codicon-pulse"></span>
                  <span>API Usage</span>
                  {#if rateLimitProtectionActive}
                    <span class="rate-limit-badge">!</span>
                  {/if}
                </button>
              </div>

              <!-- General Tab Content -->
              {#if settingsActiveTab === 'general'}
                <div class="settings-tab-content">
                  <div class="refresh-settings-header">
                    <span
                      title="Maximum total workflow runs to progressively load when no date filter is active"
                    >
                      Maximum Workflow Runs Limit (on open)
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showNonDateMaxTotalRunsHelp}
                      title="Learn more about the on-open workflow runs limit"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={MAX_TOTAL_RUNS_OPTIONS.length - 1}
                      step="1"
                      value={nonDateMaxTotalRunsIndex}
                      on:input={handleNonDateMaxTotalRunsSliderChange}
                      title={`Maximum ${NON_DATE_MAX_TOTAL_RUNS.toLocaleString()} runs to load when no date filter is active`}
                    />
                    <span class="settings-slider-value">
                      {NON_DATE_MAX_TOTAL_RUNS.toLocaleString()} runs
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Caps how many runs are progressively loaded when no date filter is active.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">
                    <span title="Maximum workflow runs to scan when a Date Filter is active">
                      Maximum Workflow Runs Limit (Date Range)
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showDateFilterMaxTotalRunsHelp}
                      title="Learn more about the date-range workflow runs limit"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={MAX_TOTAL_RUNS_OPTIONS.length - 1}
                      step="1"
                      value={dateFilterMaxTotalRunsIndex}
                      on:input={handleDateFilterMaxTotalRunsSliderChange}
                      title={`Maximum ${DATE_FILTER_MAX_TOTAL_RUNS.toLocaleString()} runs to scan when a date range is active`}
                    />
                    <span class="settings-slider-value">
                      {DATE_FILTER_MAX_TOTAL_RUNS.toLocaleString()} runs
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Limits how many runs are scanned for an active Date Filter before marking
                    results as truncated.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">
                    <span title="Number of workflow runs shown per page in this panel">
                      Workflow Runs Per Page
                    </span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showWorkflowLoadLimitHelp}
                      title="Learn more about Workflow Runs Per Page"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={WORKFLOW_LOAD_LIMIT_OPTIONS.length - 1}
                      step="1"
                      value={workflowLoadLimitIndex}
                      on:input={handleWorkflowLoadLimitSliderChange}
                      title={`Show ${workflowLoadLimit} runs per page in this panel`}
                    />
                    <span class="settings-slider-value">
                      {workflowLoadLimit} per page
                    </span>
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header">Date Filter</div>
                  <div class="settings-input-group">
                    <label for="date-filter-from-2" class="settings-date-label">From:</label>
                    <input
                      id="date-filter-from-2"
                      type="datetime-local"
                      class="settings-date-input"
                      bind:value={dateFilterFrom}
                      max={dateFilterTo || undefined}
                      on:change={handleDateFilterChange}
                    />
                    {#if dateFilterFrom}
                      <button
                        type="button"
                        class="settings-clear-button"
                        on:click={clearDateFilterFrom}
                        title="Clear 'From' date"
                      >
                        <span class="codicon codicon-close"></span>
                      </button>
                    {/if}
                  </div>
                  <div class="settings-input-group">
                    <label for="date-filter-to-2" class="settings-date-label">To:</label>
                    <input
                      id="date-filter-to-2"
                      type="datetime-local"
                      class="settings-date-input"
                      bind:value={dateFilterTo}
                      min={dateFilterFrom || undefined}
                      on:change={handleDateFilterToChange}
                    />
                    {#if dateFilterTo}
                      <button
                        type="button"
                        class="settings-clear-button"
                        on:click={clearDateFilterTo}
                        title="Clear 'To' date"
                      >
                        <span class="codicon codicon-close"></span>
                      </button>
                    {/if}
                  </div>
                  <div class="settings-help-text">
                    Only show runs created between these date/times (inclusive).
                  </div>
                  {#if autoRefreshSeconds > 0 && dateFilterTo}
                    <div class="settings-help-text settings-help-text--info">
                      <span class="codicon codicon-info"></span>
                      <span>
                        Auto-refresh is active, but new runs won't appear in this historical date
                        range.
                      </span>
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Notifications Tab Content -->
              {#if settingsActiveTab === 'notifications'}
                <div class="settings-tab-content">
                  <div class="settings-checkbox-row">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        bind:checked={showWorkflowToastNotifications}
                        on:change={updateNotificationSettings}
                        title="Show toast notifications when workflows start, complete, or fail"
                      />
                      <span>Workflow Toast Notifications</span>
                    </label>
                  </div>
                  <div class="settings-help-text">
                    Show toast notifications when workflows start, complete, or fail.
                  </div>

                  <div class="settings-divider"></div>

                  <div class="settings-checkbox-row">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        bind:checked={showProgressIndicators}
                        on:change={updateNotificationSettings}
                        title="Show inline job progress indicators for running workflows"
                      />
                      <span>Progress Indicators</span>
                    </label>
                  </div>
                  <div class="settings-help-text">
                    Show inline job progress for running workflows (e.g., "2/5 jobs completed").
                  </div>
                </div>
              {/if}

              <!-- API Rate Limit Tab Content -->
              {#if settingsActiveTab === 'ratelimit'}
                <div class="settings-tab-content">
                  <!-- Auto-Refresh Settings -->
                  <div class="refresh-settings-header">
                    <span>Auto-Refresh</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAutoRefreshSettingsHelp}
                      title="Learn more about Auto-Refresh"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-checkbox-row settings-checkbox-row--with-info">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoRefreshSeconds > 0}
                        on:change={handleAutoRefreshToggle}
                        title="Enable or disable automatic background refresh"
                      />
                      <span>Enable Auto-Refresh</span>
                    </label>
                  </div>
                  <div
                    class="settings-slider-row"
                    class:settings-slider-disabled={autoRefreshSeconds === 0}
                  >
                    <input
                      type="range"
                      min="0"
                      max={AUTO_REFRESH_SLIDER_OPTIONS.length - 1}
                      step="1"
                      value={autoRefreshIndex}
                      on:input={handleAutoRefreshSliderChange}
                      title={autoRefreshSeconds > 0
                        ? autoRefreshLabelText
                        : `Will be: ${AUTO_REFRESH_SLIDER_OPTIONS[autoRefreshIndex]}s when enabled`}
                      disabled={autoRefreshSeconds === 0}
                    />
                    <span class="settings-slider-value">
                      {autoRefreshSeconds > 0
                        ? autoRefreshLabelText
                        : `${AUTO_REFRESH_SLIDER_OPTIONS[autoRefreshIndex]}s`}
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Controls how often the panel refreshes runs in the background.
                  </div>

                  <!-- Adaptive Refresh Settings -->
                  <div
                    class="settings-checkbox-row settings-checkbox-row--with-info {autoRefreshSeconds ===
                    0
                      ? 'settings-checkbox-row--disabled'
                      : ''}"
                  >
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={adaptiveRefreshEnabled}
                        on:change={handleAdaptiveRefreshEnabledChange}
                        disabled={autoRefreshSeconds === 0}
                      />
                      <span>Enable Adaptive Refresh</span>
                    </label>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAdaptiveRefreshSettingsHelp}
                      title="Learn more about Adaptive Refresh"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  {#if adaptiveRefreshEnabled && autoRefreshSeconds > 0}
                    <div class="settings-slider-row" style="margin-top: 6px;">
                      <span class="settings-slider-label">Fast interval:</span>
                      <input
                        type="range"
                        min={MIN_ADAPTIVE_FAST_REFRESH_SECONDS}
                        max={MAX_ADAPTIVE_FAST_REFRESH_SECONDS}
                        step="1"
                        value={adaptiveFastRefreshSeconds}
                        on:input={handleAdaptiveFastRefreshSliderChange}
                        title={`Fast refresh interval: ${adaptiveFastRefreshSeconds} seconds`}
                        style="flex: 1;"
                      />
                      <span class="settings-slider-value">
                        {adaptiveFastRefreshSeconds}s
                      </span>
                    </div>
                  {/if}
                  <div class="settings-help-text" style="margin-top: 4px;">
                    {#if autoRefreshSeconds === 0}
                      <span class="settings-help-text-muted">
                        ⚠️ Adaptive refresh requires auto-refresh to be enabled.
                      </span>
                    {:else if adaptiveRefreshEnabled}
                      {#if adaptiveRefreshActive}
                        <span class="adaptive-refresh-note">
                          ⚡ Faster refresh ({adaptiveFastRefreshSeconds}s) active due to
                          in-progress runs.
                        </span>
                      {:else if autoRefreshSeconds > adaptiveFastRefreshSeconds}
                        <span class="adaptive-refresh-note">
                          Auto-speeds up to {adaptiveFastRefreshSeconds}s when runs are active.
                        </span>
                      {/if}
                    {:else}
                      <span class="settings-help-text-muted">
                        Adaptive refresh is disabled. Always uses the main auto-refresh interval.
                      </span>
                    {/if}
                  </div>

                  <div class="settings-divider"></div>

                  <div class="refresh-settings-header refresh-settings-header--with-info">
                    <span>API Rate Limit (Live)</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showRateLimitStatusHelp}
                      title="Learn more about API rate limits"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>

                  <!-- Rate Limit Progress Bar (reactive values for real-time updates) -->
                  <div class="rate-limit-display">
                    <div class="rate-limit-status-row">
                      <span class="rate-limit-label">Requests:</span>
                      <span class="rate-limit-value {rateLimitColorClass}"
                        >{rateLimitStatusText}</span
                      >
                    </div>
                    <div class="rate-limit-progress-container">
                      <div
                        class="rate-limit-progress-bar {rateLimitColorClass}"
                        style="width: {rateLimitRemainingPercent}%"
                      ></div>
                    </div>
                    <div class="rate-limit-status-row">
                      <span class="rate-limit-label">Resets at:</span>
                      <span class="rate-limit-value">{rateLimitResetTimeText}</span>
                    </div>
                    {#if rateLimitRemaining !== null && rateLimitLimit !== null}
                      <div class="rate-limit-percentage">
                        {rateLimitRemainingPercent}% remaining
                      </div>
                    {/if}
                  </div>

                  <div class="settings-divider"></div>

                  <!-- Rate Limit Protection Toggle -->
                  <div class="refresh-settings-header">
                    <span>Rate Limit Protection</span>
                    <button
                      class="info-icon clickable settings-info-icon"
                      type="button"
                      on:click={showAutoThrottlingHelp}
                      title="Learn more about Auto-Throttling"
                    >
                      <span class="codicon codicon-info"></span>
                    </button>
                  </div>
                  <div class="settings-checkbox-row settings-checkbox-row--with-info">
                    <label class="settings-checkbox-label">
                      <input
                        type="checkbox"
                        checked={rateLimitProtectionEnabled}
                        on:change={toggleRateLimitProtection}
                        title="Automatically throttle requests when approaching rate limits"
                      />
                      <span>Enable auto-throttling</span>
                    </label>
                  </div>
                  {#if rateLimitProtectionEnabled}
                    <div class="settings-option-row" style="margin-top: 6px;">
                      <span class="settings-option-label">Threshold:</span>
                      <select
                        class="settings-select"
                        value={rateLimitThreshold}
                        on:change={handleRateLimitThresholdChange}
                        title="API usage percentage at which auto-throttling activates"
                      >
                        {#each RATE_LIMIT_THRESHOLD_OPTIONS as threshold (threshold)}
                          <option value={threshold}>{threshold}%</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                  <div class="settings-help-text">
                    Automatically reduce request frequency when API usage reaches {rateLimitThreshold}%.
                  </div>

                  {#if rateLimitProtectionActive}
                    <div class="settings-help-text settings-help-text--warning">
                      <span class="codicon codicon-shield"></span>
                      <span>
                        Rate limit protection is active. Background refreshes are throttled.
                      </span>
                    </div>
                  {/if}

                  <div class="settings-divider"></div>

                  <!-- Quick Actions -->
                  <div class="refresh-settings-header">
                    <span>Quick Actions</span>
                  </div>
                  <div class="rate-limit-actions">
                    <button
                      type="button"
                      class="secondary-button rate-limit-action-btn"
                      class:btn-click-feedback={false}
                      on:click={increaseRefreshInterval}
                      disabled={autoRefreshSeconds === 0 || isAtMaxRefreshInterval}
                      title={isAtMaxRefreshInterval
                        ? 'Already at maximum interval (180s)'
                        : 'Increase to the next available refresh interval'}
                    >
                      <span class="codicon codicon-watch"></span>
                      Increase Interval
                    </button>
                    {#if autoRefreshSeconds > 0}
                      <button
                        type="button"
                        class="secondary-button rate-limit-action-btn"
                        on:click={disableAutoRefreshForRateLimit}
                        title="Disable auto-refresh to preserve API quota"
                      >
                        <span class="codicon codicon-stop"></span>
                        Disable Refresh
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="secondary-button rate-limit-action-btn rate-limit-action-btn--enable"
                        on:click={enableAutoRefreshFromRateLimit}
                        title="Enable auto-refresh with the previously selected interval"
                      >
                        <span class="codicon codicon-play"></span>
                        Enable Refresh
                      </button>
                    {/if}
                  </div>
                  <div class="settings-help-text">
                    GitHub allows 5,000 API requests per hour. Reduce refresh frequency to preserve
                    quota.
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Search and Filter Controls -->
  <div class="controls" class:is-scrolled={isScrolled}>
    {#if fetchingDateFilteredRuns && (dateFilterFrom || dateFilterTo)}
      <div class="settings-help-text settings-help-text--fetching">
        <span class="codicon codicon-loading spinning-icon"></span>
        <span>Fetching runs for the selected date range…</span>
      </div>
    {/if}
    {#if !showWatchedOnly}
      {#if dateFilterTruncated && (dateFilterFrom || dateFilterTo)}
        <div class="settings-help-text settings-help-text--warning">
          <span class="codicon codicon-alert"></span>
          <span>
            Fetched the {DATE_FILTER_MAX_TOTAL_RUNS} most recent runs for this date range. Filters are
            applied to these {DATE_FILTER_MAX_TOTAL_RUNS} runs. If you're not seeing expected results,
            there may be more matching runs beyond this limit. Try narrowing the date range to fetch different
            runs.
          </span>
        </div>
      {:else if !hasActiveDateFilter() && totalRunsFetched >= NON_DATE_MAX_TOTAL_RUNS && showMaxRunsWarningMemo}
        <div class="settings-help-text settings-help-text--warning">
          <span class="codicon codicon-alert"></span>
          <span>
            Loaded {NON_DATE_MAX_TOTAL_RUNS} most recent runs. Please apply date filters to search further
            back in history.
          </span>
        </div>
      {/if}
    {/if}

    <!-- Watched Runs Only informational message -->
    {#if showWatchedOnly && watchedRuns.size > 0}
      <div class="filter-info-message filter-info-message--watched">
        <div class="filter-info-content">
          <span class="codicon codicon-watch"></span>
          <span>
            <strong>Watched Runs Only:</strong> Showing {filteredRuns.length} of {watchedRuns.size} watched
            run{watchedRuns.size === 1 ? '' : 's'}. This filter overrides all other filters.
            {#if watchedRuns.size >= MAX_WATCHED_RUNS_PER_REPO}
              <em>(Limit reached: {MAX_WATCHED_RUNS_PER_REPO} runs)</em>
            {/if}
          </span>
        </div>
        <button
          class="filter-info-help-button"
          on:click={showWatchedRunsHelp}
          title="Learn more about watched runs"
          type="button"
        >
          <span class="codicon codicon-question"></span>
        </button>
      </div>
    {/if}

    <!-- Favorites Only informational message -->
    {#if showFavoritesOnly && !showWatchedOnly && availableMarkedWorkflowsCount > 0}
      <div class="filter-info-message filter-info-message--favorites">
        <div class="filter-info-content">
          <span class="codicon codicon-star-full"></span>
          <span>
            <strong>Favorites Only:</strong> Showing runs from {availableMarkedWorkflowsCount} favorite
            workflow{availableMarkedWorkflowsCount === 1 ? '' : 's'}. Use the ★ icon in the workflow
            dropdown to manage favorites.
          </span>
        </div>
        <button
          class="filter-info-help-button"
          on:click={showFavoritesHelp}
          title="Learn more about workflow favorites"
          type="button"
        >
          <span class="codicon codicon-question"></span>
        </button>
      </div>
    {/if}

    <div class="controls-header">
      <div class="search-box">
        <input
          type="text"
          placeholder="Search by workflow, branch, or actor..."
          bind:value={searchQuery}
          on:input={handleSearchInput}
          disabled={loading}
          title="Search by workflow name, run title, branch, or actor username"
        />
      </div>
      <button
        class="info-icon clickable"
        on:click={showPanelHelpModal}
        title="Help & Information"
        type="button"
      >
        <span class="codicon codicon-info"></span>
      </button>
    </div>
    <div class="filter-row">
      <div class="filter-box" class:filter-box--disabled={showWatchedOnly}>
        {#if showWatchedOnly}
          <span class="filter-disabled-indicator" title="Disabled: Watched Runs Only is active">
            <span class="codicon codicon-lock-small"></span>
          </span>
        {/if}
        <select
          bind:value={statusFilter}
          on:change={handleStatusFilterChange}
          disabled={loading || showWatchedOnly}
          title={showWatchedOnly
            ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
            : 'Filter runs by status (Success, Failed, In Progress, Queued, Cancelled)'}
        >
          <option value="all">All Statuses</option>
          <option value="completed">Success</option>
          <option value="failed">Failed</option>
          <option value="in_progress">In Progress</option>
          <option value="queued">Queued</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div class="filter-box" class:filter-box--disabled={showWatchedOnly}>
        {#if showWatchedOnly}
          <span class="filter-disabled-indicator" title="Disabled: Watched Runs Only is active">
            <span class="codicon codicon-lock-small"></span>
          </span>
        {/if}
        <select
          bind:value={actorFilter}
          on:change={handleActorFilterChange}
          disabled={loading || showWatchedOnly}
          title={showWatchedOnly
            ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
            : "Filter runs by who triggered them. Selecting 'My Runs' automatically hides bot runs."}
        >
          <option value="all">All Users</option>
          <option value="me">My Runs</option>
        </select>
      </div>
      <div
        class="filter-box workflow-filter-combobox"
        class:filter-box--disabled={showWatchedOnly || showFavoritesOnly}
      >
        {#if showWatchedOnly || showFavoritesOnly}
          <span
            class="filter-disabled-indicator"
            title={showWatchedOnly
              ? 'Disabled: Watched Runs Only is active'
              : 'Disabled: Favorites Only is active'}
          >
            <span class="codicon codicon-lock-small"></span>
          </span>
        {/if}
        <div class="combobox-container">
          <div class="combobox-input-wrapper">
            <input
              type="text"
              placeholder="All workflows – type to search"
              bind:value={workflowSearchQuery}
              on:input={handleWorkflowSearchInput}
              on:focus={() => {
                if (!showWatchedOnly && !showFavoritesOnly) {
                  workflowDropdownOpen = true;
                  // Show all workflows on open while keeping selected text visible
                  const previousQuery = workflowSearchQuery;
                  workflowSearchQuery = '';
                  filterAvailableWorkflows();
                  // Restore the query to preserve the selected workflow name in the input
                  workflowSearchQuery = previousQuery;
                }
              }}
              disabled={loading || showWatchedOnly || showFavoritesOnly}
              autocomplete="off"
              title={showWatchedOnly
                ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
                : showFavoritesOnly
                  ? "Disabled: Uncheck 'Favorites Only' to enable this filter"
                  : 'Filter runs by workflow file; type to search, or leave blank to see all workflows'}
            />
            <button
              class="dropdown-toggle"
              on:click={() => {
                if (!showWatchedOnly && !showFavoritesOnly) {
                  workflowDropdownOpen = !workflowDropdownOpen;
                  if (workflowDropdownOpen) {
                    // Show all workflows on open while keeping selected text visible
                    const previousQuery = workflowSearchQuery;
                    workflowSearchQuery = '';
                    filterAvailableWorkflows();
                    // Restore the query to preserve the selected workflow name in the input
                    workflowSearchQuery = previousQuery;
                  }
                }
              }}
              title={showWatchedOnly
                ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
                : showFavoritesOnly
                  ? "Disabled: Uncheck 'Favorites Only' to enable this filter"
                  : workflowDropdownOpen
                    ? 'Close dropdown'
                    : 'Open dropdown'}
              disabled={loading || showWatchedOnly || showFavoritesOnly}
            >
              {workflowDropdownOpen ? '▲' : '▼'}
            </button>
            {#if workflowFilter !== 'all'}
              <button
                class="clear-button"
                on:click={clearWorkflowFilter}
                disabled={showWatchedOnly || showFavoritesOnly}
                title={showWatchedOnly
                  ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
                  : showFavoritesOnly
                    ? "Disabled: Uncheck 'Favorites Only' to enable this filter"
                    : 'Clear filter'}>✕</button
              >
            {/if}
          </div>

          {#if workflowDropdownOpen}
            <div class="dropdown-list" transition:slide={{ duration: 200 }}>
              <!-- All Workflows option -->
              <div
                class="dropdown-item"
                on:click={clearWorkflowFilter}
                role="option"
                aria-selected={workflowFilter === 'all'}
                tabindex="0"
                on:keypress={(e) => e.key === 'Enter' && clearWorkflowFilter()}
              >
                <div class="workflow-info">
                  <div class="workflow-name">All Workflows</div>
                  <div class="workflow-path">Show all workflow runs</div>
                </div>
              </div>
              {#if filteredAvailableWorkflows.length > 0}
                {#each filteredAvailableWorkflows as workflow (workflow.path)}
                  <div
                    class="dropdown-item"
                    on:click={() => selectWorkflowFromDropdown(workflow)}
                    role="option"
                    aria-selected={workflowFilter === workflow.path}
                    tabindex="0"
                    on:keypress={(e) => e.key === 'Enter' && selectWorkflowFromDropdown(workflow)}
                  >
                    <div class="workflow-info">
                      <div class="workflow-name">{workflow.name}</div>
                      <div class="workflow-path">{workflow.path}</div>
                    </div>
                    <button
                      class="favorite-star"
                      on:click={(e) => toggleWorkflowMarked(workflow.path, e)}
                      title={isWorkflowMarked(workflow.path)
                        ? 'Remove from favorites'
                        : 'Add to favorites'}
                    >
                      {isWorkflowMarked(workflow.path) ? '★' : '☆'}
                    </button>
                  </div>
                {/each}
              {:else if workflowSearchQuery.trim()}
                <div class="dropdown-item no-results">
                  No workflows found matching "{workflowSearchQuery}"
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
      <div class="filter-box checkbox-filter" class:filter-box--disabled={showWatchedOnly}>
        {#if showWatchedOnly}
          <span class="filter-disabled-indicator" title="Disabled: Watched Runs Only is active">
            <span class="codicon codicon-lock-small"></span>
          </span>
        {/if}
        <label
          title={showWatchedOnly
            ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
            : 'Include runs triggered by bot accounts (e.g., dependabot, github-actions). Enabling this automatically switches Actor filter to "All Users".'}
          aria-label="Show Bot Runs filter"
        >
          <input
            type="checkbox"
            bind:checked={showBotRuns}
            on:change={handleShowBotRunsChange}
            disabled={loading || showWatchedOnly}
            aria-describedby="show-bot-runs-description"
          />
          Show Bot Runs
        </label>
        <span id="show-bot-runs-description" class="sr-only">
          When enabled, includes workflow runs triggered by bot accounts such as dependabot or
          github-actions. Enabling this filter automatically switches the Actor filter to All Users.
        </span>
      </div>

      <div class="filter-box checkbox-filter watched-runs-filter">
        <label
          title={watchedRuns.size === 0
            ? 'No runs are currently watched. Click the eye icon on any run to start watching it.'
            : 'Show only the runs you have explicitly marked as watched. This overrides all other filters (status, actor, workflow, date, search).'}
          aria-label="Watched Runs Only filter"
        >
          <input
            type="checkbox"
            bind:checked={showWatchedOnly}
            on:change={handleShowWatchedOnlyChange}
            disabled={loading || watchedRuns.size === 0}
            aria-describedby="watched-runs-description"
          />
          Watched Runs Only
          {#if watchedRuns.size > 0}
            ({watchedRuns.size})
          {/if}
        </label>
        <span id="watched-runs-description" class="sr-only">
          When enabled, shows only runs you have marked as watched and ignores all other filters.
          Watch runs by clicking the eye icon on individual runs.
        </span>
      </div>

      <div class="filter-box checkbox-filter" class:filter-box--disabled={showWatchedOnly}>
        {#if showWatchedOnly}
          <span class="filter-disabled-indicator" title="Disabled: Watched Runs Only is active">
            <span class="codicon codicon-lock-small"></span>
          </span>
        {/if}
        <label
          title={showWatchedOnly
            ? "Disabled: Uncheck 'Watched Runs Only' to enable this filter"
            : availableMarkedWorkflowsCount === 0
              ? 'No favorite workflows yet. Click the star icon (★/☆) next to workflows in the dropdown to add favorites.'
              : 'Show only runs from workflows you have marked as favorites. Mark workflows as favorites using the star icon (★/☆) in the workflow dropdown.'}
          aria-label="Favorites Only filter"
        >
          <input
            type="checkbox"
            bind:checked={showFavoritesOnly}
            on:change={handleShowFavoritesOnlyChange}
            disabled={loading || availableMarkedWorkflowsCount === 0 || showWatchedOnly}
            aria-describedby="favorites-only-description"
          />
          Favorites Only
          {#if availableMarkedWorkflowsCount > 0}
            ({availableMarkedWorkflowsCount})
          {/if}
        </label>
        <span id="favorites-only-description" class="sr-only">
          When enabled, shows only runs from workflows you have marked as favorites. Add favorites
          by clicking the star icon next to workflows in the dropdown.
        </span>
      </div>

      {#if !showWatchedOnly}
        <div class="filter-box">
          <button
            class="clear-filters-button"
            on:click={clearAllFilters}
            disabled={loading}
            title="Clear all filters and reset to default view"
            type="button"
          >
            <span class="codicon codicon-clear-all" aria-hidden="true"></span> Clear Filters
          </button>
        </div>
      {:else if watchedRuns.size > 0}
        <div class="filter-box">
          <button
            class="clear-filters-button manage-watched-button"
            type="button"
            on:click={openWatchedRunsModal}
            disabled={loading}
            title="Manage watched runs ({watchedRuns.size}/{MAX_WATCHED_RUNS_PER_REPO})"
          >
            <span class="codicon codicon-list-unordered"></span>
            <span>Manage ({watchedRuns.size}/{MAX_WATCHED_RUNS_PER_REPO})</span>
          </button>
        </div>
        <div class="filter-box">
          <button
            class="clear-filters-button unwatch-all-button"
            type="button"
            on:click={handleUnwatchAllRuns}
            disabled={loading}
            title="Stop watching all currently watched runs"
          >
            <span class="codicon codicon-clear-all"></span>
            <span>Unwatch all</span>
          </button>
        </div>
      {/if}
    </div>
  </div>

  {#if runs.length > 0}
    <!-- Active Filters Expandable Section -->
    <div class="filter-results">
      <button
        class="filter-results-header"
        type="button"
        on:click={toggleFiltersExpanded}
        aria-expanded={filtersExpanded}
      >
        <div class="filter-results-title">
          <span class="codicon codicon-filter" aria-hidden="true"></span>
          <span>Active Filters</span>
          {#if activeFilterLabels.length > 0}
            <span class="filter-results-count">
              ({activeFilterLabels.length})
            </span>
          {/if}
        </div>
        <!-- Inline background fetch indicator - subtle text in header -->
        {#if showFetchingIndicator && filteredRuns.length > 0}
          <span
            class="inline-fetch-indicator"
            aria-live="polite"
            transition:fade={{ duration: 250 }}
          >
            <span class="codicon codicon-loading spinning-icon" aria-hidden="true"></span>
            <span>Searching... ({totalRunsFetched.toLocaleString()})</span>
          </span>
        {/if}
        <span
          class={`codicon ${
            filtersExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'
          } filter-results-toggle`}
          aria-hidden="true"
        ></span>
      </button>
      {#if filtersExpanded}
        <div class="filter-results-filters" aria-label="Applied workflow run filters">
          {#if activeFilterLabels.length > 0}
            {#each activeFilterLabels as label (label)}
              <div class="filter-pill">
                <span class="codicon codicon-check filter-pill-icon" aria-hidden="true"></span>
                <span class="filter-pill-text">{label}</span>
              </div>
            {/each}
          {:else}
            <div class="filter-results-empty">No filters currently active</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- DISABLED: Log Comparison Mode Banner - temporarily disabled in v1.2.0
  {#if compareSourceJob}
    <div class="comparison-banner" transition:fade={{ duration: 150 }}>
      <span class="codicon codicon-diff comparison-banner-icon"></span>
      <span class="comparison-banner-text">
        Comparing logs: Select another <strong>{compareSourceJob.jobName}</strong> job from
        <em>{compareSourceJob.workflowName}</em> workflow to compare
      </span>
      <button
        class="comparison-banner-cancel"
        on:click={clearComparisonMode}
        title="Cancel comparison"
      >
        <span class="codicon codicon-close"></span>
        Cancel
      </button>
    </div>
  {/if}
  -->

  <!-- DISABLED: Step Log Comparison Mode Banner - temporarily disabled in v1.2.0
  {#if compareSourceStep}
    <div class="comparison-banner step-comparison" transition:fade={{ duration: 150 }}>
      <span class="codicon codicon-diff comparison-banner-icon"></span>
      <span class="comparison-banner-text">
        Comparing step logs: Open the <strong>{compareSourceStep.jobName}</strong> job from another
        <em>{compareSourceStep.workflowName}</em> run and select the
        <strong>{compareSourceStep.stepName}</strong> step
      </span>
      <button
        class="comparison-banner-cancel"
        on:click={clearStepComparisonMode}
        title="Cancel comparison"
      >
        <span class="codicon codicon-close"></span>
        Cancel
      </button>
    </div>
  {/if}
  -->

  {#if loading || refreshing || loadingMore || fetchingDateFilteredRuns}
    <div class="loading-container">
      <div class="loading-spinner-large">
        <span class="codicon codicon-loading spinning-icon"></span>
        <span class="loading-text-large">
          {#if refreshing}
            Refreshing workflow runs...
          {:else if loadingMore}
            Loading more runs...
          {:else if fetchingDateFilteredRuns}
            Fetching runs for date range...
          {:else}
            Loading workflow runs...
          {/if}
        </span>
      </div>
    </div>
  {:else if filteredRuns.length === 0 && runs.length > 0}
    <div class="empty">
      <div class="pagination-bar" aria-label="Workflow runs page navigation">
        <button
          class="pagination-button"
          type="button"
          on:click={() => {
            currentPage = Math.max(1, currentPage - 1);
            filterRuns();
          }}
          disabled={currentPage <= 1 || filteredRuns.length === 0}
        >
          <span class="codicon codicon-chevron-left" aria-hidden="true"></span>
          Previous
        </button>
        <span class="pagination-status">
          Page {currentPageNumber || 1} of {totalPagesNumber || 1}
        </span>
        <button
          class="pagination-button"
          type="button"
          on:click={goToNextPage}
          disabled={filteredRuns.length === 0 || (totalPagesNumber || 1) <= currentPage}
        >
          Next
          <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
        </button>
      </div>

      <div class="empty-icon">🔍</div>
      {#if !showWatchedOnly && isSearchingForRuns}
        <!-- Progressive fetching is active or will resume - show searching state, not final "no matches" -->
        <div class="empty-title">Searching for matching runs...</div>
        <div class="empty-subtitle empty-subtitle--progressive">
          <span class="codicon codicon-sync spinning-icon"></span>
          <span>
            {#if progressiveFetching}
              {#if totalRunsFetched > 0}
                Searched {totalRunsFetched} run{totalRunsFetched === 1 ? '' : 's'}, fetching more...
              {:else}
                Loading workflow runs...
              {/if}
            {:else}
              Searched {totalRunsFetched} run{totalRunsFetched === 1 ? '' : 's'}
            {/if}
          </span>
        </div>
      {:else}
        <!-- Progressive fetching complete - show final "no matches" state -->
        <div class="empty-title">No workflow runs match your filters</div>
        {#if totalRunsFetched > 0 && !showWatchedOnly}
          <div class="empty-subtitle">
            Searched {totalRunsFetched} run{totalRunsFetched === 1 ? '' : 's'} — no matches found.
          </div>
        {/if}
      {/if}
      <div class="empty-suggestions">
        {#if smartSuggestions.length > 0}
          <p>These filters are currently hiding available runs:</p>
          <ul>
            {#each smartSuggestions as suggestion (suggestion)}
              <li>{suggestion}</li>
            {/each}
          </ul>
        {:else}
          <p>Try one of the following:</p>
          <ul>
            <li>
              Click the <strong
                ><span class="codicon codicon-clear-all" aria-hidden="true"></span> Clear Filters</strong
              > button to reset all filters
            </li>
            <li>
              Enable <strong>Show Bot Runs</strong> to include automated runs
            </li>
            <li>Change the <strong>Status</strong> filter to "All"</li>
          </ul>
        {/if}
      </div>
    </div>
  {:else if filteredRuns.length === 0}
    <div class="empty">
      <div class="empty-icon">📭</div>
      <div class="empty-title">No workflow runs found</div>
      <div class="empty-suggestions">
        {#if dateFilterFrom || dateFilterTo}
          <p>
            <strong>No runs found in the selected date range.</strong>
          </p>
          <p>The GitHub API returned 0 runs for this date/time range. This could mean:</p>
          <ul style="text-align: left; margin: 10px auto; max-width: 400px;">
            <li>No workflow runs exist in this time period</li>
            <li>The date/time range is too narrow</li>
            <li>The runs you're looking for are outside this range (check the timezone)</li>
          </ul>
          <p>Try widening the date range or clearing the date filter to see all runs.</p>
        {:else if workflowFilter === 'all'}
          <p>This repository doesn't have any workflow runs yet.</p>
        {:else}
          <p>
            No runs found for this workflow. Try selecting a different workflow or clearing filters.
          </p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="runs-list">
      <!-- Key block forces complete DOM re-creation when visibleRunsRenderKey changes.
           This prevents Svelte's internal linked-list corruption during rapid array updates. -->
      {#key visibleRunsRenderKey}
        {#each visibleRuns as run (run.id)}
          <div class="run-item {getStatusClass(run)} {isHighlighted(run) ? 'highlighted' : ''}">
            {#if isHighlighted(run)}
              <div class="new-badge">🆕 Just Dispatched</div>
            {/if}
            {#if statusChanges.has(run.id)}
              <div class="status-change-message" transition:slide>
                <span class="codicon codicon-info"></span>
                <span>
                  Status updated: {statusChanges.get(run.id)?.oldStatus} → {statusChanges.get(
                    run.id
                  )?.newStatus}
                </span>
              </div>
            {/if}
            <div
              class="run-content"
              on:click={() => openRun(run)}
              role="button"
              tabindex="0"
              on:keypress={(e) => e.key === 'Enter' && openRun(run)}
            >
              <div class="run-header">
                <span
                  class={`status-icon codicon ${getStatusCodicon(run)} status-icon--${getStatusClass(run)} ${run.status === 'in_progress' || run.status === 'queued' ? 'spinning-icon' : ''}`}
                ></span>
                <div class="run-info">
                  <div class="run-title">
                    <span class="run-name">{run.display_title || run.name}</span>
                    {#if getOriginalWorkflowName(run)}
                      <span
                        class="run-workflow-name-badge"
                        title="Original workflow name from YAML file"
                      >
                        {getOriginalWorkflowName(run)}
                      </span>
                    {/if}
                  </div>
                  <div class="run-meta">
                    <div class="run-meta-line">
                      <span class="branch"
                        ><span class="codicon codicon-git-branch"></span>
                        <span class="branch-name">
                          {run.head_branch}
                        </span></span
                      >
                      <span class="separator">•</span>
                      <span class="actor"
                        ><span class="codicon codicon-account"></span>
                        {run.actor.login}</span
                      >
                      {#if run.pull_requests && run.pull_requests.length > 0}
                        <span class="separator">•</span>
                        <span class="pr-number">PR #{run.pull_requests[0].number}</span>
                      {/if}
                    </div>
                    <div class="run-meta-line">
                      <span class="status-text"
                        >{run.status === 'completed' ? run.conclusion : run.status}</span
                      >
                      <span class="separator">•</span>
                      {#if run.status === 'in_progress' || run.status === 'queued'}
                        <span class="duration">{formatDuration(run.created_at)}</span>
                      {:else if run.updated_at}
                        <span class="duration"
                          >{formatDuration(run.created_at, run.updated_at)}</span
                        >
                      {/if}
                      <span class="separator">•</span>
                      <span class="time">
                        <span class="codicon codicon-clock"></span>
                        <span>{formatRelativeTime(run.created_at)}</span>
                      </span>
                      <span class="separator">•</span>
                      <span class="run-number">#{run.run_number}</span>
                    </div>
                    <!-- Mini job progress indicator for in-progress runs (controlled by showProgressIndicators) -->
                    {#if showProgressIndicators && (run.status === 'in_progress' || run.status === 'queued') && runJobs.has(run.id)}
                      {@const jobs = runJobs.get(run.id) || []}
                      {@const completedJobs = jobs.filter((j) => j.status === 'completed')}
                      {@const inProgressJobs = jobs.filter((j) => j.status === 'in_progress')}
                      <div class="mini-job-progress">
                        <span class="job-progress-bar">
                          <span
                            class="job-progress-fill"
                            style="width: {jobs.length > 0
                              ? ((completedJobs.length / jobs.length) * 100).toFixed(0)
                              : 0}%"
                          ></span>
                        </span>
                        <span class="job-progress-text">
                          {completedJobs.length}/{jobs.length} jobs
                        </span>
                        {#if inProgressJobs.length > 0}
                          <span class="running-jobs-indicator">
                            <span class="codicon codicon-sync spinning-icon"></span>
                            <span class="running-jobs-list">
                              {#each inProgressJobs as runningJob (runningJob.id)}
                                <span class="running-job-item" title={runningJob.name}>
                                  <span class="running-job-name"
                                    >{runningJob.name.length > 50
                                      ? runningJob.name.substring(0, 47) + '...'
                                      : runningJob.name}</span
                                  >
                                  {#if runningJob.started_at}
                                    <span class="running-job-duration"
                                      >{formatDuration(runningJob.started_at)}</span
                                    >
                                  {/if}
                                </span>
                              {/each}
                            </span>
                          </span>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            </div>

            <!-- Action buttons -->
            <div class="action-buttons">
              <button
                class="action-button graph-button"
                on:click|stopPropagation={() => toggleDependencyGraph(run)}
                title={showDependencyGraph.has(run.id)
                  ? 'Hide dependency graph'
                  : 'Show dependency graph'}
              >
                <span
                  class="codicon"
                  class:codicon-chevron-down={showDependencyGraph.has(run.id)}
                  class:codicon-chevron-right={!showDependencyGraph.has(run.id)}
                ></span>
                <span>Graph</span>
              </button>

              <button
                class="action-button expand-button"
                on:click|stopPropagation={() => toggleRunExpansion(run.id)}
                title={expandedRuns.has(run.id) ? 'Hide jobs' : 'Show jobs'}
              >
                <span
                  class="codicon"
                  class:codicon-chevron-down={expandedRuns.has(run.id)}
                  class:codicon-chevron-right={!expandedRuns.has(run.id)}
                ></span>
                <span>Jobs</span>
              </button>

              <button
                class="action-button artifacts-button"
                on:click|stopPropagation={() => toggleArtifacts(run.id)}
                title={showArtifacts.has(run.id) ? 'Hide artifacts' : 'Show artifacts'}
              >
                <span
                  class="codicon"
                  class:codicon-chevron-down={showArtifacts.has(run.id)}
                  class:codicon-chevron-right={!showArtifacts.has(run.id)}
                ></span>
                <span>Artifacts</span>
              </button>

              <button
                class="action-button summary-button"
                on:click|stopPropagation={() => toggleSummary(run.id)}
                title={showSummary.has(run.id) ? 'Hide summary' : 'Show summary'}
              >
                <span
                  class="codicon"
                  class:codicon-chevron-down={showSummary.has(run.id)}
                  class:codicon-chevron-right={!showSummary.has(run.id)}
                ></span>
                <span>Summary</span>
              </button>

              <button
                class="action-button view-file-button"
                on:click|stopPropagation={() => openWorkflowFile(run.path)}
                title="Open workflow file in editor"
              >
                <span class="codicon codicon-file-code"></span>
                <span>View File</span>
              </button>

              <button
                class="action-button watch-button"
                on:click|stopPropagation={(e) => toggleRunWatch(run.id, e)}
                title={isRunWatched(run.id) ? 'Remove from watch list' : 'Add to watch list'}
              >
                <span
                  class={`codicon codicon-watch watch-icon ${isRunWatched(run.id) ? 'watch-icon--active' : ''}`}
                ></span>
                <span>{isRunWatched(run.id) ? 'Watching' : 'Watch'}</span>
              </button>

              {#if run.status === 'in_progress' || run.status === 'queued'}
                <button
                  class="action-button cancel-button"
                  on:click|stopPropagation={() => handleCancelRun(run)}
                  disabled={cancellationState.cancellingRuns.has(run.id) ||
                    cancellationState.cancelledRuns.has(run.id)}
                  title={cancellationState.cancellingRuns.has(run.id)
                    ? 'Cancelling...'
                    : 'Cancel this workflow run'}
                >
                  {#if cancellationState.cancellingRuns.has(run.id)}
                    <span class="codicon codicon-sync spinning-icon"></span>
                    <span>Cancelling...</span>
                  {:else}
                    <span class="codicon codicon-circle-slash"></span>
                    <span>Cancel</span>
                  {/if}
                </button>
              {/if}

              {#if run.status === 'completed'}
                <button
                  class="action-button rerun-button"
                  on:click|stopPropagation={() => handleRerunWorkflow(run, false)}
                  title="Rerun this workflow"
                  disabled={rerunLoadingRunIds.has(run.id)}
                >
                  {#if rerunLoadingRunIds.has(run.id)}
                    <span class="codicon codicon-loading codicon-modifier-spin"></span>
                  {:else}
                    <span class="codicon codicon-debug-restart"></span>
                  {/if}
                  <span>Rerun</span>
                </button>
                {#if run.conclusion === 'failure'}
                  <button
                    class="action-button rerun-failed-button"
                    on:click|stopPropagation={() => handleRerunWorkflow(run, true)}
                    title="Rerun only failed jobs"
                    disabled={rerunLoadingRunIds.has(run.id)}
                  >
                    {#if rerunLoadingRunIds.has(run.id)}
                      <span class="codicon codicon-loading codicon-modifier-spin"></span>
                    {:else}
                      <span class="codicon codicon-debug-restart"></span>
                    {/if}
                    <span>Rerun Failed</span>
                  </button>
                {/if}
              {/if}

              <button
                class="action-button view-button"
                on:click|stopPropagation={() => viewWorkflowInGitHub(run)}
                title="View workflow run in GitHub"
              >
                <span class="codicon codicon-eye"></span>
                <span>View</span>
              </button>

              <button
                class="action-button view-parameters-button"
                on:click|stopPropagation={() => handleViewParameters(run)}
                title="View input parameters for this run"
              >
                <span class="codicon codicon-symbol-parameter"></span>
                <span>Parameters</span>
              </button>

              {#if run.run_attempt && run.run_attempt > 1}
                <span class="attempt-badge" title={`Attempt ${run.run_attempt}`}>
                  Attempt {run.run_attempt}
                </span>
              {/if}
            </div>

            {#if cancellationState.failedCancellations.has(run.id)}
              <div class="cancel-error" transition:fade>
                <span class="codicon codicon-error status-icon status-icon--failure"></span>
                <span>{cancellationState.failedCancellations.get(run.id)}</span>
                {#if run.run_attempt && run.run_attempt > 1}
                  <span class="attempt-badge" title={`Attempt ${run.run_attempt}`}>
                    Attempt {run.run_attempt}
                  </span>
                {/if}
              </div>
            {/if}

            <!-- Job Dependency Graph (below action buttons) -->
            {#if showDependencyGraph.has(run.id)}
              <div class="dependency-graph-section" transition:slide>
                {#if loadingJobDependencies.has(run.id)}
                  <div class="graph-loading">
                    <span class="codicon codicon-sync spinning-icon"></span>
                    <span>Loading job dependencies...</span>
                  </div>
                {:else}
                  <JobDependencyGraph
                    runId={run.id}
                    jobs={runJobs.get(run.id) || []}
                    jobDefinitions={runJobDefinitions.get(run.id) || []}
                    isRunning={run.status === 'in_progress' || run.status === 'queued'}
                    onJobClick={(node) => handleGraphJobClick(node, run.id)}
                    on:showSteps={(e) => {
                      selectedJobForStepsModal = e.detail;
                      selectedJobRunIdForSteps = run.id;
                      selectedJobWorkflowIdForSteps = run.workflow_id;
                      selectedJobWorkflowNameForSteps = run.name;
                    }}
                    on:openModal={() => openJobGraphModal(run.id)}
                  />
                {/if}
              </div>
            {/if}

            <!-- Jobs list (expanded) -->
            {#if expandedRuns.has(run.id)}
              <div class="jobs-container" transition:slide>
                {#if loadingJobs.has(run.id)}
                  <div class="jobs-loading">
                    <span class="codicon codicon-sync spinning-icon"></span>
                    <span>Loading jobs...</span>
                  </div>
                {:else if runJobs.has(run.id)}
                  <!-- Key block forces complete DOM re-creation when jobs change -->
                  {#key jobsRenderKey.get(run.id) || 0}
                    {#each runJobs.get(run.id) || [] as job (job.id)}
                      <div class="job-item {getJobStatusClass(job)}">
                        <div class="job-header">
                          <span
                            class={`job-status-icon codicon ${getJobStatusCodicon(job)} status-icon status-icon--${getJobStatusClass(job)} ${job.status === 'in_progress' || job.status === 'queued' ? 'spinning-icon' : ''}`}
                          ></span>
                          <span class="job-name">{job.name}</span>
                        </div>
                        <div class="job-details">
                          <span class="job-status"
                            >{job.status === 'completed' ? job.conclusion : job.status}</span
                          >
                          {#if job.started_at && job.completed_at}
                            <span class="job-duration" title="Job duration">
                              <span class="codicon codicon-watch"></span>
                              <span
                                >{formatMs(
                                  new Date(job.completed_at).getTime() -
                                    new Date(job.started_at).getTime()
                                )}</span
                              >
                            </span>
                          {:else if job.started_at}
                            <span class="job-time">
                              <span class="codicon codicon-clock"></span>
                              <span>{formatRelativeTime(job.started_at)}</span>
                            </span>
                          {/if}
                        </div>
                        <div class="job-actions">
                          {#if job.status !== 'queued'}
                            <button
                              class="job-steps-button"
                              on:click|stopPropagation={() =>
                                openJobStepsModal(job, run.id, run.workflow_id, run.name)}
                              disabled={loadingJobSteps.has(job.id)}
                              title={job.status === 'completed' && job.steps && job.steps.length > 0
                                ? `View ${job.steps.length} step${job.steps.length !== 1 ? 's' : ''}`
                                : job.status === 'in_progress'
                                  ? 'View current steps'
                                  : 'View steps'}
                            >
                              {#if loadingJobSteps.has(job.id)}
                                <span class="codicon codicon-sync spinning-icon"></span>
                                <span>Loading...</span>
                              {:else}
                                <span class="codicon codicon-list-ordered"></span>
                                <span>Steps</span>
                              {/if}
                            </button>
                          {/if}
                          <button
                            class="job-logs-button"
                            on:click|stopPropagation={() =>
                              viewJobLogsInteractive(job.id, job.name, run.id)}
                            disabled={loadingJobLogs.has(job.id)}
                            title="View interactive logs (beta - grouping may have minor inaccuracies)"
                          >
                            {#if loadingJobLogs.has(job.id)}
                              <span class="codicon codicon-sync spinning-icon"></span>
                              <span>Loading...</span>
                            {:else}
                              <span class="codicon codicon-output"></span>
                              <span>View Logs</span>
                            {/if}
                          </button>
                          <button
                            class="job-logs-button"
                            on:click|stopPropagation={() =>
                              viewRawJobLogs(job.id, job.name, run.id)}
                            disabled={loadingRawJobLogs.has(job.id)}
                            title="View job logs in text editor"
                          >
                            {#if loadingRawJobLogs.has(job.id)}
                              <span class="codicon codicon-sync spinning-icon"></span>
                              <span>Loading...</span>
                            {:else}
                              <span class="codicon codicon-file-code"></span>
                              <span>View Raw Logs</span>
                            {/if}
                          </button>
                          <button
                            class="job-logs-button summary-btn"
                            on:click|stopPropagation={() =>
                              viewJobSummary(job.id, job.name, run.id)}
                            disabled={loadingJobSummary.has(job.id)}
                            title="View GitHub job summary"
                          >
                            {#if loadingJobSummary.has(job.id)}
                              <span class="codicon codicon-sync spinning-icon"></span>
                              <span>Loading...</span>
                            {:else}
                              <span class="codicon codicon-github"></span>
                              <span>Summary</span>
                            {/if}
                          </button>
                          <!-- DISABLED: Log comparison functionality - temporarily disabled in v1.2.0
                      {#if compareSourceJob && !isCompareSource(job.id)}
                        {#if canCompareWithJob(job.name, run.workflow_id)}
                          <button
                            class="job-logs-button compare-btn"
                            on:click|stopPropagation={() =>
                              compareWithJob(job.id, job.name, run.id)}
                            disabled={loadingComparison}
                            title="Compare logs with {compareSourceJob.jobName}"
                          >
                            {#if loadingComparison}
                              <span class="codicon codicon-sync spinning-icon"></span>
                              <span>Comparing...</span>
                            {:else}
                              <span class="codicon codicon-diff"></span>
                              <span>Compare</span>
                            {/if}
                          </button>
                        {:else}
                          <button
                            class="job-logs-button compare-btn disabled-compare"
                            disabled
                            title="Cannot compare: job name or workflow must match '{compareSourceJob.jobName}' in '{compareSourceJob.workflowName}'"
                          >
                            <span class="codicon codicon-diff"></span>
                            <span>Compare</span>
                          </button>
                        {/if}
                      {:else if !compareSourceJob}
                        <button
                          class="job-logs-button compare-btn"
                          on:click|stopPropagation={() =>
                            startLogComparison(job.id, job.name, run.id, run.workflow_id, run.name)}
                          title="Select this job for log comparison"
                        >
                          <span class="codicon codicon-diff"></span>
                          <span>Compare</span>
                        </button>
                      {:else}
                        <button
                          class="job-logs-button compare-btn selected"
                          on:click|stopPropagation={clearComparisonMode}
                          title="Cancel comparison (this job is selected)"
                        >
                          <span class="codicon codicon-close"></span>
                          <span>Cancel</span>
                        </button>
                      {/if}
                      -->
                        </div>
                      </div>
                    {/each}
                  {/key}
                {:else}
                  <div class="jobs-empty">No jobs found</div>
                {/if}
              </div>
            {/if}

            <!-- Artifacts section -->
            {#if showArtifacts.has(run.id)}
              <div class="artifacts-container" transition:slide>
                {#if loadingArtifacts.has(run.id)}
                  <div class="artifacts-loading">
                    <span class="codicon codicon-sync spinning-icon"></span>
                    <span>Loading artifacts...</span>
                  </div>
                {:else if runArtifacts.has(run.id)}
                  {#if (runArtifacts.get(run.id) || []).length === 0}
                    <div class="artifacts-empty">No artifacts available</div>
                  {:else}
                    <!-- Key block forces complete DOM re-creation when artifacts change -->
                    {#key artifactsRenderKey.get(run.id) || 0}
                      {#each runArtifacts.get(run.id) || [] as artifact (artifact.id)}
                        <div class="artifact-item">
                          <div class="artifact-header">
                            <span class="artifact-icon codicon codicon-package"></span>
                            <span class="artifact-name">{artifact.name}</span>
                          </div>
                          <div class="artifact-details">
                            <span class="artifact-size">
                              <span class="codicon codicon-database"></span>
                              <span>{formatFileSize(artifact.size_in_bytes)}</span>
                            </span>
                            <span class="artifact-date">
                              <span class="codicon codicon-calendar"></span>
                              <span>{formatRelativeTime(artifact.created_at)}</span>
                            </span>
                            {#if artifact.expired}
                              <span class="artifact-expired">
                                <span class="codicon codicon-warning"></span>
                                <span>Expired</span>
                              </span>
                            {/if}
                          </div>
                          <button
                            class="artifact-download-button"
                            on:click|stopPropagation={() =>
                              downloadArtifact(artifact.id, artifact.name)}
                            disabled={artifact.expired}
                            title={artifact.expired
                              ? 'This artifact has expired'
                              : 'Download this artifact'}
                          >
                            <span
                              class="codicon"
                              class:codicon-warning={artifact.expired}
                              class:codicon-cloud-download={!artifact.expired}
                            ></span>
                            <span>{artifact.expired ? 'Expired' : 'Download'}</span>
                          </button>
                        </div>
                      {/each}
                    {/key}
                  {/if}
                {:else}
                  <div class="artifacts-empty">No artifacts found</div>
                {/if}
              </div>
            {/if}

            <!-- Summary section -->
            {#if showSummary.has(run.id)}
              <div class="summary-container" transition:slide>
                {#if loadingJobs.has(run.id)}
                  <div class="summary-loading">
                    <span class="codicon codicon-sync spinning-icon"></span>
                    <span>Loading summary...</span>
                  </div>
                {:else if runJobs.has(run.id)}
                  {@const summary = getRunSummary(run.id)}
                  <div class="summary-content">
                    <div class="summary-header">
                      <h4>
                        <span class="codicon codicon-graph-line"></span>
                        <span>Run Summary</span>
                      </h4>
                      <button
                        class="github-summary-button"
                        on:click|stopPropagation={() => openGitHubSummaryModal(run.id)}
                        title="View GitHub Summary (parsed from job logs)"
                      >
                        <span class="codicon codicon-github"></span>
                        <span>View GitHub Summary</span>
                      </button>
                    </div>

                    <div class="summary-grid">
                      <!-- Jobs Overview -->
                      <div class="summary-section">
                        <div class="summary-section-title">
                          <span class="codicon codicon-list-selection"></span>
                          <span>Jobs Overview</span>
                        </div>
                        <div class="summary-stats">
                          <div class="summary-stat">
                            <span class="summary-stat-label">Total Jobs:</span>
                            <span class="summary-stat-value">{summary.totalJobs}</span>
                          </div>
                          {#if summary.successCount > 0}
                            <div class="summary-stat success">
                              <span class="summary-stat-label">
                                <span class="codicon codicon-pass status-icon status-icon--success"
                                ></span>
                                <span>Success:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.successCount}
                              </span>
                            </div>
                          {/if}
                          {#if summary.failureCount > 0}
                            <div class="summary-stat failure">
                              <span class="summary-stat-label">
                                <span class="codicon codicon-error status-icon status-icon--failure"
                                ></span>
                                <span>Failed:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.failureCount}
                              </span>
                            </div>
                          {/if}
                          {#if summary.cancelledCount > 0}
                            <div class="summary-stat cancelled">
                              <span class="summary-stat-label">
                                <span
                                  class="codicon codicon-circle-slash status-icon status-icon--cancelled"
                                ></span>
                                <span>Cancelled:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.cancelledCount}
                              </span>
                            </div>
                          {/if}
                          {#if summary.skippedCount > 0}
                            <div class="summary-stat skipped">
                              <span class="summary-stat-label">
                                <span class="codicon codicon-skip status-icon status-icon--skipped"
                                ></span>
                                <span>Skipped:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.skippedCount}
                              </span>
                            </div>
                          {/if}
                          {#if summary.inProgressCount > 0}
                            <div class="summary-stat in-progress">
                              <span class="summary-stat-label">
                                <span
                                  class="codicon codicon-sync status-icon status-icon--in-progress spinning-icon"
                                ></span>
                                <span>In Progress:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.inProgressCount}
                              </span>
                            </div>
                          {/if}
                          {#if summary.queuedCount > 0}
                            <div class="summary-stat queued">
                              <span class="summary-stat-label">
                                <span class="codicon codicon-clock status-icon status-icon--queued"
                                ></span>
                                <span>Queued:</span>
                              </span>
                              <span class="summary-stat-value">
                                {summary.queuedCount}
                              </span>
                            </div>
                          {/if}
                        </div>
                      </div>

                      <!-- Run Details -->
                      <div class="summary-section">
                        <div class="summary-section-title">Run Details</div>
                        <div class="summary-stats">
                          <div class="summary-stat">
                            <span class="summary-stat-label">Branch:</span>
                            <span class="summary-stat-value"
                              ><span class="codicon codicon-git-branch"></span>
                              {run.head_branch}</span
                            >
                          </div>
                          <div class="summary-stat">
                            <span class="summary-stat-label">Commit:</span>
                            <span class="summary-stat-value commit-sha"
                              >{run.head_sha.substring(0, 7)}</span
                            >
                          </div>
                          <div class="summary-stat">
                            <span class="summary-stat-label">Triggered by:</span>
                            <span class="summary-stat-value">{run.actor.login}</span>
                          </div>
                          <div class="summary-stat">
                            <span class="summary-stat-label">Run Number:</span>
                            <span class="summary-stat-value">#{run.run_number}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                {:else}
                  <div class="summary-empty">Click "▶ Jobs" to load summary data</div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/key}
    </div>

    <!-- Pagination Controls -->
    {#if filteredRuns.length > 0 && !loading}
      <div class="pagination-container">
        <div class="pagination-controls">
          <button
            class="pagination-button"
            on:click={goToPreviousPage}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            <span class="codicon codicon-chevron-left"></span>
          </button>

          <div class="pagination-info">
            Page {currentPageNumber || 1} of {totalPagesNumber || 1}
          </div>

          <button
            class="pagination-button"
            on:click={goToNextPage}
            disabled={currentPage >= (totalPagesNumber || 1)}
            title="Next page"
          >
            <span class="codicon codicon-chevron-right"></span>
          </button>
        </div>

        <div class="pagination-status">
          {#if progressiveFetching}
            <!-- Actively fetching more runs in the background -->
            <span class="codicon codicon-sync spinning-icon"></span>
            {#if filteredRuns.length < (workflowLoadLimit > 0 ? workflowLoadLimit : 20)}
              <span>
                Showing {filteredRuns.length} run{filteredRuns.length === 1 ? '' : 's'}.
                {#if totalRunsFetched > 0}
                  Searched {totalRunsFetched}, fetching more...
                {:else}
                  Loading more in background...
                {/if}
              </span>
            {:else}
              <span>
                Searched {totalRunsFetched} run{totalRunsFetched === 1 ? '' : 's'}, fetching more...
              </span>
            {/if}
          {:else if !showWatchedOnly && hasMoreRuns() && totalRunsFetched < getMaxTotalRuns()}
            <span>
              Showing {filteredRuns.length} filtered run{filteredRuns.length === 1 ? '' : 's'} from {runs.length}
              loaded
              {#if runs.length < totalCount}
                (of {totalCount} total).
              {:else}
                runs.
              {/if}
            </span>
          {:else if totalRunsFetched >= getMaxTotalRuns() && !showWatchedOnly && showMaxRunsWarningMemo}
            <span class="warning-text">
              <span class="codicon codicon-warning"></span>
              {#if hasActiveDateFilter()}
                Fetched {DATE_FILTER_MAX_TOTAL_RUNS} most recent runs. Showing
                {filteredRuns.length} matching your filters. More matching runs may exist beyond this
                limit—try narrowing the date range.
              {:else}
                Loaded {NON_DATE_MAX_TOTAL_RUNS} most recent runs. Please apply date filters to search
                further back in history.
              {/if}
            </span>
          {:else}
            <span>
              Showing all {filteredRuns.length} filtered run{filteredRuns.length === 1 ? '' : 's'}.
            </span>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<!-- Rerun Dispatch Confirmation Modal -->
{#if showDispatchConfirmModal}
  <div
    class="modal-overlay"
    on:click={() => {
      vscode.postMessage({
        type: 'confirmDispatchResult',
        data: { confirmed: false, addToWatchList: false },
      });
      showDispatchConfirmModal = false;
      dispatchConfirmTitle = '';
      dispatchConfirmBranch = null;
      dispatchConfirmInputs = {};
    }}
    transition:fade
  >
    <div class="modal-content" on:click|stopPropagation transition:fade>
      <div class="modal-header">
        <h3>{dispatchConfirmTitle || 'Rerun workflow?'}</h3>
      </div>
      <div class="modal-body">
        {#if dispatchConfirmBranch}
          <div class="modal-subtitle">
            <span>Review parameters before rerunning this workflow.</span>
            <span class="modal-branch-pill">
              <span class="codicon codicon-git-branch"></span>
              <span>{dispatchConfirmBranch}</span>
            </span>
          </div>
        {/if}

        {#if Object.keys(dispatchConfirmInputs).length === 0}
          <p class="parameters-empty">This workflow has no inputs.</p>
        {:else}
          <div class="parameters-list">
            {#each Object.entries(dispatchConfirmInputs) as [key, value] (key)}
              <div class="parameter-row">
                <div class="parameter-key">{key}</div>
                <div class="parameter-value">
                  <pre>{formatParameterValue(value)}</pre>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        <button
          type="button"
          class="secondary-button"
          on:click={() => {
            vscode.postMessage({
              type: 'confirmDispatchResult',
              data: { confirmed: false, addToWatchList: false },
            });
            showDispatchConfirmModal = false;
            dispatchConfirmTitle = '';
            dispatchConfirmBranch = null;
            dispatchConfirmInputs = {};
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          class="secondary-button"
          on:click={() => {
            vscode.postMessage({
              type: 'confirmDispatchResult',
              data: { confirmed: true, addToWatchList: false },
            });
            showDispatchConfirmModal = false;
            dispatchConfirmTitle = '';
            dispatchConfirmBranch = null;
            dispatchConfirmInputs = {};
          }}
        >
          Rerun
        </button>
        <button
          type="button"
          class="primary-button"
          on:click={() => {
            vscode.postMessage({
              type: 'confirmDispatchResult',
              data: { confirmed: true, addToWatchList: true },
            });
            showDispatchConfirmModal = false;
            dispatchConfirmTitle = '';
            dispatchConfirmBranch = null;
            dispatchConfirmInputs = {};
          }}
        >
          Rerun &amp; watch run
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Cancel Confirmation Modal -->
{#if showCancelConfirmModal}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cancel-confirm-title"
    tabindex="-1"
    on:click={closeCancelConfirmModal}
    on:keydown={(e) => {
      if (e.key === 'Escape') {
        closeCancelConfirmModal();
      }
    }}
    transition:fade
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="modal-content cancel-confirm-modal"
      role="document"
      on:click|stopPropagation
      on:keydown|stopPropagation
      transition:fade
    >
      <div class="modal-header">
        <h3 id="cancel-confirm-title">Cancel Workflow Run</h3>
      </div>
      <div class="modal-body">
        <p class="cancel-confirm-message">
          Are you sure you want to cancel <strong>"{cancelConfirmRunName}"</strong>?
        </p>
        <div class="cancel-confirm-details">
          <div class="cancel-confirm-detail">
            <span class="codicon codicon-symbol-numeric"></span>
            <span class="detail-label">Run ID:</span>
            <span class="detail-value">{cancelConfirmRunId}</span>
          </div>
          {#if cancelConfirmRunBranch}
            <div class="cancel-confirm-detail">
              <span class="codicon codicon-git-branch"></span>
              <span class="detail-label">Branch:</span>
              <span class="detail-value">{cancelConfirmRunBranch}</span>
            </div>
          {/if}
          {#if cancelConfirmRunAuthor}
            <div class="cancel-confirm-detail">
              <span class="codicon codicon-person"></span>
              <span class="detail-label">Triggered by:</span>
              <span class="detail-value">{cancelConfirmRunAuthor}</span>
            </div>
          {/if}
        </div>
        <p class="cancel-confirm-warning">
          <span class="codicon codicon-warning"></span>
          This action cannot be undone. The workflow run will be stopped.
        </p>
      </div>
      <div class="modal-footer">
        <button type="button" class="secondary-button" on:click={closeCancelConfirmModal}>
          Dismiss
        </button>
        <button type="button" class="danger-button" on:click={confirmCancelRun}>
          Cancel Run
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Run Parameters Modal -->
{#if showParametersModal}
  <div class="modal-overlay" on:click={closeParametersModal} transition:fade>
    <div class="modal-content" on:click|stopPropagation transition:fade>
      <div class="modal-header">
        <h3>{parametersModalTitle || 'Run parameters'}</h3>
      </div>
      <div class="modal-body">
        {#if parametersModalRunId}
          <div class="modal-subtitle">
            <span>Run ID: {parametersModalRunId}</span>
            {#if parametersModalBranch}
              <span class="modal-branch-pill">
                <span class="codicon codicon-git-branch"></span>
                <span>{parametersModalBranch}</span>
              </span>
            {/if}
          </div>
        {/if}

        {#if parametersModalInputs}
          <div class="parameters-list">
            {#each Object.entries(parametersModalInputs) as [key, value] (key)}
              <div class="parameter-row">
                <div class="parameter-key">{key}</div>
                <div class="parameter-value">
                  <pre>{formatParameterValue(value)}</pre>
                </div>
              </div>
            {/each}
          </div>
        {:else if parametersModalNotFound}
          <p class="parameters-empty">Parameters are not available for this run.</p>
        {:else}
          <p class="parameters-loading">
            <span class="codicon codicon-loading spinning-icon"></span>
            <span>Loading parameters…</span>
          </p>
        {/if}
      </div>
      <div class="modal-footer">
        <button class="primary-button" on:click={closeParametersModal} type="button">
          Close
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Help Modal -->
{#if showHelpModal}
  <div class="modal-overlay" on:click={closeHelpModal} transition:fade>
    <div class="modal-content" on:click|stopPropagation transition:fade>
      <div class="modal-header">
        <h3>{helpModalTitle}</h3>
        <button class="close-button" on:click={closeHelpModal} type="button"> ✕ </button>
      </div>
      <div class="modal-body">
        {@html helpModalContent}
      </div>
      <div class="modal-footer">
        <button class="primary-button" on:click={closeHelpModal} type="button"> Got it! </button>
      </div>
    </div>
  </div>
{/if}

<!-- Watched Runs Management Modal -->
{#if showWatchedRunsModal}
  <div class="modal-overlay" on:click={closeWatchedRunsModal} transition:fade>
    <div class="modal-content watched-runs-modal" on:click|stopPropagation transition:fade>
      <div class="modal-header">
        <h3>Manage Watched Runs</h3>
        <button class="close-button" on:click={closeWatchedRunsModal} type="button"> ✕ </button>
      </div>
      <div class="modal-body">
        <div class="watched-runs-info">
          <p>
            You have <strong>{watchedRuns.size}</strong> watched run{watchedRuns.size === 1
              ? ''
              : 's'} (maximum: {MAX_WATCHED_RUNS_PER_REPO} per repository).
          </p>
          {#if watchedRuns.size >= MAX_WATCHED_RUNS_PER_REPO}
            <p class="warning-text">
              <span class="codicon codicon-warning"></span>
              You've reached the maximum limit. Unwatch a run to watch new ones.
            </p>
          {/if}
        </div>

        {#if watchedRuns.size > 0}
          <div class="watched-runs-list">
            {#each runs.filter((r) => watchedRuns.has(r.id)) as run (run.id)}
              <div class="watched-run-item">
                <div class="watched-run-info">
                  <div class="watched-run-title">
                    <span class="status-icon status-{run.status}">
                      {#if run.status === 'completed' && run.conclusion === 'success'}
                        <span class="codicon codicon-check"></span>
                      {:else if run.status === 'completed' && run.conclusion === 'failure'}
                        <span class="codicon codicon-error"></span>
                      {:else if run.status === 'completed' && run.conclusion === 'cancelled'}
                        <span class="codicon codicon-circle-slash"></span>
                      {:else if run.status === 'in_progress'}
                        <span class="codicon codicon-sync spinning-icon"></span>
                      {:else if run.status === 'queued'}
                        <span class="codicon codicon-clock"></span>
                      {/if}
                    </span>
                    <span class="watched-run-name">{run.name}</span>
                  </div>
                  <div class="watched-run-meta">
                    <span>#{run.run_number}</span>
                    <span>•</span>
                    <span>{run.head_branch}</span>
                    <span>•</span>
                    <span>{formatRelativeTime(run.created_at)}</span>
                  </div>
                </div>
                <button
                  class="unwatch-button"
                  on:click={(e) => unwatchRunFromModal(run.id, e)}
                  title="Stop watching this run"
                  type="button"
                >
                  <span class="codicon codicon-eye-closed"></span>
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-state">
            <p>No watched runs.</p>
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        <button class="secondary-button" on:click={closeWatchedRunsModal} type="button">
          Close
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Job Steps Modal (from jobs list) -->
<!-- NOTE: Using optional chaining (?.) throughout to prevent null reference errors during Svelte reactivity transitions -->
{#if selectedJobForStepsModal}
  {@const currentJob = selectedJobForStepsModal}
  {@const currentJobId = currentJob?.jobId}
  {@const currentRunId = selectedJobRunIdForSteps}
  <JobStepsModal
    job={currentJob}
    onClose={closeJobStepsModal}
    onViewSummary={currentJobId != null
      ? () => {
          // Re-check state at execution time to handle race conditions
          if (selectedJobForStepsModal == null) return;
          const jobId = selectedJobForStepsModal.jobId;
          const jobName = selectedJobForStepsModal.name || 'Job';
          const runId = selectedJobRunIdForSteps;
          if (jobId != null) {
            viewJobSummary(jobId, jobName, runId ?? undefined, true);
          }
        }
      : undefined}
    onViewLogs={currentJobId != null && currentRunId != null
      ? () => {
          // Re-check state at execution time to handle race conditions
          if (selectedJobForStepsModal == null) return;
          const jobId = selectedJobForStepsModal.jobId;
          const runId = selectedJobRunIdForSteps;
          if (jobId != null && runId != null) {
            viewJobLogsInteractive(jobId, selectedJobForStepsModal.name || 'Job', runId);
          }
        }
      : undefined}
    onViewRawLogs={currentJobId != null && currentRunId != null
      ? () => {
          // Re-check state at execution time to handle race conditions
          if (selectedJobForStepsModal == null) return;
          const jobId = selectedJobForStepsModal.jobId;
          const runId = selectedJobRunIdForSteps;
          if (jobId != null && runId != null) {
            viewRawJobLogs(jobId, selectedJobForStepsModal.name || 'Job', runId);
          }
        }
      : undefined}
    onViewStepLogs={currentJobId != null && currentRunId != null
      ? (stepNumber: number, stepName: string) => {
          // Re-check state at execution time to handle race conditions
          if (selectedJobForStepsModal == null) return;
          const jobId = selectedJobForStepsModal.jobId;
          const runId = selectedJobRunIdForSteps;
          if (jobId != null && runId != null) {
            viewStepLogs(
              jobId,
              selectedJobForStepsModal.name || 'Job',
              runId,
              stepNumber,
              stepName
            );
          }
        }
      : undefined}
    loadingLogs={currentJobId != null && loadingJobLogs.has(currentJobId)}
    loadingRawLogs={currentJobId != null && loadingRawJobLogs.has(currentJobId)}
    loadingSummary={currentJobId != null && loadingJobSummary.has(currentJobId)}
    loadingStepLogs={currentJobId != null
      ? new Set(
          [...loadingStepLogs.keys()]
            .filter((key) => key.startsWith(`${currentJobId}-`))
            .map((key) => parseInt(key.split('-')[1], 10))
        )
      : new Set()}
    runId={currentRunId ?? undefined}
    workflowId={selectedJobWorkflowIdForSteps ?? undefined}
    workflowName={selectedJobWorkflowNameForSteps ?? undefined}
  />
{/if}

<!-- Job Graph Modal (full screen view) -->
{#if showJobGraphModal && jobGraphModalRunId}
  {@const modalRun = runs.find((r) => r.id === jobGraphModalRunId)}
  <JobGraphModal
    runId={jobGraphModalRunId}
    runName={modalRun?.display_title || modalRun?.name || ''}
    jobs={runJobs.get(jobGraphModalRunId) || []}
    jobDefinitions={runJobDefinitions.get(jobGraphModalRunId) || []}
    isRunning={modalRun?.status === 'in_progress' || modalRun?.status === 'queued'}
    onClose={closeJobGraphModal}
    onJobClick={(node) => {
      // Don't show steps for queued jobs
      if (node.status === 'queued') {
        return;
      }

      // For completed jobs with steps, show immediately
      if (node.status === 'completed' && node.steps && node.steps.length > 0) {
        selectedJobForStepsModal = node;
        selectedJobRunIdForSteps = jobGraphModalRunId;
        selectedJobWorkflowIdForSteps = modalRun?.workflow_id ?? null;
        selectedJobWorkflowNameForSteps = modalRun?.name ?? null;
        return;
      }

      // For running jobs or jobs without steps data, fetch from API
      if (
        node.jobId &&
        jobGraphModalRunId &&
        (node.status === 'in_progress' || !node.steps || node.steps.length === 0)
      ) {
        loadingJobSteps.add(node.jobId);
        loadingJobSteps = loadingJobSteps; // Trigger reactivity
        selectedJobRunIdForSteps = jobGraphModalRunId;
        selectedJobWorkflowIdForSteps = modalRun?.workflow_id ?? null;
        selectedJobWorkflowNameForSteps = modalRun?.name ?? null;

        vscode.postMessage({
          type: 'getJobDetails',
          data: { jobId: node.jobId, runId: jobGraphModalRunId },
        });
        return;
      }

      // Fallback: show with available data
      if (node.steps && node.steps.length > 0) {
        selectedJobForStepsModal = node;
        selectedJobRunIdForSteps = jobGraphModalRunId;
        selectedJobWorkflowIdForSteps = modalRun?.workflow_id ?? null;
        selectedJobWorkflowNameForSteps = modalRun?.name ?? null;
      } else if (node.jobId && jobGraphModalRunId) {
        // Fall back to viewing interactive logs for jobs without steps data
        viewJobLogsInteractive(node.jobId, node.name, jobGraphModalRunId);
      }
    }}
  />
{/if}

<!-- GitHub Summary Modal -->
<!-- Note: Modal shows summaries parsed from job logs via $GITHUB_STEP_SUMMARY -->
<!-- gitHubSummaryModalRunId is set for run summaries, null for individual job summaries -->
{#if showGitHubSummaryModal}
  {@const modalRun = gitHubSummaryModalRunId
    ? runs.find((r) => r.id === gitHubSummaryModalRunId)
    : null}
  <GitHubSummaryModal
    runId={gitHubSummaryModalRunId ?? 0}
    runName={modalRun?.display_title || modalRun?.name || ''}
    htmlUrl={gitHubSummaryHtmlUrl}
    summaryContent={gitHubSummaryContent}
    isLoading={gitHubSummaryLoading}
    error={gitHubSummaryError}
    onClose={closeGitHubSummaryModal}
    onOpenInTab={openGitHubSummaryInTab}
    onOpenInBrowser={openGitHubSummaryInBrowserFromModal}
  />
{/if}

<!-- Health Monitor Notification Banner -->
{#if panelUnresponsive && !healthNotificationDismissed}
  <div class="health-notification" transition:slide={{ duration: reduceMotion ? 0 : 200 }}>
    <div class="health-notification-content">
      <div class="health-notification-icon">
        <span class="codicon codicon-warning"></span>
      </div>
      <div class="health-notification-text">
        <div class="health-notification-title">Panel may be unresponsive</div>
        <div class="health-notification-reason">
          {unresponsiveReason || 'Unknown issue detected'}
        </div>
        <div class="health-notification-hint">
          You can continue using the panel, but some features may not work until refreshed.
        </div>
      </div>
    </div>
    <div class="health-notification-actions">
      <button
        class="health-action-btn"
        on:click={resetPanelState}
        title="Clear all loading states and reset the panel - use if UI is stuck"
      >
        <span class="codicon codicon-debug-restart"></span>
        Reset State
      </button>
      <button
        class="health-action-btn"
        on:click={forceDataRefresh}
        title="Force a complete data refresh from GitHub - use if data seems stale"
      >
        <span class="codicon codicon-refresh"></span>
        Refresh Data
      </button>
      {#if autoRefreshSeconds > 0}
        <button
          class="health-action-btn"
          on:click={restartAutoRefresh}
          title="Restart the auto-refresh timer - use if auto-refresh stopped working"
        >
          <span class="codicon codicon-sync"></span>
          Restart Auto-refresh
        </button>
      {/if}
      <button
        class="health-action-btn health-action-dismiss"
        on:click={dismissHealthNotification}
        title="Dismiss this notification - warning will return if issue persists"
      >
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  </div>
{/if}

<!-- Toast notifications -->
{#if toasts.length > 0}
  <div class="toast-container">
    {#each toasts as t (t.id)}
      <div
        class="toast toast-{t.type}"
        in:fly={{
          y: reduceMotion ? 0 : -12,
          duration: reduceMotion ? 0 : 220,
        }}
        out:fade={{ duration: reduceMotion ? 0 : 150 }}
      >
        <span class={`toast-icon codicon ${getToastIcon(t.type)} toast-icon--${t.type}`}></span>
        <span class="toast-message">{t.message}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .container {
    padding: 16px;
    /* Reserve space for the sticky header so filters can stick just below it */
    --workflow-runs-sticky-header-height: 72px;
  }

  .loading-container {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    padding: 48px 24px;
    background: transparent; /* Ensure no background color change */
  }

  .loading-spinner-large {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    background: transparent; /* Ensure no background color change */
  }

  .loading-spinner-large .codicon {
    font-size: 28px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }

  .loading-text-large {
    font-size: 14px;
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  .spinning-icon {
    animation: spin 0.8s linear infinite;
  }

  .header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding: 12px 0;
    background-color: var(--vscode-sideBar-background);
  }

  .header-title-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-icon {
    font-size: 18px;
    opacity: 0.9;
    color: var(--vscode-foreground);
  }

  h3 {
    margin: 0;
    font-size: 16px;
  }

  /* Welcome Header */
  .welcome-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    margin-bottom: 20px;
    background: linear-gradient(
      135deg,
      var(--vscode-editor-background) 0%,
      var(--vscode-sideBar-background) 100%
    );
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .welcome-message {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .icon-container {
    position: relative;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .wave-emoji {
    position: absolute;
    font-size: 34px;
    line-height: 1;
    opacity: 1;
    transition: opacity 0.8s ease-in-out;
  }

  .wave-emoji.fade-out {
    opacity: 0;
  }

  .wave-emoji--animated {
    animation: wave 2s ease-in-out;
    transform-origin: 70% 70%;
  }

  @keyframes wave {
    0%,
    100% {
      transform: rotate(0deg);
    }
    10%,
    30% {
      transform: rotate(14deg);
    }
    20%,
    40% {
      transform: rotate(-8deg);
    }
    50% {
      transform: rotate(14deg);
    }
    60% {
      transform: rotate(0deg);
    }
  }

  .github-icon {
    position: absolute;
    font-size: 34px;
    line-height: 1;
    color: var(--vscode-foreground);
    opacity: 0;
    transition: opacity 0.8s ease-in-out;
  }

  .github-icon.fade-in {
    opacity: 0.8;
  }

  .welcome-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .welcome-greeting-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .welcome-greeting {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }

  .welcome-username {
    font-size: 16px;
    font-weight: 700;
    color: var(--vscode-foreground);
    background: linear-gradient(
      90deg,
      var(--vscode-textLink-foreground),
      var(--vscode-textLink-activeForeground)
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .refresh-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .refresh-button {
    padding: 8px 14px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    line-height: 1;
    height: 32px; /* Explicit height for consistency */
    box-sizing: border-box; /* Ensure padding is included in height */
  }

  .refresh-icon {
    display: inline-flex;
    align-items: center;
    font-size: 14px;
  }

  .refresh-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  }

  .refresh-button:active {
    transform: translateY(0);
  }

  .refresh-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .refresh-settings-wrapper {
    position: relative;
  }

  .refresh-settings-button {
    padding: 8px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px; /* Changed from 16px to 14px to match icon size */
    line-height: 1;
    transition: all 0.2s ease;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px; /* Explicit height to match refresh button */
    box-sizing: border-box; /* Ensure padding is included in height */
  }

  .refresh-settings-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  }

  .refresh-settings-button:active {
    transform: translateY(0);
  }

  .refresh-settings-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .refresh-indicator {
    position: absolute;
    top: 2px;
    right: 2px;
    font-size: 8px;
    color: var(--vscode-charts-green);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .refresh-settings-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    z-index: 1000;
    min-width: 340px;
    max-height: calc(100vh - 100px);
    display: flex;
    flex-direction: column;
  }

  /* Settings Tab Navigation */
  .settings-tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-dropdown-border);
  }

  .settings-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .settings-tab:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }

  .settings-tab--active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground);
  }

  .settings-tab .codicon {
    font-size: 14px;
  }

  .settings-tab-content {
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .refresh-settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-dropdown-border);
  }

  .refresh-settings-header > span {
    flex: 1;
  }

  .refresh-option {
    display: block;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-foreground);
    transition: background-color 0.2s;
  }

  .refresh-option:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .refresh-option.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    font-weight: 600;
  }

  .settings-divider {
    margin: 8px 0;
    border-top: 1px solid var(--vscode-dropdown-border);
  }

  /* Rate Limit Display Styles */
  .rate-limit-display {
    padding: 8px;
    background: var(--vscode-editor-background);
    border-radius: 4px;
    margin: 4px 8px 8px;
  }

  .rate-limit-status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    margin-bottom: 4px;
  }

  .rate-limit-label {
    color: var(--vscode-descriptionForeground);
  }

  .rate-limit-value {
    font-weight: 600;
  }

  .rate-limit-progress-container {
    height: 6px;
    background: var(--vscode-input-background);
    border-radius: 3px;
    overflow: hidden;
    margin: 6px 0;
  }

  .rate-limit-progress-bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .rate-limit-progress-bar.rate-limit-good {
    background: var(--vscode-terminal-ansiGreen);
  }

  .rate-limit-progress-bar.rate-limit-caution {
    background: var(--vscode-terminal-ansiYellow);
  }

  .rate-limit-progress-bar.rate-limit-warning {
    background: var(--vscode-terminal-ansiYellow);
  }

  .rate-limit-progress-bar.rate-limit-critical {
    background: var(--vscode-errorForeground);
  }

  .rate-limit-value.rate-limit-good {
    color: var(--vscode-terminal-ansiGreen);
  }

  .rate-limit-value.rate-limit-caution {
    color: var(--vscode-terminal-ansiYellow);
  }

  .rate-limit-value.rate-limit-warning {
    color: var(--vscode-terminal-ansiYellow);
  }

  .rate-limit-value.rate-limit-critical {
    color: var(--vscode-errorForeground);
  }

  .rate-limit-percentage {
    text-align: center;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  .rate-limit-actions {
    display: flex;
    gap: 8px;
    padding: 4px 8px 8px;
  }

  .rate-limit-action-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 11px;
    padding: 4px 8px;
    transition:
      transform 0.1s ease,
      background-color 0.2s ease;
  }

  .rate-limit-action-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .rate-limit-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rate-limit-action-btn--enable {
    background: var(--vscode-testing-iconPassed, #73c991);
    border-color: var(--vscode-testing-iconPassed, #73c991);
    color: var(--vscode-editor-background, #1e1e1e);
  }

  .rate-limit-action-btn--enable:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 85%, white);
  }

  .rate-limit-action-btn .codicon {
    font-size: 12px;
  }

  .rate-limit-badge {
    background: var(--vscode-errorForeground);
    color: var(--vscode-editor-background);
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 8px;
    margin-left: 2px;
  }

  .settings-option-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 8px 8px;
    align-items: center;
  }

  .settings-option-row .refresh-option {
    flex: 1 1 45%;
    text-align: center;
  }

  .settings-option-label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-right: 4px;
    white-space: nowrap;
  }

  .settings-select {
    flex: 1;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    min-width: 80px;
  }

  .settings-select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .settings-select:hover {
    border-color: var(--vscode-focusBorder);
  }

  .settings-slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 8px;
  }

  .settings-slider-row.settings-slider-disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .settings-slider-row input[type='range'] {
    flex: 1;
  }

  .settings-slider-value {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  .settings-input-group {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px 0;
  }

  .settings-date-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
    min-width: 40px;
    flex-shrink: 0;
  }

  .settings-date-input {
    flex: 1;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 12px;
  }

  .settings-clear-button {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }

  .settings-clear-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  /* Make Manage and Unwatch all buttons match Clear Filters button styling */
  .manage-watched-button,
  .unwatch-all-button {
    padding: 8px 16px;
    height: 32px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .manage-watched-button:hover,
  .unwatch-all-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
  }

  .manage-watched-button:active,
  .unwatch-all-button:active {
    transform: translateY(0);
  }

  .manage-watched-button:disabled,
  .unwatch-all-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .manage-watched-button .codicon,
  .unwatch-all-button .codicon {
    vertical-align: text-bottom;
  }

  .settings-help-text {
    padding: 4px 12px 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .settings-checkbox-row {
    padding: 8px 12px;
  }

  .settings-checkbox-row--with-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .settings-checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
  }

  .settings-checkbox-label input[type='checkbox'] {
    width: 14px;
    height: 14px;
    cursor: pointer;
  }

  .settings-checkbox-row--disabled {
    opacity: 0.6;
  }

  .settings-checkbox-row--disabled .settings-checkbox-label {
    cursor: not-allowed;
  }

  .settings-checkbox-row--disabled .settings-checkbox-label input[type='checkbox'] {
    cursor: not-allowed;
  }

  .settings-help-text--fetching {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .settings-help-text--warning {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-editorWarning-foreground);
  }

  .settings-help-text--info {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-editorInfo-foreground);
  }

  /* Filter info messages - blue/info color scheme to distinguish from yellow warnings */
  .filter-info-message {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    margin-bottom: 8px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.4;
    background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.1));
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-editorInfo-foreground));
    color: var(--vscode-foreground);
  }

  .filter-info-content {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .filter-info-content > .codicon {
    flex-shrink: 0;
    color: var(--vscode-editorInfo-foreground);
  }

  .filter-info-content strong {
    color: var(--vscode-editorInfo-foreground);
  }

  .filter-info-content em {
    font-style: italic;
    opacity: 0.85;
  }

  .filter-info-help-button {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: transparent;
    border: 1px solid var(--vscode-editorInfo-foreground);
    border-radius: 50%;
    color: var(--vscode-editorInfo-foreground);
    cursor: pointer;
    opacity: 0.8;
    transition:
      opacity 0.2s,
      background-color 0.2s;
    flex-shrink: 0;
  }

  .filter-info-help-button:hover {
    opacity: 1;
    background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.2));
  }

  .filter-info-help-button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .filter-info-help-button .codicon {
    font-size: 12px;
  }

  /* Watched runs variant - use a slightly different shade */
  .filter-info-message--watched {
    background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.08));
  }

  .filter-info-message--watched .filter-info-content > .codicon {
    color: var(--vscode-editorInfo-foreground);
  }

  /* Favorites variant - use star color accent */
  .filter-info-message--favorites {
    background-color: var(--vscode-inputValidation-infoBackground, rgba(0, 122, 204, 0.08));
  }

  .filter-info-message--favorites .filter-info-content > .codicon {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  }

  .filter-info-message--favorites .filter-info-content strong {
    color: var(--vscode-editorInfo-foreground);
  }

  .adaptive-refresh-note {
    display: block;
    margin-top: 4px;
    color: var(--vscode-editorInfo-foreground);
    font-style: italic;
  }

  .controls {
    position: sticky;
    /* Stick just below the workflow header so both remain visible while scrolling */
    top: var(--workflow-runs-sticky-header-height);
    z-index: 15;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    padding: 8px 0;
    background-color: var(--vscode-sideBar-background);
    transition: box-shadow 0.2s ease;
  }

  /* Add subtle shadow when controls are in sticky state (user has scrolled) */
  .controls.is-scrolled {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .search-box {
    flex: 1;
  }

  .filter-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .search-box input {
    width: 100%;
    padding: 8px 12px;
    height: 32px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 13px;
    box-sizing: border-box;
    transition:
      border-color 0.3s,
      box-shadow 0.3s,
      transform 0.2s;
  }

  .search-box input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    transform: scale(1.01);
  }

  /* Base filter-box styling - position relative for lock icon overlay */
  .filter-box {
    position: relative;
  }

  .filter-box select {
    padding: 8px 12px;
    height: 32px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    font-size: 13px;
    box-sizing: border-box;
    cursor: pointer;
    transition:
      border-color 0.3s,
      box-shadow 0.3s;
  }

  .filter-box select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }

  .checkbox-filter {
    display: flex;
    align-items: center;
    /* Add consistent padding to all checkbox filters so they have the same height baseline,
       preventing layout shift when watched-runs-filter gets active styling */
    padding: 4px 0;
  }

  .checkbox-filter label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--vscode-foreground);
  }

  .checkbox-filter input[type='checkbox'] {
    cursor: pointer;
  }

  /* Enhanced disabled filter styling for better visual feedback */
  .filter-box--disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .filter-box--disabled select,
  .filter-box--disabled input,
  .filter-box--disabled button {
    cursor: not-allowed;
    background: var(--vscode-input-background);
    border-style: dashed;
    border-color: var(--vscode-disabledForeground, var(--vscode-input-border));
  }

  /* Add left padding to disabled selects to make room for the lock icon */
  .filter-box--disabled select {
    padding-left: 24px;
  }

  .filter-box--disabled.checkbox-filter label {
    cursor: not-allowed;
    color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  }

  /* Disabled indicator icon - shows a small lock icon overlaid on disabled filters */
  .filter-disabled-indicator {
    position: absolute;
    top: 50%;
    left: 4px;
    transform: translateY(-50%);
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
    font-size: 12px;
    pointer-events: auto;
    cursor: help;
  }

  .filter-disabled-indicator .codicon {
    font-size: 12px;
  }

  /* Re-enable pointer events on the indicator for tooltip */
  .filter-box--disabled .filter-disabled-indicator {
    pointer-events: auto;
  }

  /* Style for the "Watched Runs Only" filter when active - highlight it as the controlling filter */
  .watched-runs-filter:has(input:checked) {
    background: color-mix(
      in srgb,
      var(--vscode-inputOption-activeBackground, #007acc) 20%,
      transparent
    );
    border-radius: 4px;
    padding: 4px 8px;
    /* Use box-sizing and explicit dimensions to maintain consistent spacing without negative margins */
    box-sizing: border-box;
  }

  /* Combobox specific disabled styling */
  .filter-box--disabled .combobox-input-wrapper input {
    background: var(--vscode-input-background);
    /* Add left padding to make room for the lock icon when disabled */
    padding-left: 24px;
  }

  .filter-box--disabled .dropdown-toggle {
    background: var(--vscode-input-background);
  }

  .clear-filters-button {
    padding: 8px 16px;
    height: 32px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    box-sizing: border-box;
    transition:
      background-color 0.2s,
      transform 0.1s;
    white-space: nowrap;
  }

  .clear-filters-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
  }

  .clear-filters-button:active {
    transform: translateY(0);
  }
  .clear-filters-button .codicon {
    margin-right: 6px;
    vertical-align: text-bottom;
  }

  .clear-filters-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .filter-results {
    margin-bottom: 12px;
  }

  /* Inline fetch indicator - subtle text shown in Active Filters header */
  .inline-fetch-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    margin-right: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.85;
  }

  .inline-fetch-indicator .spinning-icon {
    font-size: 12px;
  }

  .filter-results-main {
    margin-bottom: 2px;
  }

  .filter-results-header {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }

  .filter-results-header:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .filter-results-title {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pagination-bar {
    margin: 8px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 12px;
  }

  .pagination-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 12px;
  }

  .pagination-button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .pagination-status {
    white-space: nowrap;
  }

  .filter-results-header-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .filter-results-count {
    font-size: 11px;
    opacity: 0.9;
  }

  .filter-results-toggle {
    font-size: 12px;
  }

  .filter-results-filters {
    margin-top: 8px;
    padding: 8px 12px;
    background: var(--vscode-textBlockQuote-background);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
  }

  .filter-pill-icon {
    font-size: 12px;
  }

  .filter-pill-text {
    white-space: nowrap;
  }

  .filter-results-empty {
    padding: 4px 0;
    font-size: 11px;
    opacity: 0.7;
    font-style: italic;
  }

  .loading,
  .empty {
    text-align: center;
    padding: 32px;
    color: var(--vscode-descriptionForeground);
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
  }

  .empty-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--vscode-foreground);
  }

  .empty-subtitle--progressive {
    margin-bottom: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--vscode-textLink-foreground);
    font-weight: 500;
  }

  .empty-suggestions {
    max-width: 500px;
    margin: 0 auto;
    text-align: left;
    background: var(--vscode-textBlockQuote-background);
    border-left: 3px solid var(--vscode-textLink-foreground);
    padding: 16px;
    border-radius: 4px;
  }

  .empty-suggestions p {
    margin: 0 0 12px 0;
    font-weight: 500;
  }

  .empty-suggestions ul {
    margin: 0;
    padding-left: 20px;
    list-style-type: disc;
  }

  .empty-suggestions li {
    margin: 8px 0;
    line-height: 1.5;
  }

  .empty-suggestions strong {
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .runs-list {
    position: relative;
    z-index: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .run-item {
    position: relative;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    transition:
      background 0.2s,
      transform 0.2s,
      box-shadow 0.2s;
  }

  .run-content {
    padding: 12px 16px;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .run-content:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .run-item:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  }

  /* Dependency graph section */
  .dependency-graph-section {
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border);
    background: var(--vscode-editor-background);
  }

  .graph-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    padding: 8px 0;
  }

  /* Action buttons container */
  .action-buttons {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border);
    background: var(--vscode-editor-background);
    flex-wrap: wrap;
  }

  .action-button {
    padding: 6px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    transition:
      background-color 0.3s,
      transform 0.2s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
  }

  .action-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: scale(1.05);
  }

  .action-button:active:not(:disabled) {
    transform: scale(0.95);
  }

  .action-button .codicon {
    margin-right: 4px;
    font-size: 14px;
    line-height: 1;
    vertical-align: middle;
  }

  .action-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .branch-name {
    font-size: 12px;
  }

  .cancel-button {
    background: var(--vscode-inputValidation-warningBackground);
    border-color: var(--vscode-inputValidation-warningBorder);
  }

  /* Ensure chevron Codicons render even if other CSS overrides them */
  .codicon.codicon-chevron-down::before {
    content: '\eab4' !important;
  }

  .codicon.codicon-chevron-right::before {
    content: '\eab6' !important;
  }

  .rerun-button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
  }

  .rerun-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  .rerun-failed-button {
    background: var(--vscode-button-secondaryBackground);
  }

  .view-button {
    background: var(--vscode-button-secondaryBackground);
  }

  .watch-button {
    background: var(--vscode-button-secondaryBackground);
  }

  .watch-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .cancel-error {
    position: absolute;
    top: 40px;
    right: 12px;
    padding: 4px 8px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
    border-radius: 2px;
    font-size: 10px;
    z-index: 10;
    max-width: 200px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .run-item.success {
    border-left: 3px solid #28a745;
  }

  .run-item.failure {
    border-left: 3px solid #d73a49;
  }

  .run-item.in-progress {
    border-left: 3px solid #0366d6;
  }

  .run-item.cancelled {
    border-left: 3px solid #6a737d;
  }

  .run-header {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-icon {
    font-size: 18px;
    flex-shrink: 0;
  }

  .status-icon--success {
    color: var(--vscode-charts-green);
  }

  .status-icon--failure {
    color: var(--vscode-charts-red);
  }

  .status-icon--in-progress {
    color: var(--vscode-charts-blue);
  }

  .status-icon--queued {
    color: var(--vscode-charts-yellow);
  }

  .status-icon--cancelled {
    color: var(--vscode-charts-orange, var(--vscode-charts-yellow));
  }

  .status-icon--skipped {
    color: var(--vscode-descriptionForeground);
  }

  .watch-icon--active {
    color: var(--vscode-charts-blue);
  }

  .run-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .run-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }

  .run-name {
    font-weight: 600;
    font-size: 14px;
  }

  .run-workflow-name-badge {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    padding: 2px 6px;
    background: var(--vscode-badge-background);
    border-radius: 3px;
  }

  .run-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .run-meta-line {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .separator {
    color: var(--vscode-descriptionForeground);
    opacity: 0.5;
  }

  /* Mini job progress indicator for in-progress runs */
  .mini-job-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 6px 10px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    font-size: 11px;
  }

  .job-progress-bar {
    width: 60px;
    height: 4px;
    background: var(--vscode-progressBar-background);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .job-progress-fill {
    height: 100%;
    background: var(--vscode-progressBar-background);
    background: linear-gradient(
      90deg,
      var(--vscode-terminal-ansiGreen) 0%,
      var(--vscode-terminal-ansiGreen) 100%
    );
    transition: width 0.3s ease;
  }

  .job-progress-text {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .running-jobs-indicator {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    color: var(--vscode-terminal-ansiYellow);
    flex: 1;
    min-width: 0;
  }

  .running-jobs-indicator > .codicon {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .running-jobs-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .running-job-item {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .running-job-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .running-job-duration {
    flex-shrink: 0;
    opacity: 0.8;
    font-size: 10px;
  }

  /* Legacy styles - kept for backward compatibility */
  .current-job-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-terminal-ansiYellow);
  }

  .current-job-name {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch,
  .actor {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .time,
  .job-time {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Legacy selectors for backward compatibility */
  .run-name-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .run-details {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  .run-item.highlighted {
    border: 2px solid var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground);
    animation: pulse 2s ease-in-out 3;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }

  .new-badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 8px;
    display: inline-block;
  }

  .status-change-message {
    background: var(--vscode-editor-infoBackground, rgba(0, 122, 204, 0.1));
    color: var(--vscode-editor-infoForeground, var(--vscode-foreground));
    border-left: 3px solid var(--vscode-editorInfo-foreground, #007acc);
    padding: 6px 10px;
    border-radius: 3px;
    font-size: 12px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-change-message .codicon {
    flex-shrink: 0;
  }

  .status-text {
    text-transform: capitalize;
    font-weight: 500;
  }

  .duration {
    font-style: italic;
  }

  /* Loading spinner animation */
  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  .refresh-button:disabled::before {
    content: '';
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: 8px;
    border: 2px solid var(--vscode-button-secondaryForeground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Fade in animation for runs list */
  .runs-list {
    animation: fadeIn 0.3s ease-in;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Pagination Controls */
  .pagination-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
    padding: 16px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .pagination-controls {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .pagination-button {
    padding: 6px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .pagination-button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  }

  .pagination-button:active:not(:disabled) {
    transform: translateY(0);
  }

  .pagination-button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .pagination-info {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    min-width: 120px;
    text-align: center;
  }

  .pagination-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pagination-status .warning-text {
    color: var(--vscode-editorWarning-foreground);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Filter results animation */
  .filter-results {
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(-20px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  /* Jobs Container */
  .jobs-container {
    margin-top: 20px;
    padding: 22px;

    .jobs-loading,
    .artifacts-loading,
    .summary-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .jobs-loading .codicon,
    .artifacts-loading .codicon,
    .summary-loading .codicon {
      margin-right: 6px;
    }

    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }

  .jobs-loading,
  .jobs-empty {
    padding: 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .job-item {
    padding: 18px;
    margin-bottom: 12px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .job-item:last-child {
    margin-bottom: 0;
  }

  .job-item:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
    transform: translateX(2px);
  }

  .job-item.success {
    border-left: 3px solid #4caf50;
  }

  .job-item.failure {
    border-left: 3px solid #f44336;
  }

  .job-item.cancelled {
    border-left: 3px solid #ff9800;
  }

  .job-item.in_progress {
    border-left: 3px solid #2196f3;
  }

  .job-item.queued {
    border-left: 3px solid #9e9e9e;
  }

  .job-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
  }

  .job-status-icon {
    font-size: 14px;
    line-height: 1;
  }

  .job-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    line-height: 1.2;
  }

  .job-details {
    display: flex;
    gap: 12px;
    margin-bottom: 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .job-status {
    text-transform: capitalize;
  }

  .job-duration {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .job-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .job-logs-button,
  .job-steps-button {
    padding: 6px 14px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .job-logs-button:hover,
  .job-steps-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
    transform: translateY(-1px);
  }

  .job-logs-button.compare-btn {
    background: var(--vscode-button-secondaryBackground);
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }

  .job-logs-button.compare-btn:hover {
    background: var(--vscode-inputOption-activeBackground, var(--vscode-button-background));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
  }

  .job-logs-button.compare-btn.selected {
    background: var(--vscode-inputOption-activeBackground, var(--vscode-button-background));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }

  /* Log Comparison Banner */
  .comparison-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: var(--vscode-inputOption-activeBackground, var(--vscode-button-background));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-button-foreground));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 13px;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .comparison-banner-icon {
    font-size: 16px;
  }

  .comparison-banner-text {
    flex: 1;
  }

  .comparison-banner-cancel {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: transparent;
    color: inherit;
    border: 1px solid currentColor;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    opacity: 0.9;
    transition: opacity 0.15s ease;
  }

  .comparison-banner-cancel:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
  }

  /* Disabled compare button styling */
  .job-logs-button.compare-btn.disabled-compare {
    opacity: 0.4;
    cursor: not-allowed;
    background: var(--vscode-button-secondaryBackground);
    border-color: var(--vscode-widget-border);
  }

  .job-logs-button.compare-btn.disabled-compare:hover {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .expand-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
  }

  .expand-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .artifacts-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
  }

  .artifacts-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  /* Artifacts Container */
  .artifacts-container {
    margin-top: 16px;
    padding: 16px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }

  .artifacts-loading,
  .artifacts-empty {
    padding: 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .artifact-item {
    padding: 12px;
    margin-bottom: 10px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid #9c27b0;
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .artifact-item:last-child {
    margin-bottom: 0;
  }

  .artifact-item:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
    transform: translateX(2px);
  }

  .artifact-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .artifact-icon {
    font-size: 14px;
  }

  .artifact-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }

  .artifact-details {
    display: flex;
    gap: 12px;
    margin-bottom: 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .artifact-size,
  .artifact-date,
  .artifact-expired {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .artifact-expired {
    color: #ff9800;
    font-weight: 600;
  }

  .artifact-download-button {
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.2s ease;
  }

  .artifact-download-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
    transform: translateY(-1px);
  }

  .artifact-download-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .summary-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
  }

  .summary-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  /* Summary Container */
  .summary-container {
    margin-top: 16px;
    padding: 16px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }

  .summary-loading,
  .summary-empty {
    padding: 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .summary-content {
    padding: 12px;
  }

  .summary-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .summary-header h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .github-summary-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .github-summary-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .github-summary-button:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .github-summary-button .codicon {
    font-size: 14px;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 18px;
  }

  .summary-section {
    padding: 12px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }

  .summary-section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .summary-stats {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .summary-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    background: var(--vscode-editor-background);
    border-radius: 3px;
    font-size: 12px;
  }

  .summary-stat-label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }

  .summary-stat-value {
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  .summary-stat.success .summary-stat-value {
    color: #4caf50;
  }

  .summary-stat.failure .summary-stat-value {
    color: #f44336;
  }

  .summary-stat.cancelled .summary-stat-value {
    color: #ff9800;
  }

  .summary-stat.skipped .summary-stat-value {
    color: #9e9e9e;
  }

  .summary-stat.in-progress .summary-stat-value {
    color: #2196f3;
  }

  .summary-stat.queued .summary-stat-value {
    color: #9e9e9e;
  }

  .commit-sha {
    font-family: 'Courier New', Courier, monospace;
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
  }

  /* Attempt badge for reruns */
  .attempt-badge {
    margin-left: 8px;
    padding: 2px 6px;
    font-size: 11px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    border: 1px solid var(--vscode-panel-border);
  }

  /* Workflow filter combobox */
  .workflow-filter-combobox {
    position: relative;
    flex: 2 1 320px; /* grow a bit more to reduce overlap with adjacent filters */
    min-width: 260px;
  }

  .combobox-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .combobox-input-wrapper input {
    flex: 1;
    padding: 8px 12px;
    padding-right: 64px; /* Match Sidebar dropdown spacing: room for toggle + clear filter */
    height: 32px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 13px;
    box-sizing: border-box;
  }

  .combobox-input-wrapper input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .combobox-input-wrapper .clear-search-button {
    position: absolute;
    right: 60px;
    padding: 4px 8px;
    min-width: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 16px;
    line-height: 1;
    opacity: 0.6;
    border: none;
    cursor: pointer;
  }

  .combobox-input-wrapper .clear-search-button:hover {
    background: var(--vscode-inputOption-hoverBackground);
    opacity: 1;
  }

  .combobox-input-wrapper .dropdown-toggle {
    position: absolute;
    right: 32px;
    padding: 4px 8px;
    min-width: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 12px;
    line-height: 1;
    opacity: 0.7;
    border: none;
    cursor: pointer;
  }

  .combobox-input-wrapper .dropdown-toggle:hover {
    background: var(--vscode-inputOption-hoverBackground);
    opacity: 1;
  }

  .combobox-input-wrapper .clear-button {
    position: absolute;
    right: 4px;
    padding: 4px 8px;
    min-width: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-size: 16px;
    line-height: 1;
    opacity: 0.6;
    border: none;
    cursor: pointer;
  }

  .combobox-input-wrapper .clear-button:hover {
    background: var(--vscode-inputOption-hoverBackground);
    opacity: 1;
  }

  .dropdown-list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 300px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    z-index: 1000;
    margin-top: 2px;
  }

  .dropdown-item {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-dropdown-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    transition:
      background-color 0.2s,
      transform 0.1s;
  }

  .dropdown-item:last-child {
    border-bottom: none;
  }

  .dropdown-item:hover {
    background: var(--vscode-list-hoverBackground);
    transform: translateX(2px);
  }

  .dropdown-item:active {
    transform: scale(0.99);
  }

  .dropdown-item[aria-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .dropdown-item.no-results {
    cursor: default;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .dropdown-item.no-results:hover {
    background: transparent;
    transform: none;
  }

  .workflow-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .dropdown-item .favorite-star {
    flex-shrink: 0;
    background: transparent;
    border: none;
    font-size: 18px;
    line-height: 1;
    padding: 4px;
    cursor: pointer;
    opacity: 0.6;
    transition:
      opacity 0.2s,
      transform 0.2s;
  }

  .dropdown-item .favorite-star:hover {
    opacity: 1;
    transform: scale(1.2);
  }

  .dropdown-item .favorite-star:active {
    transform: scale(1.1);
  }

  .workflow-name {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  .workflow-path {
    font-size: 11px;
    opacity: 0.7;
  }

  .dropdown-item.no-results {
    cursor: default;
    opacity: 0.7;
    font-style: italic;
  }

  .dropdown-item.no-results:hover {
    background: transparent;
  }

  .workflow-actions {
    display: flex;
    align-items: center;
  }

  .icon-button-small {
    min-width: 24px;
    height: 24px;
    padding: 2px 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 2px;
    cursor: pointer;
    font-size: 14px;
    transition:
      background-color 0.2s,
      transform 0.1s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .icon-button-small:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .icon-button-small:active {
    transform: scale(0.95);
  }

  .icon-button-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Star icon styling */
  .star-icon {
    display: inline-block;
    font-size: 16px;
    transition:
      color 0.2s,
      transform 0.2s;
  }

  .star-icon.starred {
    color: #fbbf24;
  }

  .star-button:hover .star-icon {
    transform: scale(1.2);
  }

  .star-button:active .star-icon {
    transform: scale(1);
  }

  /* Controls Header with Info Icon */
  .controls-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .controls-header .search-box {
    flex: 1;
    margin-bottom: 0;
  }

  /* Info Icon */
  .info-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    height: 32px;
    font-size: 16px;
    cursor: help;
    opacity: 0.7;
    transition:
      opacity 0.2s,
      transform 0.2s,
      background-color 0.2s;
  }

  .info-icon.clickable {
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    padding: 0;
    cursor: pointer;
  }

  .info-icon.clickable:hover {
    opacity: 1;
    background: var(--vscode-button-secondaryHoverBackground);
    transform: scale(1.05);
  }

  .info-icon.clickable:active {
    transform: scale(1);
  }

  .settings-info-icon {
    min-width: 24px;
    height: 24px;
    margin-left: 4px;
    flex-shrink: 0;
  }

  /* Help Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    max-width: 700px;
    width: 100%;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .modal-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
  }

  .modal-body h4 {
    margin: 16px 0 8px 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .modal-body h4:first-child {
    margin-top: 0;
  }

  .modal-body ul {
    margin: 8px 0;
    padding-left: 20px;
  }

  .modal-body li {
    margin: 6px 0;
    line-height: 1.5;
  }

  .modal-body strong {
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .modal-body code {
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }

  .modal-subtitle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .modal-branch-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
  }

  .parameters-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .parameter-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px dashed var(--vscode-panel-border);
  }

  .parameter-row:last-child {
    border-bottom: none;
  }

  .parameter-key {
    flex: 0 0 160px;
    font-weight: 600;
    font-size: 12px;
    color: var(--vscode-foreground);
    word-break: break-word;
  }

  .parameter-value {
    flex: 1;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .parameter-value pre {
    margin: 0;
    white-space: pre-wrap;
  }

  .parameters-empty,
  .parameters-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  /* Watched Runs Modal */
  .watched-runs-modal {
    max-width: 600px;
  }

  .watched-runs-info {
    margin-bottom: 16px;
  }

  .watched-runs-info p {
    margin: 8px 0;
    font-size: 13px;
  }

  .watched-runs-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 400px;
    overflow-y: auto;
  }

  .watched-run-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-input-background);
    transition: background-color 0.2s;
  }

  .watched-run-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .watched-run-info {
    flex: 1;
    min-width: 0;
  }

  .watched-run-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .watched-run-name {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watched-run-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .unwatch-button {
    padding: 6px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .unwatch-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .modal-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .close-button:hover {
    opacity: 1;
  }

  .primary-button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 8px 16px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    transition: background-color 0.2s;
  }

  .secondary-button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border);
    padding: 8px 16px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    transition: background-color 0.2s;
  }

  .secondary-button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .primary-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .danger-button {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    padding: 8px 16px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
    transition: background-color 0.2s;
  }

  .danger-button:hover {
    background: var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-button-foreground, #fff);
  }

  /* Cancel confirmation modal specific styles */
  .cancel-confirm-message {
    margin: 0 0 16px 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--vscode-foreground);
  }

  .cancel-confirm-message strong {
    color: var(--vscode-foreground);
  }

  .cancel-confirm-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
  }

  .cancel-confirm-detail {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--vscode-foreground);
  }

  .cancel-confirm-detail .codicon {
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    font-size: 14px;
  }

  .cancel-confirm-detail .detail-label {
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .cancel-confirm-detail .detail-value {
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }

  .cancel-confirm-warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    background: var(--vscode-inputValidation-warningBackground, rgba(205, 145, 52, 0.1));
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cd9134);
    border-radius: 4px;
    margin: 0;
    font-size: 12px;
    color: var(--vscode-foreground);
  }

  .cancel-confirm-warning .codicon {
    color: var(--vscode-inputValidation-warningBorder, #cd9134);
    flex-shrink: 0;
    margin-top: 2px;
  }

  /* Toast notifications */
  .toast-container {
    position: fixed;
    top: 12px;
    right: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border);
    border-left-width: 4px;
    padding: 8px 12px;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    max-width: 320px;
  }

  .toast-icon {
    font-size: 14px;
    line-height: 1;
  }

  .toast-icon--success {
    color: var(--vscode-charts-green);
  }

  .toast-icon--error {
    color: var(--vscode-charts-red);
  }

  .toast-icon--warning {
    color: var(--vscode-charts-yellow);
  }

  .toast-icon--info {
    color: var(--vscode-charts-blue);
  }

  .toast-message {
    font-size: 12px;
  }

  .toast-success {
    border-left-color: #2ea043;
  }

  .toast-error {
    border-left-color: #f85149;
  }

  .toast-warning {
    border-left-color: #d29922;
  }

  .toast-info {
    border-left-color: #58a6ff;
  }

  /* Health Monitor Notification Banner */
  .health-notification {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cd9134);
    border-radius: 8px;
    padding: 12px 16px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 1001;
    max-width: 500px;
    width: calc(100% - 32px);
  }

  .health-notification-content {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .health-notification-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: rgba(205, 145, 52, 0.15);
    border-radius: 50%;
  }

  .health-notification-icon .codicon {
    font-size: 16px;
    color: var(--vscode-inputValidation-warningBorder, #cd9134);
  }

  .health-notification-text {
    flex: 1;
    min-width: 0;
  }

  .health-notification-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 4px;
  }

  .health-notification-reason {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
  }

  .health-notification-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.85;
    margin-top: 4px;
    font-style: italic;
  }

  .health-notification-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
  }

  .health-action-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .health-action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .health-action-btn .codicon {
    font-size: 12px;
  }

  .health-action-dismiss {
    margin-left: auto;
    padding: 6px 8px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
  }

  .health-action-dismiss:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }

  /* Screen reader only - visually hidden but accessible to assistive technologies */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
