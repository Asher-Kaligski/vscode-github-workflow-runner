/**
 * Git operations for branch detection and repository information
 */
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import type { GitRepositoryInfo } from '../types/workflow-types';

/**
 * Get current Git branch using VS Code Git API
 */
export async function getCurrentBranch(): Promise<string | undefined> {
  try {
    // Try VS Code Git API first
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const git = gitExtension.exports.getAPI(1);
      const repositories = git.repositories;

      if (repositories.length > 0) {
        const repo = repositories[0];
        const branch = repo.state.HEAD?.name;
        if (branch) {
          return branch;
        }
      }
    }

    // Fallback to command line
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const cwd = workspaceFolders[0].uri.fsPath;
      const branch = execSync('git branch --show-current', {
        cwd,
        encoding: 'utf8',
      }).trim();
      return branch || undefined;
    }
  } catch (error) {
    console.error('Failed to get current branch:', error);
  }
  return undefined;
}

/**
 * Get recent Git branches
 */
export async function getRecentBranches(limit: number = 10): Promise<string[]> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    // Get recent branches sorted by commit date
    const branches = execSync(
      'git for-each-ref --sort=-committerdate refs/heads/ --format="%(refname:short)" --count=' +
        limit,
      {
        cwd,
        encoding: 'utf8',
      }
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    return branches;
  } catch (error) {
    console.error('Failed to get recent branches:', error);
    return [];
  }
}

/**
 * Check if branch exists on remote
 */
export async function branchExistsOnRemote(branch: string): Promise<boolean> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    // Check if branch exists on origin
    execSync(`git ls-remote --heads origin ${branch}`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Get repository information
 */
export async function getRepositoryInfo(): Promise<GitRepositoryInfo | null> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const cwd = rootPath;

    // Get remote URL
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf8',
    }).trim();

    // Parse owner and repo name from URL
    // Supports both HTTPS and SSH formats
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) {
      return null;
    }

    const owner = match[1];
    const name = match[2];

    // Get current branch
    const currentBranch = await getCurrentBranch();

    // Get recent branches
    const recentBranches = await getRecentBranches();

    return {
      owner,
      name,
      currentBranch,
      recentBranches,
      rootPath,
    };
  } catch (error) {
    console.error('Failed to get repository info:', error);
    return null;
  }
}

/**
 * Check if current workspace is a Git repository
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const cwd = workspaceFolders[0].uri.fsPath;
    execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Get all local branches
 */
export async function getAllBranches(): Promise<string[]> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    const branches = execSync('git branch --format="%(refname:short)"', {
      cwd,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    return branches;
  } catch (error) {
    console.error('Failed to get all branches:', error);
    return [];
  }
}

/**
 * Get remote branches
 */
export async function getRemoteBranches(): Promise<string[]> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    // Use pure git command without shell-specific features (sed, pipes with /bin/bash)
    // This ensures cross-platform compatibility (Windows, macOS, Linux)
    const rawOutput = execSync('git branch -r --format="%(refname:short)"', {
      cwd,
      encoding: 'utf8',
    }).trim();

    // Process the output in JavaScript instead of using sed
    // This removes the "origin/" prefix and filters out HEAD entries
    const branches = rawOutput
      .split('\n')
      .filter(Boolean)
      .filter((b) => !b.includes('HEAD'))
      .map((b) => b.replace(/^origin\//, ''));

    return branches;
  } catch (error) {
    console.error('Failed to get remote branches:', error);
    return [];
  }
}
