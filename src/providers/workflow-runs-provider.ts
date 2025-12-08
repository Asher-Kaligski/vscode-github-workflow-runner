/**
 * Workflow runs webview provider for monitoring
 */
import * as vscode from 'vscode';
import { getNonce } from '../utils/get-nonce';
import { getConfig } from '../utils/config';
import {
  getWorkflowRuns,
  getWorkflowRunJobs,
  cancelWorkflowRun,
  rerunWorkflowRun,
  rerunFailedJobs,
} from '../api/workflow-monitor';
import type { WebviewMessage, ExtensionConfig } from '../types/workflow-types';

export class WorkflowRunsProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _refreshInterval?: NodeJS.Timeout;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Resolve webview view
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this._handleMessage(message);
    });

    // Start auto-refresh if enabled
    const config = getConfig();
    if (config.monitoring.autoRefresh) {
      this._startAutoRefresh(config.monitoring.refreshInterval);
    }

    // Stop auto-refresh when view is hidden
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        this._stopAutoRefresh();
      } else if (config.monitoring.autoRefresh) {
        this._startAutoRefresh(config.monitoring.refreshInterval);
      }
    });
  }

  /**
   * Handle messages from webview
   */
  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case 'getWorkflowRuns':
        await this._sendWorkflowRuns(message.data as any);
        break;

      case 'refreshWorkflowRuns':
        await this._sendWorkflowRuns(message.data as any);
        break;

      case 'openWorkflowRun':
        await this._openWorkflowRun(message.data as number);
        break;

      case 'cancelWorkflowRun':
        await this._cancelWorkflowRun(message.data as number);
        break;

      case 'rerunWorkflowRun':
        await this._rerunWorkflowRun(message.data as number);
        break;

      case 'rerunFailedJobs':
        await this._rerunFailedJobs(message.data as number);
        break;
    }
  }

  /**
   * Send workflow runs to webview
   */
  private async _sendWorkflowRuns(options?: {
    workflowId?: number;
    branch?: string;
    status?: string;
  }) {
    const config = getConfig();
    const result = await getWorkflowRuns(config.repository.owner, config.repository.name, {
      ...options,
      perPage: config.monitoring.maxRuns,
    });

    this._view?.webview.postMessage({
      type: 'getWorkflowRuns',
      success: !!result,
      data: result,
    });
  }

  /**
   * Open workflow run in browser
   */
  private async _openWorkflowRun(runId: number) {
    const config = getConfig();
    const url = `https://github.com/${config.repository.owner}/${config.repository.name}/actions/runs/${runId}`;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Cancel workflow run
   */
  private async _cancelWorkflowRun(runId: number) {
    const config = getConfig();
    const success = await cancelWorkflowRun(config.repository.owner, config.repository.name, runId);

    if (success) {
      vscode.window.showInformationMessage('Workflow run cancelled');
      await this._sendWorkflowRuns();
    } else {
      vscode.window.showErrorMessage('Failed to cancel workflow run');
    }
  }

  /**
   * Rerun workflow run
   */
  private async _rerunWorkflowRun(runId: number) {
    const config = getConfig();
    const success = await rerunWorkflowRun(config.repository.owner, config.repository.name, runId);

    if (success) {
      vscode.window.showInformationMessage('Workflow run restarted');
      await this._sendWorkflowRuns();
    } else {
      vscode.window.showErrorMessage('Failed to rerun workflow');
    }
  }

  /**
   * Rerun failed jobs
   */
  private async _rerunFailedJobs(runId: number) {
    const config = getConfig();
    const success = await rerunFailedJobs(config.repository.owner, config.repository.name, runId);

    if (success) {
      vscode.window.showInformationMessage('Failed jobs restarted');
      await this._sendWorkflowRuns();
    } else {
      vscode.window.showErrorMessage('Failed to rerun failed jobs');
    }
  }

  /**
   * Start auto-refresh
   */
  private _startAutoRefresh(intervalSeconds: number) {
    this._stopAutoRefresh();

    this._refreshInterval = setInterval(() => {
      if (this._view?.visible) {
        this._sendWorkflowRuns();
      }
    }, intervalSeconds * 1000);
  }

  /**
   * Stop auto-refresh
   */
  private _stopAutoRefresh() {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
  }

  /**
   * Notify webview of config change
   */
  public notifyConfigChange(config: ExtensionConfig) {
    // Update auto-refresh settings
    if (config.monitoring.autoRefresh) {
      this._startAutoRefresh(config.monitoring.refreshInterval);
    } else {
      this._stopAutoRefresh();
    }

    this._view?.webview.postMessage({
      type: 'info',
      success: true,
      data: { message: 'Configuration updated', config },
    });
  }

  /**
   * Refresh webview
   */
  public refresh() {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  /**
   * Highlight a newly dispatched run
   */
  public highlightRun(runId: number) {
    this._view?.webview.postMessage({
      type: 'highlightRun',
      success: true,
      data: { runId },
    });
  }

  /**
   * Get HTML for webview
   */
  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    // Get path to bundled Svelte app
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'workflow-runs.js')
    );

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <title>Workflow Runs</title>
        </head>
        <body>
            <div id="app"></div>
            <script nonce="${nonce}">
                // Acquire VS Code API
                const vscode = acquireVsCodeApi();
                window.vscode = vscode;
            </script>
            <script nonce="${nonce}" src="${scriptUri}"></script>
            <script nonce="${nonce}">
                // Instantiate the Svelte component
                if (typeof app !== 'undefined') {
                    new app({ target: document.getElementById('app') });
                }
            </script>
        </body>
        </html>`;
  }
}
