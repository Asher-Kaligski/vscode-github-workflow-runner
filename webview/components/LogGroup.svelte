<script lang="ts">
  /**
   * LogGroup Component
   *
   * Recursively renders log groups with arbitrary nesting depth.
   * Uses <svelte:self> for recursive rendering of children.
   *
   * SAFETY FEATURES:
   * - MAX_RENDER_DEPTH limit prevents stack overflow from malformed data
   * - Visited ID tracking prevents infinite loops from circular references
   * - Error boundary displays warning instead of crashing
   * - UI_INDENT_CAP prevents content from being pushed off-screen
   */

  // Maximum recursion depth to prevent stack overflow (security/perf)
  // GitHub Actions typically has 2-3 levels; 50 is extremely generous
  const MAX_RENDER_DEPTH = 50;

  // UI indentation cap for readability
  // Beyond this depth, indentation stays the same and a badge is shown
  const UI_INDENT_CAP = 8;

  interface LogGroup {
    id: string;
    name: string;
    lines: string[];
    children: LogGroup[];
    expanded: boolean;
    isNested: boolean;
    stepIndex?: number;
    duration?: number;
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
    isOrphaned?: boolean;
  }

  interface FormattedLine {
    isError: boolean;
    parts: Array<{ type: 'text' | 'url' | 'error-prefix'; content: string }>;
  }

  // Props
  export let group: LogGroup;
  export let depth: number = 0;
  export let formatLogLine: (line: string) => FormattedLine;
  export let lineMatchesSearch: (line: string) => boolean;
  export let onToggle: (group: LogGroup) => void;
  export let onOpenUrl: (url: string) => void;
  export let onViewRawLogs: (() => void) | undefined = undefined;
  export let formatDuration: ((ms: number) => string) | undefined = undefined;
  // Track visited group IDs to detect circular references
  export let visitedIds: Set<string> = new Set();

  // Safety checks for infinite loop prevention
  $: isDepthExceeded = depth > MAX_RENDER_DEPTH;
  $: isCircularRef = visitedIds.has(group.id);

  // Build visited set for children (immutable - create new Set for each level)
  $: childVisitedIds = new Set([...visitedIds, group.id]);

  // Visual depth clamping - indent stops at UI_INDENT_CAP
  $: visualDepth = Math.min(depth, UI_INDENT_CAP);
  $: showDepthBadge = depth > UI_INDENT_CAP;

  /**
   * Determine CSS classes based on depth and group properties
   */
  function getGroupClasses(g: LogGroup, d: number): string {
    const classes = ['group'];
    if (d > 0) classes.push('nested-child');
    if (g.isNested) classes.push('nested');
    if (g.conclusion === 'failure') classes.push('failed');
    if (g.conclusion === 'skipped') classes.push('skipped');
    if (g.isOrphaned) classes.push('orphaned');
    return classes.join(' ');
  }
</script>

<!-- Safety: Show error boundary for exceeded depth or circular references -->
{#if isDepthExceeded}
  <div class="group safety-error">
    <div class="group-header error-header">
      <span class="codicon codicon-warning"></span>
      <span class="group-name"
        >⚠️ Max nesting depth ({MAX_RENDER_DEPTH}) exceeded - "{group.name}"</span
      >
    </div>
  </div>
{:else if isCircularRef}
  <div class="group safety-error">
    <div class="group-header error-header">
      <span class="codicon codicon-warning"></span>
      <span class="group-name"
        >⚠️ Circular reference detected - "{group.name}" (id: {group.id})</span
      >
    </div>
  </div>
{:else}
  <!-- Normal rendering when safe -->
  <!-- Use visualDepth for CSS custom property to clamp indentation -->
  <div id={group.id} class={getGroupClasses(group, depth)} style="--visual-depth: {visualDepth}">
    <button class="group-header" on:click={() => onToggle(group)}>
      <span class="chevron codicon codicon-{group.expanded ? 'chevron-down' : 'chevron-right'}"
      ></span>
      {#if group.conclusion === 'failure'}
        <span class="status-icon failed" title="Failed">
          <span class="codicon codicon-error"></span>
        </span>
      {:else if group.conclusion === 'skipped'}
        <span class="status-icon skipped" title="Skipped">
          <span class="codicon codicon-debug-step-over"></span>
        </span>
      {:else if group.isOrphaned}
        <span class="status-icon warning" title="Unmatched Logs">
          <span class="codicon codicon-warning"></span>
        </span>
      {/if}
      <span class="group-name">{group.name}</span>
      {#if showDepthBadge}
        <span class="depth-badge" title="Actual depth: {depth}">depth {depth}</span>
      {/if}
      {#if group.duration !== undefined && formatDuration}
        <span class="step-duration">{formatDuration(group.duration)}</span>
      {/if}
    </button>

    {#if group.expanded}
      <div class="group-content">
        {#if group.isOrphaned && onViewRawLogs}
          <div class="orphaned-actions">
            <button on:click={onViewRawLogs} title="View raw logs in text editor">
              <span class="codicon codicon-file-code"></span>
              View Raw Logs
            </button>
          </div>
        {/if}

        <!-- Render children groups FIRST (matches GitHub UI order) -->
        <!-- Pass childVisitedIds to detect circular references -->
        {#each group.children as child (child.id)}
          <svelte:self
            group={child}
            depth={depth + 1}
            visitedIds={childVisitedIds}
            {formatLogLine}
            {lineMatchesSearch}
            {onToggle}
            {onOpenUrl}
          />
        {/each}

        <!-- Render lines AFTER children groups -->
        {#each group.lines as line, lineIdx (lineIdx)}
          {@const formatted = formatLogLine(line)}
          <pre
            class="log-line"
            class:search-match={lineMatchesSearch(line)}
            class:error-line={formatted.isError}>{#each formatted.parts as part, pIdx (pIdx)}{#if part.type === 'error-prefix'}<span
                  class="error-prefix">{part.content}</span
                >{:else if part.type === 'url'}<button
                  class="log-url"
                  on:click={() => onOpenUrl(part.content)}
                  title="Open in browser: {part.content}">{part.content}</button
                >{:else}{part.content}{/if}{/each}</pre>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /**
   * LogGroup Component Styles
   * Recursive group rendering with arbitrary nesting depth
   */

  .group {
    margin-bottom: 2px;
  }

  /* Top-level nested groups */
  .group.nested {
    margin-left: 16px;
  }

  /* Nested child groups within group-content */
  .group.nested-child {
    margin-left: 0;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 8px;
    background: var(--vscode-list-hoverBackground);
    border: none;
    border-radius: 4px;
    color: var(--vscode-foreground);
    cursor: pointer;
    text-align: left;
    font-size: 13px;
  }

  .group-header:hover {
    background: var(--vscode-list-activeSelectionBackground);
  }

  .chevron {
    flex-shrink: 0;
    font-size: 12px;
  }

  .group-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-duration {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex-shrink: 0;
    margin-left: 8px;
  }

  /* Depth badge for deeply nested groups (beyond UI_INDENT_CAP) */
  .depth-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    flex-shrink: 0;
    margin-left: 4px;
  }

  .status-icon {
    flex-shrink: 0;
    font-size: 14px;
    margin-right: 4px;
  }

  .status-icon.failed {
    color: var(--vscode-testing-iconFailed, #f85149);
  }

  .status-icon.skipped {
    color: var(--vscode-disabledForeground, #6e7681);
  }

  .status-icon.warning {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  /* Failed group styling */
  .group.failed > .group-header {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 10%, transparent);
    border-left: 3px solid var(--vscode-testing-iconFailed, #f85149);
  }

  .group.failed > .group-header:hover {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 15%, transparent);
  }

  /* Skipped group styling - muted appearance */
  .group.skipped > .group-header {
    opacity: 0.7;
  }

  .group.skipped > .group-header .group-name {
    color: var(--vscode-disabledForeground, #6e7681);
  }

  /* Orphaned/unmatched logs styling */
  .group.orphaned > .group-header {
    background: color-mix(
      in srgb,
      var(--vscode-editorWarning-foreground, #cca700) 10%,
      transparent
    );
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
  }

  .group.orphaned > .group-header:hover {
    background: color-mix(
      in srgb,
      var(--vscode-editorWarning-foreground, #cca700) 15%,
      transparent
    );
  }

  .orphaned-actions {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
  }

  .orphaned-actions button {
    padding: 4px 12px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .orphaned-actions button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .group-content {
    padding: 4px 0 4px 24px;
    border-left: 1px solid var(--vscode-panel-border);
    margin-left: 10px;
  }

  .log-line {
    margin: 0;
    padding: 1px 4px;
    font-family: var(--vscode-editor-font-family), monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .log-line.search-match {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4));
    border-left: 2px solid var(--vscode-editor-findMatchBorder, #f0a000);
    padding-left: 2px;
  }

  /* Error line styling */
  .log-line.error-line {
    color: var(--vscode-testing-iconFailed, #f85149);
  }

  .error-prefix {
    color: var(--vscode-testing-iconFailed, #f85149);
    font-weight: 600;
  }

  /* Clickable URL styling */
  .log-url {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: underline;
  }

  .log-url:hover {
    color: var(--vscode-textLink-activeForeground, #3794ff);
    text-decoration: underline;
  }

  /* Highlight animation for scrolled-to groups */
  :global(.group.highlight) > .group-header {
    animation: highlightPulse 2s ease-out;
  }

  @keyframes highlightPulse {
    0% {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.4));
    }
    100% {
      background: var(--vscode-list-hoverBackground);
    }
  }

  /* Safety error boundary styling */
  .safety-error {
    margin-bottom: 2px;
  }

  .safety-error .error-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 15%, transparent);
    border: 1px solid var(--vscode-editorError-foreground, #f14c4c);
    border-radius: 4px;
    color: var(--vscode-editorError-foreground, #f14c4c);
    font-size: 12px;
  }
</style>
