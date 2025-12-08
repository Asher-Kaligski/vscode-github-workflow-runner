/**
 * Log URI scheme for workflow job logs
 * Based on the official GitHub Actions extension approach
 */
import * as vscode from 'vscode';

export const LOG_SCHEME = 'workflow-runner-log';

/**
 * Build a URI for a workflow job log
 * @param jobName Display name for the job
 * @param owner Repository owner
 * @param repo Repository name
 * @param jobId Job ID
 * @param runId Workflow run ID (for context)
 */
export function buildLogURI(
  jobName: string,
  owner: string,
  repo: string,
  jobId: number,
  runId: number
): vscode.Uri {
  // Format: workflow-runner-log://owner/repo/jobName?jobId=123&runId=456
  // jobName must not contain '/'
  const sanitizedJobName = jobName.replace(/\//g, '-');
  return vscode.Uri.parse(
    `${LOG_SCHEME}://${owner}/${repo}/${sanitizedJobName}?jobId=${jobId}&runId=${runId}`
  );
}

/**
 * Parse a log URI to extract job information
 */
export function parseLogURI(uri: vscode.Uri): {
  owner: string;
  repo: string;
  jobName: string;
  jobId: number;
  runId: number;
} {
  if (uri.scheme !== LOG_SCHEME) {
    throw new Error(`URI is not of log scheme: ${uri.scheme}`);
  }

  // Parse query parameters
  const params = new URLSearchParams(uri.query);
  const jobId = params.get('jobId');
  const runId = params.get('runId');

  if (!jobId || !runId) {
    throw new Error('Missing jobId or runId in log URI');
  }

  // Parse path: /repo/jobName
  const pathParts = uri.path.split('/').filter((p) => p);
  const repo = pathParts[0];
  const jobName = pathParts.slice(1).join('/');

  return {
    owner: uri.authority,
    repo,
    jobName,
    jobId: parseInt(jobId, 10),
    runId: parseInt(runId, 10),
  };
}
