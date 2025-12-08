/**
 * Extension configuration management
 */
import * as vscode from 'vscode';
import type { ExtensionConfig } from '../types/workflow-types';

const CONFIG_SECTION = 'githubWorkflowRunner';

/**
 * Get extension configuration
 * Note: For repository config, use getRepositoryConfig() from repository-config.ts
 * which handles auto-detection and manual overrides
 */
export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    repository: {
      owner: config.get('repository.owner', ''),
      name: config.get('repository.name', ''),
    },
    defaultBranch: config.get('defaultBranch', 'main'),
    monitoring: {
      autoRefresh: config.get('monitoring.autoRefresh', true),
      refreshInterval: config.get('monitoring.refreshInterval', 15),
      maxRuns: config.get('monitoring.maxRuns', 20),
    },
    ui: {
      confirmBeforeDispatch: config.get('ui.confirmBeforeDispatch', true),
      rememberLastWorkflow: config.get('ui.rememberLastWorkflow', true),
    },
    git: {
      autoDetectBranch: config.get('git.autoDetectBranch', true),
    },
    notifications: {
      enabled: config.get('notifications.enabled', true),
      onSuccess: config.get('notifications.onSuccess', false),
      onFailure: config.get('notifications.onFailure', true),
    },
    workflows: {
      excludePatterns: config.get('workflows.excludePatterns', []),
    },
  };
}

/**
 * Update configuration value
 */
export async function updateConfig(
  key: string,
  value: any,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(key, value, target);
}

/**
 * Get repository owner
 */
export function getRepositoryOwner(): string {
  return getConfig().repository.owner;
}

/**
 * Get repository name
 */
export function getRepositoryName(): string {
  return getConfig().repository.name;
}

/**
 * Get default branch
 */
export function getDefaultBranch(): string {
  return getConfig().defaultBranch;
}

/**
 * Get monitoring configuration
 */
export function getMonitoringConfig() {
  return getConfig().monitoring;
}

/**
 * Get UI configuration
 */
export function getUIConfig() {
  return getConfig().ui;
}

/**
 * Get Git configuration
 */
export function getGitConfig() {
  return getConfig().git;
}

/**
 * Get notification configuration
 */
export function getNotificationConfig() {
  return getConfig().notifications;
}

/**
 * Get workflow exclude patterns
 */
export function getWorkflowExcludePatterns(): string[] {
  return getConfig().workflows.excludePatterns;
}

/**
 * Watch for configuration changes
 */
export function onConfigChange(callback: (config: ExtensionConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      callback(getConfig());
    }
  });
}

/**
 * Reset configuration to defaults
 */
export async function resetConfig(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const keys = [
    'repository.owner',
    'repository.name',
    'defaultBranch',
    'monitoring.autoRefresh',
    'monitoring.refreshInterval',
    'monitoring.maxRuns',
    'ui.confirmBeforeDispatch',
    'ui.rememberLastWorkflow',
    'git.autoDetectBranch',
    'notifications.enabled',
    'notifications.onSuccess',
    'notifications.onFailure',
    'workflows.excludePatterns',
  ];

  for (const key of keys) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Validate configuration
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const config = getConfig();
  const errors: string[] = [];

  if (!config.repository.owner) {
    errors.push('Repository owner is not configured');
  }

  if (!config.repository.name) {
    errors.push('Repository name is not configured');
  }

  if (!config.defaultBranch) {
    errors.push('Default branch is not configured');
  }

  if (config.monitoring.refreshInterval < 5) {
    errors.push('Refresh interval must be at least 5 seconds');
  }

  if (config.monitoring.maxRuns < 1) {
    errors.push('Max runs must be at least 1');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
