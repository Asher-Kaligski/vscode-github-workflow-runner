/**
 * GitHub user information fetching and management
 */
import { TokenManager } from './token-manager';
import type { GitHubUserInfo } from '../types/workflow-types';

/**
 * Fetch authenticated user's information from GitHub API
 */
export async function fetchGitHubUserInfo(): Promise<GitHubUserInfo | null> {
  try {
    const token = await TokenManager.getGithubToken();
    if (!token) {
      return null;
    }

    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      console.error('Failed to fetch user info:', response.status, response.statusText);
      return null;
    }

    const user = await response.json() as GitHubUserInfo;
    
    // Store username for future use
    await TokenManager.setGithubUsername(user.login);
    
    return user;
  } catch (error) {
    console.error('Error fetching GitHub user info:', error);
    return null;
  }
}

/**
 * Get cached user information or fetch if not available
 */
export async function getGitHubUserInfo(): Promise<GitHubUserInfo | null> {
  // Try to get cached username first
  const cachedUsername = await TokenManager.getGithubUsername();
  
  if (cachedUsername) {
    // Return cached info (we don't cache avatar, so fetch fresh if needed)
    return fetchGitHubUserInfo();
  }
  
  // Fetch fresh user info
  return fetchGitHubUserInfo();
}

