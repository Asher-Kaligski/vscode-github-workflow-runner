/**
 * GitHub Actions workflow monitoring and run management
 */
import { TokenManager } from '../utils/token-manager';
import type { WorkflowRun, WorkflowJob } from '../types/workflow-types';

/**
 * Fetch workflow runs for a repository.
 *
 * IMPORTANT: Due to known GitHub Actions API reliability issues with
 * server-side filters (branch/actor/status), this function historically
 * avoided sending those filters as query parameters. However, for date
 * filtering, we now support the `created` parameter to handle workflows
 * with 1000+ runs per day where client-side filtering alone is insufficient.
 *
 * Date filtering strategy:
 * - When createdFrom/createdTo are provided, we send the `created` parameter
 *   to GitHub API using the range syntax: created=START..END
 * - Client-side filtering is still performed as a fallback/additional filter
 * - This hybrid approach handles high-volume workflows while maintaining
 *   reliability for edge cases where GitHub's API may have issues
 */
export async function getWorkflowRuns(
  owner: string,
  repo: string,
  options: {
    workflowId?: number;
    branch?: string;
    actor?: string;
    status?: string;
    perPage?: number;
    page?: number;
    createdFrom?: Date;
    createdTo?: Date;
  } = {}
): Promise<{ runs: WorkflowRun[]; totalCount: number } | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const params = new URLSearchParams();
    params.append('per_page', String(options.perPage || 20));
    params.append('page', String(options.page || 1));

    // Add date range filter if provided
    // GitHub API supports: created=YYYY-MM-DDTHH:MM:SSZ..YYYY-MM-DDTHH:MM:SSZ
    // This is critical for workflows with 1000+ runs per day
    if (options.createdFrom || options.createdTo) {
      const fromStr = options.createdFrom ? options.createdFrom.toISOString() : '*';
      const toStr = options.createdTo ? options.createdTo.toISOString() : '*';
      const createdRange = `${fromStr}..${toStr}`;
      params.append('created', createdRange);

      console.log('[getWorkflowRuns] Using GitHub API date filter:', createdRange);
    }

    // We still intentionally avoid branch/actor/status query parameters.
    // GitHub's Actions API has known bugs where these filtered queries return
    // incomplete or empty results, so those filters are performed client-side.

    const baseUrl = options.workflowId
      ? `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${options.workflowId}/runs`
      : `https://api.github.com/repos/${owner}/${repo}/actions/runs`;

    const url = `${baseUrl}?${params.toString()}`;

    console.log('[getWorkflowRuns] Fetching:', url);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch workflow runs:', response.status, response.statusText);
      return null;
    }

    const data = (await response.json()) as {
      workflow_runs?: WorkflowRun[];
      total_count?: number;
    };

    console.log(
      '[getWorkflowRuns] Received:',
      data.workflow_runs?.length || 0,
      'runs, total_count:',
      data.total_count || 0
    );

    return {
      runs: data.workflow_runs || [],
      totalCount: data.total_count || 0,
    };
  } catch (error) {
    console.error('Error fetching workflow runs:', error);
    return null;
  }
}

/**
 * Get the current open PR number for a branch (if any)
 */
export async function getCurrentPullRequest(
  owner: string,
  repo: string,
  branch: string
): Promise<number | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(
      `${owner}:${branch}`
    )}&state=open&per_page=1`;

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

    const data = (await response.json()) as Array<{ number: number }>;
    if (Array.isArray(data) && data.length > 0) {
      return data[0].number;
    }
    return null;
  } catch (error) {
    console.error('Error fetching current pull request:', error);
    return null;
  }
}

/**
 * Get a specific workflow run by ID
 */
export async function getWorkflowRun(
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowRun | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;

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

    return (await response.json()) as WorkflowRun;
  } catch (error) {
    console.error('Error fetching workflow run:', error);
    return null;
  }
}

/**
 * Get workflow metadata (name and path) by workflow ID
 */
export async function getWorkflowById(
  owner: string,
  repo: string,
  workflowId: number
): Promise<{ id: number; name: string; path: string } | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}`;
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
      id: number;
      name: string;
      path: string;
    };
    return { id: data.id, name: data.name, path: data.path };
  } catch (error) {
    console.error('Error fetching workflow by id:', error);
    return null;
  }
}

/**
 * Get jobs for a workflow run
 */
export async function getWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return [];
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { jobs?: WorkflowJob[] };
    return data.jobs || [];
  } catch (error) {
    console.error('Error fetching workflow run jobs:', error);
    return [];
  }
}

/**
 * Get a specific job by ID
 * Returns the job details including current status and steps
 */
export async function getWorkflowJob(
  owner: string,
  repo: string,
  jobId: number
): Promise<WorkflowJob | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}`;

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

    return (await response.json()) as WorkflowJob;
  } catch (error) {
    console.error('Error fetching workflow job:', error);
    return null;
  }
}

/**
 * Check if logs are available for a job
 * Returns true if logs exist, false if not yet available (404)
 */
export async function checkJobLogsAvailable(
  owner: string,
  repo: string,
  jobId: number
): Promise<{ available: boolean; reason?: string }> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { available: false, reason: 'Not authenticated' };
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;

    // Use HEAD request to check availability without downloading full logs
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.ok || response.status === 302) {
      return { available: true };
    }

    if (response.status === 404) {
      return { available: false, reason: 'Logs are not available yet' };
    }

    if (response.status === 410) {
      return { available: false, reason: 'Logs have expired and are no longer available' };
    }

    return { available: false, reason: `Failed to check logs: ${response.status}` };
  } catch (error) {
    console.error('Error checking job logs availability:', error);
    return { available: false, reason: 'Failed to check logs availability' };
  }
}

/**
 * Rerun a workflow run
 */
export async function rerunWorkflowRun(
  owner: string,
  repo: string,
  runId: number
): Promise<boolean> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return false;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    return response.ok;
  } catch (error) {
    console.error('Error rerunning workflow run:', error);
    return false;
  }
}

/**
 * Rerun failed jobs in a workflow run
 */
export async function rerunFailedJobs(
  owner: string,
  repo: string,
  runId: number
): Promise<boolean> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return false;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    return response.ok;
  } catch (error) {
    console.error('Error rerunning failed jobs:', error);
    return false;
  }
}

/**
 * Download workflow run logs
 */
export async function downloadWorkflowRunLogs(
  owner: string,
  repo: string,
  runId: number
): Promise<ArrayBuffer | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`;

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

    return await response.arrayBuffer();
  } catch (error) {
    console.error('Error downloading workflow run logs:', error);
    return null;
  }
}

/**
 * Get workflow run timing information
 */
export async function getWorkflowRunTiming(
  owner: string,
  repo: string,
  runId: number
): Promise<{
  runDurationMs: number;
  billableMs: number;
} | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/timing`;

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
      run_duration_ms?: number;
      billable?: { total_ms?: number };
    };
    return {
      runDurationMs: data.run_duration_ms || 0,
      billableMs: data.billable?.total_ms || 0,
    };
  } catch (error) {
    console.error('Error fetching workflow run timing:', error);
    return null;
  }
}

/**
 * Calculate duration from timestamps
 */
export function calculateDuration(startTime: string, endTime?: string): string {
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const durationMs = end - start;

  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format relative time
 */
export function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const time = new Date(timestamp).getTime();
  const diffMs = now - time;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return `${seconds}s ago`;
  }
}

/**
 * Cancel a workflow run
 */
export async function cancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { success: false, error: 'Not authenticated' };
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/force-cancel`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to cancel workflow run:', response.status, errorText);
      return {
        success: false,
        error: `Failed to cancel workflow run: ${response.statusText}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error cancelling workflow run:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Download workflow artifacts
 */
export async function downloadWorkflowArtifacts(
  owner: string,
  repo: string,
  runId: number
): Promise<ArrayBuffer | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    // First, get list of artifacts
    const artifactsResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!artifactsResponse.ok) {
      console.error('Failed to fetch artifacts:', artifactsResponse.status);
      return null;
    }

    const artifactsData = (await artifactsResponse.json()) as any;

    if (!artifactsData.artifacts || artifactsData.artifacts.length === 0) {
      console.log('No artifacts found for this run');
      return null;
    }

    // Download first artifact
    const artifact = artifactsData.artifacts[0];
    const downloadResponse = await fetch(artifact.archive_download_url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!downloadResponse.ok) {
      console.error('Failed to download artifact:', downloadResponse.status);
      return null;
    }

    return await downloadResponse.arrayBuffer();
  } catch (error) {
    console.error('Error downloading workflow artifacts:', error);
    return null;
  }
}

/**
 * Get artifacts for a workflow run
 */
export async function getWorkflowRunArtifacts(
  owner: string,
  repo: string,
  runId: number
): Promise<Array<{
  id: number;
  name: string;
  size_in_bytes: number;
  archive_download_url: string;
  expired: boolean;
  created_at: string;
}> | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch artifacts:', response.status);
      return null;
    }

    const data = (await response.json()) as any;
    return data.artifacts || [];
  } catch (error) {
    console.error('Error fetching workflow run artifacts:', error);
    return null;
  }
}

/**
 * Download a specific artifact by ID
 */
export async function downloadArtifact(
  owner: string,
  repo: string,
  artifactId: number
): Promise<ArrayBuffer | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      console.error('Failed to download artifact:', response.status);
      return null;
    }

    return await response.arrayBuffer();
  } catch (error) {
    console.error('Error downloading artifact:', error);
    return null;
  }
}

/**
 * Rerun a workflow
 */
export async function rerunWorkflow(
  owner: string,
  repo: string,
  runId: number,
  failedJobsOnly: boolean = false
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { success: false, error: 'Not authenticated' };
    }

    const endpoint = failedJobsOnly
      ? `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`
      : `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to rerun workflow:', response.status, errorText);
      return {
        success: false,
        error: `Failed to rerun workflow: ${response.statusText}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error rerunning workflow:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
