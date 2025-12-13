<script lang="ts">
  /**
   * JobNode - Individual job node component for dependency graph visualization
   * Displays job status, name, and optional duration
   * Allows clicking on completed and running jobs to view their steps
   */
  import type { JobGraphNode } from '../../src/types/workflow-types';
  import { getStatusColor, getStatusIcon, formatDuration } from '../utils/graph-utils';

  export let node: JobGraphNode;
  export let compact = false;
  export let onClick: ((node: JobGraphNode) => void) | undefined = undefined;

  $: statusColor = getStatusColor(node.status, node.conclusion);
  $: statusIcon = getStatusIcon(node.status, node.conclusion);
  $: isSpinning = node.status === 'in_progress';
  $: displayName = compact && node.name.length > 12 ? node.name.substring(0, 10) + '…' : node.name;
  $: durationText = node.duration ? formatDuration(node.duration) : '';

  // Allow clicking on completed jobs with steps or running jobs (steps will be fetched)
  $: isCompleted = node.status === 'completed';
  $: isRunning = node.status === 'in_progress';
  $: hasStarted = isCompleted || isRunning;
  $: canClick =
    !!onClick && !!node.jobId && hasStarted && (isRunning || (node.steps && node.steps.length > 0));
  $: clickDisabledReason = !hasStarted
    ? node.status === 'queued' || node.status === 'waiting'
      ? 'Job has not started yet'
      : 'Job is not ready'
    : !isRunning && (!node.steps || node.steps.length === 0)
      ? 'No step information available'
      : '';

  function handleClick() {
    if (canClick && onClick) {
      onClick(node);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }
</script>

<div
  class="job-node"
  class:compact
  class:active={node.isActive}
  class:clickable={canClick}
  class:disabled={!!onClick && !canClick}
  style="--status-color: {statusColor}"
  on:click={handleClick}
  on:keydown={handleKeydown}
  role={canClick ? 'button' : 'presentation'}
  tabindex={canClick ? 0 : -1}
  title="{node.name}{durationText ? ` (${durationText})` : ''}{clickDisabledReason
    ? ` - ${clickDisabledReason}`
    : ''}"
>
  <span class="status-icon" class:spinning={isSpinning}>
    <i class="codicon codicon-{statusIcon}"></i>
  </span>
  <span class="job-name">{displayName}</span>
  {#if !compact && durationText}
    <span class="job-duration">{durationText}</span>
  {/if}
  {#if node.isMatrix && node.matrixTotal}
    <span class="matrix-indicator" title="{node.matrixCompleted || 0}/{node.matrixTotal} completed">
      {node.matrixCompleted || 0}/{node.matrixTotal}
    </span>
  {/if}
  {#if canClick}
    <span
      class="steps-indicator"
      title={isRunning
        ? 'View current steps'
        : `View ${node.steps?.length || 0} step${(node.steps?.length || 0) !== 1 ? 's' : ''}`}
    >
      <i class="codicon codicon-list-ordered"></i>
    </span>
  {/if}
</div>

<style>
  /* GitHub-style job node card */
  .job-node {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    border-radius: 6px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    font-size: 13px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    width: 300px;
    box-sizing: border-box;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .job-node.compact {
    padding: 8px 10px;
    font-size: 12px;
    width: 216px;
  }

  .job-node.active {
    border-color: var(--status-color);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-color) 30%, transparent);
  }

  .job-node.clickable {
    cursor: pointer;
  }

  .job-node.clickable:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
  }

  .job-node.clickable:focus {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .job-node.disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .job-node.disabled:hover {
    background: var(--vscode-editor-background);
    border-color: var(--vscode-panel-border);
  }

  .status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
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

  .job-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
    min-width: 0;
  }

  .job-duration {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    flex-shrink: 0;
  }

  .matrix-indicator {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 11px;
    flex-shrink: 0;
  }

  .steps-indicator {
    display: none;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    font-size: 14px;
    flex-shrink: 0;
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }

  .job-node.clickable:hover .steps-indicator {
    display: flex;
    opacity: 1;
  }
</style>
