/**
 * Enhanced GitHub authentication with token validation
 */
import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import type { GitHubTokenInfo } from '../types/workflow-types';

interface GitHubUser {
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

/**
 * Primary authentication entrypoint. Tries VS Code GitHub auth provider first,
 * then falls back to manual PAT entry based on user choice and settings.
 */
export async function authenticate(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
  const pref = config.get<'auto' | 'oauth' | 'pat'>(
    'authentication.method',
    'auto'
  );

  // Helper to try OAuth provider
  const tryOAuth = async (): Promise<boolean> => {
    try {
      const session = await vscode.authentication.getSession(
        'github',
        ['read:user', 'repo', 'workflow'],
        { createIfNone: true }
      );
      if (!session) return false;
      // Validate quickly to surface scope issues
      const ok = await validateToken(session.accessToken);
      if (!ok) return false;
      vscode.window.showInformationMessage('Signed in with GitHub');
      return true;
    } catch (err) {
      return false;
    }
  };

  if (pref === 'oauth') {
    return await tryOAuth();
  }

  if (pref === 'pat') {
    return await setGithubToken();
  }

  // auto: ask user for preferred method, default to OAuth
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Sign in with GitHub (Recommended)', value: 'oauth' as const },
      { label: 'Use Personal Access Token (PAT)', value: 'pat' as const },
    ],
    {
      title: 'GitHub Actions Runner: Choose authentication method',
      placeHolder: 'Select how you want to authenticate with GitHub',
      ignoreFocusOut: true,
    }
  );

  if (!choice) {
    return false;
  }

  if (choice.value === 'oauth') {
    const ok = await tryOAuth();
    if (!ok) {
      const fallback = await vscode.window.showWarningMessage(
        'GitHub sign-in was cancelled or failed. Would you like to enter a Personal Access Token instead?',
        'Use PAT',
        'Cancel'
      );
      if (fallback === 'Use PAT') {
        return await setGithubToken();
      }
      return false;
    }
    return true;
  }

  return await setGithubToken();
}

/**
 * Prompt user for GitHub token and validate it
 */
export async function setGithubToken(): Promise<boolean> {
  try {
    // Prompt user for GitHub token
    const githubToken = await vscode.window.showInputBox({
      prompt: 'Enter your GitHub Personal Access Token',
      password: true,
      placeHolder: 'ghp_... or github_pat_...',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) {
          return 'Token is required';
        }
        if (!value.startsWith('ghp_') && !value.startsWith('github_pat_')) {
          return 'Invalid token format. Token should start with ghp_ or github_pat_';
        }
        return null;
      },
    });

    if (!githubToken) {
      vscode.window.showErrorMessage(
        'GitHub token is required to use this extension.'
      );
      return false;
    }

    // Validate token before storing
    const isValid = await validateToken(githubToken);
    if (!isValid) {
      vscode.window.showErrorMessage(
        'Invalid GitHub token or insufficient permissions. Token must have "workflow" or "repo" scope.'
      );
      return false;
    }

    await TokenManager.setGithubToken(githubToken);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to set GitHub token: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
    return false;
  }
}

/**
 * Validate GitHub token and fetch user information
 */
export async function validateToken(token: string): Promise<boolean> {
  try {
    // Fetch user information
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      console.error(
        'Token validation failed:',
        userResponse.status,
        userResponse.statusText
      );
      return false;
    }

    const user = (await userResponse.json()) as GitHubUser;

    // Store username
    await TokenManager.setGithubUsername(user.login);

    // Check token scopes
    const scopes = userResponse.headers.get('x-oauth-scopes');
    const scopeList = scopes ? scopes.split(',').map((s) => s.trim()) : [];

    // Store scopes
    await TokenManager.setGithubScopes(scopeList);

    // Verify required scopes
    const hasRequiredScope =
      scopeList.includes('workflow') || scopeList.includes('repo');

    if (!hasRequiredScope) {
      vscode.window
        .showWarningMessage(
          `GitHub token for ${user.login} does not have "workflow" scope. Workflow dispatch may fail.`,
          'Learn More'
        )
        .then((selection) => {
          if (selection === 'Learn More') {
            vscode.env.openExternal(
              vscode.Uri.parse(
                'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token'
              )
            );
          }
        });
    }

    return true;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
}

/**
 * Get GitHub username from token
 */
export async function getGitHubUsername(token: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const user = (await response.json()) as GitHubUser;
    return user.login;
  } catch (error) {
    console.error('Failed to fetch GitHub username:', error);
    return null;
  }
}

/**
 * Get complete token information with validation
 */
export async function getTokenInfo(): Promise<GitHubTokenInfo | null> {
  const token = await TokenManager.getGithubToken();
  if (!token) {
    return null;
  }

  // Validate token is still valid
  const isValid = await validateToken(token);
  if (!isValid) {
    await TokenManager.clearAll();
    return null;
  }

  return await TokenManager.getTokenInfo();
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await TokenManager.getGithubToken();
  if (!token) {
    return false;
  }

  // Quick validation
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Sign out and clear all stored credentials
 */
export async function signOut(): Promise<void> {
  await TokenManager.clearAll();
  vscode.window.showInformationMessage('Signed out of GitHub');
}

/**
 * Get rate limit information
 */
export async function getRateLimitInfo(): Promise<{
  limit: number;
  remaining: number;
  reset: Date;
} | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const response = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      resources: { core: { limit: number; remaining: number; reset: number } };
    };
    const core = data.resources.core;

    return {
      limit: core.limit,
      remaining: core.remaining,
      reset: new Date(core.reset * 1000),
    };
  } catch (error) {
    console.error('Failed to get rate limit info:', error);
    return null;
  }
}
