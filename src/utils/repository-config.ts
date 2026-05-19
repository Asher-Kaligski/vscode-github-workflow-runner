/**
 * Repository configuration management with auto-detection and manual override support
 */
import * as vscode from 'vscode';
import { getRepositoryInfo } from './git-operations';
import type { RepositoryConfig } from '../types/workflow-types';

const MANUAL_OWNER_KEY = 'githubWorkflowRunner.repository.manualOwner';
const MANUAL_NAME_KEY = 'githubWorkflowRunner.repository.manualName';

/**
 * Get repository configuration with auto-detection and manual override support.
 * When workspacePath is provided, auto-detection targets that specific folder.
 */
export async function getRepositoryConfig(workspacePath?: string): Promise<RepositoryConfig> {
  const config = vscode.workspace.getConfiguration();

  // Check for manual overrides in workspace settings
  const manualOwner = config.get<string>(MANUAL_OWNER_KEY);
  const manualName = config.get<string>(MANUAL_NAME_KEY);

  // Try to auto-detect repository info
  const autoDetected = await getRepositoryInfo(workspacePath);

  // If manual values are set, use them
  if (manualOwner && manualName) {
    return {
      owner: manualOwner,
      name: manualName,
      isManual: true,
      autoDetected: autoDetected
        ? {
            owner: autoDetected.owner,
            name: autoDetected.name,
          }
        : undefined,
    };
  }

  // Otherwise, use auto-detected values or fallback to config defaults
  if (autoDetected) {
    return {
      owner: autoDetected.owner,
      name: autoDetected.name,
      isManual: false,
      autoDetected: {
        owner: autoDetected.owner,
        name: autoDetected.name,
      },
    };
  }

  // Fallback to config defaults (which might be empty strings)
  const defaultOwner = config.get<string>('githubWorkflowRunner.repository.owner', '');
  const defaultName = config.get<string>('githubWorkflowRunner.repository.name', '');

  return {
    owner: defaultOwner,
    name: defaultName,
    isManual: false,
    autoDetected: undefined,
  };
}

/**
 * Set manual repository configuration
 */
export async function setRepositoryConfig(owner: string, name: string): Promise<void> {
  const config = vscode.workspace.getConfiguration();

  // Store in workspace settings (not global)
  await config.update(MANUAL_OWNER_KEY, owner, vscode.ConfigurationTarget.Workspace);
  await config.update(MANUAL_NAME_KEY, name, vscode.ConfigurationTarget.Workspace);
}

/**
 * Clear manual repository configuration and revert to auto-detection
 */
export async function resetRepositoryConfig(): Promise<void> {
  const config = vscode.workspace.getConfiguration();

  // Remove manual overrides from workspace settings
  await config.update(MANUAL_OWNER_KEY, undefined, vscode.ConfigurationTarget.Workspace);
  await config.update(MANUAL_NAME_KEY, undefined, vscode.ConfigurationTarget.Workspace);
}

/**
 * Check if repository configuration is manually set
 */
export function isRepositoryConfigManual(): boolean {
  const config = vscode.workspace.getConfiguration();
  const manualOwner = config.get<string>(MANUAL_OWNER_KEY);
  const manualName = config.get<string>(MANUAL_NAME_KEY);

  return !!(manualOwner && manualName);
}
