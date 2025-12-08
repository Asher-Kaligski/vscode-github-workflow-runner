/**
 * Secure token management using VS Code SecretStorage
 */
import * as vscode from 'vscode';
import type { GitHubTokenInfo } from '../types/workflow-types';

const GITHUB_TOKEN_KEY = 'GITHUB_TOKEN';
const GITHUB_USERNAME_KEY = 'GITHUB_USERNAME';
const GITHUB_SCOPES_KEY = 'GITHUB_SCOPES';

export class TokenManager {
  private static secrets: vscode.SecretStorage;

  // Scopes requested from VS Code's built-in GitHub authentication provider
  private static readonly GITHUB_AUTH_SCOPES = ['read:user', 'repo', 'workflow'];

  /**
   * Initialize the TokenManager with VS Code context
   */
  static initialize(context: vscode.ExtensionContext): void {
    this.secrets = context.secrets;
  }

  /**
   * Store GitHub token securely (manual PAT flow)
   */
  static async setGithubToken(token: string): Promise<void> {
    await this.secrets.store(GITHUB_TOKEN_KEY, token);
  }

  /**
   * Read extension setting for preferred authentication method
   */
  private static getPreferredAuthMethod(): 'auto' | 'oauth' | 'pat' {
    const config = vscode.workspace.getConfiguration('githubWorkflowRunner');
    const method = config.get<'auto' | 'oauth' | 'pat'>('authentication.method', 'auto');
    return method;
  }

  /**
   * Attempt to obtain an access token via the built-in GitHub auth provider.
   * When silent=true, this will not prompt the user.
   */
  private static async getTokenFromAuthProvider(
    silent: boolean = true
  ): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession('github', this.GITHUB_AUTH_SCOPES, {
        createIfNone: !silent,
        silent,
      });
      return session?.accessToken;
    } catch (err) {
      // Provider might be unavailable or user cancelled
      return undefined;
    }
  }

  /**
   * Retrieve GitHub token, preferring the OAuth provider depending on settings.
   * Falls back to stored PAT if provider session is unavailable.
   */
  static async getGithubToken(): Promise<string | undefined> {
    const method = this.getPreferredAuthMethod();

    if (method === 'oauth' || method === 'auto') {
      const oauthToken = await this.getTokenFromAuthProvider(true /* silent */);
      if (oauthToken) {
        return oauthToken;
      }
      // If explicitly oauth and none available, do not fallback silently
      if (method === 'oauth') {
        return undefined;
      }
    }

    // Fallback to stored PAT
    return await this.secrets.get(GITHUB_TOKEN_KEY);
  }

  /**
   * Delete GitHub token
   */
  static async deleteGithubToken(): Promise<void> {
    await this.secrets.delete(GITHUB_TOKEN_KEY);
    await this.secrets.delete(GITHUB_USERNAME_KEY);
    await this.secrets.delete(GITHUB_SCOPES_KEY);
  }

  /**
   * Store GitHub username
   */
  static async setGithubUsername(username: string): Promise<void> {
    await this.secrets.store(GITHUB_USERNAME_KEY, username);
  }

  /**
   * Retrieve GitHub username
   */
  static async getGithubUsername(): Promise<string | undefined> {
    return await this.secrets.get(GITHUB_USERNAME_KEY);
  }

  /**
   * Store GitHub token scopes
   */
  static async setGithubScopes(scopes: string[]): Promise<void> {
    await this.secrets.store(GITHUB_SCOPES_KEY, JSON.stringify(scopes));
  }

  /**
   * Retrieve GitHub token scopes
   */
  static async getGithubScopes(): Promise<string[]> {
    const scopesJson = await this.secrets.get(GITHUB_SCOPES_KEY);
    if (!scopesJson) {
      return [];
    }
    try {
      return JSON.parse(scopesJson);
    } catch {
      return [];
    }
  }

  /**
   * Get complete token information
   */
  static async getTokenInfo(): Promise<GitHubTokenInfo | null> {
    const token = await this.getGithubToken();
    if (!token) {
      return null;
    }

    const username = await this.getGithubUsername();
    const scopes = await this.getGithubScopes();

    return {
      token,
      username: username || 'unknown',
      scopes,
      hasWorkflowScope: scopes.includes('workflow') || scopes.includes('repo'),
    };
  }

  /**
   * Clear all stored token information
   */
  static async clearAll(): Promise<void> {
    await this.deleteGithubToken();
  }
}
