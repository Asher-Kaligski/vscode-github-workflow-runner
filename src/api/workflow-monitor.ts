/**
 * GitHub Actions workflow monitoring and run management
 */
import { TokenManager } from '../utils/token-manager';
import type { WorkflowRun, WorkflowJob } from '../types/workflow-types';

/**
 * Rate limit information from GitHub API responses
 */
export interface RateLimitInfo {
  remaining: number;
  limit: number;
  reset: number; // Unix timestamp in seconds
}

/**
 * Global rate limit tracker - updated on each API response
 */
let lastRateLimitInfo: RateLimitInfo | null = null;

/**
 * Extract rate limit information from GitHub API response headers
 */
export function extractRateLimitFromResponse(response: Response): RateLimitInfo | null {
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const limit = response.headers.get('X-RateLimit-Limit');
  const reset = response.headers.get('X-RateLimit-Reset');

  if (remaining && limit && reset) {
    const info: RateLimitInfo = {
      remaining: parseInt(remaining, 10),
      limit: parseInt(limit, 10),
      reset: parseInt(reset, 10),
    };

    // Update global tracker
    lastRateLimitInfo = info;

    return info;
  }
  return null;
}

/**
 * Get the last known rate limit information
 */
export function getLastRateLimitInfo(): RateLimitInfo | null {
  return lastRateLimitInfo;
}

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
): Promise<{ runs: WorkflowRun[]; totalCount: number; rateLimitInfo?: RateLimitInfo } | null> {
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

    // Extract and track rate limit info from response
    const rateLimitInfo = extractRateLimitFromResponse(response);

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
      data.total_count || 0,
      rateLimitInfo ? `(Rate limit: ${rateLimitInfo.remaining}/${rateLimitInfo.limit})` : ''
    );

    return {
      runs: data.workflow_runs || [],
      totalCount: data.total_count || 0,
      rateLimitInfo: rateLimitInfo ?? undefined,
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
): Promise<{ run: WorkflowRun; rateLimitInfo?: RateLimitInfo } | null> {
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

    // Extract rate limit info from response headers (updates global tracker)
    const rateLimitInfo = extractRateLimitFromResponse(response);

    if (!response.ok) {
      return null;
    }

    const run = (await response.json()) as WorkflowRun;
    return { run, rateLimitInfo: rateLimitInfo ?? undefined };
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

/**
 * GitHub summary result interface
 */
export interface GitHubSummaryResult {
  success: boolean;
  content?: string;
  markdownContent?: string;
  error?: string;
  htmlUrl: string;
}

/**
 * Represents a GitHub Actions annotation (error, warning, or notice).
 */
interface Annotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  file?: string;
  line?: number;
  col?: number;
}

/**
 * Job summary content extracted from logs
 */
interface JobSummaryContent {
  jobName: string;
  jobId: number;
  content: string;
  annotations?: Annotation[];
  error?: string;
}

/**
 * Fetch GitHub workflow run summary content
 * Note: GitHub does not provide an official API to fetch job summaries.
 * The undocumented summary_raw endpoint requires cookie-based authentication
 * (a logged-in browser session), not just a Bearer token.
 * This function attempts to fetch summaries but will likely fail due to auth requirements.
 * The primary purpose is to provide the URL for users to view summaries on GitHub.
 */
export async function getGitHubSummary(
  owner: string,
  repo: string,
  runId: number,
  jobs: WorkflowJob[]
): Promise<GitHubSummaryResult> {
  const htmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { success: false, error: 'Not authenticated', htmlUrl };
    }

    // Collect summaries from all jobs
    const summaries: string[] = [];

    for (const job of jobs) {
      try {
        // Try the undocumented summary_raw endpoint for each job
        // Note: This endpoint requires cookie-based authentication (logged-in session)
        // and may not work with API tokens
        const summaryUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}/jobs/${job.id}/summary_raw`;

        const response = await fetch(summaryUrl, {
          headers: {
            Accept: 'text/plain',
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const summaryText = await response.text();
          if (summaryText && summaryText.trim()) {
            summaries.push(`## ${job.name}\n\n${summaryText}`);
          }
        }
      } catch (jobError) {
        // Continue with other jobs if one fails
        console.warn(`Failed to fetch summary for job ${job.name}:`, jobError);
      }
    }

    if (summaries.length > 0) {
      const markdownContent = summaries.join('\n\n---\n\n');
      return {
        success: true,
        markdownContent,
        htmlUrl,
      };
    }

    // Build a summary of jobs that have steps which might generate summaries
    const jobsWithPotentialSummaries = jobs.filter((job) =>
      job.steps?.some(
        (step) =>
          step.name.toLowerCase().includes('summary') || step.name.toLowerCase().includes('report')
      )
    );

    // If no summaries found via API, provide helpful information
    let message = `## GitHub Job Summaries\n\n`;
    message += `**Note:** GitHub does not provide a public API to fetch job summaries directly.\n\n`;
    message += `The job summaries for this workflow run can only be viewed on GitHub's website.\n\n`;
    message += `### Workflow Run Details\n\n`;
    message += `- **Run ID:** ${runId}\n`;
    message += `- **Jobs:** ${jobs.length}\n`;

    if (jobsWithPotentialSummaries.length > 0) {
      message += `\n### Jobs with Potential Summaries\n\n`;
      message += `The following jobs may have generated summaries:\n\n`;
      for (const job of jobsWithPotentialSummaries) {
        message += `- **${job.name}** (${job.conclusion || job.status})\n`;
      }
    }

    message += `\n---\n\n`;
    message += `👉 **Click "View on GitHub" below to view the full job summaries on GitHub.**`;

    return {
      success: true,
      markdownContent: message,
      htmlUrl,
    };
  } catch (error) {
    console.error('Error fetching GitHub summary:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch summary',
      htmlUrl,
    };
  }
}

/**
 * Fetch job logs from GitHub API (public wrapper)
 * Returns the raw log content as a string
 */
export async function getJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
  const token = await TokenManager.getGithubToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const result = await fetchJobLogs(owner, repo, jobId, token);
  if (!result.success || !result.logs) {
    throw new Error(result.error || 'Failed to fetch job logs');
  }

  return result.logs;
}

/**
 * Fetch job logs from GitHub API
 * Handles the 302 redirect to Azure Storage URL
 */
async function fetchJobLogs(
  owner: string,
  repo: string,
  jobId: number,
  token: string
): Promise<{ success: boolean; logs?: string; error?: string }> {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'manual',
    });

    // GitHub API returns 302 redirect to Azure Storage URL
    if (response.status === 302) {
      const redirectUrl = response.headers.get('location');
      if (!redirectUrl) {
        return { success: false, error: 'Redirect without location header' };
      }
      const logResponse = await fetch(redirectUrl);
      if (!logResponse.ok) {
        return { success: false, error: `Failed to fetch logs: ${logResponse.status}` };
      }
      return { success: true, logs: await logResponse.text() };
    }

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: 'Logs not found or not yet available' };
      }
      if (response.status === 410) {
        return { success: false, error: 'Logs have expired' };
      }
      return { success: false, error: `Failed to fetch logs: ${response.status}` };
    }

    return { success: true, logs: await response.text() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error fetching logs',
    };
  }
}

/**
 * Parse summary content from job logs.
 * Looks for lines that write to $GITHUB_STEP_SUMMARY.
 *
 * Common patterns:
 * - echo "content" >> $GITHUB_STEP_SUMMARY
 * - echo 'content' >> $GITHUB_STEP_SUMMARY
 * - echo "content" >> "$GITHUB_STEP_SUMMARY"
 * - cat file >> $GITHUB_STEP_SUMMARY
 * - printf "content" >> $GITHUB_STEP_SUMMARY
 *
 * The actual summary content in logs appears as the echoed text,
 * often after shell command output.
 */
function parseSummaryFromLogs(logs: string): string {
  const lines = logs.split('\n');
  const summaryLines: string[] = [];

  // Regex to match lines that write to GITHUB_STEP_SUMMARY
  // The log format typically shows the command and its output
  const summaryWritePattern =
    />>\s*["']?\$?GITHUB_STEP_SUMMARY["']?|>>\s*["']?\$\{?GITHUB_STEP_SUMMARY\}?["']?/i;

  // Pattern to extract content from echo/printf commands
  const echoPattern = /(?:echo|printf)\s+(?:-[en]+\s+)?["'](.+?)["']\s*>>/;
  const echoPatternSingle = /(?:echo|printf)\s+(?:-[en]+\s+)?'(.+?)'\s*>>/;

  // Track if we're in a heredoc or multi-line summary section
  let inSummaryBlock = false;
  let summaryBlockContent: string[] = [];

  // Pattern to detect heredoc start (e.g., cat << EOF >> $GITHUB_STEP_SUMMARY)
  const heredocStartPattern = /<<\s*['"]?(\w+)['"]?\s*>>\s*.*GITHUB_STEP_SUMMARY/i;
  let heredocEndMarker: string | null = null;

  // Track seen content to prevent duplicates
  const seenContent = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Remove ANSI escape codes and timestamps from log lines
    // eslint-disable-next-line no-control-regex
    const ansiRegex = /\x1b\[[0-9;]*m/g;
    const cleanLine = line
      .replace(ansiRegex, '') // ANSI codes
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '') // ISO timestamp
      .trim();

    // Skip GitHub Actions group markers (##[group]Run ...) to avoid duplicates
    // The actual command appears on the next line without the ##[group] prefix
    if (cleanLine.startsWith('##[group]') || cleanLine.startsWith('##[endgroup]')) {
      continue;
    }

    // Check for heredoc end
    if (heredocEndMarker && cleanLine === heredocEndMarker) {
      inSummaryBlock = false;
      heredocEndMarker = null;
      continue;
    }

    // If we're in a heredoc block, capture all content
    if (inSummaryBlock && heredocEndMarker) {
      summaryBlockContent.push(cleanLine);
      continue;
    }

    // Check for heredoc start
    const heredocMatch: RegExpMatchArray | null = cleanLine.match(heredocStartPattern);
    if (heredocMatch) {
      heredocEndMarker = heredocMatch[1];
      inSummaryBlock = true;
      continue;
    }

    // Check if this line writes to GITHUB_STEP_SUMMARY
    if (summaryWritePattern.test(cleanLine)) {
      // Try to extract content from echo/printf commands
      let match = cleanLine.match(echoPattern);
      if (!match) {
        match = cleanLine.match(echoPatternSingle);
      }

      if (match && match[1]) {
        // Unescape common escape sequences
        const content = match[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'");

        // Track and skip duplicate content (can happen with ##[group] markers)
        if (!seenContent.has(content)) {
          seenContent.add(content);
          summaryLines.push(content);
        }
      }
    }
  }

  // Combine heredoc content if we captured any
  if (summaryBlockContent.length > 0) {
    const heredocContent = summaryBlockContent.join('\n');
    if (!seenContent.has(heredocContent)) {
      summaryLines.push(heredocContent);
    }
  }

  // Parse variable assignments from the logs and substitute in summary content
  const rawContent = summaryLines.join('\n');
  const variables = parseVariableAssignments(logs);
  return substituteVariables(rawContent, variables);
}

/**
 * Parse GitHub Actions annotations from job logs.
 * Annotations appear as ##[error], ##[warning], or ##[notice] in logs.
 */
function parseAnnotationsFromLogs(logs: string): Annotation[] {
  const annotations: Annotation[] = [];
  const lines = logs.split('\n');

  // Pattern to match annotation commands: ##[level]message or ##[level file=...,line=...,col=...]message
  const annotationPattern = /##\[(error|warning|notice)\](.+)/i;
  const annotationWithLocationPattern =
    /##\[(error|warning|notice)\s+file=([^,]+)(?:,line=(\d+))?(?:,col=(\d+))?\](.+)/i;

  for (const line of lines) {
    // Remove timestamp prefix
    const cleanLine = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '').trim();

    // Try to match annotation with location info first
    const locationMatch = cleanLine.match(annotationWithLocationPattern);
    if (locationMatch) {
      annotations.push({
        level: locationMatch[1].toLowerCase() as 'error' | 'warning' | 'notice',
        file: locationMatch[2],
        line: locationMatch[3] ? parseInt(locationMatch[3], 10) : undefined,
        col: locationMatch[4] ? parseInt(locationMatch[4], 10) : undefined,
        message: locationMatch[5].trim(),
      });
      continue;
    }

    // Try simple annotation pattern
    const simpleMatch = cleanLine.match(annotationPattern);
    if (simpleMatch) {
      annotations.push({
        level: simpleMatch[1].toLowerCase() as 'error' | 'warning' | 'notice',
        message: simpleMatch[2].trim(),
      });
    }
  }

  return annotations;
}

/**
 * Format annotations as markdown for display in the summary.
 */
function formatAnnotationsAsMarkdown(annotations: Annotation[]): string {
  if (annotations.length === 0) {
    return '';
  }

  const errors = annotations.filter((a) => a.level === 'error');
  const warnings = annotations.filter((a) => a.level === 'warning');
  const notices = annotations.filter((a) => a.level === 'notice');

  const parts: string[] = [];

  if (errors.length > 0) {
    parts.push(`#### ❌ Errors (${errors.length})`);
    for (const err of errors) {
      const location = err.file ? ` (${err.file}${err.line ? `:${err.line}` : ''})` : '';
      parts.push(`- ${err.message}${location}`);
    }
    parts.push('');
  }

  if (warnings.length > 0) {
    parts.push(`#### ⚠️ Warnings (${warnings.length})`);
    for (const warn of warnings) {
      const location = warn.file ? ` (${warn.file}${warn.line ? `:${warn.line}` : ''})` : '';
      parts.push(`- ${warn.message}${location}`);
    }
    parts.push('');
  }

  if (notices.length > 0) {
    parts.push(`#### ℹ️ Notices (${notices.length})`);
    for (const notice of notices) {
      const location = notice.file
        ? ` (${notice.file}${notice.line ? `:${notice.line}` : ''})`
        : '';
      parts.push(`- ${notice.message}${location}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Clean a log line by removing ANSI codes, timestamps, and shell trace prefixes.
 * Handles both standard ANSI format (\x1b[...m) and GitHub Actions format ([36;1m...[0m]).
 */
function cleanLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  return line
    .replace(ansiRegex, '') // Remove ANSI escape codes (standard format)
    .replace(/\[\d+(?:;\d+)*m/g, '') // Remove ANSI codes (GitHub Actions format like [36;1m, [0m)
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '') // Remove timestamp
    .replace(/^\+\s+/, '') // Remove shell trace prefix (+ )
    .replace(/^\+\+\s+/, '') // Remove nested shell trace prefix (++ )
    .trim();
}

/**
 * Evaluate a shell condition expression against known variable values.
 * Supports: -gt, -lt, -ge, -le, -eq, =, !=, -n, -z operators
 * Returns true/false based on condition evaluation, or null if cannot evaluate.
 */
function evaluateShellCondition(condition: string, variables: Map<string, string>): boolean | null {
  // Substitute variables in the condition
  const substituteVars = (str: string): string => {
    return str.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, varName) => {
      return variables.get(varName) ?? '';
    });
  };

  // Remove outer brackets and trim
  let expr = condition
    .replace(/^\[\s*/, '')
    .replace(/\s*\]$/, '')
    .trim();
  expr = substituteVars(expr);

  // Pattern: "value1" -gt|-lt|-ge|-le|-eq "value2" (numeric comparison)
  const numericCompare = expr.match(
    /^["']?(-?\d+)["']?\s+(-gt|-lt|-ge|-le|-eq)\s+["']?(-?\d+)["']?$/
  );
  if (numericCompare) {
    const left = parseInt(numericCompare[1], 10);
    const op = numericCompare[2];
    const right = parseInt(numericCompare[3], 10);

    switch (op) {
      case '-gt':
        return left > right;
      case '-lt':
        return left < right;
      case '-ge':
        return left >= right;
      case '-le':
        return left <= right;
      case '-eq':
        return left === right;
    }
  }

  // Pattern: "value1" = "value2" or "value1" != "value2" (string comparison)
  const stringCompare = expr.match(/^["']?([^"']+)?["']?\s+(=|!=)\s+["']?([^"']+)?["']?$/);
  if (stringCompare) {
    const left = (stringCompare[1] || '').trim();
    const op = stringCompare[2];
    const right = (stringCompare[3] || '').trim();

    switch (op) {
      case '=':
        return left === right;
      case '!=':
        return left !== right;
    }
  }

  // Pattern: -n "value" (string is non-empty)
  const nonEmpty = expr.match(/^-n\s+["']?(.*)["']?$/);
  if (nonEmpty) {
    return nonEmpty[1].trim().length > 0;
  }

  // Pattern: -z "value" (string is empty)
  const isEmpty = expr.match(/^-z\s+["']?(.*)["']?$/);
  if (isEmpty) {
    return isEmpty[1].trim().length === 0;
  }

  return null; // Cannot evaluate
}

/**
 * Evaluate a compound condition (with || or &&).
 */
function evaluateCompoundCondition(line: string, variables: Map<string, string>): boolean | null {
  // Handle OR conditions: [ cond1 ] || [ cond2 ]
  if (line.includes('||')) {
    const parts = line.split('||').map((p) => p.trim());
    for (const part of parts) {
      const bracketMatch = part.match(/\[([^\]]+)\]/);
      if (bracketMatch) {
        const result = evaluateShellCondition(`[${bracketMatch[1]}]`, variables);
        if (result === true) return true;
        if (result === null) return null;
      }
    }
    return false;
  }

  // Handle AND conditions: [ cond1 ] && [ cond2 ]
  if (line.includes('&&')) {
    const parts = line.split('&&').map((p) => p.trim());
    for (const part of parts) {
      const bracketMatch = part.match(/\[([^\]]+)\]/);
      if (bracketMatch) {
        const result = evaluateShellCondition(`[${bracketMatch[1]}]`, variables);
        if (result === false) return false;
        if (result === null) return null;
      }
    }
    return true;
  }

  // Single condition
  const bracketMatch = line.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    return evaluateShellCondition(`[${bracketMatch[1]}]`, variables);
  }

  return null;
}

/**
 * Represents a conditional assignment block parsed from logs.
 */
interface ConditionalBlock {
  condition: string;
  assignment: string | null;
  elseBlock: ConditionalBlock | null;
  nestedIf: ConditionalBlock | null;
}

/**
 * Evaluate a conditional block to determine which assignment applies.
 */
function evaluateConditionalBlock(
  block: ConditionalBlock,
  variables: Map<string, string>
): string | null {
  const conditionResult = evaluateCompoundCondition(block.condition, variables);

  if (conditionResult === true) {
    // Check for nested if in the then-block
    if (block.nestedIf) {
      return evaluateConditionalBlock(block.nestedIf, variables);
    }
    return block.assignment;
  } else if (conditionResult === false) {
    // Check else block
    if (block.elseBlock) {
      return evaluateConditionalBlock(block.elseBlock, variables);
    }
  }

  return null;
}

/**
 * Evaluate conditional assignments for a specific variable by tracing if/else logic.
 * Parses the conditional structure and evaluates which branch would execute.
 */
function evaluateConditionalAssignment(
  logs: string,
  varName: string,
  variables: Map<string, string>
): string | null {
  const lines = logs.split('\n').map(cleanLogLine);

  // Find all assignment lines for this variable and their context
  const assignmentPattern = new RegExp(`^${varName}=["']?(.+?)["']?$|^${varName}=["'](.*)["']$`);

  // Track if/else blocks
  const stack: { type: 'if' | 'else'; condition: string; depth: number }[] = [];
  let currentDepth = 0;

  // Store assignments with their conditional context
  const assignments: { value: string; conditions: string[] }[] = [];
  let currentConditions: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track if statements
    if (line.startsWith('if ') || line.match(/^if\s+\[/)) {
      currentDepth++;
      const condition = line
        .replace(/^if\s+/, '')
        .replace(/;\s*then\s*$/, '')
        .trim();
      stack.push({ type: 'if', condition, depth: currentDepth });
      currentConditions = stack.map((s) =>
        s.type === 'else' ? `NOT(${s.condition})` : s.condition
      );
    }

    // Track else statements
    if (line === 'else' || line.startsWith('else')) {
      // Find matching if and flip its condition
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].type === 'if' && stack[j].depth === currentDepth) {
          stack[j].type = 'else';
          break;
        }
      }
      currentConditions = stack.map((s) =>
        s.type === 'else' ? `NOT(${s.condition})` : s.condition
      );
    }

    // Track fi (end if)
    if (line === 'fi') {
      // Pop the current depth level
      while (stack.length > 0 && stack[stack.length - 1].depth === currentDepth) {
        stack.pop();
      }
      currentDepth--;
      currentConditions = stack.map((s) =>
        s.type === 'else' ? `NOT(${s.condition})` : s.condition
      );
    }

    // Check for assignment
    const match = line.match(assignmentPattern);
    if (match) {
      const value = match[1] || match[2] || '';
      assignments.push({ value, conditions: [...currentConditions] });
    }
  }

  // If no conditional assignments found, return null
  if (assignments.length === 0) {
    return null;
  }

  // Evaluate each assignment's conditions to find the one that applies
  for (const assignment of assignments) {
    if (assignment.conditions.length === 0) {
      // Unconditional assignment - use directly
      return assignment.value;
    }

    // Evaluate all conditions
    let allConditionsMet = true;
    for (const condition of assignment.conditions) {
      // Handle NOT(condition) wrapper
      const isNegated = condition.startsWith('NOT(') && condition.endsWith(')');
      const actualCondition = isNegated ? condition.slice(4, -1) : condition;

      const result = evaluateCompoundCondition(`if ${actualCondition}`, variables);

      if (result === null) {
        allConditionsMet = false;
        break;
      }

      const expectedResult = !isNegated;
      if (result !== expectedResult) {
        allConditionsMet = false;
        break;
      }
    }

    if (allConditionsMet) {
      // Substitute any variables in the assignment value
      let finalValue = assignment.value;
      finalValue = finalValue.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, vName) => {
        return variables.get(vName) ?? match;
      });
      // Handle arithmetic: $((...))
      finalValue = finalValue.replace(/\$\(\(([^)]+)\)\)/g, (_, expr) => {
        try {
          // Simple arithmetic evaluation
          const substituted = expr.replace(/([A-Za-z_][A-Za-z0-9_]*)/g, (varRef: string) => {
            return variables.get(varRef) ?? '0';
          });
          // Safe eval for simple arithmetic
          const result = Function(`"use strict"; return (${substituted})`)();
          return String(result);
        } catch {
          return '0';
        }
      });
      return finalValue;
    }
  }

  return null;
}

/**
 * Extract echoed values from job logs.
 * Strategy: Look for variable assignments in the script source code, then find the
 * corresponding output value in the actual execution section.
 *
 * GitHub Actions logs have two sections:
 * 1. Source code display (with ANSI codes like [36;1m...[0m]) - shows the script
 * 2. Actual execution output (no ANSI codes) - shows runtime values
 *
 * For variables with static assignments (no $VAR in value), we prefer the source code
 * value since execution output may have character encoding issues (e.g., # becoming •).
 */
function extractEchoedValues(logs: string): Map<string, string> {
  const echoedValues = new Map<string, string>();
  const lines = logs.split('\n');

  // Track which variables have echo statements in the source
  const varsWithEcho = new Set<string>();

  // Pattern: echo "$VAR" or echo "${VAR}" (with optional redirection)
  const echoVarPattern =
    /^echo\s+["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?["']?(?:\s*>>?\s*["']?\$GITHUB_STEP_SUMMARY["']?)?$/;

  // Pattern to detect ANY ANSI-formatted line (source code display)
  const ansiLinePattern = /\[\d+(?:;\d+)*m/;

  // First pass: Find variables that are echoed in the source code
  for (const line of lines) {
    // Only look at source code lines (have ANSI formatting codes)
    if (!line.includes('\x1b[') && !ansiLinePattern.test(line)) continue;

    const cleanLine = cleanLogLine(line);
    const match = cleanLine.match(echoVarPattern);
    if (match) {
      varsWithEcho.add(match[1]);
    }
  }

  // Collect all known variable assignments to understand expected value patterns
  // Store both the pattern and whether it's static (no $VAR references)
  const knownAssignments = new Map<string, { pattern: string; isStatic: boolean }[]>();
  const assignPattern = /^([A-Za-z_][A-Za-z0-9_]*)=["']?(.+?)["']?$/;
  const hasVarRef = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

  for (const line of lines) {
    // Only look at source code lines
    if (!line.includes('\x1b[') && !ansiLinePattern.test(line)) continue;

    const cleanLine = cleanLogLine(line);
    const match = cleanLine.match(assignPattern);
    if (match && varsWithEcho.has(match[1])) {
      const varName = match[1];
      const value = match[2];
      const isStatic = !hasVarRef.test(value);
      if (!knownAssignments.has(varName)) {
        knownAssignments.set(varName, []);
      }
      knownAssignments.get(varName)!.push({ pattern: value, isStatic });
    }
  }

  // For variables with ONLY static assignments (no $VAR in any pattern),
  // we can use the source code value directly since it's the literal value.
  // This avoids character encoding issues in execution output.
  for (const [varName, assignments] of knownAssignments) {
    const allStatic = assignments.every((a) => a.isStatic);
    if (allStatic && assignments.length === 1) {
      // Single static assignment - use source code value directly
      echoedValues.set(varName, assignments[0].pattern);
    }
  }

  // Second pass: Find actual output values (lines WITHOUT ANSI codes)
  // These are the real execution outputs - used for dynamic values
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Skip lines with ANSI codes (these are source code display, not execution)
    if (rawLine.includes('\x1b[') || rawLine.includes('[36;1m')) continue;

    const cleanLine = cleanLogLine(rawLine);
    if (!cleanLine) continue;

    // Skip metadata lines
    if (cleanLine.startsWith('shell:')) continue;
    if (cleanLine.startsWith('env:')) continue;
    if (cleanLine.startsWith('##[')) continue;
    if (cleanLine.includes('{0}')) continue;

    // For each variable with echo, check if this line matches one of its assignment patterns
    for (const [varName, assignments] of knownAssignments) {
      if (echoedValues.has(varName)) continue; // Already found

      for (const { pattern, isStatic } of assignments) {
        // For static patterns, we already handled them above
        if (isStatic) continue;

        // Check if the pattern (with variables substituted) could match this line
        // Look for the static prefix of the pattern (before any $VAR)
        const staticPrefix = pattern.split(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/)[0];
        if (staticPrefix && cleanLine.startsWith(staticPrefix)) {
          echoedValues.set(varName, cleanLine);
          break;
        }
      }
    }
  }

  return echoedValues;
}

/**
 * Parse variable assignments from job logs.
 * Looks for patterns like: VAR_NAME="value" or VAR_NAME='value' or VAR_NAME=value
 * Also captures the last assignment for variables with multiple assignments (conditionals).
 * Returns a map of variable names to their values.
 *
 * Note: Prefers source code assignments (ANSI-formatted lines) over execution output
 * because source code shows literal values, while execution output may have character
 * encoding issues (e.g., # becoming • in URLs).
 */
function parseVariableAssignments(logs: string): Map<string, string> {
  const variables = new Map<string, string>();
  const sourceCodeVars = new Map<string, string>(); // Track assignments from source code (ANSI lines)
  const multiAssignVars = new Set<string>(); // Track variables assigned multiple times
  const lines = logs.split('\n');

  // Patterns for variable assignments
  // Pattern 1: VAR="value" or VAR='value'
  const quotedAssignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=["']([^"']*)["']\s*$/;
  // Pattern 2: VAR=value (no quotes, single word)
  const unquotedAssignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/;
  // Pattern 3: export VAR="value" or export VAR='value'
  const exportQuotedPattern = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=["']([^"']*)["']\s*$/;
  // Pattern 4: export VAR=value
  const exportUnquotedPattern = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/;

  // Pattern to detect ANY ANSI-formatted line (source code display)
  // GitHub Actions uses various formats: [36;1m, [0;36m, [1;34m, etc.
  const ansiLinePattern = /\[\d+(?:;\d+)*m/;

  for (const line of lines) {
    // Check if this is a source code line (has ANSI formatting)
    // Source code lines have ANSI codes, execution output lines don't
    const isSourceCodeLine = line.includes('\x1b[') || ansiLinePattern.test(line);

    // Use shared cleanLogLine to remove ANSI codes, timestamps, and shell trace prefixes
    const cleanedLine = cleanLogLine(line);

    let match = cleanedLine.match(quotedAssignmentPattern);
    if (match) {
      if (variables.has(match[1])) {
        multiAssignVars.add(match[1]);
      }
      variables.set(match[1], match[2]);
      // Track source code assignments separately (they're more reliable)
      if (isSourceCodeLine) {
        sourceCodeVars.set(match[1], match[2]);
      }
      continue;
    }

    match = cleanedLine.match(unquotedAssignmentPattern);
    if (match) {
      if (variables.has(match[1])) {
        multiAssignVars.add(match[1]);
      }
      variables.set(match[1], match[2]);
      if (isSourceCodeLine) {
        sourceCodeVars.set(match[1], match[2]);
      }
      continue;
    }

    match = cleanedLine.match(exportQuotedPattern);
    if (match) {
      if (variables.has(match[1])) {
        multiAssignVars.add(match[1]);
      }
      variables.set(match[1], match[2]);
      if (isSourceCodeLine) {
        sourceCodeVars.set(match[1], match[2]);
      }
      continue;
    }

    match = cleanedLine.match(exportUnquotedPattern);
    if (match) {
      if (variables.has(match[1])) {
        multiAssignVars.add(match[1]);
      }
      variables.set(match[1], match[2]);
      if (isSourceCodeLine) {
        sourceCodeVars.set(match[1], match[2]);
      }
      continue;
    }
  }

  // For variables with source code assignments, ALWAYS prefer the source code value
  // when it's a static assignment (no $VAR references).
  // This is critical because execution output often has character encoding issues
  // (e.g., # becoming • or - in URLs due to shell/logging quirks).
  // Source code lines (with ANSI formatting) show the literal script content,
  // which is always more reliable than the echoed execution output.
  for (const [varName, sourceValue] of sourceCodeVars) {
    // Only use source value if it's a static assignment (no $VAR references)
    const hasVarRef = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(sourceValue);
    if (!hasVarRef) {
      // ALWAYS prefer source code value for static assignments
      // Don't try to detect "corruption" - just trust the source code
      variables.set(varName, sourceValue);
    }
  }

  // For variables with conditional assignments (multiple assignments detected),
  // use a multi-strategy approach to determine the correct value:
  // 1. Primary: Try to extract the actual echoed value from logs
  // 2. Fallback: Evaluate conditional logic to determine which branch executed

  const echoedValues = extractEchoedValues(logs);

  for (const varName of multiAssignVars) {
    // Strategy 1: Check if we have an echoed value (most reliable - actual runtime output)
    const echoedValue = echoedValues.get(varName);
    if (echoedValue) {
      variables.set(varName, echoedValue);
      continue;
    }

    // Strategy 2: Evaluate conditional logic to determine correct value
    // Use the current variables map (which has simple assignments) to evaluate conditions
    const conditionalValue = evaluateConditionalAssignment(logs, varName, variables);
    if (conditionalValue !== null) {
      variables.set(varName, conditionalValue);
    }
  }

  // Also check for echoed values of variables not in multiAssignVars
  for (const [varName, echoedValue] of echoedValues) {
    if (!multiAssignVars.has(varName) && !variables.has(varName)) {
      variables.set(varName, echoedValue);
    }
  }

  return variables;
}

/**
 * Fix known character corruptions in URLs from GitHub Actions logs.
 * GitHub Actions logging can corrupt certain characters, especially # in URLs.
 * The # character often appears as • (bullet, U+2022) in the logs.
 */
function fixUrlCorruption(value: string): string {
  // Only fix URLs - look for http:// or https://
  if (!value.includes('http://') && !value.includes('https://')) {
    return value;
  }

  // Replace • (bullet) with # in URLs - this is a known GitHub Actions logging issue
  // The bullet character (U+2022) appears where # should be in URL fragments
  return value.replace(/•/g, '#');
}

/**
 * Substitute shell variables in content with their resolved values from logs.
 * Variables like $VAR_NAME or ${VAR_NAME} are replaced with actual values.
 * Unresolved variables are marked with backticks to indicate they weren't found.
 */
function substituteVariables(content: string, variables: Map<string, string>): string {
  // Variables that should not be substituted (they're expected to appear literally)
  const excludedVars = ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV'];

  // Match $VAR_NAME or ${VAR_NAME} patterns
  const varPattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

  return content.replace(varPattern, (match, varName) => {
    // Don't substitute excluded variables
    if (excludedVars.includes(varName)) {
      return match;
    }

    // Check if we have a value for this variable
    const value = variables.get(varName);
    if (value !== undefined) {
      // Fix any URL corruption before returning
      return fixUrlCorruption(value);
    }

    // Mark unresolved variable with backticks
    return `\`${match}\``;
  });
}

/**
 * Alternative parser that looks for markdown content patterns in logs.
 * This handles cases where the summary content is output directly without
 * the shell command syntax being visible in logs.
 */
function parseMarkdownPatternsFromLogs(logs: string): string {
  const lines = logs.split('\n');
  const potentialSummaryContent: string[] = [];

  // Common summary section markers
  // Use alternation instead of character class to avoid misleading-character-class errors with combined emojis
  const emojiPrefixPattern =
    /^(?:\u{1F512}|\u{1F513}|\u{2705}|\u{274C}|\u{26A0}\u{FE0F}?|\u{1F50D}|\u{1F4CA}|\u{1F4C8}|\u{1F4C9}|\u{1F3AF}|\u{1F3C6}|\u{1F4A1}|\u{1F4DD}|\u{1F510}|\u{1F6E1}\u{FE0F}?)/u;
  const summaryStartPatterns = [
    /^#{1,3}\s+.*(?:summary|results|report|output)/i,
    /^(?:\|[-:]+)+\|/, // Markdown table separator
    emojiPrefixPattern, // Common emoji prefixes in summaries
    /:lock:|:unlock:|:white_check_mark:|:x:|:warning:/i, // GitHub emoji syntax
  ];

  // Track table state
  let inTable = false;
  let tableLines: string[] = [];

  // Track potential summary sections
  let capturingSection = false;
  let sectionLines: string[] = [];
  let sectionStartIdx = -1;

  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*m/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Remove ANSI escape codes and timestamps
    const cleanLine = line
      .replace(ansiRegex, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '')
      .trim();

    // Skip empty lines at the start of potential sections
    if (!capturingSection && !cleanLine) {
      continue;
    }

    // Check for markdown table start
    if (cleanLine.startsWith('|') && cleanLine.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableLines = [];
      }
      tableLines.push(cleanLine);
      continue;
    } else if (inTable) {
      // End of table
      if (tableLines.length >= 2) {
        potentialSummaryContent.push(tableLines.join('\n'));
      }
      inTable = false;
      tableLines = [];
    }

    // Check for summary section patterns
    for (const pattern of summaryStartPatterns) {
      if (pattern.test(cleanLine)) {
        if (capturingSection && sectionLines.length > 0) {
          potentialSummaryContent.push(sectionLines.join('\n'));
        }
        capturingSection = true;
        sectionLines = [cleanLine];
        sectionStartIdx = i;
        break;
      }
    }

    // If capturing, continue adding lines until we hit a non-summary pattern
    if (capturingSection && i > sectionStartIdx) {
      // Stop capturing if we hit common log patterns
      if (
        cleanLine.startsWith('##[') || // GitHub Actions commands
        cleanLine.startsWith('Run ') || // Action run output
        cleanLine.includes('::debug::') ||
        cleanLine.includes('::warning::') ||
        cleanLine.includes('::error::')
      ) {
        if (sectionLines.length > 0) {
          potentialSummaryContent.push(sectionLines.join('\n'));
        }
        capturingSection = false;
        sectionLines = [];
      } else if (cleanLine) {
        sectionLines.push(cleanLine);
      }
    }
  }

  // Capture any remaining content
  if (inTable && tableLines.length >= 2) {
    potentialSummaryContent.push(tableLines.join('\n'));
  }
  if (capturingSection && sectionLines.length > 0) {
    potentialSummaryContent.push(sectionLines.join('\n'));
  }

  return potentialSummaryContent.join('\n\n');
}

/**
 * Fetch GitHub workflow run summary by parsing job logs.
 * This extracts summary content written to $GITHUB_STEP_SUMMARY from the logs.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param runId - Workflow run ID
 * @param jobs - List of jobs in the workflow run
 * @returns Summary result with parsed markdown content
 */
export async function getGitHubSummaryFromLogs(
  owner: string,
  repo: string,
  runId: number,
  jobs: WorkflowJob[]
): Promise<GitHubSummaryResult> {
  const htmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { success: false, error: 'Not authenticated', htmlUrl };
    }

    const jobSummaries: JobSummaryContent[] = [];
    const jobErrors: string[] = [];

    // Fetch logs for all completed jobs in parallel (with concurrency limit)
    const completedJobs = jobs.filter(
      (job) => job.status === 'completed' && job.conclusion !== 'skipped'
    );

    // Process jobs in batches of 3 to avoid overwhelming the API
    const batchSize = 3;
    for (let i = 0; i < completedJobs.length; i += batchSize) {
      const batch = completedJobs.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (job) => {
          const logResult = await fetchJobLogs(owner, repo, job.id, token);

          if (!logResult.success || !logResult.logs) {
            return {
              jobName: job.name,
              jobId: job.id,
              content: '',
              annotations: [] as Annotation[],
              error: logResult.error,
            };
          }

          // Parse content written to $GITHUB_STEP_SUMMARY only
          // Do NOT use fallback pattern matching as it picks up regular log output
          const summaryContent = parseSummaryFromLogs(logResult.logs);

          // Parse annotations (errors, warnings, notices)
          const annotations = parseAnnotationsFromLogs(logResult.logs);

          return {
            jobName: job.name,
            jobId: job.id,
            content: summaryContent.trim(),
            annotations,
          };
        })
      );

      for (const result of results) {
        if (result.error) {
          jobErrors.push(`${result.jobName}: ${result.error}`);
        }
        if (result.content || result.annotations.length > 0) {
          jobSummaries.push(result);
        }
      }
    }

    // Build the markdown content with clear job separation
    if (jobSummaries.length > 0) {
      const markdownParts: string[] = [];

      for (const summary of jobSummaries) {
        // Use a distinctive job header format with emoji and clear attribution
        const jobHeader = `### 📋 Job: ${summary.jobName}`;

        // Build content with annotations if present
        const contentParts: string[] = [];
        if (summary.content) {
          contentParts.push(summary.content);
        }
        if (summary.annotations && summary.annotations.length > 0) {
          const annotationsMarkdown = formatAnnotationsAsMarkdown(summary.annotations);
          if (annotationsMarkdown) {
            contentParts.push(annotationsMarkdown);
          }
        }

        if (contentParts.length > 0) {
          // Note: Footer removed to avoid duplication - job header provides sufficient attribution
          markdownParts.push(`${jobHeader}\n\n${contentParts.join('\n\n')}`);
        }
      }

      return {
        success: true,
        markdownContent: markdownParts.join('\n\n---\n\n'),
        htmlUrl,
      };
    }

    // No summaries found - provide helpful message
    let message = `## Workflow Summary\n\n`;

    if (completedJobs.length === 0) {
      message += `⏳ **No completed jobs yet.**\n\n`;
      message += `The workflow is still running or no jobs have completed.\n`;
    } else if (jobErrors.length > 0 && jobErrors.length === completedJobs.length) {
      message += `⚠️ **Could not fetch job logs.**\n\n`;
      message += `The logs may have expired or are not yet available.\n\n`;
      message += `**Errors:**\n`;
      for (const err of jobErrors.slice(0, 5)) {
        message += `- ${err}\n`;
      }
    } else {
      message += `ℹ️ **No summary content detected in job logs.**\n\n`;
      message += 'This workflow may not write to GITHUB_STEP_SUMMARY,\n';
      message += `or the summary format is not recognized.\n\n`;
      message += `**Jobs checked:** ${completedJobs.length}\n`;
    }

    message += `\n---\n\n`;
    message += `👉 **Click "View on GitHub" to view the full workflow run on GitHub.**`;

    return {
      success: true,
      markdownContent: message,
      htmlUrl,
    };
  } catch (error) {
    console.error('Error fetching GitHub summary from logs:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch summary',
      htmlUrl,
    };
  }
}

/**
 * Get GitHub summary content for a single job by parsing its logs.
 * Returns parsed markdown content from $GITHUB_STEP_SUMMARY writes.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param jobId - Job ID
 * @param jobName - Job name for display
 * @param runId - Optional run ID for constructing proper GitHub URL
 * @returns Summary result with parsed markdown content
 */
export async function getJobSummaryFromLogs(
  owner: string,
  repo: string,
  jobId: number,
  jobName: string,
  runId?: number
): Promise<GitHubSummaryResult> {
  // Construct proper URL with run ID if available
  const htmlUrl = runId
    ? `https://github.com/${owner}/${repo}/actions/runs/${runId}`
    : `https://github.com/${owner}/${repo}/actions/runs`;

  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return { success: false, error: 'Not authenticated', htmlUrl };
    }

    const logResult = await fetchJobLogs(owner, repo, jobId, token);

    if (!logResult.success || !logResult.logs) {
      return {
        success: false,
        error: logResult.error || 'Failed to fetch job logs',
        htmlUrl,
      };
    }

    // Parse content written to $GITHUB_STEP_SUMMARY only
    // Do NOT use fallback pattern matching as it picks up regular log output
    const summaryContent = parseSummaryFromLogs(logResult.logs);

    // Parse annotations (errors, warnings, notices)
    const annotations = parseAnnotationsFromLogs(logResult.logs);
    const annotationsMarkdown = formatAnnotationsAsMarkdown(annotations);

    if (!summaryContent.trim() && annotations.length === 0) {
      return {
        success: true,
        markdownContent: `### 📋 Job: ${jobName}\n\nℹ️ **No summary content detected in job logs.**\n\nThis job may not write to GITHUB_STEP_SUMMARY.`,
        htmlUrl,
      };
    }

    // Build content with annotations if present
    const contentParts: string[] = [];
    if (summaryContent.trim()) {
      contentParts.push(summaryContent.trim());
    }
    if (annotationsMarkdown) {
      // Add section header when showing only annotations (no summary content)
      if (!summaryContent.trim()) {
        contentParts.push(`**📋 Annotations**\n\n${annotationsMarkdown}`);
      } else {
        contentParts.push(annotationsMarkdown);
      }
    }

    // Wrap with job header - footer removed to avoid duplication, header provides sufficient attribution
    const markdownContent = `### 📋 Job: ${jobName}\n\n${contentParts.join('\n\n')}`;

    return {
      success: true,
      markdownContent,
      htmlUrl,
    };
  } catch (error) {
    console.error('Error fetching job summary from logs:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch summary',
      htmlUrl,
    };
  }
}
