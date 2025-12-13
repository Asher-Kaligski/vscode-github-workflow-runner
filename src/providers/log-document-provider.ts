/**
 * Log Document Provider for workflow job logs
 * Implements TextDocumentContentProvider to display logs in VSCode's native text editor
 * Based on the official GitHub Actions extension approach
 */
import * as vscode from 'vscode';
import { parseLogURI } from '../utils/log-uri-scheme';
import { extractStepLogs, parseJobLogs } from '../utils/log-parser';
import { TokenManager } from '../utils/token-manager';

export class LogDocumentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly outputChannel = vscode.window.createOutputChannel(
    'GitHub Actions Runner (Logs)'
  );

  /**
   * Fetch logs from a URL with retry logic
   * Handles both the initial GitHub API call and the redirect to Azure Storage
   */
  private async fetchLogsWithRetry(
    url: string,
    headers: Record<string, string>,
    debug: boolean,
    retries: number = 1
  ): Promise<{ ok: boolean; status: number; statusText: string; text?: string; error?: string }> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (debug && attempt > 0) {
          this.outputChannel.appendLine(`[Job Logs] Retry attempt ${attempt} for ${url}`);
        }

        const response = await fetch(url, {
          headers,
          // Manual redirect handling to get better error messages
          redirect: 'manual',
        });

        // GitHub API returns 302 redirect to Azure Storage URL
        if (response.status === 302) {
          const redirectUrl = response.headers.get('location');
          if (!redirectUrl) {
            return {
              ok: false,
              status: 302,
              statusText: 'Redirect without location',
              error: 'Received redirect response without location header',
            };
          }

          if (debug) {
            this.outputChannel.appendLine(`[Job Logs] Following redirect to: ${redirectUrl}`);
          }

          // Fetch from the redirect URL (Azure Storage) - no auth header needed
          const logResponse = await fetch(redirectUrl);
          if (!logResponse.ok) {
            if (attempt < retries) {
              // Wait before retry (exponential backoff)
              await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
              continue;
            }
            return {
              ok: false,
              status: logResponse.status,
              statusText: logResponse.statusText,
              error: `Failed to fetch logs from storage: ${logResponse.status}`,
            };
          }

          const text = await logResponse.text();
          return { ok: true, status: 200, statusText: 'OK', text };
        }

        // Handle non-redirect responses (errors)
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
          };
        }

        // Unexpected success without redirect - try to read content anyway
        const text = await response.text();
        return { ok: true, status: response.status, statusText: response.statusText, text };
      } catch (error) {
        if (attempt < retries) {
          if (debug) {
            this.outputChannel.appendLine(
              `[Job Logs] Fetch error on attempt ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        return {
          ok: false,
          status: 0,
          statusText: 'Network Error',
          error: error instanceof Error ? error.message : 'Unknown network error',
        };
      }
    }
    return {
      ok: false,
      status: 0,
      statusText: 'Max retries exceeded',
      error: 'Failed to fetch logs after multiple attempts',
    };
  }

  /**
   * Provide text document content for a log URI
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { owner, repo, jobName, jobId, stepNumber, stepName } = parseLogURI(uri);

      const cfg = vscode.workspace.getConfiguration('githubWorkflowRunner');
      const debug = cfg.get<boolean>('logs.debug', false);

      // Validate job id early
      const numericJobId = Number(jobId);
      if (!Number.isFinite(numericJobId) || numericJobId <= 0) {
        if (debug) {
          this.outputChannel.appendLine(
            `[Job Logs] Invalid jobId: ${jobId} for ${owner}/${repo} jobName="${jobName}" uri=${uri.toString()}`
          );
        }
        return `Error: Invalid job ID "${jobId}" for job "${jobName}".`;
      }

      // Get GitHub token
      const token = await TokenManager.getGithubToken();
      if (!token) {
        return 'Error: Not authenticated with GitHub. Please sign in first.';
      }

      // Fetch job logs from GitHub API
      const url = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;

      if (debug) {
        this.outputChannel.appendLine(
          `[Job Logs] Fetching logs: ${owner}/${repo} jobId=${jobId} jobName="${jobName}" url=${url}`
        );
      }

      const result = await this.fetchLogsWithRetry(
        url,
        {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        debug
      );

      if (!result.ok) {
        if (debug) {
          this.outputChannel.appendLine(
            `[Job Logs] Fetch failed: status=${result.status} ${result.statusText} error=${result.error || 'none'} url=${url}`
          );
        }
        if (result.status === 410) {
          return `Logs for job "${jobName}" have expired and are no longer available.`;
        }
        if (result.status === 404) {
          return `Logs not found for job "${jobName}" (404). This can happen if logs are not yet generated, the job ID is from a different repository, or the logs have been pruned. Try again shortly or open the run in GitHub to confirm.`;
        }
        const errorDetail = result.error ? ` (${result.error})` : '';
        return `Error: Failed to fetch logs for job "${jobName}". Status: ${result.status} ${result.statusText}${errorDetail}`;
      }

      // Get log content as text
      const logText = result.text || '';

      if (debug) {
        this.outputChannel.appendLine(
          `[Job Logs] Fetch succeeded: bytes=${
            logText?.length ?? 0
          } jobId=${jobId} jobName="${jobName}"`
        );
      }

      if (!logText || logText.trim().length === 0) {
        return `No logs available for job "${jobName}".`;
      }

      // If step number is specified, extract only that step's logs
      if (stepNumber !== undefined) {
        const stepLog = extractStepLogs(logText, stepNumber, stepName);
        if (stepLog) {
          return stepLog.content;
        }
        // If step extraction failed, return a helpful message
        const stepIdentifier = stepName
          ? `"${stepName}" (step ${stepNumber})`
          : `step ${stepNumber}`;
        return `Could not extract logs for ${stepIdentifier} from job "${jobName}".\n\nThis may happen if:\n- The step has not started yet\n- The step number is invalid\n- The log format is unexpected\n\nFull job logs are available by viewing the job logs directly.`;
      }

      // Parse logs (keeps ANSI codes intact)
      const parsedLog = parseJobLogs(logText);

      return parsedLog.content;
    } catch (error) {
      console.error('Error loading job logs:', error);
      try {
        const cfg = vscode.workspace.getConfiguration('githubWorkflowRunner');
        const debug = cfg.get<boolean>('logs.debug', false);
        if (debug) {
          this.outputChannel.appendLine(
            `[Job Logs] Error loading logs: ${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }`
          );
        }
      } catch {
        // ignore secondary errors
      }
      return `Error loading logs: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Refresh a specific log document
   */
  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  /**
   * Dispose of the provider
   */
  dispose(): void {
    this._onDidChange.dispose();
  }
}
