/**
 * GitHub Actions Runner Extension
 * Main extension entry point
 */
import * as vscode from 'vscode';
import { TokenManager } from './utils/token-manager';
import { Storage } from './utils/storage';
import { FavoritesManager } from './utils/favorites-manager';
import { SmartFileInputManager } from './utils/smart-file-input-manager';
import { SidebarProvider } from './providers/sidebar-provider';
import { WorkflowRunsProvider } from './providers/workflow-runs-provider';
import { WorkflowRunsPanel } from './providers/workflow-runs-panel';
import { LogDocumentProvider } from './providers/log-document-provider';
import { LogViewerPanel } from './providers/log-viewer-panel';
import { LOG_SCHEME } from './utils/log-uri-scheme';
import { authenticate, signOut } from './utils/authenticate';
import { getAllWorkflowDefinitions } from './utils/workflow-parser';
import { getConfig, onConfigChange } from './utils/config';

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('GitHub Actions Runner extension is now active');

  // Initialize managers
  TokenManager.initialize(context);
  Storage.initialize(context);
  FavoritesManager.initialize(context);
  SmartFileInputManager.initialize(context);

  // Register log document provider for workflow job logs
  const logDocumentProvider = new LogDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logDocumentProvider)
  );

  // Set language for log documents when they are opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === LOG_SCHEME) {
        vscode.languages.setTextDocumentLanguage(doc, 'github-actions-log');
      }
    })
  );

  // Register sidebar webview provider with state preservation
  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('github-workflow-runner-sidebar', sidebarProvider, {
      // Preserve webview state when hidden (scroll position, expanded sections, etc.)
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register workflow runs webview provider with state preservation
  const workflowRunsProvider = new WorkflowRunsProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('github-workflow-runner-runs', workflowRunsProvider, {
      // Preserve webview state when hidden (scroll position, expanded sections, etc.)
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Connect providers for cross-communication
  sidebarProvider.setWorkflowRunsProvider(workflowRunsProvider);

  // Register commands
  registerCommands(context, sidebarProvider, workflowRunsProvider);

  // Watch for configuration changes
  context.subscriptions.push(
    onConfigChange((config) => {
      console.log('Configuration changed:', config);
      // Notify webviews of config change
      sidebarProvider.notifyConfigChange(config);
      workflowRunsProvider.notifyConfigChange(config);
    })
  );

  // Check authentication status on startup
  const token = await TokenManager.getGithubToken();
  if (!token) {
    vscode.window
      .showInformationMessage(
        'GitHub Actions Runner: Please authenticate with GitHub to use this extension',
        'Authenticate'
      )
      .then((selection) => {
        if (selection === 'Authenticate') {
          vscode.commands.executeCommand('github-workflow-runner.authenticate');
        }
      });
  }
}

/**
 * Register extension commands
 */
function registerCommands(
  context: vscode.ExtensionContext,
  sidebarProvider: SidebarProvider,
  workflowRunsProvider: WorkflowRunsProvider
) {
  // Authenticate command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.authenticate', async () => {
      const success = await authenticate();
      if (success) {
        vscode.window.showInformationMessage('✅ Successfully authenticated with GitHub');
        sidebarProvider.refresh();
        workflowRunsProvider.refresh();
      }
    })
  );

  // Sign out command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.signOut', async () => {
      await signOut();
      // Don't call refresh() - it causes remount and auto-login
      // Instead, let the webview handle the signOut message
    })
  );

  // Show workflow runs command - opens main panel
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.show-workflow-runs', () => {
      // Check if panel is already open
      if (WorkflowRunsPanel.isOpen()) {
        // Panel is already open - just show info message and focus it
        vscode.window.showInformationMessage('Workflow Runs panel is already open');
        // Just reveal/focus without reloading
        WorkflowRunsPanel.reveal();
      } else {
        // Panel is closed - open it
        WorkflowRunsPanel.createOrShow(context.extensionUri);
      }
    })
  );

  // Show workflow runs command (alternative name for consistency)
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.showWorkflowRuns', () => {
      // Check if panel is already open
      if (WorkflowRunsPanel.isOpen()) {
        // Panel is already open - just show info message and focus it
        vscode.window.showInformationMessage('Workflow Runs panel is already open');
        // Just reveal/focus without reloading
        WorkflowRunsPanel.reveal();
      } else {
        // Panel is closed - open it with 'all' actor filter
        WorkflowRunsPanel.createOrShow(context.extensionUri, {
          actorFilter: 'all',
        });
      }
    })
  );

  // Hide workflow runs command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.hide-workflow-runs', () => {
      WorkflowRunsPanel.kill();
    })
  );

  // Refresh workflows command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.refresh-workflows', async () => {
      sidebarProvider.refresh();
      vscode.window.showInformationMessage('Workflows refreshed');
    })
  );

  // Run last workflow command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.run-last-workflow', async () => {
      const lastWorkflow = await Storage.getLastWorkflow();
      if (!lastWorkflow) {
        vscode.window.showInformationMessage('No previous workflow execution found');
        return;
      }

      const config = getConfig();
      const workflows = await getAllWorkflowDefinitions(config.workflows.excludePatterns);
      const workflow = workflows.find((w) => w.filename === lastWorkflow.workflowFilename);

      if (!workflow) {
        vscode.window.showErrorMessage(`Workflow "${lastWorkflow.workflowFilename}" not found`);
        return;
      }

      // Dispatch through sidebar provider
      sidebarProvider.dispatchLastWorkflow(workflow, lastWorkflow);
    })
  );

  // Open settings command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.open-settings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'githubWorkflowRunner');
    })
  );

  // Prefill dispatch command (used by WorkflowRuns panel to open sidebar with inputs)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'github-workflow-runner.prefillDispatch',
      async (data: {
        workflowFilename: string;
        branch: string;
        inputs: Record<string, string>;
        runId?: number;
      }) => {
        try {
          console.log('[Extension] prefillDispatch command called with:', {
            workflowFilename: data.workflowFilename,
            branch: data.branch,
            inputsCount: Object.keys(data.inputs || {}).length,
            runId: data.runId,
          });

          // Check if sidebar is already visible and ready
          const wasReady = sidebarProvider.isReady();
          console.log('[Extension] Sidebar ready state:', wasReady);

          // If not ready, reset state to ensure we wait for the new webview
          if (!wasReady) {
            console.log('[Extension] Resetting ready state (sidebar not ready)');
            sidebarProvider.resetReadyState();
          }

          // Ensure sidebar is visible
          console.log('[Extension] Showing sidebar view...');
          await vscode.commands.executeCommand(
            'workbench.view.extension.github-workflow-runner-sidebar-view'
          );
          console.log('[Extension] Sidebar view command completed');

          // Wait for the webview to signal readiness before sending prefill
          // (if already ready, this returns immediately)
          console.log('[Extension] Waiting for webview ready...');
          await sidebarProvider.waitForWebviewReady();
          console.log('[Extension] Webview is ready');

          // Send prefill message to sidebar
          console.log('[Extension] Sending prefillDispatch to sidebar');
          sidebarProvider.prefillDispatch(data);

          // Let the user know inputs were prefilled when invoked from a specific run
          if (typeof data.runId === 'number') {
            vscode.window.showInformationMessage(
              `✅ Workflow inputs prefilled from run #${data.runId}. Review and dispatch when ready.`
            );
          }
        } catch (error) {
          console.error('[Extension] prefillDispatch error:', error);
          vscode.window.showErrorMessage(
            `Failed to prefill dispatch: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }
    )
  );

  // Export data command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.export-data', async () => {
      const data = await Storage.exportData();
      const json = JSON.stringify(data, null, 2);

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('workflow-runner-data.json'),
        filters: {
          JSON: ['json'],
        },
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
        vscode.window.showInformationMessage('Data exported successfully');
      }
    })
  );

  // Import data command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.import-data', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          JSON: ['json'],
        },
      });

      if (uris && uris.length > 0) {
        try {
          const content = await vscode.workspace.fs.readFile(uris[0]);
          const data = JSON.parse(content.toString());
          await Storage.importData(data);
          vscode.window.showInformationMessage('Data imported successfully');
          sidebarProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to import data: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    })
  );

  // Clear all data command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.clear-all-data', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all templates and history? This cannot be undone.',
        { modal: true },
        'Clear All',
        'Cancel'
      );

      if (choice === 'Clear All') {
        await Storage.clearAll();
        vscode.window.showInformationMessage('All data cleared');
        sidebarProvider.refresh();
      }
    })
  );

  // Show storage stats command
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.show-stats', async () => {
      const stats = await Storage.getStats();
      vscode.window.showInformationMessage(
        `Storage Stats:\n` +
          `Templates: ${stats.templatesCount}\n` +
          `History: ${stats.historyCount}\n` +
          `Last Workflow: ${stats.hasLastWorkflow ? 'Yes' : 'No'}`
      );
    })
  );

  // Reload extension data command (re-detect Git context and refresh all data)
  context.subscriptions.push(
    vscode.commands.registerCommand('github-workflow-runner.reload-extension-data', async () => {
      await sidebarProvider.reloadExtensionData();
    })
  );
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('GitHub Actions Runner extension is now deactivated');
}
