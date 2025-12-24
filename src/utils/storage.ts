/**
 * Storage utilities for workflow templates and history
 */
import * as vscode from 'vscode';
import type {
  WorkflowTemplate,
  WorkflowHistoryEntry,
  WorkflowConfig,
} from '../types/workflow-types';

const TEMPLATES_KEY = 'workflowTemplates';
const HISTORY_KEY = 'workflowHistory';
const LAST_WORKFLOW_KEY = 'lastWorkflow';
const WORKFLOW_CONFIGS_KEY = 'workflowConfigs';
const MARKED_WORKFLOWS_KEY = 'markedWorkflows';
const WATCHED_RUNS_KEY = 'watchedRuns';
const WORKFLOW_RUNS_PANEL_SETTINGS_KEY = 'workflowRunsPanelSettings';
const GIT_CONTEXT_KEY = 'lastValidatedGitContext';
const RATE_LIMIT_TRACKER_KEY = 'rateLimitTracker';
const MAX_HISTORY_ENTRIES = 100;
const MAX_WATCHED_RUNS_PER_REPO = 20;

/**
 * Snapshot of the Git context at a point in time.
 * Used to track and validate repository/branch changes.
 */
export interface GitContextSnapshot {
  owner: string;
  repo: string;
  branch: string | null;
  validatedAt: string;
}

/**
 * Persisted rate limit information for tracking API usage across sessions.
 * Note: This is stored for reference but NOT loaded on initial panel display.
 * The panel shows "Unknown" until real API responses provide actual values.
 */
export interface RateLimitTracker {
  /** Number of remaining API requests allowed */
  remaining: number;
  /** Total API request limit (usually 5000 for authenticated users) */
  limit: number;
  /** Unix timestamp (seconds) when the rate limit will reset */
  resetTimestamp: number;
  /** ISO timestamp when this information was last updated */
  lastUpdatedAt: string;
}

type WorkflowRunsPanelSettings = {
  workflowLoadLimit?: number;
  autoRefreshSeconds?: number;
  dateFilterFrom?: string | null;
  dateFilterTo?: string | null;
  /**
   * Maximum total runs to fetch when no date filter is active (on-open behaviour).
   */
  nonDateMaxTotalRuns?: number;
  /**
   * Maximum total runs to fetch when a date range filter is active.
   */
  dateFilterMaxTotalRuns?: number;
  /**
   * Show toast notifications in the top-right corner when workflows start, complete, or fail.
   */
  showWorkflowToastNotifications?: boolean;
  /**
   * Show inline job progress for running workflows.
   */
  showProgressIndicators?: boolean;
  /**
   * Enable adaptive refresh: speeds up polling when in-progress/queued runs exist.
   * When enabled, uses adaptiveFastRefreshSeconds when active runs are detected,
   * otherwise falls back to autoRefreshSeconds. Defaults to true.
   */
  adaptiveRefreshEnabled?: boolean;
  /**
   * Fast refresh interval (in seconds) used when adaptive refresh is enabled
   * and active runs are detected. Valid range: 5-10 seconds. Defaults to 10.
   */
  adaptiveFastRefreshSeconds?: number;
  /**
   * Whether automatic rate limit protection is enabled.
   * When enabled, auto-refresh will be throttled when API usage reaches the threshold.
   */
  rateLimitProtectionEnabled?: boolean;
  /**
   * Percentage threshold (50-90) at which rate limit protection activates.
   * Defaults to 90%.
   */
  rateLimitThreshold?: number;
};

/**
 * Map of repository key (owner/name) to array of watched run IDs
 */
type WatchedRunsMap = Record<string, number[]>;

export class Storage {
  private static context: vscode.ExtensionContext;

  /**
   * Initialize storage with extension context
   */
  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Save a workflow template
   */
  static async saveTemplate(
    template: Omit<WorkflowTemplate, 'id' | 'createdAt'>
  ): Promise<WorkflowTemplate> {
    const templates = await this.getTemplates();

    const newTemplate: WorkflowTemplate = {
      ...template,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
    };

    templates.push(newTemplate);
    await this.context.globalState.update(TEMPLATES_KEY, templates);

    return newTemplate;
  }

  /**
   * Get all workflow templates
   */
  static async getTemplates(): Promise<WorkflowTemplate[]> {
    return this.context.globalState.get<WorkflowTemplate[]>(TEMPLATES_KEY, []);
  }

  /**
   * Get templates for a specific workflow
   */
  static async getTemplatesForWorkflow(workflowFilename: string): Promise<WorkflowTemplate[]> {
    const templates = await this.getTemplates();
    return templates.filter((t) => t.workflowFilename === workflowFilename);
  }

  /**
   * Update a workflow template
   */
  static async updateTemplate(id: string, updates: Partial<WorkflowTemplate>): Promise<boolean> {
    const templates = await this.getTemplates();
    const index = templates.findIndex((t) => t.id === id);

    if (index === -1) {
      return false;
    }

    templates[index] = { ...templates[index], ...updates };
    await this.context.globalState.update(TEMPLATES_KEY, templates);

    return true;
  }

  /**
   * Delete a workflow template
   */
  static async deleteTemplate(id: string): Promise<boolean> {
    const templates = await this.getTemplates();
    const filtered = templates.filter((t) => t.id !== id);

    if (filtered.length === templates.length) {
      return false;
    }

    await this.context.globalState.update(TEMPLATES_KEY, filtered);
    return true;
  }

  /**
   * Update template last used timestamp
   */
  static async updateTemplateLastUsed(id: string): Promise<void> {
    await this.updateTemplate(id, {
      lastUsedAt: new Date().toISOString(),
    });
  }

  /**
   * Add workflow execution to history
   */
  static async addToHistory(
    entry: Omit<WorkflowHistoryEntry, 'id' | 'dispatchedAt'>
  ): Promise<void> {
    const history = await this.getHistory();

    const newEntry: WorkflowHistoryEntry = {
      ...entry,
      id: this.generateId(),
      dispatchedAt: new Date().toISOString(),
    };

    // Add to beginning of array
    history.unshift(newEntry);

    // Limit history size
    if (history.length > MAX_HISTORY_ENTRIES) {
      history.splice(MAX_HISTORY_ENTRIES);
    }

    await this.context.globalState.update(HISTORY_KEY, history);
  }

  /**
   * Get workflow execution history
   */
  static async getHistory(limit?: number): Promise<WorkflowHistoryEntry[]> {
    const history = this.context.globalState.get<WorkflowHistoryEntry[]>(HISTORY_KEY, []);
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * Get history for a specific workflow
   */
  static async getHistoryForWorkflow(
    workflowFilename: string,
    limit?: number
  ): Promise<WorkflowHistoryEntry[]> {
    const history = await this.getHistory();
    const filtered = history.filter((h) => h.workflowFilename === workflowFilename);
    return limit ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Clear workflow history
   */
  static async clearHistory(): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, []);
  }

  /**
   * Save last used workflow
   */
  static async saveLastWorkflow(data: {
    workflowFilename: string;
    inputs: Record<string, string>;
    branch: string;
  }): Promise<void> {
    await this.context.globalState.update(LAST_WORKFLOW_KEY, data);
  }

  /**
   * Get last used workflow
   */
  static async getLastWorkflow(): Promise<{
    workflowFilename: string;
    inputs: Record<string, string>;
    branch: string;
  } | null> {
    return this.context.globalState.get(LAST_WORKFLOW_KEY, null);
  }

  /**
   * Clear last used workflow
   */
  static async clearLastWorkflow(): Promise<void> {
    await this.context.globalState.update(LAST_WORKFLOW_KEY, undefined);
  }

  /**
   * Generate unique ID
   */
  private static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Export all data (for backup/migration)
   */
  static async exportData(): Promise<{
    templates: WorkflowTemplate[];
    history: WorkflowHistoryEntry[];
    lastWorkflow: any;
  }> {
    return {
      templates: await this.getTemplates(),
      history: await this.getHistory(),
      lastWorkflow: await this.getLastWorkflow(),
    };
  }

  /**
   * Import data (for backup/migration)
   */
  static async importData(data: {
    templates?: WorkflowTemplate[];
    history?: WorkflowHistoryEntry[];
    lastWorkflow?: any;
  }): Promise<void> {
    if (data.templates) {
      await this.context.globalState.update(TEMPLATES_KEY, data.templates);
    }
    if (data.history) {
      await this.context.globalState.update(HISTORY_KEY, data.history);
    }
    if (data.lastWorkflow) {
      await this.context.globalState.update(LAST_WORKFLOW_KEY, data.lastWorkflow);
    }
  }

  /**
   * Clear all stored data
   */
  static async clearAll(): Promise<void> {
    await this.context.globalState.update(TEMPLATES_KEY, undefined);
    await this.context.globalState.update(HISTORY_KEY, undefined);
    await this.context.globalState.update(LAST_WORKFLOW_KEY, undefined);
  }

  /**
   * Get storage statistics
   */
  static async getStats(): Promise<{
    templatesCount: number;
    historyCount: number;
    hasLastWorkflow: boolean;
  }> {
    const templates = await this.getTemplates();
    const history = await this.getHistory();
    const lastWorkflow = await this.getLastWorkflow();

    return {
      templatesCount: templates.length,
      historyCount: history.length,
      hasLastWorkflow: lastWorkflow !== null,
    };
  }

  /**
   * Get workflow-specific configuration
   */
  static async getWorkflowConfig(workflowFilename: string): Promise<WorkflowConfig | null> {
    const configs = this.context.globalState.get<WorkflowConfig[]>(WORKFLOW_CONFIGS_KEY, []);
    return configs.find((c) => c.workflowFilename === workflowFilename) || null;
  }

  /**
   * Set workflow-specific configuration
   */
  static async setWorkflowConfig(config: WorkflowConfig): Promise<void> {
    const configs = this.context.globalState.get<WorkflowConfig[]>(WORKFLOW_CONFIGS_KEY, []);
    const index = configs.findIndex((c) => c.workflowFilename === config.workflowFilename);

    if (index !== -1) {
      configs[index] = config;
    } else {
      configs.push(config);
    }

    await this.context.globalState.update(WORKFLOW_CONFIGS_KEY, configs);
  }

  /**
   * Get all workflow configurations
   */
  static async getAllWorkflowConfigs(): Promise<WorkflowConfig[]> {
    return this.context.globalState.get<WorkflowConfig[]>(WORKFLOW_CONFIGS_KEY, []);
  }

  /**
   * Export a single template to JSON format
   */
  static async exportTemplate(id: string): Promise<string | null> {
    const templates = await this.getTemplates();
    const template = templates.find((t) => t.id === id);

    if (!template) {
      return null;
    }

    const exportData = {
      version: '1.0',
      workflowFilename: template.workflowFilename,
      presetName: template.name,
      createdAt: template.createdAt,
      description: `Preset for ${template.workflowFilename}`,
      branch: template.branch,
      inputs: template.inputs,
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import a template from JSON format
   */
  static async importTemplate(jsonContent: string): Promise<WorkflowTemplate> {
    const data = JSON.parse(jsonContent);

    // Validate required fields
    if (!data.workflowFilename || !data.presetName || !data.inputs) {
      throw new Error('Invalid preset file: missing required fields');
    }

    // Check version compatibility
    if (data.version !== '1.0') {
      throw new Error(`Unsupported preset version: ${data.version}`);
    }

    // Create template from imported data
    const template: Omit<WorkflowTemplate, 'id' | 'createdAt'> = {
      name: data.presetName,
      workflowFilename: data.workflowFilename,
      inputs: data.inputs,
      branch: data.branch || 'main',
    };

    return await this.saveTemplate(template);
  }

  /**
   * Get storage location information
   */
  static getStorageInfo(): string {
    return 'Presets are stored in VS Code globalState (internal storage)';
  }

  /**
   * Get marked/pinned workflows
   */
  static async getMarkedWorkflows(): Promise<string[]> {
    return this.context.globalState.get<string[]>(MARKED_WORKFLOWS_KEY, []);
  }

  /**
   * Mark/pin a workflow by its path
   */
  static async markWorkflow(workflowPath: string): Promise<void> {
    const marked = await this.getMarkedWorkflows();
    if (!marked.includes(workflowPath)) {
      marked.push(workflowPath);
      await this.context.globalState.update(MARKED_WORKFLOWS_KEY, marked);
    }
  }

  /**
   * Unmark/unpin a workflow by its path
   */
  static async unmarkWorkflow(workflowPath: string): Promise<void> {
    const marked = await this.getMarkedWorkflows();
    const filtered = marked.filter((path) => path !== workflowPath);
    await this.context.globalState.update(MARKED_WORKFLOWS_KEY, filtered);
  }

  /**
   * Check if a workflow is marked/pinned
   */
  static async isWorkflowMarked(workflowPath: string): Promise<boolean> {
    const marked = await this.getMarkedWorkflows();
    return marked.includes(workflowPath);
  }

  /**
   * Toggle marked status of a workflow
   */
  static async toggleWorkflowMarked(workflowPath: string): Promise<boolean> {
    const isMarked = await this.isWorkflowMarked(workflowPath);
    if (isMarked) {
      await this.unmarkWorkflow(workflowPath);
      return false;
    } else {
      await this.markWorkflow(workflowPath);
      return true;
    }
  }

  /**
   * Get watched workflow runs (legacy - returns all watched runs across all repos)
   * @deprecated Use getWatchedRunsForRepo instead
   */
  static async getWatchedRuns(): Promise<number[]> {
    return this.context.globalState.get<number[]>(WATCHED_RUNS_KEY, []);
  }

  /**
   * Get persisted settings for the Workflow Runs panel
   */
  static async getWorkflowRunsPanelSettings(): Promise<WorkflowRunsPanelSettings> {
    return this.context.globalState.get<WorkflowRunsPanelSettings>(
      WORKFLOW_RUNS_PANEL_SETTINGS_KEY,
      {}
    );
  }

  /**
   * Update persisted settings for the Workflow Runs panel
   */
  static async updateWorkflowRunsPanelSettings(
    updates: Partial<WorkflowRunsPanelSettings>
  ): Promise<void> {
    const existing = await this.getWorkflowRunsPanelSettings();
    const next: WorkflowRunsPanelSettings = {
      ...existing,
      ...updates,
    };
    await this.context.globalState.update(WORKFLOW_RUNS_PANEL_SETTINGS_KEY, next);
  }

  /**
   * Get the storage key for a repository
   */
  private static getRepoKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  /**
   * Get all watched runs organized by repository.
   *
   * This method is resilient to legacy data formats where WATCHED_RUNS_KEY was
   * stored as a plain number[] instead of the current per-repository map
   * (Record<string, number[]>). If we detect a non-object/array value, we
   * treat it as empty to avoid corrupting the map and to ensure that newly
   * saved runs are persisted correctly.
   */
  private static async getWatchedRunsMap(): Promise<WatchedRunsMap> {
    const raw = this.context.globalState.get<unknown>(WATCHED_RUNS_KEY, {});

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      // Legacy or invalid shape (e.g. an array of run IDs). Treat as empty
      // map so that subsequent writes use the correct per-repo structure.
      console.log(
        '[Storage] getWatchedRunsMap: migrating legacy value to empty map:',
        JSON.stringify(raw)
      );
      return {};
    }

    const map = raw as WatchedRunsMap;
    console.log('[Storage] getWatchedRunsMap:', JSON.stringify(map));
    return map;
  }

  /**
   * Save the watched runs map
   */
  private static async saveWatchedRunsMap(map: WatchedRunsMap): Promise<void> {
    console.log('[Storage] saveWatchedRunsMap:', JSON.stringify(map));
    await this.context.globalState.update(WATCHED_RUNS_KEY, map);
  }

  /**
   * Get watched workflow runs for a specific repository
   */
  static async getWatchedRunsForRepo(owner: string, repo: string): Promise<number[]> {
    const map = await this.getWatchedRunsMap();
    const key = this.getRepoKey(owner, repo);
    const runs = map[key] || [];
    console.log(`[Storage] getWatchedRunsForRepo(${key}):`, runs);
    return runs;
  }

  /**
   * Watch a workflow run by its ID for a specific repository
   * Returns an error message if the limit is reached, null otherwise
   */
  static async watchRun(runId: number, owner: string, repo: string): Promise<string | null> {
    const map = await this.getWatchedRunsMap();
    const key = this.getRepoKey(owner, repo);
    const watched = map[key] || [];

    console.log(`[Storage] watchRun(${key}, ${runId}): Current count: ${watched.length}`);

    if (watched.includes(runId)) {
      console.log(`[Storage] watchRun(${key}, ${runId}): Already watched`);
      return null; // Already watched
    }

    if (watched.length >= MAX_WATCHED_RUNS_PER_REPO) {
      console.log(
        `[Storage] watchRun(${key}, ${runId}): Limit reached (${MAX_WATCHED_RUNS_PER_REPO})`
      );
      return `You have reached the maximum of ${MAX_WATCHED_RUNS_PER_REPO} watched runs for this repository. Please remove older watched runs to add new ones.`;
    }

    watched.push(runId);
    map[key] = watched;
    await this.saveWatchedRunsMap(map);
    console.log(
      `[Storage] watchRun(${key}, ${runId}): Successfully added. New count: ${watched.length}`
    );
    return null;
  }

  /**
   * Unwatch a workflow run by its ID for a specific repository
   */
  static async unwatchRun(runId: number, owner: string, repo: string): Promise<void> {
    const map = await this.getWatchedRunsMap();
    const key = this.getRepoKey(owner, repo);
    const watched = map[key] || [];
    const filtered = watched.filter((id) => id !== runId);

    console.log(
      `[Storage] unwatchRun(${key}, ${runId}): Before: ${watched.length}, After: ${filtered.length}`
    );

    if (filtered.length === 0) {
      delete map[key];
      console.log(
        `[Storage] unwatchRun(${key}, ${runId}): Removed repository key (no more watched runs)`
      );
    } else {
      map[key] = filtered;
    }

    await this.saveWatchedRunsMap(map);
  }

  /**
   * Check if a workflow run is watched for a specific repository
   */
  static async isRunWatched(runId: number, owner: string, repo: string): Promise<boolean> {
    const watched = await this.getWatchedRunsForRepo(owner, repo);
    return watched.includes(runId);
  }

  /**
   * Toggle watched status of a workflow run for a specific repository
   * Returns { isWatched: boolean, error?: string }
   */
  static async toggleRunWatch(
    runId: number,
    owner: string,
    repo: string
  ): Promise<{ isWatched: boolean; error?: string }> {
    const isWatched = await this.isRunWatched(runId, owner, repo);
    if (isWatched) {
      await this.unwatchRun(runId, owner, repo);
      return { isWatched: false };
    } else {
      const error = await this.watchRun(runId, owner, repo);
      if (error) {
        return { isWatched: false, error };
      }
      return { isWatched: true };
    }
  }

  /**
   * Unwatch all workflow runs for a specific repository
   */
  static async clearWatchedRunsForRepo(owner: string, repo: string): Promise<void> {
    const map = await this.getWatchedRunsMap();
    const key = this.getRepoKey(owner, repo);
    delete map[key];
    await this.saveWatchedRunsMap(map);
  }

  /**
   * Unwatch all workflow runs across all repositories
   */
  static async clearWatchedRuns(): Promise<void> {
    await this.context.globalState.update(WATCHED_RUNS_KEY, {});
  }

  /**
   * Get the count of watched runs for a specific repository
   */
  static async getWatchedRunsCount(owner: string, repo: string): Promise<number> {
    const watched = await this.getWatchedRunsForRepo(owner, repo);
    return watched.length;
  }

  /**
   * Get the maximum number of watched runs allowed per repository
   */
  static getMaxWatchedRunsPerRepo(): number {
    return MAX_WATCHED_RUNS_PER_REPO;
  }

  // ========================================================================
  // Git Context Validation Methods
  // ========================================================================

  /**
   * Get the last validated Git context (repository/branch).
   * Returns null if no context has been validated yet.
   */
  static async getLastValidatedGitContext(): Promise<GitContextSnapshot | null> {
    return this.context.globalState.get<GitContextSnapshot | null>(GIT_CONTEXT_KEY, null);
  }

  /**
   * Set the last validated Git context (repository/branch).
   * Call this when the user reloads extension data.
   */
  static async setLastValidatedGitContext(snapshot: GitContextSnapshot): Promise<void> {
    await this.context.globalState.update(GIT_CONTEXT_KEY, snapshot);
  }

  /**
   * Clear the last validated Git context.
   * Call this when no Git repository is detected.
   */
  static async clearLastValidatedGitContext(): Promise<void> {
    await this.context.globalState.update(GIT_CONTEXT_KEY, null);
  }

  // ========================================================================
  // Rate Limit Tracking Methods
  // ========================================================================

  /**
   * Get the persisted rate limit information.
   * Returns null if no rate limit info has been recorded yet.
   * Note: This is for reference/logging purposes. The panel UI does NOT
   * load this on startup - it shows "Unknown" until real API responses arrive.
   */
  static async getRateLimitTracker(): Promise<RateLimitTracker | null> {
    const tracker = this.context.globalState.get<RateLimitTracker | null>(
      RATE_LIMIT_TRACKER_KEY,
      null
    );

    // Check if the stored data is stale (reset time has passed)
    if (tracker && tracker.resetTimestamp) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= tracker.resetTimestamp) {
        // Rate limit has reset, return null to indicate unknown
        console.log('[Storage] Rate limit has reset, clearing stale tracker');
        return null;
      }
    }

    return tracker;
  }

  /**
   * Update the persisted rate limit information.
   * Call this after receiving API responses with rate limit headers.
   */
  static async updateRateLimitTracker(data: {
    remaining: number;
    limit: number;
    resetTimestamp: number;
  }): Promise<void> {
    const tracker: RateLimitTracker = {
      remaining: data.remaining,
      limit: data.limit,
      resetTimestamp: data.resetTimestamp,
      lastUpdatedAt: new Date().toISOString(),
    };

    console.log('[Storage] Updating rate limit tracker:', tracker);
    await this.context.globalState.update(RATE_LIMIT_TRACKER_KEY, tracker);
  }

  /**
   * Clear the persisted rate limit information.
   */
  static async clearRateLimitTracker(): Promise<void> {
    await this.context.globalState.update(RATE_LIMIT_TRACKER_KEY, null);
  }
}
