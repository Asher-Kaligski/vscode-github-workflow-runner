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
 * @param stepNumber Optional step number for step-specific logs
 * @param stepName Optional step name for step-specific logs (used for matching in logs)
 */
export function buildLogURI(
  jobName: string,
  owner: string,
  repo: string,
  jobId: number,
  runId: number,
  stepNumber?: number,
  stepName?: string
): vscode.Uri {
  // Format: workflow-runner-log://owner/repo/jobName?jobId=123&runId=456&step=1&stepName=...
  // jobName must not contain '/'
  const sanitizedJobName = jobName.replace(/\//g, '-');
  const stepParam = stepNumber !== undefined ? `&step=${stepNumber}` : '';
  const stepNameParam = stepName ? `&stepName=${encodeURIComponent(stepName)}` : '';
  return vscode.Uri.parse(
    `${LOG_SCHEME}://${owner}/${repo}/${sanitizedJobName}?jobId=${jobId}&runId=${runId}${stepParam}${stepNameParam}`
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
  stepNumber?: number;
  stepName?: string;
} {
  if (uri.scheme !== LOG_SCHEME) {
    throw new Error(`URI is not of log scheme: ${uri.scheme}`);
  }

  // Parse query parameters
  const params = new URLSearchParams(uri.query);
  const jobId = params.get('jobId');
  const runId = params.get('runId');
  const step = params.get('step');
  const stepName = params.get('stepName');

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
    stepNumber: step ? parseInt(step, 10) : undefined,
    stepName: stepName ? decodeURIComponent(stepName) : undefined,
  };
}
