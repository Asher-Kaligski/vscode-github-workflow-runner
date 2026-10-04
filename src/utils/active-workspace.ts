/**
 * Active workspace tracking for multi-root (multi-workspace) setups.
 *
 * The sidebar lets the user pick which workspace folder / repository to operate
 * on. That selection lives in the sidebar webview, but several other parts of
 * the extension (most notably the Workflow Runs panel) resolve the repository
 * by falling back to the first workspace folder. This module holds the selected
 * workspace path so those fallbacks target the chosen repository instead of
 * always using `workspaceFolders[0]`.
 *
 * An explicit `workspacePath` argument always takes precedence; this value is
 * only consulted as the default when no explicit path is provided.
 */
let activeWorkspacePath: string | undefined;

/**
 * Set the currently selected workspace folder path (undefined to clear and fall
 * back to the first workspace folder).
 */
export function setActiveWorkspacePath(workspacePath: string | undefined): void {
  activeWorkspacePath = workspacePath || undefined;
}

/**
 * Get the currently selected workspace folder path, if any.
 */
export function getActiveWorkspacePath(): string | undefined {
  return activeWorkspacePath;
}
