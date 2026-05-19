/**
 * Git context validation helpers.
 *
 * These utilities keep track of the last validated repository/branch and are
 * used to block GitHub API operations when the active Git repository or branch
 * has changed since the last explicit reload/validation.
 */
import * as vscode from 'vscode';
import { getRepositoryInfo } from './git-operations';
import { Storage } from './storage';

/**
 * Snapshot of the Git context at a point in time.
 */
export interface GitContextSnapshot {
  owner: string;
  repo: string;
  branch: string | null;
  validatedAt: string;
}

export type GitContextValidationReason =
  | 'ok'
  | 'initialized'
  | 'no-git-repo'
  | 'repository-mismatch'
  | 'branch-mismatch';

export interface GitContextValidationResult {
  /** True when it is safe to perform GitHub API operations. */
  ok: boolean;
  /** Explanation for the validation result. */
  reason: GitContextValidationReason;
  /** Live Git context from the current workspace. */
  current?: GitContextSnapshot;
  /** Persisted context from the last validation/reload, if any. */
  lastValidated?: GitContextSnapshot | null;
}

/**
 * Build a GitContextSnapshot from the current workspace Git repository.
 */
async function buildCurrentSnapshot(workspacePath?: string): Promise<GitContextSnapshot | null> {
  const repoInfo = await getRepositoryInfo(workspacePath);
  if (!repoInfo) {
    return null;
  }

  return {
    owner: repoInfo.owner,
    repo: repoInfo.name,
    branch: repoInfo.currentBranch ?? null,
    validatedAt: new Date().toISOString(),
  };
}

/**
 * Validate that the current Git repository and branch match the ones stored in
 * extension state from the last validation/reload.
 */
export async function validateGitContextForGitHubOperation(
  workspacePath?: string
): Promise<GitContextValidationResult> {
  const current = await buildCurrentSnapshot(workspacePath);

  if (!current) {
    return {
      ok: false,
      reason: 'no-git-repo',
      current: undefined,
      lastValidated: await Storage.getLastValidatedGitContext(),
    };
  }

  const lastValidated = await Storage.getLastValidatedGitContext();

  // First-time use: record the current context and allow the operation.
  if (!lastValidated) {
    await Storage.setLastValidatedGitContext(current);
    return {
      ok: true,
      reason: 'initialized',
      current,
      lastValidated: null,
    };
  }

  // Compare repository (owner/repo)
  if (current.owner !== lastValidated.owner || current.repo !== lastValidated.repo) {
    return {
      ok: false,
      reason: 'repository-mismatch',
      current,
      lastValidated,
    };
  }

  // Compare branch
  if (current.branch !== lastValidated.branch) {
    return {
      ok: false,
      reason: 'branch-mismatch',
      current,
      lastValidated,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    current,
    lastValidated,
  };
}

/**
 * Force-refresh the stored Git context to the current workspace state.
 * Call this when the user explicitly reloads extension data.
 */
export async function refreshGitContext(
  workspacePath?: string
): Promise<GitContextSnapshot | null> {
  const current = await buildCurrentSnapshot(workspacePath);
  if (current) {
    await Storage.setLastValidatedGitContext(current);
  } else {
    await Storage.clearLastValidatedGitContext();
  }
  return current;
}

/**
 * Get the current Git context without validation.
 */
export async function getCurrentGitContext(
  workspacePath?: string
): Promise<GitContextSnapshot | null> {
  return buildCurrentSnapshot(workspacePath);
}

/**
 * Validate Git context and, when invalid, show a standard warning message.
 * Returns true when it is safe to proceed with GitHub API operations.
 */
export async function ensureGitContextValidOrWarn(
  source?: string,
  workspacePath?: string
): Promise<boolean> {
  const result = await validateGitContextForGitHubOperation(workspacePath);

  if (result.ok) {
    return true;
  }

  console.warn('[GitContextValidation] Blocked operation:', {
    source,
    reason: result.reason,
    current: result.current,
    lastValidated: result.lastValidated,
  });

  let message: string;

  switch (result.reason) {
    case 'no-git-repo':
      message =
        'GitHub Workflow Runner: No Git repository detected in the current workspace. Open a folder with a Git repository before using workflow features.';
      void vscode.window.showWarningMessage(message);
      break;
    case 'repository-mismatch':
    case 'branch-mismatch':
    default:
      message =
        'GitHub Workflow Runner: The active Git repository or branch has changed since the extension was last reloaded. Click "Reload" to refresh workflows, runs, and configuration to match your current Git context.';
      // Show warning with a "Reload" action button
      void vscode.window.showWarningMessage(message, 'Reload').then((selection) => {
        if (selection === 'Reload') {
          vscode.commands.executeCommand('github-workflow-runner.reload-extension-data');
        }
      });
      break;
  }

  return false;
}
