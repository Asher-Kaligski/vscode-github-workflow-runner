/**
 * Message Recovery Utilities
 *
 * Provides utilities for recovering from stuck states in webview message handling.
 * This module contains the logic for determining error responses and detecting stuck states.
 */

/**
 * Mapping of request message types to their expected response types.
 * Used to send error responses when message handling fails.
 */
export const MESSAGE_RESPONSE_TYPES: Record<string, string> = {
  getWorkflowRuns: 'getWorkflowRuns',
  getWorkflows: 'getWorkflows',
  getWorkflowId: 'getWorkflowIdResponse',
  getUserInfo: 'getUserInfo',
  loadMoreRuns: 'loadMoreRuns',
  progressiveFetchRuns: 'progressiveFetchRunsResponse',
  getWorkflowRunJobs: 'getWorkflowRunJobs',
  getJobDependencies: 'getJobDependenciesResponse',
  cancelWorkflowRun: 'cancelWorkflowRunResponse',
  rerunWorkflow: 'rerunWorkflowResponse',
};

/**
 * Default timeout for workflow fetch operations (in milliseconds).
 * After this duration, the UI should recover from stuck loading states.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/**
 * Threshold for detecting stuck loading states (in milliseconds).
 * If loading has been active for longer than this, consider it stuck.
 */
export const STUCK_LOADING_THRESHOLD_MS = 30000;

/**
 * Gets the response type for a given request message type.
 * Returns undefined if the message type doesn't expect a response.
 *
 * @param messageType - The request message type
 * @returns The response message type, or undefined if no response expected
 */
export function getResponseTypeForMessage(messageType: string): string | undefined {
  return MESSAGE_RESPONSE_TYPES[messageType];
}

/**
 * Creates an error response message for a failed request.
 *
 * @param responseType - The response message type
 * @param error - The error that occurred
 * @returns The error response message object
 */
export function createErrorResponse(
  responseType: string,
  error: Error | unknown
): { type: string; success: false; error: string } {
  return {
    type: responseType,
    success: false,
    error: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
  };
}

/**
 * Checks if a loading state is considered "stuck" based on duration.
 *
 * @param loadingStartTime - Timestamp when loading started (null if not loading)
 * @param currentTime - Current timestamp (defaults to Date.now())
 * @param thresholdMs - Threshold in milliseconds (defaults to STUCK_LOADING_THRESHOLD_MS)
 * @returns True if the loading state is stuck
 */
export function isLoadingStuck(
  loadingStartTime: number | null,
  currentTime: number = Date.now(),
  thresholdMs: number = STUCK_LOADING_THRESHOLD_MS
): boolean {
  if (loadingStartTime === null) {
    return false;
  }
  return currentTime - loadingStartTime > thresholdMs;
}

/**
 * Represents the state flags that can cause the UI to be stuck.
 */
export interface LoadingStateFlags {
  loading: boolean;
  refreshing: boolean;
  isManualWorkflowFetch: boolean;
  waitingForInitialFilters: boolean;
  pendingWorkflowId: number | string | null;
}

/**
 * Checks if any loading-related flag is set that could cause a stuck state.
 *
 * @param flags - The current loading state flags
 * @returns True if any blocking flag is set
 */
export function hasBlockingFlags(flags: LoadingStateFlags): boolean {
  return (
    flags.loading ||
    flags.refreshing ||
    flags.isManualWorkflowFetch ||
    flags.waitingForInitialFilters ||
    flags.pendingWorkflowId !== null
  );
}

/**
 * Returns the default/reset values for all loading state flags.
 * Used when recovering from a stuck state.
 *
 * @returns Reset values for all loading state flags
 */
export function getResetLoadingState(): LoadingStateFlags {
  return {
    loading: false,
    refreshing: false,
    isManualWorkflowFetch: false,
    waitingForInitialFilters: false,
    pendingWorkflowId: null,
  };
}

/**
 * Formats a diagnostic message for logging stuck state information.
 *
 * @param flags - Current loading state flags
 * @param loadingStartTime - When loading started
 * @param errorMessage - Optional error message
 * @returns Formatted diagnostic string
 */
export function formatStuckStateDiagnostic(
  flags: LoadingStateFlags,
  loadingStartTime: number | null,
  errorMessage?: string
): string {
  const duration = loadingStartTime ? Math.round((Date.now() - loadingStartTime) / 1000) : 0;
  const parts = [
    `[Recovery] Loading stuck for ${duration}s`,
    `loading=${flags.loading}`,
    `refreshing=${flags.refreshing}`,
    `isManualWorkflowFetch=${flags.isManualWorkflowFetch}`,
    `waitingForInitialFilters=${flags.waitingForInitialFilters}`,
    `pendingWorkflowId=${flags.pendingWorkflowId}`,
  ];
  if (errorMessage) {
    parts.push(`error="${errorMessage}"`);
  }
  return parts.join(', ');
}
