/**
 * Git operations for branch detection and repository information
 */
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import type { GitRepositoryInfo, WorkspaceRepoInfo } from '../types/workflow-types';
import { getActiveWorkspacePath } from './active-workspace';

/**
 * Resolve the working directory for git operations.
 * If workspacePath is provided, uses it directly; otherwise falls back to the
 * workspace selected in the sidebar (multi-workspace support), and finally to
 * the first workspace folder.
 */
function resolveWorkspaceCwd(workspacePath?: string): string | undefined {
  if (workspacePath) {
    return workspacePath;
  }
  const active = getActiveWorkspacePath();
  if (active) {
    return active;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Get current Git branch using VS Code Git API
 */
export async function getCurrentBranch(workspacePath?: string): Promise<string | undefined> {
  try {
    // Try VS Code Git API first — find the matching repo by root path when possible
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const git = gitExtension.exports.getAPI(1);
      const repositories = git.repositories;

      if (repositories.length > 0) {
        const targetPath = resolveWorkspaceCwd(workspacePath);
        const repo = targetPath
          ? repositories.find((r: any) => r.rootUri?.fsPath === targetPath) ?? repositories[0]
          : repositories[0];
        const branch = repo.state.HEAD?.name;
        if (branch) {
          return branch;
        }
      }
    }

    // Fallback to command line
    const cwd = resolveWorkspaceCwd(workspacePath);
    if (cwd) {
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
export async function getRecentBranches(
  limit: number = 10,
  workspacePath?: string
): Promise<string[]> {
  try {
    const cwd = resolveWorkspaceCwd(workspacePath);
    if (!cwd) {
      return [];
    }

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
    const cwd = resolveWorkspaceCwd();
    if (!cwd) {
      return false;
    }

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
 * Get repository information for a specific workspace path (or the first workspace folder).
 */
export async function getRepositoryInfo(workspacePath?: string): Promise<GitRepositoryInfo | null> {
  try {
    const rootPath = resolveWorkspaceCwd(workspacePath);
    if (!rootPath) {
      return null;
    }

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
    const currentBranch = await getCurrentBranch(rootPath);

    // Get recent branches
    const recentBranches = await getRecentBranches(10, rootPath);

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
 * Get repo info for every workspace folder that is a GitHub-backed git repo.
 */
export async function getAllWorkspaceRepos(): Promise<WorkspaceRepoInfo[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const results: WorkspaceRepoInfo[] = [];
  for (const folder of folders) {
    try {
      const repoInfo = await getRepositoryInfo(folder.uri.fsPath);
      results.push({
        folderName: folder.name,
        folderPath: folder.uri.fsPath,
        owner: repoInfo?.owner ?? null,
        repoName: repoInfo?.name ?? null,
        isGitHub: repoInfo !== null,
      });
    } catch {
      results.push({
        folderName: folder.name,
        folderPath: folder.uri.fsPath,
        owner: null,
        repoName: null,
        isGitHub: false,
      });
    }
  }
  return results;
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
