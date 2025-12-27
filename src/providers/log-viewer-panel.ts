/**
 * Log Viewer Panel - Webview panel for displaying workflow logs with collapsible groups
 * Similar to GitHub's native log viewing UI with expand/collapse functionality
 */
import * as vscode from 'vscode';
import { getNonce } from '../utils/get-nonce';
import { getRepositoryInfo } from '../utils/git-operations';
import { TokenManager } from '../utils/token-manager';
import { getWorkflowJob } from '../api/workflow-monitor';
import { buildLogURI } from '../utils/log-uri-scheme';

export interface LogViewerOptions {
  jobId: number;
  jobName: string;
  runId: number;
  stepNumber?: number;
  stepName?: string;
}

/**
 * Step data for display in log viewer
 * Includes timestamps for timestamp-based log grouping
 */
interface StepDisplayData {
  number: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
  duration?: number;
  startedAt?: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
}

export class LogViewerPanel {
  public static currentPanel: LogViewerPanel | undefined;
  public static readonly viewType = 'github-workflow-log-viewer';

  /**
   * Maximum log size in bytes before warning user (50MB)
   * Large logs can cause memory issues and UI freezing
   */
  private static readonly MAX_LOG_SIZE_WARNING = 50 * 1024 * 1024;

  /**
   * Maximum log size in bytes before truncation (100MB)
   * Prevents out-of-memory errors with extremely large logs
   */
  private static readonly MAX_LOG_SIZE_LIMIT = 100 * 1024 * 1024;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _options: LogViewerOptions;
  private _isDisposing = false; // Prevent double-dispose

  /**
   * Create or show the log viewer panel
   */
  public static async createOrShow(
    extensionUri: vscode.Uri,
    options: LogViewerOptions
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    // If panel exists but for different job/step, dispose and create new
    if (LogViewerPanel.currentPanel) {
      const current = LogViewerPanel.currentPanel._options;
      const isSame = current.jobId === options.jobId && current.stepNumber === options.stepNumber;
      if (!isSame) {
        LogViewerPanel.currentPanel.dispose();
      } else {
        LogViewerPanel.currentPanel._panel.reveal(column);
        return;
      }
    }

    const title = options.stepName ? `Logs: ${options.stepName}` : `Logs: ${options.jobName}`;

    const panel = vscode.window.createWebviewPanel(LogViewerPanel.viewType, title, column, {
      enableScripts: true,
      localResourceRoots: [extensionUri],
      retainContextWhenHidden: true,
    });

    LogViewerPanel.currentPanel = new LogViewerPanel(panel, extensionUri, options);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    options: LogViewerOptions
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._options = options;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      this._handleMessage.bind(this),
      null,
      this._disposables
    );
  }

  public dispose() {
    // Prevent double-dispose which can cause errors
    if (this._isDisposing) {
      return;
    }
    this._isDisposing = true;

    LogViewerPanel.currentPanel = undefined;

    // Clear raw logs to free memory
    this._rawLogs = '';
    this._repoInfo = null;

    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  // Store raw logs for download functionality
  private _rawLogs: string = '';
  private _repoInfo: { owner: string; name: string } | null = null;

  /**
   * Handle messages from the webview
   */
  private async _handleMessage(message: { type: string; data?: unknown; url?: string }) {
    switch (message.type) {
      case 'webviewReady':
        await this._loadAndSendLogs();
        break;
      case 'refresh':
        await this._loadAndSendLogs();
        break;
      case 'viewRawLogs':
        await this._viewRawLogs();
        break;
      case 'downloadLogs':
        await this._downloadLogs();
        break;
      case 'openUrl':
        // Open external URL in user's default browser
        if (message.url) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
    }
  }

  /**
   * Open raw logs in VSCode text editor
   */
  private async _viewRawLogs(): Promise<void> {
    try {
      if (!this._repoInfo) {
        this._repoInfo = await getRepositoryInfo();
      }
      if (!this._repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      const logUri = buildLogURI(
        this._options.jobName,
        this._repoInfo.owner,
        this._repoInfo.name,
        this._options.jobId,
        this._options.runId
      );

      const doc = await vscode.workspace.openTextDocument(logUri);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open raw logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Download logs as a text file
   */
  private async _downloadLogs(): Promise<void> {
    try {
      if (!this._rawLogs) {
        vscode.window.showErrorMessage('No logs available to download');
        return;
      }

      // Generate filename
      const stepPart = this._options.stepName ? `-step-${this._options.stepNumber}` : '';
      const sanitizedJobName = this._options.jobName.replace(/[^a-zA-Z0-9-_]/g, '_');
      const filename = `job-${this._options.jobId}${stepPart}-${sanitizedJobName}.txt`;

      // Show save dialog
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(filename),
        filters: { 'Text files': ['txt'], 'All files': ['*'] },
        title: 'Save Logs',
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(this._rawLogs, 'utf8'));
        vscode.window.showInformationMessage(`Logs saved to ${uri.fsPath}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to save logs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Load logs from GitHub API and send to webview.
   * Includes safety checks for large log files to prevent memory issues.
   */
  private async _loadAndSendLogs(): Promise<void> {
    try {
      // Early return if panel is being disposed
      if (this._isDisposing) {
        return;
      }

      this._repoInfo = await getRepositoryInfo();
      if (!this._repoInfo) {
        this._sendError('Could not get repository information');
        return;
      }

      // Fetch logs and job details in parallel
      const [logs, job] = await Promise.all([
        this._fetchJobLogs(this._repoInfo.owner, this._repoInfo.name, this._options.jobId),
        getWorkflowJob(this._repoInfo.owner, this._repoInfo.name, this._options.jobId),
      ]);

      if (!logs) {
        this._sendError('Could not fetch logs');
        return;
      }

      // Safety check: warn for very large logs
      const logSize = Buffer.byteLength(logs, 'utf8');
      let processedLogs = logs;

      if (logSize > LogViewerPanel.MAX_LOG_SIZE_LIMIT) {
        // Truncate extremely large logs to prevent crashes
        vscode.window.showWarningMessage(
          `Log file is very large (${Math.round(logSize / 1024 / 1024)}MB). ` +
            `Truncating to prevent memory issues. Use "View Raw Logs" for full content.`
        );
        // Keep first 90MB and last 10MB to preserve both start and end of logs
        const keepStart = 90 * 1024 * 1024;
        const keepEnd = 10 * 1024 * 1024;
        const truncationMarker = '\n\n... [LOG TRUNCATED - File too large] ...\n\n';
        processedLogs =
          logs.substring(0, keepStart) + truncationMarker + logs.substring(logs.length - keepEnd);
      } else if (logSize > LogViewerPanel.MAX_LOG_SIZE_WARNING) {
        vscode.window.showInformationMessage(
          `Log file is large (${Math.round(logSize / 1024 / 1024)}MB). ` +
            `Consider using "View Raw Logs" for better performance.`
        );
      }

      // Store raw logs for download (original, not truncated)
      this._rawLogs = logs;

      // Convert job steps to display format with duration and timestamps
      const steps: StepDisplayData[] = (job?.steps || []).map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        duration:
          step.started_at && step.completed_at
            ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
            : undefined,
        startedAt: step.started_at,
        completedAt: step.completed_at,
      }));

      this._panel.webview.postMessage({
        type: 'logsLoaded',
        data: {
          logs: processedLogs,
          jobId: this._options.jobId,
          jobName: this._options.jobName,
          stepNumber: this._options.stepNumber,
          stepName: this._options.stepName,
          steps,
          isTruncated: processedLogs !== logs,
        },
      });
    } catch (error) {
      this._sendError(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Fetch job logs from GitHub API
   */
  private async _fetchJobLogs(owner: string, repo: string, jobId: number): Promise<string | null> {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      throw new Error('Not authenticated with GitHub');
    }

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
        throw new Error('Redirect without location header');
      }
      const logResponse = await fetch(redirectUrl);
      if (!logResponse.ok) {
        throw new Error(`Failed to fetch logs: ${logResponse.status}`);
      }
      return await logResponse.text();
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Logs not found. The job may not have started yet.');
      }
      if (response.status === 410) {
        throw new Error('Logs have expired and are no longer available.');
      }
      throw new Error(`Failed to fetch logs: ${response.status}`);
    }

    return await response.text();
  }

  private _sendError(message: string): void {
    this._panel.webview.postMessage({ type: 'error', data: { message } });
  }

  /**
   * Generate HTML for the webview
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'log-viewer.js');
    const scriptUri = webview.asWebviewUri(scriptPath);
    const cacheBuster = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const scriptUriWithCacheBust = `${scriptUri}?v=${cacheBuster}`;
    const nonce = getNonce();
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="${codiconsUri}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitHub Actions Logs</title>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}">const vscode = acquireVsCodeApi(); window.vscode = vscode;</script>
    <script nonce="${nonce}" src="${scriptUriWithCacheBust}"></script>
    <script nonce="${nonce}">
        setTimeout(() => {
            try {
                const Component = typeof SvelteApp !== 'undefined' ? SvelteApp : window.SvelteApp;
                const mount = window.svelteMount;
                if (Component && mount) {
                    mount(Component, { target: document.getElementById('app'), props: {} });
                    vscode.postMessage({ type: 'webviewReady' });
                }
            } catch (error) { console.error('Error mounting LogViewer:', error); }
        }, 10);
    </script>
</body>
</html>`;
  }
}
