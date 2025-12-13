<script lang="ts">
  /**
   * MatrixJobGroup - Collapsible container for matrix jobs
   * Displays matrix jobs in a GitHub-style collapsible box with status summary
   */
  import type { JobGraphNode } from '../../src/types/workflow-types';
  import { getStatusColor, getStatusIcon } from '../utils/graph-utils';
  import JobNode from './JobNode.svelte';
  import { createEventDispatcher } from 'svelte';

  export let node: JobGraphNode;
  export let expanded = false;
  export let matrixJobs: JobGraphNode[] = [];
  export let onClick: ((node: JobGraphNode) => void) | undefined = undefined;

  const dispatch = createEventDispatcher();

  $: statusColor = getStatusColor(node.status, node.conclusion);
  $: statusIcon = getStatusIcon(node.status, node.conclusion);
  $: isSpinning = node.status === 'in_progress';
  $: completedCount = node.matrixCompleted || 0;
  $: totalCount = node.matrixTotal || matrixJobs.length || 1;
  $: baseName = node.name.replace(/^Matrix: /, '');

  function toggleExpanded() {
    dispatch('toggle');
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleExpanded();
    }
  }
</script>

<div class="matrix-group" class:expanded style="--status-color: {statusColor}">
  <div
    class="matrix-header"
    on:click={toggleExpanded}
    on:keydown={handleKeydown}
    role="button"
    tabindex="0"
    title="Click to {expanded ? 'collapse' : 'expand'} matrix jobs"
  >
    <span class="expand-icon">
      <i class="codicon codicon-chevron-{expanded ? 'down' : 'right'}"></i>
    </span>
    <span class="status-icon" class:spinning={isSpinning}>
      <i class="codicon codicon-{statusIcon}"></i>
    </span>
    <span class="matrix-name">Matrix: {baseName}</span>
    <span class="matrix-count">{completedCount}/{totalCount} completed</span>
  </div>

  {#if expanded && matrixJobs.length > 0}
    <div class="matrix-jobs">
      {#each matrixJobs as job (job.id)}
        <JobNode node={job} {onClick} />
      {/each}
    </div>
  {:else if !expanded}
    <div class="matrix-collapsed-hint">
      <button class="show-all-btn" on:click={toggleExpanded}>
        Show all {totalCount} jobs
      </button>
    </div>
  {/if}
</div>

<style>
  .matrix-group {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: var(--vscode-editor-background);
    overflow: hidden;
    /* Width = nested job node width (300px) + padding (12px * 2) + border (1px * 2) + buffer */
    width: 332px;
    box-sizing: border-box;
  }

  .matrix-group.expanded {
    border-color: var(--status-color);
  }

  .matrix-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--status-color) 5%);
    cursor: pointer;
    user-select: none;
  }

  .matrix-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .matrix-header:focus {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: -2px;
  }

  .expand-icon {
    color: var(--vscode-descriptionForeground);
    font-size: 14px;
  }

  .status-icon {
    color: var(--status-color);
    font-size: 16px;
  }

  .status-icon.spinning {
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

  .matrix-name {
    flex: 1;
    font-weight: 500;
    font-size: 13px;
  }

  .matrix-count {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .matrix-jobs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .matrix-collapsed-hint {
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-panel-border);
  }

  .show-all-btn {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    font-size: 12px;
    cursor: pointer;
    padding: 0;
  }

  .show-all-btn:hover {
    text-decoration: underline;
  }
</style>
