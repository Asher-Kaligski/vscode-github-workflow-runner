<script lang="ts">
  /**
   * GitHubSummaryModal - Modal for viewing GitHub workflow run summary
   * Displays the rich markdown summary content from GitHub Actions
   */
  import { fade, scale } from 'svelte/transition';

  // Props
  export let runId: number;
  export let runName: string = '';
  export let htmlUrl: string = '';
  export let summaryContent: string = '';
  export let isLoading: boolean = false;
  export let error: string = '';
  export let onClose: () => void;
  export let onOpenInTab: () => void;
  export let onOpenInBrowser: () => void;

  // Suppress unused warning - runId is used by parent component for context
  void runId;

  // Track if beta notice has been dismissed (per session)
  let betaNoticeDismissed = false;

  /**
   * Dismiss the beta notice for this session
   */
  function dismissBetaNotice() {
    betaNoticeDismissed = true;
  }

  /**
   * Handle overlay click to close modal
   */
  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  /**
   * Handle keyboard events
   */
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }

  /**
   * Handle link clicks in the markdown content.
   * Opens external links in the default browser via VS Code API.
   */
  function handleContentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    if (anchor) {
      event.preventDefault();
      // Get the original URL from data attribute (to avoid webview URL resolution issues)
      const url = anchor.dataset.href || anchor.getAttribute('href');
      if (url && url !== '#') {
        // Use VS Code's openExternal command via postMessage
        // @ts-ignore - vscode is available in webview context
        if (typeof vscode !== 'undefined') {
          // @ts-ignore
          vscode.postMessage({
            type: 'openExternalUrl',
            data: { url },
          });
        } else {
          // Fallback for non-webview context (e.g., testing)
          window.open(url, '_blank', 'noopener');
        }
      }
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-overlay"
  on:click={handleOverlayClick}
  on:keydown={(e) => e.key === 'Escape' && onClose()}
  role="dialog"
  aria-modal="true"
  aria-labelledby="modal-title"
  tabindex="-1"
  transition:fade={{ duration: 150 }}
>
  <div class="modal-content" transition:scale={{ duration: 150, start: 0.95 }}>
    <div class="modal-header">
      <div class="modal-title-section">
        <span class="codicon codicon-book"></span>
        <h3 id="modal-title">GitHub Summary</h3>
        {#if runName}
          <span class="run-name">{runName}</span>
        {/if}
      </div>

      <div class="modal-actions">
        <button
          class="toolbar-btn primary-btn"
          on:click={onOpenInTab}
          title="Open in Editor Tab"
          disabled={isLoading || !!error}
        >
          <span class="codicon codicon-go-to-file"></span>
          <span>Open in Tab</span>
        </button>
        <button class="close-button" on:click={onClose} title="Close (Esc)">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </div>

    <div class="modal-body">
      {#if isLoading}
        <div class="loading-state">
          <span class="codicon codicon-sync spinning-icon"></span>
          <span>Loading GitHub summary...</span>
        </div>
      {:else if error}
        <div class="error-state">
          <span class="codicon codicon-warning"></span>
          <span>{error}</span>
          <button class="retry-btn" on:click={onOpenInBrowser}> View on GitHub instead </button>
        </div>
      {:else if summaryContent}
        <div class="summary-content-wrapper">
          {#if !betaNoticeDismissed}
            <div class="beta-notice" transition:fade={{ duration: 150 }}>
              <span class="codicon codicon-beaker"></span>
              <span class="beta-text">[Beta] Summary parsed from job logs.</span>
              <button
                class="beta-dismiss"
                on:click={dismissBetaNotice}
                title="Dismiss notice"
                aria-label="Dismiss beta notice"
              >
                <span class="codicon codicon-close"></span>
              </button>
            </div>
          {/if}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="markdown-content" on:click={handleContentClick}>
            {@html summaryContent}
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <span class="codicon codicon-info"></span>
          <span
            >No summary content found. This job may not write to <code>$GITHUB_STEP_SUMMARY</code
            >.</span
          >
          {#if htmlUrl}
            <button class="view-github-btn" on:click={onOpenInBrowser}> View on GitHub </button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <div class="footer-info">
        {#if htmlUrl}
          <button class="github-link-btn" on:click={onOpenInBrowser}>
            <span class="codicon codicon-github"></span>
            <span>View on GitHub</span>
          </button>
        {/if}
      </div>
      <button class="close-btn" on:click={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 24px;
  }

  .modal-content {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    width: 90%;
    max-width: 900px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .modal-title-section {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .modal-title-section h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }

  .run-name {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }

  .modal-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toolbar-btn.primary-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .toolbar-btn.primary-btn:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  .close-button {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 16px;
    min-height: 200px;
  }

  .loading-state,
  .error-state,
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    min-height: 200px;
    color: var(--vscode-descriptionForeground);
  }

  .error-state {
    color: var(--vscode-errorForeground);
  }

  .spinning-icon {
    animation: spin 1.5s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .retry-btn,
  .view-github-btn {
    margin-top: 8px;
    padding: 6px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .retry-btn:hover,
  .view-github-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .summary-content-wrapper {
    background: var(--vscode-editor-background);
    border-radius: 4px;
  }

  .beta-notice {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-bottom: 8px;
    background: transparent;
    border-radius: 3px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
  }

  .beta-notice .codicon {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    opacity: 0.7;
  }

  .beta-notice .beta-text {
    flex: 1;
  }

  .beta-notice .beta-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }

  .beta-notice .beta-dismiss:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  .beta-notice .beta-dismiss .codicon {
    font-size: 10px;
    opacity: 1;
  }

  .markdown-content {
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground);
  }

  /* Markdown styling */
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4) {
    margin: 16px 0 8px 0;
    font-weight: 600;
  }

  .markdown-content :global(h1) {
    font-size: 1.5em;
  }
  .markdown-content :global(h2) {
    font-size: 1.3em;
  }
  .markdown-content :global(h3) {
    font-size: 1.1em;
  }

  .markdown-content :global(p) {
    margin: 8px 0;
  }

  .markdown-content :global(code) {
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
  }

  .markdown-content :global(pre) {
    background: var(--vscode-textCodeBlock-background);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 12px 0;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
  }

  .markdown-content :global(th),
  .markdown-content :global(td) {
    border: 1px solid var(--vscode-panel-border);
    padding: 8px 12px;
    text-align: left;
  }

  .markdown-content :global(th) {
    background: var(--vscode-sideBar-background);
    font-weight: 600;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 8px 0;
    padding-left: 24px;
  }

  .markdown-content :global(li) {
    margin: 4px 0;
  }

  .markdown-content :global(a) {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }

  .markdown-content :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-content :global(blockquote) {
    border-left: 3px solid var(--vscode-panel-border);
    margin: 12px 0;
    padding-left: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .markdown-content :global(hr) {
    border: none;
    border-top: 2px solid var(--vscode-panel-border);
    margin: 24px 0;
  }

  .markdown-content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }

  /* Job section styling - targets h3 headers that start with 📋 Job: */
  .markdown-content :global(h3) {
    background: var(--vscode-sideBar-background);
    padding: 8px 12px;
    border-radius: 4px;
    border-left: 3px solid var(--vscode-activityBarBadge-background);
    margin: 0 0 16px 0;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .footer-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .github-link-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: none;
    font-size: 11px;
    opacity: 0.7;
    cursor: pointer;
    padding: 0;
  }

  .github-link-btn:hover {
    text-decoration: underline;
    opacity: 1;
    color: var(--vscode-textLink-foreground);
  }

  .close-btn {
    padding: 6px 16px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .close-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
</style>
