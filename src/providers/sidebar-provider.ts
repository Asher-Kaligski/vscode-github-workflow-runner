/**
 * Sidebar webview provider for workflow dispatch
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { dispatchWorkflowWithRunId } from '../api/workflow-dispatcher';
import type {
  AddFileFavoriteMessage,
  ExtensionConfig,
  FileContentConfig,
  GetFileSuggestionsMessage,
  GetSmartFileInputDataMessage,
  OpenFileInEditorMessage,
  ParseFileForSelectionMessage,
  RemoveFileFavoriteMessage,
  SaveValueFavoritesMessage,
  TrackRecentFileMessage,
  UpdateFileFavoriteMessage,
  WebviewMessage,
  WorkflowDefinition,
} from '../types/workflow-types';
import { isAuthenticated, signOut } from '../utils/authenticate';
import { setActiveWorkspacePath } from '../utils/active-workspace';
import { getConfig } from '../utils/config';
import { FavoritesManager } from '../utils/favorites-manager';
import { getNonce } from '../utils/get-nonce';
import { SmartFileInputManager } from '../utils/smart-file-input-manager';
import { ensureGitContextValidOrWarn, refreshGitContext } from '../utils/git-context-validation';
import { getCurrentBranch, getRecentBranches, getRepositoryInfo } from '../utils/git-operations';
import { fetchGitHubUserInfo } from '../utils/github-user';
import {
  getRepositoryConfig,
  resetRepositoryConfig,
  setRepositoryConfig,
} from '../utils/repository-config';
import { Storage } from '../utils/storage';
import { TokenManager } from '../utils/token-manager';
import { getAllWorkflowDefinitions, getWorkflowDefinition } from '../utils/workflow-parser';
import { getAllWorkspaceRepos } from '../utils/git-operations';
import { WorkflowRunsPanel } from './workflow-runs-panel';
import type { WorkflowRunsProvider } from './workflow-runs-provider';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _workflowRunsProvider?: WorkflowRunsProvider;
  private _isWebviewReady = false;
  private _readyPromise: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;
  /** Path of the workspace folder currently selected in the repo switcher. */
  private _activeWorkspacePath: string | undefined = undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * Set workflow runs provider for highlighting dispatched runs
   */
  public setWorkflowRunsProvider(provider: WorkflowRunsProvider) {
    this._workflowRunsProvider = provider;
  }

  /**
   * Check if the webview is ready to receive messages.
   */
  public isReady(): boolean {
    const hasView = this._view !== undefined;
    const isVisible = !!this._view?.visible;
    const ready = this._isWebviewReady && hasView && isVisible;
    console.log('[SidebarProvider] isReady check:', {
      _isWebviewReady: this._isWebviewReady,
      hasView,
      isVisible,
      result: ready,
    });
    return ready;
  }

  /**
   * Reset the ready state. This should be called before showing the sidebar
   * to ensure we wait for the webview to be fully loaded.
   */
  public resetReadyState() {
    console.log('[SidebarProvider] resetReadyState called');
    this._isWebviewReady = false;
    this._readyPromise = null;
    this._readyResolve = null;
  }

  /**
   * Wait until the sidebar webview has signalled that it is ready to
   * receive messages. Returns immediately if already ready.
   */
  public async waitForWebviewReady(): Promise<void> {
    console.log('[SidebarProvider] waitForWebviewReady called:', {
      hasView: this._view !== undefined,
      isReady: this._isWebviewReady,
    });

    // If no view exists, we can't wait for it
    if (!this._view) {
      console.error('[SidebarProvider] No view exists!');
      throw new Error('Webview view not initialized');
    }

    // If already ready, return immediately
    if (this._isWebviewReady) {
      console.log('[SidebarProvider] Already ready, returning immediately');
      return;
    }

    // Create a promise that will be resolved when webviewReady message arrives
    if (!this._readyPromise) {
      console.log('[SidebarProvider] Creating promise to wait for webviewReady');
      this._readyPromise = new Promise<void>((resolve) => {
        this._readyResolve = resolve;
      });
    }

    return this._readyPromise;
  }

  /**
   * Send a prefillDispatch message to the sidebar webview. Assumes the
   * webview is already ready; callers should await waitForWebviewReady().
   */
  public prefillDispatch(data: {
    workflowFilename: string;
    branch: string;
    inputs: Record<string, string>;
    runId?: number;
  }) {
    console.log('[SidebarProvider] prefillDispatch called:', {
      hasView: this._view !== undefined,
      workflowFilename: data.workflowFilename,
      branch: data.branch,
      inputsCount: Object.keys(data.inputs || {}).length,
    });

    if (!this._view) {
      console.error('[SidebarProvider] No view exists, cannot send message');
      return;
    }

    this._view.webview.postMessage({
      type: 'prefillDispatch',
      success: true,
      data,
    });
    console.log('[SidebarProvider] prefillDispatch message posted');
  }

  /**
   * Resolve webview view
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    console.log('[SidebarProvider] resolveWebviewView called');
    this._view = webviewView;
    this._isWebviewReady = false;
    this._readyPromise = null;
    this._readyResolve = null;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Handle messages from webview before loading HTML to avoid missing early messages
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this._handleMessage(message);
    });

    // Reset ready state when webview is disposed
    webviewView.onDidDispose(() => {
      console.log('[SidebarProvider] Webview disposed');
      this._isWebviewReady = false;
      this._readyPromise = null;
      this._readyResolve = null;
      this._view = undefined;
    });

    // Load the webview HTML after the message handler is attached
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
  }

  /**
   * Handle messages from webview
   */
  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case 'webviewReady':
        console.log('[SidebarProvider] Received webviewReady message');
        this._isWebviewReady = true;
        if (this._readyResolve) {
          console.log('[SidebarProvider] Resolving ready promise');
          this._readyResolve();
          this._readyResolve = null;
          this._readyPromise = null;
        } else {
          console.log('[SidebarProvider] No ready promise to resolve (already ready)');
        }
        break;

      case 'authenticate':
        vscode.commands.executeCommand('github-workflow-runner.authenticate');
        break;

      case 'checkAuth':
        console.log('Sidebar: Received checkAuth message');
        const isAuth = await isAuthenticated();
        console.log('Sidebar: Authentication status:', isAuth);
        this._view?.webview.postMessage({
          type: 'checkAuth',
          success: true,
          data: { authenticated: isAuth },
        });
        break;

      case 'signOut':
        console.log('Sidebar: Received signOut message');
        await signOut();
        console.log('Sidebar: Sign out completed, sending confirmation to webview');
        // Send confirmation back to webview to update UI
        this._view?.webview.postMessage({
          type: 'signOut',
          success: true,
        });
        console.log('Sidebar: Confirmation message sent');
        break;

      case 'getUserInfo':
        await this._sendUserInfo();
        break;

      case 'getWorkspaceFolders':
        await this._sendWorkspaceFolders();
        break;

      case 'setActiveWorkspace': {
        const folderPath = message.data as string | undefined;
        this._activeWorkspacePath = folderPath || undefined;
        // Share the selection so other parts of the extension (e.g. the
        // Workflow Runs panel) resolve the repository against the chosen
        // workspace instead of falling back to the first workspace folder.
        setActiveWorkspacePath(this._activeWorkspacePath);
        // Reload all data for the newly selected workspace
        await this._reloadExtensionData();
        break;
      }

      case 'getRepositoryConfig':
        await this._sendRepositoryConfig();
        break;

      case 'setRepositoryConfig':
        await this._setRepositoryConfig(message.data as { owner: string; name: string });
        break;

      case 'resetRepositoryConfig':
        await this._resetRepositoryConfig();
        break;

      case 'getWorkflows':
        await this._sendWorkflows();
        break;

      case 'getWorkflowSchema':
        await this._sendWorkflowSchema(message.data as string);
        break;

      case 'dispatchWorkflow':
        await this._dispatchWorkflow(message.data as any);
        break;

      case 'getCurrentBranch':
        await this._sendCurrentBranch();
        break;

      case 'getDefaultBranch':
        await this._sendDefaultBranch();
        break;

      case 'getRecentBranches':
        await this._sendRecentBranches();
        break;

      case 'saveTemplate':
        await this._saveTemplate(message.data as any);
        break;

      case 'getTemplates':
        await this._sendTemplates(message.data as string);
        break;

      case 'deleteTemplate':
        await this._deleteTemplate(message.data as string);
        break;

      case 'updateTemplate':
        await this._updateTemplate(
          message.data as {
            id: string;
            updates: Partial<{
              name: string;
              inputs: Record<string, string>;
              branch: string;
            }>;
          }
        );
        break;

      case 'getHistory':
        await this._sendHistory(message.data as string);
        break;

      case 'getWorkflowConfig':
        await this._sendWorkflowConfig(message.data as string);
        break;

      case 'setWorkflowConfig':
        await this._setWorkflowConfig(
          message.data as { workflowFilename: string; artifactPattern?: string }
        );
        break;

      case 'exportPreset':
        await this._exportPreset(message.data as string);
        break;

      case 'importPreset':
        await this._importPreset();
        break;

      case 'getStorageInfo':
        await this._sendStorageInfo();
        break;

      case 'openWorkflowRuns':
        // Pass workflow name and filter options if provided
        const workflowData = message.data as
          | {
              workflowName?: string;
              actorFilter?: string;
              showBotRuns?: boolean;
            }
          | undefined;
        if (
          workflowData?.workflowName ||
          workflowData?.actorFilter ||
          workflowData?.showBotRuns !== undefined
        ) {
          // Use smart panel opening logic for "View Last Run" action
          await WorkflowRunsPanel.createOrShowForAction(this._extensionUri, 'viewLastRun', {
            workflowName: workflowData.workflowName,
            actorFilter: workflowData.actorFilter,
            showBotRuns: workflowData.showBotRuns,
          });
        } else {
          vscode.commands.executeCommand('github-workflow-runner.showWorkflowRuns');
        }
        break;

      case 'addFavorite':
        await this._addFavorite(message.data as any);
        break;

      case 'removeFavorite':
        await this._removeFavorite(message.data as { id: string });
        break;

      case 'updateFavorite':
        await this._updateFavorite(message.data as any);
        break;

      case 'getFavorites':
        await this._sendFavorites(message.data as any);
        break;

      case 'getRepositoryFavorites':
        await this._sendRepositoryFavorites();
        break;

      case 'saveRepositoryFavorites':
        await this._saveRepositoryFavorites(
          message.data as {
            repositories: Array<{ owner: string; name: string }>;
          }
        );
        break;

      case 'dispatchFavorite':
        await this._dispatchFavorite(message.data as any);
        break;

      case 'selectFile':
        await this._selectFile(message.data as any);
        break;

      case 'readFileContent':
        await this._readFileContent(message.data as any);
        break;

      case 'validateFilePath':
        await this._validateFilePath(message.data as any);
        break;

      case 'openExternalUrl': {
        const url = message.data as string;
        if (url) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }

      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'githubWorkflowRunner');
        break;

      case 'openWorkflowFile': {
        const { filePath } = (message.data || {}) as { filePath: string };
        if (filePath) {
          await this._openWorkflowFile(filePath);
        }
        break;
      }

      case 'reloadExtensionData':
        await this._reloadExtensionData();
        break;

      // SmartFileInput message handlers
      case 'getSmartFileInputData':
        await this._getSmartFileInputData(message.data as GetSmartFileInputDataMessage);
        break;

      case 'addFileFavorite':
        await this._addSmartFileFavorite(message.data as AddFileFavoriteMessage);
        break;

      case 'removeFileFavorite':
        await this._removeSmartFileFavorite(message.data as RemoveFileFavoriteMessage);
        break;

      case 'updateFileFavorite':
        await this._updateSmartFileFavorite(message.data as UpdateFileFavoriteMessage);
        break;

      case 'trackRecentFile':
        await this._trackSmartFileRecent(message.data as TrackRecentFileMessage);
        break;

      case 'getFileSuggestions':
        await this._getFileSuggestions(message.data as GetFileSuggestionsMessage);
        break;

      case 'parseFileForSelection':
        await this._parseFileForSelection(message.data as ParseFileForSelectionMessage);
        break;

      case 'openFileInEditor':
        await this._openFileInEditor(message.data as OpenFileInEditorMessage);
        break;

      case 'saveValueFavorites':
        await this._saveValueFavorites(message.data as SaveValueFavoritesMessage);
        break;
    }
  }

  /**
   * Reload all extension data after repository/branch change.
   * Re-detects the current repository and branch, refreshes Git context,
   * and reloads all sidebar data (workflows, repository config, branches, etc.)
   *
   * This is a public wrapper for _reloadExtensionData that can be called from
   * commands or other parts of the extension.
   */
  public async reloadExtensionData(): Promise<void> {
    return this._reloadExtensionData();
  }

  /**
   * Reload all extension data after repository/branch change.
   * Re-detects the current repository and branch, refreshes Git context,
   * and reloads all sidebar data (workflows, repository config, branches, etc.)
   */
  private async _reloadExtensionData() {
    try {
      console.log('[SidebarProvider] Reloading extension data...');

      // Refresh and store the new Git context
      const newContext = await refreshGitContext(this._activeWorkspacePath);
      console.log('[SidebarProvider] New Git context:', newContext);

      // Re-send repository config
      await this._sendRepositoryConfig();

      // Re-send workflows list
      await this._sendWorkflows();

      // Re-send current branch
      await this._sendCurrentBranch();

      // Re-send recent branches
      await this._sendRecentBranches();

      // Re-send user info (in case it changed)
      await this._sendUserInfo();

      // Re-send default branch
      await this._sendDefaultBranch();

      // Notify webview that reload is complete
      this._view?.webview.postMessage({
        type: 'reloadExtensionDataResponse',
        success: true,
        data: {
          message: 'Extension data reloaded successfully',
          gitContext: newContext,
        },
      });

      vscode.window.showInformationMessage(
        '✅ GitHub Workflow Runner: Extension data reloaded successfully'
      );
    } catch (error) {
      console.error('[SidebarProvider] Error reloading extension data:', error);
      this._view?.webview.postMessage({
        type: 'reloadExtensionDataResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      vscode.window.showErrorMessage(
        `❌ Failed to reload extension data: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Open workflow file in editor
   */
  private async _openWorkflowFile(filePath: string) {
    try {
      const repoInfo = await getRepositoryInfo(this._activeWorkspacePath);
      if (!repoInfo) {
        vscode.window.showErrorMessage('Could not get repository information');
        return;
      }

      const rootPath = this._activeWorkspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const fullPath = vscode.Uri.joinPath(vscode.Uri.file(rootPath), filePath);

      try {
        await vscode.workspace.fs.stat(fullPath);
      } catch {
        vscode.window.showErrorMessage(`Workflow file not found: ${filePath}`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open workflow file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Send workflows to webview
   */
  private async _sendWorkflows() {
    const config = getConfig();
    const workflows = await getAllWorkflowDefinitions(
      config.workflows.excludePatterns,
      this._activeWorkspacePath
    );

    this._view?.webview.postMessage({
      type: 'getWorkflows',
      success: true,
      data: workflows,
    });
  }

  /**
   * Send workflow schema to webview
   */
  private async _sendWorkflowSchema(filename: string) {
    const workflow = await getWorkflowDefinition(filename, this._activeWorkspacePath);

    this._view?.webview.postMessage({
      type: 'getWorkflowSchema',
      success: !!workflow,
      data: workflow,
    });
  }

  /**
   * Ask the sidebar webview to confirm a workflow dispatch with a rich
   * parameters layout. This uses the webview's custom modal so we can mirror
   * the styling of the Workflow Runs Parameters modal.
   */
  private async _requestDispatchConfirmation(data: {
    workflowName: string;
    workflowFilename: string;
    branch: string;
    inputs: Record<string, string>;
  }): Promise<{ confirmed: boolean; addToWatchList: boolean } | undefined> {
    if (!this._view) {
      return undefined;
    }

    return new Promise((resolve) => {
      const webview = this._view!.webview;
      const disposables: vscode.Disposable[] = [];

      const cleanup = () => {
        for (const d of disposables) {
          try {
            d.dispose();
          } catch {
            // Ignore dispose errors
          }
        }
        disposables.length = 0;
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, 60_000);

      const listener = (message: WebviewMessage) => {
        if (message.type !== 'confirmDispatchResult') {
          return;
        }

        clearTimeout(timeout);
        cleanup();
        const result = (message.data ?? {}) as {
          confirmed?: boolean;
          addToWatchList?: boolean;
        };
        resolve({
          confirmed: !!result.confirmed,
          addToWatchList: !!result.addToWatchList,
        });
      };

      disposables.push(webview.onDidReceiveMessage(listener));

      webview.postMessage({
        type: 'confirmDispatch',
        data,
      });
    });
  }

  /**
   * Dispatch workflow
   */
  private async _dispatchWorkflow(data: {
    workflowFilename: string;
    branch: string;
    inputs: Record<string, string>;
    // NOTE: addToWatchList is no longer controlled by the sidebar UI. The
    // watch-list opt-in is handled in the extension host confirmation dialog
    // (dispatch modal) via a webview-based confirmation flow.
    addToWatchList?: boolean;
  }) {
    try {
      // Validate Git context before any GitHub API operation
      const isValidContext = await ensureGitContextValidOrWarn(
        'dispatchWorkflow',
        this._activeWorkspacePath
      );
      if (!isValidContext) {
        this._view?.webview.postMessage({
          type: 'gitContextMismatch',
          success: false,
          error: 'Repository or branch has changed. Please reload the extension data.',
        });
        return;
      }

      const config = getConfig();
      const repoConfig = await getRepositoryConfig(this._activeWorkspacePath);
      const workflow = await getWorkflowDefinition(data.workflowFilename, this._activeWorkspacePath);

      if (!workflow) {
        throw new Error('Workflow not found');
      }

      // Validate repository config
      if (!repoConfig.owner || !repoConfig.name) {
        throw new Error(
          'Repository not configured. Please set repository owner and name in the sidebar.'
        );
      }

      // Determine whether we should prompt in the webview before dispatch.
      let addToWatchList = false;
      if (config.ui.confirmBeforeDispatch) {
        const confirmation = await this._requestDispatchConfirmation({
          workflowName: workflow.name,
          workflowFilename: workflow.filename,
          branch: data.branch,
          inputs: data.inputs,
        });

        if (!confirmation || !confirmation.confirmed) {
          // User cancelled the dispatch - send cancelled message to webview
          this._view?.webview.postMessage({
            type: 'cancelled',
            success: false,
            data: {
              message: 'Workflow dispatch cancelled',
            },
          });
          return;
        }

        addToWatchList = confirmation.addToWatchList;
      }

      const result = await dispatchWorkflowWithRunId(repoConfig.owner, repoConfig.name, workflow, {
        ref: data.branch,
        inputs: data.inputs,
      });

      if (result.success) {
        // Save to history
        await Storage.addToHistory({
          workflowFilename: data.workflowFilename,
          workflowName: workflow.name,
          inputs: data.inputs,
          branch: data.branch,
          // Link this history entry to the created run when available
          runId: result.runId,
        });

        // Save as last workflow
        if (config.ui.rememberLastWorkflow) {
          await Storage.saveLastWorkflow(data);
        }

        // Show success notification (without button - use sidebar button instead)
        vscode.window.showInformationMessage(
          `✅ Workflow "${workflow.name}" dispatched successfully on branch "${data.branch}"`
        );

        // Send success message with run info to webview
        this._view?.webview.postMessage({
          type: 'success',
          success: true,
          data: {
            message: 'Workflow dispatched successfully',
            workflowName: workflow.name,
            branch: data.branch,
            runId: result.runId,
          },
        });

        // Add to watch list if requested in the confirmation modal and we
        // were able to resolve a runId.
        if (addToWatchList && result.runId) {
          const error = await Storage.watchRun(result.runId, repoConfig.owner, repoConfig.name);
          if (error) {
            vscode.window.showWarningMessage(`⚠️ Failed to add run to watch list: ${error}`);
          } else {
            // Keep the Workflow Runs panel's in-memory watchedRuns set in
            // sync so that "Watched Runs Only" reflects newly watched runs
            // immediately without requiring a panel reload.
            WorkflowRunsPanel.notifyRunWatched(result.runId);
          }
        }

        // Auto-open workflow runs panel with smart logic
        await WorkflowRunsPanel.createOrShowForAction(this._extensionUri, 'dispatch', {
          workflowName: workflow.filename, // Use filename for consistent comparison with filter
          actorFilter: 'all', // Default to "All Users" for dispatch actions
          showBotRuns: false,
          runId: result.runId,
        });

        // Highlight the newly dispatched run if runId is available
        if (result.runId) {
          // Highlight in both the panel and the sidebar provider
          WorkflowRunsPanel.highlightRun(result.runId);
          if (this._workflowRunsProvider) {
            this._workflowRunsProvider.highlightRun(result.runId);
          }
        }
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Send current branch to webview
   */
  private async _sendCurrentBranch() {
    const branch = await getCurrentBranch(this._activeWorkspacePath);

    this._view?.webview.postMessage({
      type: 'getCurrentBranch',
      success: true,
      data: branch,
    });
  }

  /**
   * Try to detect the repository's default branch from GitHub API.
   * Falls back to undefined if repository info or token are unavailable.
   */
  private async _fetchDefaultBranchFromGitHub(): Promise<string | undefined> {
    try {
      const repoConfig = await getRepositoryConfig(this._activeWorkspacePath);

      const owner = repoConfig.owner?.trim();
      const name = repoConfig.name?.trim();

      if (!owner || !name) {
        return undefined;
      }

      const token = await TokenManager.getGithubToken();
      if (!token) {
        return undefined;
      }

      const url = `https://api.github.com/repos/${owner}/${name}`;
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        console.error(
          'Sidebar: Failed to auto-detect default branch from GitHub:',
          response.status,
          response.statusText
        );
        return undefined;
      }

      const data = (await response.json()) as { default_branch?: string };
      const defaultBranch = (data.default_branch ?? '').trim();
      return defaultBranch || undefined;
    } catch (error) {
      console.error('Sidebar: Error auto-detecting default branch:', error);
      return undefined;
    }
  }

  /**
   * Send default branch to webview.
   * Prefers GitHub auto-detected default branch, falls back to config setting.
   */
  private async _sendDefaultBranch() {
    try {
      let defaultBranch = await this._fetchDefaultBranchFromGitHub();

      if (!defaultBranch) {
        const config: ExtensionConfig = getConfig();
        const configured = (config.defaultBranch ?? '').trim();
        defaultBranch = configured || undefined;
      }

      this._view?.webview.postMessage({
        type: 'getDefaultBranch',
        success: !!defaultBranch,
        data: defaultBranch,
      });
    } catch (error) {
      console.error('Sidebar: Failed to send default branch:', error);
      this._view?.webview.postMessage({
        type: 'getDefaultBranch',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get default branch',
      });
    }
  }

  /**
   * Send recent branches to webview
   */
  private async _sendRecentBranches() {
    const branches = await getRecentBranches(10, this._activeWorkspacePath);

    this._view?.webview.postMessage({
      type: 'getRecentBranches',
      success: true,
      data: branches,
    });
  }

  /**
   * Save template
   */
  private async _saveTemplate(data: {
    name: string;
    workflowFilename: string;
    inputs: Record<string, string>;
    branch: string;
  }) {
    try {
      await Storage.saveTemplate(data);

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Template saved successfully' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Send templates to webview
   */
  private async _sendTemplates(workflowFilename?: string) {
    const templates = workflowFilename
      ? await Storage.getTemplatesForWorkflow(workflowFilename)
      : await Storage.getTemplates();

    this._view?.webview.postMessage({
      type: 'getTemplates',
      success: true,
      data: templates,
    });
  }

  /**
   * Delete template
   */
  private async _deleteTemplate(id: string) {
    try {
      await Storage.deleteTemplate(id);

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Template deleted successfully' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Update template (rename or modify)
   */
  private async _updateTemplate(data: {
    id: string;
    updates: Partial<{
      name: string;
      inputs: Record<string, string>;
      branch: string;
    }>;
  }) {
    try {
      await Storage.updateTemplate(data.id, data.updates);
      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Template updated successfully' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Send history to webview
   */
  private async _sendHistory(workflowFilename?: string) {
    const history = workflowFilename
      ? await Storage.getHistoryForWorkflow(workflowFilename, 10)
      : await Storage.getHistory(10);

    this._view?.webview.postMessage({
      type: 'getHistory',
      success: true,
      data: history,
    });
  }

  /**
   * Dispatch last workflow (called from command)
   */
  public async dispatchLastWorkflow(
    workflow: WorkflowDefinition,
    lastWorkflow: { inputs: Record<string, string>; branch: string }
  ) {
    await this._dispatchWorkflow({
      workflowFilename: workflow.filename,
      branch: lastWorkflow.branch,
      inputs: lastWorkflow.inputs,
    });
  }

  /**
   * Notify webview of config change
   */
  public notifyConfigChange(config: ExtensionConfig) {
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
      // Reset readiness state since we are reloading the webview contents
      this._isWebviewReady = false;
      this._readyPromise = null;
      this._readyResolve = null;

      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  /**
   * Send user info to webview
   */
  private async _sendUserInfo() {
    try {
      const userInfo = await fetchGitHubUserInfo();

      this._view?.webview.postMessage({
        type: 'getUserInfo',
        success: true,
        data: userInfo,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'getUserInfo',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch user info',
      });
    }
  }

  /**
   * Send all workspace folders with their GitHub repo info to the webview.
   */
  private async _sendWorkspaceFolders() {
    try {
      const workspaces = await getAllWorkspaceRepos();
      this._view?.webview.postMessage({
        type: 'getWorkspaceFolders',
        success: true,
        data: {
          workspaces,
          activeWorkspacePath: this._activeWorkspacePath ?? null,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'getWorkspaceFolders',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get workspace folders',
      });
    }
  }

  /**
   * Send repository config to webview
   */
  private async _sendRepositoryConfig() {
    try {
      const repoConfig = await getRepositoryConfig(this._activeWorkspacePath);

      this._view?.webview.postMessage({
        type: 'getRepositoryConfig',
        success: true,
        data: repoConfig,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'getRepositoryConfig',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get repository config',
      });
    }
  }

  /**
   * Set repository config
   */
  private async _setRepositoryConfig(data: { owner: string; name: string }) {
    try {
      await setRepositoryConfig(data.owner, data.name);

      // Send updated config back
      await this._sendRepositoryConfig();

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Repository configuration saved' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save repository config',
      });
    }
  }

  /**
   * Reset repository config to auto-detection
   */
  private async _resetRepositoryConfig() {
    try {
      await resetRepositoryConfig();

      // Send updated config back
      await this._sendRepositoryConfig();

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Repository configuration reset to auto-detection' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset repository config',
      });
    }
  }

  /**
   * Add a favorite
   */
  private async _addFavorite(data: any) {
    try {
      const favorite = await FavoritesManager.addFavorite(data);
      this._view?.webview.postMessage({
        type: 'addFavoriteResponse',
        success: true,
        data: { favorite },
      });
      vscode.window.showInformationMessage('⭐ Workflow added to favorites');
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'addFavoriteResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add favorite',
      });
    }
  }

  /**
   * Remove a favorite
   */
  private async _removeFavorite(data: { id: string }) {
    try {
      await FavoritesManager.removeFavorite(data.id);
      this._view?.webview.postMessage({
        type: 'removeFavoriteResponse',
        success: true,
        data: { id: data.id },
      });
      vscode.window.showInformationMessage('Favorite removed');
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'removeFavoriteResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove favorite',
      });
    }
  }

  /**
   * Update a favorite
   */
  private async _updateFavorite(data: { id: string; updates: any }) {
    try {
      const favorite = await FavoritesManager.updateFavorite(data.id, data.updates);
      this._view?.webview.postMessage({
        type: 'updateFavoriteResponse',
        success: true,
        data: { favorite },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'updateFavoriteResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update favorite',
      });
    }
  }

  /**
   * Send favorites to webview
   */
  private async _sendFavorites(data?: { repository?: { owner: string; name: string } }) {
    try {
      const favorites = await FavoritesManager.getFavorites(data?.repository);
      this._view?.webview.postMessage({
        type: 'getFavoritesResponse',
        success: true,
        data: { favorites },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'getFavoritesResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get favorites',
      });
    }
  }

  /**
   * Send favorite repositories to webview
   */
  private async _sendRepositoryFavorites() {
    try {
      const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
      const repositories = config.get<Array<{ owner: string; name: string }>>(
        'favoriteRepositories',
        []
      );
      this._view?.webview.postMessage({
        type: 'getRepositoryFavoritesResponse',
        success: true,
        data: { repositories },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'getRepositoryFavoritesResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get repository favorites',
      });
    }
  }

  /**
   * Save favorite repositories from webview
   */
  private async _saveRepositoryFavorites(data: {
    repositories: Array<{ owner: string; name: string }>;
  }) {
    try {
      const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
      await config.update(
        'favoriteRepositories',
        data.repositories,
        vscode.ConfigurationTarget.Global
      );
      this._view?.webview.postMessage({
        type: 'saveRepositoryFavoritesResponse',
        success: true,
        data: { repositories: data.repositories },
      });
      vscode.window.showInformationMessage('Repository favorites updated');
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'saveRepositoryFavoritesResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save repository favorites',
      });
    }
  }

  /**
   * Dispatch a favorite workflow
   */
  private async _dispatchFavorite(data: { id: string; overrideInputs?: Record<string, string> }) {
    try {
      const favorites = await FavoritesManager.getFavorites();
      const favorite = favorites.find((f) => f.id === data.id);

      if (!favorite) {
        throw new Error('Favorite not found');
      }

      // Merge saved inputs with overrides
      const inputs = { ...favorite.savedInputs, ...data.overrideInputs };

      // Dispatch the workflow
      await this._dispatchWorkflow({
        workflowFilename: favorite.workflowFilename,
        branch: favorite.branch || '',
        inputs,
      });

      this._view?.webview.postMessage({
        type: 'dispatchFavoriteResponse',
        success: true,
        data: { id: data.id },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'dispatchFavoriteResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to dispatch favorite',
      });
    }
  }

  /**
   * Select a file using VS Code file picker
   */
  private async _selectFile(data: {
    parameterName: string;
    currentPath?: string;
    filters?: any;
    mode?: 'path' | 'content';
  }) {
    try {
      // Determine default URI
      let defaultUri: vscode.Uri | undefined;
      if (data.currentPath) {
        try {
          defaultUri = vscode.Uri.file(data.currentPath);
        } catch {
          // Use workspace root if current path is invalid
          defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        }
      } else {
        defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      }

      // Show file picker
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select File',
        defaultUri,
        filters: data.filters || { 'All Files': ['*'] },
      });

      if (!fileUris || fileUris.length === 0) {
        // User cancelled
        this._view?.webview.postMessage({
          type: 'selectFileResponse',
          success: false,
          data: {
            parameterName: data.parameterName,
            mode: data.mode,
          },
          error: 'File selection cancelled',
        });
        return;
      }

      const fileUri = fileUris[0];
      const stat = await vscode.workspace.fs.stat(fileUri);

      // Check file size
      const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
      const warnThreshold = config.get<number>('filePathDetection.warnSizeThreshold', 1048576); // 1MB
      let warning: string | undefined;
      if (stat.size > warnThreshold) {
        warning = `File size (${(stat.size / 1024 / 1024).toFixed(
          2
        )}MB) exceeds recommended limit of ${(warnThreshold / 1024 / 1024).toFixed(0)}MB`;
      }

      // Get workspace-relative path if possible
      let relativePath: string | undefined;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
      if (workspaceFolder) {
        relativePath = vscode.workspace.asRelativePath(fileUri);
      }

      this._view?.webview.postMessage({
        type: 'selectFileResponse',
        success: true,
        data: {
          parameterName: data.parameterName,
          path: fileUri.fsPath,
          size: stat.size,
          relativePath,
          mode: data.mode,
        },
        warning,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'selectFileResponse',
        success: false,
        data: {
          parameterName: data.parameterName,
          mode: data.mode,
        },
        error: error instanceof Error ? error.message : 'Failed to select file',
      });
    }
  }

  /**
   * Read file content
   */
  private async _readFileContent(data: { path: string; parameterName: string }) {
    try {
      const fileUri = vscode.Uri.file(data.path);
      const stat = await vscode.workspace.fs.stat(fileUri);

      // Check file size limits
      const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
      const maxSize = config.get<number>('filePathDetection.maxFileSize', 10485760); // 10MB
      if (stat.size > maxSize) {
        throw new Error(
          `File size exceeds maximum limit of ${(maxSize / 1024 / 1024).toFixed(0)}MB`
        );
      }

      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(content).toString('utf8');

      const warnThreshold = config.get<number>('filePathDetection.warnSizeThreshold', 1048576);
      let warning: string | undefined;
      if (stat.size > warnThreshold) {
        warning = `Large file (${(stat.size / 1024 / 1024).toFixed(2)}MB) may impact performance`;
      }

      this._view?.webview.postMessage({
        type: 'readFileContentResponse',
        success: true,
        data: {
          parameterName: data.parameterName,
          content: text,
          size: stat.size,
          encoding: 'utf-8',
        },
        warning,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'readFileContentResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read file',
      });
    }
  }

  /**
   * Validate a file path
   */
  private async _validateFilePath(data: { path: string; parameterName: string }) {
    try {
      const fileUri = vscode.Uri.file(data.path);
      const stat = await vscode.workspace.fs.stat(fileUri);

      // Get workspace-relative path if possible
      let relativePath: string | undefined;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
      if (workspaceFolder) {
        relativePath = vscode.workspace.asRelativePath(fileUri);
      }

      this._view?.webview.postMessage({
        type: 'validateFilePathResponse',
        success: true,
        data: {
          parameterName: data.parameterName,
          exists: true,
          isFile: stat.type === vscode.FileType.File,
          isDirectory: stat.type === vscode.FileType.Directory,
          size: stat.type === vscode.FileType.File ? stat.size : undefined,
          relativePath,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'validateFilePathResponse',
        success: false,
        error: error instanceof Error ? error.message : 'Failed to validate file path',
      });
    }
  }

  /**
   * Get HTML for webview
   */
  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    // Get path to bundled Svelte app
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'sidebar.js')
    );
    // Load VS Code Codicons CSS from packaged media directory
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'codicons', 'codicon.css')
    );

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
            <link rel="stylesheet" href="${codiconsUri}">
            <title>GitHub Actions Runner</title>
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
                // Instantiate the Svelte 5 component
                console.log('Script loaded, checking for SvelteApp...');
                console.log('typeof SvelteApp:', typeof SvelteApp);
                console.log('typeof svelteMount:', typeof window.svelteMount);

                // Use a small delay to ensure the IIFE has fully executed
                setTimeout(() => {
                    try {
                        // Get the component and mount function
                        const Component = typeof SvelteApp !== 'undefined' ? SvelteApp : window.SvelteApp;
                        const mount = window.svelteMount;

                        if (Component && mount) {
                            console.log('Found component and mount function');

                            // Svelte 5: Use the mount() function
                            const target = document.getElementById('app');
                            console.log('Mounting Svelte 5 component with mount()...');

                            const instance = mount(Component, {
                                target: target,
                                props: {}
                            });

                            console.log('Svelte component mounted successfully');
                        } else {
                            console.error('SvelteApp or svelteMount is not defined.');
                            console.error('SvelteApp:', typeof Component);
                            console.error('svelteMount:', typeof mount);
                        }
                    } catch (error) {
                        console.error('Error mounting Svelte component:', error);
                        console.error('Error stack:', error.stack);
                    }
                }, 10);
            </script>
        </body>
        </html>`;
  }

  /**
   * Send workflow configuration to webview
   */
  private async _sendWorkflowConfig(workflowFilename: string) {
    try {
      const config = await Storage.getWorkflowConfig(workflowFilename);

      this._view?.webview.postMessage({
        type: 'getWorkflowConfig',
        success: true,
        data: config,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Set workflow configuration
   */
  private async _setWorkflowConfig(data: { workflowFilename: string; artifactPattern?: string }) {
    try {
      await Storage.setWorkflowConfig({
        workflowFilename: data.workflowFilename,
        artifactPattern: data.artifactPattern,
      });

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Workflow configuration saved successfully' },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Export preset to JSON file
   */
  private async _exportPreset(id: string) {
    try {
      const jsonContent = await Storage.exportTemplate(id);

      if (!jsonContent) {
        throw new Error('Preset not found');
      }

      // Get template name for filename
      const templates = await Storage.getTemplates();
      const template = templates.find((t) => t.id === id);
      const filename = template
        ? `${template.name.replace(/[^a-z0-9-]/gi, '_')}.json`
        : 'preset.json';

      // Show save dialog
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(filename),
        filters: {
          'JSON Files': ['json'],
          'All Files': ['*'],
        },
        saveLabel: 'Export Preset',
      });

      if (!uri) {
        return; // User cancelled
      }

      // Write file
      await vscode.workspace.fs.writeFile(uri, Buffer.from(jsonContent, 'utf8'));

      vscode.window.showInformationMessage(`✅ Preset exported to: ${uri.fsPath}`);

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Preset exported successfully', path: uri.fsPath },
      });
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to export preset: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Import preset from JSON file
   */
  private async _importPreset() {
    try {
      // Show open dialog
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          'JSON Files': ['json'],
          'All Files': ['*'],
        },
        openLabel: 'Import Preset',
      });

      if (!uris || uris.length === 0) {
        return; // User cancelled
      }

      // Read file
      const fileContent = await vscode.workspace.fs.readFile(uris[0]);
      const jsonContent = Buffer.from(fileContent).toString('utf8');

      // Import template
      const template = await Storage.importTemplate(jsonContent);

      vscode.window.showInformationMessage(`✅ Preset "${template.name}" imported successfully`);

      this._view?.webview.postMessage({
        type: 'success',
        success: true,
        data: { message: 'Preset imported successfully', template },
      });

      // Don't send all templates - let the frontend request templates for the selected workflow
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to import preset: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      this._view?.webview.postMessage({
        type: 'error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Send storage information to webview
   */
  private async _sendStorageInfo() {
    const info = Storage.getStorageInfo();

    this._view?.webview.postMessage({
      type: 'storageInfo',
      success: true,
      data: { info },
    });
  }

  // ============================================
  // SmartFileInput handlers
  // ============================================

  /**
   * Get SmartFileInput data (recent files and favorites) for a specific scope
   */
  private async _getSmartFileInputData(data: GetSmartFileInputDataMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      const inputData = await SmartFileInputManager.getData(key);

      this._view?.webview.postMessage({
        type: 'smartFileInputDataResponse',
        success: true,
        data: {
          inputName: data.inputName,
          recentFiles: inputData.recentFiles,
          favorites: inputData.favorites,
          valueFavorites: inputData.valueFavorites || [],
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'smartFileInputDataResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to get SmartFileInput data',
      });
    }
  }

  /**
   * Add a file to SmartFileInput favorites
   */
  private async _addSmartFileFavorite(data: AddFileFavoriteMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      const favorite = await SmartFileInputManager.addFavorite(
        key,
        data.relativePath,
        data.absolutePath,
        data.nickname,
        data.config // Pass config from recent file when adding to favorites
      );

      this._view?.webview.postMessage({
        type: 'addFileFavoriteResponse',
        success: true,
        data: {
          inputName: data.inputName,
          favorite,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'addFileFavoriteResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to add favorite',
      });
    }
  }

  /**
   * Remove a file from SmartFileInput favorites
   */
  private async _removeSmartFileFavorite(data: RemoveFileFavoriteMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      await SmartFileInputManager.removeFavorite(key, data.favoriteId);

      this._view?.webview.postMessage({
        type: 'removeFileFavoriteResponse',
        success: true,
        data: {
          inputName: data.inputName,
          favoriteId: data.favoriteId,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'removeFileFavoriteResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to remove favorite',
      });
    }
  }

  /**
   * Update a SmartFileInput favorite (nickname or config)
   */
  private async _updateSmartFileFavorite(data: UpdateFileFavoriteMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      const updated = await SmartFileInputManager.updateFavorite(key, data.favoriteId, {
        nickname: data.nickname,
        config: data.config,
      });

      this._view?.webview.postMessage({
        type: 'updateFileFavoriteResponse',
        success: true,
        data: {
          inputName: data.inputName,
          favorite: updated,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'updateFileFavoriteResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to update favorite',
      });
    }
  }

  /**
   * Track a file as recently used
   */
  private async _trackSmartFileRecent(data: TrackRecentFileMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      await SmartFileInputManager.trackRecentFile(
        key,
        data.relativePath,
        data.absolutePath,
        data.config,
        data.mode
      );

      this._view?.webview.postMessage({
        type: 'trackRecentFileResponse',
        success: true,
        data: { inputName: data.inputName },
      });
    } catch (error) {
      // Silent failure for tracking - not critical
      console.error('Failed to track recent file:', error);
    }
  }

  /**
   * Get file path suggestions for autocomplete
   */
  private async _getFileSuggestions(data: GetFileSuggestionsMessage) {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        this._view?.webview.postMessage({
          type: 'fileSuggestionsResponse',
          success: true,
          data: {
            inputName: data.inputName,
            suggestions: [],
          },
        });
        return;
      }

      const suggestions = await SmartFileInputManager.getFileSuggestions(
        workspaceRoot,
        data.partialPath,
        10
      );

      this._view?.webview.postMessage({
        type: 'fileSuggestionsResponse',
        success: true,
        data: {
          inputName: data.inputName,
          suggestions,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'fileSuggestionsResponse',
        success: false,
        data: { inputName: data.inputName, suggestions: [] },
        error: error instanceof Error ? error.message : 'Failed to get suggestions',
      });
    }
  }

  /**
   * Parse file content for multi-select modal
   */
  private async _parseFileForSelection(data: ParseFileForSelectionMessage) {
    try {
      // Resolve relative path to absolute path using workspace folder
      let absolutePath = data.path;
      if (!path.isAbsolute(data.path)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          absolutePath = path.join(workspaceFolder.uri.fsPath, data.path);
        }
      }

      const fileUri = vscode.Uri.file(absolutePath);
      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(content).toString('utf8');

      const parsed = SmartFileInputManager.parseFileContent(text, data.path, data.config);

      this._view?.webview.postMessage({
        type: 'parseFileForSelectionResponse',
        success: true,
        data: {
          inputName: data.inputName,
          parsedContent: parsed,
          filePath: data.path,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'parseFileForSelectionResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to parse file',
      });
    }
  }

  /**
   * Open a file in VS Code editor - resolves relative paths using workspace
   */
  private async _openFileInEditor(data: OpenFileInEditorMessage) {
    try {
      // Resolve relative path to absolute path using workspace folder
      let absolutePath = data.path;
      if (!path.isAbsolute(data.path)) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          absolutePath = path.join(workspaceFolder.uri.fsPath, data.path);
        }
      }
      const fileUri = vscode.Uri.file(absolutePath);
      await vscode.window.showTextDocument(fileUri);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to open file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Save value favorites for a specific input
   */
  private async _saveValueFavorites(data: SaveValueFavoritesMessage) {
    try {
      const key = {
        owner: data.repoOwner,
        repo: data.repoName,
        workflowFilename: data.workflowPath,
        inputName: data.inputName,
      };
      const savedFavorites = await SmartFileInputManager.saveValueFavorites(key, data.favorites);

      this._view?.webview.postMessage({
        type: 'saveValueFavoritesResponse',
        success: true,
        data: {
          inputName: data.inputName,
          favorites: savedFavorites,
        },
      });
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'saveValueFavoritesResponse',
        success: false,
        data: { inputName: data.inputName },
        error: error instanceof Error ? error.message : 'Failed to save value favorites',
      });
    }
  }
}
