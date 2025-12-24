/**
 * Workflow Runs Panel - Main editor webview panel for displaying workflow runs
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dispatchWorkflowWithRunId } from '../api/workflow-dispatcher';
import {
  cancelWorkflowRun,
  checkJobLogsAvailable,
  downloadArtifact,
  downloadWorkflowArtifacts,
  getCurrentPullRequest,
  getGitHubSummaryFromLogs,
  getJobLogs,
  getJobSummaryFromLogs,
  getWorkflowById,
  getWorkflowJob,
  getWorkflowRun,
  getWorkflowRunArtifacts,
  getWorkflowRunJobs,
  getWorkflowRuns,
  rerunWorkflow,
} from '../api/workflow-monitor';
import { getConfig } from '../utils/config';
import { getNonce } from '../utils/get-nonce';
import { ensureGitContextValidOrWarn } from '../utils/git-context-validation';
import { branchExistsOnRemote, getCurrentBranch, getRepositoryInfo } from '../utils/git-operations';
import { fetchGitHubUserInfo } from '../utils/github-user';
import { getRepositoryConfig } from '../utils/repository-config';
import { TokenManager } from '../utils/token-manager';
import { getAllWorkflowDefinitionsIncludingNonDispatch } from '../utils/workflow-parser';

import AdmZip from 'adm-zip';
import type { WebviewMessage, WorkflowRun } from '../types/workflow-types';
import { buildLogURI } from '../utils/log-uri-scheme';
import { createErrorResponse, getResponseTypeForMessage } from '../utils/message-recovery';
import { Storage } from '../utils/storage';

const AUTO_REFRESH_SECONDS_OPTIONS: number[] = [0, 15, 30, 45, 60, 90, 120, 180];
// Default to 30 seconds - provides responsive monitoring without excessive API usage
// Adaptive refresh handles faster polling when in-progress/queued runs exist
const DEFAULT_AUTO_REFRESH_SECONDS = 30;

// Throttle rate limit storage persistence to once per minute (60000ms)
// This reduces storage write operations while still persisting reasonably fresh data
// Note: In-memory rate limit values are still updated on every API response for real-time UI
const RATE_LIMIT_STORAGE_THROTTLE_MS = 60000;
let lastRateLimitStorageUpdate = 0;

export class WorkflowRunsPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: WorkflowRunsPanel | undefined;

  public static readonly viewType = 'github-workflow-runner-panel';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _highlightedRunId: number | null = null;
  private _initialWorkflowFilter: string | null = null;
  private _initialActorFilter: string | null = null;
  private _initialShowBotRuns: boolean | null = null;
  private _currentWorkflowId: number | undefined = undefined;
  private _currentDateFilterFrom: string | null = null;
  private _currentDateFilterTo: string | null = null;
  private _currentWorkflowFilter: string | null = null; // Track current workflow filter from webview
  private _currentActorFilter: string | null = null; // Track current actor filter from webview
  private _currentShowBotRuns: boolean = false; // Track current bot runs filter from webview
  private _webviewReady: boolean = false; // Track if webview has sent webviewReady message

  private _webviewMessageListener?: vscode.Disposable;

  /**
   * Smart panel opening for workflow actions (dispatch, rerun, cancel, view last run)
   * Handles different scenarios based on panel state and workflow context
   */
  public static async createOrShowForAction(
    extensionUri: vscode.Uri,
    action: 'dispatch' | 'rerun' | 'cancel' | 'viewLastRun',
    options: {
      workflowName?: string;
      actorFilter?: string;
      showBotRuns?: boolean;
      runId?: number;
    }
  ): Promise<void> {
    // If panel is closed, open it with the specified filters
    if (!WorkflowRunsPanel.currentPanel) {
      WorkflowRunsPanel.createOrShow(extensionUri, options);
      return;
    }

    // Panel exists - decide whether to focus based on action type and visibility
    // Sidebar actions: "viewLastRun" (always focus), "dispatch" (prompt if not visible)
    // Note: "rerun" and "cancel" are not triggered from sidebar, no special handling needed
    const shouldAutoFocus = action === 'viewLastRun';
    const isPanelVisible = WorkflowRunsPanel.isVisible();

    if (shouldAutoFocus) {
      // Always focus for "View Last Run" action (user explicitly wants to VIEW)
      WorkflowRunsPanel.reveal();
    } else if (action === 'dispatch' && !isPanelVisible) {
      // Panel is open but not visible - ask user if they want to switch
      vscode.window
        .showInformationMessage(
          'Workflow dispatched successfully. Would you like to switch to the GitHub Workflow Runs panel?',
          'Switch to Panel',
          'Stay Here'
        )
        .then((choice) => {
          if (choice === 'Switch to Panel') {
            WorkflowRunsPanel.reveal();
          }
        });
    }
    // If panel is already visible or action is rerun/cancel, no need to reveal or ask

    // Panel is open - request current filter state from webview
    const filterState = await WorkflowRunsPanel._requestFilterState();
    const currentWorkflowFilter = filterState?.workflowFilter || null;
    const targetWorkflowName = options.workflowName;

    // If no target workflow specified, just refresh
    if (!targetWorkflowName) {
      vscode.window.showInformationMessage(
        `Loading ${action === 'dispatch' ? 'workflow' : 'run'} in the background...`
      );
      await WorkflowRunsPanel.backgroundRefresh();
      return;
    }

    // Convert target workflow name to full path format for comparison
    // (currentWorkflowFilter uses full path like ".github/workflows/file.yml")
    const targetWorkflowPath = targetWorkflowName.startsWith('.github/workflows/')
      ? targetWorkflowName
      : `.github/workflows/${targetWorkflowName}`;

    // Check if viewing the same workflow
    // If no target workflow is specified (viewing all workflows), treat as same workflow
    // If target workflow is specified, only treat as same if current filter matches exactly
    const isSameWorkflow =
      !targetWorkflowName || // No target workflow specified (viewing all workflows)
      currentWorkflowFilter === targetWorkflowPath; // Exact match

    if (isSameWorkflow) {
      // Same workflow - refresh in background
      await WorkflowRunsPanel.backgroundRefresh();

      // Check if filters might hide the run
      const mightBeHidden = await WorkflowRunsPanel._checkIfRunMightBeHidden(filterState, action);

      if (mightBeHidden) {
        // Show filter suggestion toast
        const choice = await vscode.window.showInformationMessage(
          `Workflow run may be hidden by current filters. Would you like to adjust filters?`,
          'Show All Runs',
          'Keep Current Filters'
        );

        if (choice === 'Show All Runs') {
          // Clear filters to show all runs
          WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
            type: 'clearFilters',
            success: true,
          });
        }
      } else {
        // Just show a simple message
        vscode.window.showInformationMessage(`Loading ${targetWorkflowName} in the background...`);
      }

      // When actions like dispatch / rerun / view last run explicitly request an
      // actor filter (e.g. `actorFilter: 'all'`), ensure the existing panel
      // respects that even when we're staying on the same workflow. This keeps
      // the behavior consistent with the "panel closed" path where initial
      // filters are applied via _initialActorFilter / _initialShowBotRuns.
      if (options.actorFilter) {
        WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
          type: 'setActorFilter',
          success: true,
          data: { actorFilter: options.actorFilter },
        });
      }

      if (options.showBotRuns !== undefined) {
        WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
          type: 'setShowBotRuns',
          success: true,
          data: { showBotRuns: options.showBotRuns },
        });
      }

      // Highlight the run if available
      if (options.runId) {
        WorkflowRunsPanel.highlightRun(options.runId);
      }
    } else {
      // Different workflow - show modal dialog
      const workflowLabel = targetWorkflowName || 'workflow';

      // Format current filter for display
      const currentFilterDisplay =
        currentWorkflowFilter === 'all' || !currentWorkflowFilter
          ? 'All Workflows'
          : currentWorkflowFilter;

      // Show modal to switch to the target workflow
      // Note: "Add to Watch List" option removed - users should use the checkbox in dispatch/rerun modal
      const choice = await vscode.window.showInformationMessage(
        `You are currently viewing "${currentFilterDisplay}". Would you like to switch to "${workflowLabel}"?`,
        { modal: true },
        `Switch to ${workflowLabel}`
        // Note: No explicit 'Cancel' button - modal: true adds one automatically
      );

      if (choice === `Switch to ${workflowLabel}`) {
        // Switch to the target workflow using postMessage to preserve webview state
        // (don't use _update() which reloads the entire HTML and destroys state)
        const workflowPath = targetWorkflowName.startsWith('.github/workflows/')
          ? targetWorkflowName
          : `.github/workflows/${targetWorkflowName}`;

        // Update workflow filter
        WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
          type: 'setWorkflowFilter',
          success: true,
          data: { workflowPath },
        });

        // Update actor filter if provided
        if (options.actorFilter) {
          WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
            type: 'setActorFilter',
            success: true,
            data: { actorFilter: options.actorFilter },
          });
        }

        // Update show bot runs filter if provided
        if (options.showBotRuns !== undefined) {
          WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
            type: 'setShowBotRuns',
            success: true,
            data: { showBotRuns: options.showBotRuns },
          });
        }

        // Trigger a refresh to load runs for the new workflow
        await WorkflowRunsPanel.backgroundRefresh();

        // Highlight the run if available
        if (options.runId) {
          WorkflowRunsPanel.highlightRun(options.runId);
        }
      }
      // If cancelled (undefined choice), do nothing
    }
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    options?: {
      workflowName?: string;
      actorFilter?: string;
      showBotRuns?: boolean;
    }
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it and update filters via postMessage
    // (preserves webview state - scroll position, expanded sections, etc.)
    if (WorkflowRunsPanel.currentPanel) {
      WorkflowRunsPanel.currentPanel._panel.reveal(column);

      // Update filters via postMessage to preserve webview state
      // (don't use _update() which reloads the entire HTML and destroys state)
      if (options?.workflowName) {
        const workflowPath = options.workflowName.startsWith('.github/workflows/')
          ? options.workflowName
          : `.github/workflows/${options.workflowName}`;
        WorkflowRunsPanel.currentPanel._panel.webview.postMessage({
          type: 'setWorkflowFilter',
          success: true,
          data: { workflowPath },
        });
      }
      if (options?.actorFilter) {
        WorkflowRunsPanel.currentPanel._panel.webview.postMessage({
          type: 'setActorFilter',
          success: true,
          data: { actorFilter: options.actorFilter },
        });
      }
      if (options?.showBotRuns !== undefined) {
        WorkflowRunsPanel.currentPanel._panel.webview.postMessage({
          type: 'setShowBotRuns',
          success: true,
          data: { showBotRuns: options.showBotRuns },
        });
      }

      // Trigger a background refresh if any filters were updated
      if (options?.workflowName || options?.actorFilter || options?.showBotRuns !== undefined) {
        WorkflowRunsPanel.backgroundRefresh();
      }
      return;
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      WorkflowRunsPanel.viewType,
      'GitHub Workflow Runs',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        // Allow loading bundled JS (dist) and static assets like Codicons (media)
        localResourceRoots: [extensionUri],
        // Preserve webview state when hidden (scroll position, expanded runs, filters, etc.)
        retainContextWhenHidden: true,
      }
    );

    WorkflowRunsPanel.currentPanel = new WorkflowRunsPanel(panel, extensionUri, options);
  }

  /**
   * Reveal/focus the panel without reloading
   */
  public static reveal() {
    if (WorkflowRunsPanel.currentPanel) {
      const column = vscode.window.activeTextEditor
        ? vscode.window.activeTextEditor.viewColumn
        : undefined;
      WorkflowRunsPanel.currentPanel._panel.reveal(column);
    }
  }

  public static kill() {
    WorkflowRunsPanel.currentPanel?.dispose();
    WorkflowRunsPanel.currentPanel = undefined;
  }

  public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    WorkflowRunsPanel.currentPanel = new WorkflowRunsPanel(panel, extensionUri);
  }

  /**
   * Highlight a newly dispatched run
   */
  public static highlightRun(runId: number) {
    if (WorkflowRunsPanel.currentPanel) {
      WorkflowRunsPanel.currentPanel._highlightedRunId = runId;
      WorkflowRunsPanel.currentPanel._panel.webview.postMessage({
        type: 'highlightRun',
        success: true,
        data: { runId },
      });
    }
  }

  /**
   * Notify the webview that a run has been added to the watch list.
   *
   * This is used by external callers (e.g. sidebar dispatch) that already
   * updated persistent storage and only need to sync the in-memory
   * watchedRuns set in the Workflow Runs panel.
   */
  public static notifyRunWatched(runId: number): void {
    if (!WorkflowRunsPanel.currentPanel) {
      return;
    }

    WorkflowRunsPanel.currentPanel._panel.webview.postMessage({
      type: 'toggleRunWatchResponse',
      success: true,
      data: { runId, isWatched: true },
    });
  }

  /**
   * Check if the panel is currently open
   */
  public static isOpen(): boolean {
    return WorkflowRunsPanel.currentPanel !== undefined;
  }

  /**
   * Check if the panel is currently visible
   */
  public static isVisible(): boolean {
    return (
      WorkflowRunsPanel.currentPanel !== undefined && WorkflowRunsPanel.currentPanel._panel.visible
    );
  }

  /**
   * Get the current workflow filter from the panel
   */
  public static getCurrentWorkflowFilter(): string | null {
    return WorkflowRunsPanel.currentPanel?._currentWorkflowFilter || null;
  }

  /**
   * Request current filter state from webview and wait for response
   */
  private static async _requestFilterState(): Promise<{
    workflowFilter: string;
    actorFilter: string;
    showBotRuns: boolean;
    dateFilterFrom: string;
    dateFilterTo: string;
    statusFilter: string;
  } | null> {
    if (!WorkflowRunsPanel.currentPanel) {
      return null;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 1000);

      const listener = WorkflowRunsPanel.currentPanel!._panel.webview.onDidReceiveMessage(
        (message: WebviewMessage) => {
          if (message.type === 'filterStateResponse') {
            clearTimeout(timeout);
            listener.dispose();
            resolve(message.data as any);
          }
        }
      );

      WorkflowRunsPanel.currentPanel!._panel.webview.postMessage({
        type: 'getFilterState',
        success: true,
      });
    });
  }

  /**
   * Refresh the panel in the background without changing filters
   */
  public static async backgroundRefresh() {
    if (WorkflowRunsPanel.currentPanel) {
      await WorkflowRunsPanel.currentPanel._sendWorkflowRuns();
    }
  }

  /**
   * Check if a newly dispatched/rerun workflow might be hidden by current filters
   * Returns true if the run might be hidden
   */
  private static async _checkIfRunMightBeHidden(
    filterState: {
      workflowFilter: string;
      actorFilter: string;
      showBotRuns: boolean;
      dateFilterFrom: string;
      dateFilterTo: string;
      statusFilter: string;
    } | null,
    action: 'dispatch' | 'rerun' | 'cancel' | 'viewLastRun'
  ): Promise<boolean> {
    if (!filterState) {
      return false;
    }

    // For newly dispatched/rerun workflows, check common filters that might hide them:

    // 1. Actor filter - if set to a specific user (not 'me' or 'all'), might hide the run
    if (
      filterState.actorFilter &&
      filterState.actorFilter !== 'me' &&
      filterState.actorFilter !== 'all'
    ) {
      return true;
    }

    // 2. Date range filter - if set and doesn't include today, will hide the run
    const today = new Date();
    if (filterState.dateFilterFrom) {
      const fromDate = new Date(filterState.dateFilterFrom);
      if (today < fromDate) {
        return true;
      }
    }
    if (filterState.dateFilterTo) {
      const toDate = new Date(filterState.dateFilterTo);
      if (today > toDate) {
        return true;
      }
    }

    // 3. Status filter - if set to completed/failed/cancelled, will hide new runs
    if (
      filterState.statusFilter &&
      filterState.statusFilter !== 'all' &&
      filterState.statusFilter !== 'queued' &&
      filterState.statusFilter !== 'in_progress'
    ) {
      return true;
    }

    return false;
  }

  /**
   * Add a run to the watch list
   */
  private async _addRunToWatchList(runId: number): Promise<void> {
    const repoConfig = await getRepositoryConfig();
    if (!repoConfig) {
      vscode.window.showErrorMessage('Repository not configured');
      return;
    }

    const error = await Storage.watchRun(runId, repoConfig.owner, repoConfig.name);

    if (error) {
      vscode.window.showErrorMessage(error);
    } else {
      // Notify webview to update watched runs
      this._panel.webview.postMessage({
        type: 'toggleRunWatchResponse',
        success: true,
        data: { runId, isWatched: true },
      });
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    options?: {
      workflowName?: string;
      actorFilter?: string;
      showBotRuns?: boolean;
    }
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._initialWorkflowFilter = options?.workflowName || null;
    this._initialActorFilter = options?.actorFilter || null;
    this._initialShowBotRuns = options?.showBotRuns ?? null;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Listen for visibility changes to stop/restore auto-refresh
    this._panel.onDidChangeViewState(
      async (e) => {
        if (!e.webviewPanel.visible) {
          // Panel is no longer visible, stop auto-refresh
          // Only send if webview is ready to receive messages
          if (this._webviewReady) {
            this._panel.webview.postMessage({
              type: 'stopAutoRefresh',
              success: true,
            });
          }
        } else {
          // Panel became visible again, restore persisted auto-refresh setting
          // Only send if webview has been initialized (received webviewReady)
          // On first open, initialSettings will handle auto-refresh setup
          if (this._webviewReady) {
            await this._sendRestoreAutoRefresh();
          }
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    WorkflowRunsPanel.currentPanel = undefined;

    // Reset webview ready state
    this._webviewReady = false;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private async _update() {
    const webview = this._panel.webview;

    this._panel.webview.html = this._getHtmlForWebview(webview);

    if (this._webviewMessageListener) {
      this._webviewMessageListener.dispose();
    }
    this._webviewMessageListener = webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this._handleMessage(message);
    });
  }

  /**
   * Handle messages from webview
   */
  private async _handleMessage(message: WebviewMessage) {
    try {
      switch (message.type) {
        case 'webviewReady':
          // Webview signaled it's ready to receive data
          this._webviewReady = true;
          await this._sendInitialSettings();
          await this._sendWorkflows();
          await this._sendWatchedRuns(); // Load watched runs from storage
          await this._sendWorkflowRuns();
          break;

        case 'getWorkflowRuns': {
          const { workflowId } = (message.data || {}) as {
            workflowId?: number;
          };
          await this._sendWorkflowRuns({ workflowId });
          // Also push workflows proactively so the webview can populate the dropdown
          await this._sendWorkflows();

          // Check if any initial filters are set BEFORE sending them
          const hasInitialFilters =
            this._initialWorkflowFilter ||
            this._initialActorFilter ||
            this._initialShowBotRuns !== null;

          // Send initial filters if set
          if (this._initialWorkflowFilter) {
            // Convert filename to full path format (.github/workflows/filename.yml)
            const workflowPath = this._initialWorkflowFilter.startsWith('.github/workflows/')
              ? this._initialWorkflowFilter
              : `.github/workflows/${this._initialWorkflowFilter}`;

            this._panel.webview.postMessage({
              type: 'setWorkflowFilter',
              success: true,
              data: { workflowPath }, // Use workflowPath for consistency
            });
            this._initialWorkflowFilter = null;
          }

          if (this._initialActorFilter) {
            this._panel.webview.postMessage({
              type: 'setActorFilter',
              success: true,
              data: { actorFilter: this._initialActorFilter },
            });
            this._initialActorFilter = null;
          }

          if (this._initialShowBotRuns !== null) {
            this._panel.webview.postMessage({
              type: 'setShowBotRuns',
              success: true,
              data: { showBotRuns: this._initialShowBotRuns },
            });
            this._initialShowBotRuns = null;
          }

          // If no initial filters were set, tell webview to finalize initial load immediately
          // This prevents the webview from waiting indefinitely for filter messages
          if (!hasInitialFilters) {
            console.log(
              '[WorkflowRunsPanel] No initial filters - sending finalizeInitialLoad message'
            );
            this._panel.webview.postMessage({
              type: 'finalizeInitialLoad',
              success: true,
            });
          }
          break;
        }

        case 'refreshWorkflowRuns': {
          await this._sendWorkflowRuns();
          // Keep workflows list in sync as well
          await this._sendWorkflows();
          break;
        }

        case 'updateWorkflowLoadLimit': {
          const { limit } = (message.data || {}) as { limit?: number };
          if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
            try {
              // Persist the panel-level page size without changing the backend
              // per-page configuration. The backend continues to use
              // config.monitoring.maxRuns (capped at 100) for GitHub API calls,
              // while the webview uses workflowLoadLimit purely as a UI page size
              // for client-side pagination.
              await Storage.updateWorkflowRunsPanelSettings({
                workflowLoadLimit: limit,
              });
            } catch (error) {
              console.error('Failed to persist workflow load limit:', error);
            }
          }
          break;
        }

        case 'updateWorkflowRunsTotalLimits': {
          const { nonDateMaxTotalRuns, dateFilterMaxTotalRuns } = (message.data || {}) as {
            nonDateMaxTotalRuns?: number;
            dateFilterMaxTotalRuns?: number;
          };

          const updates: Partial<{
            nonDateMaxTotalRuns: number;
            dateFilterMaxTotalRuns: number;
          }> = {};

          if (
            typeof nonDateMaxTotalRuns === 'number' &&
            Number.isFinite(nonDateMaxTotalRuns) &&
            nonDateMaxTotalRuns > 0
          ) {
            updates.nonDateMaxTotalRuns = nonDateMaxTotalRuns;
          }

          if (
            typeof dateFilterMaxTotalRuns === 'number' &&
            Number.isFinite(dateFilterMaxTotalRuns) &&
            dateFilterMaxTotalRuns > 0
          ) {
            updates.dateFilterMaxTotalRuns = dateFilterMaxTotalRuns;
          }

          if (Object.keys(updates).length > 0) {
            try {
              await Storage.updateWorkflowRunsPanelSettings(updates);
            } catch (error) {
              console.error('Failed to persist workflow runs total limits:', error);
            }
          }
          break;
        }

        case 'updateAutoRefresh': {
          const { autoRefreshSeconds } = (message.data || {}) as {
            autoRefreshSeconds?: number;
          };

          if (
            typeof autoRefreshSeconds !== 'number' ||
            !Number.isFinite(autoRefreshSeconds) ||
            autoRefreshSeconds < 0
          ) {
            break;
          }

          if (!AUTO_REFRESH_SECONDS_OPTIONS.includes(autoRefreshSeconds)) {
            console.warn(
              '[WorkflowRunsPanel] Ignoring unsupported auto-refresh value from webview:',
              autoRefreshSeconds
            );
            break;
          }

          try {
            await Storage.updateWorkflowRunsPanelSettings({
              autoRefreshSeconds,
            });
          } catch (error) {
            console.error('Failed to persist Workflow Runs auto-refresh value:', error);
          }
          break;
        }

        case 'updateNotificationSettings': {
          const { showWorkflowToastNotifications, showProgressIndicators } = (message.data ||
            {}) as {
            showWorkflowToastNotifications?: boolean;
            showProgressIndicators?: boolean;
          };

          // Build update object with only provided values
          const updates: {
            showWorkflowToastNotifications?: boolean;
            showProgressIndicators?: boolean;
          } = {};

          if (typeof showWorkflowToastNotifications === 'boolean') {
            updates.showWorkflowToastNotifications = showWorkflowToastNotifications;
          }
          if (typeof showProgressIndicators === 'boolean') {
            updates.showProgressIndicators = showProgressIndicators;
          }

          if (Object.keys(updates).length > 0) {
            try {
              await Storage.updateWorkflowRunsPanelSettings(updates);
            } catch (error) {
              console.error('Failed to persist notification settings:', error);
            }
          }
          break;
        }

        case 'updateAdaptiveRefreshSettings': {
          const { adaptiveRefreshEnabled, adaptiveFastRefreshSeconds } = (message.data || {}) as {
            adaptiveRefreshEnabled?: boolean;
            adaptiveFastRefreshSeconds?: number;
          };

          // Build update object with only provided values
          const updates: {
            adaptiveRefreshEnabled?: boolean;
            adaptiveFastRefreshSeconds?: number;
          } = {};

          if (typeof adaptiveRefreshEnabled === 'boolean') {
            updates.adaptiveRefreshEnabled = adaptiveRefreshEnabled;
          }
          if (
            typeof adaptiveFastRefreshSeconds === 'number' &&
            Number.isFinite(adaptiveFastRefreshSeconds) &&
            adaptiveFastRefreshSeconds >= 5 &&
            adaptiveFastRefreshSeconds <= 10
          ) {
            updates.adaptiveFastRefreshSeconds = adaptiveFastRefreshSeconds;
          }

          if (Object.keys(updates).length > 0) {
            try {
              await Storage.updateWorkflowRunsPanelSettings(updates);
            } catch (error) {
              console.error('Failed to persist adaptive refresh settings:', error);
            }
          }
          break;
        }

        case 'updateDateFilter': {
          const { from, to } = (message.data || {}) as {
            from?: string;
            to?: string;
          };
          const normalizedFrom = typeof from === 'string' && from.trim() ? from.trim() : null;
          const normalizedTo = typeof to === 'string' && to.trim() ? to.trim() : null;
          this._currentDateFilterFrom = normalizedFrom;
          this._currentDateFilterTo = normalizedTo;
          try {
            await Storage.updateWorkflowRunsPanelSettings({
              dateFilterFrom: normalizedFrom,
              dateFilterTo: normalizedTo,
            });
          } catch (error) {
            console.error('Failed to persist Workflow Runs date filter:', error);
          }
          await this._sendWorkflowRuns();
          break;
        }

        case 'getUserInfo':
          await this._sendUserInfo();
          break;

        case 'openWorkflowRun':
          const runUrl = message.data as string;
          if (runUrl) {
            vscode.env.openExternal(vscode.Uri.parse(runUrl));
          }
          break;

        case 'cancelWorkflowRun':
          await this._cancelWorkflowRun(message.data as { runId: number });
          break;

        case 'getWorkflowRunJobs':
          await this._sendWorkflowRunJobs(message.data as { runId: number });
          break;

        case 'getJobDependencies':
          await this._sendJobDependencies(message.data as { runId: number; workflowPath: string });
          break;

        case 'viewWorkflowRunLogs':
          await this._viewWorkflowRunLogs(message.data as { runId: number });
          break;

        case 'downloadWorkflowArtifacts':
          await this._downloadWorkflowArtifacts(message.data as { runId: number });
          break;

        case 'rerunWorkflow':
          await this._rerunWorkflow(message.data as { runId: number; failedJobsOnly?: boolean });
          break;

        case 'promptRerunWorkflow': {
          const { runId, workflowName, branch } = (message.data || {}) as {
            runId: number;
            workflowName?: string;
            branch?: string;
          };
          await this._promptRerunWorkflowWithInputCheck(runId, workflowName, branch);
          break;
        }

        case 'openSidebarWithWorkflow':
          // Focus the sidebar view without forcing an instructional toast
          await vscode.commands.executeCommand(
            'workbench.view.extension.github-workflow-runner-sidebar-view'
          );
          break;

        case 'loadMoreRuns':
          await this._loadMoreRuns(message.data as { page: number });
          break;

        case 'progressiveFetchRuns':
          await this._progressiveFetchRuns(
            message.data as { startPage: number; maxPages: number; generation?: number }
          );
          break;

        case 'viewJobLogs':
          await this._viewJobLogs(
            message.data as { jobId: number; jobName: string; runId: number }
          );
          break;

        // DISABLED: Interactive log viewer - temporarily disabled for separate PR
        // case 'viewJobLogsInteractive':
        //   await this._viewJobLogsInteractive(
        //     message.data as { jobId: number; jobName: string; runId: number }
        //   );
        //   break;

        // DISABLED: Log comparison - temporarily disabled in v1.2.0
        // case 'compareJobLogs':
        //   await this._compareJobLogs(
        //     message.data as {
        //       sourceJobId: number;
        //       sourceJobName: string;
        //       sourceRunId: number;
        //       targetJobId: number;
        //       targetJobName: string;
        //       targetRunId: number;
        //     }
        //   );
        //   break;

        // DISABLED: Step log comparison - temporarily disabled in v1.2.0
        // case 'compareStepLogs':
        //   await this._compareStepLogs(
        //     message.data as {
        //       sourceJobId: number;
        //       sourceJobName: string;
        //       sourceRunId: number;
        //       sourceStepNumber: number;
        //       sourceStepName: string;
        //       targetJobId: number;
        //       targetJobName: string;
        //       targetRunId: number;
        //       targetStepNumber: number;
        //       targetStepName: string;
        //     }
        //   );
        //   break;

        case 'checkJobLogsAvailability':
          await this._checkJobLogsAvailability(
            message.data as { jobId: number; jobName: string; runId: number }
          );
          break;

        case 'getJobDetails':
          await this._getJobDetails(message.data as { jobId: number; runId: number });
          break;

        // DISABLED: Step log viewing - temporarily disabled for separate PR
        // case 'viewStepLogs':
        //   await this._viewStepLogs(
        //     message.data as {
        //       jobId: number;
        //       jobName: string;
        //       runId: number;
        //       stepNumber: number;
        //       stepName: string;
        //     }
        //   );
        //   break;

        case 'getWorkflowRunArtifacts':
          await this._getWorkflowRunArtifacts(message.data as { runId: number });
          break;

        case 'downloadArtifact':
          await this._downloadArtifact(
            message.data as { artifactId: number; artifactName: string }
          );
          break;

        case 'getCurrentPR': {
          try {
            const repoInfo = await getRepositoryInfo();
            if (!repoInfo) {
              this._panel.webview.postMessage({
                type: 'getCurrentPRResponse',
                success: true,
                data: { number: null },
              });
              break;
            }
            const branch = await getCurrentBranch();
            if (!branch) {
              this._panel.webview.postMessage({
                type: 'getCurrentPRResponse',
                success: true,
                data: { number: null },
              });
              break;
            }
            const prNumber = await getCurrentPullRequest(repoInfo.owner, repoInfo.name, branch);
            this._panel.webview.postMessage({
              type: 'getCurrentPRResponse',
              success: true,
              data: { number: prNumber },
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'getCurrentPRResponse',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to get current PR',
            });
          }
          break;
        }

        case 'getCurrentBranch': {
          try {
            const branch = await getCurrentBranch();
            this._panel.webview.postMessage({
              type: 'getCurrentBranch',
              success: true,
              data: branch || null,
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'getCurrentBranch',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to get current branch',
            });
          }
          break;
        }

        case 'getDefaultBranch': {
          try {
            const config = getConfig();
            const defaultBranch = config.defaultBranch;
            this._panel.webview.postMessage({
              type: 'getDefaultBranch',
              success: true,
              data: defaultBranch,
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'getDefaultBranch',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to get default branch',
            });
          }
          break;
        }

        case 'checkBranchOnRemote': {
          try {
            const branch = await getCurrentBranch();
            if (!branch) {
              this._panel.webview.postMessage({
                type: 'checkBranchOnRemote',
                success: true,
                data: { exists: false },
              });
              break;
            }
            const exists = await branchExistsOnRemote(branch);
            this._panel.webview.postMessage({
              type: 'checkBranchOnRemote',
              success: true,
              data: { exists },
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'checkBranchOnRemote',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to check branch on remote',
            });
          }
          break;
        }

        case 'openWorkflowFile': {
          const { filePath } = (message.data || {}) as { filePath: string };
          if (filePath) {
            await this._openWorkflowFile(filePath);
          }
          break;
        }

        case 'getMarkedWorkflows': {
          const markedWorkflows = await Storage.getMarkedWorkflows();
          this._panel.webview.postMessage({
            type: 'getMarkedWorkflowsResponse',
            success: true,
            data: markedWorkflows,
          });
          break;
        }

        case 'toggleWorkflowMarked': {
          const { workflowPath } = (message.data || {}) as {
            workflowPath: string;
          };
          if (workflowPath) {
            const isMarked = await Storage.toggleWorkflowMarked(workflowPath);
            this._panel.webview.postMessage({
              type: 'toggleWorkflowMarkedResponse',
              success: true,
              data: { workflowPath, isMarked },
            });
          }
          break;
        }

        case 'getWatchedRuns': {
          const repoConfig = await getRepositoryConfig();
          if (!repoConfig) {
            console.log('[WorkflowRunsPanel] getWatchedRuns: Repository not configured');
            this._panel.webview.postMessage({
              type: 'getWatchedRunsResponse',
              success: false,
              error: 'Repository not configured',
            });
            break;
          }
          console.log(
            `[WorkflowRunsPanel] getWatchedRuns: Fetching for ${repoConfig.owner}/${repoConfig.name}`
          );
          const watchedRuns = await Storage.getWatchedRunsForRepo(
            repoConfig.owner,
            repoConfig.name
          );
          console.log(
            `[WorkflowRunsPanel] getWatchedRuns: Sending ${watchedRuns.length} watched runs to webview`
          );
          this._panel.webview.postMessage({
            type: 'getWatchedRunsResponse',
            success: true,
            data: watchedRuns,
          });
          break;
        }

        case 'toggleRunWatch': {
          const { runId, isWatched } = (message.data || {}) as {
            runId: number;
            isWatched: boolean;
          };
          if (!runId) {
            break;
          }

          const repoConfig = await getRepositoryConfig();
          if (!repoConfig) {
            this._panel.webview.postMessage({
              type: 'toggleRunWatchResponse',
              success: false,
              error: 'Repository not configured',
            });
            break;
          }

          const result = await Storage.toggleRunWatch(runId, repoConfig.owner, repoConfig.name);

          this._panel.webview.postMessage({
            type: 'toggleRunWatchResponse',
            success: !result.error,
            data: { runId, isWatched: result.isWatched },
            error: result.error,
          });
          break;
        }

        case 'unwatchAllRuns': {
          try {
            const repoConfig = await getRepositoryConfig();
            if (!repoConfig) {
              this._panel.webview.postMessage({
                type: 'unwatchAllRunsResponse',
                success: false,
                error: 'Repository not configured',
              });
              break;
            }

            const existing = await Storage.getWatchedRunsForRepo(repoConfig.owner, repoConfig.name);
            const total = existing.length;

            if (total === 0) {
              this._panel.webview.postMessage({
                type: 'unwatchAllRunsResponse',
                success: true,
                data: { clearedCount: 0 },
              });
              break;
            }

            const confirm = await vscode.window.showWarningMessage(
              `Stop watching all ${total} workflow run${total === 1 ? '' : 's'}?`,
              { modal: true },
              'Unwatch All'
            );
            if (confirm !== 'Unwatch All') {
              this._panel.webview.postMessage({
                type: 'unwatchAllRunsResponse',
                success: false,
                error: 'Unwatch all runs cancelled.',
              });
              break;
            }

            await Storage.clearWatchedRunsForRepo(repoConfig.owner, repoConfig.name);

            this._panel.webview.postMessage({
              type: 'unwatchAllRunsResponse',
              success: true,
              data: { clearedCount: total },
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'unwatchAllRunsResponse',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to unwatch all runs',
            });
          }
          break;
        }

        case 'backgroundRefreshWatchedRuns': {
          await this._backgroundRefreshWatchedRuns(message.data as { watchedRunIds: number[] });
          break;
        }

        case 'backgroundRefreshAllRuns': {
          await this._backgroundRefreshAllRuns();
          break;
        }

        case 'filterStateResponse': {
          // Store the current filter state from webview
          const filterState = (message.data || {}) as {
            workflowFilter: string | 'all';
            actorFilter: string;
            showBotRuns: boolean;
          };
          this._currentWorkflowFilter =
            filterState.workflowFilter === 'all' ? null : filterState.workflowFilter;
          this._currentActorFilter = filterState.actorFilter;
          this._currentShowBotRuns = filterState.showBotRuns;
          console.log('[WorkflowRunsPanel] Updated filter state:', {
            workflowFilter: this._currentWorkflowFilter,
            actorFilter: this._currentActorFilter,
            showBotRuns: this._currentShowBotRuns,
          });
          break;
        }

        case 'getRunParameters': {
          const { runId } = (message.data || {}) as { runId?: number };
          if (!runId) {
            this._panel.webview.postMessage({
              type: 'getRunParametersResponse',
              success: false,
              error: 'Missing runId for parameter lookup.',
            });
            break;
          }

          try {
            const recovered = await this._recoverInputsForRun(runId);
            if (!recovered) {
              this._panel.webview.postMessage({
                type: 'getRunParametersResponse',
                success: true,
                data: { found: false, runId },
              });
              return;
            }

            this._panel.webview.postMessage({
              type: 'getRunParametersResponse',
              success: true,
              data: {
                found: true,
                runId,
                workflowFilename: recovered.workflowFilename,
                branch: recovered.branch,
                inputs: recovered.inputs,
              },
            });
          } catch (error) {
            this._panel.webview.postMessage({
              type: 'getRunParametersResponse',
              success: false,
              error: error instanceof Error ? error.message : 'Failed to recover run parameters',
              data: { runId },
            });
          }
          break;
        }

        case 'getWorkflows': {
          console.log('[WorkflowRunsPanel] Received getWorkflows message');
          await this._sendWorkflows();
          break;
        }

        case 'getWorkflowId': {
          const { workflowFilename } = (message.data || {}) as {
            workflowFilename: string;
          };
          if (workflowFilename) {
            await this._sendWorkflowId(workflowFilename);
          }
          break;
        }

        // Disabled: GitHub API doesn't provide job summary content via REST API.
        // The button now opens the browser directly instead of using this modal flow.
        case 'getGitHubSummary': {
          await this._getGitHubSummary(message.data as { runId: number });
          break;
        }

        // Get summary for a single job
        case 'getJobSummary': {
          await this._getJobSummary(message.data as { jobId: number; jobName: string });
          break;
        }

        case 'openGitHubSummaryInTab': {
          await this._openGitHubSummaryInTab(
            message.data as {
              runId: number;
              runName: string;
              markdownContent: string;
              htmlContent: string;
              htmlUrl?: string;
            }
          );
          break;
        }

        case 'openInBrowser': {
          const { url } = (message.data || {}) as { url: string };
          if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }

        // Handle external URL clicks from markdown content
        case 'openExternalUrl': {
          const { url } = (message.data || {}) as { url: string };
          if (url) {
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }

        // Handle request cancellation from webview
        // This is called when filters change rapidly to invalidate stale requests
        case 'cancelPendingRequests': {
          const { workflowGeneration, filterGeneration } = (message.data || {}) as {
            workflowGeneration?: number;
            filterGeneration?: number;
          };
          console.log('[WorkflowRunsPanel] Cancelling pending requests:', {
            workflowGeneration,
            filterGeneration,
          });
          // Currently we just log this - actual request cancellation would require
          // AbortController for fetch requests, which is a larger change.
          // The webview uses generation counters to ignore stale responses.
          break;
        }

        // Handle rate limit settings update from webview
        case 'updateRateLimitSettings': {
          const { rateLimitProtectionEnabled, rateLimitThreshold } = (message.data || {}) as {
            rateLimitProtectionEnabled?: boolean;
            rateLimitThreshold?: number;
          };
          console.log('[WorkflowRunsPanel] Rate limit settings updated:', {
            rateLimitProtectionEnabled,
            rateLimitThreshold,
          });
          // Persist the settings to storage
          try {
            const panelSettings = await Storage.getWorkflowRunsPanelSettings();
            await Storage.updateWorkflowRunsPanelSettings({
              ...panelSettings,
              rateLimitProtectionEnabled,
              rateLimitThreshold,
            });
          } catch (error) {
            console.error('[WorkflowRunsPanel] Failed to persist rate limit settings:', error);
          }
          break;
        }
      }
    } catch (error) {
      // Log the error and send an error response to the webview
      // This prevents silent failures that could leave the UI in a stuck state
      console.error(
        '[WorkflowRunsPanel] Error handling message:',
        message.type,
        error instanceof Error ? error.message : error
      );

      // For message types that expect a response, send an error response
      // This helps the webview recover from stuck loading states
      const responseType = getResponseTypeForMessage(message.type);
      if (responseType) {
        this._panel.webview.postMessage(createErrorResponse(responseType, error));
      }
    }
  }

  /**
   * Send user info to webview
   */
  private async _sendUserInfo() {
    try {
      const userInfo = await fetchGitHubUserInfo();
      if (userInfo) {
        this._panel.webview.postMessage({
          type: 'getUserInfo',
          success: true,
          data: userInfo,
        });
      } else {
        this._panel.webview.postMessage({
          type: 'getUserInfo',
          success: false,
          error: 'Not authenticated',
        });
      }
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getUserInfo',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user info',
      });
    }
  }

  /**
   * Send initial persisted settings for the Workflow Runs panel
   */
  private async _sendInitialSettings() {
    try {
      const panelSettings = await Storage.getWorkflowRunsPanelSettings();

      const workflowLoadLimit =
        typeof panelSettings.workflowLoadLimit === 'number' &&
        Number.isFinite(panelSettings.workflowLoadLimit) &&
        panelSettings.workflowLoadLimit > 0
          ? panelSettings.workflowLoadLimit
          : undefined;

      const dateFilterFrom =
        typeof panelSettings.dateFilterFrom === 'string' && panelSettings.dateFilterFrom.trim()
          ? panelSettings.dateFilterFrom.trim()
          : null;
      const dateFilterTo =
        typeof panelSettings.dateFilterTo === 'string' && panelSettings.dateFilterTo.trim()
          ? panelSettings.dateFilterTo.trim()
          : null;

      const persistedAutoRefreshSeconds =
        typeof panelSettings.autoRefreshSeconds === 'number' &&
        Number.isFinite(panelSettings.autoRefreshSeconds) &&
        panelSettings.autoRefreshSeconds >= 0
          ? panelSettings.autoRefreshSeconds
          : undefined;

      const nonDateMaxTotalRuns =
        typeof panelSettings.nonDateMaxTotalRuns === 'number' &&
        Number.isFinite(panelSettings.nonDateMaxTotalRuns) &&
        panelSettings.nonDateMaxTotalRuns > 0
          ? panelSettings.nonDateMaxTotalRuns
          : 2000;

      const dateFilterMaxTotalRuns =
        typeof panelSettings.dateFilterMaxTotalRuns === 'number' &&
        Number.isFinite(panelSettings.dateFilterMaxTotalRuns) &&
        panelSettings.dateFilterMaxTotalRuns > 0
          ? panelSettings.dateFilterMaxTotalRuns
          : 2000;

      const autoRefreshSeconds =
        typeof persistedAutoRefreshSeconds === 'number' &&
        AUTO_REFRESH_SECONDS_OPTIONS.includes(persistedAutoRefreshSeconds)
          ? persistedAutoRefreshSeconds
          : DEFAULT_AUTO_REFRESH_SECONDS;

      // Extract notification settings with defaults (true if not set)
      const showWorkflowToastNotifications =
        typeof panelSettings.showWorkflowToastNotifications === 'boolean'
          ? panelSettings.showWorkflowToastNotifications
          : true;
      const showProgressIndicators =
        typeof panelSettings.showProgressIndicators === 'boolean'
          ? panelSettings.showProgressIndicators
          : true;

      // Extract adaptive refresh settings with defaults
      const adaptiveRefreshEnabled =
        typeof panelSettings.adaptiveRefreshEnabled === 'boolean'
          ? panelSettings.adaptiveRefreshEnabled
          : true; // Enabled by default
      const adaptiveFastRefreshSeconds =
        typeof panelSettings.adaptiveFastRefreshSeconds === 'number' &&
        Number.isFinite(panelSettings.adaptiveFastRefreshSeconds) &&
        panelSettings.adaptiveFastRefreshSeconds >= 5 &&
        panelSettings.adaptiveFastRefreshSeconds <= 10
          ? panelSettings.adaptiveFastRefreshSeconds
          : 10; // Default to 10 seconds

      // Extract rate limit protection settings with defaults
      const rateLimitProtectionEnabled =
        typeof panelSettings.rateLimitProtectionEnabled === 'boolean'
          ? panelSettings.rateLimitProtectionEnabled
          : true; // Enabled by default
      const rateLimitThreshold =
        typeof panelSettings.rateLimitThreshold === 'number' &&
        Number.isFinite(panelSettings.rateLimitThreshold) &&
        panelSettings.rateLimitThreshold >= 50 &&
        panelSettings.rateLimitThreshold <= 90
          ? panelSettings.rateLimitThreshold
          : 70; // Default to 70%

      // NOTE: We intentionally do NOT load persisted rate limit info here.
      // Rate limit display should show actual values from real API responses only,
      // not stale cached values from previous sessions. The display will show
      // "Unknown" until the first API response is received with rate limit headers.

      // CRITICAL FIX: Do NOT apply persisted date filters to the initial load.
      // Date filters from previous sessions can prevent any runs from being
      // fetched if the date range has no matching runs. Instead, always start
      // with no date filter active, and let the user explicitly apply date
      // filters if needed. The persisted values are still sent to the webview
      // so they appear in the UI, but they won't affect the initial API fetch.
      this._currentDateFilterFrom = null;
      this._currentDateFilterTo = null;

      console.log(
        '[WorkflowRunsPanel] _sendInitialSettings: Cleared date filters for initial load.',
        'Persisted values (sent to webview but not applied):',
        {
          dateFilterFrom,
          dateFilterTo,
          nonDateMaxTotalRuns,
          dateFilterMaxTotalRuns,
          autoRefreshSeconds,
          showWorkflowToastNotifications,
          showProgressIndicators,
          adaptiveRefreshEnabled,
          adaptiveFastRefreshSeconds,
          rateLimitProtectionEnabled,
          rateLimitThreshold,
        }
      );

      this._panel.webview.postMessage({
        type: 'initialSettings',
        success: true,
        data: {
          workflowLoadLimit,
          autoRefreshSeconds,
          // Send null instead of persisted values to ensure the webview
          // also starts with no active date filter
          dateFilterFrom: null,
          dateFilterTo: null,
          nonDateMaxTotalRuns,
          dateFilterMaxTotalRuns,
          showWorkflowToastNotifications,
          showProgressIndicators,
          adaptiveRefreshEnabled,
          adaptiveFastRefreshSeconds,
          rateLimitProtectionEnabled,
          rateLimitThreshold,
          // NOTE: rateLimitInfo is intentionally NOT included here.
          // Rate limit should only show real values from actual API responses,
          // not cached data from previous sessions. Display starts as "Unknown".
        },
      });
    } catch (error) {
      console.error('Failed to send Workflow Runs panel settings:', error);
      this._panel.webview.postMessage({
        type: 'initialSettings',
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to load Workflow Runs panel settings',
      });
    }
  }

  /**
   * Send restore auto-refresh message when panel becomes visible again.
   * This retrieves the persisted auto-refresh setting and tells the webview
   * to resume auto-refresh with the correct interval.
   */
  private async _sendRestoreAutoRefresh() {
    try {
      const panelSettings = await Storage.getWorkflowRunsPanelSettings();

      const persistedAutoRefreshSeconds =
        typeof panelSettings.autoRefreshSeconds === 'number' &&
        Number.isFinite(panelSettings.autoRefreshSeconds) &&
        panelSettings.autoRefreshSeconds >= 0
          ? panelSettings.autoRefreshSeconds
          : undefined;

      const autoRefreshSeconds =
        typeof persistedAutoRefreshSeconds === 'number' &&
        AUTO_REFRESH_SECONDS_OPTIONS.includes(persistedAutoRefreshSeconds)
          ? persistedAutoRefreshSeconds
          : DEFAULT_AUTO_REFRESH_SECONDS;

      // Extract adaptive refresh settings with defaults
      const adaptiveRefreshEnabled =
        typeof panelSettings.adaptiveRefreshEnabled === 'boolean'
          ? panelSettings.adaptiveRefreshEnabled
          : true; // Enabled by default
      const adaptiveFastRefreshSeconds =
        typeof panelSettings.adaptiveFastRefreshSeconds === 'number' &&
        Number.isFinite(panelSettings.adaptiveFastRefreshSeconds) &&
        panelSettings.adaptiveFastRefreshSeconds >= 5 &&
        panelSettings.adaptiveFastRefreshSeconds <= 10
          ? panelSettings.adaptiveFastRefreshSeconds
          : 10; // Default to 10 seconds

      console.log(
        '[WorkflowRunsPanel] _sendRestoreAutoRefresh: Restoring auto-refresh to',
        autoRefreshSeconds,
        'seconds, adaptive:',
        adaptiveRefreshEnabled,
        'fast interval:',
        adaptiveFastRefreshSeconds
      );

      this._panel.webview.postMessage({
        type: 'restoreAutoRefresh',
        success: true,
        data: {
          autoRefreshSeconds,
          adaptiveRefreshEnabled,
          adaptiveFastRefreshSeconds,
        },
      });
    } catch (error) {
      console.error('Failed to restore auto-refresh setting:', error);
      // If we can't load the persisted setting, restore with default
      this._panel.webview.postMessage({
        type: 'restoreAutoRefresh',
        success: true,
        data: {
          autoRefreshSeconds: DEFAULT_AUTO_REFRESH_SECONDS,
          adaptiveRefreshEnabled: true,
          adaptiveFastRefreshSeconds: 10,
        },
      });
    }
  }

  /**
   * Send watched runs from storage to webview
   */
  private async _sendWatchedRuns() {
    try {
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        console.log('[WorkflowRunsPanel] _sendWatchedRuns: No repository config, skipping');
        return;
      }

      const watchedRunIds = await Storage.getWatchedRunsForRepo(repoConfig.owner, repoConfig.name);

      console.log(
        '[WorkflowRunsPanel] _sendWatchedRuns: Loaded',
        watchedRunIds.length,
        'watched runs from storage'
      );

      this._panel.webview.postMessage({
        type: 'loadWatchedRuns',
        success: true,
        data: { watchedRunIds },
      });
    } catch (error) {
      console.error('[WorkflowRunsPanel] _sendWatchedRuns: Error:', error);
      this._panel.webview.postMessage({
        type: 'loadWatchedRuns',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load watched runs',
      });
    }
  }

  /**
   * Send workflows to webview
   */
  private async _sendWorkflows() {
    try {
      console.log('[WorkflowRunsPanel] _sendWorkflows: Fetching workflows...');
      const config = getConfig();
      const workflows = await getAllWorkflowDefinitionsIncludingNonDispatch(
        config.workflows.excludePatterns
      );

      console.log(
        '[WorkflowRunsPanel] _sendWorkflows: Found',
        workflows.length,
        'workflows:',
        workflows.map((w) => ({ name: w.name, filepath: w.filepath }))
      );

      this._panel.webview.postMessage({
        type: 'getWorkflows',
        success: true,
        data: workflows,
      });
      console.log('[WorkflowRunsPanel] _sendWorkflows: Sent workflows to webview');
    } catch (error) {
      console.error('[WorkflowRunsPanel] _sendWorkflows: Error:', error);
      this._panel.webview.postMessage({
        type: 'getWorkflows',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get workflows',
      });
    }
  }

  /**
   * Cancel a workflow run
   */
  private async _cancelWorkflowRun(data: { runId: number }) {
    const runId = data.runId;

    console.log('[CancelWorkflow] Backend received cancel request:', { runId, data });

    // Validate runId is present and valid
    if (!runId || typeof runId !== 'number') {
      console.error('[CancelWorkflow] Invalid runId received:', { runId, type: typeof runId });
      this._panel.webview.postMessage({
        type: 'cancelWorkflowRunResponse',
        success: false,
        data: { runId },
        error: 'Invalid run ID provided',
      });
      return;
    }

    try {
      // Validate Git context before any GitHub API operation
      const isValidContext = await ensureGitContextValidOrWarn('cancelWorkflowRun');
      if (!isValidContext) {
        console.warn('[CancelWorkflow] Git context validation failed for runId:', runId);
        this._panel.webview.postMessage({
          type: 'gitContextMismatch',
          success: false,
          error: 'Repository or branch has changed. Please reload the extension data.',
        });
        return;
      }

      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        console.error('[CancelWorkflow] Could not get repository info for runId:', runId);
        this._panel.webview.postMessage({
          type: 'cancelWorkflowRunResponse',
          success: false,
          data: { runId },
          error: 'Could not get repository information',
        });
        return;
      }

      console.log('[CancelWorkflow] Calling GitHub API to cancel run:', {
        owner: repoInfo.owner,
        repo: repoInfo.name,
        runId,
      });

      const result = await cancelWorkflowRun(repoInfo.owner, repoInfo.name, runId);

      console.log('[CancelWorkflow] GitHub API response:', { runId, result });

      if (result.success) {
        console.log('[CancelWorkflow] Successfully cancelled run:', runId);
        this._panel.webview.postMessage({
          type: 'cancelWorkflowRunResponse',
          success: true,
          data: { runId, status: 'cancelled' },
        });
        vscode.window.showInformationMessage(`✅ Workflow run #${runId} cancelled successfully`);
        // Don't do a full reload - the webview will update the run status
        // based on the cancelWorkflowRunResponse message above
      } else {
        console.error('[CancelWorkflow] Failed to cancel run:', { runId, error: result.error });
        this._panel.webview.postMessage({
          type: 'cancelWorkflowRunResponse',
          success: false,
          data: { runId },
          error: result.error || 'Failed to cancel workflow run',
        });
        vscode.window.showErrorMessage(
          `❌ Failed to cancel workflow run #${runId}: ${result.error}`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[CancelWorkflow] Exception while cancelling run:', {
        runId,
        error: errorMessage,
      });
      this._panel.webview.postMessage({
        type: 'cancelWorkflowRunResponse',
        success: false,
        data: { runId },
        error: errorMessage,
      });
      vscode.window.showErrorMessage(`❌ Error cancelling workflow run #${runId}: ${errorMessage}`);
    }
  }

  /**
   * Get and send workflow ID by filename
   */
  private async _sendWorkflowId(workflowFilename: string) {
    try {
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        this._panel.webview.postMessage({
          type: 'getWorkflowIdResponse',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      console.log(
        '[WorkflowRunsPanel] _sendWorkflowId: Getting workflow ID for',
        workflowFilename,
        'in',
        `${repoConfig.owner}/${repoConfig.name}`
      );

      const { getWorkflowId } = await import('../api/workflow-dispatcher');
      const workflowId = await getWorkflowId(repoConfig.owner, repoConfig.name, workflowFilename);

      if (workflowId) {
        this._panel.webview.postMessage({
          type: 'getWorkflowIdResponse',
          success: true,
          data: { workflowFilename, workflowId },
        });
      } else {
        this._panel.webview.postMessage({
          type: 'getWorkflowIdResponse',
          success: false,
          error: 'Failed to get workflow ID',
        });
      }
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getWorkflowIdResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Send workflow runs to webview.
   * When a date filter is active, this will fetch all matching runs from that
   * date onwards (up to an internal safety cap), effectively overriding the
   * normal per-page load limit.
   */
  private async _sendWorkflowRuns(options?: { workflowId?: number }) {
    try {
      const authenticated = await TokenManager.getGithubToken();
      if (!authenticated) {
        this._panel.webview.postMessage({
          type: 'getWorkflowRuns',
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      // Use getRepositoryConfig() which supports manual overrides
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        this._panel.webview.postMessage({
          type: 'getWorkflowRuns',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      // Log current workflow context and any incoming override.
      console.log(
        '[WorkflowRunsPanel] _sendWorkflowRuns: entry - stored workflowId:',
        this._currentWorkflowId,
        'options:',
        options
      );

      const config = getConfig();

      // Update the stored workflow ID based on the options:
      // - If options.workflowId is a valid number, store it (specific workflow)
      // - If options is provided but workflowId is undefined/null, clear it (all workflows)
      // - If options is not provided, keep the current stored value (refresh/background)
      if (options) {
        if (typeof options.workflowId === 'number' && Number.isFinite(options.workflowId)) {
          console.log(
            '[WorkflowRunsPanel] _sendWorkflowRuns: updating _currentWorkflowId from',
            this._currentWorkflowId,
            'to',
            options.workflowId
          );
          this._currentWorkflowId = options.workflowId;
        } else if (options.workflowId === undefined || options.workflowId === null) {
          // Explicitly clearing the workflow filter - request for "all workflows"
          console.log(
            '[WorkflowRunsPanel] _sendWorkflowRuns: clearing _currentWorkflowId (was:',
            this._currentWorkflowId,
            ')'
          );
          this._currentWorkflowId = undefined;
        }
      }

      const workflowId = this._currentWorkflowId;
      console.log('[WorkflowRunsPanel] _sendWorkflowRuns: using workflowId for fetch:', workflowId);

      const pageSize = Math.min(config.monitoring.maxRuns, 100);

      const rawFrom = this._currentDateFilterFrom;
      const rawTo = this._currentDateFilterTo;

      let fromDate: Date | null = null;
      let toDate: Date | null = null;

      // CRITICAL FIX: The datetime-local input returns a string in local timezone
      // (e.g., "2025-11-20T09:58"), but new Date() interprets it as UTC if there's
      // no timezone offset. This causes a mismatch between the user's intended time
      // and the actual filter applied. To fix this, we need to parse the datetime
      // string as local time, not UTC.
      //
      // The correct approach is to use the datetime string as-is and let the Date
      // constructor interpret it in the local timezone by NOT appending 'Z'.
      // However, ISO 8601 strings without a timezone are ambiguous, so we need to
      // be explicit about the timezone.
      //
      // Since the webview runs in the same timezone as the extension host (both in
      // VS Code), we can safely parse the datetime-local value as local time.

      if (rawFrom) {
        // Parse as local time: datetime-local format is "YYYY-MM-DDTHH:mm"
        // We need to convert this to a Date object in local timezone.
        // The trick is to use the Date constructor with individual components.
        const parsed = this._parseDateTimeLocal(rawFrom);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          fromDate = parsed;
          console.log('[WorkflowRunsPanel] Parsed fromDate:', {
            raw: rawFrom,
            parsed: fromDate.toISOString(),
            localString: fromDate.toString(),
          });
        } else {
          console.warn('[WorkflowRunsPanel] Ignoring invalid from-date filter value:', rawFrom);
        }
      }

      if (rawTo) {
        const parsed = this._parseDateTimeLocal(rawTo);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          toDate = parsed;
          console.log('[WorkflowRunsPanel] Parsed toDate:', {
            raw: rawTo,
            parsed: toDate.toISOString(),
            localString: toDate.toString(),
          });
        } else {
          console.warn('[WorkflowRunsPanel] Ignoring invalid to-date filter value:', rawTo);
        }
      }

      const hasDateFilter = !!fromDate || !!toDate;

      console.log(
        '[WorkflowRunsPanel] _sendWorkflowRuns: Fetching runs for',
        `${repoConfig.owner}/${repoConfig.name}`,
        'workflowId:',
        workflowId,
        'isManual:',
        repoConfig.isManual,
        'dateFilterFrom:',
        rawFrom,
        'dateFilterTo:',
        rawTo
      );

      const result = hasDateFilter
        ? await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
            workflowId,
            perPage: pageSize,
            createdFrom: fromDate || undefined,
            createdTo: toDate || undefined,
          })
        : await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
            workflowId,
            perPage: pageSize,
          });

      console.log(
        '[WorkflowRunsPanel] _sendWorkflowRuns: Received',
        result?.runs.length || 0,
        'runs (dateFilter active:',
        hasDateFilter,
        ', truncated:',
        hasDateFilter && !!(result && (result as { truncated?: boolean }).truncated === true),
        ')'
      );

      if (result) {
        const truncated = hasDateFilter && (result as { truncated?: boolean }).truncated === true;

        this._panel.webview.postMessage({
          type: 'getWorkflowRuns',
          success: true,
          data: {
            runs: result.runs,
            // For date-filtered results, totalCount is the number of matching runs.
            totalCount: result.totalCount,
            perPage: config.monitoring.maxRuns,
            repository: { owner: repoConfig.owner, name: repoConfig.name },
            truncated,
            // Include workflowId so webview can identify workflow-specific vs all-runs responses
            workflowId: workflowId || null,
          },
        });
      } else {
        this._panel.webview.postMessage({
          type: 'getWorkflowRuns',
          success: false,
          error: 'Failed to fetch workflow runs',
        });
      }
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getWorkflowRuns',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Background refresh for watched runs only.
   * Fetches only the specified watched runs without showing loading indicators.
   * This is used during auto-refresh when "Watched Runs Only" filter is active.
   */
  private async _backgroundRefreshWatchedRuns(data: { watchedRunIds: number[] }) {
    // Helper to send response - ensures webview always gets a response
    // to clear its isBackgroundRefreshInProgress flag
    const sendResponse = (
      success: boolean,
      runs?: unknown[],
      skipped?: string,
      rateLimitInfo?: { remaining: number; limit: number; reset: number }
    ) => {
      this._panel.webview.postMessage({
        type: 'backgroundRefreshWatchedRunsResponse',
        success,
        data: runs ? { runs, rateLimitInfo } : undefined,
        skipped, // Optional: reason why refresh was skipped (for debugging)
      });
    };

    try {
      const authenticated = await TokenManager.getGithubToken();
      if (!authenticated) {
        console.log('[WorkflowRunsPanel] Background refresh skipped: not authenticated');
        sendResponse(false, undefined, 'not authenticated');
        return;
      }

      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        console.log('[WorkflowRunsPanel] Background refresh skipped: no repository config');
        sendResponse(false, undefined, 'no repository config');
        return;
      }

      const { watchedRunIds } = data;
      if (!watchedRunIds || watchedRunIds.length === 0) {
        console.log('[WorkflowRunsPanel] Background refresh skipped: no watched runs');
        sendResponse(false, undefined, 'no watched runs');
        return;
      }

      console.log(
        '[WorkflowRunsPanel] Background refresh: fetching',
        watchedRunIds.length,
        'watched runs'
      );

      // Fetch each watched run individually
      // Note: GitHub API doesn't support fetching multiple runs by ID in a single request
      const { getWorkflowRun } = await import('../api/workflow-monitor');
      const updatedRuns = [];
      let latestRateLimitInfo: { remaining: number; limit: number; reset: number } | undefined;

      for (const runId of watchedRunIds) {
        try {
          const result = await getWorkflowRun(repoConfig.owner, repoConfig.name, runId);
          if (result) {
            updatedRuns.push(result.run);
            // Keep track of the latest rate limit info from any API response
            if (result.rateLimitInfo) {
              latestRateLimitInfo = result.rateLimitInfo;
            }
          }
        } catch (error) {
          console.error(
            '[WorkflowRunsPanel] Background refresh: failed to fetch run',
            runId,
            error
          );
          // Continue with other runs even if one fails
        }
      }

      // Persist rate limit info to storage (throttled to once per minute)
      if (latestRateLimitInfo && typeof latestRateLimitInfo.remaining === 'number') {
        const now = Date.now();
        if (now - lastRateLimitStorageUpdate >= RATE_LIMIT_STORAGE_THROTTLE_MS) {
          lastRateLimitStorageUpdate = now;
          Storage.updateRateLimitTracker({
            remaining: latestRateLimitInfo.remaining,
            limit: latestRateLimitInfo.limit,
            resetTimestamp: latestRateLimitInfo.reset,
          }).catch((err) => {
            console.error('[WorkflowRunsPanel] Failed to persist rate limit info:', err);
          });
        }
      }

      console.log(
        '[WorkflowRunsPanel] Background refresh: fetched',
        updatedRuns.length,
        'runs',
        latestRateLimitInfo
          ? `(Rate limit: ${latestRateLimitInfo.remaining}/${latestRateLimitInfo.limit})`
          : ''
      );
      sendResponse(true, updatedRuns, undefined, latestRateLimitInfo);
    } catch (error) {
      console.error(
        '[WorkflowRunsPanel] Background refresh error:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      // Send error response so webview can clear its isBackgroundRefreshInProgress flag
      sendResponse(false, undefined, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Background refresh for all runs.
   * Fetches the latest workflow runs without showing loading indicators.
   * This is used during auto-refresh to silently update the runs list.
   */
  private async _backgroundRefreshAllRuns() {
    // Helper to send response - ensures webview always gets a response
    // to clear its isBackgroundRefreshInProgress flag
    const sendResponse = (
      success: boolean,
      data?: {
        runs: unknown[];
        totalCount: number;
        perPage: number;
        repository: { owner: string; name: string };
        truncated?: boolean;
        rateLimitInfo?: { remaining: number; limit: number; reset: number };
      },
      skipped?: string
    ) => {
      this._panel.webview.postMessage({
        type: 'backgroundRefreshAllRunsResponse',
        success,
        data,
        skipped, // Optional: reason why refresh was skipped (for debugging)
      });
    };

    try {
      const authenticated = await TokenManager.getGithubToken();
      if (!authenticated) {
        console.log('[WorkflowRunsPanel] Background refresh all skipped: not authenticated');
        sendResponse(false, undefined, 'not authenticated');
        return;
      }

      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        console.log('[WorkflowRunsPanel] Background refresh all skipped: no repository config');
        sendResponse(false, undefined, 'no repository config');
        return;
      }

      console.log('[WorkflowRunsPanel] Background refresh all: fetching latest runs');

      const config = getConfig();
      const workflowId = this._currentWorkflowId;
      const pageSize = Math.min(config.monitoring.maxRuns, 100);

      const rawFrom = this._currentDateFilterFrom;
      const rawTo = this._currentDateFilterTo;

      let fromDate: Date | null = null;
      let toDate: Date | null = null;

      if (rawFrom) {
        const parsed = new Date(rawFrom);
        if (!isNaN(parsed.getTime())) {
          fromDate = parsed;
        }
      }

      if (rawTo) {
        const parsed = new Date(rawTo);
        if (!isNaN(parsed.getTime())) {
          toDate = parsed;
        }
      }

      const hasDateFilter = fromDate !== null || toDate !== null;

      const result = hasDateFilter
        ? await this._fetchRunsSinceDate({
            owner: repoConfig.owner,
            repo: repoConfig.name,
            workflowId,
            pageSize,
            fromDate,
            toDate,
          })
        : await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
            workflowId,
            perPage: Math.min(config.monitoring.maxRuns, 100),
          });

      console.log(
        '[WorkflowRunsPanel] Background refresh all: fetched',
        result?.runs.length || 0,
        'runs'
      );

      if (result) {
        const truncated = hasDateFilter && (result as { truncated?: boolean }).truncated === true;

        // Include rate limit info if available
        const rateLimitInfo = (
          result as { rateLimitInfo?: { remaining: number; limit: number; reset: number } }
        ).rateLimitInfo;

        // Persist rate limit info to storage (throttled to once per minute)
        // This is for tracking/reference purposes - the UI display is updated
        // from actual API responses, not loaded from storage on startup
        if (rateLimitInfo && typeof rateLimitInfo.remaining === 'number') {
          const now = Date.now();
          if (now - lastRateLimitStorageUpdate >= RATE_LIMIT_STORAGE_THROTTLE_MS) {
            lastRateLimitStorageUpdate = now;
            Storage.updateRateLimitTracker({
              remaining: rateLimitInfo.remaining,
              limit: rateLimitInfo.limit,
              resetTimestamp: rateLimitInfo.reset,
            }).catch((err) => {
              console.error('[WorkflowRunsPanel] Failed to persist rate limit info:', err);
            });
          }
        }

        sendResponse(true, {
          runs: result.runs,
          totalCount: result.totalCount,
          perPage: config.monitoring.maxRuns,
          repository: { owner: repoConfig.owner, name: repoConfig.name },
          truncated,
          rateLimitInfo,
        });
      } else {
        // API returned null - send failure response so webview can clear its state
        console.log('[WorkflowRunsPanel] Background refresh all: API returned no result');
        sendResponse(false, undefined, 'API returned no result');
      }
    } catch (error) {
      console.error(
        '[WorkflowRunsPanel] Background refresh all error:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      // Send error response so webview can clear its isBackgroundRefreshInProgress flag
      sendResponse(false, undefined, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Parse a datetime-local input value (e.g., "2025-11-20T09:58") as local time.
   * The datetime-local input returns a string in local timezone, but new Date()
   * interprets it as UTC if there's no timezone offset. This helper ensures the
   * datetime is parsed in the local timezone.
   */
  private _parseDateTimeLocal(datetimeLocal: string): Date | null {
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
      console.error('[WorkflowRunsPanel] Failed to parse datetime-local:', datetimeLocal, error);
      return null;
    }
  }

  /**
   * Fetch workflow runs within an optional [fromDate, toDate] window.
   *
   * HYBRID FILTERING STRATEGY:
   * 1. Server-side: Passes date range to GitHub API via `created` parameter
   *    - This is critical for workflows with 1000+ runs per day
   *    - Ensures we fetch runs within the date range, not just recent runs
   * 2. Client-side: Additional filtering on returned runs as a fallback
   *    - Handles edge cases where GitHub API may return incomplete results
   *    - Provides precise filtering down to the second
   *
   * fromDate and toDate are inclusive bounds. We page through results,
   * stopping when runs get older than fromDate (if provided) or we exhaust maxPages.
   *
   * When we hit the internal maxPages cap without reaching the lower bound of the
   * date window, we mark the result as truncated so the webview can inform the
   * user that not all matching runs are shown.
   */
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
  } | null> {
    const { owner, repo, workflowId, pageSize, fromDate, toDate } = params;

    console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Starting fetch', {
      owner,
      repo,
      workflowId,
      pageSize,
      fromDate: fromDate?.toISOString(),
      toDate: toDate?.toISOString(),
    });

    const allRuns: WorkflowRun[] = [];
    const maxPages = 10;

    // Determine how many runs we're willing to scan for the active date range.
    // The cap is configurable via the Workflow Runs panel settings UI but always
    // clamped to a safe range to prevent excessive API usage.
    let maxDateWindowRuns = 2000;
    try {
      const panelSettings = await Storage.getWorkflowRunsPanelSettings();
      const configuredLimit = panelSettings?.dateFilterMaxTotalRuns;
      if (
        typeof configuredLimit === 'number' &&
        Number.isFinite(configuredLimit) &&
        configuredLimit > 0
      ) {
        maxDateWindowRuns = configuredLimit;
      }
    } catch (error) {
      console.error(
        '[WorkflowRunsPanel] _fetchRunsSinceDate: Failed to read panel settings, using default maxDateWindowRuns=2000',
        error
      );
    }

    // Hard clamp the limit to a sensible range.
    const MAX_DATE_WINDOW_RUNS = Math.max(1000, Math.min(maxDateWindowRuns, 10000));
    let page = 1;
    let truncated = false;
    let totalRunsScanned = 0;
    let runsSkippedTooNew = 0;
    let runsSkippedTooOld = 0;

    while (page <= maxPages && allRuns.length < MAX_DATE_WINDOW_RUNS) {
      console.log(`[WorkflowRunsPanel] _fetchRunsSinceDate: Fetching page ${page}...`);

      // CRITICAL FIX: Pass date range to GitHub API to handle workflows with 1000+ runs/day
      // This ensures we fetch runs within the specified date range instead of just
      // the most recent runs. Client-side filtering is still performed as a fallback.
      const pageResult = await getWorkflowRuns(owner, repo, {
        workflowId,
        perPage: pageSize,
        page,
        createdFrom: fromDate || undefined,
        createdTo: toDate || undefined,
      });

      if (!pageResult) {
        console.error('[WorkflowRunsPanel] _fetchRunsSinceDate: API returned null');
        return null;
      }

      const { runs } = pageResult;
      totalRunsScanned += runs.length;

      console.log(
        `[WorkflowRunsPanel] _fetchRunsSinceDate: Page ${page} returned ${runs.length} runs`
      );

      if (!runs.length) {
        console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: No more runs, stopping pagination');
        break;
      }

      let reachedOlderThanFrom = false;
      let runsIncludedThisPage = 0;

      for (const run of runs) {
        const timestamp = run.run_started_at ?? run.created_at;
        const runDate = new Date(timestamp);

        if (Number.isNaN(runDate.getTime())) {
          // If we can't parse the date, include it so it's not silently dropped.
          console.warn(
            '[WorkflowRunsPanel] _fetchRunsSinceDate: Invalid date for run',
            run.id,
            'timestamp:',
            timestamp
          );
          allRuns.push(run);
          runsIncludedThisPage++;
          if (allRuns.length >= MAX_DATE_WINDOW_RUNS) {
            truncated = true;
            break;
          }
          continue;
        }

        // If toDate is set and this run is newer than toDate, skip it
        // but keep scanning this page (newer  older).
        if (toDate && runDate > toDate) {
          runsSkippedTooNew++;
          if (runsSkippedTooNew <= 2) {
            console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Skipping run (too new)', {
              runId: run.id,
              runDate: runDate.toISOString(),
              toDate: toDate.toISOString(),
              comparison: `${runDate.toISOString()} > ${toDate.toISOString()}`,
            });
          }
          continue;
        }

        // If fromDate is set and this run is older than fromDate, we can stop:
        // all subsequent runs in this page and later pages will be older too.
        if (fromDate && runDate < fromDate) {
          runsSkippedTooOld++;
          if (runsSkippedTooOld <= 2) {
            console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Skipping run (too old)', {
              runId: run.id,
              runDate: runDate.toISOString(),
              fromDate: fromDate.toISOString(),
              comparison: `${runDate.toISOString()} < ${fromDate.toISOString()}`,
            });
          }
          reachedOlderThanFrom = true;
          break;
        }

        // Run is within [fromDate, toDate] (respecting whichever bounds are present).
        allRuns.push(run);
        runsIncludedThisPage++;

        if (allRuns.length <= 3) {
          console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Including run (within range)', {
            runId: run.id,
            runDate: runDate.toISOString(),
            fromDate: fromDate?.toISOString(),
            toDate: toDate?.toISOString(),
          });
        }
      }

      console.log(`[WorkflowRunsPanel] _fetchRunsSinceDate: Page ${page} summary:`, {
        runsIncludedThisPage,
        totalIncluded: allRuns.length,
        reachedOlderThanFrom,
      });

      if (reachedOlderThanFrom || runs.length < pageSize) {
        console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Stopping pagination', {
          reachedOlderThanFrom,
          lastPageWasPartial: runs.length < pageSize,
        });
        break;
      }

      if (page === maxPages) {
        console.log(
          '[WorkflowRunsPanel] _fetchRunsSinceDate: Reached maxPages limit, marking as truncated'
        );
        truncated = true;
        break;
      }

      page += 1;
    }

    console.log('[WorkflowRunsPanel] _fetchRunsSinceDate: Fetch complete', {
      totalRunsScanned,
      runsIncluded: allRuns.length,
      runsSkippedTooNew,
      runsSkippedTooOld,
      pagesScanned: page,
      truncated,
    });

    return {
      runs: allRuns,
      // totalCount here represents the number of runs that matched the date window.
      totalCount: allRuns.length,
      truncated,
    };
  }

  /**
   * Load more workflow runs (pagination)
   */
  private async _loadMoreRuns(data: { page: number }) {
    try {
      const authenticated = await TokenManager.getGithubToken();
      if (!authenticated) {
        this._panel.webview.postMessage({
          type: 'loadMoreRuns',
          success: false,
          error: 'Not authenticated',
        });
        return;
      }

      // Use repository configuration so manual overrides are respected, and
      // keep pagination consistent with the initial _sendWorkflowRuns fetch.
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        this._panel.webview.postMessage({
          type: 'loadMoreRuns',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      const config = getConfig();
      const pageSize = Math.min(config.monitoring.maxRuns, 100);

      const rawFrom = this._currentDateFilterFrom;
      const rawTo = this._currentDateFilterTo;

      let fromDate: Date | null = null;
      let toDate: Date | null = null;

      if (rawFrom) {
        const parsed = this._parseDateTimeLocal(rawFrom);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          fromDate = parsed;
        }
      }

      if (rawTo) {
        const parsed = this._parseDateTimeLocal(rawTo);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          toDate = parsed;
        }
      }

      const hasDateFilter = !!fromDate || !!toDate;

      const result = hasDateFilter
        ? await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
            workflowId: this._currentWorkflowId,
            perPage: pageSize,
            page: data.page,
            createdFrom: fromDate || undefined,
            createdTo: toDate || undefined,
          })
        : await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
            workflowId: this._currentWorkflowId,
            perPage: pageSize,
            page: data.page,
          });

      if (result) {
        this._panel.webview.postMessage({
          type: 'loadMoreRuns',
          success: true,
          data: {
            runs: result.runs,
            totalCount: result.totalCount,
            perPage: config.monitoring.maxRuns,
            repository: { owner: repoConfig.owner, name: repoConfig.name },
          },
        });
      } else {
        this._panel.webview.postMessage({
          type: 'loadMoreRuns',
          success: false,
          error: 'Failed to fetch more workflow runs',
        });
      }
    } catch (error) {
      console.error('Error loading more workflow runs:', error);
      this._panel.webview.postMessage({
        type: 'loadMoreRuns',
        success: false,
        error: 'An error occurred while loading more workflow runs',
      });
    }
  }

  /**
   * Progressive fetch workflow runs for intelligent background loading.
   * Fetches multiple pages in sequence to help client-side filtering reach
   * the desired number of matching results.
   */
  private async _progressiveFetchRuns(data: {
    startPage: number;
    maxPages: number;
    generation?: number;
  }) {
    // Capture generation to pass back in response for stale detection
    const generation = data.generation;

    try {
      const authenticated = await TokenManager.getGithubToken();
      if (!authenticated) {
        this._panel.webview.postMessage({
          type: 'progressiveFetchRunsResponse',
          success: false,
          error: 'Not authenticated',
          data: { generation },
        });
        return;
      }

      const repoConfig = await getRepositoryConfig();
      if (!repoConfig.owner || !repoConfig.name) {
        this._panel.webview.postMessage({
          type: 'progressiveFetchRunsResponse',
          success: false,
          error: 'Could not get repository information',
          data: { generation },
        });
        return;
      }

      const config = getConfig();
      const pageSize = Math.min(config.monitoring.maxRuns, 100);
      const allRuns: WorkflowRun[] = [];
      let currentPage = data.startPage;
      const maxPage = data.startPage + data.maxPages - 1;

      const rawFrom = this._currentDateFilterFrom;
      const rawTo = this._currentDateFilterTo;

      let fromDate: Date | null = null;
      let toDate: Date | null = null;

      if (rawFrom) {
        const parsed = this._parseDateTimeLocal(rawFrom);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          fromDate = parsed;
        }
      }

      if (rawTo) {
        const parsed = this._parseDateTimeLocal(rawTo);
        if (parsed && !Number.isNaN(parsed.getTime())) {
          toDate = parsed;
        }
      }

      const hasDateFilter = !!fromDate || !!toDate;

      // Fetch pages sequentially, respecting any active date filter
      while (currentPage <= maxPage) {
        const result = hasDateFilter
          ? await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
              workflowId: this._currentWorkflowId,
              perPage: pageSize,
              page: currentPage,
              createdFrom: fromDate || undefined,
              createdTo: toDate || undefined,
            })
          : await getWorkflowRuns(repoConfig.owner, repoConfig.name, {
              workflowId: this._currentWorkflowId,
              perPage: pageSize,
              page: currentPage,
            });

        if (!result || result.runs.length === 0) {
          // No more runs available
          break;
        }

        allRuns.push(...result.runs);
        currentPage++;

        // If we got fewer runs than requested, we've reached the end
        if (result.runs.length < pageSize) {
          break;
        }
      }

      this._panel.webview.postMessage({
        type: 'progressiveFetchRunsResponse',
        success: true,
        data: {
          runs: allRuns,
          fetchedPages: currentPage - data.startPage,
          repository: { owner: repoConfig.owner, name: repoConfig.name },
          generation,
        },
      });
    } catch (error) {
      console.error('Error in progressive fetch:', error);
      this._panel.webview.postMessage({
        type: 'progressiveFetchRunsResponse',
        success: false,
        error: 'An error occurred during progressive fetch',
        data: { generation },
      });
    }
  }

  /**
   * Send workflow run jobs to webview
   */
  private async _sendWorkflowRunJobs(data: { runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'getWorkflowRunJobs',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      const jobs = await getWorkflowRunJobs(repoInfo.owner, repoInfo.name, data.runId);

      this._panel.webview.postMessage({
        type: 'getWorkflowRunJobs',
        success: !!jobs,
        data: { runId: data.runId, jobs: jobs || [] },
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getWorkflowRunJobs',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch jobs',
      });
    }
  }

  /**
   * Send job dependencies to webview for graph visualization
   * Combines runtime job data from API with dependency info from YAML
   */
  private async _sendJobDependencies(data: { runId: number; workflowPath: string }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'getJobDependenciesResponse',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      // Get runtime jobs from GitHub API
      const jobs = await getWorkflowRunJobs(repoInfo.owner, repoInfo.name, data.runId);

      // Parse job dependencies from workflow YAML
      const { parseJobDependencies } = await import('../utils/workflow-parser');
      const jobDefinitions = await parseJobDependencies(data.workflowPath);

      this._panel.webview.postMessage({
        type: 'getJobDependenciesResponse',
        success: true,
        data: {
          runId: data.runId,
          jobs: jobs || [],
          jobDefinitions,
        },
      });
    } catch (error) {
      console.error('Error fetching job dependencies:', error);
      this._panel.webview.postMessage({
        type: 'getJobDependenciesResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch job dependencies',
      });
    }
  }

  /**
   * Get jobs for a workflow run
   */
  private async _getWorkflowRunJobs(data: { runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'getWorkflowRunJobs',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      const jobs = await getWorkflowRunJobs(repoInfo.owner, repoInfo.name, data.runId);

      this._panel.webview.postMessage({
        type: 'getWorkflowRunJobs',
        success: true,
        data: { runId: data.runId, jobs },
      });
    } catch (error) {
      console.error('Error fetching workflow run jobs:', error);
      this._panel.webview.postMessage({
        type: 'getWorkflowRunJobs',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch jobs',
      });
    }
  }

  /**
   * View job logs using TextDocumentContentProvider
   * Opens logs in VSCode's native text editor
   * Checks if logs are available first to provide user-friendly error messages
   */
  private async _viewJobLogs(data: { jobId: number; jobName: string; runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        this._panel.webview.postMessage({
          type: 'viewJobLogsResponse',
          success: false,
          error: 'Could not get repository information',
          data: { jobId: data.jobId },
        });
        return;
      }

      // Check if logs are available before attempting to open
      const availability = await checkJobLogsAvailable(repoInfo.owner, repoInfo.name, data.jobId);

      if (!availability.available) {
        // Show user-friendly message instead of opening a tab that will fail
        const reason = availability.reason || 'The job has not completed yet.';
        vscode.window.showInformationMessage(
          `Logs are not yet available for "${data.jobName}". ${reason} You can try viewing individual step logs if the job has started.`
        );
        this._panel.webview.postMessage({
          type: 'viewJobLogsResponse',
          success: false,
          error: 'Logs not available',
          data: { jobId: data.jobId, available: false, reason },
        });
        return;
      }

      // Build log URI
      const logUri = buildLogURI(
        data.jobName,
        repoInfo.owner,
        repoInfo.name,
        data.jobId,
        data.runId
      );

      // Open the log document in VSCode's text editor
      const doc = await vscode.workspace.openTextDocument(logUri);

      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });

      this._panel.webview.postMessage({
        type: 'viewJobLogsResponse',
        success: true,
        data: { jobId: data.jobId, opened: true },
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to view job logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'viewJobLogsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to view logs',
      });
    }
  }

  /**
   * View job logs in interactive webview panel with collapsible groups
   * Opens logs in a custom webview that mimics GitHub's log viewer UI
   */
  private async _viewJobLogsInteractive(data: { jobId: number; jobName: string; runId: number }) {
    try {
      const { LogViewerPanel } = await import('./log-viewer-panel');
      await LogViewerPanel.createOrShow(this._extensionUri, {
        jobId: data.jobId,
        jobName: data.jobName,
        runId: data.runId,
      });

      this._panel.webview.postMessage({
        type: 'viewJobLogsInteractiveResponse',
        success: true,
        data: { jobId: data.jobId, opened: true },
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open log viewer: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'viewJobLogsInteractiveResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open log viewer',
        data: { jobId: data.jobId },
      });
    }
  }

  /**
   * Compare logs from two different jobs using VS Code's diff editor
   * Fetches logs for both jobs and opens them in a side-by-side diff view
   */
  /**
   * Strip timestamps from log lines to enable meaningful diff comparison.
   * GitHub Actions logs typically have ISO 8601 timestamps at the start of each line
   * (e.g., "2024-01-15T10:30:45.1234567Z Some log message")
   */
  private _stripTimestampsFromLogs(logs: string): string {
    // Match ISO 8601 timestamps at the start of lines
    // Format: YYYY-MM-DDTHH:MM:SS.nnnnnnnZ (with variable precision on milliseconds)
    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/gm;
    return logs.replace(timestampRegex, '');
  }

  private async _compareJobLogs(data: {
    sourceJobId: number;
    sourceJobName: string;
    sourceRunId: number;
    targetJobId: number;
    targetJobName: string;
    targetRunId: number;
  }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        throw new Error('Could not get repository information');
      }

      // Fetch logs for both jobs in parallel
      const [sourceLogs, targetLogs] = await Promise.all([
        getJobLogs(repoInfo.owner, repoInfo.name, data.sourceJobId),
        getJobLogs(repoInfo.owner, repoInfo.name, data.targetJobId),
      ]);

      // Strip timestamps from logs to enable meaningful diff comparison
      const sourceLogsClean = this._stripTimestampsFromLogs(sourceLogs);
      const targetLogsClean = this._stripTimestampsFromLogs(targetLogs);

      // Create unique URIs with timestamp to avoid caching issues
      const timestamp = Date.now();
      const sourceUri = vscode.Uri.parse(
        `github-workflow-log:/${timestamp}/source/${data.sourceJobName.replace(/[/\\?%*:|"<>]/g, '-')}-run-${data.sourceRunId}.log`
      );
      const targetUri = vscode.Uri.parse(
        `github-workflow-log:/${timestamp}/target/${data.targetJobName.replace(/[/\\?%*:|"<>]/g, '-')}-run-${data.targetRunId}.log`
      );

      // Use a Map to store content by URI path
      const contentMap = new Map<string, string>();
      contentMap.set(sourceUri.path, sourceLogsClean);
      contentMap.set(targetUri.path, targetLogsClean);

      // Create a single provider that serves content based on URI
      const provider: vscode.TextDocumentContentProvider = {
        provideTextDocumentContent: (uri: vscode.Uri): string => {
          return contentMap.get(uri.path) || '';
        },
      };

      // Register a single provider for both documents
      const disposable = vscode.workspace.registerTextDocumentContentProvider(
        'github-workflow-log',
        provider
      );

      // Open the diff editor
      const diffTitle = `Log Comparison: ${data.sourceJobName} (Run #${data.sourceRunId}) ↔ ${data.targetJobName} (Run #${data.targetRunId})`;
      await vscode.commands.executeCommand('vscode.diff', sourceUri, targetUri, diffTitle);

      // Clean up provider after a delay (to ensure the diff editor has loaded)
      setTimeout(() => {
        disposable.dispose();
        contentMap.clear();
      }, 5000);

      this._panel.webview.postMessage({
        type: 'compareJobLogsResponse',
        success: true,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to compare logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'compareJobLogsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to compare logs',
      });
    }
  }

  /**
   * Compare logs from two different steps using VS Code's diff editor
   * Fetches logs for both steps and opens them in a side-by-side diff view
   */
  private async _compareStepLogs(data: {
    sourceJobId: number;
    sourceJobName: string;
    sourceRunId: number;
    sourceStepNumber: number;
    sourceStepName: string;
    targetJobId: number;
    targetJobName: string;
    targetRunId: number;
    targetStepNumber: number;
    targetStepName: string;
  }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        throw new Error('Could not get repository information');
      }

      // Fetch logs for both jobs
      const [sourceLogs, targetLogs] = await Promise.all([
        getJobLogs(repoInfo.owner, repoInfo.name, data.sourceJobId),
        getJobLogs(repoInfo.owner, repoInfo.name, data.targetJobId),
      ]);

      // Extract step-specific logs from the full job logs
      const sourceStepLogs = this._extractStepLogs(
        sourceLogs,
        data.sourceStepNumber,
        data.sourceStepName
      );
      const targetStepLogs = this._extractStepLogs(
        targetLogs,
        data.targetStepNumber,
        data.targetStepName
      );

      // Strip timestamps from step logs to enable meaningful diff comparison
      const sourceStepLogsClean = this._stripTimestampsFromLogs(sourceStepLogs);
      const targetStepLogsClean = this._stripTimestampsFromLogs(targetStepLogs);

      // Create unique URIs with timestamp to avoid caching issues
      const timestamp = Date.now();
      const sourceUri = vscode.Uri.parse(
        `github-workflow-log:/${timestamp}/source/step-${data.sourceJobId}-${data.sourceStepNumber}.log`
      );
      const targetUri = vscode.Uri.parse(
        `github-workflow-log:/${timestamp}/target/step-${data.targetJobId}-${data.targetStepNumber}.log`
      );

      // Use a Map to store content by URI path
      const contentMap = new Map<string, string>();
      contentMap.set(sourceUri.path, sourceStepLogsClean);
      contentMap.set(targetUri.path, targetStepLogsClean);

      // Create a single provider that serves content based on URI
      const provider: vscode.TextDocumentContentProvider = {
        provideTextDocumentContent: (uri: vscode.Uri): string => {
          return contentMap.get(uri.path) || '';
        },
      };

      // Register a single provider for both documents
      const disposable = vscode.workspace.registerTextDocumentContentProvider(
        'github-workflow-log',
        provider
      );

      // Open the diff editor
      const diffTitle = `Step Comparison: ${data.sourceStepName} (${data.sourceJobName}) ↔ ${data.targetStepName} (${data.targetJobName})`;
      await vscode.commands.executeCommand('vscode.diff', sourceUri, targetUri, diffTitle);

      // Clean up provider after a delay (to ensure the diff editor has loaded)
      setTimeout(() => {
        disposable.dispose();
        contentMap.clear();
      }, 5000);

      this._panel.webview.postMessage({
        type: 'compareStepLogsResponse',
        success: true,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to compare step logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'compareStepLogsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to compare step logs',
      });
    }
  }

  /**
   * Extract logs for a specific step from the full job logs
   * GitHub logs use ##[group]StepName and ##[endgroup] to mark step boundaries.
   * Steps are numbered starting from 1 (matching the API step.number field).
   */
  private _extractStepLogs(fullLogs: string, stepNumber: number, stepName: string): string {
    const lines = fullLogs.split('\n');

    // First, parse all step sections from the logs
    const stepSections: Array<{ name: string; startLine: number; endLine: number }> = [];
    let currentStepStart = -1;
    let currentStepName = '';
    let nestingLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for group start marker: ##[group]StepName
      const groupMatch = line.match(/##\[group\](.+)/);
      if (groupMatch) {
        if (nestingLevel === 0) {
          // Top-level group = new step
          currentStepStart = i;
          currentStepName = groupMatch[1].trim();
        }
        nestingLevel++;
        continue;
      }

      // Check for group end marker: ##[endgroup]
      if (line.includes('##[endgroup]')) {
        nestingLevel = Math.max(0, nestingLevel - 1);
        if (nestingLevel === 0 && currentStepStart >= 0) {
          // End of top-level step
          stepSections.push({
            name: currentStepName,
            startLine: currentStepStart,
            endLine: i,
          });
          currentStepStart = -1;
          currentStepName = '';
        }
        continue;
      }
    }

    // Handle unclosed step at end of logs
    if (currentStepStart >= 0) {
      stepSections.push({
        name: currentStepName,
        startLine: currentStepStart,
        endLine: lines.length - 1,
      });
    }

    // Try to find the step by number first (most reliable)
    // Step numbers are 1-based, array is 0-based
    if (stepNumber > 0 && stepNumber <= stepSections.length) {
      const section = stepSections[stepNumber - 1];
      return lines.slice(section.startLine, section.endLine + 1).join('\n');
    }

    // Fallback: try to find by name (fuzzy match)
    const normalizedStepName = stepName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const section of stepSections) {
      const normalizedSectionName = section.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        normalizedSectionName.includes(normalizedStepName) ||
        normalizedStepName.includes(normalizedSectionName)
      ) {
        return lines.slice(section.startLine, section.endLine + 1).join('\n');
      }
    }

    // Last resort: search for the step name anywhere in the logs
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().includes(stepName.toLowerCase())) {
        // Include context around the match
        const start = Math.max(0, i - 5);
        const end = Math.min(lines.length, i + 50);
        return lines.slice(start, end).join('\n');
      }
    }

    // Provide debugging info when no step found
    const stepInfo =
      stepSections.length > 0
        ? `\n\nFound ${stepSections.length} steps in logs:\n${stepSections.map((s, idx) => `  ${idx + 1}. ${s.name}`).join('\n')}`
        : '\n\nNo step sections (##[group]...##[endgroup]) found in logs.';

    return `No logs found for step "${stepName}" (step #${stepNumber}).${stepInfo}`;
  }

  /**
   * Check if job logs are available before attempting to display them
   * Returns availability status to allow webview to show appropriate loading/message
   */
  private async _checkJobLogsAvailability(data: { jobId: number; jobName: string; runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'checkJobLogsAvailabilityResponse',
          success: false,
          error: 'Could not get repository information',
          data: { jobId: data.jobId },
        });
        return;
      }

      const result = await checkJobLogsAvailable(repoInfo.owner, repoInfo.name, data.jobId);

      this._panel.webview.postMessage({
        type: 'checkJobLogsAvailabilityResponse',
        success: true,
        data: {
          jobId: data.jobId,
          available: result.available,
          reason: result.reason,
        },
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'checkJobLogsAvailabilityResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check logs availability',
        data: { jobId: data.jobId },
      });
    }
  }

  /**
   * Get detailed job information including current steps
   * Used to fetch steps for running jobs
   */
  private async _getJobDetails(data: { jobId: number; runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'getJobDetailsResponse',
          success: false,
          error: 'Could not get repository information',
          data: { jobId: data.jobId },
        });
        return;
      }

      const job = await getWorkflowJob(repoInfo.owner, repoInfo.name, data.jobId);

      if (job) {
        this._panel.webview.postMessage({
          type: 'getJobDetailsResponse',
          success: true,
          data: { jobId: data.jobId, job },
        });
      } else {
        this._panel.webview.postMessage({
          type: 'getJobDetailsResponse',
          success: false,
          error: 'Job not found',
          data: { jobId: data.jobId },
        });
      }
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getJobDetailsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch job details',
        data: { jobId: data.jobId },
      });
    }
  }

  /**
   * View logs for a specific step within a job
   * Fetches the job logs and extracts the section for the specified step
   */
  private async _viewStepLogs(data: {
    jobId: number;
    jobName: string;
    runId: number;
    stepNumber: number;
    stepName: string;
  }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        this._panel.webview.postMessage({
          type: 'viewStepLogsResponse',
          success: false,
          error: 'Could not get repository information',
          data: { jobId: data.jobId, stepNumber: data.stepNumber },
        });
        return;
      }

      // Check if job logs are available before attempting to open step logs
      // Step logs are extracted from job logs, so job logs must be available first
      const availability = await checkJobLogsAvailable(repoInfo.owner, repoInfo.name, data.jobId);

      if (!availability.available) {
        // Show user-friendly message instead of opening a tab that will fail
        const reason = availability.reason || 'The job logs are not yet generated.';
        vscode.window.showInformationMessage(
          `Logs for step "${data.stepName}" are not yet available. ${reason}`
        );
        this._panel.webview.postMessage({
          type: 'viewStepLogsResponse',
          success: false,
          error: 'Step logs not yet available',
          data: { jobId: data.jobId, stepNumber: data.stepNumber, available: false },
        });
        return;
      }

      // Open interactive log viewer with step info for auto-expand and scroll
      const { LogViewerPanel } = await import('./log-viewer-panel');
      await LogViewerPanel.createOrShow(this._extensionUri, {
        jobId: data.jobId,
        jobName: data.jobName,
        runId: data.runId,
        stepNumber: data.stepNumber,
        stepName: data.stepName,
      });

      this._panel.webview.postMessage({
        type: 'viewStepLogsResponse',
        success: true,
        data: { jobId: data.jobId, stepNumber: data.stepNumber, opened: true },
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to view step logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'viewStepLogsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to view step logs',
        data: { jobId: data.jobId, stepNumber: data.stepNumber },
      });
    }
  }

  /**
   * View workflow run logs (deprecated - kept for backwards compatibility)
   * Now redirects to viewing jobs
   */
  private async _viewWorkflowRunLogs(data: { runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      // Fetch jobs for the run
      const jobs = await getWorkflowRunJobs(repoInfo.owner, repoInfo.name, data.runId);

      if (jobs.length === 0) {
        vscode.window.showInformationMessage('No jobs found for this workflow run.');
        return;
      }

      // If there's only one job, open it directly
      if (jobs.length === 1) {
        await this._viewJobLogs({
          jobId: jobs[0].id,
          jobName: jobs[0].name,
          runId: data.runId,
        });
        return;
      }

      // Multiple jobs - let user choose
      const jobNames = jobs.map((job) => job.name);
      const selected = await vscode.window.showQuickPick(jobNames, {
        placeHolder: 'Select a job to view logs',
      });

      if (selected) {
        const job = jobs.find((j) => j.name === selected);
        if (job) {
          await this._viewJobLogs({
            jobId: job.id,
            jobName: job.name,
            runId: data.runId,
          });
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to view logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get artifacts for a workflow run
   */
  private async _getWorkflowRunArtifacts(data: { runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        this._panel.webview.postMessage({
          type: 'getWorkflowRunArtifacts',
          success: false,
          error: 'Could not get repository information',
        });
        return;
      }

      const artifacts = await getWorkflowRunArtifacts(repoInfo.owner, repoInfo.name, data.runId);

      this._panel.webview.postMessage({
        type: 'getWorkflowRunArtifacts',
        success: true,
        data: { runId: data.runId, artifacts: artifacts || [] },
      });
    } catch (error) {
      console.error('Error fetching workflow run artifacts:', error);
      this._panel.webview.postMessage({
        type: 'getWorkflowRunArtifacts',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch artifacts',
      });
    }
  }

  /**
   * Download a specific artifact
   */
  private async _downloadArtifact(data: { artifactId: number; artifactName: string }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      // Show progress notification
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading artifact "${data.artifactName}"...`,
          cancellable: false,
        },
        async () => {
          const artifactData = await downloadArtifact(
            repoInfo.owner,
            repoInfo.name,
            data.artifactId
          );

          if (!artifactData) {
            vscode.window.showErrorMessage(`Failed to download artifact "${data.artifactName}"`);
            return;
          }

          // Prompt user to save the artifact
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${data.artifactName}.zip`),
            filters: {
              'Zip Files': ['zip'],
              'All Files': ['*'],
            },
          });

          if (saveUri) {
            fs.writeFileSync(saveUri.fsPath, Buffer.from(artifactData));
            vscode.window.showInformationMessage(
              `✅ Artifact "${data.artifactName}" downloaded successfully!`
            );
          }
        }
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to download artifact: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Download workflow artifacts (deprecated - kept for backwards compatibility)
   */
  private async _downloadWorkflowArtifacts(data: { runId: number }) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      const artifacts = await downloadWorkflowArtifacts(repoInfo.owner, repoInfo.name, data.runId);

      if (!artifacts) {
        vscode.window.showErrorMessage('No artifacts found or failed to download');
        return;
      }

      // Ask user where to save
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`workflow-${data.runId}-artifacts.zip`),
        filters: { 'ZIP files': ['zip'] },
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, new Uint8Array(artifacts));
        vscode.window.showInformationMessage(`Artifacts saved to ${saveUri.fsPath}`);

        this._panel.webview.postMessage({
          type: 'downloadWorkflowArtifactsResponse',
          success: true,
          data: {
            runId: data.runId,
            savedPath: saveUri.fsPath,
            size: artifacts.byteLength,
          },
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to download artifacts: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'downloadWorkflowArtifactsResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to download artifacts',
      });
    }
  }

  /**
   * Rerun a workflow
   */
  private async _rerunWorkflow(data: { runId: number; failedJobsOnly?: boolean }) {
    try {
      // Validate Git context before any GitHub API operation
      const isValidContext = await ensureGitContextValidOrWarn('rerunWorkflow');
      if (!isValidContext) {
        this._panel.webview.postMessage({
          type: 'gitContextMismatch',
          success: false,
          error: 'Repository or branch has changed. Please reload the extension data.',
        });
        return;
      }

      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      const result = await rerunWorkflow(
        repoInfo.owner,
        repoInfo.name,
        data.runId,
        data.failedJobsOnly
      );

      if (result.success) {
        vscode.window.showInformationMessage('✅ Workflow rerun initiated');
        this._panel.webview.postMessage({
          type: 'rerunWorkflowResponse',
          success: true,
          data: { runId: data.runId },
        });
        // Refresh runs
        await this._sendWorkflowRuns();
      } else {
        vscode.window.showErrorMessage(`❌ Failed to rerun workflow: ${result.error}`);
        this._panel.webview.postMessage({
          type: 'rerunWorkflowResponse',
          success: false,
          error: result.error,
          data: { runId: data.runId },
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `❌ Error rerunning workflow: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._panel.webview.postMessage({
        type: 'rerunWorkflowResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rerun workflow',
        data: { runId: data.runId },
      });
    }
  }

  /**
   * Prompt user to rerun workflow with improved UX based on workflow inputs and recovery capability
   */
  private async _promptRerunWorkflowWithInputCheck(
    runId: number,
    workflowName?: string,
    branch?: string
  ) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        await this._rerunWorkflow({ runId });
        return;
      }

      // Fetch run details to get workflow_id
      const runResult = await getWorkflowRun(repoInfo.owner, repoInfo.name, runId);
      if (!runResult) {
        await this._rerunWorkflow({ runId });
        return;
      }
      const run = runResult.run;

      // Resolve workflow file path from workflow_id
      const workflowMeta = await getWorkflowById(repoInfo.owner, repoInfo.name, run.workflow_id);
      if (!workflowMeta || !workflowMeta.path) {
        await this._rerunWorkflow({ runId });
        return;
      }

      const workflowFilename = path.posix.basename(workflowMeta.path);

      // Get workflow definition to check if it has inputs
      const { getWorkflowDefinition } = await import('../utils/workflow-parser');
      const workflowDef = await getWorkflowDefinition(workflowFilename);

      // Case 3: Workflow has NO inputs → Just rerun directly
      if (!workflowDef || !workflowDef.inputs || workflowDef.inputs.length === 0) {
        await this._rerunWorkflow({ runId });
        return;
      }

      // Workflow has inputs - check if we can recover them
      const canRecover = await this._canRecoverInputs(runId, workflowFilename);

      if (canRecover) {
        // Case 1: Workflow has inputs AND we can recover them
        const choice = await vscode.window.showInformationMessage(
          `Rerun "${workflowName || 'workflow'}"?`,
          {
            modal: true,
            detail: branch
              ? `Branch: ${branch}\n\nRecovered inputs are available for this run.`
              : 'Recovered inputs are available for this run.',
          },
          'Rerun from Original',
          'Rerun with Latest Commit',
          'Edit Inputs & Rerun'
        );

        if (choice === 'Rerun from Original') {
          await this._rerunWorkflow({ runId });
        } else if (choice === 'Rerun with Latest Commit') {
          await this._rerunWithLatestCommit(runId);
        } else if (choice === 'Edit Inputs & Rerun') {
          await this._prefillInputsOrRerun(runId);
        }
      } else {
        // Case 2: Workflow has inputs but NO recovery (no parameters available to display or edit)
        const rerunItem: vscode.MessageItem = { title: 'Rerun' };
        const cancelItem: vscode.MessageItem = {
          title: 'Cancel',
          isCloseAffordance: true,
        };

        const choice = await vscode.window.showInformationMessage(
          `Rerun "${workflowName || 'workflow'}"?`,
          {
            modal: true,
            detail: branch
              ? `Branch: ${branch}\n\nParameters are not available for this run. You can rerun it with the original inputs from GitHub, or cancel.`
              : 'Parameters are not available for this run. You can rerun it with the original inputs from GitHub, or cancel.',
          },
          rerunItem,
          cancelItem
        );

        if (choice && choice.title === 'Rerun') {
          await this._rerunWorkflow({ runId });
        }
      }
    } catch (error) {
      console.error('Error in _promptRerunWorkflowWithInputCheck:', error);
      await this._rerunWorkflow({ runId });
    } finally {
      // Always notify the webview that the rerun prompt flow has completed
      // so it can clear any loading indicators tied to this run.
      try {
        if (this._panel) {
          this._panel.webview.postMessage({
            type: 'promptRerunWorkflowComplete',
            success: true,
            data: { runId },
          });
        }
      } catch (postError) {
        console.error('Failed to notify webview of rerun prompt completion:', postError);
      }
    }
  }

  /**
   * Check if we can recover inputs for a workflow run.
   *
   * This is now strictly per-run: it returns true only if we can actually
   * reconstruct inputs for the specific run via _recoverInputsForRun(runId),
   * so its semantics match the Parameters modal.
   */
  private async _canRecoverInputs(runId: number, _workflowFilename: string): Promise<boolean> {
    try {
      const recovered = await this._recoverInputsForRun(runId);
      return !!recovered;
    } catch {
      return false;
    }
  }

  /**
   * Open sidebar with workflow pre-selected.
   *
   * Delegates opening and readiness handling to the prefillDispatch command.
   */
  private async _openSidebarForWorkflow(workflowFilename: string, branch?: string) {
    await vscode.commands.executeCommand('github-workflow-runner.prefillDispatch', {
      workflowFilename,
      branch: branch || '',
      inputs: {},
    });
  }

  /**
   * Prefill dispatch inputs using recovered parameters when possible; otherwise, rerun directly.
   */
  private async _prefillInputsOrRerun(runId: number) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        await this._rerunWorkflow({ runId });
        return;
      }

      // Fetch run details to get workflow_id and branch
      const runResult = await getWorkflowRun(repoInfo.owner, repoInfo.name, runId);
      if (!runResult) {
        await this._rerunWorkflow({ runId });
        return;
      }
      const run = runResult.run;

      // Resolve workflow file path from workflow_id
      const workflowMeta = await getWorkflowById(repoInfo.owner, repoInfo.name, run.workflow_id);
      if (!workflowMeta || !workflowMeta.path) {
        await this._rerunWorkflow({ runId });
        return;
      }

      const workflowFilename = path.posix.basename(workflowMeta.path);

      // Preferred path: use the same recovery logic as the Parameters modal
      const recovered = await this._recoverInputsForRun(runId);
      if (recovered) {
        await vscode.commands.executeCommand('github-workflow-runner.prefillDispatch', {
          workflowFilename: recovered.workflowFilename,
          branch: recovered.branch,
          inputs: recovered.inputs,
          runId,
        });
        return;
      }

      // Fallback: use the latest history entry for this workflow (even if not bound to this run)
      const history = await Storage.getHistoryForWorkflow(workflowFilename, 1);
      if (history && history.length > 0) {
        const latest = history[0];
        const branch = this._normalizeBranch(latest.branch || run.head_branch || '');
        const filteredInputs = await this._filterInputsForWorkflow(
          workflowFilename,
          latest.inputs || {}
        );

        await vscode.commands.executeCommand('github-workflow-runner.prefillDispatch', {
          workflowFilename,
          branch,
          inputs: filteredInputs,
          runId,
        });
        return;
      }

      // Final fallback: Direct rerun without prefilling inputs
      await this._rerunWorkflow({ runId });
    } catch {
      await this._rerunWorkflow({ runId });
    }
  }

  /**
   * Attempt to recover inputs for a workflow run from local history or artifacts.
   * Returns workflow filename, normalized branch, and filtered string inputs.
   */
  private async _recoverInputsForRun(runId: number): Promise<{
    workflowFilename: string;
    inputs: Record<string, string>;
    branch: string;
  } | null> {
    const repoInfo = await getRepositoryInfo();
    if (!repoInfo) {
      return null;
    }

    const runResult = await getWorkflowRun(repoInfo.owner, repoInfo.name, runId);
    if (!runResult) {
      return null;
    }
    const run = runResult.run;

    const workflowMeta = await getWorkflowById(repoInfo.owner, repoInfo.name, run.workflow_id);
    if (!workflowMeta || !workflowMeta.path) {
      return null;
    }
    const workflowFilename = path.posix.basename(workflowMeta.path);

    // Priority 1: Local persistence (match by runId to ensure per-run parameters)
    const history = await Storage.getHistoryForWorkflow(workflowFilename);
    const matching = history.find((h) => typeof h.runId === 'number' && h.runId === runId);

    if (matching) {
      const filteredInputs = await this._filterInputsForWorkflow(
        workflowFilename,
        matching.inputs || {}
      );
      const branch = this._normalizeBranch(matching.branch || run.head_branch || '');

      return {
        workflowFilename,
        inputs: filteredInputs,
        branch,
      };
    }

    // Priority 2: Artifact-based recovery
    const artifacts = await getWorkflowRunArtifacts(repoInfo.owner, repoInfo.name, runId);
    const pattern = await this._getArtifactPattern(workflowFilename);
    const regex = this._createPatternRegex(pattern);
    const paramArtifact = (artifacts || []).find((a) => regex.test(a.name) && !a.expired);
    if (paramArtifact) {
      const buf = await downloadArtifact(repoInfo.owner, repoInfo.name, paramArtifact.id);
      if (buf) {
        try {
          const zip = new AdmZip(Buffer.from(buf));
          const entries = zip.getEntries();
          for (const entry of entries) {
            if (entry.isDirectory) {
              continue;
            }
            const lc = entry.entryName.toLowerCase();
            if (!lc.endsWith('.json')) {
              continue;
            }

            try {
              const txt = zip.readAsText(entry);
              const obj = JSON.parse(txt);
              const extracted = this._extractInputsFromArtifactObject(obj);
              if (!extracted) {
                continue;
              }

              const filteredInputs = await this._filterInputsForWorkflow(
                workflowFilename,
                extracted.inputs
              );
              const branch =
                extracted.branchFromArtifact ?? this._normalizeBranch(run.head_branch || '');

              return {
                workflowFilename,
                inputs: filteredInputs,
                branch,
              };
            } catch {
              // ignore parse errors, try next entry
            }
          }
        } catch {
          // fall through
        }
      }
    }

    return null;
  }

  /**
   * Rerun the workflow with the latest commit on the same branch, using recovered inputs
   */
  private async _rerunWithLatestCommit(runId: number) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        return;
      }

      const recovered = await this._recoverInputsForRun(runId);
      if (!recovered) {
        vscode.window.showErrorMessage('❌ Could not recover inputs for this run.');
        return;
      }

      const { getWorkflowDefinition } = await import('../utils/workflow-parser');
      const definition = await getWorkflowDefinition(recovered.workflowFilename);
      if (!definition) {
        vscode.window.showErrorMessage('❌ Workflow definition not found.');
        return;
      }

      // Determine whether we should prompt in the Workflow Runs webview
      // before dispatching a rerun with recovered inputs.
      let addToWatchList = false;
      if (getConfig().ui.confirmBeforeDispatch) {
        const confirmation = await this._requestDispatchConfirmation({
          workflowName: definition.name,
          workflowFilename: recovered.workflowFilename,
          branch: recovered.branch,
          inputs: recovered.inputs,
        });

        // If the user cancelled, dismissed the modal, or the webview timed
        // out, treat this as a cancelled rerun.
        if (!confirmation || !confirmation.confirmed) {
          return;
        }

        addToWatchList = confirmation.addToWatchList;
      }

      const result = await dispatchWorkflowWithRunId(repoInfo.owner, repoInfo.name, definition, {
        ref: recovered.branch,
        inputs: recovered.inputs,
      });

      if (!result.success) {
        return;
      }

      // Persist history similar to sidebar dispatch and link to the created
      // run when available so we can recover parameters per-run.
      await Storage.addToHistory({
        workflowFilename: recovered.workflowFilename,
        workflowName: definition.name,
        inputs: recovered.inputs,
        branch: recovered.branch,
        runId: result.runId,
      });

      // Highlight new run if available
      if (result.runId) {
        if (addToWatchList) {
          await this._addRunToWatchList(result.runId);
        }

        await WorkflowRunsPanel.createOrShowForAction(this._extensionUri, 'rerun', {
          workflowName: definition.filename, // Use filename for consistent comparison with filter
          actorFilter: 'all', // Default to "All Users" for rerun actions
          showBotRuns: false,
          runId: result.runId,
        });
        WorkflowRunsPanel.highlightRun(result.runId);
      }
    } catch (err) {
      console.error('Error rerunning with latest commit:', err);
    }
  }

  /**
   * Request dispatch confirmation for a rerun from the Workflow Runs webview.
   *
   * This mirrors the sidebar's confirmation flow by delegating the actual UI
   * to the webview while keeping dispatch logic and side effects in the
   * extension host.
   */
  private async _requestDispatchConfirmation(data: {
    workflowName: string;
    workflowFilename: string;
    branch: string;
    inputs: Record<string, string>;
  }): Promise<{ confirmed: boolean; addToWatchList: boolean } | undefined> {
    if (!this._panel) {
      return undefined;
    }

    return new Promise((resolve) => {
      const webview = this._panel!.webview;
      let listener: vscode.Disposable | undefined;

      const timeout = setTimeout(() => {
        if (listener) {
          try {
            listener.dispose();
          } catch {
            // Ignore dispose errors
          }
        }
        resolve(undefined);
      }, 60_000);

      listener = webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (message.type !== 'confirmDispatchResult') {
          return;
        }

        clearTimeout(timeout);
        if (listener) {
          try {
            listener.dispose();
          } catch {
            // Ignore dispose errors
          }
        }

        const result = (message.data ?? {}) as {
          confirmed?: boolean;
          addToWatchList?: boolean;
        };

        resolve({
          confirmed: !!result.confirmed,
          addToWatchList: !!result.addToWatchList,
        });
      });

      webview.postMessage({
        type: 'confirmDispatch',
        data,
      });
    });
  }

  /**
   * Open workflow file in editor
   */
  private async _openWorkflowFile(filePath: string) {
    try {
      const repoInfo = await getRepositoryInfo();
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      // Construct the full path to the workflow file
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fullPath);
      } catch {
        vscode.window.showErrorMessage(`Workflow file not found: ${filePath}`);
        return;
      }

      // Open the file in the editor
      const document = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open workflow file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Add cache-busting query parameter to force webview to reload the script
    // This is critical for ensuring timezone fixes and other updates are loaded
    const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'workflow-runs.js');
    const scriptUri = webview.asWebviewUri(scriptPath);
    // Append timestamp AND random string to bust VS Code's aggressive webview caching
    // Using both timestamp and random ensures the URL is always unique
    const cacheBuster = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const scriptUriWithCacheBust = `${scriptUri}?v=${cacheBuster}`;
    const nonce = getNonce();
    // Load VS Code Codicons CSS from extension's node_modules
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css')
    );

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <link rel="stylesheet" href="${codiconsUri}">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>GitHub Workflow Runs</title>
            </head>
            <body>
                <div id="app"></div>
                <script nonce="${nonce}">
                    // Acquire VS Code API
                    const vscode = acquireVsCodeApi();
                    window.vscode = vscode;
                </script>
                <script nonce="${nonce}" src="${scriptUriWithCacheBust}"></script>
                <script nonce="${nonce}">
                    // Instantiate the Svelte 5 component
                    console.log('WorkflowRuns script loaded, checking for SvelteApp...');
                    console.log('typeof SvelteApp:', typeof SvelteApp);
                    console.log('typeof svelteMount:', typeof window.svelteMount);

                    // Use a small delay to ensure the IIFE has fully executed
                    setTimeout(() => {
                        try {
                            // Get the component and mount function
                            const Component = typeof SvelteApp !== 'undefined' ? SvelteApp : window.SvelteApp;
                            const mount = window.svelteMount;

                            if (Component && mount) {
                                console.log('Found WorkflowRuns component and mount function');

                                // Svelte 5: Use the mount() function
                                const target = document.getElementById('app');
                                console.log('Mounting Svelte 5 WorkflowRuns component with mount()...');

                                const instance = mount(Component, {
                                    target: target,
                                    props: {}
                                });

                                console.log('WorkflowRuns component mounted successfully');
                                // Notify host that webview is ready to receive initial data
                                vscode.postMessage({ type: 'webviewReady' });
                            } else {
                                console.error('SvelteApp or svelteMount is not defined.');
                                console.error('SvelteApp:', typeof Component);
                                console.error('svelteMount:', typeof mount);
                            }
                        } catch (error) {
                            console.error('Error mounting WorkflowRuns component:', error);
                            console.error('Error stack:', error.stack);
                        }
                    }, 10);
                </script>
            </body>
            </html>`;
  }

  /**
   * Normalize a branch name to a short form (e.g. refs/heads/main -> main).
   */
  private _normalizeBranch(branch: string | null | undefined): string {
    if (!branch) {
      return '';
    }

    const prefix = 'refs/heads/';
    if (branch.startsWith(prefix)) {
      return branch.slice(prefix.length);
    }

    return branch;
  }

  /**
   * Extract candidate inputs and optional branch information from an artifact JSON object.
   */
  private _extractInputsFromArtifactObject(obj: unknown): {
    inputs: Record<string, unknown>;
    branchFromArtifact?: string;
  } | null {
    if (!obj || typeof obj !== 'object') {
      return null;
    }

    const root = obj as Record<string, unknown>;
    const rootInputs = root.inputs;

    let inputs: Record<string, unknown>;
    if (rootInputs && typeof rootInputs === 'object') {
      inputs = rootInputs as Record<string, unknown>;
    } else {
      inputs = root;
    }

    const branchFromArtifact =
      typeof root.ref === 'string' ? this._normalizeBranch(root.ref) : undefined;

    return { inputs, branchFromArtifact };
  }

  /**
   * Convert an arbitrary input value to a string suitable for dispatch.
   */
  private _stringifyInputValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Filter and normalize recovered inputs based on the workflow's defined inputs.
   */
  private async _filterInputsForWorkflow(
    workflowFilename: string,
    rawInputs: Record<string, unknown>
  ): Promise<Record<string, string>> {
    const safeEntries = Object.entries(rawInputs ?? {});
    const result: Record<string, string> = {};

    try {
      const { getWorkflowDefinition } = await import('../utils/workflow-parser');
      const definition = await getWorkflowDefinition(workflowFilename);

      if (!definition?.inputs || definition.inputs.length === 0) {
        for (const [key, value] of safeEntries) {
          result[key] = this._stringifyInputValue(value);
        }
        return result;
      }

      const allowed = new Set(definition.inputs.map((input) => input.name));
      for (const [key, value] of safeEntries) {
        if (!allowed.has(key)) {
          continue;
        }
        result[key] = this._stringifyInputValue(value);
      }
      return result;
    } catch {
      // If anything goes wrong while reading the workflow definition,
      // fall back to stringifying all keys.
      for (const [key, value] of safeEntries) {
        result[key] = this._stringifyInputValue(value);
      }
      return result;
    }
  }

  /**
   * Get artifact pattern for a workflow
   * Priority: 1) Workflow config, 2) Default
   */
  private async _getArtifactPattern(workflowFilename: string): Promise<string> {
    // Priority 1: Check workflow-specific config
    const config = await Storage.getWorkflowConfig(workflowFilename);
    if (config?.artifactPattern) {
      return config.artifactPattern;
    }

    // Priority 2: Default pattern
    return '*parameter*';
  }

  /**
   * Create regex from artifact pattern
   * Supports both simple wildcards (my-params-*) and full regex patterns
   */
  private _createPatternRegex(pattern: string): RegExp {
    // Check if it's already a regex pattern (starts with ^ or contains regex special chars)
    if (pattern.startsWith('^') || pattern.includes('.*') || pattern.includes('\\')) {
      try {
        return new RegExp(pattern, 'i');
      } catch {
        // If invalid regex, fall back to wildcard pattern
        console.warn(`Invalid regex pattern: ${pattern}, falling back to wildcard`);
      }
    }

    // Convert simple wildcard / prefix pattern to regex
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    // If there's no explicit wildcard, treat the pattern as a prefix
    const hasWildcard = pattern.includes('*');
    const wildcardPattern = hasWildcard ? escaped : `${escaped}*`;

    // Replace * with .*
    const regexPattern = '^' + wildcardPattern.replace(/\*/g, '.*') + '$';
    return new RegExp(regexPattern, 'i');
  }

  /**
   * Get GitHub summary content for a workflow run.
   * Fetches job logs and parses summary content written to $GITHUB_STEP_SUMMARY.
   */
  private async _getGitHubSummary(data: { runId: number }) {
    const { runId } = data;

    try {
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig) {
        this._panel.webview.postMessage({
          type: 'getGitHubSummaryResponse',
          success: false,
          error: 'Repository not configured',
        });
        return;
      }

      // Get jobs for this run to fetch their summaries from logs
      const jobs = await getWorkflowRunJobs(repoConfig.owner, repoConfig.name, runId);

      // Fetch the GitHub summary by parsing job logs
      const result = await getGitHubSummaryFromLogs(repoConfig.owner, repoConfig.name, runId, jobs);

      this._panel.webview.postMessage({
        type: 'getGitHubSummaryResponse',
        success: result.success,
        data: {
          runId,
          markdownContent: result.markdownContent,
          htmlUrl: result.htmlUrl,
        },
        error: result.error,
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getGitHubSummaryResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch GitHub summary',
      });
    }
  }

  /**
   * Get GitHub summary content for a single job.
   * Fetches job logs and parses summary content written to $GITHUB_STEP_SUMMARY.
   */
  private async _getJobSummary(data: { jobId: number; jobName: string; runId?: number }) {
    const { jobId, jobName, runId } = data;

    try {
      const repoConfig = await getRepositoryConfig();
      if (!repoConfig) {
        this._panel.webview.postMessage({
          type: 'getJobSummaryResponse',
          success: false,
          data: { jobId }, // Include jobId so loading state can be cleared
          error: 'Repository not configured',
        });
        return;
      }

      // Fetch the job summary by parsing its logs
      const result = await getJobSummaryFromLogs(
        repoConfig.owner,
        repoConfig.name,
        jobId,
        jobName,
        runId
      );

      this._panel.webview.postMessage({
        type: 'getJobSummaryResponse',
        success: result.success,
        data: {
          jobId,
          jobName,
          markdownContent: result.markdownContent,
          htmlUrl: result.htmlUrl,
        },
        error: result.error,
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'getJobSummaryResponse',
        success: false,
        data: { jobId }, // Include jobId so loading state can be cleared
        error: error instanceof Error ? error.message : 'Failed to fetch job summary',
      });
    }
  }

  /**
   * Open GitHub summary content in a new editor tab.
   * Creates a webview panel with rendered HTML content (same as modal).
   */
  private async _openGitHubSummaryInTab(data: {
    runId: number;
    runName: string;
    markdownContent: string;
    htmlContent: string;
    htmlUrl?: string;
  }) {
    const { runId, runName, htmlContent, htmlUrl } = data;

    try {
      const title = `GitHub Summary - ${runName || `Run #${runId}`}`;

      // Create a new webview panel
      const panel = vscode.window.createWebviewPanel(
        'github-summary-tab',
        title,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [this._extensionUri],
        }
      );

      // Get the codicons CSS for the webview
      const codiconsUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(
          this._extensionUri,
          'node_modules',
          '@vscode/codicons',
          'dist',
          'codicon.css'
        )
      );

      // Set the HTML content
      panel.webview.html = this._getSummaryTabHtml(htmlContent, htmlUrl || '', codiconsUri);

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage((message) => {
        if (message.type === 'openExternalUrl' && message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
      });

      // Notify webview of success
      this._panel.webview.postMessage({
        type: 'openGitHubSummaryInTabResponse',
        success: true,
        data: { runId, fileName: title },
      });
    } catch (error) {
      this._panel.webview.postMessage({
        type: 'openGitHubSummaryInTabResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open summary in tab',
      });
    }
  }

  /**
   * Generate HTML for the summary tab webview.
   */
  private _getSummaryTabHtml(content: string, htmlUrl: string, codiconsUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet" />
  <title>GitHub Summary</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.6;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    .content {
      max-width: 900px;
      margin: 0 auto;
    }
    h1, h2, h3, h4 { margin-top: 1.2em; margin-bottom: 0.5em; }
    h1 { font-size: 1.5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.3em; }
    h2 { font-size: 1.3em; }
    h3 { font-size: 1.1em; }
    p { margin: 0.8em 0; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
    pre code { padding: 0; background: none; }
    ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
    li { margin: 0.3em 0; }
    hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 1.5em 0;
    }
    .job-section {
      margin: 16px 0;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      border-left: 3px solid var(--vscode-button-background);
      border-radius: 4px;
    }
    .footer {
      margin-top: 24px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .footer a { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="content">
    ${content}
    ${
      htmlUrl
        ? `<div class="footer">
        <a href="#" onclick="openUrl('${htmlUrl}')">View on GitHub</a>
      </div>`
        : ''
    }
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function openUrl(url) {
      vscode.postMessage({ type: 'openExternalUrl', url: url });
    }

    document.addEventListener('click', function(e) {
      const anchor = e.target.closest('a');
      if (anchor) {
        e.preventDefault();
        const url = anchor.dataset.href || anchor.getAttribute('href');
        if (url && url !== '#') {
          openUrl(url);
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
