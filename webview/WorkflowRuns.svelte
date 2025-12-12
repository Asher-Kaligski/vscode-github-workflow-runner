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
  import { formatDuration as formatMs } from './utils/graph-utils';

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

  const MAX_TOTAL_RUNS_OPTIONS: number[] = [1000, 2000, 3000, 5000, 10000];
  const WORKFLOW_LOAD_LIMIT_OPTIONS: number[] = [10, 20, 30, 50, 100];
  const AUTO_REFRESH_SECONDS_OPTIONS: number[] = [0, 15, 30, 45, 60, 90, 120, 180];
  const DEFAULT_MAX_TOTAL_RUNS = 2000;
  const DEFAULT_WORKFLOW_LOAD_LIMIT = 20;
  const DEFAULT_AUTO_REFRESH_SECONDS = 30;

  let runs: WorkflowRun[] = [];
  let filteredRuns: WorkflowRun[] = [];
  let visibleRuns: WorkflowRun[] = [];
  let loading = true;
  let refreshInterval: number | null = null;
  let highlightedRunId: number | null = null;
  let autoRefreshSeconds = DEFAULT_AUTO_REFRESH_SECONDS;
  let autoRefreshPaused = false; // Pause auto-refresh when opening external resources

  // Track status changes for background updates
  // Map<runId, { oldStatus: string, newStatus: string, timestamp: number }>
  let statusChanges: Map<number, { oldStatus: string; newStatus: string; timestamp: number }> =
    new Map();

  let searchQuery = '';
  let statusFilter = 'all';
  let refreshing = false;
  let showRefreshSettings = false;
  let settingsActiveTab: 'general' | 'notifications' = 'general'; // Active tab in settings dropdown
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
  let pendingWorkflowId: number | null | 'all' = null;

  // Timeout ID for scheduled progressive fetch - allows cancellation when switching workflows
  let progressiveFetchTimeoutId: number | null = null;
  // Debounce timeout ID for workflow switches to prevent rapid-fire requests
  let workflowSwitchDebounceId: number | null = null;
  // Counter to track workflow switch generation - used to ignore stale progressive fetch callbacks
  let workflowSwitchGeneration = 0;

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
    if (workflowSwitchDebounceId !== null) {
      window.clearTimeout(workflowSwitchDebounceId);
      workflowSwitchDebounceId = null;
    }

    // Cancel pending initial filter timeout
    if (initialFilterTimeout !== null) {
      window.clearTimeout(initialFilterTimeout);
      initialFilterTimeout = null;
    }

    // Reset progressive fetching state
    progressiveFetching = false;

    // Increment generation to invalidate any in-flight progressive fetch callbacks
    workflowSwitchGeneration++;
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

  // Reactive: reset pagination when the workflow selection changes so that
  // we always show the first page for the newly selected workflow.
  $: {
    if (workflowFilter !== previousWorkflowFilter) {
      currentPage = 1;
      previousWorkflowFilter = workflowFilter;
    }
  }

  // Track previous username to detect changes
  let previousCurrentUsername = '';

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

  // Motion preference
  reduceMotion = !!(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  // Job expansion state
  let expandedRuns = new Set<number>(); // Set of expanded run IDs
  let runJobs = new Map<number, WorkflowJob[]>(); // Map of run ID to jobs
  let loadingJobs = new Set<number>(); // Set of run IDs currently loading jobs

  // Job dependency graph state
  let runJobDefinitions = new Map<number, WorkflowJobDefinition[]>(); // Map of run ID to job definitions
  let loadingJobDependencies = new Set<number>(); // Set of run IDs currently loading job dependencies
  let showDependencyGraph = new Set<number>(); // Set of run IDs with graph visible

  // Artifacts state
  let runArtifacts = new Map<number, any[]>(); // Map of run ID to artifacts
  let loadingArtifacts = new Set<number>(); // Set of run IDs currently loading artifacts
  let showArtifacts = new Set<number>(); // Set of run IDs with artifacts section visible

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

  // Job steps modal state (for jobs list view)
  let selectedJobForStepsModal: JobGraphNode | null = null;
  let selectedJobRunIdForSteps: number | null = null;
  let loadingJobSteps: Set<number> = new Set(); // Track jobs currently loading steps
  let loadingJobLogs: Set<number> = new Set(); // Track jobs currently checking logs availability
  let loadingStepLogs: Map<string, boolean> = new Map(); // Track steps currently loading logs (key: jobId-stepNumber)

  // Job graph modal state (full screen view)
  let showJobGraphModal = false;
  let jobGraphModalRunId: number | null = null;

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
  let workflowRunsCache: Map<string, WorkflowRunsCache> = new Map();
  const CACHE_EXPIRATION_MS = 3 * 60 * 1000; // 3 minutes

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

    // Trigger welcome wave animation if allowed
    triggerWorkflowRunsWaveIfAllowed();

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleWorkflowDropdownClickOutside);
      window.removeEventListener('scroll', handleScroll);
      stopAutoRefresh();
    };
  });

  onDestroy(() => {
    stopAutoRefresh();
  });

  /**
   * Start auto-refresh timer
   */
  function startAutoRefresh() {
    stopAutoRefresh(); // Clear any existing interval

    if (autoRefreshSeconds > 0) {
      refreshInterval = window.setInterval(() => {
        // Avoid overlapping with explicit background fetches or temporary
        // pauses (for example when viewing logs or artifacts), or while
        // the panel is already busy loading data (initial load, manual
        // refresh, "Load more", or a date-filtered fetch).
        if (
          !autoRefreshPaused &&
          !loadingMore &&
          !loading &&
          !refreshing &&
          !fetchingDateFilteredRuns
        ) {
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
            vscode.postMessage({
              type: 'backgroundRefreshAllRuns',
            });
          }
        }
      }, autoRefreshSeconds * 1000);
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
      AUTO_REFRESH_SECONDS_OPTIONS.length - 1
    );
    const nextSeconds = AUTO_REFRESH_SECONDS_OPTIONS[clampedIndex];
    if (
      typeof nextSeconds !== 'number' ||
      !Number.isFinite(nextSeconds) ||
      nextSeconds === autoRefreshSeconds
    ) {
      autoRefreshIndex = clampedIndex;
      return;
    }

    autoRefreshIndex = clampedIndex;
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
   */
  function getAutoRefreshOptionIndex(value: number | null | undefined): number {
    const safeValue =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : DEFAULT_AUTO_REFRESH_SECONDS;

    const foundIndex = AUTO_REFRESH_SECONDS_OPTIONS.indexOf(safeValue);
    if (foundIndex !== -1) {
      return foundIndex;
    }

    const fallbackIndex = AUTO_REFRESH_SECONDS_OPTIONS.indexOf(DEFAULT_AUTO_REFRESH_SECONDS);
    return fallbackIndex >= 0 ? fallbackIndex : 0;
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
   */
  function formatAutoRefreshLabel(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return 'Off';
    }

    if (seconds < 60) {
      return `${seconds} seconds`;
    }

    switch (seconds) {
      case 60:
        return '1 minute';
      case 90:
        return '1 minute 30 seconds';
      case 120:
        return '2 minutes';
      case 180:
        return '3 minutes';
      default:
        return `${seconds} seconds`;
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
    // at a time. This avoids pulling hundreds of extra runs when the user is
    // simply browsing the latest runs, while still allowing progressive
    // fetching to walk forward page-by-page when client-side filters (e.g.
    // "My Runs", status, search, watched-only) reduce the visible results
    // below the configured workflowLoadLimit.
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
    filtersExpanded = !filtersExpanded;
    userManuallyToggledFilters = true;
  }

  /**
   * Toggle run expansion to show/hide jobs
   * Closes other sections (Graph, Artifacts, Summary) when opening
   */
  function toggleRunExpansion(runId: number) {
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
   * Opens the job logs
   */
  function handleGraphJobClick(node: JobGraphNode, runId: number) {
    if (node.jobId) {
      viewJobLogs(node.jobId, node.name, runId);
    }
  }

  /**
   * View job logs
   */
  function viewJobLogs(jobId: number, jobName: string, runId: number) {
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
    if (jobId === undefined) return new Set();
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
   * Open job steps modal from jobs list
   * Converts WorkflowJob to JobGraphNode format for the modal
   * For running jobs, fetches the latest steps from the API
   */
  function openJobStepsModal(job: WorkflowJob, runId: number) {
    // Don't show steps for queued jobs (they haven't started yet)
    if (job.status === 'queued') {
      return;
    }

    // For completed jobs with steps, show immediately
    if (job.status === 'completed' && job.steps && job.steps.length > 0) {
      showJobStepsModalWithData(job, runId);
      return;
    }

    // For running jobs or jobs without steps data, fetch from API
    if (job.status === 'in_progress' || !job.steps || job.steps.length === 0) {
      loadingJobSteps.add(job.id);
      loadingJobSteps = loadingJobSteps; // Trigger reactivity

      // Set the runId so the response handler knows which run this is for
      selectedJobRunIdForSteps = runId;

      vscode.postMessage({
        type: 'getJobDetails',
        data: { jobId: job.id, runId },
      });
      return;
    }

    // Fallback: show with available data
    showJobStepsModalWithData(job, runId);
  }

  /**
   * Helper to display job steps modal with job data
   */
  function showJobStepsModalWithData(job: WorkflowJob, runId: number) {
    const duration =
      job.started_at && job.completed_at
        ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
        : job.started_at
          ? Date.now() - new Date(job.started_at).getTime()
          : undefined;

    selectedJobForStepsModal = {
      id: job.name,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion || undefined,
      position: { x: 0, y: 0 },
      dependencies: [],
      jobId: job.id,
      steps: job.steps || [],
      duration,
    };
    selectedJobRunIdForSteps = runId;
  }

  /**
   * Close job steps modal
   */
  function closeJobStepsModal() {
    selectedJobForStepsModal = null;
    selectedJobRunIdForSteps = null;
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
    if (showSummary.has(runId)) {
      showSummary.delete(runId);
      showSummary = showSummary; // Trigger reactivity
    } else {
      // When opening summary, close jobs and artifacts for this run so that
      // only one section (Jobs, Artifacts, or Summary) is expanded at a time.
      if (expandedRuns.has(runId)) {
        expandedRuns.delete(runId);
        expandedRuns = expandedRuns; // Trigger reactivity
      }
      if (showArtifacts.has(runId)) {
        showArtifacts.delete(runId);
        showArtifacts = showArtifacts; // Trigger reactivity
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
    const matchingRun = runs.find((run) => {
      const runPath = run.path.split('@')[0];
      return runPath === workflow.path;
    });

    // Clear notifications from previous workflow to prevent stale notifications
    clearAllToasts();
    clearStatusChanges();

    // Show a loading state while fetching runs for the selected workflow
    runs = [];
    filteredRuns = [];
    smartSuggestions = [];
    loading = true;

    // Mark this as a manual workflow fetch to skip the filter message wait
    isManualWorkflowFetch = true;

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
        // pendingWorkflowId will be set when we get the workflow ID response
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
    // Cancel all pending operations from previous workflow
    cancelPendingOperations();

    workflowFilter = 'all';
    workflowSearchQuery = '';
    isWorkflowSearchActive = false;
    workflowDropdownOpen = false;

    // Clear notifications from previous workflow to prevent stale notifications
    clearAllToasts();
    clearStatusChanges();

    // Show a loading state while fetching runs without a workflow filter
    runs = [];
    filteredRuns = [];
    smartSuggestions = [];
    loading = true;

    // Mark this as a manual workflow fetch to skip the filter message wait
    isManualWorkflowFetch = true;
    // Track that we're expecting "all" runs (no workflow filter)
    pendingWorkflowId = 'all';

    // Debounce the actual request to prevent rapid-fire API calls
    workflowSwitchDebounceId = window.setTimeout(() => {
      workflowSwitchDebounceId = null;
      // Request all runs (no workflow filter)
      vscode.postMessage({ type: 'getWorkflowRuns' });
    }, 150); // 150ms debounce for rapid workflow switches
  }

  /**
   * Handle click outside workflow dropdown
   */
  function handleWorkflowDropdownClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.workflow-filter-combobox')) {
      workflowDropdownOpen = false;
    }
  }

  /**
   * Handle "Show Bot Runs" checkbox change with one-way coupling.
   * Rule: When CHECKED → automatically switch to "All Users" (bot runs only visible with All Users)
   * Rule: When UNCHECKED → do NOT change Actor Filter (user can view All Users or My Runs without bots)
   */
  function handleShowBotRunsChange() {
    if (showBotRuns) {
      // User just checked "Show Bot Runs" → switch to "All Users" if not already
      if (actorFilter !== 'all') {
        actorFilter = 'all';
        console.log('[WorkflowRuns] Show Bot Runs enabled: switching to All Users');
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
    filterRuns();

    if (showWatchedOnly && watchedRuns.size > 0) {
      vscode.postMessage({
        type: 'backgroundRefreshWatchedRuns',
        data: { watchedRunIds: Array.from(watchedRuns) },
      });
    }
  }

  /**
   * Handle actor filter dropdown change with one-way coupling.
   * Rule: When "My Runs" selected → automatically uncheck "Show Bot Runs" (My Runs never shows bots)
   * Rule: When "All Users" selected → do NOT change "Show Bot Runs" (All Users can show with or without bots)
   */
  function handleActorFilterChange() {
    if (actorFilter === 'me') {
      // User selected "My Runs" → uncheck bot runs if checked
      if (showBotRuns) {
        showBotRuns = false;
        console.log('[WorkflowRuns] Actor filter changed to My Runs: disabling bot runs');
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
   * Get cache key for current workflow filter
   */
  function getCacheKey(): string {
    return workflowFilter === 'all' ? '__all__' : workflowFilter;
  }

  /**
   * Check if cache is valid for a specific workflow
   */
  function isCacheValid(workflowPath: string): boolean {
    const cache = workflowRunsCache.get(workflowPath);
    if (!cache) {
      return false;
    }
    const now = Date.now();
    const age = now - cache.cacheTimestamp;
    return age < CACHE_EXPIRATION_MS;
  }

  /**
   * Save runs to workflow-specific cache
   */
  function saveToCache(
    workflowPath: string,
    runs: WorkflowRun[],
    totalCount: number,
    repository: { owner: string; name: string } | null
  ) {
    const now = Date.now();
    workflowRunsCache.set(workflowPath, {
      runs,
      totalCount,
      lastFetchTimestamp: now,
      cacheTimestamp: now,
      repository,
    });
    console.log(
      '[WorkflowRuns] Saved runs to cache for workflow:',
      workflowPath,
      runs.length,
      'runs'
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

    // Now apply filters and clear loading state
    buildAvailableWorkflows();
    filterRuns();
    loading = false;
    refreshing = false;

    // Auto-load jobs for in-progress runs to show mini progress indicator (Issue 5)
    autoLoadJobsForInProgressRuns();
  }

  /**
   * Handle messages from extension
   */
  function handleMessage(event: MessageEvent) {
    const message = event.data;

    // Avoid disruptive refresh while we intentionally pause (e.g., when opening logs)
    if (message.type === 'getWorkflowRuns') {
      // Always clear the date-filter fetching indicator when a runs payload
      // arrives, even if we skip applying it while auto-refresh is paused.
      fetchingDateFilteredRuns = false;

      if (autoRefreshPaused) {
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

      // Check if this is a stale response that should be ignored
      // This happens when we're waiting for a workflow-specific response but
      // a response from webviewReady (with all runs) arrives first
      if (isManualWorkflowFetch && pendingWorkflowId !== null) {
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
        buildAvailableWorkflows();
        filterRuns();
        loading = false;
        refreshing = false;
      } else if (isInitialLoad) {
        console.log(
          '[WorkflowRuns] Initial load detected - waiting for filter messages before finalizing'
        );
        waitingForInitialFilters = true;

        // Set a timeout to finalize the load even if filter messages don't arrive
        // This prevents indefinite waiting if no filter messages are sent
        initialFilterTimeout = window.setTimeout(() => {
          console.log('[WorkflowRuns] Filter message timeout - finalizing initial load');
          finalizeInitialLoad();
        }, 500); // 500ms should be enough for filter messages to arrive

        // Don't call filterRuns() or clear loading state yet - wait for filter messages
      } else {
        // This is a refresh or subsequent load - apply filters immediately
        buildAvailableWorkflows();
        filterRuns();
        loading = false;
        refreshing = false;
      }
    } else if (message.type === 'getWorkflowRuns' && !message.success) {
      // Handle error case - reset loading states
      console.error('[WorkflowRuns] Failed to fetch workflow runs:', message.error);
      isManualWorkflowFetch = false;
      pendingWorkflowId = null;
      loading = false;
      refreshing = false;
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
      if (runId) {
        if (message.success) {
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
          // Mark as failed
          cancellationState.failedCancellations.set(
            runId,
            message.error || 'Failed to cancel workflow'
          );
          cancellationState.cancellingRuns.delete(runId);
          cancellationState = cancellationState; // Trigger reactivity
        }
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
    } else if (message.type === 'viewStepLogsResponse') {
      // Handle response for viewing step logs
      const jobId = message.data?.jobId;
      const stepNumber = message.data?.stepNumber;
      if (jobId && stepNumber !== undefined) {
        const key = `${jobId}-${stepNumber}`;
        loadingStepLogs.delete(key);
        loadingStepLogs = loadingStepLogs; // Trigger reactivity
      }
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

          // Rebuild available workflows with new runs
          buildAvailableWorkflows();

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
          runJobs.set(runId, jobs);
          runJobs = runJobs; // Trigger reactivity

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
            runJobs.set(runId, jobs);
            runJobs = runJobs; // Trigger reactivity

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
          runArtifacts.set(runId, message.data?.artifacts || []);
          runArtifacts = runArtifacts; // Trigger reactivity
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
      if (message.success && message.data) {
        const updatedRuns = message.data.runs || [];
        console.log(
          '[WorkflowRuns] Background refresh: received',
          updatedRuns.length,
          'watched runs'
        );

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

        // Refresh jobs for watched runs that are in-progress
        for (const run of updatedRuns as WorkflowRun[]) {
          if (run.status === 'in_progress' || run.status === 'queued') {
            vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId: run.id } });
          }
        }

        // Also refresh jobs if the modal is open showing a job from a watched run
        // (even if the run has completed, so the modal shows updated status)
        if (selectedJobForStepsModal && selectedJobRunIdForSteps) {
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
      if (message.success && message.data) {
        const newRuns = message.data.runs || [];
        console.log('[WorkflowRuns] Background refresh all: received', newRuns.length, 'runs');

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
        // Track workflow-level status changes for notifications (Issue 9)
        const workflowStatusChanges: Array<{
          name: string;
          status: string;
          conclusion?: string;
          matchesActiveFilters: boolean;
        }> = [];
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

              // Track workflow-level status changes for notification (Issue 9)
              // Only notify for significant workflow state transitions
              const isWorkflowStarted = run.status === 'queued' && newRun.status === 'in_progress';
              const isWorkflowCompleted =
                run.status === 'in_progress' && newRun.status === 'completed';

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
        for (const newRun of newRuns) {
          if (!existingRunIds.has(newRun.id)) {
            runs = [newRun, ...runs];
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

        // Show workflow-level notifications only (Issue 9)
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

        // Issue 8: Refresh jobs for all in-progress runs
        // This ensures the mini progress indicator and graph stay updated
        for (const run of runs) {
          if (run.status === 'in_progress' || run.status === 'queued') {
            // Refresh jobs for in-progress runs
            vscode.postMessage({ type: 'getWorkflowRunJobs', data: { runId: run.id } });
          }
        }

        // Also refresh jobs if the modal is open showing a job from any updated run
        // (even if the run has completed, so the modal shows updated status)
        if (selectedJobForStepsModal && selectedJobRunIdForSteps) {
          const modalRunUpdated = newRunsMap.has(selectedJobRunIdForSteps);
          // Only refresh if the run was updated and not already refreshed above
          const modalRun = runs.find((r) => r.id === selectedJobRunIdForSteps);
          const alreadyRefreshed =
            modalRun && (modalRun.status === 'in_progress' || modalRun.status === 'queued');
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
        const { autoRefreshSeconds: restoredSeconds } = message.data as {
          autoRefreshSeconds?: number;
        };
        if (
          typeof restoredSeconds === 'number' &&
          Number.isFinite(restoredSeconds) &&
          restoredSeconds >= 0
        ) {
          console.log('[WorkflowRuns] Restoring auto-refresh to', restoredSeconds, 'seconds');
          autoRefreshSeconds = restoredSeconds;
          autoRefreshIndex = getAutoRefreshOptionIndex(autoRefreshSeconds);
          startAutoRefresh();
        }
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
   * Accepts options to temporarily skip specific filters (used for smart suggestions).
   */
  function applyFiltersToRuns(options: FilterComputationOptions = {}): WorkflowRun[] {
    let filtered = runs;

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

    // Filter out bot runs by default (unless showBotRuns is true)
    if (!skipBot && !showBotRuns) {
      filtered = filtered.filter((run) => !run.actor.login.endsWith('[bot]'));
    }

    // Apply actor filter
    if (!skipActor) {
      if (actorFilter === 'me' && currentUsername) {
        filtered = filtered.filter((run) => run.actor.login === currentUsername);
      } else if (actorFilter !== 'all' && actorFilter !== 'me') {
        filtered = filtered.filter((run) => run.actor.login === actorFilter);
      }
    }

    // Apply favorites filter (show only runs from favorite workflows)
    if (!skipFavoritesOnly && showFavoritesOnly && markedWorkflows.length > 0) {
      filtered = filtered.filter((run) => {
        // Extract workflow path without @branch suffix
        const workflowPath = run.path.split('@')[0];
        return markedWorkflows.includes(workflowPath);
      });
    }

    // Apply workflow filter (by workflow file path)
    if (!skipWorkflow && workflowFilter !== 'all') {
      filtered = filtered.filter((run) => {
        // Extract workflow path without @branch suffix
        const workflowPath = run.path.split('@')[0];
        return workflowPath === workflowFilter;
      });
    }

    // Apply search filter
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

    // Apply date/time filter (from selected date/time onwards, up to optional end).
    if (!skipDate && (dateFilterFrom || dateFilterTo)) {
      // CRITICAL FIX: Use parseDateTimeLocal() to parse datetime-local strings
      // as local time, not UTC. This fixes the timezone mismatch issue.
      const fromDate = dateFilterFrom ? parseDateTimeLocal(dateFilterFrom) : null;
      const toDate = dateFilterTo ? parseDateTimeLocal(dateFilterTo) : null;

      const hasValidFrom = fromDate && !Number.isNaN(fromDate.getTime());
      const hasValidTo = toDate && !Number.isNaN(toDate.getTime());

      console.log('[WorkflowRuns] Date Filter Debug:', {
        dateFilterFrom,
        dateFilterTo,
        fromDate: fromDate?.toISOString(),
        toDate: toDate?.toISOString(),
        hasValidFrom,
        hasValidTo,
        runsBeforeFilter: filtered.length,
      });

      if (hasValidFrom || hasValidTo) {
        let filteredOutCount = 0;

        filtered = filtered.filter((run) => {
          const timestamp = run.run_started_at ?? run.created_at;
          const runDate = new Date(timestamp);

          if (Number.isNaN(runDate.getTime())) {
            return true;
          }

          let shouldInclude = true;

          if (hasValidFrom && fromDate && runDate < fromDate) {
            shouldInclude = false;
            if (filteredOutCount === 0) {
              console.log('[WorkflowRuns] Sample run filtered out (before fromDate):', {
                runId: run.id,
                timestamp,
                runDate: runDate.toISOString(),
                fromDate: fromDate.toISOString(),
                comparison: `${runDate.toISOString()} < ${fromDate.toISOString()}`,
              });
            }
            filteredOutCount++;
          }

          if (hasValidTo && toDate && runDate > toDate) {
            shouldInclude = false;
            if (filteredOutCount === 0) {
              console.log('[WorkflowRuns] Sample run filtered out (after toDate):', {
                runId: run.id,
                timestamp,
                runDate: runDate.toISOString(),
                toDate: toDate.toISOString(),
                comparison: `${runDate.toISOString()} > ${toDate.toISOString()}`,
              });
            }
            filteredOutCount++;
          }

          return shouldInclude;
        });

        console.log('[WorkflowRuns] Date Filter Results:', {
          runsAfterFilter: filtered.length,
          filteredOutCount,
          sampleIncludedRun:
            filtered.length > 0
              ? {
                  id: filtered[0].id,
                  timestamp: filtered[0].run_started_at ?? filtered[0].created_at,
                  runDate: new Date(
                    filtered[0].run_started_at ?? filtered[0].created_at
                  ).toISOString(),
                }
              : null,
        });
      }
    }

    // Apply status filter
    if (!skipStatus && statusFilter !== 'all') {
      filtered = filtered.filter((run) => {
        if (statusFilter === 'completed') {
          return run.status === 'completed' && run.conclusion === 'success';
        }
        if (statusFilter === 'failed') {
          return run.status === 'completed' && run.conclusion === 'failure';
        }
        if (statusFilter === 'in_progress') {
          return run.status === 'in_progress';
        }
        if (statusFilter === 'queued') {
          return run.status === 'queued';
        }
        if (statusFilter === 'cancelled') {
          return run.status === 'completed' && run.conclusion === 'cancelled';
        }
        return true;
      });
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
   * Filter runs based on search query, status, actor, workflow, and bot runs.
   *
   * This also updates the current page slice used for rendering so pagination
   * stays in sync after any filter or setting change.
   */
  function filterRuns() {
    console.log(
      '[WorkflowRuns] filterRuns called: showWatchedOnly=',
      showWatchedOnly,
      'watchedRuns.size=',
      watchedRuns.size,
      'runs.length=',
      runs.length
    );
    const baseOptions = getBaseFilterOptionsForCurrentContext();
    filteredRuns = applyFiltersToRuns(baseOptions);
    console.log('[WorkflowRuns] filterRuns result: filteredRuns.length=', filteredRuns.length);

    // Keep client-side pagination slice in sync with the latest filters.
    const limit = workflowLoadLimit > 0 ? workflowLoadLimit : 20;
    const safePage = currentPage > 0 ? currentPage : 1;
    const start = (safePage - 1) * limit;
    const end = start + limit;
    visibleRuns = filteredRuns.slice(start, end);

    smartSuggestions =
      filteredRuns.length === 0 && runs.length > 0 ? computeSmartSuggestions(baseOptions) : [];

    // After (re)computing the filtered and visible runs, decide whether we
    // should continue progressive fetching for the current page / view.
    scheduleProgressiveFetchIfNeeded();
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
      labels.push('Favorites only');
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
   * Cancel workflow run
   */
  function handleCancelRun(run: WorkflowRun) {
    // Delegate confirmation to the extension host (webview cannot show window.confirm)
    vscode.postMessage({
      type: 'requestCancelWorkflowRun',
      data: { runId: run.id, runName: run.display_title || run.name },
    });
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
   * Changed from Jobs to Graph as the default view per Issue 4
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
              </div>

              <!-- General Tab Content -->
              {#if settingsActiveTab === 'general'}
                <div class="settings-tab-content">
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
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={AUTO_REFRESH_SECONDS_OPTIONS.length - 1}
                      step="1"
                      value={autoRefreshIndex}
                      on:input={handleAutoRefreshSliderChange}
                      title={formatAutoRefreshLabel(autoRefreshSeconds)}
                    />
                    <span class="settings-slider-value">
                      {formatAutoRefreshLabel(autoRefreshSeconds)}
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Controls how often the panel refreshes runs in the background.
                  </div>

                  <div class="settings-divider"></div>

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
                    {:else if !hasActiveDateFilter() && totalRunsFetched >= NON_DATE_MAX_TOTAL_RUNS}
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
              </div>

              <!-- General Tab Content -->
              {#if settingsActiveTab === 'general'}
                <div class="settings-tab-content">
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
                  <div class="settings-slider-row">
                    <input
                      type="range"
                      min="0"
                      max={AUTO_REFRESH_SECONDS_OPTIONS.length - 1}
                      step="1"
                      value={autoRefreshIndex}
                      on:input={handleAutoRefreshSliderChange}
                      title={formatAutoRefreshLabel(autoRefreshSeconds)}
                    />
                    <span class="settings-slider-value">
                      {formatAutoRefreshLabel(autoRefreshSeconds)}
                    </span>
                  </div>
                  <div class="settings-help-text">
                    Controls how often the panel refreshes runs in the background.
                  </div>

                  <div class="settings-divider"></div>

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
      {:else if !hasActiveDateFilter() && totalRunsFetched >= NON_DATE_MAX_TOTAL_RUNS}
        <div class="settings-help-text settings-help-text--warning">
          <span class="codicon codicon-alert"></span>
          <span>
            Loaded {NON_DATE_MAX_TOTAL_RUNS} most recent runs. Please apply date filters to search further
            back in history.
          </span>
        </div>
      {/if}
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
      <div class="filter-box">
        <select
          bind:value={statusFilter}
          on:change={handleStatusFilterChange}
          disabled={loading || showWatchedOnly}
          title={showWatchedOnly
            ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
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
      <div class="filter-box">
        <select
          bind:value={actorFilter}
          on:change={handleActorFilterChange}
          disabled={loading || showWatchedOnly}
          title={showWatchedOnly
            ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
            : "Filter runs by who triggered them. Selecting 'My Runs' automatically hides bot runs."}
        >
          <option value="all">All Users</option>
          <option value="me">My Runs</option>
        </select>
      </div>
      <div class="filter-box workflow-filter-combobox">
        <div class="combobox-container">
          <div class="combobox-input-wrapper">
            <input
              type="text"
              placeholder="All workflows – type to search"
              bind:value={workflowSearchQuery}
              on:input={handleWorkflowSearchInput}
              on:focus={() => {
                if (!showWatchedOnly) {
                  workflowDropdownOpen = true;
                  // Show all workflows on open while keeping selected text visible
                  const previousQuery = workflowSearchQuery;
                  workflowSearchQuery = '';
                  filterAvailableWorkflows();
                  // Restore the query to preserve the selected workflow name in the input
                  workflowSearchQuery = previousQuery;
                }
              }}
              disabled={loading || showWatchedOnly}
              autocomplete="off"
              title={showWatchedOnly
                ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                : 'Filter runs by workflow file; type to search, or leave blank to see all workflows'}
            />
            <button
              class="dropdown-toggle"
              on:click={() => {
                if (!showWatchedOnly) {
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
                ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
                : workflowDropdownOpen
                  ? 'Close dropdown'
                  : 'Open dropdown'}
              disabled={loading || showWatchedOnly}
            >
              {workflowDropdownOpen ? '▲' : '▼'}
            </button>
            {#if workflowFilter !== 'all'}
              <button
                class="clear-button"
                on:click={clearWorkflowFilter}
                disabled={showWatchedOnly}
                title={showWatchedOnly
                  ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
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
      <div class="filter-box checkbox-filter">
        <label>
          <input
            type="checkbox"
            bind:checked={showBotRuns}
            on:change={handleShowBotRunsChange}
            disabled={loading || showWatchedOnly}
            title={showWatchedOnly
              ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
              : "Include runs triggered by bot accounts. Checking this automatically switches to 'All Users'."}
          />
          Show Bot Runs
        </label>
      </div>

      <div class="filter-box checkbox-filter">
        <label>
          <input
            type="checkbox"
            bind:checked={showWatchedOnly}
            on:change={handleShowWatchedOnlyChange}
            disabled={loading || watchedRuns.size === 0}
            title="Show only runs you have marked as watched; ignores all other filters"
          />
          Watched Runs Only
          {#if watchedRuns.size > 0}
            ({watchedRuns.size})
          {/if}
        </label>
      </div>

      <div class="filter-box checkbox-filter">
        <label>
          <input
            type="checkbox"
            bind:checked={showFavoritesOnly}
            on:change={filterRuns}
            disabled={loading || availableMarkedWorkflowsCount === 0 || showWatchedOnly}
            title={showWatchedOnly
              ? "To enable filters, uncheck the 'Watched Runs Only' checkbox"
              : 'Show only runs from workflows you have marked as favorite'}
          />
          Favorites Only
          {#if availableMarkedWorkflowsCount > 0}
            ({availableMarkedWorkflowsCount})
          {/if}
        </label>
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
      {#each visibleRuns as run (run.id)}
        <div class="run-item {getStatusClass(run)} {isHighlighted(run) ? 'highlighted' : ''}">
          {#if isHighlighted(run)}
            <div class="new-badge">🆕 Just Dispatched</div>
          {/if}
          {#if statusChanges.has(run.id)}
            <div class="status-change-message" transition:slide>
              <span class="codicon codicon-info"></span>
              <span>
                Status updated: {statusChanges.get(run.id)?.oldStatus} → {statusChanges.get(run.id)
                  ?.newStatus}
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
                      <span class="duration">{formatDuration(run.created_at, run.updated_at)}</span>
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
                          on:click|stopPropagation={() => openJobStepsModal(job, run.id)}
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
                        on:click|stopPropagation={() => viewJobLogs(job.id, job.name, run.id)}
                        title="View logs for this job"
                      >
                        <span class="codicon codicon-file-text"></span>
                        <span>View Logs</span>
                      </button>
                    </div>
                  </div>
                {/each}
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
              <span
                >Searched {totalRunsFetched} run{totalRunsFetched === 1 ? '' : 's'}, fetching
                more...</span
              >
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
          {:else if totalRunsFetched >= getMaxTotalRuns() && !showWatchedOnly}
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
{#if selectedJobForStepsModal}
  <JobStepsModal
    job={selectedJobForStepsModal}
    onClose={closeJobStepsModal}
    onViewLogs={selectedJobForStepsModal.jobId != null && selectedJobRunIdForSteps != null
      ? () => {
          const jobId = selectedJobForStepsModal?.jobId;
          const runId = selectedJobRunIdForSteps;
          if (jobId != null && runId != null) {
            viewJobLogs(jobId, selectedJobForStepsModal?.name || 'Job', runId);
          }
        }
      : undefined}
    onViewStepLogs={selectedJobForStepsModal.jobId != null && selectedJobRunIdForSteps != null
      ? (stepNumber, stepName) => {
          const jobId = selectedJobForStepsModal?.jobId;
          const runId = selectedJobRunIdForSteps;
          if (jobId != null && runId != null) {
            viewStepLogs(
              jobId,
              selectedJobForStepsModal?.name || 'Job',
              runId,
              stepNumber,
              stepName
            );
          }
        }
      : undefined}
    loadingStepLogs={getStepLogsLoadingSet(selectedJobForStepsModal.jobId)}
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
      } else if (node.jobId && jobGraphModalRunId) {
        // Fall back to viewing logs for jobs without steps data
        viewJobLogs(node.jobId, node.name, jobGraphModalRunId);
      }
    }}
  />
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
    min-width: 280px;
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
  }

  .refresh-settings-header {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-dropdown-border);
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

  .settings-option-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 8px 8px;
  }

  .settings-option-row .refresh-option {
    flex: 1 1 45%;
    text-align: center;
  }

  .settings-slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 8px;
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

  .summary-header h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-foreground);
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
</style>
