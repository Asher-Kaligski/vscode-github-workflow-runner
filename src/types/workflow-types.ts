/**
 * Type definitions for GitHub Actions workflows and related entities
 */

/**
 * Supported workflow input types
 */
export type WorkflowInputType = 'string' | 'choice' | 'boolean' | 'number' | 'environment';

/**
 * Definition of a single workflow input
 */
export interface WorkflowInput {
  /** Input name/key */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Whether the input is required */
  required: boolean;
  /** Input type */
  type: WorkflowInputType;
  /** Default value */
  default?: string | number | boolean;
  /** Available options (for choice type) */
  options?: string[];
  /** Whether this input is detected as a file path parameter */
  isFilePath?: boolean;
  /** Whether file picker UI is enabled for this input */
  filePickerEnabled?: boolean;
}

/**
 * Complete workflow definition
 */
export interface WorkflowDefinition {
  /** Workflow name from YAML */
  name: string;
  /** Workflow filename */
  filename: string;
  /** Full file path */
  filepath: string;
  /** Workflow description (from run-name or name) */
  description?: string;
  /** Workflow inputs */
  inputs: WorkflowInput[];
  /** Whether workflow has workflow_dispatch trigger */
  hasWorkflowDispatch: boolean;
}

/**
 * Workflow dispatch request payload
 */
export interface WorkflowDispatchRequest {
  /** Branch/ref to run workflow on */
  ref: string;
  /** Input values */
  inputs: Record<string, string>;
}

/**
 * GitHub workflow run status
 */
export type WorkflowRunStatus = 'queued' | 'in_progress' | 'completed' | 'waiting';

/**
 * GitHub workflow run conclusion
 */
export type WorkflowRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | null;

/**
 * GitHub workflow run information
 */
export interface WorkflowRun {
  /** Run ID */
  id: number;
  /** Run number */
  run_number: number;
  /** Workflow name */
  name: string;
  /** Workflow ID */
  workflow_id: number;
  /** Workflow file path (e.g., ".github/workflows/build.yml@main") */
  path: string;
  /** Run status */
  status: WorkflowRunStatus;
  /** Run conclusion */
  conclusion: WorkflowRunConclusion;
  /** Branch/ref */
  head_branch: string;
  /** Commit SHA */
  head_sha: string;
  /** Actor who triggered the run */
  actor: {
    login: string;
    avatar_url: string;
  };
  /** Run URL */
  html_url: string;
  /** Created timestamp */
  created_at: string;
  /** Updated timestamp */
  updated_at: string;
  /** Run started timestamp */
  run_started_at?: string;
  /** Attempt number for this run (1 on first run, increments on reruns) */
  run_attempt?: number;
  /** Display title */
  display_title: string;
  /** Associated pull requests (if any) */
  pull_requests?: Array<{
    id: number;
    number: number;
    head: { ref: string };
  }>;
}

/**
 * Workflow run job information
 */
export interface WorkflowJob {
  /** Job ID */
  id: number;
  /** Job name */
  name: string;
  /** Job status */
  status: WorkflowRunStatus;
  /** Job conclusion */
  conclusion: WorkflowRunConclusion;
  /** Started timestamp */
  started_at: string;
  /** Completed timestamp */
  completed_at?: string;
  /** Workflow job key from YAML (e.g., "build", "test") - returned by GitHub API */
  workflow_job_key?: string;
  /** Job steps */
  steps?: Array<{
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
    number: number;
    started_at?: string;
    completed_at?: string;
  }>;
}

/**
 * Enhanced WorkflowJob with dependency information
 */
export interface WorkflowJobWithDependencies extends WorkflowJob {
  /** Job key identifier (from YAML job definition) */
  job_key?: string;
  /** Jobs this job depends on (from 'needs' keyword) */
  needs?: string[];
  /** Runner name if applicable */
  runner_name?: string;
  /** Matrix configuration if job is part of matrix */
  matrix?: Record<string, string>;
}

/**
 * Job step information for graph node
 */
export interface JobNodeStep {
  /** Step name */
  name: string;
  /** Step status */
  status: 'queued' | 'in_progress' | 'completed';
  /** Step conclusion */
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
  /** Step number/order */
  number: number;
  /** Started timestamp */
  startedAt?: string;
  /** Completed timestamp */
  completedAt?: string;
  /** Duration in milliseconds */
  duration?: number;
}

/**
 * Job node for graph visualization
 */
export interface JobGraphNode {
  /** Unique identifier (matches job key or generated ID) */
  id: string;
  /** Display name */
  name: string;
  /** Job ID from GitHub API (for linking to logs) */
  jobId?: number;
  /** Current status */
  status: WorkflowRunStatus;
  /** Conclusion if completed */
  conclusion: WorkflowRunConclusion;
  /** Dependencies (job IDs this job needs) */
  dependencies: string[];
  /** Dependents (job IDs that need this job) */
  dependents: string[];
  /** Graph layout position */
  position: { x: number; y: number };
  /** Node level in graph (0 = root, 1 = first level deps, etc.) */
  level: number;
  /** Is this job currently in progress */
  isActive?: boolean;
  /** Is this a matrix job group */
  isMatrix?: boolean;
  /** Matrix label if applicable (e.g., "ubuntu-latest, node-18") */
  matrixLabel?: string;
  /** Number of completed matrix jobs (for matrix groups) */
  matrixCompleted?: number;
  /** Total number of matrix jobs (for matrix groups) */
  matrixTotal?: number;
  /** Individual matrix jobs (for expandable display) */
  matrixJobs?: JobGraphNode[];
  /** Duration in milliseconds */
  duration?: number;
  /** Started timestamp */
  startedAt?: string;
  /** Completed timestamp */
  completedAt?: string;
  /** Job steps */
  steps?: JobNodeStep[];
}

/**
 * Dependency edge for graph visualization
 */
export interface JobGraphEdge {
  /** Source job ID */
  from: string;
  /** Target job ID */
  to: string;
  /** Edge type */
  type: 'dependency' | 'parallel';
}

/**
 * Complete job dependency graph
 */
export interface JobDependencyGraph {
  /** All job nodes */
  nodes: JobGraphNode[];
  /** All edges between nodes */
  edges: JobGraphEdge[];
  /** Maximum depth of graph (number of levels) */
  maxDepth: number;
  /** Total number of jobs */
  totalJobs: number;
  /** Current running job ID(s) */
  activeJobIds: string[];
  /** Nodes organized by level for layout */
  levels: JobGraphNode[][];
}

/**
 * Graph display mode based on available space
 */
export type GraphDisplayMode =
  | 'full' // All jobs visible
  | 'focused' // Previous → Current → Next only
  | 'minimal' // Current job only
  | 'button'; // Fallback to button/icon

/**
 * Job dependencies parsed from workflow YAML
 */
export interface WorkflowJobDefinition {
  /** Job key (identifier in YAML) */
  key: string;
  /** Job name (display name) */
  name?: string;
  /** Jobs this job depends on */
  needs?: string | string[];
  /** Matrix strategy if defined */
  matrix?: {
    include?: Record<string, unknown>[];
    exclude?: Record<string, unknown>[];
  } & Record<string, unknown[]>;
  /** Reusable workflow reference (if this job calls another workflow) */
  uses?: string;
}

/**
 * Saved workflow template
 */
export interface WorkflowTemplate {
  /** Template ID */
  id: string;
  /** Template name */
  name: string;
  /** Workflow filename */
  workflowFilename: string;
  /** Saved input values */
  inputs: Record<string, string>;
  /** Branch */
  branch: string;
  /** Created timestamp */
  createdAt: string;
  /** Last used timestamp */
  lastUsedAt?: string;
}

/**
 * Workflow-specific configuration
 */
export interface WorkflowConfig {
  /** Workflow filename */
  workflowFilename: string;
  /** Default artifact name pattern for parameter recovery */
  artifactPattern?: string;
}

/**
 * Workflow execution history entry
 */
export interface WorkflowHistoryEntry {
  /** History entry ID */
  id: string;
  /** Workflow filename */
  workflowFilename: string;
  /** Workflow name */
  workflowName: string;
  /** Input values used */
  inputs: Record<string, string>;
  /** Branch used */
  branch: string;
  /** Dispatch timestamp */
  dispatchedAt: string;
  /** Run ID (if available) */
  runId?: number;
  /** Run URL (if available) */
  runUrl?: string;
}

/**
 * GitHub API token information
 */
export interface GitHubTokenInfo {
  /** Token value */
  token: string;
  /** GitHub username */
  username: string;
  /** Token scopes */
  scopes: string[];
  /** Whether token has workflow scope */
  hasWorkflowScope: boolean;
}

/**
 * Git repository information
 */
export interface GitRepositoryInfo {
  /** Repository owner */
  owner: string;
  /** Repository name */
  name: string;
  /** Current branch */
  currentBranch?: string;
  /** Recent branches */
  recentBranches: string[];
  /** Repository root path */
  rootPath: string;
}

/**
 * GitHub user information
 */
export interface GitHubUserInfo {
  /** GitHub username/login */
  login: string;
  /** User's display name */
  name?: string;
  /** Avatar URL */
  avatar_url?: string;
  /** User's email */
  email?: string;
  /** User ID */
  id: number;
}

/**
 * Repository configuration with auto-detection support
 */
export interface RepositoryConfig {
  /** Repository owner (manual override or auto-detected) */
  owner: string;
  /** Repository name (manual override or auto-detected) */
  name: string;
  /** Whether values are manually set (true) or auto-detected (false) */
  isManual: boolean;
  /** Auto-detected repository info (if available) */
  autoDetected?: {
    owner: string;
    name: string;
  };
}

/**
 * Extension configuration
 */
export interface ExtensionConfig {
  repository: {
    owner: string;
    name: string;
  };
  defaultBranch: string;
  monitoring: {
    autoRefresh: boolean;
    refreshInterval: number;
    maxRuns: number;
  };
  ui: {
    confirmBeforeDispatch: boolean;
    rememberLastWorkflow: boolean;
  };
  git: {
    autoDetectBranch: boolean;
  };
  notifications: {
    enabled: boolean;
    onSuccess: boolean;
    onFailure: boolean;
  };
  workflows: {
    excludePatterns: string[];
  };
  logs?: {
    debug: boolean;
  };
}

/**
 * Workflow favorite for quick access
 */
export interface WorkflowFavorite {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Display name of the workflow */
  workflowName: string;
  /** Workflow file name (e.g., "deploy.yml") */
  workflowFilename: string;
  /** Repository information */
  repository: {
    owner: string;
    name: string;
  };
  /** Pre-filled input values */
  savedInputs?: Record<string, string>;
  /** Saved branch name */
  branch?: string;
  /** Unix timestamp when favorite was added */
  addedAt: number;
}

/**
 * Cancellation state for workflow runs
 */
export interface CancellationState {
  /** Set of run IDs currently being cancelled */
  cancellingRuns: Set<number>;
  /** Set of run IDs that have been successfully cancelled */
  cancelledRuns: Set<number>;
  /** Map of run ID to error message for failed cancellations */
  failedCancellations: Map<number, string>;
}

/**
 * Workflow runs filter criteria
 */
export interface WorkflowRunsFilter {
  /** Filter by workflow run actor */
  actor?: 'me' | 'all' | string;
  /** Filter by branch name */
  branch?: string;
  /** Filter by run status */
  status?: WorkflowRunStatus | 'success' | 'failure' | 'cancelled';
  /** Client-side search query */
  searchQuery?: string;
}

/**
 * Job status type
 */
export type JobStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Job conclusion type
 */
export type JobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

/**
 * Workflow run step information
 */
export interface WorkflowRunStep {
  /** Step name */
  name: string;
  /** Step status */
  status: JobStatus;
  /** Step conclusion */
  conclusion?: JobConclusion;
  /** Step number */
  number: number;
}

/**
 * Workflow run job information (enhanced)
 */
export interface WorkflowRunJob {
  /** Job ID */
  id: number;
  /** Job name */
  name: string;
  /** Job status */
  status: JobStatus;
  /** Job conclusion */
  conclusion?: JobConclusion;
  /** Started timestamp */
  started_at?: string;
  /** Completed timestamp */
  completed_at?: string;
  /** Job steps */
  steps?: WorkflowRunStep[];
}

/**
 * File picker state for file path parameters
 */
export interface FilePickerState {
  /** Name of the workflow input parameter */
  parameterName: string;
  /** Currently selected file path */
  selectedPath?: string;
  /** Content of selected file (if loaded) */
  fileContent?: string;
  /** Size of selected file in bytes */
  fileSize?: number;
  /** Whether file is being loaded */
  isLoading: boolean;
  /** Error message if file loading failed */
  error?: string;
}

/**
 * Message types for webview communication
 */
export type WebviewMessageType =
  | 'authenticate'
  | 'checkAuth'
  | 'signOut'
  | 'getUserInfo'
  | 'getRepositoryConfig'
  | 'setRepositoryConfig'
  | 'resetRepositoryConfig'
  | 'webviewReady'
  | 'getWorkflows'
  | 'getWorkflowSchema'
  | 'getWorkflowId'
  | 'getWorkflowIdResponse'
  | 'dispatchWorkflow'
  | 'getWorkflowRuns'
  | 'refreshWorkflowRuns'
  | 'updateWorkflowLoadLimit'
  | 'updateWorkflowRunsTotalLimits'
  | 'updateDateFilter'
  | 'updateAutoRefresh'
  | 'updateNotificationSettings'
  | 'openWorkflowRun'
  | 'openWorkflowRuns'
  | 'cancelWorkflowRun'
  | 'cancelWorkflowRunResponse'
  | 'rerunWorkflowRun'
  | 'rerunFailedJobs'
  | 'getCurrentBranch'
  | 'getDefaultBranch'
  | 'checkBranchOnRemote'
  | 'getRecentBranches'
  | 'saveTemplate'
  | 'getTemplates'
  | 'deleteTemplate'
  | 'updateTemplate'
  | 'getHistory'
  | 'getWorkflowConfig'
  | 'setWorkflowConfig'
  | 'exportPreset'
  | 'importPreset'
  | 'getStorageInfo'
  | 'storageInfo'
  | 'addFavorite'
  | 'addFavoriteResponse'
  | 'removeFavorite'
  | 'removeFavoriteResponse'
  | 'updateFavorite'
  | 'updateFavoriteResponse'
  | 'getFavorites'
  | 'getFavoritesResponse'
  | 'dispatchFavorite'
  | 'dispatchFavoriteResponse'
  | 'selectFile'
  | 'selectFileResponse'
  | 'readFileContent'
  | 'readFileContentResponse'
  | 'validateFilePath'
  | 'validateFilePathResponse'
  | 'getWorkflowRunJobs'
  | 'getWorkflowRunJobsResponse'
  | 'viewWorkflowRunLogs'
  | 'viewWorkflowRunLogsResponse'
  | 'downloadWorkflowArtifacts'
  | 'downloadWorkflowArtifactsResponse'
  | 'rerunWorkflow'
  | 'rerunWorkflowResponse'
  | 'runLastWorkflow'
  | 'openSidebarWithWorkflow'
  | 'setWorkflowFilter'
  | 'setActorFilter'
  | 'setShowBotRuns'
  | 'getCurrentPR'
  | 'getCurrentPRResponse'
  | 'openSettings'
  | 'loadMoreRuns'
  | 'viewJobLogs'
  | 'viewJobLogsResponse'
  | 'viewJobLogsInteractive'
  | 'viewJobLogsInteractiveResponse'
  | 'compareJobLogs'
  | 'compareJobLogsResponse'
  | 'compareStepLogs'
  | 'compareStepLogsResponse'
  | 'checkJobLogsAvailability'
  | 'checkJobLogsAvailabilityResponse'
  | 'getJobDetails'
  | 'getJobDetailsResponse'
  | 'viewStepLogs'
  | 'viewStepLogsResponse'
  | 'getWorkflowRunArtifacts'
  | 'getWorkflowRunArtifactsResponse'
  | 'downloadArtifact'
  | 'downloadArtifactResponse'
  | 'getWorkflowRunSummary'
  | 'getWorkflowRunSummaryResponse'
  | 'getGitHubSummary'
  | 'getGitHubSummaryResponse'
  | 'getJobSummary'
  | 'getJobSummaryResponse'
  | 'openGitHubSummaryInTab'
  | 'openGitHubSummaryInTabResponse'
  | 'openInBrowser'
  | 'getRepositoryFavorites'
  | 'getRepositoryFavoritesResponse'
  | 'saveRepositoryFavorites'
  | 'saveRepositoryFavoritesResponse'
  | 'promptRerunWorkflow'
  | 'requestCancelWorkflowRun'
  | 'prefillDispatch'
  | 'openWorkflowFile'
  | 'getMarkedWorkflows'
  | 'getMarkedWorkflowsResponse'
  | 'toggleWorkflowMarked'
  | 'toggleWorkflowMarkedResponse'
  | 'getWatchedRuns'
  | 'getWatchedRunsResponse'
  | 'toggleRunWatch'
  | 'toggleRunWatchResponse'
  | 'unwatchAllRuns'
  | 'unwatchAllRunsResponse'
  | 'getRunParameters'
  | 'getRunParametersResponse'
  | 'progressiveFetchRuns'
  | 'progressiveFetchRunsResponse'
  | 'backgroundRefreshWatchedRuns'
  | 'backgroundRefreshWatchedRunsResponse'
  | 'backgroundRefreshAllRuns'
  | 'backgroundRefreshAllRunsResponse'
  | 'stopAutoRefresh'
  | 'getFilterState'
  | 'filterStateResponse'
  | 'clearFilters'
  | 'highlightRun'
  | 'confirmDispatch'
  | 'confirmDispatchResult'
  | 'reloadExtensionData'
  | 'reloadExtensionDataResponse'
  | 'gitContextMismatch'
  | 'openExternalUrl'
  | 'getJobDependencies'
  | 'getJobDependenciesResponse'
  | 'cancelled'
  | 'error'
  | 'success'
  | 'info';

/**
 * Webview message structure
 */
export interface WebviewMessage {
  type: WebviewMessageType;
  data?: unknown;
}

/**
 * Response message from extension to webview
 */
export interface WebviewResponse<T = unknown> {
  type: WebviewMessageType;
  success: boolean;
  data?: T;
  error?: string;
}
