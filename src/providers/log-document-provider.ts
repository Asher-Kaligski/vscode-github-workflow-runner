/**
 * Log Document Provider for workflow job logs
 * Implements TextDocumentContentProvider to display logs in VSCode's native text editor
 * Based on the official GitHub Actions extension approach
 */
import * as vscode from 'vscode';
import { parseLogURI } from '../utils/log-uri-scheme';
import { parseJobLogs } from '../utils/log-parser';
import { TokenManager } from '../utils/token-manager';

export class LogDocumentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly outputChannel = vscode.window.createOutputChannel(
    'GitHub Actions Runner (Logs)'
  );

  /**
   * Provide text document content for a log URI
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { owner, repo, jobName, jobId } = parseLogURI(uri);

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

      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        if (debug) {
          this.outputChannel.appendLine(
            `[Job Logs] Fetch failed: status=${response.status} ${response.statusText} url=${url}`
          );
        }
        if (response.status === 410) {
          return `Logs for job "${jobName}" have expired and are no longer available.`;
        }
        if (response.status === 404) {
          return `Logs not found for job "${jobName}" (404). This can happen if logs are not yet generated, the job ID is from a different repository, or the logs have been pruned. Try again shortly or open the run in GitHub to confirm.`;
        }
        return `Error: Failed to fetch logs for job "${jobName}". Status: ${response.status} ${response.statusText}`;
      }

      // Get log content as text
      const logText = await response.text();

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
