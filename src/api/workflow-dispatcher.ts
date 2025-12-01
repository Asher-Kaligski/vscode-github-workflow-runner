/**
 * Generic GitHub Actions workflow dispatcher
 */
import * as vscode from 'vscode';
import { TokenManager } from '../utils/token-manager';
import type {
  WorkflowDefinition,
  WorkflowDispatchRequest,
} from '../types/workflow-types';
import { validateWorkflowInputs } from '../utils/workflow-parser';

/**
 * Dispatch a workflow via GitHub API
 */
export async function dispatchWorkflow(
  owner: string,
  repo: string,
  workflowFilename: string,
  request: WorkflowDispatchRequest
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return {
        success: false,
        error: 'Not authenticated. Please sign in with GitHub.',
      };
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFilename}/dispatches`;

    console.log('Dispatching workflow:', {
      url,
      ref: request.ref,
      inputs: request.inputs,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: request.ref,
        inputs: request.inputs,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Workflow dispatch failed:', response.status, errorText);

      let errorMessage = `Failed to dispatch workflow: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // Use default error message
      }

      return {
        success: false,
        error: errorMessage,
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Workflow dispatch error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Dispatch workflow with validation
 */
export async function dispatchWorkflowWithValidation(
  owner: string,
  repo: string,
  definition: WorkflowDefinition,
  request: WorkflowDispatchRequest
): Promise<{ success: boolean; error?: string }> {
  // Validate inputs
  const validation = validateWorkflowInputs(definition, request.inputs);
  if (!validation.valid) {
    return {
      success: false,
      error: `Validation failed:\n${validation.errors.join('\n')}`,
    };
  }

  // Dispatch workflow
  return await dispatchWorkflow(owner, repo, definition.filename, request);
}

/**
 * Dispatch a workflow and attempt to resolve the created run ID.
 *
 * This helper performs input validation, dispatches the workflow via the
 * GitHub API, and then calls fetchLatestRunId to resolve the most recent
 * run for the given workflow/branch. It does not show any confirmation UI
 * and is safe to call from both sidebar and workflow-runs flows.
 */
export async function dispatchWorkflowWithRunId(
  owner: string,
  repo: string,
  definition: WorkflowDefinition,
  request: WorkflowDispatchRequest
): Promise<{ success: boolean; error?: string; runId?: number }> {
  const result = await dispatchWorkflowWithValidation(
    owner,
    repo,
    definition,
    request
  );

  if (!result.success) {
    // Keep existing behaviour of surfacing dispatch/validation errors via a
    // VS Code error message so callers don't need to duplicate this logic.
    vscode.window.showErrorMessage(
      `❌ Failed to dispatch workflow: ${result.error}`
    );
    return { success: false, error: result.error };
  }

  const runId = await fetchLatestRunId(
    owner,
    repo,
    definition.filename,
    request.ref
  );

  return { success: true, runId };
}

/**
 * Dispatch workflow with confirmation dialog
 */
export async function dispatchWorkflowWithConfirmation(
  owner: string,
  repo: string,
  definition: WorkflowDefinition,
  request: WorkflowDispatchRequest,
  showConfirmation: boolean = true
): Promise<{
  success: boolean;
  error?: string;
  cancelled?: boolean;
  runId?: number;
  /**
   * Whether the user chose to add the dispatched run to the watch list.
   * This is only set when a confirmation dialog was shown and the user
   * explicitly selected the watch-list option.
   */
  addToWatchList?: boolean;
}> {
  let addToWatchList = false;

  // Show confirmation dialog if enabled
  if (showConfirmation) {
    const inputEntries = Object.entries(request.inputs);
    const inputsSummary =
      inputEntries.length === 0
        ? '  (none)'
        : inputEntries
            .map(([key, value]) => {
              const stringValue = String(value);
              const indentedValue = stringValue.replace(/\n/g, '\n    ');
              // Render parameter name on its own line with the value indented
              // beneath it. VS Code's showInformationMessage is text-only, so
              // this layout is the most we can do to visually separate names
              // from values without custom webview UI.
              return `  ${key}\n    ${indentedValue}`;
            })
            .join('\n\n');

    const message =
      `Dispatch workflow "${definition.name}"?` +
      `\n\nBranch: ${request.ref}` +
      `\n\nInputs:\n${inputsSummary}`;

    const DISPATCH_ONLY = 'Dispatch';
    const DISPATCH_AND_WATCH = 'Dispatch and add to watch list';

    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      DISPATCH_ONLY,
      DISPATCH_AND_WATCH
    );

    if (!choice) {
      return { success: false, cancelled: true };
    }

    addToWatchList = choice === DISPATCH_AND_WATCH;
  }

  // Dispatch without additional UI and resolve runId
  const result = await dispatchWorkflowWithRunId(
    owner,
    repo,
    definition,
    request
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true, runId: result.runId, addToWatchList };
}

/**
 * Fetch the latest run ID for a workflow after dispatch.
 *
 * NOTE: We deliberately avoid using the `branch` query parameter here because
 * GitHub's Actions API has known reliability issues where branch-filtered
 * queries can return incomplete or empty results. Instead, we fetch a small
 * page of the most recent runs for the workflow and select the newest run
 * matching the requested branch using `head_branch`.
 */
export async function fetchLatestRunId(
  owner: string,
  repo: string,
  workflowFilename: string,
  branch: string
): Promise<number | undefined> {
  try {
    // Wait 2 seconds for GitHub to create the run
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const token = await TokenManager.getGithubToken();
    if (!token) {
      return undefined;
    }

    // Fetch recent runs for this workflow (unfiltered) and filter by branch
    // client-side to avoid GitHub's unreliable branch filtering.
    const url =
      `https://api.github.com/repos/${owner}/${repo}` +
      `/actions/workflows/${workflowFilename}/runs?per_page=20`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch latest run:', response.status);
      return undefined;
    }

    const data = (await response.json()) as {
      workflow_runs: Array<{ id: number; head_branch: string }>;
    };

    if (data.workflow_runs && data.workflow_runs.length > 0) {
      const matchingRun = data.workflow_runs.find(
        (run) => run.head_branch === branch
      );
      if (matchingRun) {
        return matchingRun.id;
      }
    }

    return undefined;
  } catch (error) {
    console.error('Error fetching latest run ID:', error);
    return undefined;
  }
}

/**
 * Get workflow ID by filename
 */
export async function getWorkflowId(
  owner: string,
  repo: string,
  workflowFilename: string
): Promise<number | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFilename}`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { id: number };
    return data.id;
  } catch (error) {
    console.error('Failed to get workflow ID:', error);
    return null;
  }
}

/**
 * Check if workflow file exists in repository
 */
export async function workflowExists(
  owner: string,
  repo: string,
  workflowFilename: string
): Promise<boolean> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return false;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${workflowFilename}`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get workflow usage statistics
 */
export async function getWorkflowUsage(
  owner: string,
  repo: string,
  workflowId: number
): Promise<{
  totalCount: number;
  billableMinutes: Record<string, number>;
} | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/timing`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      billable?: { total_ms?: number; [key: string]: unknown };
    };
    return {
      totalCount: data.billable?.total_ms || 0,
      billableMinutes: (data.billable || {}) as Record<string, number>,
    };
  } catch (error) {
    console.error('Failed to get workflow usage:', error);
    return null;
  }
}
